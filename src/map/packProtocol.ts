/**
 * The `navpack://` protocol MapLibre loads our own basemap through (ADR-020): styles, tiles (from packs of 85),
 * fonts and sprites, all static files under one base URL. When no basemap is deployed (or the index cannot be read)
 * the style request returns the fallback style instead (OpenFreeMap), so the map never stays blank.
 */
import { gunzip as gunzipBytes } from '../utils/gzip';
import { isBasemapIndex, packOf, packPath, readPackDirectory, type BasemapIndex, type PackDirectory } from './packs';

export interface PackProtocolOptions {
  baseUrl: string;
  /** Style URL to use when our basemap is unavailable. */
  fallbackStyle: (theme: 'light' | 'dark') => string;
  /** How many decoded packs to keep in memory (each ≈ 0.1–3 MB). */
  maxPacks?: number;
}

interface Req {
  url: string;
  type?: string;
}

const EMPTY = new ArrayBuffer(0);
const KNOWN_FONTS = new Set(['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic']);
const isHtml = (res: Response) => (res.headers.get('content-type') ?? '').includes('text/html');

/** Adapt a Protomaps EN/RU style into native Georgian (`ka`) labels when no pre-built `style-*-ka.json` exists yet. */
function adaptStyleForGeorgian(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { layers?: unknown[] }).layers)) return raw;
  const doc = raw as { layers: Record<string, unknown>[] };
  return {
    ...doc,
    layers: doc.layers.map((layer) => {
      if (layer.type !== 'symbol' || !layer.layout || typeof layer.layout !== 'object') return layer;
      const layout = { ...(layer.layout as Record<string, unknown>) };
      if ('text-field' in layout) {
        layout['text-field'] = ['coalesce', ['get', 'name:ka'], ['get', 'pgf:name'], ['get', 'name'], ['get', 'name:en']];
      }
      // Noto Sans Italic lacks Georgian glyphs (26-byte stub PBF): switch italic stacks to Regular so water/park labels render.
      if (Array.isArray(layout['text-font'])) {
        layout['text-font'] = (layout['text-font'] as string[]).map((f) => (f === 'Noto Sans Italic' ? 'Noto Sans Regular' : f));
      }
      return { ...layer, layout };
    }),
  };
}

export function createPackProtocol(opts: PackProtocolOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const maxPacks = opts.maxPacks ?? 48;
  let index: Promise<{ value: BasemapIndex; have: Map<string, Set<string>> } | null> | null = null;
  const packs = new Map<string, Promise<{ buf: ArrayBuffer; dir: PackDirectory } | null>>();

  function loadIndex() {
    index ??= fetch(`${base}/index.json`, { cache: 'no-cache' })
      .then(async (res) => {
        const body = res.ok && (res.headers.get('content-type') ?? '').includes('json') ? ((await res.json()) as unknown) : null;
        if (!isBasemapIndex(body)) return null;
        const have = new Map(Object.entries(body.packs).map(([z, list]) => [z, new Set(list)]));
        return { value: body, have };
      })
      .catch(() => {
        index = null; // try again on the next style load
        return null;
      });
    return index;
  }

  function loadPack(build: string, rz: number, rx: number, ry: number) {
    const key = `${rz}/${rx}/${ry}`;
    let p = packs.get(key);
    if (p) {
      packs.delete(key); // most recently used goes last
      packs.set(key, p);
      return p;
    }
    // Never tie the shared cached pack download to one tile's AbortSignal: MapLibre cancelling one tile mid-zoom
    // would otherwise abort the pack for all 85 sibling tiles in the same pack (B-49).
    p = fetch(`${base}/${packPath(build, rz, rx, ry)}`)
      .then(async (res) => {
        if (!res.ok || isHtml(res)) throw new Error(`pack ${res.status}`);
        const buf = await res.arrayBuffer();
        return { buf, dir: readPackDirectory(buf) };
      })
      .catch(() => {
        packs.delete(key);
        return null;
      });
    packs.set(key, p);
    while (packs.size > maxPacks) packs.delete(packs.keys().next().value!);
    return p;
  }

  async function gunzip(bytes: Uint8Array): Promise<ArrayBuffer> {
    const out = await gunzipBytes(bytes);
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  }

  async function tile(z: number, x: number, y: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (signal?.aborted) return EMPTY;
    const idx = await loadIndex();
    const where = packOf(z, x, y);
    if (!idx || !where || !idx.have.get(String(where.rz))?.has(`${where.rx}/${where.ry}`)) return EMPTY;
    const pack = await loadPack(idx.value.build, where.rz, where.rx, where.ry);
    if (signal?.aborted) return EMPTY;
    const entry = pack?.dir.get(`${z}/${x}/${y}`);
    if (!pack || !entry) return EMPTY;
    return gunzip(new Uint8Array(pack.buf, entry[0], entry[1]));
  }

  async function style(theme: 'light' | 'dark', lang: string): Promise<unknown> {
    const idx = await loadIndex();
    const hasLang = idx?.value.langs.includes(lang) ?? false;
    const url = idx ? `${base}/${idx.value.build}/style-${theme}-${hasLang ? lang : 'en'}.json` : opts.fallbackStyle(theme);
    const res = await fetch(url);
    if (!res.ok || isHtml(res)) {
      if (!idx) throw new Error(`map style ${res.status}`);
      return (await fetch(opts.fallbackStyle(theme))).json();
    }
    const json = await res.json();
    return idx && lang === 'ka' && !hasLang ? adaptStyleForGeorgian(json) : json;
  }

  /** MapLibre `addProtocol` handler. */
  return async function load(params: Req, ctrl: AbortController): Promise<{ data: unknown }> {
    const path = params.url.replace(/^navpack:\/\//, '');
    const parts = path.split('/');
    if (parts[0] === 'tiles') {
      const [z, x, y] = parts.slice(1, 4).map(Number);
      return { data: await tile(z, x, y, ctrl.signal) };
    }
    if (parts[0] === 'style') {
      return { data: await style(parts[1] === 'dark' ? 'dark' : 'light', parts[2] ?? 'en') };
    }
    if (parts[0] === 'assets') {
      if (parts[1] === 'fonts' && parts.length >= 4) {
        const rawStack = decodeURIComponent(parts[2]);
        const range = decodeURIComponent(parts[3]);
        // Normalize composite or unsupported font stacks (and Georgian italic stub range) to Noto Sans Regular.
        const chosen =
          KNOWN_FONTS.has(rawStack) && !(rawStack === 'Noto Sans Italic' && range === '4096-4351.pbf')
            ? rawStack
            : 'Noto Sans Regular';
        const fontUrl = `${base}/assets/fonts/${encodeURIComponent(chosen)}/${encodeURIComponent(range)}`;
        const res = await fetch(fontUrl, { signal: ctrl.signal });
        if (!res.ok || isHtml(res)) return { data: EMPTY };
        return { data: await res.arrayBuffer() };
      }
      // Other assets (sprites): normalise every segment and reject SPA HTML fallbacks.
      const rest = parts.slice(1).map((s) => encodeURIComponent(decodeURIComponent(s)).replace(/%40/g, '@')).join('/');
      const res = await fetch(`${base}/assets/${rest}`, { signal: ctrl.signal });
      if (!res.ok || isHtml(res)) {
        throw new Error(`basemap asset ${res.status}`);
      }
      return { data: params.type === 'json' ? await res.json() : await res.arrayBuffer() };
    }
    throw new Error(`unknown basemap resource ${params.url}`);
  };
}
