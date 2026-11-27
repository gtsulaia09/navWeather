import { ATTR, CLASS } from './format';
import { bearing, edgePoints, haversine, headOf, isLink, isRoundabout, turnAngle, type RoadGraph } from './graph';
import { allowed, type RoadMode } from './profiles';
import { edgeSeconds, transitionSeconds, type RoadPath } from './search';
import { localizeScript } from '../i18n/script';

/**
 * A found path → the OSRM-shaped answer the app already reads (`normalizeOsrmRoute`): full geometry, legs with
 * turn-by-turn steps (OSRM maneuver vocabulary), lanes from OSM `turn:lanes`, and per-segment durations.
 */

type LngLat = [number, number];

export interface OsrmLikeStep {
  distance: number;
  duration: number;
  name: string;
  ref?: string;
  destinations?: string;
  driving_side: 'right';
  geometry: { coordinates: LngLat[] };
  /** `lanes_approach`: metres before the maneuver over which `lanes` hold (the mapped road the tag is on). */
  intersections: { location: LngLat; lanes?: { indications: string[]; valid: boolean }[]; lanes_approach?: number; classes?: string[] }[];
  maneuver: { type: string; modifier?: string; location: LngLat; exit?: number; bearing_before: number; bearing_after: number };
}
export interface OsrmLikeLeg {
  distance: number;
  duration: number;
  summary: string;
  steps: OsrmLikeStep[];
  annotation: { distance: number[]; duration: number[] };
}
export interface OsrmLikeRoute {
  distance: number;
  duration: number;
  geometry: { coordinates: LngLat[] };
  legs: OsrmLikeLeg[];
}

/** One driven piece of an edge, with its points in travel order. */
interface Piece {
  state: number;
  pts: LngLat[];
  lengthM: number;
  durationS: number;
  /** Seconds lost at the node where this piece starts (turn, traffic light). */
  turnS: number;
}

/** Points of `pts` from fraction t0 to t1 of its length (t0 < t1). */
function slice(pts: LngLat[], t0: number, t1: number): LngLat[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  if (total <= 0) return [pts[0], pts[pts.length - 1]];
  const at = (d: number): LngLat => {
    let i = 1;
    while (i < pts.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1];
    const u = seg > 0 ? (d - cum[i - 1]) / seg : 0;
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
  };
  const d0 = t0 * total;
  const d1 = t1 * total;
  const out: LngLat[] = [at(d0)];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > d0 && cum[i] < d1) out.push(pts[i]);
  out.push(at(d1));
  return out;
}

function pieces(g: RoadGraph, mode: RoadMode, p: RoadPath): Piece[] {
  return p.states.map((s, i) => {
    const dir = s & 1;
    const full = edgePoints(g, s);
    const last = i === p.states.length - 1;
    // Fractions along the travel direction.
    let t0 = 0;
    let t1 = 1;
    if (i === 0) t0 = dir === 0 ? p.fromT : 1 - p.fromT;
    if (last) t1 = dir === 0 ? p.toT : 1 - p.toT;
    const pts = t0 === 0 && t1 === 1 ? full : slice(full, t0, Math.max(t0, t1));
    const part = Math.max(0, t1 - t0);
    return {
      state: s,
      pts,
      lengthM: part * g.len[s >> 1],
      durationS: part * edgeSeconds(g, mode, s >> 1),
      turnS: i > 0 ? Math.max(0, transitionSeconds(g, mode, p.states[i - 1], s)) : 0,
    };
  });
}

function wayName(g: RoadGraph, e: number, lang: string): { name: string; ref: string } {
  const w = g.ways[g.way[e]];
  // No name in the reader's language: the local (Georgian) name in their script, as everywhere else in the app.
  const name = lang === 'ru' ? w.nameRu || localizeScript(w.name, 'ru') || w.nameEn : w.nameEn || localizeScript(w.name, 'en') || w.nameRu;
  return { name: (name ?? '').split(';')[0].trim(), ref: localizeScript((w.ref ?? '').split(';')[0].trim(), lang) };
}

