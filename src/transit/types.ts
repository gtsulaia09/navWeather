import type { BBox } from '../types/geo';
import type { TransitVehicle } from '../types/route';

/** Manifest at `/data/transit.json`. */
export interface TransitManifest {
  version: number;
  build: string;
  builtAt: string;
  regions: TransitRegionMeta[];
}

export interface TransitRegionMeta {
  id: string;
  name: string;
  tz: string;
  bbox: BBox;
  file: string;
  stops: number;
  routes: number;
  patterns: number;
  trips: number;
  sources: string[];
}

/** Compact JSON payload stored in `<region>.json.gz`. */
export interface RawTransitBundle {
  v: number;
  tz: string;
  /** [lat, lon, name] */
  stops: [number, number, string][];
  routes: {
    l: string;
    v: TransitVehicle;
    a: string;
    c?: string;
    tc?: string;
  }[];
  patterns: {
    /** Route index into `routes`. */
    r: number;
    /** Headsign. */
    h: string;
    /** Ordered stop indices. */
    s: number[];
    /** Minutes from first stop departure to each stop. */
    o: number[];
    /** Flat [startMin, serviceMask, startMin, serviceMask, ...] sorted by startMin. */
    t: number[];
  }[];
  /** Per-stop flat footpaths: [neighborStopIdx, distM, ...]. */
  transfers: number[][];
}

/** Indexed in-memory network ready for fast RAPTOR queries. */
export interface TransitNetwork {
  bundle: RawTransitBundle;
  /** For each stop, list of (patternIdx, posInPattern) serving that stop. */
  stopPatterns: [number, number][][];
}
