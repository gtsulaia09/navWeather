import { config } from '../../config';
import { positionAtDistance, timeAtDistance } from '../../algorithms/routeTiming';
import type { LocationForecast } from '../../types/weather';
import type { TimedRoute, RouteSample, PlaceAlongRoute } from '../../types/route';
import { encodePolyline } from '../../utils/polyline';
import { resampleRoute, type RouteProfile } from '../../trip/route/profile';
import { hazardCode } from '../../trip/weather/hazards';
import type {
  StopPlaces,
  StopPlacesRequest,
  TripPlan,
  TripPlanRequest,
  TripPreferences,
  TripProgressState,
  TripStop,
  TripWeatherSample,
  VehicleProfile,
} from '../../trip/types';
import { ProviderError } from '../http';
import { PlacesTiles } from '../places/tiles';
import { createTripPlan, findStopPlaces, TripPlanError } from '../../trip/planning/planner';
import { sanitizeStopPlacesRequest, sanitizeTripRequest } from '../../trip/protocol';
import { TileTripPlaces } from './tilePlaces';
import type { BordersResponse } from '../../trip/borders';
import { countriesAlong, decodeCountries, type CountriesFile, type CountryIndex } from '../../trip/countries';

/**
 * The long-trip planner on the device (ADR-013, ADR-019): turn the app's route, forecasts and settlements into a
 * TripPlanRequest and plan it here — the route never leaves the device.
 */

/** The client's own timed route as a planner profile (exact, no resampling). */
export function profileFromTimed(timed: TimedRoute): RouteProfile {
  return {
    points: timed.route.geometry,
    alongM: Array.from(timed.cumDistM),
    timeS: Array.from(timed.cumTimeS),
    totalDistM: timed.totalDistM,
    totalTimeS: timed.totalTimeS,
  };
}

/** Most hours of hazard codes per sample the planner accepts (`src/trip/protocol.ts`). */
const MAX_WEATHER_HOURS = 400;

/**
 * Hourly hazard codes for each sample, from forecasts already loaded: from the hour before departure as far as the
 * forecasts reach (they were loaded for the whole trip, stops included) — never a fixed 4 days (B-21).
 */
export function weatherSamples(
  samples: RouteSample[],
  forecastFor: (s: RouteSample) => LocationForecast | undefined,
  departAtMs: number,
  hours = MAX_WEATHER_HOURS,
): TripWeatherSample[] {
  const t0 = Math.floor(departAtMs / 3_600_000) * 3_600_000 - 3_600_000;
  const out: TripWeatherSample[] = [];
  for (const s of samples.slice(0, 200)) {
    const f = forecastFor(s);
    if (!f) continue;
    const h: number[] = [];
    for (let k = 0; k < hours; k++) {
      const i = f.times.indexOf(t0 + k * 3_600_000);
      if (i < 0) {
        h.push(-1);
        continue;
      }
      // Precipitation describes the hour BEFORE its timestamp: take the next hour's value for this hour.
      const next = i + 1 < f.times.length ? i + 1 : i;
      h.push(
        hazardCode({
          condition: f.hourly.condition[i],
          precipitation: f.hourly.precipitation[next],
          temperature: f.hourly.temperature[i],
          windGusts: f.hourly.windGusts[i],
          visibility: f.hourly.visibility[i],
        }),
      );
    }
    while (h.length && h[h.length - 1] === -1) h.pop();
    if (h.length) out.push({ alongM: Math.round(s.distanceM), tz: f.timezone, t0, h });
  }
  return out;
}

export interface TripRequestInput {
  timed: TimedRoute;
  samples: RouteSample[];
  places: PlaceAlongRoute[];
  forecastFor: (s: RouteSample) => LocationForecast | undefined;
  departAtMs: number;
  vehicle: VehicleProfile;
  preferences: TripPreferences;
  locale: string;
  fallbackTz: string;
  progress?: TripProgressState;
  overnightsM?: number[];
}

