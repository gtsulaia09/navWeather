import {
  gridCell,
  HOURLY_UNITS,
  hoursFor,
  LATEST_KEY,
  MAX_RUN_AGE_H,
  parseForecastQuery,
  planHours,
  pointForecast,
  recordValues,
  tileKey,
  type WeatherIndex,
} from '../../api/weather';
import type { LocationForecast } from '../../types/weather';
import { timeZoneOffsetMinutes } from '../../utils/timezone';
import { dataUrl, fetchBytes, fetchIndex, LoadCache } from '../data/staticFiles';
import { ProviderError } from '../http';
import { forecastParams, normalize, type OpenMeteoLocation } from './OpenMeteoProvider';
import type { ForecastLocation, ForecastRequest, WeatherProvider } from './WeatherProvider';

/** Heights (m) of points, when known — the forecast is then for the point's own height, not its 25 km cell's. */
export type HeightLookup = (points: { lat: number; lon: number }[], signal?: AbortSignal) => Promise<(number | null)[]>;

const PROVIDER = 'Weather service';
const INDEX_TTL_MS = 10 * 60_000;
let tzLookup: Promise<(lat: number, lon: number) => string> | null = null;
function zoneLookup() {
  tzLookup ??= import('@photostructure/tz-lookup').then((m) => (m.default ?? m) as unknown as (lat: number, lon: number) => string);
  return tzLookup;
}

/**
 * Our forecast, worked out on the device (ADR-019; DP-4.6, DP-6.6): the weather pipeline publishes open model data
 * (ECMWF IFS, NOAA GFS) for the whole world as static 2° tile files; this reads the tiles a request needs and answers exactly as the old
 * forecast endpoint did (Open-Meteo-shaped, read by the same normaliser). No weather server, no request limit, and no
 * coordinates leave the device — only requests for whole tiles.
 *
 * Where we have no data (not built here, too old, far out at sea) the answer is an empty series: "not available",
 * never a borrowed or invented forecast.
 */
export class StaticWeatherProvider implements WeatherProvider {
  readonly name = 'navweather';
  readonly maxLocationsPerRequest = 100;
  private indexAt = 0;
  private indexP: Promise<WeatherIndex | null> | null = null;
  private readonly tiles = new LoadCache<Int16Array | null>(96);
  private readonly base: string;
  private readonly heights: HeightLookup | null;

  constructor(base: string, heights: HeightLookup | null = null) {
    this.base = base;
    this.heights = heights;
  }

  private index(signal?: AbortSignal): Promise<WeatherIndex | null> {
    if (!this.indexP || Date.now() - this.indexAt > INDEX_TTL_MS) {
      this.indexAt = Date.now();
      const p = fetchIndex<WeatherIndex>(dataUrl(this.base, LATEST_KEY), PROVIDER, signal).then((i) => {
        if (i && i.run !== this.lastRun) {
          this.tiles.clear(); // a new run: older tiles are of no more use
          this.lastRun = i.run;
        }
        return i;
      });
      this.indexP = p.catch((e) => {
        if (this.indexP === p) this.indexP = null;
        throw e;
      });
    }
    return this.indexP;
  }
  private lastRun = '';

  private static fresh(i: WeatherIndex): boolean {
    return Date.now() / 1000 - i.referenceTime <= MAX_RUN_AGE_H * 3600;
  }

  /** When our current forecast became available (null while there is none, or it is too old). */
  async getLatestUpdateTime(signal?: AbortSignal): Promise<number | null> {
    const i = await this.index(signal).catch(() => null);
    return i && StaticWeatherProvider.fresh(i) ? i.createdAt * 1000 : null;
  }

  private tile(i: WeatherIndex, ty: number, tx: number, signal?: AbortSignal): Promise<Int16Array | null> {
    const key = tileKey(i.run, ty, tx);
    return this.tiles.get(key, async () => {
      const bytes = await fetchBytes(dataUrl(this.base, key), PROVIDER, signal);
      if (!bytes) {
        // A new deploy replaced this run's files: look at the index again on the next request, not in 10 minutes.
        this.indexAt = 0;
        return null;
      }
      return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    });
  }

  async getForecasts(req: ForecastRequest): Promise<LocationForecast[]> {
    if (req.locations.length === 0) return [];
    const q = parseForecastQuery(forecastParams(req));
    if (typeof q === 'string') throw new ProviderError(q, 'invalid-response', PROVIDER);
    const fetchedAt = Date.now();
    const index = await this.index(req.signal);
    if (!index || !StaticWeatherProvider.fresh(index)) return req.locations.map((l) => noForecast(l, fetchedAt));

    // Heights for points the app gave none (map centre, a place card).
    let points = q.points;
    if (this.heights && points.some((p) => p.elevation === undefined)) {
      const h = await this.heights(points, req.signal).catch(() => points.map(() => null));
      points = points.map((p, n) => (p.elevation === undefined && h[n] != null ? { ...p, elevation: h[n]! } : p));
    }
    const have = new Set(index.tiles);
    const RV = recordValues(index);
    const cells = points.map((p) => gridCell(p.lat, p.lon));
    const recs = await Promise.all(
      cells.map(async (c) => {
        if (!have.has(`${c.ty}/${c.tx}`)) return null;
        const tile = await this.tile(index, c.ty, c.tx, req.signal);
        if (!tile || tile.length < (c.i + 1) * RV) return null;
        return tile.subarray(c.i * RV, (c.i + 1) * RV);
      }),
    );
    const tz = await zoneLookup();
    const plan = planHours(index, hoursFor(index, fetchedAt / 1000, q.pastHours, q.forecastHours));
    const units = {
      time: 'unixtime',
      ...Object.fromEntries(q.hourly.map((h) => [h, h === 'wind_speed_10m' || h === 'wind_gusts_10m' ? (q.windUnit === 'ms' ? 'm/s' : 'km/h') : HOURLY_UNITS[h]])),
    };
    return req.locations.map((loc, n) => {
      const rec = recs[n];
      if (!rec) return noForecast(loc, fetchedAt);
      const cell = cells[n];
      let timezone = 'GMT';
      try {
        timezone = tz(points[n].lat, points[n].lon);
      } catch {
        /* open sea */
      }
      const raw = {
        latitude: cell.lat,
        longitude: cell.lon,
        timezone,
        utc_offset_seconds: timeZoneOffsetMinutes(fetchedAt, timezone) * 60,
        hourly_units: units,
        ...pointForecast(index, rec, plan, { hourly: q.hourly, windUnit: q.windUnit, elevation: points[n].elevation }),
      } as unknown as OpenMeteoLocation;
      return { ...normalize(raw, loc, fetchedAt), provider: this.name };
    });
  }
}

/** "No forecast here": an empty series (nothing matches it), never invented values. */
function noForecast(loc: ForecastLocation, fetchedAt: number): LocationForecast {
  return {
    locationKey: loc.key,
    latitude: loc.latitude,
    longitude: loc.longitude,
    timezone: 'UTC',
    times: [],
    hourly: {
      temperature: [],
      apparentTemperature: [],
      precipitationProbability: [],
      precipitation: [],
      rain: [],
      snowfall: [],
      condition: [],
      description: [],
      cloudCover: [],
      windSpeed: [],
      windGusts: [],
      windDirection: [],
      visibility: [],
      humidity: [],
    },
    provider: 'navweather',
    fetchedAt,
  };
}
