import type { BBox, LngLat, Place } from '../types/geo';
import type { Route, RouteLeg, RouteSegment, TransitLeg, TransitVehicle } from '../types/route';
import { haversineM } from '../utils/distance';
import { zonedParts } from '../utils/timezone';
import type { RawTransitBundle, TransitNetwork } from './types';

/** Walking speed for access, egress, and transfer legs (1.25 m/s ≈ 4.5 km/h). */
const WALK_MPS = 1.25;
/** Road-network detour multiplier over straight-line walking distance. */
const WALK_DETOUR = 1.25;
/** Minimum transfer buffer at a stop (minutes). */
const TRANSFER_BUFFER_MIN = 2;
/** Maximum rounds = 3 (0, 1, or 2 transfers). */
const MAX_ROUNDS = 3;
/** Maximum transit options returned to the UI. */
const MAX_OPTIONS = 4;

/** Build reverse stop→patterns index once per loaded region bundle. */
export function indexTransitNetwork(bundle: RawTransitBundle): TransitNetwork {
  const stopPatterns: [number, number][][] = Array.from({ length: bundle.stops.length }, () => []);
  for (let p = 0; p < bundle.patterns.length; p++) {
    const stops = bundle.patterns[p].s;
    for (let pos = 0; pos < stops.length; pos++) {
      stopPatterns[stops[pos]].push([p, pos]);
    }
  }
  return { bundle, stopPatterns };
}

/** Default high-contrast line colors when a GTFS feed omits `route_color`. */
function defaultLineColor(vehicle: TransitVehicle): { color: string; textColor: string } {
  switch (vehicle) {
    case 'subway':
      return { color: '#d93025', textColor: '#ffffff' };
    case 'rail':
      return { color: '#1a73e8', textColor: '#ffffff' };
    case 'tram':
      return { color: '#188038', textColor: '#ffffff' };
    case 'cable':
      return { color: '#e37400', textColor: '#ffffff' };
    case 'ferry':
      return { color: '#007b83', textColor: '#ffffff' };
    default:
      return { color: '#0b57d0', textColor: '#ffffff' };
  }
}

interface NearbyStop {
  idx: number;
  walkM: number;
  walkMin: number;
}

/** Find stops near `coord`, widening search radius if sparse (e.g. intercity railway stations). */
function findNearbyStops(bundle: RawTransitBundle, coord: LngLat): NearbyStop[] {
  const [lon, lat] = coord;
  const near: NearbyStop[] = [];
  const wide: NearbyStop[] = [];
  for (let i = 0; i < bundle.stops.length; i++) {
    const [sLat, sLon] = bundle.stops[i];
    // Fast bounding-box reject (~3 km)
    if (Math.abs(sLat - lat) > 0.03 || Math.abs(sLon - lon) > 0.04) continue;
    const straight = haversineM(coord, [sLon, sLat]);
    if (straight <= 900) {
      const walkM = Math.round(straight * WALK_DETOUR);
      near.push({ idx: i, walkM, walkMin: Math.max(1, Math.ceil(walkM / (WALK_MPS * 60))) });
    } else if (straight <= 3000) {
      const walkM = Math.round(straight * WALK_DETOUR);
      wide.push({ idx: i, walkM, walkMin: Math.max(1, Math.ceil(walkM / (WALK_MPS * 60))) });
    }
  }
  near.sort((a, b) => a.walkM - b.walkM);
  if (near.length >= 3) return near.slice(0, 14);
  wide.sort((a, b) => a.walkM - b.walkM);
  return [...near, ...wide].slice(0, 14);
}

/**
 * Find the earliest trip on `pattern` departing stop index `pos` at or after `earliestMin`,
 * running on `dayBit` (day 0) or `nextDayBit` (day 1, shifted +1440 min).
 * Returns `{ depMin, dayOffset, startMin }` or null.
 */
function earliestTrip(
  trips: number[],
  stopOffsetMin: number,
  earliestMin: number,
  dayBit0: number,
  dayBit1: number,
): { depMin: number; startMin: number } | null {
  // Check today (dayOffset = 0)
  const target0 = earliestMin - stopOffsetMin;
  let lo = 0;
  let hi = trips.length / 2;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (trips[mid * 2] < target0) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo * 2; i < trips.length; i += 2) {
    if (trips[i + 1] & dayBit0) {
      const startMin = trips[i];
      return { depMin: startMin + stopOffsetMin, startMin };
    }
  }

  // Wrap to tomorrow (dayOffset = 1, +1440 min) for late-night / next-morning queries
  const target1 = earliestMin - 1440 - stopOffsetMin;
  lo = 0;
  hi = trips.length / 2;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (trips[mid * 2] < target1) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo * 2; i < trips.length; i += 2) {
    if (trips[i + 1] & dayBit1) {
      const startMin = trips[i] + 1440;
      return { depMin: startMin + stopOffsetMin, startMin };
    }
  }
  return null;
}

