import { setApiOrigin } from './api/v1';
import { DEFAULT_RELAYS as DEFAULT_RELAY_LIST } from './p2p/relays';

/**
 * Single source of configuration. Every tunable reads from Vite env vars
 * (see .env.example) with a sensible default, so the app runs with no .env.
 */

type Env = Record<string, string | boolean | undefined>;

const env: Env = (import.meta as unknown as { env?: Env }).env ?? {};

function str(key: string, fallback: string): string {
  const v = env[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}

function num(key: string, fallback: number): number {
  const v = env[key];
  if (typeof v !== 'string' || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const DEFAULT_RELAYS = DEFAULT_RELAY_LIST.join(',');

/** Our API: '' = this page's origin (the Worker serves both); an absolute origin otherwise (DP-2.3). */
const apiOriginValue = str('VITE_API_ORIGIN', '').replace(/\/+$/, '');
setApiOrigin(apiOriginValue);
const api = (path: string) => `${apiOriginValue}/api/v1${path}`;

export const config = {
  providers: {
    /**
     * Everything per user runs on the device over our static files (ADR-019): no routing, weather, search or
     * elevation server, and no public server with limits. Outside the regions we build, the app says
     * "not available here yet".
     */
    routing: str('VITE_ROUTING_PROVIDER', 'local'),
    weather: str('VITE_WEATHER_PROVIDER', 'static'),
    geocoding: str('VITE_GEOCODING_PROVIDER', 'static'),
    autocomplete: str('VITE_AUTOCOMPLETE_PROVIDER', 'static'),
    /** Settlements, places and road data: our tiles (DP-6.5). */
    places: str('VITE_PLACES_PROVIDER', 'tiles'),
    elevation: str('VITE_ELEVATION_PROVIDER', 'static'),
    /** Our own basemap files (ADR-020); 'openfreemap' uses OpenFreeMap's styles directly. */
    map: str('VITE_MAP_PROVIDER', 'packs'),
    poi: str('VITE_POI_PROVIDER', 'tiles'),
    speedLimits: str('VITE_SPEED_LIMIT_PROVIDER', 'tiles'),
    traffic: str('VITE_TRAFFIC_PROVIDER', 'none'),
    incidents: str('VITE_INCIDENT_PROVIDER', 'reports'),
    airQuality: str('VITE_AIR_QUALITY_PROVIDER', 'static'),
    speech: str('VITE_SPEECH_PROVIDER', 'browser'),
  },
  endpoints: {
    /** Our static data (roads, search, weather, air, heights, places): free static files on the app's origin. */
    data: str('VITE_DATA_URL', '/data'),
    /** Driver reports relay (the Worker in worker/, Free plan): writes, and reads where no feed is reachable. */
    reports: str('VITE_REPORTS_URL', api('/reports')),
    /**
     * Static driver-reports feed (ADR-020): files rebuilt every ~10 minutes. Production: the `navweather-reports`
     * Worker's origin (set by the deploy workflow); localhost: `npm run data:reports` writes public/data/reports.
     * Missing or stale → the app reads the Worker list instead.
     */
    reportsFeed: str('VITE_REPORTS_FEED_URL', '/data/reports'),
    /**
     * Nostr relays for overflow (ADR-020): live-sharing handshakes and driver reports when the Worker is busy.
     * Public relays in production; "/nostr" = the local relay behind the dev server (scripts/nostr-relay.mjs).
     */
    nostrRelays: str('VITE_NOSTR_RELAYS', DEFAULT_RELAYS),
    /** Our places tiles (static assets built by `npm run data:osm`). */
    placesTiles: str('VITE_PLACES_TILES_URL', '/data/places/v1'),
    /**
     * Our basemap (ADR-020): production — the `navweather-basemap` Worker's origin (set by the deploy workflow);
     * localhost — `npm run data:basemap` writes public/data/basemap. Missing → the OpenFreeMap styles below.
     */
    basemap: str('VITE_BASEMAP_URL', '/data/basemap'),
    /** Fallback basemap styles while none of ours is deployed. */
    mapStyleLight: str('VITE_MAP_STYLE_LIGHT', 'https://tiles.openfreemap.org/styles/positron'),
    mapStyleDark: str('VITE_MAP_STYLE_DARK', 'https://tiles.openfreemap.org/styles/dark'),
  },
  geocoding: {
    language: str('VITE_GEOCODING_LANGUAGE', 'en'),
    autocompleteDebounceMs: num('VITE_AUTOCOMPLETE_DEBOUNCE_MS', 300),
  },
  weather: {
    cacheTtlMinutes: num('VITE_WEATHER_CACHE_TTL_MINUTES', 20),
    refreshMinutes: num('VITE_WEATHER_REFRESH_MINUTES', 20),
    /** Grid size for the spatial cache key. 0.02° ≈ 2.2 km — fine enough for mountains/coasts. */
    spatialResolutionDeg: num('VITE_WEATHER_SPATIAL_RESOLUTION_DEG', 0.02),
    batchSize: num('VITE_WEATHER_BATCH_SIZE', 50),
    maxCacheEntries: num('VITE_WEATHER_MAX_CACHE_ENTRIES', 500),
    requestTimeoutMs: num('VITE_WEATHER_TIMEOUT_MS', 15000),
    /** Hours of forecast always requested (rounded up to cover the whole trip). */
    minForecastHours: num('VITE_WEATHER_MIN_FORECAST_HOURS', 48),
    /** How often to check whether a newer forecast build exists (a small static index file). */
    updateCheckMinutes: num('VITE_WEATHER_UPDATE_CHECK_MINUTES', 10),
  },
  routing: {
    /** Roads offered to choose from (the best one included), each with its own forecast. */
    maxRoutes: Math.max(1, Math.min(4, Math.round(num('VITE_ROUTE_OPTIONS_MAX', 3)))),
  },
  sampling: {
    maxIntervalMinutes: num('VITE_SAMPLE_MAX_INTERVAL_MINUTES', 45),
    /** Extra points added between samples whose weather differs a lot. */
    maxRefinementPoints: num('VITE_SAMPLE_MAX_REFINEMENT_POINTS', 10),
  },
  navigation: {
    offRouteMinThresholdM: num('VITE_OFF_ROUTE_MIN_THRESHOLD_M', 30),
    offRouteMaxThresholdM: num('VITE_OFF_ROUTE_MAX_THRESHOLD_M', 100),
    offRoutePersistSeconds: num('VITE_OFF_ROUTE_PERSIST_SECONDS', 8),
    offRoutePersistReadings: num('VITE_OFF_ROUTE_PERSIST_READINGS', 3),
    /** GPS fixes worse than this are ignored for deviation decisions. */
    maxUsableAccuracyM: num('VITE_MAX_USABLE_GPS_ACCURACY_M', 100),
    minRecalculationIntervalS: num('VITE_MIN_RECALC_INTERVAL_S', 20),
    /** Starting navigation farther than this from the route asks the user first. */
    farFromRouteM: num('VITE_FAR_FROM_ROUTE_M', 3000),
  },
  simulation: {
    /** 1–10× are real-ish playback; 60×/300× let a long drive be demoed in minutes. */
    speeds: [1, 2, 5, 10, 60, 300] as number[],
    defaultSpeed: num('VITE_SIMULATION_DEFAULT_SPEED', 60),
  },
} as const;

export type AppConfig = typeof config;
