#!/usr/bin/env node
/**
 * Build the static driver-reports feed (ADR-020): every active report from our Worker plus overflow reports and votes
 * published to Nostr relays while the Worker was busy, merged by the same rules (src/reports/feed.ts), written as one
 * small JSON file per 1°×1° cell. Phones read these files (free static assets) instead of asking the Worker.
 *
 *   node --experimental-strip-types --no-warnings pipelines/reports/build.mjs \
 *     --export <url of /api/v1/reports/export> [--relays wss://a,wss://b] [--out dist-reports] [--keep-builds 2]
 *
 * Localhost: `npm run data:reports` (local Worker on :8787, local relay on :7777, out: public/data/reports).
 * CI: .github/workflows/reports-feed.yml every ~10 minutes, then `wrangler deploy -c wrangler.reports.toml`.
 * Output: <out>/index.json, <out>/builds/<build>/<cell>.json, <out>/_headers. Exits non-zero (and writes nothing)
 * when the Worker export fails, so a broken run never replaces a good feed with an empty one.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RelayPool, parseRelayList } from '../../src/p2p/nostr.ts';
import { DEFAULT_RELAYS } from '../../src/p2p/relays.ts';
import { FEED_LOOKBACK_S, mergeFeed, REPORT_EVENT_KIND, REPORT_EVENT_TAG, splitByCell } from '../../src/reports/feed.ts';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const exportUrl = arg('export', process.env.REPORTS_EXPORT_URL);
const relays = parseRelayList(arg('relays', process.env.NOSTR_RELAYS ?? DEFAULT_RELAYS.join(',')));
const out = arg('out', 'dist-reports');
const keepBuilds = Number(arg('keep-builds', '2'));
if (!exportUrl) {
  console.error('reports feed: --export <url of /api/v1/reports/export> is required');
  process.exit(2);
}

const now = Date.now();

async function workerReports() {
  const res = await fetch(exportUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Worker export answered ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.reports)) throw new Error('Worker export: unexpected body');
  // Move the Worker's times onto this machine's clock.
  const skew = Number.isFinite(body.now) ? now - body.now : 0;
  return body.reports.map((r) => ({ ...r, createdAt: r.createdAt + skew, expiresAt: r.expiresAt + skew }));
}

/** Overflow events from every relay, an hour at a time (public relays cap how many events one request returns). */
async function relayEvents() {
  if (!relays.length) return [];
  const pool = new RelayPool(relays);
  const byId = new Map();
  const nowS = Math.floor(now / 1000);
  try {
    for (let until = nowS; until > nowS - FEED_LOOKBACK_S; until -= 3600) {
      const events = await pool.fetchEvents([{ kinds: [REPORT_EVENT_KIND], '#t': [REPORT_EVENT_TAG], since: until - 3600, until, limit: 5000 }], 12_000);
      for (const e of events) byId.set(e.id, e);
    }
  } finally {
    pool.close();
  }
  return [...byId.values()];
}

let fromWorker;
try {
  fromWorker = await workerReports();
} catch (e) {
  console.error(`reports feed: ${e.message} — keeping the previous feed`);
  process.exit(1);
}
const events = await relayEvents();
const merged = mergeFeed(fromWorker, events, now);
const cells = splitByCell(merged);

const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 12);
const build = `b${stamp}`;
mkdirSync(join(out, 'builds', build), { recursive: true });
for (const [cell, reports] of cells) writeFileSync(join(out, 'builds', build, `${cell}.json`), JSON.stringify({ v: 1, generatedAt: now, reports }));
writeFileSync(join(out, 'index.json'), JSON.stringify({ v: 1, build, generatedAt: now, cells: [...cells.keys()].sort() }));
writeFileSync(
  join(out, '_headers'),
  [
    '# The reports feed (ADR-020): read by the app from another origin.',
    '/*',
    '  Access-Control-Allow-Origin: *',
    '  X-Content-Type-Options: nosniff',
    '',
    '/index.json',
    '  Cache-Control: public, max-age=30, must-revalidate',
    '',
    '/builds/*',
    '  Cache-Control: public, max-age=86400, immutable',
    '',
  ].join('\n'),
);
// Older builds: keep the last few so a phone holding a slightly old index still finds its files.
const builds = readdirSync(join(out, 'builds')).filter((d) => /^b\d{12}$/.test(d)).sort();
for (const old of builds.slice(0, Math.max(0, builds.length - keepBuilds))) rmSync(join(out, 'builds', old), { recursive: true, force: true });

const overflow = merged.filter((r) => r.src === 'n').length;
console.log(
  `reports feed ${build}: ${merged.length} active (${fromWorker.length} from the Worker, ${overflow} via ${relays.length} relays from ${events.length} events), ${cells.size} cells → ${out}`,
);
