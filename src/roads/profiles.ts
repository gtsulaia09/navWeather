import { ACCESS, CLASS } from './format';

/** How a road is travelled: by car, by bike, on foot (ADR-019). */
export type RoadMode = 'drive' | 'bike' | 'walk';

/** Bike speeds by class (km/h); footways and pedestrian streets mean pushing the bike. */
const BIKE_KMH: Record<number, number> = {
  [CLASS.cycleway]: 18,
  [CLASS.path]: 12,
  [CLASS.track]: 12,
  [CLASS.bridleway]: 8,
  [CLASS.footway]: 6,
  [CLASS.pedestrian]: 6,
  [CLASS.steps]: 2,
  [CLASS.living_street]: 12,
};
const BIKE_DEFAULT_KMH = 16;
const FOOT_KMH = 5;
const STEPS_FOOT_KMH = 3.5;

/** Can this mode use the edge in this direction (dir 0: a→b, 1: b→a)? */
export function allowed(mode: RoadMode, access: number, dir: number): boolean {
  if (mode === 'drive') return (access & (dir === 0 ? ACCESS.carFwd : ACCESS.carBwd)) !== 0;
  if (mode === 'bike') return (access & (dir === 0 ? ACCESS.bikeFwd : ACCESS.bikeBwd)) !== 0;
  return (access & ACCESS.foot) !== 0;
}

/** Travel speed (m/s) of a mode on an edge. Ferries move every mode at the ferry's own speed. */
export function speedMps(mode: RoadMode, cls: number, carKmh: number): number {
  if (cls === CLASS.ferry) return Math.max(1, carKmh) / 3.6;
  if (mode === 'drive') return Math.max(1, carKmh) / 3.6;
  if (mode === 'bike') return (BIKE_KMH[cls] ?? BIKE_DEFAULT_KMH) / 3.6;
  return (cls === CLASS.steps ? STEPS_FOOT_KMH : FOOT_KMH) / 3.6;
}

/** Fastest a mode can go anywhere (m/s): keeps the A* estimate a true lower bound. */
export function topSpeedMps(mode: RoadMode, maxCarKmh: number, maxFerryKmh: number): number {
  const ferry = maxFerryKmh / 3.6;
  if (mode === 'drive') return Math.max(maxCarKmh / 3.6, ferry, 1);
  if (mode === 'bike') return Math.max(18 / 3.6, ferry);
  return Math.max(FOOT_KMH / 3.6, ferry);
}

/** Seconds lost at a traffic light. */
export function signalDelayS(mode: RoadMode): number {
  return mode === 'drive' ? 8 : mode === 'bike' ? 5 : 3;
}

/**
 * Seconds a turn costs. `angle` is the change of heading in degrees, -180…180, positive to the right. Traffic drives on
 * the right: a left turn crosses oncoming traffic and costs more.
 */
export function turnCostS(mode: RoadMode, angle: number): number {
  const a = Math.abs(angle);
  if (mode === 'walk') return 0;
  if (a < 30) return 0;
  if (mode === 'bike') return a > 150 ? 6 : 2;
  if (a > 150) return 25;
  const base = angle > 0 ? 3 : 7;
  return a > 110 ? base + 4 : base;
}
