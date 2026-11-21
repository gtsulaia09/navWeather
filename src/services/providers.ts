import { config, type AppConfig } from '../config';
import { createRoadClient } from '../roads/client';
import type { ElevationProvider } from './elevation/ElevationProvider';
import { StaticElevationProvider } from './elevation/StaticElevationProvider';
import type { AutocompleteProvider, GeocodingProvider } from './geocoding/GeocodingProvider';
import { StaticGeocodingProvider } from './geocoding/StaticGeocodingProvider';
import { TileReverseGeocoder } from './geocoding/TileReverseGeocoder';
import { StyleUrlMapProvider, type MapProvider } from './map/MapProvider';
import type { PlacesProvider } from './places/PlacesProvider';
import type { PoiProvider } from './places/PoiProvider';
import { PlacesTiles } from './places/tiles';
import { TilePlacesProvider, TilePoiProvider, TileSpeedLimitProvider } from './places/TileProviders';
import type { SpeedLimitProvider } from './speed/SpeedLimitProvider';
import {
  BrowserSpeechRecognition,
  BrowserSpeechSynthesis,
  type SpeechRecognitionProvider,
  type TextToSpeechProvider,
} from '../voice/providers';
import type { Locale } from '../i18n';
import { useSettings } from '../state/settings';
import type { TravelMode } from '../types/travel';
import { FlightEstimateProvider } from './routing/FlightEstimateProvider';
import { LocalRoutingProvider } from './routing/LocalRoutingProvider';
import type { RoutingProvider } from './routing/RoutingProvider';
import { StaticAirQualityProvider, type AirQualityProvider } from './air/AirQualityProvider';
import { NoIncidentProvider, type IncidentProvider } from './traffic/IncidentProvider';
import { ReportsIncidentProvider } from './traffic/ReportsIncidentProvider';
import { parseRelayList } from '../p2p/nostr';
import { NoTrafficProvider, type TrafficProvider } from './traffic/TrafficProvider';
import { StaticWeatherProvider } from './weather/StaticWeatherProvider';
import type { WeatherProvider } from './weather/WeatherProvider';
import { WeatherService } from './weather/WeatherService';

export interface Providers {
  /** The car router. Other modes: `routingByMode` (see `providersForMode`). */
  routing: RoutingProvider;
  /** Routers for the other ways to travel. A mode without one (public transport) is not available. */
  routingByMode?: Partial<Record<Exclude<TravelMode, 'drive'>, RoutingProvider>>;
  geocoding: GeocodingProvider;
  autocomplete: AutocompleteProvider;
  /** Lightweight reverse geocoder for naming route points. */
  reverseGeocoding: GeocodingProvider;
  places: PlacesProvider | null;
  /** Places along the route (fuel, food, hotels…). */
  poi: PoiProvider | null;
  speedLimits: SpeedLimitProvider | null;
  elevation: ElevationProvider | null;
  traffic: TrafficProvider;
  incidents: IncidentProvider;
  /** Air quality (AQI) — optional. */
  air: AirQualityProvider | null;
  map: MapProvider;
  weather: WeatherService;
  tts: TextToSpeechProvider;
  speechRecognition: SpeechRecognitionProvider;
}

function unknown(kind: string, name: string): never {
  throw new Error(`Unknown ${kind} provider "${name}". Check your VITE_* environment variables.`);
}

/**
 * Build providers from configuration. The only place provider classes are named.
 *
 * Everything per user runs on the device over our static files (ADR-019): routing, search, forecasts, air quality,
 * heights, places. Only driver reports (and live sharing, elsewhere) use the Worker, on the Free plan.
 */
