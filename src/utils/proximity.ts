import type { LngLat } from '../types/geo';
import { projectOntoSegment } from './distance';

const M_PER_DEG_LAT = 111_195;

/** Answers "is this point within `maxM` metres of the line?" without scanning the whole line. */
export interface ProximityIndex {
  /** True when some segment of the line is at most `maxM` from `p` (exact, same metric as projectOntoLine). */
  within(p: LngLat, maxM: number): boolean;
  /** The largest `maxM` the index answers exactly (its cell size). */
  readonly cellM: number;
}

/**
 * A uniform grid over a polyline's segments. Each segment is filed under every cell its bounding box touches;
 * a query looks only at the 3×3 cells around the point. With cells at least `cellM` wide, every segment within
 * `cellM` of the point is in one of those cells, so the answer is exact while costing a handful of segment checks
 * instead of one per vertex — the difference between ~600 ms and a few ms per route comparison on a slow phone.
 */
export function createProximityIndex(coords: LngLat[], cellM: number): ProximityIndex {
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const c of coords) {
    if (c[1] < minLat) minLat = c[1];
    if (c[1] > maxLat) maxLat = c[1];
  }
  // A longitude degree is shortest at the latitude farthest from the equator: size cells for that one so they
  // are never narrower than cellM anywhere on the line.
  const cosMin = Math.max(0.05, Math.cos((Math.max(Math.abs(minLat), Math.abs(maxLat)) * Math.PI) / 180));
  const latCell = cellM / M_PER_DEG_LAT;
  const lonCell = cellM / (M_PER_DEG_LAT * cosMin);
  const cells = new Map<number, number[]>();
  // One safe integer per cell; unique while |cy| < 2^21, i.e. for any latitude at cells of 5 m or more.
  const key = (cx: number, cy: number) => cx * 4_194_304 + cy;

  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const x0 = Math.floor(Math.min(a[0], b[0]) / lonCell);
    const x1 = Math.floor(Math.max(a[0], b[0]) / lonCell);
    const y0 = Math.floor(Math.min(a[1], b[1]) / latCell);
    const y1 = Math.floor(Math.max(a[1], b[1]) / latCell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy);
        const list = cells.get(k);
        if (list) list.push(i);
        else cells.set(k, [i]);
      }
    }
  }

  // Segments seen by the current query (a segment can sit in several of the 9 cells).
  const seen = new Uint32Array(Math.max(1, coords.length));
  let stamp = 0;

  return {
    cellM,
    within(p, maxM) {
      if (coords.length < 2) return false;
      if (maxM > cellM) throw new RangeError(`within(${maxM}) needs an index with cells of at least ${maxM} m`);
      stamp = stamp === 0xffffffff ? 1 : stamp + 1;
      if (stamp === 1) seen.fill(0);
      const cx = Math.floor(p[0] / lonCell);
      const cy = Math.floor(p[1] / latCell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const list = cells.get(key(cx + dx, cy + dy));
          if (!list) continue;
          for (const i of list) {
            if (seen[i] === stamp) continue;
            seen[i] = stamp;
            if (projectOntoSegment(p, coords[i], coords[i + 1]).distanceM <= maxM) return true;
          }
        }
      }
      return false;
    },
  };
}

const indexes = new WeakMap<LngLat[], Map<number, ProximityIndex>>();

/**
 * One index per line and cell size, kept as long as the line is (routes are immutable once built), so comparing
 * several candidate roads against the same road builds its index once.
 */
export function proximityIndexFor(coords: LngLat[], cellM: number): ProximityIndex {
  let bySize = indexes.get(coords);
  if (!bySize) indexes.set(coords, (bySize = new Map()));
  let idx = bySize.get(cellM);
  if (!idx) bySize.set(cellM, (idx = createProximityIndex(coords, cellM)));
  return idx;
}
