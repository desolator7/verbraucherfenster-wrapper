import { Router } from 'express';
import { getPublication, listPublications, status } from './db.js';
import { publicBaseUrl } from './config.js';

export function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function finite(value, min, max) {
  const number = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(number) || number < min || number > max) throw new Error('Ungültige Koordinaten oder Radius');
  return number;
}

export function filterPublications(publications, query) {
  const hasBBox = query.bbox !== undefined;
  const hasCircle = ['lat', 'lon', 'radius_km'].some((key) => query[key] !== undefined);
  if (hasBBox && hasCircle) throw new Error('bbox und Umkreis können nicht kombiniert werden');
  if (hasBBox) {
    const values = String(query.bbox).split(',');
    if (values.length !== 4) throw new Error('bbox benötigt west,süd,ost,nord');
    const [west, south, east, north] = values.map((v, i) => finite(v, i % 2 ? -90 : -180, i % 2 ? 90 : 180));
    if (west > east || south > north) throw new Error('Ungültige bbox-Grenzen');
    return publications.filter((item) => item.longitude >= west && item.longitude <= east && item.latitude >= south && item.latitude <= north);
  }
  if (hasCircle) {
    const lat = finite(query.lat, -90, 90);
    const lon = finite(query.lon, -180, 180);
    const radius = finite(query.radius_km, 0.1, 100);
    return publications.map((item) => ({ ...item, distanceKm: distanceKm(lat, lon, item.latitude, item.longitude) }))
      .filter((item) => item.distanceKm <= radius).sort((a, b) => a.distanceKm - b.distanceKm);
  }
  return publications;
}

export function asGeoJson(publications) {
  return {
    type: 'FeatureCollection',
    features: publications.map(({ id, longitude, latitude, ...properties }) => ({
      type: 'Feature', id, geometry: { type: 'Point', coordinates: [longitude, latitude] },
      properties: { id, ...properties },
    })),
  };
}

export function createApi(db) {
  const router = Router();
  router.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });
  router.get('/status', (_req, res) => {
    const current = status(db);
    res.json({ ...current, stale: !current.lastSuccessAt || Date.now() - Date.parse(current.lastSuccessAt) > 36 * 60 * 60 * 1000 });
  });
  router.get('/publications.geojson', (req, res) => {
    if (!status(db).lastSuccessAt) return res.status(503).json({ error: 'Noch keine Daten verfügbar' });
    try { return res.json(asGeoJson(filterPublications(listPublications(db), req.query))); }
    catch (error) { return res.status(400).json({ error: error.message }); }
  });
  router.get('/publications/:id', (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Ungültige ID' });
    const publication = getPublication(db, req.params.id);
    return publication ? res.json(publication) : res.status(404).json({ error: 'Eintrag nicht gefunden' });
  });
  return router;
}

export function createGeocoder(db, { fetchImpl = fetch } = {}) {
  const router = Router();
  let lastRemoteAt = 0;
  router.get('/', async (req, res) => {
    const query = String(req.query.q ?? '').trim();
    if (query.length < 3 || query.length > 100) return res.status(400).json({ error: 'Bitte einen Ort oder eine PLZ eingeben' });
    const key = query.toLocaleLowerCase('de-DE');
    const cached = db.prepare('SELECT response FROM geocode_cache WHERE query = ? AND expires_at > ?').get(key, Date.now());
    if (cached) return res.json(JSON.parse(cached.response));
    if (Date.now() - lastRemoteAt < 1000) return res.status(429).json({ error: 'Bitte kurz warten' });
    lastRemoteAt = Date.now();
    try {
      const url = new URL('https://photon.komoot.io/api/');
      url.searchParams.set('q', query);
      url.searchParams.set('limit', '5');
      url.searchParams.set('lang', 'de');
      url.searchParams.set('bbox', '6.8,48.8,11.0,52.4');
      const response = await fetchImpl(url, { headers: { 'user-agent': `PFUI-LFGB-Karte/161.26.020 (+${publicBaseUrl})` }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Photon HTTP ${response.status}`);
      const json = await response.json();
      const results = (json.features ?? []).filter((item) => item.geometry?.type === 'Point').map((item) => ({
        name: [item.properties?.name, item.properties?.city, item.properties?.state].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', '),
        longitude: Number(item.geometry.coordinates[0]), latitude: Number(item.geometry.coordinates[1]),
      })).filter((item) => item.name && Number.isFinite(item.longitude) && Number.isFinite(item.latitude));
      db.prepare('INSERT INTO geocode_cache (query, response, expires_at) VALUES (?, ?, ?) ON CONFLICT(query) DO UPDATE SET response=excluded.response, expires_at=excluded.expires_at')
        .run(key, JSON.stringify(results), Date.now() + 30 * 86400000);
      return res.json(results);
    } catch (error) { return res.status(502).json({ error: 'Ortssuche derzeit nicht verfügbar' }); }
  });
  return router;
}
