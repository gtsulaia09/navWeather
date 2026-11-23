/**
 * ADR-010 Hermes core execution entry.
 *
 * Imports our REAL shared TypeScript engines directly — with ZERO DOM, React, or browser APIs — and runs a complete
 * end-to-end Tbilisi → Batumi route + weather timeline + alerts + guidance + CarPlay/Watch CompanionSnapshot +
 * fflate gzip round-trip inside Hermes (or a bare ES2020 VM without browser globals).
 */
import { gzipSync } from 'fflate';
import { buildTimedRoute } from '../../src/algorithms/routeTiming';
import { sampleRoute } from '../../src/algorithms/routeSampling';
import { matchForecastToTime } from '../../src/algorithms/weatherMatching';
import { groupWeather, summarizeRouteWeather } from '../../src/algorithms/weatherGrouping';
import { buildRouteIntelligence } from '../../src/intelligence/routeIntelligence';
import { evaluateDriverAlerts, initialDriverAlertState } from '../../src/intelligence/driverAlerts';
import { buildManeuvers, computeGuidance } from '../../src/navigation/maneuvers';
import { instructionText } from '../../src/navigation/instructions';
import { buildCompanionSnapshot } from '../../src/platform/surfaces';
import { memoryStore, setStorage } from '../../src/platform/storage';
import { gunzip } from '../../src/utils/gzip';
import { en } from '../../src/i18n/en';
import { defaultUnits, formatDistance, formatDuration, formatTemp } from '../../src/i18n/format';
import type { Route } from '../../src/types/route';
import type { LocationForecast, RouteWeatherPoint } from '../../src/types/weather';

const BASE_MS = Date.UTC(2026, 8, 26, 4, 0); // 08:00 Tbilisi

/** Deterministic Tbilisi → Batumi sample route (~356 km, 5 h) for Hermes benchmarking. */
function sampleRouteFixture(): Route {
  const pts: [number, number][] = [];
  const N = 200;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    pts.push([44.8014 + (41.6367 - 44.8014) * t, 41.6936 + (41.6168 - 41.6936) * t + Math.sin(t * Math.PI) * 0.4]);
  }
  const distM = 356_000;
  const durS = 17_400;
  return {
    id: 'hermes-tbilisi-batumi',
    provider: 'local-roads',
    origin: { id: 'tbilisi', name: 'Tbilisi', label: 'Tbilisi, Georgia', coordinate: pts[0] },
    destination: { id: 'batumi', name: 'Batumi', label: 'Batumi, Georgia', coordinate: pts[pts.length - 1] },
    geometry: pts,
    distanceM: distM,
    durationS: durS,
    legs: [
      {
        distanceM: distM,
        durationS: durS,
        summary: 'S1',
        steps: [
          {
            distanceM: 120_000,
            durationS: 5_400,
            name: 'S1 Highway',
            ref: 'S1',
            maneuverType: 'depart',
            location: pts[0],
            fromIndex: 0,
            toIndex: 70,
          },
          {
            distanceM: 140_000,
            durationS: 6_800,
            name: 'Rikoti Pass',
            ref: 'S1',
            maneuverType: 'turn',
            maneuverModifier: 'slight right',
            location: pts[70],
            fromIndex: 70,
            toIndex: 140,
          },
          {
            distanceM: 96_000,
            durationS: 5_200,
            name: 'S2 Batumi Rd',
            ref: 'S2',
            maneuverType: 'arrive',
            location: pts[pts.length - 1],
            fromIndex: 140,
            toIndex: pts.length - 1,
          },
        ],
      },
    ],
    segments: [{ fromIndex: 0, toIndex: pts.length - 1, distanceM: distM, durationS: durS }],
    segmentSource: 'steps',
    bbox: [41.6, 41.6, 44.9, 42.2],
    computedAt: BASE_MS,
  };
}

function makeForecast(lon: number, lat: number): LocationForecast {
  const hours = 24;
  const times = Array.from({ length: hours }, (_, h) => BASE_MS + h * 3_600_000);
  const rainy = lon < 43.8 && lon > 42.5; // Khashuri / Rikoti Pass heavy rain band
  return {
    locationKey: `${lat.toFixed(2)},${lon.toFixed(2)}`,
    latitude: lat,
    longitude: lon,
    timezone: 'Asia/Tbilisi',
    fetchedAt: BASE_MS,
    provider: 'navweather-static',
    times,
    hourly: {
      temperature: times.map(() => (rainy ? 14 : 21)),
      apparentTemperature: times.map(() => (rainy ? 13 : 21)),
      precipitation: times.map(() => (rainy ? 8.5 : 0)),
      rain: times.map(() => (rainy ? 8.5 : 0)),
      snowfall: times.map(() => 0),
      precipitationProbability: times.map(() => (rainy ? 85 : 10)),
      condition: times.map(() => (rainy ? 'HEAVY_RAIN' : 'PARTLY_CLOUDY')),
      description: times.map(() => (rainy ? 'Heavy rain' : 'Partly cloudy')),
      windSpeed: times.map(() => (rainy ? 35 : 12)),
      windGusts: times.map(() => (rainy ? 58 : 18)),
      windDirection: times.map(() => 240),
      visibility: times.map(() => (rainy ? 1800 : 20_000)),
      cloudCover: times.map(() => (rainy ? 95 : 30)),
      humidity: times.map(() => (rainy ? 92 : 55)),
    },
  };
}