export function buildTripRequest(input: TripRequestInput): TripPlanRequest {
  const { timed } = input;
  const route = timed.route;
  const resampled = resampleRoute(
    timed.totalDistM,
    (d) => positionAtDistance(timed, d).coordinate,
    (d) => timeAtDistance(timed, d),
  );
  const weather = weatherSamples(input.samples, input.forecastFor, input.progress?.nowMs ?? input.departAtMs);
  const [olon, olat] = route.origin.coordinate;
  const [dlon, dlat] = route.destination.coordinate;
  return {
    version: 1,
    route: {
      id: route.id,
      polyline: resampled.polyline,
      stepM: resampled.stepM,
      timesS: resampled.timesS,
      distanceM: Math.round(timed.totalDistM),
      origin: { name: route.origin.name, lat: olat, lon: olon },
      destination: { name: route.destination.name, lat: dlat, lon: dlon },
      tz: weather[0]?.tz ?? input.fallbackTz,
    },
    departAtMs: input.departAtMs,
    vehicle: input.vehicle,
    preferences: input.preferences,
    places: [...input.places]
      .sort((a, b) => (a.kind === b.kind ? (b.population ?? 0) - (a.population ?? 0) : a.kind === 'city' ? -1 : b.kind === 'city' ? 1 : a.kind === 'town' ? -1 : 1))
      .slice(0, 200)
      .map((p) => ({ name: p.name, kind: p.kind, alongM: Math.round(p.distanceAlongM), lat: p.coordinate[1], lon: p.coordinate[0], ...(p.population ? { population: p.population } : {}) })),
    weather,
    ...(input.progress ? { progress: input.progress } : {}),
    ...(input.overnightsM?.length ? { overnightsM: input.overnightsM } : {}),
    locale: input.locale,
  };
}

/**
 * The long-trip plan, worked out on the device (ADR-019; was `POST /api/v1/trips/plan`): the same planner module,
 * the same validation — no server, no request limit, and the route never leaves the device.
 */
export async function fetchTripPlan(req: TripPlanRequest, signal?: AbortSignal): Promise<TripPlan> {
  const now = Date.now();
  const clean = sanitizeTripRequest(JSON.parse(JSON.stringify(req)), now);
  if (!clean) throw new ProviderError('This trip cannot be planned', 'invalid-response', 'Trip planner');
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  try {
    return await backend.plan(clean, now);
  } catch (e) {
    if (e instanceof TripPlanError) throw new ProviderError('This trip cannot be planned', 'invalid-response', 'Trip planner');
    throw e;
  }
}

let stopPlaceTiles: TileTripPlaces | null = null;

/** Where plans and stop places come from: the planner on this device (tests swap it). */
export interface TripBackend {
  plan(req: TripPlanRequest, nowMs: number): Promise<TripPlan>;
  places(req: StopPlacesRequest, signal?: AbortSignal): Promise<StopPlaces[]>;
}
const deviceBackend: TripBackend = {
  plan: (req, nowMs) => createTripPlan(req, { places: null, nowMs }),
  places: (req, signal) => {
    stopPlaceTiles ??= new TileTripPlaces(new PlacesTiles(config.endpoints.placesTiles), null);
    return findStopPlaces(req, stopPlaceTiles, signal);
  },
};
let backend: TripBackend = deviceBackend;
/** Tests: another planner; null puts the device's back. */
export function setTripBackend(b: TripBackend | null): void {
  backend = b ?? deviceBackend;
}

/**
 * Places around one stop (hotels, food, fuel, rest) from our places tiles on the device (ADR-019; was
 * `POST /api/v1/trips/places` with Overpass): the stop and the road ±30 km around it, no server.
 */
export async function fetchStopPlaces(
  stop: TripStop,
  timed: TimedRoute,
  vehicle: VehicleProfile,
  preferences: TripPreferences,
  locale: string,
  signal?: AbortSignal,
): Promise<StopPlaces[]> {
  const pts = [];
  for (let d = Math.max(0, stop.alongM - 30_000); d <= Math.min(timed.totalDistM, stop.alongM + 30_000); d += 500) pts.push(positionAtDistance(timed, d).coordinate);
  const raw: StopPlacesRequest = {
    version: 1,
    stop: { lat: stop.lat, lon: stop.lon, kinds: stop.kinds, arriveMs: stop.arriveMs, tz: stop.tz },
    route: encodePolyline(pts, 5),
    vehicle,
    preferences,
    locale,
  };
  const req = sanitizeStopPlacesRequest(JSON.parse(JSON.stringify(raw)), Date.now());
  if (!req) throw new ProviderError('Places around this stop are not available', 'invalid-response', 'Trip planner');
  return backend.places(req, signal);
}

/** Countries along the route and where they change (a few dozen points, never the user's position). */
let countryIndex: Promise<CountryIndex> | null = null;

/**
 * Countries along the route and where they change, worked out on the device from Natural Earth boundaries
 * (DP-4.5): no request leaves the device and it works offline. The data (≈0.2 MB gzip) loads on first use.
 */
export async function findBorders(timed: TimedRoute, locale: string): Promise<BordersResponse> {
  countryIndex ??= import('../../trip/data/countries-v1.json').then((m) => decodeCountries((m.default ?? m) as CountriesFile));
  const index = await countryIndex.catch((e) => {
    countryIndex = null; // a failed chunk load may succeed later
    throw e;
  });
  const { countries, crossings } = countriesAlong(index, (d) => positionAtDistance(timed, d).coordinate, timed.totalDistM, locale);
  return { countries, crossings };
}
