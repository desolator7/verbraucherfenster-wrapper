import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { openDatabase } from '../src/db.js';
import { createOAuthRouter, lookupToken, pkceChallenge } from '../src/oauth.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => server.close(resolve));

test('OAuth uses PKCE, issues resource-bound tokens and rejects users outside the group', async () => {
  const db = openDatabase(':memory:');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  let upstreamBase;
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, upstreamBase);
    const json = (value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/issuer/.well-known/openid-configuration') return json({
      issuer: `${upstreamBase}/issuer/`, authorization_endpoint: `${upstreamBase}/authorize`,
      token_endpoint: `${upstreamBase}/token`, userinfo_endpoint: `${upstreamBase}/userinfo`, jwks_uri: `${upstreamBase}/jwks`,
    });
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/token') {
      let body = '';
      for await (const part of req) body += part;
      const params = new URLSearchParams(body);
      const code = params.get('code');
      const idToken = await new SignJWT({ sub: 'person-1', nonce: pkceChallenge(params.get('code_verifier')) }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(`${upstreamBase}/issuer/`).setAudience('upstream-client').setIssuedAt().setExpirationTime('5m').sign(privateKey);
      return json({ id_token: idToken, access_token: code });
    }
    if (url.pathname === '/userinfo') return json({ sub: 'person-1', groups: req.headers.authorization === 'Bearer allowed' ? ['PFUI MCP'] : [] });
    res.writeHead(404).end();
  });
  upstreamBase = await listen(upstream);
  const baseUrl = 'https://pfui.example.com';
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use('/oauth', createOAuthRouter(db, {
    baseUrl, authentikIssuer: `${upstreamBase}/issuer/`,
    authentikClientId: 'upstream-client', authentikClientSecret: 'upstream-secret',
  }));
  const own = createServer(app);
  const ownBase = await listen(own);
  try {
    const redirectUri = 'http://127.0.0.1:45678/callback';
    const registration = await fetch(`${ownBase}/oauth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'Test MCP client' }),
    });
    assert.equal(registration.status, 201);
    const { client_id: clientId } = await registration.json();
    const verifier = 'v'.repeat(64);
    async function begin() {
      const url = new URL(`${ownBase}/oauth/authorize`);
      for (const [key, value] of Object.entries({
        response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
        code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256',
        resource: `${baseUrl}/mcp`, scope: 'mcp:read', state: 'client-state',
      })) url.searchParams.set(key, value);
      const response = await fetch(url, { redirect: 'manual' });
      assert.equal(response.status, 302);
      return new URL(response.headers.get('location')).searchParams.get('state');
    }
    const state = await begin();
    const callback = await fetch(`${ownBase}/oauth/callback?state=${state}&code=allowed`, { redirect: 'manual' });
    const completed = new URL(callback.headers.get('location'));
    assert.equal(completed.searchParams.get('iss'), `${baseUrl}/oauth`);
    const code = completed.searchParams.get('code');
    assert.ok(code);
    const body = new URLSearchParams({
      grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri,
      code, code_verifier: verifier, resource: `${baseUrl}/mcp`,
    });
    const wrongResource = await fetch(`${ownBase}/oauth/token`, { method: 'POST', body: new URLSearchParams({ ...Object.fromEntries(body), resource: 'https://other.example/mcp' }) });
    assert.equal(wrongResource.status, 400);
    const wrongVerifier = await fetch(`${ownBase}/oauth/token`, { method: 'POST', body: new URLSearchParams({ ...Object.fromEntries(body), code_verifier: 'x'.repeat(64) }) });
    assert.equal(wrongVerifier.status, 400);
    const exchange = await fetch(`${ownBase}/oauth/token`, { method: 'POST', body });
    assert.equal(exchange.status, 200);
    const token = (await exchange.json()).access_token;
    assert.ok(lookupToken(db, token, `${baseUrl}/mcp`));
    assert.equal(lookupToken(db, token, 'https://other.example/mcp'), null);
    assert.equal((await fetch(`${ownBase}/oauth/token`, { method: 'POST', body })).status, 400);

    const deniedState = await begin();
    const denied = await fetch(`${ownBase}/oauth/callback?state=${deniedState}&code=denied`, { redirect: 'manual' });
    assert.equal(new URL(denied.headers.get('location')).searchParams.get('error'), 'access_denied');
  } finally {
    await close(own);
    await close(upstream);
    db.close();
  }
});
