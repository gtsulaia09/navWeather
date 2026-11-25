#!/usr/bin/env node
/**
 * Open timetables for our public-transport engine (DEVELOPMENT_PLAN DP-5.3, MOTIS): GTFS feeds of the region, the same
 * sources Transitous uses (public-transport/transitous, feeds/ge.json) — open data, no keys, no quotas.
 *
 *   npm run data:transit        # → data/raw/gtfs/*.gtfs.zip (~13 MB for Georgia), then `npm run engines:up`
 *
 * Georgian Railway (ODbL 1.0) and the Tbilisi Transport Company (licence not stated by the source — LICENSING_MATRIX:
 * REQUIRES REVIEW before a public launch), converted to GTFS by the Transitous maintainers. Downloaded when newer than
 * the copy here (Last-Modified), at most once a day by the scheduled job.
 */
import { createWriteStream, existsSync, mkdirSync, statSync, utimesSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const FEEDS = [
  { name: 'ge-georgian-railway', url: 'https://georailway.com/gtfs/georgian-railway.zip', licence: 'ODbL-1.0' },
  { name: 'ge-tbilisi', url: 'https://jbb.ghsq.de/gtfs/ge-tbilisi.gtfs.zip', licence: 'not stated (REQUIRES REVIEW)' },
];
const DIR = 'data/raw/gtfs';
const MAX_MB = 40;

async function fetchRetry(url, init, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'user-agent': 'NavWeather-DataPipeline/1.0', ...init?.headers },
      });
      if (res.ok) return res;
      if ((res.status < 500 && res.status !== 429 && res.status !== 408) || i >= tries) {
        throw new Error(`${url}: HTTP ${res.status}`);
      }
    } catch (e) {
      if (i >= tries) throw e;
    }
    await new Promise((r) => setTimeout(r, 1000 * i * i + Math.floor(Math.random() * 400)));
  }
}

mkdirSync(DIR, { recursive: true });
let total = 0;
for (const f of FEEDS) {
  const file = `${DIR}/${f.name}.gtfs.zip`;
  const head = await fetchRetry(f.url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) });
  const size = Number(head.headers.get('content-length') ?? 0);
  const modified = Date.parse(head.headers.get('last-modified') ?? '') || Date.now();
  if (existsSync(file) && statSync(file).mtimeMs >= modified && statSync(file).size === size) {
    console.log(`  ${f.name}: up to date (${(size / 1e6).toFixed(1)} MB)`);
    continue;
  }
  if ((total + size) / 1e6 > MAX_MB) throw new Error(`${f.name}: over the ${MAX_MB} MB ceiling — check the source`);
  const res = await fetchRetry(f.url, { signal: AbortSignal.timeout(300_000) });
  if (!res.body) throw new Error(`${f.url}: empty body`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  utimesSync(file, new Date(), new Date(modified));
  total += statSync(file).size;
  console.log(`  ${f.name}: ${(statSync(file).size / 1e6).toFixed(1)} MB (${f.licence})`);
}
console.log(`timetables in ${DIR}: ${(total / 1e6).toFixed(1)} MB downloaded`);
