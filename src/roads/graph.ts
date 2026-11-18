import { ATTR, CLASS, type RoadFile } from './format';

/**
 * One searchable road graph built from several road files (the main-roads file and street tiles): nodes are joined
 * by their OpenStreetMap ids, an edge that two tiles both hold is kept once, and street geometry wins over the
 * simplified main-road geometry where both describe the same stretch.
 *
 * Directed traversals are "states": state = edge × 2 + dir, dir 0 = a → b, dir 1 = b → a.
 */
export interface RoadGraph {
  nodeCount: number;
  lon: Float64Array;
  lat: Float64Array;
  nodeFlags: Uint8Array;
  edgeCount: number;
  a: Uint32Array;
  b: Uint32Array;
  len: Float64Array;
  carKmh: Uint16Array;
  access: Uint8Array;
  cls: Uint8Array;
  attr: Uint8Array;
  signals: Uint8Array;
  way: Uint32Array;
  /** Interior points of edge i: geom[geomStart[i] … geomStart[i+1]) as lon, lat pairs. */
  geomStart: Uint32Array;
  geom: Float64Array;
  /** States leaving node v: outState[outStart[v] … outStart[v+1]). */
  outStart: Uint32Array;
  outState: Uint32Array;
  ways: WayInfo[];
  /** Heading (degrees) of each state where it leaves its tail node, and where it reaches its head node. */
  startBear: Float32Array;
  endBear: Float32Array;
  /** Turn restrictions (cars), by `${fromWay}:${viaNode}`. */
  restrictions: Map<string, { no: Set<number>; only: number | null }>;
  maxCarKmh: number;
  maxFerryKmh: number;
}

export interface WayInfo {
  id: number;
  name: string;
  nameEn: string;
  nameRu: string;
  ref: string;
  dest: string;
  lanesFwd: string;
  lanesBwd: string;
}

