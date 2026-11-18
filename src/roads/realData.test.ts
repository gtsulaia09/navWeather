// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RoadEngine } from './engine';

/**
 * Real Georgian roads (runs only after `npm run data:roads`): known trips must give sensible routes, times and
 * instructions, fast. Reference times: OSRM/Valhalla on the same roads.
 */
const root = 'public/data';
const built = existsSync(`${root}/roads.json`);

describe.skipIf(!built)('routing on real road files (Georgia)', () => {
  const engine = new RoadEngine({
    index: async () => JSON.parse(readFileSync(`${root}/roads.json`, 'utf8')),
    bytes: async (build, path) => new Uint8Array(readFileSync(`${root}/roads/${build}/${path}`)),
  });
  const verbose = !!process.env.ROADS_VERBOSE;
  const show = (name: string, routes: Awaited<ReturnType<RoadEngine['route']>>, ms: number) => {
    if (!verbose) return;
    console.log(`\n${name}: ${routes.length} route(s) in ${ms.toFixed(0)} ms`);
    for (const r of routes) console.log(`  ${(r.distance / 1000).toFixed(1)} km, ${(r.duration / 60).toFixed(0)} min, ${r.legs[0].steps.length} steps, via ${r.legs[0].summary}`);
    for (const s of routes[0].legs[0].steps.slice(0, 16)) {
      const m = s.maneuver;
      console.log(`   ${m.type}${m.modifier ? ' ' + m.modifier : ''}${m.exit ? ' exit ' + m.exit : ''} → ${s.name || s.ref || '(unnamed)'} ${Math.round(s.distance)} m${s.intersections[0].lanes ? ' [lanes]' : ''}`);
    }
  };
  const run = async (name: string, mode: 'drive' | 'walk' | 'bike', a: [number, number], b: [number, number]) => {
    const t0 = performance.now();
    const routes = await engine.route({ mode, points: [{ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] }], alternatives: 2, language: 'en' });
    show(name, routes, performance.now() - t0);
    return routes;
  };

  it('Tbilisi → Batumi by car: ~360 km, 4–6 h, over the main highway, with alternatives', async () => {
    const routes = await run('Tbilisi → Batumi', 'drive', [44.793, 41.7151], [41.6168, 41.6168]);
    const r = routes[0];
    expect(r.distance).toBeGreaterThan(330_000);
    expect(r.distance).toBeLessThan(420_000);
    expect(r.duration).toBeGreaterThan(4 * 3600);
    expect(r.duration).toBeLessThan(6.5 * 3600);
    expect(r.legs[0].summary).toMatch(/S1|S12|E60|E70/);
    expect(r.legs[0].steps[0].maneuver.type).toBe('depart');
    expect(r.legs[0].steps.at(-1)!.maneuver.type).toBe('arrive');
    expect(r.geometry.coordinates.length - 1).toBe(r.legs[0].annotation.distance.length);
  }, 60_000);

  it('across Tbilisi by car: a few km, minutes, turn instructions', async () => {
    const routes = await run('Rustaveli → Vake', 'drive', [44.799, 41.699], [44.748, 41.71]);
    const r = routes[0];
    expect(r.distance).toBeGreaterThan(4_000);
    expect(r.distance).toBeLessThan(12_000);
    expect(r.duration).toBeLessThan(40 * 60);
    expect(r.legs[0].steps.some((s) => s.maneuver.type === 'turn' || s.maneuver.type === 'roundabout' || s.maneuver.type === 'end of road')).toBe(true);
  }, 60_000);

  it('Kutaisi → Mestia by car through the mountains', async () => {
    const routes = await run('Kutaisi → Mestia', 'drive', [42.6946, 42.2679], [42.727, 43.045]);
    expect(routes[0].distance).toBeGreaterThan(150_000);
    expect(routes[0].duration).toBeGreaterThan(2.5 * 3600);
  }, 60_000);

  it('a walk in old Tbilisi and a bike ride', async () => {
    const walk = await run('Old Tbilisi walk', 'walk', [44.808, 41.69], [44.799, 41.699]);
    expect(walk[0].distance).toBeGreaterThan(900);
    expect(walk[0].duration / (walk[0].distance / 1000)).toBeGreaterThan(600); // ≈ 12 min per km on foot
    const bike = await run('Tbilisi bike', 'bike', [44.799, 41.699], [44.77, 41.725]);
    expect(bike[0].duration / (bike[0].distance / 1000)).toBeLessThan(400);
  }, 60_000);

  it('outside the region: not covered', async () => {
    await expect(engine.route({ mode: 'drive', points: [{ lon: 2.35, lat: 48.85 }, { lon: 2.29, lat: 48.86 }] })).rejects.toMatchObject({ code: 'not-covered' });
  });

  it('is fast once the files are loaded', async () => {
    const t0 = performance.now();
    await engine.route({ mode: 'drive', points: [{ lon: 44.793, lat: 41.7151 }, { lon: 41.6168, lat: 41.6168 }], alternatives: 2 });
    const ms = performance.now() - t0;
    if (verbose) console.log(`\nTbilisi → Batumi again: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1500);
  }, 60_000);
});