interface Label {
  kind: 'ride' | 'transfer';
  fromStop: number;
  patIdx: number;
  boardPos: number;
  alightPos: number;
  boardMin: number;
  alightMin: number;
  walkM: number;
}

interface RawItinerary {
  transfers: number;
  departMin: number;
  arriveMin: number;
  originWalk: NearbyStop;
  destWalk: NearbyStop;
  steps: Label[];
}

/** Run one RAPTOR pass starting at `departMin` (local minutes since midnight of day 0). */
function runRaptorPass(
  net: TransitNetwork,
  originStops: NearbyStop[],
  destStops: NearbyStop[],
  departMin: number,
  dayBit0: number,
  dayBit1: number,
): RawItinerary[] {
  const { bundle, stopPatterns } = net;
  const nStops = bundle.stops.length;
  const INF = 1e9;

  // tau[k][s] = earliest arrival at stop s after at most k transit rides
  const tau: Int32Array[] = Array.from({ length: MAX_ROUNDS + 1 }, () => {
    const a = new Int32Array(nStops);
    a.fill(INF);
    return a;
  });
  const bestOverall = new Int32Array(nStops);
  bestOverall.fill(INF);

  // Backpointers: parent[k][s]
  const parent: (Label | undefined)[][] = Array.from({ length: MAX_ROUNDS + 1 }, () => new Array(nStops));
  const originByStop = new Map<number, NearbyStop>();

  let marked = new Set<number>();
  for (const o of originStops) {
    const arr = departMin + o.walkMin;
    if (arr < tau[0][o.idx]) {
      tau[0][o.idx] = arr;
      bestOverall[o.idx] = arr;
      originByStop.set(o.idx, o);
      marked.add(o.idx);
    }
  }

  const destMap = new Map<number, NearbyStop>();
  for (const d of destStops) destMap.set(d.idx, d);

  const results: RawItinerary[] = [];

  for (let k = 1; k <= MAX_ROUNDS; k++) {
    // Copy previous round baseline into tau[k]
    tau[k].set(tau[k - 1]);

    // Collect patterns serving marked stops, keeping earliest marked stop index in each pattern
    const Q = new Map<number, number>();
    for (const s of marked) {
      for (const [p, pos] of stopPatterns[s]) {
        const prev = Q.get(p);
        if (prev === undefined || pos < prev) Q.set(p, pos);
      }
    }

    const nextMarked = new Set<number>();

    // Scan each active pattern
    for (const [p, startPos] of Q) {
      const pat = bundle.patterns[p];
      const pStops = pat.s;
      const pOff = pat.o;
      let activeTrip: { startMin: number; boardPos: number; boardStop: number; boardMin: number } | null = null;

      for (let pos = startPos; pos < pStops.length; pos++) {
        const s = pStops[pos];

        // 1. Can we alight from activeTrip and improve arrival at s?
        if (activeTrip && pos > activeTrip.boardPos) {
          const arr = activeTrip.startMin + pOff[pos];
          if (arr < bestOverall[s] && arr < tau[k][s]) {
            tau[k][s] = arr;
            bestOverall[s] = arr;
            parent[k][s] = {
              kind: 'ride',
              fromStop: activeTrip.boardStop,
              patIdx: p,
              boardPos: activeTrip.boardPos,
              alightPos: pos,
              boardMin: activeTrip.boardMin,
              alightMin: arr,
              walkM: 0,
            };
            nextMarked.add(s);
          }
        }

        // 2. Can we catch an earlier trip on this pattern at stop s from round k-1?
        const prevArr = tau[k - 1][s];
        if (prevArr < INF) {
          const earliestBoard = k === 1 ? prevArr : prevArr + TRANSFER_BUFFER_MIN;
          if (!activeTrip || earliestBoard < activeTrip.startMin + pOff[pos]) {
            const found = earliestTrip(pat.t, pOff[pos], earliestBoard, dayBit0, dayBit1);
            if (found && (!activeTrip || found.startMin < activeTrip.startMin)) {
              activeTrip = {
                startMin: found.startMin,
                boardPos: pos,
                boardStop: s,
                boardMin: found.depMin,
              };
            }
          }
        }
      }
    }

    // Check best destination arrival after round k (before expanding footpaths for round k+1)
    let bestDest: { stop: number; arriveMin: number; dest: NearbyStop } | null = null;
    for (const [dIdx, dInfo] of destMap) {
      if (parent[k][dIdx] && tau[k][dIdx] < INF) {
        const totalArr = tau[k][dIdx] + dInfo.walkMin;
        if (!bestDest || totalArr < bestDest.arriveMin) {
          bestDest = { stop: dIdx, arriveMin: totalArr, dest: dInfo };
        }
      }
    }

    if (bestDest) {
      // Reconstruct steps backwards from round k
      const steps: Label[] = [];
      let curStop = bestDest.stop;
      let curK = k;
      let ok = true;
      while (curK > 0) {
        const lbl = parent[curK][curStop];
        if (!lbl) {
          ok = false;
          break;
        }
        steps.push(lbl);
        curStop = lbl.fromStop;
        if (lbl.kind === 'ride') curK--;
      }
      const originWalk = originByStop.get(curStop);
      if (ok && originWalk && steps.length > 0) {
        steps.reverse();
        const firstRide = steps[0];
        // Tighten departure so user leaves just in time to walk to the first stop
        const actualDepartMin = Math.max(departMin, firstRide.boardMin - originWalk.walkMin);
        results.push({
          transfers: k - 1,
          departMin: actualDepartMin,
          arriveMin: bestDest.arriveMin,
          originWalk,
          destWalk: bestDest.dest,
          steps,
        });
      }
    }

    // Expand footpaths from newly reached stops for the next round
    if (k < MAX_ROUNDS) {
      const transferAdded: number[] = [];
      for (const s of nextMarked) {
        const arrAtS = tau[k][s];
        const edges = bundle.transfers[s];
        if (!edges) continue;
        for (let i = 0; i < edges.length; i += 2) {
          const nb = edges[i];
          const distM = edges[i + 1];
          const walkM = Math.round(distM * WALK_DETOUR);
          const walkMin = Math.max(1, Math.ceil(walkM / (WALK_MPS * 60)));
          const arrNb = arrAtS + walkMin;
          if (arrNb < tau[k][nb] && arrNb < bestOverall[nb]) {
            tau[k][nb] = arrNb;
            bestOverall[nb] = arrNb;
            parent[k][nb] = {
              kind: 'transfer',
              fromStop: s,
              patIdx: -1,
              boardPos: -1,
              alightPos: -1,
              boardMin: arrAtS,
              alightMin: arrNb,
              walkM,
            };
            transferAdded.push(nb);
          }
        }
      }
      for (const s of transferAdded) nextMarked.add(s);
    }

    marked = nextMarked;
    if (marked.size === 0) break;
  }

  return results;
}

