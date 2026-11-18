import { gunzip } from '../../utils/gzip';
import { ProviderError } from '../http';

/**
 * Our data as static files (ADR-019): forecasts, air quality, heights, search and roads live under `/data` on the
 * app's own origin — free to serve at any scale, and read here on the device. Index files (which build is current)
 * are re-checked; build folders never change, so their files are cached for as long as the build is current.
 */

/** A small least-recently-used map of pending loads (a failed load is forgotten, so it is retried next time). */
export class LoadCache<T> {
  private map = new Map<string, Promise<T>>();
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    const p = load().catch((e) => {
      if (this.map.get(key) === p) this.map.delete(key);
      throw e;
    });
    this.map.set(key, p);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    return p;
  }
  clear() {
    this.map.clear();
  }
}

function fail(provider: string, url: string, e: unknown): never {
  if (e instanceof DOMException && e.name === 'AbortError') throw e;
  throw new ProviderError(`${url}: ${e instanceof Error ? e.message : String(e)}`, 'network', provider);
}

/** A JSON index, or null when it isn't there (data not built here). Always revalidated with the server. */
export async function fetchIndex<T>(url: string, provider: string, signal?: AbortSignal): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-cache', signal });
  } catch (e) {
    fail(provider, url, e);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ProviderError(`${url}: HTTP ${res.status}`, 'http', provider, res.status);
  // An SPA host answers a missing file with the app page.
  if (!(res.headers.get('content-type') ?? '').includes('json')) return null;
  return (await res.json()) as T;
}

/** A data file's bytes (gzip undone), or null when it isn't there. */
export async function fetchBytes(url: string, provider: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    fail(provider, url, e);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ProviderError(`${url}: HTTP ${res.status}`, 'http', provider, res.status);
  if ((res.headers.get('content-type') ?? '').includes('text/html')) return null;
  return gunzip(new Uint8Array(await res.arrayBuffer()));
}

/** Join a base ("/data", "https://…/data") and a key ("weather/latest.json"). */
export const dataUrl = (base: string, key: string) => `${base.replace(/\/$/, '')}/${key}`;