export async function runHermesCorePipeline() {
  // 1. Verify platform seams work with zero browser storage/DOM.
  setStorage({ device: memoryStore(), session: memoryStore() });

  // 2. Verify fflate gzip works inside Hermes (no DecompressionStream).
  const gzPayload = gzipSync(new Uint8Array([110, 97, 118, 87, 101, 97, 116, 104, 101, 114])); // "navWeather"
  const raw = await gunzip(gzPayload);
  const gunzipOk = raw.length === 10 && raw[0] === 110 && raw[9] === 114;

  // 3. Run full deterministic route + weather + intelligence + alerts + guidance + car/wrist snapshot pipeline.
  const route = sampleRouteFixture();
  const timed = buildTimedRoute(route);
  const samples = sampleRoute({ timed, places: [], elevation: null, maxIntervalMinutes: 45 });
  const forecasts = new Map(samples.map((s) => [s.id, makeForecast(s.coordinate[0], s.coordinate[1])]));
  const maneuvers = buildManeuvers(timed);
  const units = defaultUnits('en-GB');

  const runDerive = (progressM: number, nowMs: number) => {
    const modelTimeS = (progressM / timed.totalDistM) * timed.totalTimeS;
    const points: RouteWeatherPoint[] = samples.map((s) => {
      const f = forecasts.get(s.id)!;
      const arrivalMs = BASE_MS + s.travelTimeS * 1000;
      const dtMin = Math.round((arrivalMs - nowMs) / 60_000);
      return {
        id: s.id,
        latitude: s.coordinate[1],
        longitude: s.coordinate[0],
        distanceFromStartKm: Math.round((s.distanceM / 1000) * 10) / 10,
        estimatedTravelMinutes: dtMin,
        estimatedArrivalUtc: new Date(arrivalMs).toISOString(),
        arrivalMs,
        localTime: new Date(arrivalMs).toISOString().slice(11, 16),
        timezone: f.timezone,
        weather: matchForecastToTime(f, arrivalMs),
        forecastLeadHours: Math.max(0, (arrivalMs - BASE_MS) / 3_600_000),
        confidence: 'high',
        status: s.distanceM < progressM ? 'passed' : 'upcoming',
        reasons: s.reasons,
        placeName: s.placeName,
      };
    });
    const groups = groupWeather(points, en);
    const summary = summarizeRouteWeather(points, en, units.temperature);
    const intel = buildRouteIntelligence({
      timed,
      maneuvers,
      progressM,
      clock: { mode: 'navigating', nowMs, modelTimeS },
      weatherPoints: points,
      currentPoint: points.find((p) => p.status === 'upcoming') ?? points[0] ?? null,
      weatherPrefs: { level: 'all', types: { rain: true, snow: true, fog: true, wind: true, temperature: true } },
      speedLimits: null,
      fuelRangeKm: null,
      m: en,
      units,
    });
    const alerts = evaluateDriverAlerts(intel.events, initialDriverAlertState, {
      nowMs,
      prefs: { output: 'both', timing: 'auto' },
      m: en,
    });
    const guidance = computeGuidance(maneuvers, timed, progressM);
    const maneuverText = guidance.next ? instructionText(guidance.next, en) : '';
    const snapshot = buildCompanionSnapshot({
      active: true,
      destinationName: route.destination.name,
      progress: {
        distanceAlongM: progressM,
        modelTimeS,
        distanceFromRouteM: 2,
        segmentIndex: 0,
        remainingDistanceM: timed.totalDistM - progressM,
        remainingTimeS: timed.totalTimeS * (1 - progressM / timed.totalDistM),
        nowMs,
        etaMs: BASE_MS + timed.totalTimeS * 1000,
      },
      guidance,
      instructionText: maneuverText,
      alert: alerts.visual
        ? { id: alerts.visual.id, headline: alerts.visual.title, severity: 'high', inSeconds: 1200 }
        : null,
      nowMs,
    });
    return { points, groups, summary, intel, alerts, guidance, snapshot };
  };

  // Warmup + benchmark 50 derive iterations (ADR-010 criterion #2: <= 20 ms per derive).
  const first = runDerive(60_000, BASE_MS + 2_700_000);
  const times: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = Date.now();
    runDerive(60_000 + i * 1500, BASE_MS + 2_700_000 + i * 60_000);
    times.push(Date.now() - t0);
  }
  times.sort((a, b) => a - b);

  return {
    gunzipOk,
    routeLabel: `${route.origin.name} → ${route.destination.name}`,
    distance: formatDistance(timed.totalDistM, units.distance, en),
    duration: formatDuration(timed.totalTimeS, en),
    sampleCount: first.points.length,
    groupCount: first.groups.length,
    eventCount: first.intel.events.length,
    headline: first.summary.headline,
    firstPointTemp: first.points[0]?.weather ? formatTemp(first.points[0].weather.temperature, units.temperature) : null,
    nextManeuver: first.snapshot.nextManeuver?.instruction ?? null,
    alertHeadline: first.alerts.visual?.title ?? null,
    deriveMs: {
      iterations: times.length,
      medianMs: times[Math.floor(times.length / 2)],
      p95Ms: times[Math.floor(times.length * 0.95)],
      maxMs: times[times.length - 1],
    },
  };
}
