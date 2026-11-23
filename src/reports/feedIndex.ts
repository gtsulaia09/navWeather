import type { PublicReport } from './protocol.ts';

/** Pure feed-index helpers (zero crypto dependencies — keeps `@noble/*` out of the main bundle). */

export const cellOf = (lat: number, lon: number): string => `${Math.floor(lat)}_${Math.floor(lon)}`;

/** Cells (1°×1°) a set of boxes touches. */
export function cellsForBoxes(boxes: [number, number, number, number][]): string[] {
  const out = new Set<string>();
  for (const [w, s, e, n] of boxes) {
    for (let lat = Math.floor(s); lat <= Math.floor(n); lat++) for (let lon = Math.floor(w); lon <= Math.floor(e); lon++) out.add(`${lat}_${lon}`);
  }
  return [...out];
}

export interface FeedIndex {
  v: 1;
  build: string;
  generatedAt: number;
  cells: string[];
}

export interface FeedCell {
  v: 1;
  generatedAt: number;
  reports: PublicReport[];
}

export function isFeedIndex(x: unknown): x is FeedIndex {
  const o = x as FeedIndex;
  return !!o && o.v === 1 && typeof o.build === 'string' && /^[\w-]{1,40}$/.test(o.build) && Number.isFinite(o.generatedAt) && Array.isArray(o.cells);
}
