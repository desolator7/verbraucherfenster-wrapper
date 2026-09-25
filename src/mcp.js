import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { filterPublications } from './api.js';
import { getPublication, listPublications, status } from './db.js';

const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

export function createMcpNodeHandler(db) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'pfui-lfgb', version: '161.26.020' });
    server.registerTool('search_publications', {
      title: 'LFGB-Veröffentlichungen im Umkreis',
      description: 'Sucht aktuelle amtliche LFGB-Veröffentlichungen nahe einer Koordinate. Ergebnisse enthalten kurze Hinweise und Links zur Originalquelle.',
      inputSchema: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), radius_km: z.number().min(0.1).max(100).default(10) }),
    }, async ({ lat, lon, radius_km }) => result({ publications: filterPublications(listPublications(db), { lat, lon, radius_km }).slice(0, 100) }));
    server.registerTool('get_publication', {
      title: 'LFGB-Veröffentlichung abrufen',
      description: 'Liefert einen aktuell gelisteten Eintrag und den Link zur amtlichen Detailseite.',
      inputSchema: z.object({ id: z.string().regex(/^\d+$/) }),
    }, async ({ id }) => result({ publication: getPublication(db, id) }));
    server.registerTool('get_sync_status', {
      title: 'Aktualisierungsstatus',
      description: 'Zeigt Zeitpunkt und Zustand der letzten Synchronisation.',
      inputSchema: z.object({}),
    }, async () => result(status(db)));
    return server;
  }, { responseMode: 'json' });
  return { nodeHandler: toNodeHandler(handler), close: () => handler.close() };
}
