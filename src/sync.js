import { parsePublicationDate, parseSource, parseSummary, SOURCE_URL } from './source.js';
import { syncSnapshot } from './db.js';
import { publicBaseUrl } from './config.js';

const HEADERS = { 'user-agent': `PFUI-LFGB-Karte/161.26.020 (+${publicBaseUrl})`, accept: 'text/html' };

async function readHtml(url, fetchImpl = fetch) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    } catch (error) {
      if (attempt === 2) throw error;
      await delay(2000 * (attempt + 1));
      continue;
    }
    if (response.ok) return response.text();
    if (attempt === 2 || ![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`Source HTTP ${response.status}`);
    await delay(2000 * (attempt + 1));
  }
  throw new Error('Source request failed');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSync(db, { fetchImpl = fetch, detailDelayMs = 1000, logger = console } = {}) {
  const attemptAt = new Date().toISOString();
  db.prepare("INSERT INTO sync_status (key, value) VALUES ('last_attempt_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(attemptAt);
  try {
    const points = parseSource(await readHtml(SOURCE_URL, fetchImpl));
    const summaries = new Map();
    const publicationDates = new Map();
    let failedDetails = 0;
    for (const point of points) {
      if (detailDelayMs) await delay(detailDelayMs);
      try {
        const html = await readHtml(point.sourceUrl, fetchImpl);
        const summary = parseSummary(html);
        if (summary) summaries.set(point.id, summary);
        else failedDetails += 1;
        const publicationDate = parsePublicationDate(html);
        if (publicationDate) publicationDates.set(point.id, publicationDate);
      } catch (error) {
        failedDetails += 1;
        logger.warn(`Detail ${point.id}: ${error.message}`);
      }
    }
    syncSnapshot(db, points, summaries, new Date().toISOString(), publicationDates);
    db.prepare("INSERT INTO sync_status (key, value) VALUES ('failed_details', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(failedDetails));
    logger.info(`Synced ${points.length} publications; ${failedDetails} details unavailable`);
    return { count: points.length, failedDetails };
  } catch (error) {
    db.prepare("INSERT INTO sync_status (key, value) VALUES ('last_error', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(error.message));
    logger.error(`Sync failed: ${error.message}`);
    throw error;
  }
}

export function startDailySync(db) {
  let running = false;
  let lastDate = '';
  async function start() {
    if (running) return;
    running = true;
    try { await runSync(db); } catch { /* status is persisted by runSync */ }
    finally { running = false; }
  }
  void start();
  const timer = setInterval(() => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const date = `${values.year}-${values.month}-${values.day}`;
    if (values.hour === '03' && values.minute === '00' && lastDate !== date) {
      lastDate = date;
      void start();
    }
  }, 15000);
  return () => clearInterval(timer);
}