function modifierOf(angle: number): string {
  const a = Math.abs(angle);
  const side = angle > 0 ? 'right' : 'left';
  if (a < 20) return 'straight';
  if (a < 60) return `slight ${side}`;
  if (a < 140) return side;
  if (a < 170) return `sharp ${side}`;
  return 'uturn';
}

const LANE_WORD: Record<string, string> = {
  through: 'straight',
  left: 'left',
  right: 'right',
  slight_left: 'slight left',
  slight_right: 'slight right',
  sharp_left: 'sharp left',
  sharp_right: 'sharp right',
  reverse: 'uturn',
};

/** OSM turn:lanes ("left|through;right") → lanes, valid where they lead the way the maneuver goes. */
export function lanesFor(tag: string, modifier: string): { indications: string[]; valid: boolean }[] | undefined {
  if (!tag) return undefined;
  const family = (m: string) => (m.includes('left') ? 'left' : m.includes('right') ? 'right' : m === 'uturn' ? 'uturn' : 'straight');
  const want = family(modifier);
  const lanes = tag.split('|').map((l) => {
    const ind = l
      .split(';')
      .map((x) => LANE_WORD[x.trim()] ?? 'none')
      .filter((x, i, a) => a.indexOf(x) === i);
    const valid = ind.some((x) => x !== 'none' && family(x) === want) || (want === 'straight' && ind.every((x) => x === 'none'));
    return { indications: ind, valid };
  });
  return lanes.some((l) => l.valid) && lanes.length > 1 ? lanes : undefined;
}

/** Other ways a mode could leave node v, coming in on `sIn` (not back the same road). */
function options(g: RoadGraph, mode: RoadMode, sIn: number): number[] {
  const v = headOf(g, sIn);
  const out: number[] = [];
  for (let k = g.outStart[v]; k < g.outStart[v + 1]; k++) {
    const o = g.outState[k];
    if (o >> 1 === sIn >> 1) continue;
    if (!allowed(mode, g.access[o >> 1], o & 1)) continue;
    if (transitionSeconds(g, mode, sIn, o) < 0) continue;
    out.push(o);
  }
  return out;
}

const isHighway = (g: RoadGraph, e: number) => g.cls[e] <= CLASS.trunk && !isLink(g, e);

function classesOf(g: RoadGraph, e: number): string[] {
  const c: string[] = [];
  if (g.attr[e] & ATTR.toll) c.push('toll');
  if (g.cls[e] === CLASS.motorway) c.push('motorway');
  if (g.attr[e] & ATTR.ferry) c.push('ferry');
  if (g.attr[e] & ATTR.tunnel) c.push('tunnel');
  return c;
}

interface Decision {
  type: string;
  modifier?: string;
  exit?: number;
}

/** Road looked at on each side of a junction to see how far it really turns. */
const CORNER_M = 40;
/** A renamed road that turns at least this much across its corner is announced as a turn, not a silent new name. */
const CORNER_TURN_DEG = 40;

/** Can a mode go another way at the node where piece k starts? */
function hasChoice(g: RoadGraph, mode: RoadMode, ps: Piece[], k: number): boolean {
  return options(g, mode, ps[k - 1].state).some((o) => o !== ps[k].state);
}

/**
 * How much the road turns across the corner at the node where piece k starts: from the heading ~40 m before it to
 * the heading ~40 m after it. Mapped corners are often curves of short segments, so the last segment before a
 * junction may already point most of the way round, and the angle at the node itself looks like "straight on". The
 * walk follows bends only (nodes with no other way to go), so the next junction's turn is never counted in.
 */