export function createProviders(cfg: AppConfig = config): Providers {
  const { providers: p, endpoints: e } = cfg;
  const lang = cfg.geocoding.language;

  if (p.routing !== 'local') unknown('routing', p.routing);
  const roads = createRoadClient(e.data);
  const alternates = Math.min(2, cfg.routing.maxRoutes - 1);
  const routing: RoutingProvider = new LocalRoutingProvider(roads, 'drive', alternates);
  const routingByMode: NonNullable<Providers['routingByMode']> = {
    walk: new LocalRoutingProvider(roads, 'walk', alternates),
    bike: new LocalRoutingProvider(roads, 'bike', alternates),
    flight: new FlightEstimateProvider(),
    // Public transport: no free, unlimited timetable router yet (ADR-019) — the mode is not offered.
  };

  const tiles = new PlacesTiles(e.placesTiles);
  const reverser = new TileReverseGeocoder(tiles, lang);
  if (p.geocoding !== 'static') unknown('geocoding', p.geocoding);
  if (p.autocomplete !== 'static') unknown('autocomplete', p.autocomplete);
  const search = new StaticGeocodingProvider(e.data, lang, reverser);

  const elevationSource = new StaticElevationProvider(e.data);
  const elevation: ElevationProvider | null = p.elevation === 'static' ? elevationSource : p.elevation === 'none' ? null : unknown('elevation', p.elevation);

  if (p.weather !== 'static') unknown('weather', p.weather);
  const weatherProvider: WeatherProvider = new StaticWeatherProvider(e.data, (pts, signal) => elevationSource.heights(pts, signal));

  const places: PlacesProvider | null = p.places === 'tiles' ? new TilePlacesProvider(tiles, lang, null) : p.places === 'none' ? null : unknown('places', p.places);

  const map: MapProvider =
    p.map === 'openfreemap' || p.map === 'style-url'
      ? new StyleUrlMapProvider(p.map, e.mapStyleLight, e.mapStyleDark)
      : unknown('map', p.map);

  const poi: PoiProvider | null = p.poi === 'tiles' ? new TilePoiProvider(tiles, lang, null) : p.poi === 'none' ? null : unknown('poi', p.poi);
  const speedLimits: SpeedLimitProvider | null =
    p.speedLimits === 'tiles' ? new TileSpeedLimitProvider(tiles, null) : p.speedLimits === 'none' ? null : unknown('speed limit', p.speedLimits);
  // No free live-traffic source exists; the interface is ready for one.
  const traffic: TrafficProvider = p.traffic === 'none' ? new NoTrafficProvider() : unknown('traffic', p.traffic);
  // Driver reports go through the app's own relay (worker/reports.ts); official feeds can plug in here.
  const incidents: IncidentProvider =
    p.incidents === 'reports'
      ? new ReportsIncidentProvider(e.reports, { feedUrl: e.reportsFeed, relays: parseRelayList(e.nostrRelays) })
      : p.incidents === 'none'
        ? new NoIncidentProvider()
        : unknown('incident', p.incidents);
  const air: AirQualityProvider | null =
    p.airQuality === 'static' ? new StaticAirQualityProvider(e.data) : p.airQuality === 'none' ? null : unknown('air quality', p.airQuality);
  if (p.speech !== 'browser') unknown('speech', p.speech);

  return {
    routing,
    routingByMode,
    geocoding: search,
    autocomplete: search,
    reverseGeocoding: reverser,
    places,
    poi,
    speedLimits,
    elevation,
    traffic,
    incidents,
    air,
    map,
    weather: new WeatherService(weatherProvider, {
      ttlMs: cfg.weather.cacheTtlMinutes * 60000,
      batchSize: cfg.weather.batchSize,
      resolutionDeg: cfg.weather.spatialResolutionDeg,
      maxEntries: cfg.weather.maxCacheEntries,
      minForecastHours: cfg.weather.minForecastHours,
      updateCheckMs: cfg.weather.updateCheckMinutes * 60000,
    }),
    tts: googleVoice(),
    speechRecognition: new BrowserSpeechRecognition(),
  };
}

/** Google voices; the one picked in Settings (per language) when there is one. */
function googleVoice(): BrowserSpeechSynthesis {
  const tts = new BrowserSpeechSynthesis();
  tts.preferredVoice = (lang) => {
    const choice = useSettings.getState().voiceByLang[lang.slice(0, 2).toLowerCase() as Locale];
    return choice?.startsWith('device:') ? choice.slice(7) : null;
  };
  return tts;
}

let singleton: Providers | null = null;

/** App-wide providers (lazily created; tests can inject via setProviders). */
export function getProviders(): Providers {
  if (!singleton) singleton = createProviders();
  return singleton;
}

/**
 * The providers to plan and navigate a trip made `mode`: the same as the
 * app's, with that mode's router. A flight has no places or road data along
 * it; a bus ride no speed limits or stops for fuel. null when the mode has no
 * router (public transport switched off).
 */
export function providersForMode(base: Providers, mode: TravelMode): Providers | null {
  if (mode === 'drive') return base;
  const routing = base.routingByMode?.[mode];
  if (!routing) return null;
  if (mode === 'flight') return { ...base, routing, places: null, elevation: null, poi: null, speedLimits: null };
  if (mode === 'transit') return { ...base, routing, poi: null, speedLimits: null };
  return { ...base, routing };
}

export function setProviders(p: Providers | null): void {
  singleton = p;
}
