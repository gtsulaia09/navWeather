import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gunzip } from '../utils/gzip';
import { indexTransitNetwork, planTransit } from './raptor';
import type { RawTransitBundle, TransitManifest } from './types';
import type { Place } from '../types/geo';

const place = (id: string, name: string, lon: number, lat: number): Place => ({
  id,
  name,
  label: name,
  coordinate: [lon, lat],
});

describe('on-device RAPTOR transit router', () => {
  const sampleBundle: RawTransitBundle = {
    v: 1,
    tz: 'Asia/Tbilisi',
    stops: [
      [41.6938, 44.8015, 'Freedom Square'],
      [41.7030, 44.7890, 'Rustaveli'],
      [41.7100, 44.7750, 'Vake Park'],
      [41.7105, 44.7755, 'Vake Transfer'],
      [41.7200, 44.7600, 'Saburtalo'],
    ],
    routes: [
      { l: '301', v: 'bus', a: 'TTC', c: '#0b57d0', tc: '#ffffff' },
      { l: 'M1', v: 'subway', a: 'TTC', c: '#d93025', tc: '#ffffff' },
    ],
    patterns: [
      {
        r: 0,
        h: 'Vake Park',
        s: [0, 1, 2],
        o: [0, 8, 16],
        t: [
          8 * 60, 0x7f,
          8 * 60 + 15, 0x7f,
          8 * 60 + 30, 0x7f,
        ],
      },
      {
        r: 1,
        h: 'Saburtalo',
        s: [3, 4],
        o: [0, 10],
        t: [
          8 * 60 + 20, 0x7f,
          8 * 60 + 35, 0x7f,
          8 * 60 + 50, 0x7f,
        ],
      },
    ],
    transfers: [[], [], [3, 70], [2, 70], []],
  };

  it('plans a direct bus trip with multiple upcoming departures', () => {
    const net = indexTransitNetwork(sampleBundle);
    // 2026-11-24 07:50 Asia/Tbilisi (UTC+4 = 03:50Z)
    const departAtMs = Date.UTC(2026, 10, 24, 3, 50, 0);
    const routes = planTransit(net, place('a', 'Start', 44.8014, 41.6937), place('b', 'End', 44.7751, 41.7101), departAtMs);
    expect(routes.length).toBeGreaterThanOrEqual(2);
    const first = routes[0];
    expect(first.transit).toBeDefined();
    expect(first.transit!.transfers).toBe(0);
    expect(first.transit!.legs.map((l) => l.vehicle)).toEqual(['walk', 'bus', 'walk']);
    expect(first.transit!.legs[1].line).toBe('301');
    expect(first.transit!.legs[1].stops).toBe(2);
    expect(first.geometry.length).toBeGreaterThanOrEqual(3);
  });

  it('plans a 1-transfer trip across footpath edges', () => {
    const net = indexTransitNetwork(sampleBundle);
    const departAtMs = Date.UTC(2026, 10, 24, 3, 50, 0);
    const routes = planTransit(net, place('a', 'Start', 44.8014, 41.6937), place('b', 'Saburtalo', 44.7601, 41.7201), departAtMs);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    const first = routes[0];
    expect(first.transit!.transfers).toBe(1);
    const rideLines = first.transit!.legs.filter((l) => l.vehicle !== 'walk').map((l) => l.line);
    expect(rideLines).toEqual(['301', 'M1']);
  });

  it('wraps late-night queries to the next morning schedule instead of returning empty', () => {
    const net = indexTransitNetwork(sampleBundle);
    // 01:40 Asia/Tbilisi (UTC+4 = 21:40Z prev day)
    const departAtMs = Date.UTC(2026, 10, 23, 21, 40, 0);
    const routes = planTransit(net, place('a', 'Start', 44.8014, 41.6937), place('b', 'End', 44.7751, 41.7101), departAtMs);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(routes[0].transit!.departMs).toBeGreaterThan(departAtMs);
  });

  const manifestPath = join(process.cwd(), 'public/data/transit.json');
  const itReal = existsSync(manifestPath) ? it : it.skip;

  itReal('routes real Tbilisi (Freedom Square -> Ateni St) and Georgia (Tbilisi -> Batumi) GTFS data fast', async () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TransitManifest;
    const region = manifest.regions[0];
    const raw = await gunzip(new Uint8Array(readFileSync(join(process.cwd(), 'public/data', region.file))));
    const net = indexTransitNetwork(JSON.parse(new TextDecoder().decode(raw)) as RawTransitBundle);

    // 10:00 Asia/Tbilisi on a Tuesday
    const departAtMs = Date.UTC(2026, 10, 24, 6, 0, 0);

    const t0 = performance.now();
    const city = planTransit(
      net,
      place('o', 'Freedom Square', 44.8015, 41.6934),
      place('d', 'Ateni 16a', 44.7705, 41.7095),
      departAtMs,
    );
    const elapsedMs = performance.now() - t0;
    expect(city.length).toBeGreaterThanOrEqual(1);
    expect(elapsedMs).toBeLessThan(250);
    expect(city[0].transit!.legs.some((l) => l.vehicle !== 'walk')).toBe(true);

    const rail = planTransit(
      net,
      place('t', 'Tbilisi Central', 44.7995, 41.7209),
      place('b', 'Batumi', 41.6669, 41.6606),
      departAtMs,
    );
    expect(rail.length).toBeGreaterThanOrEqual(1);
    expect(rail[0].transit!.legs.some((l) => l.vehicle === 'rail')).toBe(true);
  });
});
