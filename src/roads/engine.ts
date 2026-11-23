import { gunzip } from '../utils/gzip';
import { decodeRoadFile, tileOf, type RoadFile, type RoadsIndex } from './format';
import { buildGraph, buildSnapIndex, componentSizes, haversine, snap, type RoadGraph, type Snap, type SnapIndex } from './graph';
import { buildLeg, buildRoute, type OsrmLikeRoute } from './guidance';
import { allowed, type RoadMode } from './profiles';
import { findAlternatives, findPath, type RoadPath, type SearchOptions } from './search';

/**
 * Routing on the device (ADR-019): picks the road files a trip needs (the region's main roads plus the street tiles
 * around each stop — or every street tile between two close points), joins them into one graph, and searches it.
 * Nothing leaves the device but requests for static files.
 */

export interface RoutePoint {
  lon: number;
  lat: number;
  /** A silent via point: driven through, not a stop. */
  via?: boolean;
}

export interface EngineRequest {
  mode: RoadMode;
  /** Start, via points / stops in order, destination. */
  points: RoutePoint[];
  /** Alternatives wanted besides the best route (two-point trips only). */
  alternatives?: number;
  avoid?: ('tolls' | 'highways' | 'ferries')[];
  bearingDeg?: number;
  language?: string;
}

import { RoadEngineError } from './errors';
export { RoadEngineError, type RoadEngineErrorCode } from './errors';

/** Where the files come from: fetch on the device, the file system in tests and pipelines. */
export interface RoadSource {
  index(): Promise<RoadsIndex>;
  /** Raw (possibly gzip-compressed) bytes of `<build>/<path>`. */
  bytes(build: string, path: string): Promise<Uint8Array>;
}

/** Two points closer than this (m) route over street tiles only — every street counts. */
const SHORT_TRIP_M = 12_000;
/** Street tiles loaded around each stop of a longer trip (m), widened when a stop can't reach the main roads. */
const RADII_M = [1_500, 6_000, 15_000];
const SNAP_MAX_M = 3_000;
/** A piece of road network smaller than this (edges) is a stray fragment, not somewhere to start or end. */
const MIN_COMPONENT_EDGES = 200;
const MAX_FILES = 80;
const MAX_GRAPHS = 3;

export class RoadEngine {
  private indexP: Promise<RoadsIndex> | null = null;
  private indexAt = 0;
  private files = new Map<string, Promise<RoadFile>>();
  private graphs = new Map<string, { g: RoadGraph; idx: SnapIndex }>();
  private readonly source: RoadSource;

  constructor(source: RoadSource) {
    this.source = source;
  }

  private index(): Promise<RoadsIndex> {
    // Re-read the small index now and then: a new build of the data may have been deployed.
    if (!this.indexP || Date.now() - this.indexAt > 3_600_000) {
      this.indexAt = Date.now();
      this.indexP = this.source.index().catch((e) => {
        this.indexP = null;
        throw new RoadEngineError(`Road data unavailable: ${e instanceof Error ? e.message : e}`, 'data-unavailable');
      });
    }
    return this.indexP;
  }

  private file(build: string, path: string): Promise<RoadFile> {
    const key = `${build}/${path}`;
    let p = this.files.get(key);
    if (p) {
      this.files.delete(key);
      this.files.set(key, p); // most recently used last
      return p;
    }
    p = this.source
      .bytes(build, path)
      .then(gunzip)
      .then(decodeRoadFile)
      .catch((e) => {
        this.files.delete(key);
        throw new RoadEngineError(`Road data unavailable: ${e instanceof Error ? e.message : e}`, 'data-unavailable');
      });
    this.files.set(key, p);
    while (this.files.size > MAX_FILES) this.files.delete(this.files.keys().next().value as string);
    return p;
  }

  /** Is this point inside a region we have roads for? */
  async covers(lon: number, lat: number): Promise<boolean> {
    const idx = await this.index();
    return idx.regions.some((r) => inBbox(r.bbox, lon, lat));
  }

  private async graphFor(idx: RoadsIndex, tiles: string[], core: boolean): Promise<{ g: RoadGraph; idx: SnapIndex }> {
    const region = idx.regions[0];
    const paths = [...tiles.sort().map((t) => `t/${t}.bin.gz`), ...(core ? [region.core] : [])];
    const key = `${idx.build}:${paths.join(',')}`;
    const hit = this.graphs.get(key);
    if (hit) return hit;
    const files = await Promise.all(paths.map((p) => this.file(idx.build, p)));
    const g = buildGraph(files);
    const entry = { g, idx: buildSnapIndex(g) };
    this.graphs.set(key, entry);
    while (this.graphs.size > MAX_GRAPHS) this.graphs.delete(this.graphs.keys().next().value as string);
    return entry;
  }