/** Convert a RawItinerary into our standard `Route` + `TransitTrip` structure. */
function toRoute(
  it: RawItinerary,
  idx: number,
  bundle: RawTransitBundle,
  origin: Place,
  destination: Place,
  midnightUtcMs: number,
): Route {
  const minToMs = (m: number) => midnightUtcMs + m * 60_000;
  const geometry: LngLat[] = [];
  const transitLegs: TransitLeg[] = [];
  const segments: RouteSegment[] = [];
  let totalDistM = 0;

  const pushCoord = (c: LngLat): number => {
    const prev = geometry[geometry.length - 1];
    if (prev && prev[0] === c[0] && prev[1] === c[1]) return geometry.length - 1;
    geometry.push(c);
    return geometry.length - 1;
  };

  const addLegSegments = (fromIdx: number, toIdx: number, legDistM: number, legDurS: number) => {
    const count = Math.max(1, toIdx - fromIdx);
    for (let i = fromIdx; i < toIdx; i++) {
      segments.push({
        fromIndex: i,
        toIndex: i + 1,
        distanceM: legDistM / count,
        durationS: legDurS / count,
      });
    }
  };

  // 1. Access walk from origin to first boarding stop
  const firstStop = bundle.stops[it.originWalk.idx];
  const firstCoord: LngLat = [firstStop[1], firstStop[0]];
  const accessStart = pushCoord(origin.coordinate);
  const accessEnd = pushCoord(firstCoord);
  const accessDepMs = minToMs(it.departMin);
  const accessArrMs = minToMs(it.departMin + it.originWalk.walkMin);
  transitLegs.push({
    vehicle: 'walk',
    fromName: origin.name,
    toName: firstStop[2],
    departMs: accessDepMs,
    arriveMs: accessArrMs,
    distanceM: it.originWalk.walkM,
    stops: 0,
    realTime: false,
    fromIndex: accessStart,
    toIndex: accessEnd,
  });
  addLegSegments(accessStart, accessEnd, it.originWalk.walkM, (accessArrMs - accessDepMs) / 1000);
  totalDistM += it.originWalk.walkM;

  // 2. Transit rides and transfer walks
  for (let sIdx = 0; sIdx < it.steps.length; sIdx++) {
    const step = it.steps[sIdx];
    if (step.kind === 'transfer') {
      const fromS = bundle.stops[step.fromStop];
      const nextStep = it.steps[sIdx + 1];
      const toStopIdx = nextStep ? nextStep.fromStop : step.fromStop;
      const toS = bundle.stops[toStopIdx];
      const fIdx = pushCoord([fromS[1], fromS[0]]);
      const tIdx = pushCoord([toS[1], toS[0]]);
      const depMs = minToMs(step.boardMin);
      const arrMs = minToMs(step.alightMin);
      transitLegs.push({
        vehicle: 'walk',
        fromName: fromS[2],
        toName: toS[2],
        departMs: depMs,
        arriveMs: arrMs,
        distanceM: step.walkM,
        stops: 0,
        realTime: false,
        fromIndex: fIdx,
        toIndex: tIdx,
      });
      addLegSegments(fIdx, tIdx, step.walkM, Math.max(60, (arrMs - depMs) / 1000));
      totalDistM += step.walkM;
      continue;
    }

    // Same-stop wait/change between two consecutive rides
    if (sIdx > 0 && it.steps[sIdx - 1].kind === 'ride') {
      const prevRide = it.steps[sIdx - 1];
      const waitMin = Math.max(0, step.boardMin - prevRide.alightMin);
      if (waitMin > 0) {
        const stop = bundle.stops[step.fromStop];
        const idxPos = pushCoord([stop[1], stop[0]]);
        transitLegs.push({
          vehicle: 'walk',
          fromName: stop[2],
          toName: stop[2],
          departMs: minToMs(prevRide.alightMin),
          arriveMs: minToMs(step.boardMin),
          distanceM: 0,
          stops: 0,
          realTime: false,
          fromIndex: idxPos,
          toIndex: idxPos,
        });
      }
    }

    const pat = bundle.patterns[step.patIdx];
    const routeMeta = bundle.routes[pat.r];
    const fromStop = bundle.stops[pat.s[step.boardPos]];
    const toStop = bundle.stops[pat.s[step.alightPos]];
    const legStart = pushCoord([fromStop[1], fromStop[0]]);
    let legDistM = 0;
    let prevC: LngLat = [fromStop[1], fromStop[0]];
    for (let pos = step.boardPos + 1; pos <= step.alightPos; pos++) {
      const st = bundle.stops[pat.s[pos]];
      const c: LngLat = [st[1], st[0]];
      legDistM += haversineM(prevC, c);
      pushCoord(c);
      prevC = c;
    }
    const legEnd = geometry.length - 1;
    const depMs = minToMs(step.boardMin);
    const arrMs = minToMs(step.alightMin);
    const fallbackColors = defaultLineColor(routeMeta.v);
    transitLegs.push({
      vehicle: routeMeta.v,
      line: routeMeta.l,
      color: routeMeta.c ?? fallbackColors.color,
      textColor: routeMeta.tc ?? fallbackColors.textColor,
      headsign: pat.h || toStop[2],
      agency: routeMeta.a,
      fromName: fromStop[2],
      toName: toStop[2],
      departMs: depMs,
      arriveMs: arrMs,
      distanceM: Math.round(legDistM),
      stops: step.alightPos - step.boardPos,
      realTime: false,
      fromIndex: legStart,
      toIndex: legEnd,
    });
    addLegSegments(legStart, legEnd, Math.max(10, legDistM), Math.max(60, (arrMs - depMs) / 1000));
    totalDistM += Math.round(legDistM);
  }

  // 3. Egress walk from final alighting stop to destination
  const lastStop = bundle.stops[it.destWalk.idx];
  const egressStart = pushCoord([lastStop[1], lastStop[0]]);
  const egressEnd = pushCoord(destination.coordinate);
  const egressDepMs = minToMs(it.arriveMin - it.destWalk.walkMin);
  const egressArrMs = minToMs(it.arriveMin);
  transitLegs.push({
    vehicle: 'walk',
    fromName: lastStop[2],
    toName: destination.name,
    departMs: egressDepMs,
    arriveMs: egressArrMs,
    distanceM: it.destWalk.walkM,
    stops: 0,
    realTime: false,
    fromIndex: egressStart,
    toIndex: egressEnd,
  });
  addLegSegments(egressStart, egressEnd, it.destWalk.walkM, (egressArrMs - egressDepMs) / 1000);
  totalDistM += it.destWalk.walkM;

  // Compute bbox
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of geometry) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  const bbox: BBox = [minLon, minLat, maxLon, maxLat];
  const departMs = minToMs(it.departMin);
  const arriveMs = minToMs(it.arriveMin);
  const durationS = Math.max(60, Math.round((arriveMs - departMs) / 1000));

  const rideSummary = transitLegs
    .filter((l) => l.vehicle !== 'walk')
    .map((l) => l.line ?? l.vehicle)
    .join(' → ');

  const legs: RouteLeg[] = [
    {
      distanceM: totalDistM,
      durationS,
      summary: rideSummary || destination.name,
      steps: [],
    },
  ];

  return {
    id: `transit-${idx}-${departMs}-${arriveMs}`,
    provider: 'static-transit',
    origin,
    destination,
    geometry,
    distanceM: totalDistM,
    durationS,
    legs,
    segments,
    segmentSource: 'steps',
    bbox,
    computedAt: Date.now(),
    transit: {
      departMs,
      arriveMs,
      transfers: it.transfers,
      legs: transitLegs,
    },
  };
}

