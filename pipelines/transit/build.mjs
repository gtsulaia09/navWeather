#!/usr/bin/env node
/**
 * Compile open GTFS feeds (data/raw/gtfs/*.gtfs.zip) into a compact, gzip-compressed
 * static transit bundle for on-device RAPTOR routing (ADR-019: $0 per user, zero API calls).
 *
 *   npm run data:transit
 *
 * Outputs:
 *   public/data/transit/<build>/ge.json.gz   (~0.5-1.5 MB gz for all of Tbilisi + Georgian Railway)
 *   public/data/transit.json                 (region manifest + source metadata)
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';

const RAW_DIR = 'data/raw/gtfs';
const OUT_ROOT = 'public/data';
const TRANSIT_DIR = join(OUT_ROOT, 'transit');

/** Parse one CSV line (handles quoted fields and escaped quotes ""). */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else if (ch !== '\r') {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Stream rows of `entry` inside `zipPath` via `unzip -p`, invoking `onRow(get)`. */
async function streamCsvFromZip(zipPath, entry, onRow) {
  const proc = spawn('unzip', ['-p', zipPath, entry], { stdio: ['ignore', 'pipe', 'ignore'] });
  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  let header = null;
  let colMap = null;
  for await (const raw of rl) {
    if (!raw) continue;
    const line = header === null ? raw.replace(/^\uFEFF/, '') : raw;
    if (header === null) {
      header = parseCsvLine(line);
      colMap = new Map();
      for (let i = 0; i < header.length; i++) colMap.set(header[i].trim(), i);
      continue;
    }
    const cols = parseCsvLine(line);
    onRow((name) => {
      const idx = colMap.get(name);
      return idx !== undefined ? (cols[idx] ?? '').trim() : '';
    });
  }
  await new Promise((resolve) => proc.on('close', resolve));
}

/** Parse GTFS HH:MM:SS into integer minutes from midnight (supports >= 24:00:00). */
function parseGtfsMin(t) {
  if (!t) return -1;
  const parts = t.split(':');
  if (parts.length < 2) return -1;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = parts.length >= 3 ? Number(parts[2]) : 0;
  if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;
  return h * 60 + m + (s >= 30 ? 1 : 0);
}

/** GTFS route_type -> our TransitVehicle union. */
function mapVehicle(routeType, routeId = '') {
  const n = Number(routeType);
  if (n === 0 || (n >= 900 && n < 1000)) return 'tram';
  if (n === 1 || (n >= 400 && n < 500)) return 'subway';
  if (n === 2 || (n >= 100 && n < 200)) return 'rail';
  if (n === 4 || (n >= 1000 && n < 1100)) return 'ferry';
  if (n === 5 || n === 6 || n === 7 || (n >= 1300 && n < 1500)) return 'cable';
  if (n === 1100) return 'plane';
  if (n === 3 || n === 11 || (n >= 200 && n < 300) || (n >= 700 && n < 900)) return 'bus';
  if (/metro|subway/i.test(routeId)) return 'subway';
  return 'bus';
}

function normalizeColor(hex) {
  if (!hex) return undefined;
  const clean = hex.replace(/^#/, '').trim();
  return /^[0-9a-fA-F]{6}$/.test(clean) ? `#${clean}` : undefined;
}

/** Straight-line metres between two WGS-84 points. */
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

async function main() {
  if (!existsSync(RAW_DIR)) {
    throw new Error(`${RAW_DIR} does not exist. Run \`node pipelines/transit/download.mjs\` first.`);
  }
  const zips = readdirSync(RAW_DIR)
    .filter((f) => f.endsWith('.gtfs.zip'))
    .sort()
    .map((f) => join(RAW_DIR, f));
  if (zips.length === 0) {
    throw new Error(`No *.gtfs.zip files found in ${RAW_DIR}.`);
  }

  /** Unified stops: [lat, lon, name, nameEn?] */
  const stops = [];
  /** Unified routes: { line, name, vehicle, agency, color?, textColor? } */
  const routes = [];
  /** Pattern map: key -> { r, h, s, o, trips: Map<startMin, mask> } */
  const patternMap = new Map();
  const sources = [];

  for (const zipPath of zips) {
    const feedName = zipPath.split('/').pop().replace(/\.gtfs\.zip$/, '');
    console.log(`Processing ${feedName}...`);

    // 1. Translations (prefer English names when available for stop_name & trip_headsign)
    const transStopEn = new Map();
    const transHeadsignEn = new Map();
    const transTextEn = new Map();
    await streamCsvFromZip(zipPath, 'translations.txt', (get) => {
      const lang = (get('language') || '').toLowerCase();
      if (!lang.startsWith('en')) return;
      const table = get('table_name');
      const field = get('field_name');
      const val = get('translation');
      if (!val) return;
      const recId = get('record_id');
      const fieldVal = get('field_value');
      if (table === 'stops' && field === 'stop_name') {
        if (recId) transStopEn.set(recId, val);
        if (fieldVal) transTextEn.set(fieldVal, val);
      } else if (table === 'trips' && field === 'trip_headsign') {
        if (recId) transHeadsignEn.set(recId, val);
        if (fieldVal) transTextEn.set(fieldVal, val);
      }
    });

    // 2. Agencies
    const agencies = new Map();
    let defaultAgency = feedName;
    await streamCsvFromZip(zipPath, 'agency.txt', (get) => {
      const id = get('agency_id') || 'default';
      const name = get('agency_name') || feedName;
      agencies.set(id, name);
      if (defaultAgency === feedName) defaultAgency = name;
    });
    sources.push(defaultAgency);

    // 3. Stops
    const stopIdToIdx = new Map();
    await streamCsvFromZip(zipPath, 'stops.txt', (get) => {
      const id = get('stop_id');
      const lat = Number(get('stop_lat'));
      const lon = Number(get('stop_lon'));
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
      if (lat === 0 && lon === 0) return;
      const locType = get('location_type');
      if (locType && locType !== '0' && locType !== '1') return;
      const rawName = get('stop_name') || id;
      const enName = transStopEn.get(id) || transTextEn.get(rawName) || '';
      const name = enName && enName !== rawName ? enName : rawName;
      const idx = stops.length;
      stopIdToIdx.set(id, idx);
      stops.push([Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, name]);
    });

    // 4. Calendar -> 7-bit weekday mask (bit 0 = Mon .. bit 6 = Sun)
    const serviceMask = new Map();
    await streamCsvFromZip(zipPath, 'calendar.txt', (get) => {
      const id = get('service_id');
      if (!id) return;
      const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      let mask = 0;
      for (let d = 0; d < 7; d++) {
        if (get(days[d]) === '1') mask |= 1 << d;
      }
      if (mask === 0) mask = 0x7f;
      serviceMask.set(id, mask);
    });

    // Also include services defined only via calendar_dates.txt (exception_type = 1)
    await streamCsvFromZip(zipPath, 'calendar_dates.txt', (get) => {
      const id = get('service_id');
      if (!id || get('exception_type') !== '1') return;
      const ymd = get('date');
      if (ymd.length !== 8) return;
      const dt = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))));
      const dow = (dt.getUTCDay() + 6) % 7; // Mon=0..Sun=6
      serviceMask.set(id, (serviceMask.get(id) ?? 0) | (1 << dow));
    });

    // 5. Routes
    const routeIdToIdx = new Map();
    await streamCsvFromZip(zipPath, 'routes.txt', (get) => {
      const id = get('route_id');
      if (!id) return;
      const shortName = get('route_short_name');
      const longName = get('route_long_name');
      const vehicle = mapVehicle(get('route_type'), id);
      const agency = agencies.get(get('agency_id')) || defaultAgency;
      const color = normalizeColor(get('route_color'));
      const textColor = normalizeColor(get('route_text_color'));
      const line = shortName || longName || id;
      const idx = routes.length;
      routeIdToIdx.set(id, idx);
      routes.push({
        l: line,
        v: vehicle,
        a: agency,
        ...(color ? { c: color } : {}),
        ...(textColor ? { tc: textColor } : {}),
      });
    });

    // 6. Trips
    const tripMeta = new Map();
    await streamCsvFromZip(zipPath, 'trips.txt', (get) => {
      const id = get('trip_id');
      const rIdx = routeIdToIdx.get(get('route_id'));
      if (!id || rIdx === undefined) return;
      const mask = serviceMask.get(get('service_id')) ?? 0x7f;
      const rawHead = get('trip_headsign') || get('trip_short_name') || '';
      const head = transHeadsignEn.get(id) || transTextEn.get(rawHead) || rawHead;
      const tripShort = get('trip_short_name');
      tripMeta.set(id, { rIdx, mask, head, tripShort });
    });

    // 7. Stop times -> group by trip_id (stop_times.txt is grouped by trip_id in GTFS)
    const tripStops = new Map();
    let rawStopTimes = 0;
    await streamCsvFromZip(zipPath, 'stop_times.txt', (get) => {
      const tid = get('trip_id');
      if (!tripMeta.has(tid)) return;
      const sIdx = stopIdToIdx.get(get('stop_id'));
      if (sIdx === undefined) return;
      const dep = parseGtfsMin(get('departure_time') || get('arrival_time'));
      const arr = parseGtfsMin(get('arrival_time') || get('departure_time'));
      if (dep < 0 || arr < 0) return;
      const seq = Number(get('stop_sequence')) || 0;
      let list = tripStops.get(tid);
      if (!list) {
        list = [];
        tripStops.set(tid, list);
      }
      list.push({ seq, sIdx, arr, dep });
      rawStopTimes++;
    });

    // 8. Collapse trips into patterns: (rIdx, stopSequence, quantizedOffsets)
    let keptTrips = 0;
    for (const [tid, list] of tripStops) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.seq - b.seq);
      const meta = tripMeta.get(tid);
      const startMin = list[0].dep;
      const sIds = new Array(list.length);
      const offsets = new Array(list.length);
      let valid = true;
      for (let i = 0; i < list.length; i++) {
        sIds[i] = list[i].sIdx;
        const off = list[i].arr - startMin;
        if (off < 0 || off > 1440) {
          valid = false;
          break;
        }
        offsets[i] = off;
      }
      if (!valid) continue;

      // For rail where trip_short_name is the train number (e.g. "802") and route line is long name,
      // keep route index as-is and include headsign (last stop name if missing).
      const head = meta.head || stops[sIds[sIds.length - 1]][2];
      // Quantize pattern key offsets to 2-min buckets so slight 1-min schedule jitter merges into one pattern
      const keyOff = offsets.map((o) => Math.round(o / 2) * 2).join(',');
      const key = `${meta.rIdx}|${sIds.join(',')}|${keyOff}`;

      let pat = patternMap.get(key);
      if (!pat) {
        pat = { r: meta.rIdx, h: head, s: sIds, o: offsets, trips: new Map() };
        patternMap.set(key, pat);
      }
      // Merge service masks if two trips share the same start minute on the same pattern
      pat.trips.set(startMin, (pat.trips.get(startMin) ?? 0) | meta.mask);
      keptTrips++;
    }
    console.log(
      `  ${feedName}: ${stopIdToIdx.size} stops, ${routeIdToIdx.size} routes, ${keptTrips} trips (${rawStopTimes} stop_times)`,
    );
  }

  // Filter out unused stops and remap indices
  const usedStopOldToNew = new Map();
  const compactStops = [];
  for (const pat of patternMap.values()) {
    for (const oldIdx of pat.s) {
      if (!usedStopOldToNew.has(oldIdx)) {
        usedStopOldToNew.set(oldIdx, compactStops.length);
        compactStops.push(stops[oldIdx]);
      }
    }
  }

  const patterns = [];
  let totalTrips = 0;
  for (const pat of patternMap.values()) {
    const s = pat.s.map((old) => usedStopOldToNew.get(old));
    // Sort departures ascending; store flat [startMin, mask, startMin, mask, ...]
    const sorted = Array.from(pat.trips.entries()).sort((a, b) => a[0] - b[0]);
    const t = [];
    for (const [min, mask] of sorted) {
      t.push(min, mask);
    }
    totalTrips += sorted.length;
    patterns.push({ r: pat.r, h: pat.h, s, o: pat.o, t });
  }

  // Compute bbox of all stops
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lat, lon] of compactStops) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  const pad = 0.05;
  const bbox = [
    Math.round((minLon - pad) * 1e4) / 1e4,
    Math.round((minLat - pad) * 1e4) / 1e4,
    Math.round((maxLon + pad) * 1e4) / 1e4,
    Math.round((maxLat + pad) * 1e4) / 1e4,
  ];

  // Precompute footpath transfers between stops within 350 m (grid-indexed)
  const CELL = 0.004; // ~350-440 m
  const grid = new Map();
  for (let i = 0; i < compactStops.length; i++) {
    const [lat, lon] = compactStops[i];
    const gx = Math.floor(lon / CELL);
    const gy = Math.floor(lat / CELL);
    const key = `${gx},${gy}`;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(i);
  }
  const transfers = new Array(compactStops.length);
  let transferEdges = 0;
  for (let i = 0; i < compactStops.length; i++) {
    const [lat1, lon1] = compactStops[i];
    const gx = Math.floor(lon1 / CELL);
    const gy = Math.floor(lat1 / CELL);
    const near = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${gx + dx},${gy + dy}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j === i) continue;
          const [lat2, lon2] = compactStops[j];
          const d = haversineM(lat1, lon1, lat2, lon2);
          if (d <= 350) near.push([j, Math.round(d)]);
        }
      }
    }
    near.sort((a, b) => a[1] - b[1]);
    // Keep up to 8 closest stops; flat [stopIdx, distM, ...]
    const top = near.slice(0, 8);
    const flat = [];
    for (const [j, d] of top) flat.push(j, d);
    transfers[i] = flat;
    transferEdges += top.length;
  }

  const payload = {
    v: 1,
    tz: 'Asia/Tbilisi',
    stops: compactStops,
    routes,
    patterns,
    transfers,
  };

  const jsonBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const gzBytes = gzipSync(jsonBytes, { level: 9 });
  const hash = createHash('sha256').update(gzBytes).digest('hex').slice(0, 10);
  const buildId = `${new Date().toISOString().slice(0, 10)}-${hash}`;

  // Clean old builds under public/data/transit/
  if (existsSync(TRANSIT_DIR)) rmSync(TRANSIT_DIR, { recursive: true, force: true });
  const buildDir = join(TRANSIT_DIR, buildId);
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, 'ge.json.gz'), gzBytes);

  const manifest = {
    version: 1,
    build: buildId,
    builtAt: new Date().toISOString(),
    regions: [
      {
        id: 'ge',
        name: 'Georgia (Tbilisi & Georgian Railway)',
        tz: 'Asia/Tbilisi',
        bbox,
        file: `transit/${buildId}/ge.json.gz`,
        stops: compactStops.length,
        routes: routes.length,
        patterns: patterns.length,
        trips: totalTrips,
        sources,
      },
    ],
  };
  writeFileSync(join(OUT_ROOT, 'transit.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(
    `\nBuilt static transit bundle: ${compactStops.length} stops, ${routes.length} routes, ${patterns.length} patterns, ${totalTrips} departures, ${transferEdges} transfer edges`,
  );
  console.log(
    `Size: ${(jsonBytes.length / 1e6).toFixed(2)} MB raw -> ${(gzBytes.length / 1e3).toFixed(1)} KB gzipped (public/data/transit/${buildId}/ge.json.gz)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
