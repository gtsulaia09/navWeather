#!/usr/bin/env node
/**
 * OpenStreetMap → our static road files (ADR-019): the graph the device routes on, so routing needs no server.
 *
 *   npm run data:roads                               # data/raw/georgia-latest.osm.pbf → public/data/roads/<build>/
 *   node --experimental-strip-types pipelines/roads/build.mjs <file.osm.pbf> [--region ge] [--name Georgia]
 *
 * Output (gzip-compressed, format in src/roads/format.ts):
 *   public/data/roads.json                    — index: current build, region bbox, tiles present (small, not cached)
 *   public/data/roads/<build>/core.bin.gz     — main roads of the whole region (motorway…tertiary + links)
 *   public/data/roads/<build>/t/<x>/<y>.bin.gz — every routable road of one zoom-11 tile
 * Files under a build folder never change (a new build gets a new folder), so they are cached as immutable.
 * ODbL: built, not committed; attribution in the app.
 */
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readPbf } from '../osm/pbf.mjs';
import { CORE_MAX_CLASS, NODE_FLAG, TILE_Z, encodeRoadFile, tileOf } from '../../src/roads/format.ts';
import { isRoutable, restrictionOf, roadOf, wayText } from './tags.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) i++;
  else positional.push(args[i]);
}
const SRC = positional[0] ?? 'data/raw/georgia-latest.osm.pbf';
const REGION = opt('region', 'ge');
const NAME = opt('name', 'Georgia');
const OUT = process.env.ROADS_OUT ?? 'public/data';
// A unique folder per build: its files are cached as immutable, so a rebuild must never reuse a name.
const BUILD = opt('build', `${new Date(statSync(SRC).mtimeMs).toISOString().slice(0, 10)}-${Date.now().toString(36)}`);
/** Main-road geometry is simplified to this tolerance (m); street tiles keep every point. */
const CORE_SIMPLIFY_M = 4;

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---- Read: node coordinates (all, sorted by id), routable ways, restrictions, traffic signals ----
let cap = 1 << 22;
let ids = new Float64Array(cap);
let lats = new Int32Array(cap);
let lons = new Int32Array(cap);
let count = 0;
const signals = new Set();
const ways = [];
const relations = [];
for (const block of readPbf(readFileSync(SRC))) {
  for (const e of block) {
    if (e.type === 'node') {
      if (count === cap) {
        cap *= 2;
        const [a, b, c] = [new Float64Array(cap), new Int32Array(cap), new Int32Array(cap)];
        a.set(ids);
        b.set(lats);
        c.set(lons);
        [ids, lats, lons] = [a, b, c];
      }
      ids[count] = e.id;
      lats[count] = Math.round(e.lat * 1e7);
      lons[count] = Math.round(e.lon * 1e7);
      count++;
      if (e.tags && (e.tags.highway === 'traffic_signals' || e.tags.crossing === 'traffic_signals')) signals.add(e.id);
    } else if (e.type === 'way') {
      if (isRoutable(e.tags) && e.refs.length >= 2) ways.push({ id: e.id, refs: e.refs, tags: e.tags });
    } else if (e.type === 'relation') {
      const r = restrictionOf(e);
      if (r) relations.push(r);
    }
  }
}
for (let i = 1; i < count; i++) if (ids[i] < ids[i - 1]) throw new Error('nodes are not sorted by id — use a Geofabrik extract');
log(`read ${count} nodes, ${ways.length} routable ways, ${relations.length} turn restrictions, ${signals.size} signals`);

