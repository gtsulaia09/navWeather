import type { LngLat } from '../../types/geo';
import { AIR_LATEST_KEY, AIR_MAX_AGE_H, AIR_NONE, airCell, airTileKey, type AirIndex } from '../../api/air';
import { dataUrl, fetchBytes, fetchIndex, LoadCache } from '../data/staticFiles';

export interface AirQuality {
  /** European AQI (0 good … 100+ extremely poor). */
  europeanAqi: number;
  observedAt: number;
}

export interface AirQualityProvider {
  readonly name: string;
  current(coordinate: LngLat, signal?: AbortSignal): Promise<AirQuality | null>;
}

/**
 * Air quality on the device (ADR-019; DP-4.6): our CAMS tiles as static files (4° × 4°, one byte per hour and point,
 * ≈ 5 kB) — the European AQI for the current hour, anywhere on land we build. No air-quality server; where we have no
 * data the answer is "not available" (null).
 */
export class StaticAirQualityProvider implements AirQualityProvider {
  readonly name = 'navweather-air';
  private indexAt = 0;
  private indexP: Promise<AirIndex | null> | null = null;
  private readonly tiles = new LoadCache<Uint8Array | null>(48);
  private readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  private index(signal?: AbortSignal): Promise<AirIndex | null> {
    if (!this.indexP || Date.now() - this.indexAt > 15 * 60_000) {
      this.indexAt = Date.now();
      const p = fetchIndex<AirIndex>(dataUrl(this.base, AIR_LATEST_KEY), 'Air quality service', signal);
      this.indexP = p.catch((e) => {
        if (this.indexP === p) this.indexP = null;
        throw e;
      });
    }
    return this.indexP;
  }

  async current([lon, lat]: LngLat, signal?: AbortSignal): Promise<AirQuality | null> {
    const index = await this.index(signal);
    if (!index) return null;
    const nowS = Date.now() / 1000;
    if (nowS - index.referenceTime > AIR_MAX_AGE_H * 3600) return null;
    const hour = Math.floor(nowS / 3600) * 3600;
    const h = index.times.indexOf(hour);
    if (h < 0) return null;
    const cell = airCell(lat, lon);
    if (!index.tiles.includes(`${cell.ty}/${cell.tx}`)) return null;
    const key = airTileKey(index.run, cell.ty, cell.tx);
    const tile = await this.tiles.get(key, () => fetchBytes(dataUrl(this.base, key), 'Air quality service', signal));
    const v = tile?.[cell.i * index.times.length + h];
    return v === undefined || v === AIR_NONE ? null : { europeanAqi: v, observedAt: hour * 1000 };
  }
}

export type AqiLevel = 'good' | 'fair' | 'moderate' | 'poor' | 'veryPoor' | 'extremelyPoor';

/** European AQI bands (EEA). */
export function aqiLevel(aqi: number): AqiLevel {
  if (aqi <= 20) return 'good';
  if (aqi <= 40) return 'fair';
  if (aqi <= 60) return 'moderate';
  if (aqi <= 80) return 'poor';
  if (aqi <= 100) return 'veryPoor';
  return 'extremelyPoor';
}
