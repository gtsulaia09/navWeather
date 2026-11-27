import type { LngLat } from '../types/geo';
import type { RouteProgress, VehicleState } from '../types/navigation';
import type { TimedRoute } from '../types/route';
import { bearingDeg, bearingDelta, lowerIndex, type LineProjection } from '../utils/distance';
import { createRouteProjector } from './placesAlongRoute';
import { positionAtDistance, timeAtDistance } from './routeTiming';

export interface FixContext {
  headingDeg?: number;
  accuracyM?: number;
}

/**
 * Map matching for navigation. Keeps continuity with the previous position:
 *  - searches forward from the last match within what the vehicle could have
 *    driven since the last fix (generous: 55 m/s), plus a small back margin;
 *  - only jumps elsewhere when that is clearly better AND the heading agrees
 *    (so the opposite carriageway or a parallel road can't steal the match);
 *  - on the first fix, ties prefer the earlier part of the route (an
 *    out-and-back route must not snap to its end and "arrive" at once).
 */
export function createProgressTracker(timed: TimedRoute) {
  const project = createRouteProjector(timed);
  const coords = timed.route.geometry;
  const n = coords.length;
  let last: { along: number; t: number } | null = null;

  const indexAt = (d: number) => Math.max(0, Math.min(n - 1, lowerIndex(timed.cumDistM, d)));
  const segBearing = (i: number) => bearingDeg(coords[Math.min(i, n - 2)], coords[Math.min(i + 1, n - 1)]);
  const headingOk = (p: LineProjection, heading?: number) =>
    heading === undefined || !Number.isFinite(heading) || bearingDelta(segBearing(p.index), heading) <= 75;

  function firstMatch(p: LngLat, ctx: FixContext): LineProjection {
    let best = project(p);
    // Prefer a matching heading if the nearest segment runs the other way.
    if (!headingOk(best, ctx.headingDeg)) {
      const lo = project(p, { from: 0, to: Math.max(1, indexAt(best.distanceAlongM - 2000)) });
      const hi = project(p, { from: Math.min(n - 2, indexAt(best.distanceAlongM + 2000)), to: n - 1 });
      const alt = [lo, hi].filter((c) => headingOk(c, ctx.headingDeg)).sort((a, b) => a.distanceFromLineM - b.distanceFromLineM)[0];
      if (alt && alt.distanceFromLineM <= best.distanceFromLineM + 50) best = alt;
    }
    // Tie → earlier along the route.
    if (best.distanceAlongM > 2000) {
      const earlier = project(p, { from: 0, to: indexAt(best.distanceAlongM - 1000) });
      if (earlier.distanceFromLineM <= best.distanceFromLineM + 30 && headingOk(earlier, ctx.headingDeg)) best = earlier;
    }
    return best;
  }

  return function track(coordinate: LngLat, nowMs: number, ctx: FixContext = {}): RouteProgress {
    const accuracy = Math.max(5, ctx.accuracyM ?? 20);
    let proj: LineProjection;
    if (!last) {
      proj = firstMatch(coordinate, ctx);
    } else {
      const dt = Math.max(1, (nowMs - last.t) / 1000);
      const ahead = Math.max(300, dt * 55) + accuracy * 2;
      const back = 150 + accuracy;
      const windowed = project(coordinate, { from: indexAt(last.along - back), to: indexAt(last.along + ahead) + 1 });
      proj = windowed;
      if (windowed.distanceFromLineM > Math.max(60, accuracy * 2)) {
        const global = project(coordinate);
        const jump = Math.abs(global.distanceAlongM - last.along);
        if (
          jump > ahead &&
          global.distanceFromLineM < windowed.distanceFromLineM - 50 &&
          headingOk(global, ctx.headingDeg)
        ) {
          proj = global; // genuinely somewhere else on the route (e.g. after a long tunnel)
        }
      }
    }
    last = { along: proj.distanceAlongM, t: nowMs };
    const modelTimeS = timeAtDistance(timed, proj.distanceAlongM);
    const remainingTimeS = Math.max(0, timed.totalTimeS - modelTimeS);
    return {
      distanceAlongM: proj.distanceAlongM,
      modelTimeS,
      distanceFromRouteM: proj.distanceFromLineM,
      segmentIndex: proj.index,
      remainingDistanceM: Math.max(0, timed.totalDistM - proj.distanceAlongM),
      remainingTimeS,
      nowMs,
      etaMs: nowMs + remainingTimeS * 1000,
    };
  };
}

/** Expected road speed at a geometry edge (m/s), for deviation thresholds. */
export function edgeSpeedMps(timed: TimedRoute, index: number): number | undefined {
  const i = Math.max(0, Math.min(index, timed.cumDistM.length - 2));
  const dt = timed.cumTimeS[i + 1] - timed.cumTimeS[i];
  const dd = timed.cumDistM[i + 1] - timed.cumDistM[i];
  return dt > 0 ? dd / dt : undefined;
}

/** Direction of the route (degrees) at a geometry edge; undefined on a zero-length edge. */
export function routeBearingAt(timed: TimedRoute, index: number): number | undefined {
  const coords = timed.route.geometry;
  if (coords.length < 2) return undefined;
  const i = Math.max(0, Math.min(index, coords.length - 2));
  const a = coords[i];
  const b = coords[i + 1];
  return a[0] === b[0] && a[1] === b[1] ? undefined : bearingDeg(a, b);
}

/** Below this speed a GPS course is noise. */
const COURSE_MIN_MPS = 3;

/**
 * Where to draw the car. While it follows the route: ON the road (city GPS is often 10–30 m to the side, which put
 * the car among the buildings), facing the road's direction. As soon as it may be leaving the route: the raw fix, so
 * the driver sees it go and the new road is worked out from where the car really is.
 */
export function snapVehicle(
  timed: TimedRoute,
  fix: VehicleState,
  at: Pick<RouteProgress, 'distanceAlongM' | 'distanceFromRouteM'>,
  onRoute: boolean,
  maxSnapM: number,
): VehicleState {
  if (!onRoute || !(at.distanceFromRouteM <= maxSnapM)) return fix;
  const { coordinate, index } = positionAtDistance(timed, at.distanceAlongM);
  const road = routeBearingAt(timed, index);
  const course = fix.headingDeg !== undefined && Number.isFinite(fix.headingDeg) ? fix.headingDeg : undefined;
  // Driving back along the route (a U-turn) at speed: that is the way the car faces.
  const reversed = course !== undefined && road !== undefined && (fix.speedMps ?? 0) >= COURSE_MIN_MPS && bearingDelta(road, course) > 100;
  return { ...fix, coordinate, headingDeg: reversed ? course : (road ?? course) };
}

/** Arrived = near the end of the route AND actually on it (not beside it). */
export function hasArrived(p: RouteProgress): boolean {
  return p.remainingDistanceM < 40 && p.distanceFromRouteM < 60;
}
