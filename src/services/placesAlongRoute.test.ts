import { describe, expect, it } from 'vitest';
import { buildTimedRoute } from '../algorithms/routeTiming';
import type { LngLat } from '../types/geo';
import type { Route } from '../types/route';
import type { Poi, PoiProvider } from './places/PoiProvider';
import type { RoutingProvider } from './routing/RoutingProvider';
import { searchAlongRoute } from './placesAlongRoute';

function makeStraightRoute(km: number): Route {
  // ~1 degree longitude at lat 41.7 is ~83 km
  const steps = Math.max(10, Math.round(km / 5));
  const degSpan = km / 83;
  const geometry: LngLat[] = [];
  for (let i = 0; i <= steps; i++) {
    geometry.push([41.6 + (degSpan * i) / steps, 41.7]);
  }
  const distM = km * 1000;
  return {
    id: 'test-route',
    provider: 'test',
    origin: { id: 'o', name: 'Start', label: 'Start', coordinate: geometry[0] },
    destination: { id: 'd', name: 'End', label: 'End', coordinate: geometry[geometry.length - 1] },
    geometry,
    distanceM: distM,
    durationS: Math.round(distM / 20),
    legs: [{ distanceM: distM, durationS: Math.round(distM / 20), summary: 'Test', steps: [] }],
    segments: [],
    segmentSource: 'proportional',
    bbox: [geometry[0][0], 41.69, geometry[geometry.length - 1][0], 41.71],
    computedAt: 0,
  };
}

const dummyRouting: RoutingProvider = {
  name: 'dummy',
  capabilities: { alternatives: false, avoid: [], laneGuidance: false, matrix: false, multiStop: false },
  calculateRoutes: async () => [],
};

describe('searchAlongRoute', () => {
  it('spreads recommendations evenly across the entire A-to-B route instead of clustering near the start', async () => {
    const route = makeStraightRoute(320);
    const timed = buildTimedRoute(route);

    // 20 dense restaurants in the first 10 km + 1 restaurant every 40 km across the rest of the 320 km route
    const pois: Poi[] = [];
    for (let i = 0; i < 20; i++) {
      pois.push({
        id: `start-${i}`,
        category: 'restaurant',
        name: `Start Cafe ${i}`,
        coordinate: [41.6 + (i * 0.5) / 83, 41.7002],
        source: 'osm',
      });
    }
    for (let km = 40; km <= 310; km += 45) {
      pois.push({
        id: `mid-${km}`,
        category: 'restaurant',
        name: `Roadside ${km} km`,
        coordinate: [41.6 + km / 83, 41.7003],
        source: 'osm',
      });
    }

    const places: PoiProvider = {
      name: 'fake',
      search: async () => pois,
    };

    const results = await searchAlongRoute({
      places,
      routing: dummyRouting,
      timed,
      category: 'restaurant',
      fromM: 0,
      aheadM: timed.totalDistM,
      maxResults: 12,
      spreadAlongRoute: true,
    });

    expect(results).toHaveLength(12);
    // Must include restaurants from the middle and end of the route, not just the first 10 km!
    expect(results.some((r) => r.aheadM > 100_000)).toBe(true);
    expect(results.some((r) => r.aheadM > 220_000)).toBe(true);
    // Returned sorted in driving order from A to B
    for (let i = 1; i < results.length; i++) {
      expect(results[i].aheadM).toBeGreaterThanOrEqual(results[i - 1].aheadM);
    }
  });
});
