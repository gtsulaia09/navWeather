/**
 * OFFLINE FILE CACHE seam for immutable `/data` files (roads, search shards, weather/air/elevation tiles, basemap packs).
 * Web uses Cache Storage API (when available) with an in-memory LRU fallback; React Native injects an on-disk
 * filesystem cache (e.g. RNFS / Expo FileSystem) via `setFileCacheProvider(...)` so static files read from disk offline.
 */
export interface FileCacheProvider {
  readonly name: string;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export function memoryFileCache(maxEntries = 128): FileCacheProvider {
  const map = new Map<string, Uint8Array>();
  return {
    name: 'memory-file-cache',
    async get(key) {
      const v = map.get(key);
      if (!v) return null;
      map.delete(key);
      map.set(key, v);
      return v;
    },
    async put(key, bytes) {
      map.delete(key);
      map.set(key, bytes);
      while (map.size > maxEntries) map.delete(map.keys().next().value!);
    },
    async delete(key) {
      map.delete(key);
    },
    async clear() {
      map.clear();
    },
  };
}

const CACHE_NAME = 'navweather-files-v1';

export function webFileCache(fallbackMax = 128): FileCacheProvider {
  const fallback = memoryFileCache(fallbackMax);
  const open = () => (typeof caches !== 'undefined' ? caches.open(CACHE_NAME).catch(() => null) : Promise.resolve(null));
  const reqUrl = (key: string) => (key.startsWith('http://') || key.startsWith('https://') ? key : `https://navweather.local/${key.replace(/^\/+/, '')}`);
  return {
    name: 'web-file-cache',
    async get(key) {
      const cache = await open();
      if (!cache) return fallback.get(key);
      const hit = await cache.match(reqUrl(key));
      return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
    },
    async put(key, bytes) {
      const cache = await open();
      if (!cache) return fallback.put(key, bytes);
      await cache.put(reqUrl(key), new Response(bytes as BodyInit, { headers: { 'Content-Type': 'application/octet-stream' } }));
    },
    async delete(key) {
      const cache = await open();
      if (!cache) return fallback.delete(key);
      await cache.delete(reqUrl(key));
    },
    async clear() {
      if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME).catch(() => undefined);
      await fallback.clear();
    },
  };
}

let current: FileCacheProvider = webFileCache();

export function getFileCacheProvider(): FileCacheProvider {
  return current;
}

export function setFileCacheProvider(provider: FileCacheProvider | null): void {
  current = provider ?? webFileCache();
}
