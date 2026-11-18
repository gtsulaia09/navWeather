// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RoadEngine, tilesAround } from './engine';
import { ACCESS, ATTR, CLASS, decodeRoadFile, encodeRoadFile, TILE_Z, type RoadFileInput, type RoadsIndex } from './format';

/**
 * The device router on a small made-up network (ADR-019), so every rule is checked without the real road files:
 *
 *        D (44.81, 41.71)
 *       /   \
 *  A — B  →  C          A(44.80,41.70) B(44.81,41.70) C(44.82,41.70)
 *
 *  A–B, B–D, D–C two-way residential; B → C one-way.
 */
const A = { lon: 44.8, lat: 41.7 };
const C = { lon: 44.82, lat: 41.7 };
const all = ACCESS.carFwd | ACCESS.carBwd | ACCESS.bikeFwd | ACCESS.bikeBwd | ACCESS.foot;
const oneway = ACCESS.carFwd | ACCESS.bikeFwd | ACCESS.foot;

function network(restrict: boolean): RoadFileInput {
  return {
    header: { kind: 'tile', region: 'test', build: 'b1', z: TILE_Z },
    nodes: [
      { gid: 1, lon: 44.8, lat: 41.7, flags: 0 },
      { gid: 2, lon: 44.81, lat: 41.7, flags: 0 },
      { gid: 3, lon: 44.82, lat: 41.7, flags: 0 },
      { gid: 4, lon: 44.81, lat: 41.71, flags: 0 },
    ],
    ways: [
      { id: 10, name: 'ა ქუჩა', nameEn: 'First Street' },
      { id: 11, name: 'Oneway', ref: 'ს 1' },
      { id: 12, name: 'North Road' },
      { id: 13, name: 'East Road' },
    ],
    edges: [
      { a: 0, b: 1, way: 0, lenM: 830, carKmh: 30, access: all, cls: CLASS.residential, attr: 0, signals: 0, geom: [] },
      { a: 1, b: 2, way: 1, lenM: 830, carKmh: 30, access: oneway, cls: CLASS.residential, attr: 0, signals: 0, geom: [] },
      { a: 1, b: 3, way: 2, lenM: 1110, carKmh: 30, access: all, cls: CLASS.residential, attr: ATTR.toll, signals: 0, geom: [[44.81, 41.705]] },
      { a: 3, b: 2, way: 3, lenM: 1400, carKmh: 30, access: all, cls: CLASS.residential, attr: 0, signals: 0, geom: [] },
    ],
    restrictions: restrict ? [{ from: 0, via: 1, to: 1, only: false }] : [],
  };
}

function engineFor(restrict = false) {
  const bytes = encodeRoadFile(network(restrict));
  const tiles = tilesAround([A, C], 20_000, TILE_Z);
  const index: RoadsIndex = {
    version: 1,
    build: 'b1',
    regions: [{ id: 'test', name: 'Test', bbox: [44.7, 41.6, 44.9, 41.8], core: 'core.bin.gz', tileZ: TILE_Z, tiles }],
    source: 'test',
    dataDate: '2026-11-18',
  };
  return new RoadEngine({ index: async () => index, bytes: async () => bytes });
}

const route = (e: RoadEngine, from: typeof A, to: typeof A, mode: 'drive' | 'walk' = 'drive', avoid?: ('tolls' | 'highways' | 'ferries')[]) =>
  e.route({ mode, points: [from, to], language: 'en', ...(avoid ? { avoid } : {}) });

describe('road files', () => {
  it('encode and decode to the same network', () => {
    const f = decodeRoadFile(encodeRoadFile(network(true)));
    expect([...f.nodeGid]).toEqual([1, 2, 3, 4]);
    expect(f.nodeLon[2]).toBeCloseTo(44.82, 5);
    expect([...f.edgeA]).toEqual([0, 1, 1, 3]);
    expect(f.edgeLen[2]).toBeCloseTo(1110, 1);
    expect(f.edgeAccess[1]).toBe(oneway);
    expect(f.strings[f.wayNameEn[0]]).toBe('First Street');
    expect([...f.geom.slice(f.geomStart[2], f.geomStart[3])].map((v) => +v.toFixed(5))).toEqual([44.81, 41.705]);
    expect([...f.resFrom, ...f.resVia, ...f.resTo, ...f.resKind]).toEqual([0, 1, 1, 0]);
  });
});

describe('routing on the device', () => {
  it('drives the one-way street the right way, with depart and arrive and a geometry the timings fit', async () => {
    const [r] = await route(engineFor(), A, C);
    expect(r.distance).toBeCloseTo(1660, -1);
    const steps = r.legs[0].steps;
    expect(steps[0].maneuver.type).toBe('depart');
    expect(steps.at(-1)!.maneuver.type).toBe('arrive');
    expect(r.legs[0].annotation.distance).toHaveLength(r.geometry.coordinates.length - 1);
    // Names in the reader's language: English where OSM has it, Georgian written in Latin letters, road numbers as S1.
    expect(steps[0].name).toBe('First Street');
    expect(steps.some((s) => s.ref === 'S1')).toBe(true);
  });

  it('never against a one-way street by car — round the block instead; on foot straight back', async () => {
    const [car] = await route(engineFor(), C, A);
    expect(car.distance).toBeGreaterThan(3000); // C → D → B → A
    const [walk] = await route(engineFor(), C, A, 'walk');
    expect(walk.distance).toBeCloseTo(1660, -1);
  });

  it('keeps to turn restrictions (no straight on from First Street into the one-way at B)', async () => {
    const [r] = await route(engineFor(true), A, C);
    expect(r.distance).toBeGreaterThan(3000); // A → B → D → C
  });

  it('avoids tolls when asked — and says there is no road when that leaves none', async () => {
    await expect(route(engineFor(true), A, C, 'drive', ['tolls'])).rejects.toMatchObject({ code: 'no-route' });
  });

  it('outside the regions we build: not covered (the app says "not available here yet")', async () => {
    await expect(route(engineFor(), { lon: 2.35, lat: 48.85 }, { lon: 2.36, lat: 48.86 })).rejects.toMatchObject({ code: 'not-covered' });
  });
});
