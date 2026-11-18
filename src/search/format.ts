/**
 * Our search index as static files (ADR-019; replaces the D1 full-text index of DP-4.4): built by
 * `pipelines/osm/geocode.mjs`, searched on the device by `src/services/geocoding/StaticGeocodingProvider.ts`.
 * Erasable TypeScript only, so the Node pipeline imports this same file.
 *
 *   /data/search.json                          index: current build, row count, block size, shards present
 *   /data/search/<build>/w/<shard>.json        words beginning with one two-letter prefix → the rows that have them
 *   /data/search/<build>/r/<block>.json        the rows themselves, BLOCK_ROWS per file
 *
 * Rows are numbered best first (by rank), so the first ids of a word are its most important places and a search
 * reads only a few row blocks. Posting lists are capped at MAX_POSTINGS ids per word (common words like "street");
 * a search then leans on the query's rarest word.
 */

export const SEARCH_VERSION = 1;
export const BLOCK_ROWS = 250;
export const MAX_POSTINGS = 4000;

/** A row as stored in a block: [id, kind, rank, lon, lat, name_en, name_ru, ctx_en, ctx_ru, words]. */
export type SearchRow = [string, string, number, number, number, string, string, string, string, string];

export interface SearchIndex {
  version: number;
  build: string;
  rows: number;
  blockRows: number;
  /** Shard keys present (two-letter prefixes). */
  shards: string[];
  bbox: [number, number, number, number];
  source: string;
}

/** One shard: word → [count of rows having it, delta-encoded row ids (ascending, capped)]. */
export type SearchShard = Record<string, [number, number[]]>;

/**
 * Words of a text as the index stores them: lower case, NFKC, accents removed (as FTS5's unicode61 with
 * remove_diacritics), split on anything that is not a letter or a digit.
 */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The shard a word lives in: its first two letters ("" for one-letter words, which are not indexed). */
export function shardOf(word: string): string {
  const chars = [...word];
  return chars.length >= 2 ? chars.slice(0, 2).join('') : '';
}

/** File name of a shard (encoded, so any script is a safe path). */
export function shardFile(shard: string): string {
  return [...shard].map((c) => c.codePointAt(0)!.toString(36)).join('-');
}

export function encodePostings(ids: number[]): number[] {
  const out: number[] = [];
  let prev = 0;
  for (const id of ids) {
    out.push(id - prev);
    prev = id;
  }
  return out;
}

export function decodePostings(deltas: number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const d of deltas) out.push((acc += d));
  return out;
}
