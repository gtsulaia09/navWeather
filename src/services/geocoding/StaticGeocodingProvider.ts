import { rerank, type GeoRow } from '../../api/geocode';
import { decodePostings, shardFile, shardOf, words, MAX_POSTINGS, type SearchIndex, type SearchRow, type SearchShard } from '../../search/format';
import type { LngLat, Place } from '../../types/geo';
import { dataUrl, fetchIndex, LoadCache } from '../data/staticFiles';
import { ProviderError } from '../http';
import type { AutocompleteProvider, GeocodeOptions, GeocodingProvider } from './GeocodingProvider';

const PROVIDER = 'Search service';
/** Rows looked at per search (best ranked first): enough for the nearest small place to beat a far big one. */
const CANDIDATES = 160;

interface Term {
  word: string;
  /** Rows having a word that starts with this one (all of them, or the best MAX_POSTINGS when common). */
  ids: number[];
  count: number;
  complete: boolean;
}

/**
 * Search and suggestions on the device (ADR-019; DP-4.4): our index of the region's settlements, streets, addresses
 * and named places as static files — the words of a two-letter prefix, then the few blocks of rows the best matches
 * are in. No search server, no request limit, and the search text never leaves the device.
 */
export class StaticGeocodingProvider implements GeocodingProvider, AutocompleteProvider {
  readonly name = 'navweather-geocoder';
  private indexAt = 0;
  private indexP: Promise<SearchIndex | null> | null = null;
  private readonly shards = new LoadCache<SearchShard | null>(64);
  private readonly blocks = new LoadCache<SearchRow[] | null>(24);
  private readonly base: string;
  private readonly language: string;
  private readonly reverser: GeocodingProvider;

  constructor(base: string, language: string, reverser: GeocodingProvider) {
    this.base = base;
    this.language = language;
    this.reverser = reverser;
  }

  private index(signal?: AbortSignal): Promise<SearchIndex | null> {
    if (!this.indexP || Date.now() - this.indexAt > 60 * 60_000) {
      this.indexAt = Date.now();
      const p = fetchIndex<SearchIndex>(dataUrl(this.base, 'search.json'), PROVIDER, signal);
      this.indexP = p.catch((e) => {
        if (this.indexP === p) this.indexP = null;
        throw e;
      });
    }
    return this.indexP;
  }

  private json<T>(url: string, signal?: AbortSignal): Promise<T | null> {
    return fetch(url, { signal }).then(
      async (res) => {
        if (res.status === 404 || (res.headers.get('content-type') ?? '').includes('text/html')) return null;
        if (!res.ok) throw new ProviderError(`${url}: HTTP ${res.status}`, 'http', PROVIDER, res.status);
        return (await res.json()) as T;
      },
      (e) => {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        throw new ProviderError(`${url}: ${e instanceof Error ? e.message : e}`, 'network', PROVIDER);
      },
    );
  }

  private async term(idx: SearchIndex, word: string, signal?: AbortSignal): Promise<Term> {
    const key = shardOf(word);
    if (!idx.shards.includes(key)) return { word, ids: [], count: 0, complete: true };
    const shard = await this.shards.get(`${idx.build}/${key}`, () => this.json<SearchShard>(dataUrl(this.base, `search/${idx.build}/w/${shardFile(key)}.json`), signal));
    if (!shard) return { word, ids: [], count: 0, complete: true };
    let count = 0;
    let complete = true;
    const lists: number[][] = [];
    for (const [w, [n, deltas]] of Object.entries(shard)) {
      if (!w.startsWith(word)) continue;
      count += n;
      if (n > MAX_POSTINGS) complete = false;
      lists.push(decodePostings(deltas));
    }
    // Union, best (lowest id) first, at most MAX_POSTINGS.
    const ids = lists.length === 1 ? lists[0] : [...new Set(lists.flat())].sort((a, b) => a - b);
    if (ids.length > MAX_POSTINGS) complete = false;
    return { word, ids: ids.slice(0, MAX_POSTINGS), count, complete };
  }

  async suggest(query: string, options: GeocodeOptions = {}): Promise<Place[]> {
    const q = query.trim().slice(0, 100);
    if (q.length < 2) return [];
    const ws = [...new Set(words(q))].slice(0, 6);
    if (!ws.length || ws.every((w) => [...w].length < 2)) return [];
    const idx = await this.index(options.signal);
    if (!idx) return [];
    const terms = await Promise.all(ws.filter((w) => [...w].length >= 2).map((w) => this.term(idx, w, options.signal)));
    if (terms.some((t) => t.count === 0)) return [];

    // The rarest word drives; words with complete lists narrow it down exactly; the rest are checked on the rows.
    terms.sort((a, b) => a.count - b.count);
    let candidates = terms[0].ids;
    for (const t of terms.slice(1)) {
      if (!t.complete) continue;
      const set = new Set(t.ids);
      candidates = candidates.filter((id) => set.has(id));
    }
    candidates = candidates.slice(0, CANDIDATES);
    if (!candidates.length) return [];

    const blockIds = [...new Set(candidates.map((id) => Math.floor(id / idx.blockRows)))];
    const blocks = new Map(
      await Promise.all(
        blockIds.map(async (b) => [b, await this.blocks.get(`${idx.build}/${b}`, () => this.json<SearchRow[]>(dataUrl(this.base, `search/${idx.build}/r/${b}.json`), options.signal))] as const),
      ),
    );
    const rows: GeoRow[] = [];
    for (const id of candidates) {
      const row = blocks.get(Math.floor(id / idx.blockRows))?.[id % idx.blockRows];
      if (!row) continue;
      const [rid, kind, rank, lon, lat, nameEn, nameRu, ctxEn, ctxRu, text] = row;
      const [names, ctx = ''] = text.split(' | ');
      const nameWords = names.split(' ');
      const ctxWords = ctx ? ctx.split(' ') : [];
      let nameHits = 0;
      let ok = true;
      for (const w of ws) {
        if (nameWords.some((x) => x.startsWith(w))) nameHits++;
        else if (!ctxWords.some((x) => x.startsWith(w))) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      rows.push({ id: rid, kind, rank, lat, lon, name_en: nameEn, name_ru: nameRu, ctx_en: ctxEn || null, ctx_ru: ctxRu || null, s: -(nameHits * 5 + (ws.length - nameHits)) });
    }
    const lang = (options.language ?? this.language) === 'ru' ? 'ru' : 'en';
    return rerank(rows, q, options.near ?? null, lang, Math.max(1, Math.min(10, options.limit ?? 6)));
  }

  async geocode(query: string, options: GeocodeOptions = {}): Promise<Place | null> {
    const q = query.trim().slice(0, 100);
    if (q.length < 2) return null;
    const idx = await this.index(options.signal);
    if (!idx) throw new ProviderError('Search index not built yet', 'data-missing', PROVIDER);
    return (await this.suggest(query, { ...options, limit: 1 }))[0] ?? null;
  }

  reverse(coordinate: LngLat, options?: GeocodeOptions): Promise<Place | null> {
    return this.reverser.reverse(coordinate, options);
  }
}
