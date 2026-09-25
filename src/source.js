import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

export const SOURCE_URL = 'https://verbraucherfenster.hessen.de/ernaehrung/sichere-lebensmittel/veroeffentlichung-maengel-lfgb?displayFirst=map_first';
const SOURCE_ORIGIN = 'https://verbraucherfenster.hessen.de';

export function parseSource(html) {
  const $ = cheerio.load(html);
  const settingsText = $('script[data-drupal-selector="drupal-settings-json"]').first().html();
  if (!settingsText) throw new Error('Drupal settings JSON missing');
  const settings = JSON.parse(settingsText);
  const raw = settings.he_config?.allPoints;
  const points = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(points) || points.length === 0) throw new Error('No map points found');

  const exampleHref = $('a[href*="/maengel/mangel/view/"]').first().attr('href');
  let linkTemplate = null;
  if (exampleHref) {
    const link = new URL(exampleHref, SOURCE_ORIGIN);
    if (link.origin === SOURCE_ORIGIN && /\/maengel\/mangel\/view\/\d+\//.test(link.pathname)) {
      linkTemplate = link.href.replace(/(\/maengel\/mangel\/view\/)\d+(\/)/, '$1{id}$2');
    }
  }
  if (!linkTemplate) throw new Error('Official detail link pattern missing');

  const seen = new Set();
  const normalized = points.map((feature) => {
    if (feature?.type !== 'Feature' || feature.geometry?.type !== 'Point') throw new Error('Unexpected map feature');
    const id = String(feature.properties?.description ?? '');
    const [longitude, latitude] = (feature.geometry.coordinates ?? []).map(Number);
    if (!/^\d+$/.test(id) || seen.has(id)) throw new Error(`Invalid or duplicate publication ID: ${id}`);
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new Error(`Invalid coordinates for ${id}`);
    }
    seen.add(id);
    const name = String(feature.properties?.rendered_entity ?? '').trim();
    const postalCode = String(feature.properties?.name ?? '').trim();
    const sourceUrl = linkTemplate.replace('{id}', id);
    return {
      id, name, postalCode, longitude, latitude, sourceUrl,
      featureHash: createHash('sha256').update(JSON.stringify(feature)).digest('hex'),
    };
  });
  return normalized;
}

export function parseSummary(html) {
  const $ = cheerio.load(html);
  const label = $('label').filter((_, element) => $(element).text().includes('Art der Beanstandung')).first();
  const paragraph = label.nextAll('p').first();
  const text = paragraph.text().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= 320) return text;
  const cut = text.slice(0, 320);
  return `${cut.slice(0, Math.max(0, cut.lastIndexOf(' '))).trimEnd()} …`;
}

export function parsePublicationDate(html) {
  const text = cheerio.load(html)('body').text().replace(/\s+/g, ' ');
  const match = text.match(/Veröffentlichungsdatum\s*:?\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/i);
  if (!match) return null;

  const [, rawDay, rawMonth, rawYear] = match;
  const day = Number(rawDay);
  const month = Number(rawMonth);
  const year = Number(rawYear);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
