import type { LngLat, Place } from '../types/geo';
import { haversineM } from '../utils/distance';

/**
 * Search ranking for our geocoder (`/api/v1/geocode`, DEVELOPMENT_PLAN DP-4.4) — platform-neutral, shared by the
 * Worker (worker/geocode.ts) and tests: the query as FTS5 terms, and the final order of the candidates.
 */

/** A candidate row from the D1 index (`pipelines/osm/geocode.mjs`), with its FTS5 bm25 score `s` (lower = better). */
export interface GeoRow {
  id: string;
  kind: string;
  rank: number;
  lat: number;
  lon: number;
  name_en: string;
  name_ru: string;
  ctx_en: string | null;
  ctx_ru: string | null;
  s: number;
}

const SETTLEMENT = /^(city|town|village|hamlet|suburb|quarter|neighbourhood|isolated_dwelling)$/;

/** Words of the query as FTS5 prefix terms (letters and digits only — nothing else reaches the MATCH syntax). */
export function ftsQuery(q: string): string | null {
  const words = q
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 6);
  if (!words.length || words.every((w) => w.length < 2)) return null;
  return words.map((w) => `"${w}"${w.length >= 2 ? '*' : ''}`).join(' ');
}

export function parseNear(v: string | null): LngLat | null {
  const m = /^(-?\d{1,3}(?:\.\d+)?),(-?\d{1,2}(?:\.\d+)?)$/.exec(v ?? '');
  if (!m) return null;
  const [lon, lat] = [Number(m[1]), Number(m[2])];
  return Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? [lon, lat] : null;
}

/** Rank: exact name match first, then prefix match & importance, then closeness to `near` (B-45). */
export function rerank(rows: GeoRow[], q: string, near: LngLat | null, lang: 'en' | 'ru', limit: number): Place[] {
  const head = q.trim().toLowerCase();
  const scored = rows.map((r) => {
    const name = lang === 'ru' ? r.name_ru : r.name_en;
    const names = [name.toLowerCase(), r.name_en.toLowerCase(), r.name_ru.toLowerCase()];
    const exact = names.some((n) => n === head);
    const prefix = !exact && names.some((n) => n.startsWith(head));
    let score = -r.s + r.rank * 0.2;
    if (exact) score += 7;
    else if (prefix) score += 3;
    if (near) score -= Math.min(3.5, haversineM(near, [r.lon, r.lat]) / 60_000);
    return { r, name, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const { r, name } of scored) {
    const ctx = lang === 'ru' ? r.ctx_ru : r.ctx_en;
    const label = ctx && ctx !== name ? `${name}, ${ctx}` : name;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ id: `osm:${r.id}`, name, label, coordinate: [r.lon, r.lat], kind: SETTLEMENT.test(r.kind) ? r.kind : r.kind === 'street' || r.kind === 'address' ? r.kind : 'poi' });
    if (out.length >= limit) break;
  }
  return out;
}