/**
 * Plan up to 4 public-transport itineraries between `origin` and `destination`
 * departing at or after `departAtMs`, using the on-device RAPTOR timetable engine.
 */
export function planTransit(
  net: TransitNetwork,
  origin: Place,
  destination: Place,
  departAtMs: number,
): Route[] {
  const { bundle } = net;
  const originStops = findNearbyStops(bundle, origin.coordinate);
  const destStops = findNearbyStops(bundle, destination.coordinate);
  if (originStops.length === 0 || destStops.length === 0) return [];

  // Convert departAtMs to local midnight + minute-of-day + weekday bits in bundle.tz
  const z = zonedParts(departAtMs, bundle.tz);
  const departMin = z.hour * 60 + z.minute;
  const midnightUtcMs = departAtMs - (departMin * 60 + z.second) * 1000;
  // Weekday of local date: Mon=0 .. Sun=6
  const localNoonUtc = Date.UTC(z.year, z.month - 1, z.day, 12, 0, 0);
  const dow0 = (new Date(localNoonUtc).getUTCDay() + 6) % 7;
  const dow1 = (dow0 + 1) % 7;
  const dayBit0 = 1 << dow0;
  const dayBit1 = 1 << dow1;

  const collected: RawItinerary[] = [];
  const seen = new Set<string>();

  const signature = (it: RawItinerary) => {
    const lines = it.steps
      .filter((s) => s.kind === 'ride')
      .map((s) => `${bundle.routes[bundle.patterns[s.patIdx].r].l}@${s.boardMin}`)
      .join('|');
    return `${lines}|${it.arriveMin}`;
  };

  const addPass = (startMin: number) => {
    const found = runRaptorPass(net, originStops, destStops, startMin, dayBit0, dayBit1);
    for (const it of found) {
      const sig = signature(it);
      if (seen.has(sig)) continue;
      seen.add(sig);
      collected.push(it);
    }
    return found;
  };

  // First pass at requested departure time
  const first = addPass(departMin);
  if (first.length === 0) return [];

  // Probe up to 3 later departure windows to offer upcoming departures (like Google Maps)
  let probeMin = Math.min(...first.map((x) => x.departMin)) + 3;
  for (let p = 0; p < 3 && collected.length < MAX_OPTIONS + 2; p++) {
    const next = addPass(probeMin);
    if (next.length === 0) break;
    const earliestNext = Math.min(...next.map((x) => x.departMin));
    probeMin = Math.max(probeMin + 5, earliestNext + 3);
  }

  // Filter out strictly dominated itineraries (depart earlier AND arrive later with >= transfers)
  collected.sort((a, b) => a.arriveMin - b.arriveMin || a.transfers - b.transfers || b.departMin - a.departMin);
  const pruned: RawItinerary[] = [];
  for (const cand of collected) {
    const dominated = pruned.some(
      (kept) =>
        kept.departMin >= cand.departMin &&
        kept.arriveMin <= cand.arriveMin &&
        kept.transfers <= cand.transfers,
    );
    if (!dominated) pruned.push(cand);
    if (pruned.length >= MAX_OPTIONS) break;
  }

  return pruned.map((it, idx) => toRoute(it, idx, bundle, origin, destination, midnightUtcMs));
}
