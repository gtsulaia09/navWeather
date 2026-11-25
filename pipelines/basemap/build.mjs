#!/usr/bin/env node
/**
 * Our own map background as static files (ADR-020, REQ-MAP-003): the Protomaps basemap (OpenStreetMap, ODbL) from
 * the free daily planet build — an open data file read with HTTP range requests, volume independent of users —
 * for the whole world at zoom 0–6 and for every region we build at zoom 7–14, packed 85 tiles to a file
 * (src/map/packs.ts), plus light/dark styles in English and Russian, fonts and sprites.
 *
 *   node --experimental-strip-types --no-warnings pipelines/basemap/build.mjs [--out public/data/basemap]
 *        [--region georgia] [--bbox w,s,e,n] [--source <url or file of a .pmtiles>] [--keep-builds 1]
 *
 * Needs the `pmtiles` CLI (BSD-3); a pinned release is downloaded into data/raw/tools/ when missing.
 * Output (see src/map/packs.ts): <out>/index.json, <out>/<build>/p/**.pack, <out>/<build>/style-*.json,
 * <out>/assets/{fonts,sprites}, <out>/_headers (CORS, caching) — served locally by Vite, in production by the
 * assets-only Worker `navweather-basemap` (wrangler.basemap.toml, .github/workflows/basemap.yml).
 */
import { execFileSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { PMTiles } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { BANDS, encodePack, MAX_ZOOM, packMembers, packPath, tileRange, WORLD_MAX_ZOOM } from '../../src/map/packs.ts';

const PMTILES_VERSION = '1.31.2';
const ASSETS_ZIP = 'https://github.com/protomaps/basemaps-assets/archive/refs/heads/main.zip';
const REGIONS = { georgia: [39.9, 40.95, 46.8, 43.7] };
const LANGS = ['en', 'ru', 'ka'];
const FONTS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
const ATTRIBUTION = '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const out = arg('out', 'public/data/basemap');
const regionName = arg('region', 'georgia');
const bbox = arg('bbox') ? arg('bbox').split(',').map(Number) : REGIONS[regionName];
if (!bbox || bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) throw new Error(`unknown region ${regionName}; pass --bbox w,s,e,n`);
const keepBuilds = Number(arg('keep-builds', '1'));
const work = 'data/build/basemap';
const tools = 'data/raw/tools';
mkdirSync(work, { recursive: true });
mkdirSync(tools, { recursive: true });

// --- the planet build to read --------------------------------------------------------------------------------
async function latestSource() {
  const res = await fetch('https://build-metadata.protomaps.dev/builds.json');
  if (!res.ok) throw new Error(`Protomaps build list answered ${res.status}`);
  const builds = await res.json();
  const latest = builds.filter((b) => /^\d{8}\.pmtiles$/.test(b.key)).sort((a, b) => (a.key < b.key ? -1 : 1)).at(-1);
  if (!latest) throw new Error('no Protomaps build listed');
  return `https://build.protomaps.com/${latest.key}`;
}
const source = arg('source') ?? (await latestSource());
const sourceKey = source.split('/').at(-1).replace(/\.pmtiles$/, '');
console.log(`basemap: source ${source}`);

// --- the pmtiles CLI ---------------------------------------------------------------------------------------------
function pmtilesBin() {
  try {
    execFileSync('pmtiles', ['version'], { stdio: 'ignore' });
    return 'pmtiles';
  } catch {
    /* not installed */
  }
  const bin = join(tools, `pmtiles-${PMTILES_VERSION}`);
  if (existsSync(bin)) return bin;
  const os = process.platform === 'darwin' ? 'Darwin' : process.platform === 'linux' ? 'Linux' : null;
  const cpu = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : null;
  if (!os || !cpu) throw new Error('install the pmtiles CLI (https://github.com/protomaps/go-pmtiles)');
  const file = os === 'Darwin' ? `go-pmtiles-${PMTILES_VERSION}_${os}_${cpu}.zip` : `go-pmtiles_${PMTILES_VERSION}_${os}_${cpu}.tar.gz`;
  const url = `https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${file}`;
  const archive = join(tools, file);
  console.log(`basemap: downloading ${url}`);
  execFileSync('curl', ['-fsSL', '-o', archive, url]);
  const dir = join(tools, `pmtiles-${PMTILES_VERSION}-x`);
  mkdirSync(dir, { recursive: true });
  if (file.endsWith('.zip')) execFileSync('unzip', ['-o', '-q', archive, '-d', dir]);
  else execFileSync('tar', ['-xzf', archive, '-C', dir]);
  cpSync(join(dir, 'pmtiles'), bin);
  execFileSync('chmod', ['+x', bin]);
  return bin;
}
const pmtiles = pmtilesBin();

function extract(file, args) {
  const target = join(work, `${sourceKey}-${file}`);
  if (!existsSync(target)) {
    console.log(`basemap: extracting ${file} (${args.join(' ')})`);
    execFileSync(pmtiles, ['extract', source, `${target}.part`, ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    execFileSync('mv', [`${target}.part`, target]);
  }
  return target;
}
const worldFile = extract('world.pmtiles', [`--maxzoom=${WORLD_MAX_ZOOM}`]);
const regionFile = extract(`${regionName}.pmtiles`, [`--bbox=${bbox.join(',')}`, `--maxzoom=${MAX_ZOOM}`]);

// --- read the extracts with the pmtiles library (a local file as its Source) ------------------------------------
class FileSource {
  constructor(path) {
    this.path = path;
    this.fd = openSync(path, 'r');
  }
  getKey() {
    return this.path;
  }
  async getBytes(offset, length) {
    const buf = Buffer.alloc(length);
    readSync(this.fd, buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + length) };
  }
  close() {
    closeSync(this.fd);
  }
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const build = `m${stamp}`;
const packs = {};
let packCount = 0;
let bytes = 0;

async function writePacks(file, bands, area) {
  const src = new FileSource(file);
  const archive = new PMTiles(src);
  for (const band of bands) {
    const { x0, x1, y0, y1 } = tileRange(area, band.root);
    for (let rx = x0; rx <= x1; rx++) {
      for (let ry = y0; ry <= y1; ry++) {
        const tiles = [];
        for (const t of packMembers(band.root, rx, ry)) {
          const r = await archive.getZxy(t.z, t.x, t.y);
          if (r?.data && r.data.byteLength) tiles.push({ ...t, data: gzipSync(Buffer.from(r.data), { level: 9 }) });
        }
        if (!tiles.length) continue;
        const pack = encodePack(tiles);
        const path = join(out, packPath(build, band.root, rx, ry));
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, pack);
        (packs[band.root] ??= []).push(`${rx}/${ry}`);
        packCount++;
        bytes += pack.length;
      }
    }
  }
  src.close();
}

await writePacks(worldFile, BANDS.filter((b) => b.root <= WORLD_MAX_ZOOM), [-180, -85.0511, 180, 85.0511]);
await writePacks(regionFile, BANDS.filter((b) => b.root > WORLD_MAX_ZOOM), bbox);

// --- styles: world copy (z0–6 tiles, over-zoomed outside regions) under the region copy (z7–14 inside them) -------
function style(theme, lang) {
  const flavor = namedFlavor(theme);
  const world = layers('world', flavor, { lang });
  const region = layers('region', flavor, { lang });
  const out = [];
  for (const l of world) {
    const copy = { ...l, id: `w-${l.id}` };
    // World labels stop where region detail starts, so hidden labels never block the region's labels.
    if (l.type === 'symbol') copy.maxzoom = Math.min(l.maxzoom ?? 24, 7);
    out.push(copy);
  }
  for (const l of region) {
    if (l.type === 'background') continue;
    out.push({ ...l, id: `r-${l.id}`, minzoom: Math.max(l.minzoom ?? 0, 7) });
  }
  return {
    version: 8,
    name: `navWeather ${theme} (${lang})`,
    glyphs: 'navpack://assets/fonts/{fontstack}/{range}.pbf',
    sprite: `navpack://assets/sprites/${theme}`,
    sources: {
      world: { type: 'vector', tiles: ['navpack://tiles/{z}/{x}/{y}'], minzoom: 0, maxzoom: WORLD_MAX_ZOOM, attribution: ATTRIBUTION },
      region: { type: 'vector', tiles: ['navpack://tiles/{z}/{x}/{y}'], minzoom: 7, maxzoom: MAX_ZOOM, bounds: bbox, attribution: ATTRIBUTION },
    },
    layers: out,
  };
}
for (const theme of ['light', 'dark']) for (const lang of LANGS) writeFileSync(join(out, build, `style-${theme}-${lang}.json`), JSON.stringify(style(theme, lang)));

// --- fonts and sprites (OFL / CC0), downloaded once ------------------------------------------------------------------
const assetsDir = join(out, 'assets');
if (!existsSync(join(assetsDir, 'sprites', 'light.json'))) {
  const zip = join(tools, 'basemaps-assets.zip');
  if (!existsSync(zip)) {
    console.log(`basemap: downloading ${ASSETS_ZIP}`);
    execFileSync('curl', ['-fsSL', '-o', zip, ASSETS_ZIP]);
  }
  const dir = join(tools, 'basemaps-assets');
  rmSync(dir, { recursive: true, force: true });
  execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  const root = join(dir, readdirSync(dir)[0]);
  for (const f of FONTS) cpSync(join(root, 'fonts', f), join(assetsDir, 'fonts', f), { recursive: true });
  const sprites = join(root, 'sprites', 'v4');
  mkdirSync(join(assetsDir, 'sprites'), { recursive: true });
  for (const theme of ['light', 'dark']) for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) cpSync(join(sprites, `${theme}${suffix}`), join(assetsDir, 'sprites', `${theme}${suffix}`));
}

writeFileSync(join(out, 'index.json'), JSON.stringify({ v: 1, build, source: sourceKey, regions: [bbox], packs, langs: LANGS }));
writeFileSync(
  join(out, '_headers'),
  [
    '# Our basemap (ADR-020): read by the app from another origin; every file but the index is immutable.',
    '/*',
    '  Access-Control-Allow-Origin: *',
    '  X-Content-Type-Options: nosniff',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
    '/index.json',
    '  ! Cache-Control',
    '  Cache-Control: public, max-age=300, must-revalidate',
    '',
  ].join('\n'),
);
const builds = readdirSync(out).filter((d) => /^m\d{12}$/.test(d)).sort();
for (const old of builds.slice(0, Math.max(0, builds.length - keepBuilds))) rmSync(join(out, old), { recursive: true, force: true });

const files = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? files(join(dir, e.name)) : 1), 0);
console.log(
  `basemap ${build}: ${packCount} packs (${(bytes / 1e6).toFixed(1)} MB; world z0–${WORLD_MAX_ZOOM}, ${regionName} z7–${MAX_ZOOM}), ${files(out)} files in ${out}`,
);