function coordOf(id) {
  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = ids[mid];
    if (v === id) return [lons[mid] / 1e7, lats[mid] / 1e7];
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

const R = 6371008.8;
const rad = Math.PI / 180;
function dist([lon1, lat1], [lon2, lat2]) {
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---- Ways → attributes; drop missing nodes ----
const W = [];
for (const w of ways) {
  const pts = [];
  const refs = [];
  for (const r of w.refs) {
    const c = coordOf(r);
    if (!c) continue; // outside the extract
    if (refs.length && refs[refs.length - 1] === r) continue;
    pts.push(c);
    refs.push(r);
  }
  if (refs.length < 2) continue;
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  const road = roadOf(w.tags, len);
  if (!road) continue;
  W.push({ id: w.id, refs, pts, road, text: wayText(w.tags) });
}
W.sort((a, b) => a.id - b.id);
log(`${W.length} ways usable`);

const viaNodes = new Set(relations.map((r) => r.via));

/** Graph nodes for a set of ways: shared by two ways (or twice by one), way ends, restriction via nodes. */
function graphNodes(list) {
  const seen = new Map();
  for (const w of list) {
    for (let i = 0; i < w.refs.length; i++) {
      const r = w.refs[i];
      const end = i === 0 || i === w.refs.length - 1;
      seen.set(r, (seen.get(r) ?? 0) + (end ? 2 : 1));
    }
  }
  const out = new Set();
  for (const [r, n] of seen) if (n > 1 || viaNodes.has(r)) out.add(r);
  return out;
}

/** Douglas–Peucker on [lon, lat] points (local metres), keeping the ends. */
function simplify(pts, tolM) {
  if (pts.length <= 2) return pts;
  const lat0 = pts[0][1] * rad;
  const kx = 111320 * Math.cos(lat0);
  const ky = 110540;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const ax = pts[i][0] * kx, ay = pts[i][1] * ky, bx = pts[j][0] * kx, by = pts[j][1] * ky;
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let best = -1;
    let bestD = tolM;
    for (let k = i + 1; k < j; k++) {
      const px = pts[k][0] * kx, py = pts[k][1] * ky;
      let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i, best], [best, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Cut ways at graph nodes → edges { way (index into list), from, to (OSM ids), pts (full geometry), len, signals }. */
function cut(list, nodes) {
  const edges = [];
  list.forEach((w, wi) => {
    let start = 0;
    for (let i = 1; i < w.refs.length; i++) {
      if (i < w.refs.length - 1 && !nodes.has(w.refs[i])) continue;
      const pts = w.pts.slice(start, i + 1);
      let len = 0;
      for (let k = 1; k < pts.length; k++) len += dist(pts[k - 1], pts[k]);
      let sig = 0;
      for (let k = start + 1; k < i; k++) if (signals.has(w.refs[k])) sig++;
      edges.push({ way: wi, from: w.refs[start], to: w.refs[i], pts, len, signals: sig });
      start = i;
    }
  });
  return edges;
}

/** One file's input from a subset of edges (indices into `edges` over ways `list`). */
function fileInput(header, list, edges, pick, simplifyM) {
  const nodeIds = new Set();
  const wayIdx = new Set();
  for (const k of pick) {
    nodeIds.add(edges[k].from);
    nodeIds.add(edges[k].to);
    wayIdx.add(edges[k].way);
  }
  const nodeList = [...nodeIds].sort((a, b) => a - b);
  const nodeAt = new Map(nodeList.map((id, i) => [id, i]));
  const wayList = [...wayIdx].sort((a, b) => list[a].id - list[b].id);
  const wayAt = new Map(wayList.map((wi, i) => [wi, i]));
  const wayById = new Map(wayList.map((wi, i) => [list[wi].id, i]));
  const nodes = nodeList.map((id) => {
    const [lon, lat] = coordOf(id);
    return { gid: id, lon, lat, flags: signals.has(id) ? NODE_FLAG.signals : 0 };
  });
  const out = [];
  for (const k of pick) {
    const e = edges[k];
    const w = list[e.way];
    const pts = simplifyM ? simplify(e.pts, simplifyM) : e.pts;
    out.push({
      a: nodeAt.get(e.from),
      b: nodeAt.get(e.to),
      way: wayAt.get(e.way),
      lenM: e.len,
      carKmh: w.road.carKmh,
      access: w.road.access,
      cls: w.road.cls,
      attr: w.road.attr,
      signals: e.signals,
      geom: pts.slice(1, -1),
    });
  }
  const restrictions = [];
  for (const r of relations) {
    const via = nodeAt.get(r.via);
    const from = wayById.get(r.from);
    const to = wayById.get(r.to);
    if (via !== undefined && from !== undefined && to !== undefined) restrictions.push({ from, via, to, only: r.only });
  }
  return {
    header,
    nodes,
    ways: wayList.map((wi) => ({ id: list[wi].id, ...list[wi].text })),
    edges: out,
    restrictions,
  };
}

function write(path, input) {
  const raw = encodeRoadFile(input);
  const gz = gzipSync(raw, { level: 9 });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gz);
  return gz.length;
}

const dir = join(OUT, 'roads', BUILD);
rmSync(join(OUT, 'roads'), { recursive: true, force: true });

// ---- Core: main roads of the whole region ----
const coreWays = W.filter((w) => w.road.cls <= CORE_MAX_CLASS);
const coreEdges = cut(coreWays, graphNodes(coreWays));
const coreBytes = write(join(dir, 'core.bin.gz'), fileInput({ kind: 'core', region: REGION, build: BUILD }, coreWays, coreEdges, coreEdges.map((_, i) => i), CORE_SIMPLIFY_M));
log(`core: ${coreWays.length} ways, ${coreEdges.length} edges, ${(coreBytes / 1e6).toFixed(2)} MB`);

// ---- Street tiles: every road, an edge in the tiles of both its ends ----
const allEdges = cut(W, graphNodes(W));
const byTile = new Map();
const add = (key, k) => {
  let l = byTile.get(key);
  if (!l) byTile.set(key, (l = []));
  if (l[l.length - 1] !== k) l.push(k);
};
let west = 180, south = 90, east = -180, north = -90;
allEdges.forEach((e, k) => {
  const a = e.pts[0];
  const b = e.pts[e.pts.length - 1];
  for (const [lon, lat] of e.pts) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  add(tileOf(a[0], a[1], TILE_Z).join('/'), k);
  add(tileOf(b[0], b[1], TILE_Z).join('/'), k);
});
let tileBytes = 0;
let biggest = 0;
const tiles = [...byTile.keys()].sort();
for (const key of tiles) {
  const [x, y] = key.split('/').map(Number);
  const n = write(join(dir, 't', `${x}`, `${y}.bin.gz`), fileInput({ kind: 'tile', region: REGION, build: BUILD, z: TILE_Z, x, y }, W, allEdges, byTile.get(key), 0));
  tileBytes += n;
  biggest = Math.max(biggest, n);
}
log(`tiles: ${allEdges.length} edges in ${tiles.length} tiles, ${(tileBytes / 1e6).toFixed(1)} MB (largest ${(biggest / 1e3).toFixed(0)} kB)`);

const index = {
  version: 1,
  build: BUILD,
  regions: [
    {
      id: REGION,
      name: NAME,
      bbox: [west, south, east, north].map((v) => Math.round(v * 1e4) / 1e4),
      core: 'core.bin.gz',
      tileZ: TILE_Z,
      tiles,
    },
  ],
  source: '© OpenStreetMap contributors (ODbL)',
  dataDate: BUILD.slice(0, 10),
};
writeFileSync(join(OUT, 'roads.json'), JSON.stringify(index));
log(`wrote ${join(OUT, 'roads.json')} (build ${BUILD})`);
