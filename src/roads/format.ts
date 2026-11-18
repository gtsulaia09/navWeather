/**
 * Our static road files (ADR-019): the road graph the device routes on, built from OpenStreetMap by
 * `pipelines/roads/build.mjs` and read by `src/roads/graph.ts`. Platform-neutral TypeScript with erasable syntax only,
 * so the Node pipeline imports this same file (node --experimental-strip-types).
 *
 * Two kinds of file per region, both gzip-compressed binary:
 *   - `core`: the main roads (motorway…tertiary and links) of the whole region, cut only where main roads meet, with
 *     simplified geometry — used for the middle of long trips;
 *   - `tile`: every routable road of one slippy-map tile (zoom `TILE_Z`), full geometry — used near the start and the
 *     end of a trip, and for short trips.
 *
 * Layout (all integers are LEB128 varints; `s` = zigzag-signed; columns, not rows, so gzip finds the repetition):
 *   "NWR" + version byte · header (JSON) ·
 *   nodes: count, s gid deltas (OSM node ids, ascending), s lon deltas, s lat deltas (1e-5°), flags ·
 *   strings: count, (byte length, UTF-8)… (index 0 = none) ·
 *   ways: count, s OSM way id deltas (ascending), then per column a string index: name, name:en, name:ru, ref,
 *         destination, turn:lanes forward, turn:lanes backward ·
 *   edges: count, a, b (node indices), way index, length (dm), car km/h (0 = no cars), access bits, class, attribute
 *          bits, traffic signals inside, interior point count; then all interior points as s deltas (lon, lat) from
 *          the edge's first node ·
 *   restrictions: count, from way, via node, to way, kind (0 = no_*, 1 = only_*).
 */

export const FORMAT_VERSION = 1;
/** Street tiles' zoom (≈ 15 km wide at 42° N). */
export const TILE_Z = 11;
/** Coordinates are stored in 1e-5° (≈ 1.1 m). */
export const COORD_SCALE = 1e5;

/** Road class codes (OSM `highway`, `_link` folded into the class with ATTR.link). */
export const CLASS = {
  motorway: 0,
  trunk: 1,
  primary: 2,
  secondary: 3,
  tertiary: 4,
  unclassified: 5,
  residential: 6,
  living_street: 7,
  service: 8,
  track: 9,
  path: 10,
  footway: 11,
  cycleway: 12,
  pedestrian: 13,
  steps: 14,
  bridleway: 15,
  ferry: 16,
  road: 17,
} as const;
export type RoadClass = keyof typeof CLASS;
export const CLASS_NAMES = Object.keys(CLASS) as RoadClass[];
/** Classes in the main-roads (core) file. */
export const CORE_MAX_CLASS = CLASS.tertiary;

export const ACCESS = { carFwd: 1, carBwd: 2, bikeFwd: 4, bikeBwd: 8, foot: 16 } as const;
export const ATTR = { toll: 1, ferry: 2, roundabout: 4, link: 8, tunnel: 16, bridge: 32 } as const;
export const NODE_FLAG = { signals: 1 } as const;

export interface RoadFileHeader {
  kind: 'core' | 'tile';
  /** Region id, e.g. "ge". */
  region: string;
  /** Build id (the folder name), e.g. "2026-11-18". */
  build: string;
  z?: number;
  x?: number;
  y?: number;
}

/** A decoded road file: columns of typed arrays. */
export interface RoadFile {
  header: RoadFileHeader;
  nodeGid: Float64Array;
  nodeLon: Float64Array;
  nodeLat: Float64Array;
  nodeFlags: Uint8Array;
  strings: string[];
  wayId: Float64Array;
  /** String indices per way (0 = none). */
  wayName: Uint32Array;
  wayNameEn: Uint32Array;
  wayNameRu: Uint32Array;
  wayRef: Uint32Array;
  wayDest: Uint32Array;
  wayLanesFwd: Uint32Array;
  wayLanesBwd: Uint32Array;
  edgeA: Uint32Array;
  edgeB: Uint32Array;
  edgeWay: Uint32Array;
  /** Metres. */
  edgeLen: Float64Array;
  edgeCarKmh: Uint16Array;
  edgeAccess: Uint8Array;
  edgeClass: Uint8Array;
  edgeAttr: Uint8Array;
  edgeSignals: Uint8Array;
  /** Interior points of edge i: geom[geomStart[i] … geomStart[i+1]) as lon, lat pairs (degrees). */
  geomStart: Uint32Array;
  geom: Float64Array;
  resFrom: Uint32Array;
  resVia: Uint32Array;
  resTo: Uint32Array;
  resKind: Uint8Array;
}