function cornerAngle(g: RoadGraph, mode: RoadMode, ps: Piece[], k: number): number {
  const node = ps[k].pts[0];
  let back = node;
  let acc = 0;
  for (let j = k - 1; j >= 0 && acc < CORNER_M; j--) {
    const pts = ps[j].pts;
    for (let i = pts.length - 2; i >= 0 && acc < CORNER_M; i--) {
      acc += haversine(pts[i], pts[i + 1]);
      back = pts[i];
    }
    if (j > 0 && hasChoice(g, mode, ps, j)) break;
  }
  let ahead = node;
  acc = 0;
  for (let j = k; j < ps.length && acc < CORNER_M; j++) {
    if (j > k && hasChoice(g, mode, ps, j)) break;
    const pts = ps[j].pts;
    for (let i = 1; i < pts.length && acc < CORNER_M; i++) {
      acc += haversine(pts[i - 1], pts[i]);
      ahead = pts[i];
    }
  }
  if (back === node || ahead === node) return turnAngle(g.endBear[ps[k - 1].state], g.startBear[ps[k].state]);
  return turnAngle(bearing(back, node), bearing(node, ahead));
}

/** Is a maneuver needed between pieces k-1 and k, and which? */
function decide(g: RoadGraph, mode: RoadMode, ps: Piece[], k: number, lang: string): Decision | null {
  const sIn = ps[k - 1].state;
  const sOut = ps[k].state;
  const eIn = sIn >> 1;
  const eOut = sOut >> 1;
  const angle = turnAngle(g.endBear[sIn], g.startBear[sOut]);
  const inRb = isRoundabout(g, eIn);
  const outRb = isRoundabout(g, eOut);
  if (inRb && outRb) return null;
  if (!inRb && outRb) {
    // Count exits passed until the one taken.
    let exit = 0;
    let j = k;
    for (; j < ps.length && isRoundabout(g, ps[j].state >> 1); j++) {
      if (j + 1 < ps.length && !isRoundabout(g, ps[j + 1].state >> 1)) {
        exit++;
        break;
      }
      exit += options(g, mode, ps[j].state).filter((o) => !isRoundabout(g, o >> 1)).length;
    }
    const leave = j + 1 < ps.length ? ps[j + 1].state : ps[ps.length - 1].state;
    const turn = turnAngle(g.endBear[sIn], g.startBear[leave]);
    return { type: 'roundabout', modifier: modifierOf(turn), exit: Math.max(1, exit) };
  }
  if (inRb && !outRb) return { type: 'exit roundabout', modifier: modifierOf(angle) };

  const opts = options(g, mode, sIn).filter((o) => o !== sOut);
  const nameIn = wayName(g, eIn, lang);
  const nameOut = wayName(g, eOut, lang);
  const renamed = nameIn.name !== nameOut.name || nameIn.ref !== nameOut.ref;

  if (mode === 'drive') {
    if (isLink(g, eOut) && !isLink(g, eIn)) {
      if (isHighway(g, eIn)) return { type: 'off ramp', modifier: angle < 0 ? 'slight left' : 'slight right' };
      return opts.length || Math.abs(angle) >= 30 ? { type: 'on ramp', modifier: modifierOf(angle) } : null;
    }
    if (isLink(g, eIn) && !isLink(g, eOut) && isHighway(g, eOut)) {
      return { type: 'merge', modifier: angle < 0 ? 'slight left' : 'slight right' };
    }
  }
  // Onto a road with another name round a real corner (often a curve of short segments, with no other way to go
  // at the node itself): that is a turn the driver must be told about, not a silent name change — otherwise the next
  // thing announced can be the arrival, kilometres early.
  const corner = renamed ? cornerAngle(g, mode, ps, k) : 0;
  const cornerTurn = renamed && Math.abs(corner) >= CORNER_TURN_DEG && Math.abs(corner) > Math.abs(angle);
  if (!opts.length) return cornerTurn ? { type: 'turn', modifier: modifierOf(corner) } : renamed ? { type: 'new name', modifier: 'straight' } : null;

  const others = opts.map((o) => turnAngle(g.endBear[sIn], g.startBear[o]));
  const straightOther = others.some((a) => Math.abs(a) < 35);
  const abs = Math.abs(angle);
  const straightest = others.every((a) => abs <= Math.abs(a) + 10);

  // The road simply goes on (same name, the straightest way): nothing to say.
  if (!renamed && straightest && abs < 45) return null;

  // Two ways on ahead and we take one of them: a fork.
  if (abs < 45 && others.some((a) => Math.abs(a) < 45) && (isHighway(g, eIn) || isLink(g, eIn))) {
    const other = others.reduce((m, a) => (Math.abs(a) < Math.abs(m) ? a : m), others[0]);
    return { type: 'fork', modifier: angle < other ? 'slight left' : 'slight right' };
  }
  // No way on straight ahead: the end of the road.
  if (abs >= 45 && abs <= 135 && !straightOther && others.some((a) => Math.sign(a) !== Math.sign(angle) && Math.abs(a) >= 45)) {
    return { type: 'end of road', modifier: angle > 0 ? 'right' : 'left' };
  }
  if (abs >= 35) return { type: 'turn', modifier: modifierOf(angle) };
  // Bearing off while another road goes straighter on.
  if (others.some((a) => Math.abs(a) + 10 < abs)) return { type: 'turn', modifier: angle > 0 ? 'slight right' : 'slight left' };
  if (cornerTurn) return { type: 'turn', modifier: modifierOf(corner) };
  return renamed ? { type: 'new name', modifier: 'straight' } : null;
}

