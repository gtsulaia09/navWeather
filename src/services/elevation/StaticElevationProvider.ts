import {
  cellOf,
  decodeHeader,
  ELEV_INDEX_KEY,
  ELEV_MISSING,
  elevBlockKey,
  elevHeaderKey,
  elevTileOf,
  tileStatus,
  type ElevationIndex,
  type TileHeader,
} from '../../api/elevation';
import type { LngLat } from '../../types/geo';
import { inflateRaw } from '../../utils/gzip';
import { dataUrl, fetchBytes, fetchIndex, LoadCache } from '../data/staticFiles';
import { ProviderError } from '../http';
import type { ElevationProvider } from './ElevationProvider';

const PROVIDER = 'Elevation service';
const INDEX_TTL_MS = 60 * 60_000;

/**
 * Ground heights on the device (ADR-019; DP-4.7): our Copernicus GLO-90 tiles as static files — a tile's header and
 * the one block (a few kB) a point falls in. Route profiles, passes and the forecast's own-height temperature, with no
 * elevation server.
 */
export class StaticElevationProvider implements ElevationProvider {
  readonly name = 'navweather-elevation';
  private indexAt = 0;
  private indexP: Promise<{ tiles: Set<string>; sea: Set<string> } | null> | null = null;
  private readonly headers = new LoadCache<TileHeader | null>(64);
  private readonly blocks = new LoadCache<Int16Array | null>(128);
  private readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  private index(signal?: AbortSignal) {
    if (!this.indexP || Date.now() - this.indexAt > INDEX_TTL_MS) {
      this.indexAt = Date.now();
      const p = fetchIndex<ElevationIndex>(dataUrl(this.base, ELEV_INDEX_KEY), PROVIDER, signal).then((i) =>
        i ? { tiles: new Set(i.tiles), sea: new Set(i.sea ?? []) } : null,
      );
      this.indexP = p.catch((e) => {
        if (this.indexP === p) this.indexP = null;
        throw e;
      });
    }
    return this.indexP;
  }

  /** Heights in metres; null where our tiles don't reach. */
  async heights(points: { lat: number; lon: number }[], signal?: AbortSignal): Promise<(number | null)[]> {
    const index = await this.index(signal);
    if (!index) return points.map(() => null);
    return Promise.all(
      points.map(async ({ lat, lon }) => {
        const status = tileStatus(index, lat, lon);
        if (status === 'unknown') return null;
        if (status === 'sea') return 0;
        const t = elevTileOf(lat, lon);
        const h = await this.headers.get(`${t.lat}/${t.lon}`, async () => {
          const bytes = await fetchBytes(dataUrl(this.base, elevHeaderKey(t.lat, t.lon)), PROVIDER, signal);
          return bytes ? decodeHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) : null;
        });
        if (!h) return null;
        const cell = cellOf(h, lat, lon);
        if (!h.lengths[cell.block]) return 0; // an all-sea block
        const values = await this.blocks.get(`${t.lat}/${t.lon}/${cell.block}`, async () => {
          const z = await fetchBytes(dataUrl(this.base, elevBlockKey(t.lat, t.lon, cell.block)), PROVIDER, signal);
          if (!z) return null;
          const raw = await inflateRaw(z);
          return new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
        });
        if (!values) return null;
        const v = values[cell.i];
        return v === ELEV_MISSING ? 0 : v;
      }),
    );
  }

  async getElevations(coords: LngLat[], signal?: AbortSignal): Promise<number[]> {
    const h = await this.heights(
      coords.map(([lon, lat]) => ({ lat, lon })),
      signal,
    );
    if (h.some((v) => v === null)) throw new ProviderError('No elevation data here', 'not-found', PROVIDER);
    return h as number[];
  }
}