/** What the pipeline hands to `encodeRoadFile` (plain arrays). */
export interface RoadFileInput {
  header: RoadFileHeader;
  nodes: { gid: number; lon: number; lat: number; flags: number }[];
  ways: { id: number; name?: string; nameEn?: string; nameRu?: string; ref?: string; dest?: string; lanesFwd?: string; lanesBwd?: string }[];
  edges: {
    a: number;
    b: number;
    way: number;
    lenM: number;
    carKmh: number;
    access: number;
    cls: number;
    attr: number;
    signals: number;
    /** Interior points [lon, lat]. */
    geom: [number, number][];
  }[];
  restrictions: { from: number; via: number; to: number; only: boolean }[];
}

class Writer {
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b: number) {
    this.ensure(1);
    this.buf[this.len++] = b;
  }
  varint(v: number) {
    if (!(v >= 0) || !Number.isFinite(v)) throw new Error(`varint out of range: ${v}`);
    this.ensure(10);
    let n = Math.floor(v);
    while (n >= 0x80) {
      this.buf[this.len++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    this.buf[this.len++] = n;
  }
  svarint(v: number) {
    const n = Math.round(v);
    this.varint(n >= 0 ? n * 2 : -n * 2 - 1);
  }
  bytes(b: Uint8Array) {
    this.varint(b.length);
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

class Reader {
  pos = 0;
  private readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  byte(): number {
    return this.buf[this.pos++];
  }
  varint(): number {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = this.buf[this.pos++];
      if (b === undefined) throw new Error('road file truncated');
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
  }
  svarint(): number {
    const n = this.varint();
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  }
  bytes(): Uint8Array {
    const n = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const q = (deg: number) => Math.round(deg * COORD_SCALE);

export function encodeRoadFile(input: RoadFileInput): Uint8Array {
  const w = new Writer();
  for (const c of 'NWR') w.byte(c.charCodeAt(0));
  w.byte(FORMAT_VERSION);
  w.bytes(enc.encode(JSON.stringify(input.header)));

  const nodes = input.nodes;
  w.varint(nodes.length);
  let prev = 0;
  for (const n of nodes) {
    if (n.gid < prev) throw new Error('nodes must be sorted by gid');
    w.svarint(n.gid - prev);
    prev = n.gid;
  }
  prev = 0;
  for (const n of nodes) {
    w.svarint(q(n.lon) - prev);
    prev = q(n.lon);
  }
  prev = 0;
  for (const n of nodes) {
    w.svarint(q(n.lat) - prev);
    prev = q(n.lat);
  }
  for (const n of nodes) w.varint(n.flags);

  const strings: string[] = [''];
  const stringIndex = new Map<string, number>([['', 0]]);
  const str = (s: string | undefined) => {
    if (!s) return 0;
    let i = stringIndex.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      stringIndex.set(s, i);
    }
    return i;
  };
  const cols = (['name', 'nameEn', 'nameRu', 'ref', 'dest', 'lanesFwd', 'lanesBwd'] as const).map((k) => input.ways.map((wy) => str(wy[k])));
  w.varint(strings.length - 1);
  for (let i = 1; i < strings.length; i++) w.bytes(enc.encode(strings[i]));

  w.varint(input.ways.length);
  prev = 0;
  for (const wy of input.ways) {
    if (wy.id < prev) throw new Error('ways must be sorted by id');
    w.svarint(wy.id - prev);
    prev = wy.id;
  }
  for (const col of cols) for (const v of col) w.varint(v);

  const edges = input.edges;
  w.varint(edges.length);
  for (const e of edges) w.varint(e.a);
  for (const e of edges) w.varint(e.b);
  for (const e of edges) w.varint(e.way);
  for (const e of edges) w.varint(Math.max(0, Math.round(e.lenM * 10)));
  for (const e of edges) w.varint(e.carKmh);
  for (const e of edges) w.varint(e.access);
  for (const e of edges) w.varint(e.cls);
  for (const e of edges) w.varint(e.attr);
  for (const e of edges) w.varint(Math.min(255, e.signals));
  for (const e of edges) w.varint(e.geom.length);
  for (const e of edges) {
    let plon = q(nodes[e.a].lon);
    let plat = q(nodes[e.a].lat);
    for (const [lon, lat] of e.geom) {
      w.svarint(q(lon) - plon);
      w.svarint(q(lat) - plat);
      plon = q(lon);
      plat = q(lat);
    }
  }

  const rs = input.restrictions;
  w.varint(rs.length);
  for (const r of rs) w.varint(r.from);
  for (const r of rs) w.varint(r.via);
  for (const r of rs) w.varint(r.to);
  for (const r of rs) w.varint(r.only ? 1 : 0);
  return w.result();
}

export function decodeRoadFile(bytes: Uint8Array): RoadFile {
  const r = new Reader(bytes);
  const magic = String.fromCharCode(r.byte(), r.byte(), r.byte());
  const version = r.byte();
  if (magic !== 'NWR' || version !== FORMAT_VERSION) throw new Error(`not a road file (version ${version})`);
  const header = JSON.parse(dec.decode(r.bytes())) as RoadFileHeader;

  const n = r.varint();
  const nodeGid = new Float64Array(n);
  const nodeLon = new Float64Array(n);
  const nodeLat = new Float64Array(n);
  const nodeFlags = new Uint8Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) nodeGid[i] = acc += r.svarint();
  acc = 0;
  for (let i = 0; i < n; i++) nodeLon[i] = (acc += r.svarint()) / COORD_SCALE;
  acc = 0;
  for (let i = 0; i < n; i++) nodeLat[i] = (acc += r.svarint()) / COORD_SCALE;
  for (let i = 0; i < n; i++) nodeFlags[i] = r.varint();

  const sc = r.varint();
  const strings = [''];
  for (let i = 0; i < sc; i++) strings.push(dec.decode(r.bytes()));

  const wc = r.varint();
  const wayId = new Float64Array(wc);
  acc = 0;
  for (let i = 0; i < wc; i++) wayId[i] = acc += r.svarint();
  const col = () => {
    const a = new Uint32Array(wc);
    for (let i = 0; i < wc; i++) a[i] = r.varint();
    return a;
  };
  const wayName = col();
  const wayNameEn = col();
  const wayNameRu = col();
  const wayRef = col();
  const wayDest = col();
  const wayLanesFwd = col();
  const wayLanesBwd = col();

  const m = r.varint();
  const u32 = () => {
    const a = new Uint32Array(m);
    for (let i = 0; i < m; i++) a[i] = r.varint();
    return a;
  };
  const edgeA = u32();
  const edgeB = u32();
  const edgeWay = u32();
  const edgeLen = new Float64Array(m);
  for (let i = 0; i < m; i++) edgeLen[i] = r.varint() / 10;
  const edgeCarKmh = new Uint16Array(m);
  for (let i = 0; i < m; i++) edgeCarKmh[i] = r.varint();
  const u8 = () => {
    const a = new Uint8Array(m);
    for (let i = 0; i < m; i++) a[i] = r.varint();
    return a;
  };
  const edgeAccess = u8();
  const edgeClass = u8();
  const edgeAttr = u8();
  const edgeSignals = u8();
  const geomStart = new Uint32Array(m + 1);
  for (let i = 0; i < m; i++) geomStart[i + 1] = geomStart[i] + r.varint() * 2;
  const geom = new Float64Array(geomStart[m]);
  for (let i = 0; i < m; i++) {
    let lon = Math.round(nodeLon[edgeA[i]] * COORD_SCALE);
    let lat = Math.round(nodeLat[edgeA[i]] * COORD_SCALE);
    for (let k = geomStart[i]; k < geomStart[i + 1]; k += 2) {
      lon += r.svarint();
      lat += r.svarint();
      geom[k] = lon / COORD_SCALE;
      geom[k + 1] = lat / COORD_SCALE;
    }
  }

  const rc = r.varint();
  const ru32 = () => {
    const a = new Uint32Array(rc);
    for (let i = 0; i < rc; i++) a[i] = r.varint();
    return a;
  };
  const resFrom = ru32();
  const resVia = ru32();
  const resTo = ru32();
  const resKind = new Uint8Array(rc);
  for (let i = 0; i < rc; i++) resKind[i] = r.varint();

  return {
    header,
    nodeGid,
    nodeLon,
    nodeLat,
    nodeFlags,
    strings,
    wayId,
    wayName,
    wayNameEn,
    wayNameRu,
    wayRef,
    wayDest,
    wayLanesFwd,
    wayLanesBwd,
    edgeA,
    edgeB,
    edgeWay,
    edgeLen,
    edgeCarKmh,
    edgeAccess,
    edgeClass,
    edgeAttr,
    edgeSignals,
    geomStart,
    geom,
    resFrom,
    resVia,
    resTo,
    resKind,
  };
}

/** The region index (`/data/roads.json`): which build is current and which tiles exist. */
export interface RoadsIndex {
  version: number;
  build: string;
  /** Files of this build live under `/data/roads/<build>/`. */
  regions: {
    id: string;
    name: string;
    /** [west, south, east, north] of the roads in the region. */
    bbox: [number, number, number, number];
    core: string;
    tileZ: number;
    /** "x/y" of every tile that has roads. */
    tiles: string[];
  }[];
  source: string;
  dataDate: string;
}

/** Slippy-map tile of a point. */
export function tileOf(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const y = Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)));
  return [x, y];
}

/** Bounds [west, south, east, north] of a slippy-map tile. */
export function tileBounds(x: number, y: number, z: number): [number, number, number, number] {
  const n = 2 ** z;
  const lon = (xx: number) => (xx / n) * 360 - 180;
  const lat = (yy: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}
