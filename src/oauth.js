import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const SCOPE = 'mcp:read';
const GROUP = 'PFUI MCP';
const random = () => randomBytes(32).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest('base64url');
export const pkceChallenge = (verifier) => hash(verifier);
const epoch = () => Math.floor(Date.now() / 1000);

function exactRedirectUri(raw) {
  try {
    const url = new URL(raw);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

function canonicalResource(baseUrl) { return `${baseUrl}/mcp`; }
function oauthIssuer(baseUrl) { return `${baseUrl}/oauth`; }

export function protectedResourceMetadata(baseUrl) {
  return {
    resource: canonicalResource(baseUrl),
    authorization_servers: [oauthIssuer(baseUrl)],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
  };
}

export function authorizationServerMetadata(baseUrl) {
  const issuer = oauthIssuer(baseUrl);
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

export function lookupToken(db, rawToken, resource) {
  if (!rawToken || rawToken.length > 256) return null;
  const token = db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ? AND expires_at > ?').get(hash(rawToken), epoch());
  return token && token.resource === resource && token.scope.split(' ').includes(SCOPE) ? token : null;
}

export function createOAuthRouter(db, config) {
  const router = Router();
  let discovery;
  let discoveryAt = 0;
  const jwks = new Map();
  const registrationAttempts = new Map();
  async function discover() {
    if (discovery && Date.now() - discoveryAt < 3600000) return discovery;
    if (!config.authentikIssuer || !config.authentikClientId || !config.authentikClientSecret) throw new Error('Authentik OAuth is not configured');
    const url = new URL('.well-known/openid-configuration', config.authentikIssuer);
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Authentik discovery HTTP ${response.status}`);
    const data = await response.json();
    if (data.issuer !== config.authentikIssuer || !data.authorization_endpoint || !data.token_endpoint || !data.jwks_uri || !data.userinfo_endpoint) {
      throw new Error('Invalid Authentik discovery metadata');
    }
    discovery = data;
    discoveryAt = Date.now();
    return data;
  }

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/register', (req, res) => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const previous = registrationAttempts.get(ip);
    const attempts = previous && previous.until > now ? previous.count : 0;
    if (attempts >= 10 || db.prepare('SELECT COUNT(*) AS count FROM oauth_clients').get().count >= 1000) {
      return res.status(429).json({ error: 'too_many_requests' });
    }
    const uris = req.body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every((uri) => typeof uri === 'string' && exactRedirectUri(uri))) {
      return res.status(400).json({ error: 'invalid_redirect_uri' });
    }
    if (req.body.token_endpoint_auth_method && req.body.token_endpoint_auth_method !== 'none') return res.status(400).json({ error: 'invalid_client_metadata' });
    const id = random();
    const name = String(req.body.client_name ?? 'MCP client').slice(0, 100);
    db.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(id, name, JSON.stringify(uris), epoch());
    registrationAttempts.set(ip, { count: attempts + 1, until: previous?.until > now ? previous.until : now + 3600000 });
    return res.status(201).json({
      client_id: id, client_name: name, redirect_uris: uris, token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], response_types: ['code'], scope: SCOPE,
    });
  });

  router.get('/authorize', async (req, res) => {
    const { client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: method,
      response_type: responseType, resource, scope, state: clientState } = req.query;
    const client = typeof clientId === 'string' && db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(clientId);
    if (!client || typeof redirectUri !== 'string' || !JSON.parse(client.redirect_uris).includes(redirectUri)) return res.status(400).send('invalid_client');
    if (responseType !== 'code' || method !== 'S256' || typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)
      || resource !== canonicalResource(config.baseUrl) || scope !== SCOPE || typeof clientState !== 'string' || clientState.length > 1024) {
      return res.status(400).send('invalid_request');
    }
    try {
      const upstream = await discover();
      const state = random();
      const verifier = random();
      const nonce = pkceChallenge(verifier);
      db.prepare('DELETE FROM oauth_flows WHERE expires_at <= ?').run(epoch());
      db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(epoch());
      db.prepare('DELETE FROM oauth_tokens WHERE expires_at <= ?').run(epoch());
      db.prepare('INSERT INTO oauth_flows (state_hash, client_id, redirect_uri, client_state, code_challenge, upstream_verifier, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(hash(state), clientId, redirectUri, clientState, challenge, verifier, epoch() + 600);
      const url = new URL(upstream.authorization_endpoint);
      for (const [key, value] of Object.entries({
        response_type: 'code', client_id: config.authentikClientId, redirect_uri: `${config.baseUrl}/oauth/callback`,
        scope: 'openid profile email', state, nonce, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256',
      })) url.searchParams.set(key, value);
      return res.redirect(302, url.href);
    } catch (error) { return res.status(503).send('Authentik ist derzeit nicht verfügbar'); }
  });

  router.get('/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const flow = db.prepare('SELECT * FROM oauth_flows WHERE state_hash = ? AND expires_at > ?').get(hash(state), epoch());
    if (!flow) return res.status(400).send('Ungültiger oder abgelaufener OAuth-Vorgang');
    db.prepare('DELETE FROM oauth_flows WHERE state_hash = ?').run(hash(state));
    const target = new URL(flow.redirect_uri);
    target.searchParams.set('state', flow.client_state);
    target.searchParams.set('iss', oauthIssuer(config.baseUrl));
    if (req.query.error || typeof req.query.code !== 'string') {
      target.searchParams.set('error', 'access_denied');
      return res.redirect(302, target.href);
    }
    try {
      const upstream = await discover();
      const body = new URLSearchParams({
        grant_type: 'authorization_code', code: req.query.code,
        redirect_uri: `${config.baseUrl}/oauth/callback`, code_verifier: flow.upstream_verifier,
      });
      const credentials = Buffer.from(`${config.authentikClientId}:${config.authentikClientSecret}`).toString('base64');
      const response = await fetch(upstream.token_endpoint, {
        method: 'POST', headers: { authorization: `Basic ${credentials}`, 'content-type': 'application/x-www-form-urlencoded' },
        body, signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Authentik token HTTP ${response.status}`);
      const tokens = await response.json();
      if (!tokens.id_token || !tokens.access_token) throw new Error('Authentik tokens missing');
      const key = jwks.get(upstream.jwks_uri) ?? createRemoteJWKSet(new URL(upstream.jwks_uri));
      jwks.set(upstream.jwks_uri, key);
      const { payload } = await jwtVerify(tokens.id_token, key, { issuer: config.authentikIssuer, audience: config.authentikClientId });
      if (payload.nonce !== pkceChallenge(flow.upstream_verifier)) throw new Error('Authentik nonce mismatch');
      const userResponse = await fetch(upstream.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10000),
      });
      if (!userResponse.ok) throw new Error(`Authentik userinfo HTTP ${userResponse.status}`);
      const user = await userResponse.json();
      if (user.sub !== payload.sub || !Array.isArray(user.groups) || !user.groups.includes(GROUP)) throw new Error('Required Authentik group missing');
      const code = random();
      db.prepare('INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, subject, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(hash(code), flow.client_id, flow.redirect_uri, flow.code_challenge, user.sub, epoch() + 300);
      target.searchParams.set('code', code);
    } catch (error) {
      console.error(`OAuth callback failed: ${error.message}`);
      target.searchParams.set('error', 'access_denied');
    }
    return res.redirect(302, target.href);
  });

  router.post('/token', (req, res) => {
    const { grant_type: grant, client_id: clientId, code, redirect_uri: redirectUri,
      code_verifier: verifier, resource } = req.body ?? {};
    if (grant !== 'authorization_code' || typeof clientId !== 'string' || typeof code !== 'string' || typeof verifier !== 'string'
      || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || resource !== canonicalResource(config.baseUrl)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ? AND expires_at > ?').get(hash(code), epoch());
    if (!row || row.client_id !== clientId || row.redirect_uri !== redirectUri || row.code_challenge !== pkceChallenge(verifier)) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(hash(code));
    const token = random();
    db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, subject, scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hash(token), clientId, row.subject, SCOPE, canonicalResource(config.baseUrl), epoch() + 3600);
    return res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600, scope: SCOPE });
  });

  router.post('/revoke', (req, res) => {
    const { token, client_id: clientId } = req.body ?? {};
    if (typeof token === 'string' && typeof clientId === 'string') {
      db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ? AND client_id = ?').run(hash(token), clientId);
    }
    return res.status(200).end();
  });
  return router;
}

export function mcpBearerGuard(db, baseUrl) {
  return (req, res, next) => {
    const raw = /^Bearer (\S+)$/i.exec(req.get('Authorization') ?? '')?.[1];
    const token = lookupToken(db, raw, canonicalResource(baseUrl));
    if (!token) {
      res.set('WWW-Authenticate', `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`);
      return res.status(401).json({ error: 'invalid_token' });
    }
    req.auth = { token: raw, clientId: token.client_id, scopes: [SCOPE], expiresAt: token.expires_at };
    return next();
  };
}
