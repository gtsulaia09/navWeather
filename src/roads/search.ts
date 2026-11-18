import { ATTR, CLASS } from './format';
import { haversine, headOf, turnAngle, type RoadGraph, type Snap } from './graph';
import { allowed, signalDelayS, speedMps, topSpeedMps, turnCostS, type RoadMode } from './profiles';

/** What the search may use and how it weighs it. */
export interface SearchOptions {
  mode: RoadMode;
  avoidTolls?: boolean;
  avoidMotorways?: boolean;
  avoidFerries?: boolean;
  /** Heading of a moving vehicle (degrees): starting the other way costs a turn-around. */
  startBearingDeg?: number;
  /** Per-edge cost multipliers (alternatives: roads already offered cost more). */
  penalty?: Float64Array;
}

/** A path: the states driven, the start fraction on the first edge and the end fraction on the last (along a → b). */
export interface RoadPath {
  states: number[];
  fromT: number;
  toT: number;
  /** Seconds, with turns and traffic lights, without penalties. */
  durationS: number;
}

/** Seconds to travel a whole edge (traffic lights inside it included). */
export function edgeSeconds(g: RoadGraph, mode: RoadMode, e: number): number {
  return g.len[e] / speedMps(mode, g.cls[e], g.carKmh[e]) + g.signals[e] * signalDelayS(mode);
}

/** Seconds a move from state `sIn` into state `sOut` costs at their shared node, or -1 when it is not allowed. */
export function transitionSeconds(g: RoadGraph, mode: RoadMode, sIn: number, sOut: number): number {
  const v = headOf(g, sIn);
  if (sOut >> 1 === sIn >> 1) {
    // Turning around on the same road: only at a dead end for cars.
    if (mode !== 'drive') return 5;
    for (let k = g.outStart[v]; k < g.outStart[v + 1]; k++) {
      const o = g.outState[k];
      if (o >> 1 !== sIn >> 1 && allowed(mode, g.access[o >> 1], o & 1)) return -1;
    }
    return 30;
  }
  if (mode === 'drive' && g.restrictions.size) {
    const r = g.restrictions.get(`${g.way[sIn >> 1]}:${v}`);
    if (r) {
      const to = g.way[sOut >> 1];
      if (r.only !== null && r.only !== to) return -1;
      if (r.no.has(to)) return -1;
    }
  }
  const angle = turnAngle(g.endBear[sIn], g.startBear[sOut]);
  return turnCostS(mode, angle) + (g.nodeFlags[v] & 1 ? signalDelayS(mode) : 0);
}

/** A min-heap of (key, state). */
class Heap {
  private keys = new Float64Array(1024);
  private vals = new Int32Array(1024);
  size = 0;
  push(key: number, val: number) {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      this.keys = k;
      const v = new Int32Array(this.size * 2);
      v.set(this.vals);
      this.vals = v;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.keys[i] = this.keys[p];
      this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }
  get minKey() {
    return this.keys[0];
  }
  pop(): number {
    const top = this.vals[0];
    const key = this.keys[--this.size];
    const val = this.vals[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= key) break;
      this.keys[i] = this.keys[c];
      this.vals[i] = this.vals[c];
      i = c;
    }
    this.keys[i] = key;
    this.vals[i] = val;
    return top;
  }
}

/** Seconds of turning around when a moving vehicle would start against its heading. */
const AGAINST_HEADING_S = 60;

/**
 * The fastest path between two snapped points (A* over directed edges, so turn restrictions, U-turns and turn costs
 * are exact). null when they are not connected for this mode.
 */