/** Join road files into one graph. Street tiles should come before the main-roads file. */
export function buildGraph(files: RoadFile[]): RoadGraph {
  const nodeIndex = new Map<number, number>();
  const lon: number[] = [];
  const lat: number[] = [];
  const flags: number[] = [];
  const wayIndex = new Map<number, number>();
  const ways: WayInfo[] = [];
  const edgeKeys = new Set<string>();
  const ea: number[] = [];
  const eb: number[] = [];
  const elen: number[] = [];
  const ecar: number[] = [];
  const eacc: number[] = [];
  const ecls: number[] = [];
  const eattr: number[] = [];
  const esig: number[] = [];
  const eway: number[] = [];
  const gStart: number[] = [0];
  const geom: number[] = [];
  const restrictions = new Map<string, { no: Set<number>; only: number | null }>();
  let maxCarKmh = 1;
  let maxFerryKmh = 1;

  for (const f of files) {
    const nodeMap = new Uint32Array(f.nodeGid.length);
    for (let i = 0; i < f.nodeGid.length; i++) {
      const gid = f.nodeGid[i];
      let k = nodeIndex.get(gid);
      if (k === undefined) {
        k = lon.length;
        nodeIndex.set(gid, k);
        lon.push(f.nodeLon[i]);
        lat.push(f.nodeLat[i]);
        flags.push(f.nodeFlags[i]);
      }
      nodeMap[i] = k;
    }
    const wayMap = new Uint32Array(f.wayId.length);
    for (let i = 0; i < f.wayId.length; i++) {
      const id = f.wayId[i];
      let k = wayIndex.get(id);
      if (k === undefined) {
        k = ways.length;
        wayIndex.set(id, k);
        const s = (col: Uint32Array) => f.strings[col[i]] ?? '';
        ways.push({
          id,
          name: s(f.wayName),
          nameEn: s(f.wayNameEn),
          nameRu: s(f.wayNameRu),
          ref: s(f.wayRef),
          dest: s(f.wayDest),
          lanesFwd: s(f.wayLanesFwd),
          lanesBwd: s(f.wayLanesBwd),
        });
      }
      wayMap[i] = k;
    }
    for (let i = 0; i < f.edgeA.length; i++) {
      const a = nodeMap[f.edgeA[i]];
      const b = nodeMap[f.edgeB[i]];
      const w = wayMap[f.edgeWay[i]];
      const key = `${ways[w].id}:${a}:${b}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      ea.push(a);
      eb.push(b);
      elen.push(f.edgeLen[i]);
      ecar.push(f.edgeCarKmh[i]);
      eacc.push(f.edgeAccess[i]);
      ecls.push(f.edgeClass[i]);
      eattr.push(f.edgeAttr[i]);
      esig.push(f.edgeSignals[i]);
      eway.push(w);
      for (let k = f.geomStart[i]; k < f.geomStart[i + 1]; k++) geom.push(f.geom[k]);
      gStart.push(geom.length);
      if (f.edgeClass[i] === CLASS.ferry) maxFerryKmh = Math.max(maxFerryKmh, f.edgeCarKmh[i]);
      else maxCarKmh = Math.max(maxCarKmh, f.edgeCarKmh[i]);
    }
    for (let i = 0; i < f.resVia.length; i++) {
      const from = wayMap[f.resFrom[i]];
      const via = nodeMap[f.resVia[i]];
      const to = wayMap[f.resTo[i]];
      const key = `${from}:${via}`;
      let r = restrictions.get(key);
      if (!r) restrictions.set(key, (r = { no: new Set(), only: null }));
      if (f.resKind[i] === 1) r.only = to;
      else r.no.add(to);
    }
  }

  const n = lon.length;
  const m = ea.length;
  const outCount = new Uint32Array(n + 1);
  for (let e = 0; e < m; e++) {
    outCount[ea[e]]++;
    outCount[eb[e]]++;
  }
  const outStart = new Uint32Array(n + 1);
  for (let v = 0; v < n; v++) outStart[v + 1] = outStart[v] + outCount[v];
  const fill = outStart.slice(0, n);
  const outState = new Uint32Array(outStart[n]);
  for (let e = 0; e < m; e++) {
    outState[fill[ea[e]]++] = e * 2;
    outState[fill[eb[e]]++] = e * 2 + 1;
  }

  const startBear = new Float32Array(m * 2);
  const endBear = new Float32Array(m * 2);
  for (let e = 0; e < m; e++) {
    const A: [number, number] = [lon[ea[e]], lat[ea[e]]];
    const B: [number, number] = [lon[eb[e]], lat[eb[e]]];
    const s = gStart[e];
    const t = gStart[e + 1];
    const first: [number, number] = t > s ? [geom[s], geom[s + 1]] : B;
    const last: [number, number] = t > s ? [geom[t - 2], geom[t - 1]] : A;
    startBear[e * 2] = bearing(A, first);
    endBear[e * 2] = bearing(last, B);
    startBear[e * 2 + 1] = bearing(B, last);
    endBear[e * 2 + 1] = bearing(first, A);
  }

  return {
    nodeCount: n,
    startBear,
    endBear,
    lon: Float64Array.from(lon),
    lat: Float64Array.from(lat),
    nodeFlags: Uint8Array.from(flags),
    edgeCount: m,
    a: Uint32Array.from(ea),
    b: Uint32Array.from(eb),
    len: Float64Array.from(elen),
    carKmh: Uint16Array.from(ecar),
    access: Uint8Array.from(eacc),
    cls: Uint8Array.from(ecls),
    attr: Uint8Array.from(eattr),
    signals: Uint8Array.from(esig),
    way: Uint32Array.from(eway),
    geomStart: Uint32Array.from(gStart),
    geom: Float64Array.from(geom),
    outStart,
    outState,
    ways,
    restrictions,
    maxCarKmh,
    maxFerryKmh,
  };
}

/** Node a state leaves from / arrives at. */
export const tailOf = (g: RoadGraph, s: number) => ((s & 1) === 0 ? g.a[s >> 1] : g.b[s >> 1]);
export const headOf = (g: RoadGraph, s: number) => ((s & 1) === 0 ? g.b[s >> 1] : g.a[s >> 1]);

/** All points of an edge, in the direction of travel. */
export function edgePoints(g: RoadGraph, state: number): [number, number][] {
  const e = state >> 1;
  const pts: [number, number][] = [[g.lon[g.a[e]], g.lat[g.a[e]]]];
  for (let k = g.geomStart[e]; k < g.geomStart[e + 1]; k += 2) pts.push([g.geom[k], g.geom[k + 1]]);
  pts.push([g.lon[g.b[e]], g.lat[g.b[e]]]);
  if (state & 1) pts.reverse();
  return pts;
}

const RAD = Math.PI / 180;
/** Initial bearing from p to q, degrees 0…360. */
export function bearing(p: [number, number], q: [number, number]): number {
  const y = Math.sin((q[0] - p[0]) * RAD) * Math.cos(q[1] * RAD);
  const x = Math.cos(p[1] * RAD) * Math.sin(q[1] * RAD) - Math.sin(p[1] * RAD) * Math.cos(q[1] * RAD) * Math.cos((q[0] - p[0]) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Metres between two points. */
export function haversine(p: [number, number], q: [number, number]): number {
  const dLat = (q[1] - p[1]) * RAD;
  const dLon = (q[0] - p[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(p[1] * RAD) * Math.cos(q[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Heading where a state leaves its tail node / arrives at its head node (from the nearest points ≥ 5 m away). */
export function startBearing(g: RoadGraph, s: number): number {
  const pts = edgePoints(g, s);
  let k = 1;
  while (k < pts.length - 1 && haversine(pts[0], pts[k]) < 5) k++;
  return bearing(pts[0], pts[k]);
}
export function endBearing(g: RoadGraph, s: number): number {
  const pts = edgePoints(g, s);
  const last = pts.length - 1;
  let k = last - 1;
  while (k > 0 && haversine(pts[k], pts[last]) < 5) k--;
  return bearing(pts[k], pts[last]);
}

/** Signed change of heading from `inDeg` to `outDeg`, -180…180, positive to the right. */
export function turnAngle(inDeg: number, outDeg: number): number {
  let d = outDeg - inDeg;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

export const isRoundabout = (g: RoadGraph, e: number) => (g.attr[e] & ATTR.roundabout) !== 0;
export const isLink = (g: RoadGraph, e: number) => (g.attr[e] & ATTR.link) !== 0;

/**
 * Size (in edges) of the connected piece of road network each edge belongs to, for one way of travelling. A point
 * must not snap onto a stray fragment (a private driveway cut off from the rest): the route would be impossible.
 */
const componentCache = new WeakMap<RoadGraph, Map<string, Uint32Array>>();
export function componentSizes(g: RoadGraph, key: string, usable: (e: number) => boolean): Uint32Array {
  let byKey = componentCache.get(g);
  if (!byKey) componentCache.set(g, (byKey = new Map()));
  const hit = byKey.get(key);
  if (hit) return hit;
  const parent = new Int32Array(g.nodeCount);
  for (let i = 0; i < g.nodeCount; i++) parent[i] = i;
  const find = (x: number) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let e = 0; e < g.edgeCount; e++) {
    if (!usable(e)) continue;
    const ra = find(g.a[e]);
    const rb = find(g.b[e]);
    if (ra !== rb) parent[ra] = rb;
  }
  const count = new Uint32Array(g.nodeCount);
  for (let e = 0; e < g.edgeCount; e++) if (usable(e)) count[find(g.a[e])]++;
  const sizes = new Uint32Array(g.edgeCount);
  for (let e = 0; e < g.edgeCount; e++) sizes[e] = usable(e) ? count[find(g.a[e])] : 0;
  byKey.set(key, sizes);
  return sizes;
}

/** A grid over every edge segment, for finding the road nearest a point. */
export interface SnapIndex {
  cell: number;
  cells: Map<number, number[]>;
}
const SNAP_CELL_DEG = 0.01;

export function buildSnapIndex(g: RoadGraph): SnapIndex {
  const cells = new Map<number, number[]>();
  const key = (x: number, y: number) => x * 100000 + y;
  for (let e = 0; e < g.edgeCount; e++) {
    const pts = edgePoints(g, e * 2);
    for (let i = 1; i < pts.length; i++) {
      const x0 = Math.floor(Math.min(pts[i - 1][0], pts[i][0]) / SNAP_CELL_DEG);
      const x1 = Math.floor(Math.max(pts[i - 1][0], pts[i][0]) / SNAP_CELL_DEG);
      const y0 = Math.floor(Math.min(pts[i - 1][1], pts[i][1]) / SNAP_CELL_DEG);
      const y1 = Math.floor(Math.max(pts[i - 1][1], pts[i][1]) / SNAP_CELL_DEG);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const k = key(x, y);
          let l = cells.get(k);
          if (!l) cells.set(k, (l = []));
          l.push(e, i - 1);
        }
      }
    }
  }
  return { cell: SNAP_CELL_DEG, cells };
}

/** Where a point meets the road network: edge, fraction along a → b, the point on the road and its distance. */
export interface Snap {
  edge: number;
  /** 0 at node a, 1 at node b, by length. */
  t: number;
  point: [number, number];
  distM: number;
}

/**
 * The nearest edge a mode may use (in at least one direction), searching rings of grid cells outward up to
 * `maxM` metres. null when no usable road is that close.
 */
export function snap(g: RoadGraph, idx: SnapIndex, p: [number, number], usable: (e: number) => boolean, maxM = 5000): Snap | null {
  const kx = 111320 * Math.cos(p[1] * RAD);
  const ky = 110540;
  const cx = Math.floor(p[0] / idx.cell);
  const cy = Math.floor(p[1] / idx.cell);
  const maxRing = Math.ceil(maxM / (idx.cell * ky)) + 1;
  let best = null as { e: number; seg: number; u: number; d: number } | null;
  const seen = new Set<number>();
  for (let ring = 0; ring <= maxRing; ring++) {
    for (let x = cx - ring; x <= cx + ring; x++) {
      for (let y = cy - ring; y <= cy + ring; y++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== ring) continue;
        const list = idx.cells.get(x * 100000 + y);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 2) {
          const e = list[i];
          const seg = list[i + 1];
          const tag = e * 100000 + seg;
          if (seen.has(tag)) continue;
          seen.add(tag);
          if (!usable(e)) continue;
          const pts = edgePoints(g, e * 2);
          const A = pts[seg];
          const B = pts[seg + 1];
          const ax = (A[0] - p[0]) * kx, ay = (A[1] - p[1]) * ky;
          const bx = (B[0] - p[0]) * kx, by = (B[1] - p[1]) * ky;
          const dx = bx - ax, dy = by - ay;
          const l2 = dx * dx + dy * dy;
          const u = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
          const d = Math.hypot(ax + u * dx, ay + u * dy);
          if (!best || d < best.d) best = { e, seg, u, d };
        }
      }
    }
    // Anything in a farther ring is at least `ring` cells away.
    if (best && best.d <= ring * idx.cell * Math.min(kx, ky)) break;
  }
  if (!best || best.d > maxM) return null;
  const pts = edgePoints(g, best.e * 2);
  let along = 0;
  for (let i = 1; i <= best.seg; i++) along += haversine(pts[i - 1], pts[i]);
  const A = pts[best.seg];
  const B = pts[best.seg + 1];
  const point: [number, number] = [A[0] + (B[0] - A[0]) * best.u, A[1] + (B[1] - A[1]) * best.u];
  along += haversine(A, point);
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += haversine(pts[i - 1], pts[i]);
  return { edge: best.e, t: total > 0 ? Math.min(1, along / total) : 0, point, distM: best.d };
}
