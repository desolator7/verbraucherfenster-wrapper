import express from 'express';
import { resolve } from 'node:path';
import { openDatabase } from './db.js';
import { createApi, createGeocoder } from './api.js';
import { createMcpNodeHandler } from './mcp.js';
import { authorizationServerMetadata, createOAuthRouter, mcpBearerGuard, protectedResourceMetadata } from './oauth.js';
import { startDailySync } from './sync.js';
import { publicBaseUrl } from './config.js';

const baseUrl = publicBaseUrl;
const config = {
  baseUrl,
  authentikIssuer: process.env.AUTHENTIK_ISSUER,
  authentikClientId: process.env.AUTHENTIK_CLIENT_ID,
  authentikClientSecret: process.env.AUTHENTIK_CLIENT_SECRET,
};
const db = openDatabase(process.env.DATABASE_PATH ?? resolve('data/app.sqlite'));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use('/api/v1', createApi(db));
app.use('/api/geocode', createGeocoder(db));

const resourceMetadata = protectedResourceMetadata(baseUrl);
const serverMetadata = authorizationServerMetadata(baseUrl);
app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json(resourceMetadata));
app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(resourceMetadata));
app.get('/.well-known/oauth-authorization-server/oauth', (_req, res) => res.json(serverMetadata));
app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(serverMetadata));
app.use('/oauth', createOAuthRouter(db, config));

const mcp = createMcpNodeHandler(db);
app.all('/mcp', (req, res, next) => {
  const host = req.get('host')?.split(':')[0];
  const origin = req.get('origin');
  if (host !== new URL(baseUrl).hostname || (origin && origin !== baseUrl)) return res.status(403).json({ error: 'forbidden_origin' });
  next();
}, mcpBearerGuard(db, baseUrl), (req, res) => void mcp.nodeHandler(req, res, req.body));

app.use(express.static(resolve('dist'), { index: 'index.html', maxAge: '1h' }));
const server = app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () => {
  console.info(`PFUI listening on ${process.env.PORT ?? 3000}`);
});
const stopSync = startDailySync(db);
async function shutdown() {
  stopSync();
  server.close();
  await mcp.close();
  db.close();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