export function findPath(g: RoadGraph, from: Snap, to: Snap, opt: SearchOptions): RoadPath | null {
  const mode = opt.mode;
  const usable = (e: number, dir: number) => {
    if (!allowed(mode, g.access[e], dir)) return false;
    const at = g.attr[e];
    if (opt.avoidTolls && at & ATTR.toll) return false;
    if (opt.avoidFerries && at & ATTR.ferry) return false;
    if (opt.avoidMotorways && g.cls[e] === CLASS.motorway) return false;
    return true;
  };
  const cost = (e: number) => edgeSeconds(g, mode, e) * (opt.penalty ? opt.penalty[e] : 1);
  const vmax = topSpeedMps(mode, g.maxCarKmh, g.maxFerryKmh);
  const goal: [number, number] = to.point;
  const h = (v: number) => haversine([g.lon[v], g.lat[v]], goal) / vmax;

  const S = g.edgeCount * 2;
  const dist = new Float64Array(S).fill(Infinity);
  const prev = new Int32Array(S).fill(-1);
  const closed = new Uint8Array(S);
  const heap = new Heap();

  let best = Infinity;
  let bestLast = -1;
  let bestPrev = -1;

  // Same edge, no turn needed.
  for (const dir of [0, 1]) {
    if (from.edge !== to.edge || !usable(from.edge, dir)) continue;
    const ok = dir === 0 ? to.t >= from.t : to.t <= from.t;
    if (!ok) continue;
    const c = Math.abs(to.t - from.t) * cost(from.edge) + headingCost(g, from.edge * 2 + dir, opt.startBearingDeg);
    if (c < best) {
      best = c;
      bestLast = from.edge * 2 + dir;
      bestPrev = -2; // the path is this one partial edge
    }
  }

  // Seeds: the rest of the start edge, in each allowed direction.
  for (const dir of [0, 1]) {
    if (!usable(from.edge, dir)) continue;
    const s = from.edge * 2 + dir;
    const part = dir === 0 ? 1 - from.t : from.t;
    const c = part * cost(from.edge) + headingCost(g, s, opt.startBearingDeg);
    dist[s] = c;
    heap.push(c + h(headOf(g, s)), s);
  }

  while (heap.size) {
    if (heap.minKey >= best) break;
    const s = heap.pop();
    if (closed[s]) continue;
    closed[s] = 1;
    const base = dist[s];
    const v = headOf(g, s);
    for (let k = g.outStart[v]; k < g.outStart[v + 1]; k++) {
      const o = g.outState[k];
      const e = o >> 1;
      if (!usable(e, o & 1)) continue;
      const tc = transitionSeconds(g, mode, s, o);
      if (tc < 0) continue;
      if (e === to.edge) {
        const part = (o & 1) === 0 ? to.t : 1 - to.t;
        const c = base + tc + part * cost(e);
        if (c < best) {
          best = c;
          bestLast = o;
          bestPrev = s;
        }
      }
      const nd = base + tc + cost(e);
      if (nd < dist[o]) {
        dist[o] = nd;
        prev[o] = s;
        heap.push(nd + h(headOf(g, o)), o);
      }
    }
  }
  if (bestLast < 0) return null;

  const states = [bestLast];
  if (bestPrev !== -2) {
    for (let s = bestPrev; s >= 0; s = prev[s]) states.push(s);
    states.reverse();
  }
  const path: RoadPath = { states, fromT: from.t, toT: to.t, durationS: 0 };
  path.durationS = pathSeconds(g, mode, path);
  return path;
}

function headingCost(g: RoadGraph, s: number, heading: number | undefined): number {
  if (heading === undefined || !Number.isFinite(heading)) return 0;
  return Math.abs(turnAngle(heading, g.startBear[s])) > 100 ? AGAINST_HEADING_S : 0;
}

/** Real seconds of a path (no penalties): partial first and last edges, turns and traffic lights. */
export function pathSeconds(g: RoadGraph, mode: RoadMode, p: RoadPath): number {
  let total = 0;
  p.states.forEach((s, i) => {
    const e = s >> 1;
    const dir = s & 1;
    let part = 1;
    const last = i === p.states.length - 1;
    if (i === 0 && last) part = Math.abs(p.toT - p.fromT);
    else if (i === 0) part = dir === 0 ? 1 - p.fromT : p.fromT;
    else if (last) part = dir === 0 ? p.toT : 1 - p.toT;
    total += part * edgeSeconds(g, mode, e);
    if (i > 0) total += Math.max(0, transitionSeconds(g, mode, p.states[i - 1], s));
  });
  return total;
}

/** Length (m) a path shares with another (by edge). */
export function sharedLength(g: RoadGraph, a: RoadPath, b: RoadPath): number {
  const set = new Set(b.states.map((s) => s >> 1));
  let shared = 0;
  for (const s of a.states) if (set.has(s >> 1)) shared += g.len[s >> 1];
  return shared;
}

export function pathLength(g: RoadGraph, p: RoadPath): number {
  let total = 0;
  for (const s of p.states) total += g.len[s >> 1];
  return total;
}

/**
 * The best path and up to `count` real alternatives: each later search makes the roads already offered dearer, and a
 * candidate counts only when it is mostly a different road and not much slower.
 */
export function findAlternatives(g: RoadGraph, from: Snap, to: Snap, opt: SearchOptions, count: number): RoadPath[] {
  const best = findPath(g, from, to, opt);
  if (!best) return [];
  const out = [best];
  if (count <= 0) return out;
  const penalty = new Float64Array(g.edgeCount).fill(1);
  for (let attempt = 0; attempt < count * 3 && out.length <= count; attempt++) {
    for (const p of out) for (const s of p.states) penalty[s >> 1] = Math.min(penalty[s >> 1] * 1.6, 8);
    const cand = findPath(g, from, to, { ...opt, penalty });
    if (!cand) break;
    if (cand.durationS > best.durationS * 1.5) break;
    const len = pathLength(g, cand);
    const distinct = out.every((p) => sharedLength(g, cand, p) < 0.7 * len);
    if (distinct) out.push(cand);
  }
  return out;
}
