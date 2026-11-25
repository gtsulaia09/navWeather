#!/usr/bin/env node
/**
 * Download a regional OpenStreetMap extract from Geofabrik and check it (DEVELOPMENT_PLAN DP-4.1): the file and
 * its published MD5, kept under data/raw/ (git-ignored) with the data date. Open data on a fixed schedule —
 * class B of the "always free" rule (FREE_STACK_PLAN §1.1): the download does not grow with users.
 *
 *   npm run data:download                 # Georgia (europe/georgia), ~100 MB
 *   node pipelines/osm/download.mjs europe/georgia --force
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REGIONS = { ge: 'europe/georgia' };
const arg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'ge';
const region = REGIONS[arg] ?? arg;
const force = process.argv.includes('--force');
const name = `${region.split('/').at(-1)}-latest.osm.pbf`;
const url = `https://download.geofabrik.de/${region}-latest.osm.pbf`;
const dest = `data/raw/${name}`;

const USER_AGENT = 'NavWeather-DataPipeline/1.0 (+https://github.com/gtsulaia09/navWeather)';

async function fetchRetry(targetUrl, timeoutMs = 180_000, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(targetUrl, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      if ((res.status < 500 && res.status !== 429 && res.status !== 408) || i >= tries) {
        throw new Error(`${targetUrl}: HTTP ${res.status}`);
      }
    } catch (err) {
      if (i >= tries) throw err;
    }
    const jitter = Math.floor(Math.random() * 600);
    await new Promise((r) => setTimeout(r, 1200 * i * i + jitter));
  }
}

mkdirSync('data/raw', { recursive: true });
const md5Res = await fetchRetry(`${url}.md5`, 30_000);
const expected = (await md5Res.text()).trim().split(/\s+/)[0];

const md5 = (path) => createHash('md5').update(readFileSync(path)).digest('hex');
if (!force && existsSync(dest) && md5(dest) === expected) {
  console.log(`${dest} is current (${(statSync(dest).size / 1e6).toFixed(0)} MB, md5 ${expected})`);
  process.exit(0);
}

console.log(`downloading ${url} …`);
let lastDate = 'unknown date';
for (let attempt = 1; attempt <= 4; attempt++) {
  const res = await fetchRetry(url, 300_000);
  if (!res.body) throw new Error(`download failed: empty body`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const got = md5(tmp);
  if (got === expected) {
    lastDate = res.headers.get('last-modified') ?? 'unknown date';
    renameSync(tmp, dest);
    break;
  }
  if (attempt === 4) throw new Error(`checksum mismatch: got ${got}, expected ${expected} — try again`);
  await new Promise((r) => setTimeout(r, 1500 * attempt));
}
console.log(`${dest}: ${(statSync(dest).size / 1e6).toFixed(0)} MB, md5 ok, data of ${lastDate}`);
