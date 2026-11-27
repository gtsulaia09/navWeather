import { describe, expect, it } from 'vitest';
import type { LngLat } from '../types/geo';
import { tbilisiBatumiRoute } from '../test/helpers';
import { buildTimedRoute } from './routeTiming';
import { createProgressTracker, hasArrived, snapVehicle } from './routeProgress';

/** Out-and-back: 4 km east along 42°N, U-turn, back on a carriageway 15 m north. */
function outAndBack() {
  const kmLon = 1 / (111.32 * Math.cos((42 * Math.PI) / 180));
  const g: LngLat[] = [];
  for (let k = 0; k <= 40; k++) g.push([42 + (k / 10) * kmLon, 42]);
  for (let k = 40; k >= 0; k--) g.push([42 + (k / 10) * kmLon, 42 + 15 / 111_200]);
  const base = tbilisiBatumiRoute();
  return buildTimedRoute({
    ...base,
    id: 'oab',
    geometry: g,
    legs: [],
    distanceM: 8000,
    durationS: 600,
    segmentSource: 'proportional',
    segments: [{ fromIndex: 0, toIndex: g.length - 1, distanceM: 8000, durationS: 600 }],
  });
}

describe('map matching (progress tracking)', () => {
  it('does not snap the first fix of an out-and-back route to its end', () => {
    const t = outAndBack();
    const track = createProgressTracker(t);
    const p = track([42, 42 + 7 / 111_200], 0); // between both carriageways at the start
    expect(p.distanceAlongM).toBeLessThan(500);
    expect(hasArrived(p)).toBe(false);
  });

  it('ignores a noisy fix nearer the opposite carriageway', () => {
    const t = outAndBack();
    const track = createProgressTracker(t);
    const kmLon = 1 / (111.32 * Math.cos((42 * Math.PI) / 180));
    let p = track([42 + 0.5 * kmLon, 42], 0);
    p = track([42 + 0.8 * kmLon, 42 + 1 / 111_200], 10_000);
    expect(p.distanceAlongM / 1000).toBeCloseTo(0.8, 1);
    // Noisy fix drifted onto the return carriageway (15 m north).
    p = track([42 + 0.9 * kmLon, 42 + 14 / 111_200], 12_000);
    expect(p.distanceAlongM).toBeLessThan(1500); // still outbound, not ~7.1 km
    p = track([42 + 1.1 * kmLon, 42], 20_000);
    expect(p.distanceAlongM / 1000).toBeCloseTo(1.1, 1);
  });

  it('follows the vehicle along a real route and detects arrival only on the route', () => {
    const t = buildTimedRoute(tbilisiBatumiRoute());
    const track = createProgressTracker(t);
    const g = t.route.geometry;
    let p = track(g[0], 0);
    for (let i = 1; i < g.length; i += 25) p = track(g[i], i * 1000);
    p = track(g[g.length - 1], g.length * 1000);
    expect(p.remainingDistanceM).toBeLessThan(40);
    expect(hasArrived(p)).toBe(true);
    // Beside the destination but 200 m off the road → not "arrived".
    expect(hasArrived({ ...p, distanceFromRouteM: 200 })).toBe(false);
  });
});

describe('the car drawn on the road (real-drive bug 2026-11-27: the car showed beside the road)', () => {
  const kmLon = 1 / (111.32 * Math.cos((42 * Math.PI) / 180));
  const fixAt = (eastKm: number, northM: number, heading?: number, speed = 10) => ({
    coordinate: [42 + eastKm * kmLon, 42 + northM / 111_200] as LngLat,
    headingDeg: heading,
    speedMps: speed,
    accuracyM: 15,
    timestampMs: 0,
  });

  it('on the route: the car sits on the line, facing along it — not 20 m off among the buildings', () => {
    const t = outAndBack();
    const fix = fixAt(1, -20, 75); // 20 m south of the eastbound carriageway, GPS course a bit off
    const p = createProgressTracker(t)(fix.coordinate, 0, { headingDeg: 75, accuracyM: 15 });
    const shown = snapVehicle(t, fix, p, true, 40);
    expect(shown.coordinate[1]).toBeCloseTo(42, 6);
    expect(shown.coordinate[0]).toBeCloseTo(42 + 1 * kmLon, 4);
    expect(shown.headingDeg).toBeCloseTo(90, 0);
    expect(shown.speedMps).toBe(10);
  });

  it('possibly leaving the route, or farther than the snap distance: where the GPS puts it', () => {
    const t = outAndBack();
    const fix = fixAt(1, -20, 180);
    const p = createProgressTracker(t)(fix.coordinate, 0, { headingDeg: 180, accuracyM: 15 });
    expect(snapVehicle(t, fix, p, false, 40)).toBe(fix);
    expect(snapVehicle(t, fix, p, true, 15)).toBe(fix);
  });

  it('driving back along the route at speed keeps the car facing the way it goes', () => {
    const t = outAndBack();
    const fix = fixAt(1, -3, 270, 12);
    const shown = snapVehicle(t, fix, { distanceAlongM: 1000, distanceFromRouteM: 3 }, true, 40);
    expect(shown.headingDeg).toBe(270);
  });
});
