import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDatabase, getPublication, isArchivedPublication, listPublications, status, syncSnapshot } from '../src/db.js';
import { asGeoJson, filterPublications } from '../src/api.js';
import { parseSource, parseSummary } from '../src/source.js';
import { runSync } from '../src/sync.js';
import { authorizationServerMetadata, lookupToken, pkceChallenge, protectedResourceMetadata } from '../src/oauth.js';

const feature = (id, coordinates = ['8.5', '50.5']) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates },
  properties: { name: '01234', description: id, rendered_entity: `Betrieb ${id}` },
});
const sourceHtml = (features) => `<script type="application/json" data-drupal-selector="drupal-settings-json">${JSON.stringify({ he_config: { allPoints: JSON.stringify(features) } })}</script><a href="https://verbraucherfenster.hessen.de/ernaehrung/sichere-lebensmittel/veroeffentlichung-maengel-lfgb/maengel/mangel/view/7292/token/view/Mangel">Details</a>`;

test('source parser keeps IDs distinct even with the same coordinates', () => {
  const points = parseSource(sourceHtml([feature('7292'), feature('7266')]));
  assert.equal(points.length, 2);
  assert.equal(points[0].postalCode, '01234');
  assert.equal(points[1].id, '7266');
  assert.match(points[1].sourceUrl, /view\/7266\/token/);
  assert.throws(() => parseSource(sourceHtml([feature('7292'), feature('7292')])), /duplicate/);
  assert.throws(() => parseSource(sourceHtml([])), /No map points/);
  assert.throws(() => parseSource(sourceHtml([feature('7292')]).replace(/<a href=[^>]+>Details<\/a>/, '')), /link pattern/);
});

test('summary uses the official objection field and outputs plain short text', () => {
  const html = '<label>Art der Beanstandung / Produktname</label><p>  Hygienische <b>Mängel</b>  festgestellt. </p><script>bad()</script>';
  assert.equal(parseSummary(html), 'Hygienische Mängel festgestellt.');
});

test('successful snapshots retain missing IDs and failed details keep the last summary', () => {
  const db = openDatabase(':memory:');
  const first = parseSource(sourceHtml([feature('7292'), feature('7266')]));
  syncSnapshot(db, first, new Map([['7292', 'Erster Kurztext']]), '2026-09-24T01:00:00.000Z');
  assert.equal(listPublications(db).length, 2);
  assert.equal(getPublication(db, '7292').summary, 'Erster Kurztext');
  syncSnapshot(db, first.slice(0, 1), new Map(), '2026-09-25T01:00:00.000Z');
  assert.equal(getPublication(db, '7266').name, 'Betrieb 7266');
  assert.equal(getPublication(db, '7292').summary, 'Erster Kurztext');
  assert.equal(status(db).count, 2);
  db.close();
});

test('archive status starts six calendar months after the publication date', () => {
  assert.equal(isArchivedPublication('2026-03-25', new Date('2026-09-24T23:59:59.999Z')), false);
  assert.equal(isArchivedPublication('2026-03-25', new Date('2026-09-25T00:00:00.000Z')), true);
  assert.equal(isArchivedPublication('2026-08-31', new Date('2027-02-28T00:00:00.000Z')), true);
  assert.equal(isArchivedPublication(null, new Date('2030-01-01T00:00:00.000Z')), false);
  assert.equal(isArchivedPublication('2026-02-30', new Date('2030-01-01T00:00:00.000Z')), false);
});

test('sync preserves the last snapshot when the source fails and tolerates missing details', async () => {
  const db = openDatabase(':memory:');
  const first = parseSource(sourceHtml([feature('7292')]));
  syncSnapshot(db, first, new Map([['7292', 'Alter Kurztext']]), '2026-09-24T01:00:00.000Z');
  const logger = { warn() {}, info() {}, error() {} };
  await assert.rejects(runSync(db, { fetchImpl: async () => new Response('', { status: 404 }), detailDelayMs: 0, logger }), /Source HTTP 404/);
  assert.equal(status(db).lastSuccessAt, '2026-09-24T01:00:00.000Z');
  assert.equal(getPublication(db, '7292').summary, 'Alter Kurztext');
  const fetchImpl = async (url) => url.toString().includes('displayFirst=map_first')
    ? new Response(sourceHtml([feature('7292'), feature('7266')]))
    : new Response('', { status: 404 });
  await runSync(db, { fetchImpl, detailDelayMs: 0, logger });
  assert.equal(status(db).count, 2);
  assert.equal(getPublication(db, '7292').summary, 'Alter Kurztext');
  assert.equal(getPublication(db, '7266').summary, null);
  db.close();
});

test('API filtering and GeoJSON preserve numeric coordinates and source links', () => {
  const db = openDatabase(':memory:');
  const points = parseSource(sourceHtml([feature('7292'), feature('7266', ['9.2', '51.2'])]));
  syncSnapshot(db, points, new Map(), '2026-09-24T01:00:00.000Z', new Map([['7292', '2026-01-01']]));
  const publications = listPublications(db);
  assert.equal(publications.find((item) => item.id === '7292').isArchived, true);
  const near = filterPublications(publications, { lat: '50.5', lon: '8.5', radius_km: '10' });
  assert.equal(near.length, 1);
  assert.equal(near[0].id, '7292');
  assert.equal(filterPublications(publications, { bbox: '8,50,9,51' }).length, 1);
  assert.throws(() => filterPublications(publications, { bbox: 'bad' }));
  const json = asGeoJson(near);
  assert.deepEqual(json.features[0].geometry.coordinates, [8.5, 50.5]);
  assert.match(json.features[0].properties.sourceUrl, /^https:\/\/verbraucherfenster\.hessen\.de/);
  assert.equal(json.features[0].properties.isArchived, true);
  db.close();
});

test('OAuth metadata binds the resource and tokens to this MCP endpoint', () => {
  const base = 'https://pfui.example.com';
  assert.equal(protectedResourceMetadata(base).resource, `${base}/mcp`);
  assert.equal(authorizationServerMetadata(base).issuer, `${base}/oauth`);
  assert.equal(pkceChallenge('a'.repeat(43)).length, 43);
  const db = openDatabase(':memory:');
  const raw = 'test-token';
  const hashed = createHash('sha256').update(raw).digest('base64url');
  db.prepare('INSERT INTO oauth_tokens VALUES (?, ?, ?, ?, ?, ?)').run(hashed, 'client', 'subject', 'mcp:read', `${base}/mcp`, Math.floor(Date.now()/1000)+60);
  assert.equal(lookupToken(db, raw, `${base}/mcp`).subject, 'subject');
  assert.equal(lookupToken(db, raw, 'https://other.example/mcp'), null);
  db.close();
});