/** One leg (a path between two stops) as OSRM steps. */
export function buildLeg(g: RoadGraph, mode: RoadMode, paths: RoadPath[], lang: string): { leg: OsrmLikeLeg; coords: LngLat[] } {
  // Several paths = silent via points: driven straight through, one leg.
  const ps: Piece[] = [];
  for (const p of paths) {
    const list = pieces(g, mode, p);
    for (const pc of list) {
      // Two pieces of the same state back to back (a via point mid-edge) become one.
      const prev = ps[ps.length - 1];
      if (prev && prev.state === pc.state && ps.length && pc.turnS === 0) {
        prev.pts = prev.pts.concat(pc.pts.slice(1));
        prev.lengthM += pc.lengthM;
        prev.durationS += pc.durationS;
        continue;
      }
      ps.push(pc);
    }
  }

  const coords: LngLat[] = [];
  const annDist: number[] = [];
  const annDur: number[] = [];
  const steps: OsrmLikeStep[] = [];
  let cur: OsrmLikeStep | null = null;

  const open = (type: string, k: number, d?: Decision): OsrmLikeStep => {
    const e = ps[k].state >> 1;
    const { name, ref } = wayName(g, e, lang);
    const loc = ps[k].pts[0];
    const before = k > 0 ? g.endBear[ps[k - 1].state] : 0;
    const after = g.startBear[ps[k].state];
    const w = g.ways[g.way[e]];
    const step: OsrmLikeStep = {
      distance: 0,
      duration: 0,
      name,
      ...(ref ? { ref } : {}),
      ...(w.dest && (type === 'off ramp' || type === 'on ramp' || type === 'fork') ? { destinations: w.dest } : {}),
      driving_side: 'right',
      geometry: { coordinates: [loc] },
      intersections: [{ location: loc }],
      maneuver: { type, location: loc, bearing_before: Math.round(before), bearing_after: Math.round(after) },
    };
    if (d?.modifier && type !== 'depart') step.maneuver.modifier = d.modifier;
    if (d?.exit) step.maneuver.exit = d.exit;
    if (k > 0 && mode === 'drive' && d?.modifier) {
      const sIn = ps[k - 1].state;
      const wi = g.ways[g.way[sIn >> 1]];
      const tag = (sIn & 1) === 0 ? wi.lanesFwd : wi.lanesBwd;
      const lanes = lanesFor(tag, d.modifier);
      if (lanes) {
        step.intersections[0].lanes = lanes;
        // The lanes belong to the mapped road the tag is on — shown only once the car is on it, not from the
        // junction before (where the road may have other lanes).
        let approach = 0;
        for (let j = k - 1; j >= 0 && g.way[ps[j].state >> 1] === g.way[sIn >> 1] && (ps[j].state & 1) === (sIn & 1); j--) {
          approach += ps[j].lengthM;
        }
        step.intersections[0].lanes_approach = Math.round(approach);
      }
    }
    steps.push(step);
    return step;
  };

  ps.forEach((pc, k) => {
    if (k === 0) cur = open('depart', 0);
    else {
      const d = decide(g, mode, ps, k, lang);
      if (d?.type === 'new name') {
        // A silent name change only when the road gets a real, different name (not unnamed bits of a bridge).
        const next = wayName(g, pc.state >> 1, lang);
        const now = cur as OsrmLikeStep | null;
        if (now && !now.name && next.name) {
          now.name = next.name;
          if (next.ref) now.ref = next.ref;
        } else if (next.name && (next.name !== now?.name || next.ref !== (now?.ref ?? ''))) cur = open(d.type, k, d);
      } else if (d) cur = open(d.type, k, d);
    }
    const step = cur as OsrmLikeStep;
    const cls = classesOf(g, pc.state >> 1);
    if (cls.length) {
      const it = step.intersections[0];
      it.classes = [...new Set([...(it.classes ?? []), ...cls])];
    }
    // Geometry and per-segment timing.
    const segLens: number[] = [];
    for (let i = 1; i < pc.pts.length; i++) segLens.push(haversine(pc.pts[i - 1], pc.pts[i]));
    const sum = segLens.reduce((a, b) => a + b, 0);
    if (!coords.length) coords.push(pc.pts[0]);
    for (let i = 1; i < pc.pts.length; i++) {
      coords.push(pc.pts[i]);
      step.geometry.coordinates.push(pc.pts[i]);
      const share = sum > 0 ? segLens[i - 1] / sum : 1 / segLens.length;
      annDist.push(segLens[i - 1]);
      annDur.push(pc.durationS * share + (i === 1 ? pc.turnS : 0));
    }
    step.distance += pc.lengthM;
    step.duration += pc.durationS + pc.turnS;
  });

  const lastPc = ps[ps.length - 1];
  const end = lastPc.pts[lastPc.pts.length - 1];
  const lastName = wayName(g, lastPc.state >> 1, lang);
  steps.push({
    distance: 0,
    duration: 0,
    name: lastName.name,
    ...(lastName.ref ? { ref: lastName.ref } : {}),
    driving_side: 'right',
    geometry: { coordinates: [end] },
    intersections: [{ location: end }],
    maneuver: { type: 'arrive', location: end, bearing_before: Math.round(g.endBear[lastPc.state]), bearing_after: 0 },
  });

  // Degenerate geometry (start and end on the same spot): two points, as OSRM does.
  if (coords.length < 2) {
    coords.push(coords[0]);
    annDist.push(0);
    annDur.push(0);
  }

  const distance = ps.reduce((a, p) => a + p.lengthM, 0);
  const duration = ps.reduce((a, p) => a + p.durationS + p.turnS, 0);
  return { leg: { distance, duration, summary: summaryOf(g, ps, lang), steps, annotation: { distance: annDist, duration: annDur } }, coords };
}

