import { describe, expect, it } from 'vitest';
import { buildTimedRoute } from './routeTiming';
import { analyzeRouteConditions } from './routeConditions';
import { crosswindThresholdKmh } from './hazardThresholds';
import type { LngLat } from '../types/geo';
import type { Route } from '../types/route';
import type { RouteWeatherPoint } from '../types/weather';

function sampleRoute(): { route: Route; points: RouteWeatherPoint[] } {
  // 100 km heading due east (bearing 90°)
  const geometry: LngLat[] = [
    [44.0, 42.0],
    [44.3, 42.0],
    [44.6, 42.0],
    [44.9, 42.0],
    [45.2, 42.0],
  ];
  const route: Route = {
    id: 'r1',
    provider: 'test',
    origin: { id: 'o', name: 'A', label: 'A', coordinate: geometry[0] },
    destination: { id: 'd', name: 'B', label: 'B', coordinate: geometry[4] },
    geometry,
    distanceM: 100_000,
    durationS: 5400,
    legs: [{ distanceM: 100_000, durationS: 5400, summary: 'A-B', steps: [] }],
    segments: [],
    segmentSource: 'proportional',
    bbox: [44.0, 41.9, 45.2, 42.1],
    computedAt: 0,
  };
  const baseMs = Date.UTC(2026, 10, 24, 6, 0, 0);
  const elevs = [500, 1200, 2100, 1300, 600];
  const points: RouteWeatherPoint[] = geometry.map((coord, i) => ({
    id: `p-${i}`,
    longitude: coord[0],
    latitude: coord[1],
    distanceFromStartKm: i * 25,
    estimatedTravelMinutes: i * 22.5,
    arrivalMs: baseMs + i * 1350 * 1000,
    estimatedArrivalUtc: new Date(baseMs + i * 1350 * 1000).toISOString(),
    localTime: `1${i}:00`,
    timezone: 'Asia/Tbilisi',
    elevationM: elevs[i],
    placeName: i === 2 ? 'Jvari Pass' : `Point ${i}`,
    confidence: 'high',
    weather: {
      temperature: i === 2 ? -1 : 5,
      condition: i === 2 ? 'SNOW' : 'RAIN',
      description: i === 2 ? 'Snow' : 'Rain',
      precipitation: i === 2 ? 3 : 1,
      windSpeed: 30,
      windGusts: 52,
      // Wind from North (0°) while heading East (90°) => pure crosswind!
      windDirection: 0,
      isDay: true,
    },
  })) as RouteWeatherPoint[];
  return { route, points };
}

describe('analyzeRouteConditions', () => {
  it('detects mountain passes, crosswind for trucks vs cars, EV cold/climb penalty, and weather delay', () => {
    const { route, points } = sampleRoute();
    const timed = buildTimedRoute(route);

    const car = analyzeRouteConditions(timed, points, { vehicleKind: 'car', powertrain: 'fuel' });
    expect(car.mountainPasses).toHaveLength(1);
    expect(car.mountainPasses[0].elevationM).toBe(2100);
    expect(car.mountainPasses[0].freezingRisk).toBe(true);
    expect(car.maxCrosswindKmh).toBeGreaterThanOrEqual(50);
    // 52 km/h crosswind < 60 km/h car threshold, but >= 45 km/h truck threshold!
    expect(car.crosswindWarning).toBe(false);
    expect(car.evExtraConsumptionPct).toBeNull();
    expect(car.weatherDelayS).toBeGreaterThan(0);

    const truck = analyzeRouteConditions(timed, points, { vehicleKind: 'truck', powertrain: 'ev' });
    expect(truck.crosswindThresholdKmh).toBe(crosswindThresholdKmh('truck'));
    expect(truck.crosswindWarning).toBe(true);
    expect(truck.evExtraConsumptionPct).toBeGreaterThanOrEqual(15);
  });
});
