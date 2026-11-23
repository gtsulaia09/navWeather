/**
 * Map background from our own static files (ADR-020): the Protomaps basemap (© OpenStreetMap contributors, ODbL),
 * packed 85 tiles to a file so a phone fetches a handful of small immutable files instead of thousands of tiles —
 * and no server range requests are needed. Shared by the builder (pipelines/basemap/build.mjs) and the app
 * (`src/map/packProtocol.ts`). No DOM, no React.
 *
 * A pack holds a root tile and its descendants for the zoom levels of its band:
 *   band 0: root z0 → z0–3      (world)
 *   band 4: root z4 → z4–6      (world)
 *   band 7: root z7 → z7–10     (regions we build)
 *   band 11: root z11 → z11–14  (regions we build; MapLibre over-zooms beyond 14)
 *
 * File layout of a basemap build (static assets of the `navweather-basemap` Worker, or public/data/basemap locally):
 *   <base>/index.json                          { v: 1, build, ... } — the only file that is ever revalidated
 *   <base>/<build>/p/<rootZ>/<x>/<y>.pack      packs (immutable)
 *   <base>/<build>/style-<light|dark>-<lang>.json
 *   <base>/assets/fonts/<fontstack>/<range>.pbf, <base>/assets/sprites/<light|dark>[@2x].{json,png}
 *
 * Pack format "NWP1": magic(4) · count(u32 LE) · count × [z u8, x u32, y u32, offset u32, length u32] · tile data.
 * Each tile is a gzip-compressed Mapbox Vector Tile; offsets are from the start of the file.
 */

export const BANDS = [
  { root: 0, max: 3 },
  { root: 4, max: 6 },
  { root: 7, max: 10 },
  { root: 11, max: 14 },
] as const;
export const WORLD_MAX_ZOOM = 6;
export const MAX_ZOOM = 14;
const MAGIC = 0x3150574e; // "NWP1" little-endian
const ENTRY = 17;

export interface BasemapIndex {
  v: 1;
  build: string;
  /** Source build of the planet file (Protomaps daily build key) — for the record and attribution. */
  source: string;
  /** Bounds of the regions with detail (zoom 7–14), [w, s, e, n] each. */
  regions: [number, number, number, number][];
  /** Pack roots that exist, per band root zoom: "x/y". */
  packs: Record<string, string[]>;
  langs: string[];
}

export function isBasemapIndex(x: unknown): x is BasemapIndex {
  const o = x as BasemapIndex;
  return !!o && o.v === 1 && typeof o.build === 'string' && /^[\w-]{1,40}$/.test(o.build) && !!o.packs && typeof o.packs === 'object' && Array.isArray(o.regions);
}

/** The pack holding tile z/x/y: band root zoom and root tile. */
export function packOf(z: number, x: number, y: number): { rz: number; rx: number; ry: number } | null {
  const band = BANDS.find((b) => z >= b.root && z <= b.max);
  if (!band) return null;
  const d = z - band.root;
  return { rz: band.root, rx: x >> d, ry: y >> d };
}

export function packPath(build: string, rz: number, rx: number, ry: number): string {
  return `${build}/p/${rz}/${rx}/${ry}.pack`;
}

export interface PackTile {
  z: number;
  x: number;
  y: number;
  data: Uint8Array;
}

export function encodePack(tiles: PackTile[]): Uint8Array {
  const header = 8 + tiles.length * ENTRY;
  const total = header + tiles.reduce((n, t) => n + t.data.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, tiles.length, true);
  let offset = header;
  tiles.forEach((t, i) => {
    const at = 8 + i * ENTRY;
    dv.setUint8(at, t.z);
    dv.setUint32(at + 1, t.x, true);
    dv.setUint32(at + 5, t.y, true);
    dv.setUint32(at + 9, offset, true);
    dv.setUint32(at + 13, t.data.length, true);
    out.set(t.data, offset);
    offset += t.data.length;
  });
  return out;
}

/** Tile key → [offset, length] in the pack. */
export type PackDirectory = Map<string, [number, number]>;

export function readPackDirectory(buf: ArrayBuffer): PackDirectory {
  const dv = new DataView(buf);
  if (buf.byteLength < 8 || dv.getUint32(0, true) !== MAGIC) throw new Error('not a basemap pack');
  const n = dv.getUint32(4, true);
  if (8 + n * ENTRY > buf.byteLength) throw new Error('truncated basemap pack');
  const dir: PackDirectory = new Map();
  for (let i = 0; i < n; i++) {
    const at = 8 + i * ENTRY;
    const off = dv.getUint32(at + 9, true);
    const len = dv.getUint32(at + 13, true);
    if (off + len > buf.byteLength) throw new Error('truncated basemap pack');
    dir.set(`${dv.getUint8(at)}/${dv.getUint32(at + 1, true)}/${dv.getUint32(at + 5, true)}`, [off, len]);
  }
  return dir;
}

/** Every tile of a pack's band below its root (root first). */
export function packMembers(rz: number, rx: number, ry: number): { z: number; x: number; y: number }[] {
  const band = BANDS.find((b) => b.root === rz);
  if (!band) return [];
  const out: { z: number; x: number; y: number }[] = [];
  for (let z = rz; z <= band.max; z++) {
    const d = z - rz;
    for (let x = rx << d; x < (rx + 1) << d; x++) for (let y = ry << d; y < (ry + 1) << d; y++) out.push({ z, x, y });
  }
  return out;
}

/** Tile x/y range covering a bbox at zoom z (Web Mercator). */
export function tileRange(bbox: [number, number, number, number], z: number): { x0: number; x1: number; y0: number; y1: number } {
  const n = 2 ** z;
  const lon2x = (lon: number) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const lat2y = (lat: number) => {
    const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
    return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)));
  };
  const [w, s, e, nn] = bbox;
  return { x0: lon2x(w), x1: lon2x(e), y0: lat2y(nn), y1: lat2y(s) };
}