/** The two roads driven longest, in the order driven (OSRM's leg summary). */
function summaryOf(g: RoadGraph, ps: Piece[], lang: string): string {
  const by = new Map<string, { len: number; first: number }>();
  ps.forEach((p, i) => {
    const { name, ref } = wayName(g, p.state >> 1, lang);
    const key = ref || name;
    if (!key) return;
    const v = by.get(key) ?? { len: 0, first: i };
    v.len += p.lengthM;
    by.set(key, v);
  });
  return [...by.entries()]
    .sort((a, b) => b[1].len - a[1].len)
    .slice(0, 2)
    .sort((a, b) => a[1].first - b[1].first)
    .map(([k]) => k)
    .join(', ');
}

/** Legs → one route; consecutive legs share their joining point once in the overview geometry. */
export function buildRoute(legs: { leg: OsrmLikeLeg; coords: LngLat[] }[]): OsrmLikeRoute {
  const coords: LngLat[] = [];
  legs.forEach((l, i) => coords.push(...(i === 0 ? l.coords : l.coords.slice(1))));
  return {
    distance: legs.reduce((a, l) => a + l.leg.distance, 0),
    duration: legs.reduce((a, l) => a + l.leg.duration, 0),
    geometry: { coordinates: coords },
    legs: legs.map((l) => l.leg),
  };
}
