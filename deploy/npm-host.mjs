// Run inside the verified local NPM 2.15.1 container, passing PUBLIC_BASE_URL from local .env:
// PUBLIC_BASE_URL="$(sed -n 's/^PUBLIC_BASE_URL=//p' .env)" docker exec -i -e PUBLIC_BASE_URL nginx-proxy-manager node --input-type=module - plan < deploy/npm-host.mjs
// Use apply instead of plan to write the NPM configuration.
import { readFileSync, existsSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import ProxyHost from '/app/models/proxy_host.js';
import Certificate from '/app/models/certificate.js';
import internalNginx from '/app/internal/nginx.js';

const mode = process.argv[2];
if (!['plan', 'apply'].includes(mode)) throw new Error('Use plan or apply');
const version = JSON.parse(readFileSync('/app/package.json', 'utf8')).version;
if (version !== '2.15.1') throw new Error(`Unsupported NPM version: ${version}`);

const publicUrl = new URL(process.env.PUBLIC_BASE_URL ?? 'https://pfui.example.com');
if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
  throw new Error('PUBLIC_BASE_URL must be an HTTPS origin');
}
const domain = publicUrl.hostname.toLowerCase();
const upstream = 'pfui-app';
const hosts = await ProxyHost.query().where('is_deleted', 0);
const matching = hosts.filter((host) => host.domain_names.some((value) => value.toLowerCase() === domain));
if (matching.length > 1) throw new Error(`Multiple NPM hosts found: ${domain}`);
const existing = matching[0];
let base;
let certificate;
for (const candidate of hosts.filter((host) => host.owner_user_id && host.certificate_id)) {
  const candidateCertificate = await Certificate.query().findById(candidate.certificate_id);
  const coversDomain = candidateCertificate?.domain_names?.some((value) => {
    const name = value.toLowerCase();
    return name === domain || (name.startsWith('*.') && domain.endsWith(name.slice(1)));
  });
  if (!coversDomain) continue;
  const certPath = `/etc/letsencrypt/live/npm-${candidateCertificate.id}/fullchain.pem`;
  if (!existsSync(certPath)) continue;
  const x509 = new X509Certificate(readFileSync(certPath));
  if (!x509.checkHost(domain) || Date.parse(x509.validTo) <= Date.now()) continue;
  base = candidate;
  certificate = candidateCertificate;
  break;
}
if (!base || !certificate) throw new Error('No active NPM certificate covers PUBLIC_BASE_URL');
const fields = {
  owner_user_id: base.owner_user_id,
  is_deleted: 0,
  domain_names: [domain],
  forward_scheme: 'http', forward_host: upstream, forward_port: 3000,
  access_list_id: 0, certificate_id: certificate.id,
  ssl_forced: true, caching_enabled: false, block_exploits: true,
  advanced_config: '', meta: {}, allow_websocket_upgrade: false,
  http2_support: true, enabled: true, locations: [],
  hsts_enabled: true, hsts_subdomains: false, trust_forwarded_proto: false,
};
const action = existing
  ? (existing.forward_host === upstream && existing.forward_port === 3000 ? 'unchanged' : 'update')
  : 'create';
console.log(JSON.stringify({ mode, action, upstream: `http://${upstream}:3000`, sslForced: true }));
if (mode === 'plan') process.exit(0);

let inserted;
let updated = false;
let previousUpstream;
try {
  await internalNginx.test();
  let hostId;
  if (existing) {
    previousUpstream = { forward_host: existing.forward_host, forward_port: existing.forward_port };
    if (action === 'update') {
      await ProxyHost.query().patch({ forward_host: upstream, forward_port: 3000 }).where('id', existing.id);
      updated = true;
    }
    hostId = existing.id;
  } else {
    inserted = await ProxyHost.query().insertAndFetch(fields);
    hostId = inserted.id;
  }
  const expanded = await ProxyHost.query().findById(hostId).withGraphFetched('[owner,certificate,access_list.[clients,items]]');
  const meta = await internalNginx.configure(ProxyHost, 'proxy_host', expanded);
  if (meta?.nginx_online !== true) throw new Error('Generated NPM host is not online');
  await internalNginx.test();
  console.log(JSON.stringify({ created: Boolean(inserted), updated, upstream: `http://${upstream}:3000`, sslForced: true }));
} catch (error) {
  if (inserted) {
    await internalNginx.deleteConfig('proxy_host', inserted, true);
    await ProxyHost.query().deleteById(inserted.id);
    await internalNginx.reload();
  } else if (updated) {
    await ProxyHost.query().patch(previousUpstream).where('id', existing.id);
    const expanded = await ProxyHost.query().findById(existing.id).withGraphFetched('[owner,certificate,access_list.[clients,items]]');
    await internalNginx.configure(ProxyHost, 'proxy_host', expanded);
    await internalNginx.reload();
  }
  throw error;
}
process.exit(0);
