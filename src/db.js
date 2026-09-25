import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS publications (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, postal_code TEXT NOT NULL,
      longitude REAL NOT NULL, latitude REAL NOT NULL, summary TEXT, publication_date TEXT,
      source_url TEXT NOT NULL, feature_hash TEXT NOT NULL,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      detail_fetched_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sync_status (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS geocode_cache (
      query TEXT PRIMARY KEY, response TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_clients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_flows (
      state_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      client_state TEXT, code_challenge TEXT NOT NULL, upstream_verifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL, subject TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, subject TEXT NOT NULL,
      scope TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function syncSnapshot(db, points, summaries, timestamp, publicationDates = new Map()) {
  const upsert = db.prepare(`
    INSERT INTO publications (id, name, postal_code, longitude, latitude, summary, publication_date, source_url,
      feature_hash, first_seen_at, last_seen_at, detail_fetched_at)
    VALUES (@id, @name, @postalCode, @longitude, @latitude, @summary, @publicationDate, @sourceUrl,
      @featureHash, @firstSeenAt, @lastSeenAt, @detailFetchedAt)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, postal_code=excluded.postal_code,
      longitude=excluded.longitude, latitude=excluded.latitude,
      summary=COALESCE(excluded.summary, publications.summary),
      publication_date=COALESCE(excluded.publication_date, publications.publication_date),
      source_url=excluded.source_url, feature_hash=excluded.feature_hash,
      last_seen_at=excluded.last_seen_at,
      detail_fetched_at=COALESCE(excluded.detail_fetched_at, publications.detail_fetched_at)
  `);
  const previous = db.prepare('SELECT id, summary, first_seen_at, detail_fetched_at FROM publications').all();
  const oldById = new Map(previous.map((row) => [row.id, row]));
  db.transaction(() => {
    for (const point of points) {
      const old = oldById.get(point.id);
      const detail = summaries.get(point.id);
      upsert.run({
        ...point,
        summary: detail ?? null,
        publicationDate: publicationDates.get(point.id) ?? null,
        firstSeenAt: old?.first_seen_at ?? timestamp,
        lastSeenAt: timestamp,
        detailFetchedAt: detail ? timestamp : null,
      });
    }
    db.prepare("INSERT INTO sync_status (key, value) VALUES ('last_success_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(timestamp);
    db.prepare("INSERT INTO sync_status (key, value) VALUES ('last_error', '') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  })();
}

export function status(db) {
  const entries = db.prepare('SELECT key, value FROM sync_status').all();
  const values = Object.fromEntries(entries.map(({ key, value }) => [key, value]));
  return {
    lastSuccessAt: values.last_success_at ?? null,
    lastAttemptAt: values.last_attempt_at ?? null,
    lastError: values.last_error || null,
    count: db.prepare('SELECT COUNT(*) AS count FROM publications').get().count,
  };
}

export function getPublication(db, id) {
  const row = db.prepare('SELECT * FROM publications WHERE id = ?').get(id);
  return row ? formatPublication(row) : null;
}

export function listPublications(db) {
  return db.prepare('SELECT * FROM publications ORDER BY id DESC').all().map(formatPublication);
}

export function isArchivedPublication(publicationDate, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publicationDate || '')) return false;
  const [year, month, day] = publicationDate.split('-').map(Number);
  const published = new Date(Date.UTC(year, month - 1, day));
  if (published.getUTCFullYear() !== year || published.getUTCMonth() !== month - 1 || published.getUTCDate() !== day) return false;

  const targetMonth = published.getUTCMonth() + 6;
  const targetYear = published.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = targetMonth % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const archivedAt = Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay));
  return now.getTime() >= archivedAt;
}

function formatPublication(row) {
  return {
    id: row.id, name: row.name, postalCode: row.postal_code,
    longitude: row.longitude, latitude: row.latitude, summary: row.summary,
    publicationDate: row.publication_date,
    isArchived: isArchivedPublication(row.publication_date),
    sourceUrl: row.source_url, firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}