  /** Routes, best first, OSRM-shaped. Throws RoadEngineError. */
  async route(req: EngineRequest): Promise<OsrmLikeRoute[]> {
    const idx = await this.index();
    const region = idx.regions.find((r) => req.points.every((p) => inBbox(r.bbox, p.lon, p.lat)));
    if (!region) throw new RoadEngineError('Routing is not available here yet', 'not-covered');
    const have = new Set(region.tiles);
    const z = region.tileZ;
    const pts = req.points;
    const short = pts.every((p, i) => i === 0 || haversine([pts[i - 1].lon, pts[i - 1].lat], [p.lon, p.lat]) < SHORT_TRIP_M);

    let lastError: RoadEngineError = new RoadEngineError('No route found', 'no-route');
    for (const radius of RADII_M) {
      const tiles = new Set<string>();
      if (short) {
        for (let i = 1; i < pts.length; i++) for (const t of tilesAround([pts[i - 1], pts[i]], radius, z)) if (have.has(t)) tiles.add(t);
      } else {
        for (const p of pts) for (const t of tilesAround([p], radius, z)) if (have.has(t)) tiles.add(t);
      }
      const { g, idx: sIdx } = await this.graphFor(idx, [...tiles], !short || radius > RADII_M[0]);
      try {
        return this.search(g, sIdx, req);
      } catch (e) {
        if (!(e instanceof RoadEngineError) || e.code === 'not-covered') throw e;
        lastError = e;
      }
    }
    throw lastError;
  }

  private search(g: RoadGraph, sIdx: SnapIndex, req: EngineRequest): OsrmLikeRoute[] {
    const mode = req.mode;
    const usable = (e: number) => allowed(mode, g.access[e], 0) || allowed(mode, g.access[e], 1);
    // Only onto the connected road network, not a stray fragment (unless nothing else is near).
    const sizes = componentSizes(g, mode, usable);
    let biggest = 0;
    for (let e = 0; e < g.edgeCount; e++) if (sizes[e] > biggest) biggest = sizes[e];
    const minSize = Math.min(MIN_COMPONENT_EDGES, biggest);
    const connected = (e: number) => sizes[e] >= minSize;
    const snaps: Snap[] = req.points.map((p) => {
      const s = snap(g, sIdx, [p.lon, p.lat], connected, SNAP_MAX_M) ?? snap(g, sIdx, [p.lon, p.lat], usable, SNAP_MAX_M);
      if (!s) throw new RoadEngineError('No road near this point', 'no-road-nearby');
      return s;
    });
    const opt: SearchOptions = {
      mode,
      avoidTolls: req.avoid?.includes('tolls'),
      avoidMotorways: req.avoid?.includes('highways'),
      avoidFerries: req.avoid?.includes('ferries'),
    };
    const lang = req.language ?? 'en';

    // Legs end at stops; via points only split the search.
    const stops = req.points.map((p, i) => i === 0 || i === req.points.length - 1 || !p.via);
    if (req.points.length === 2) {
      const paths = findAlternatives(g, snaps[0], snaps[1], { ...opt, startBearingDeg: req.bearingDeg }, Math.max(0, req.alternatives ?? 0));
      if (!paths.length) throw new RoadEngineError('No route found', 'no-route');
      return paths.map((p) => buildRoute([buildLeg(g, mode, [p], lang)]));
    }
    const legs: ReturnType<typeof buildLeg>[] = [];
    let legPaths: RoadPath[] = [];
    for (let i = 1; i < snaps.length; i++) {
      const p = findPath(g, snaps[i - 1], snaps[i], { ...opt, startBearingDeg: i === 1 ? req.bearingDeg : undefined });
      if (!p) throw new RoadEngineError('No route found', 'no-route');
      legPaths.push(p);
      if (stops[i]) {
        legs.push(buildLeg(g, mode, legPaths, lang));
        legPaths = [];
      }
    }
    return [buildRoute(legs)];
  }
}

function inBbox([w, s, e, n]: [number, number, number, number], lon: number, lat: number): boolean {
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

/** Tile keys "x/y" covering the bounding box of the points, widened by `radiusM`. */
export function tilesAround(points: { lon: number; lat: number }[], radiusM: number, z: number): string[] {
  const lat0 = points.reduce((a, p) => a + p.lat, 0) / points.length;
  const dLat = radiusM / 110_540;
  const dLon = radiusM / (111_320 * Math.cos((lat0 * Math.PI) / 180));
  const w = Math.min(...points.map((p) => p.lon)) - dLon;
  const e = Math.max(...points.map((p) => p.lon)) + dLon;
  const s = Math.min(...points.map((p) => p.lat)) - dLat;
  const n = Math.max(...points.map((p) => p.lat)) + dLat;
  const [x0, y0] = tileOf(w, n, z);
  const [x1, y1] = tileOf(e, s, z);
  const out: string[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x}/${y}`);
  return out;
}
