import { describe, expect, it } from 'vitest';
import { tbilisiBatumiRoute } from '../test/helpers';
import type { LngLat } from '../types/geo';
import { cumulativeDistances, projectOntoLine } from './distance';
import { createProximityIndex, proximityIndexFor } from './proximity';

const route = tbilisiBatumiRoute();
const line = route.geometry;
const cum = cumulativeDistances(line);

/** Deterministic pseudo-random points around the route (no flaky seeds). */
function pointsAround(n: number, spreadDeg: number): LngLat[] {
  let s = 42;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  return Array.from({ length: n }, () => {
    const v = line[Math.floor(rnd() * line.length)];
    return [v[0] + (rnd() - 0.5) * spreadDeg, v[1] + (rnd() - 0.5) * spreadDeg] as LngLat;
  });
}

describe('createProximityIndex', () => {
  it('agrees with a full scan of the line for every point and radius', () => {
    const index = createProximityIndex(line, 150);
    for (const p of pointsAround(400, 0.006)) {
      const exact = projectOntoLine(line, cum, p).distanceFromLineM;
      for (const r of [30, 60, 120, 150]) {
        // Off by float rounding only exactly on the boundary.
        if (Math.abs(exact - r) < 1e-6) continue;
        expect(index.within(p, r), `${p} at ${r} m (exact ${exact.toFixed(1)} m)`).toBe(exact <= r);
      }
    }
  });

  it('finds the line from far away only when it is that close', () => {
    const index = createProximityIndex(line, 120);
    expect(index.within(line[10], 120)).toBe(true);
    expect(index.within([line[10][0] + 0.5, line[10][1] + 0.5], 120)).toBe(false);
  });

  it('handles a single point and an empty line', () => {
    expect(createProximityIndex([], 100).within([44.8, 41.7], 100)).toBe(false);
    expect(createProximityIndex([[44.8, 41.7]], 100).within([44.8, 41.7], 100)).toBe(false);
  });

  it('refuses a radius wider than its cells (the answer would not be exact)', () => {
    expect(() => createProximityIndex(line, 100).within(line[0], 200)).toThrow(RangeError);
  });

  it('is built once per line and cell size', () => {
    expect(proximityIndexFor(line, 120)).toBe(proximityIndexFor(line, 120));
    expect(proximityIndexFor(line, 120)).not.toBe(proximityIndexFor(line, 200));
  });
});
