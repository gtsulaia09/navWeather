import { afterEach, describe, expect, it, vi } from 'vitest';
import { aqiLevel, StaticAirQualityProvider } from '../services/air/AirQualityProvider';
import { airCell, europeanAqi, subIndex, trailingMean } from './air';

/** Air quality from our CAMS tiles (DP-4.6): the European AQI, the grid, the reader on the device. */

describe('the European Air Quality Index', () => {
  it('each band is 20 points, linear inside: the band edges land on the app’s levels', () => {
    expect(subIndex('pm2_5', 0)).toBe(0);
    expect(subIndex('pm2_5', 10)).toBe(20); // good | fair
    expect(subIndex('pm2_5', 15)).toBe(30);
    expect(subIndex('no2', 120)).toBe(60); // moderate | poor
    expect(subIndex('o3', 380)).toBe(100); // very poor | extremely poor
    expect(subIndex('so2', null)).toBeNull();
    expect(subIndex('pm10', -1)).toBeNull();
    expect(aqiLevel(subIndex('pm10', 45)!)).toBe('moderate');
  });

  it('the index is the worst pollutant; unknown only when nothing is known', () => {
    expect(europeanAqi({ pm2_5: 8, pm10: 15, no2: 100, o3: 60, so2: 5 })).toBe(47); // NO2 is the worst: 40 + 20 × 10/30
    expect(europeanAqi({ pm2_5: null, pm10: null, no2: null, o3: 30, so2: null })).toBe(12);
    expect(europeanAqi({ pm2_5: null, pm10: null, no2: null, o3: null, so2: null })).toBeNull();
  });

  it('particles count over the last 24 hours (what exists of them)', () => {
    const v = Float32Array.from({ length: 30 }, (_, i) => (i < 24 ? 10 : 70));
    expect(trailingMean(v, 0)).toBe(10);
    expect(trailingMean(v, 29)).toBe((18 * 10 + 6 * 70) / 24);
    expect(trailingMean(Float32Array.from([NaN, 4, NaN]), 2)).toBe(4);
    expect(trailingMean(Float32Array.from([NaN]), 0)).toBeNull();
  });

  it('a point → its 0.4° cell and 4° tile', () => {
    expect(airCell(41.6935, 44.8015)).toEqual({ row: 329, col: 562, ty: 32, tx: 56, i: 92 });
    expect(airCell(0, 180).col).toBe(0);
  });
});

describe('StaticAirQualityProvider (on the device, ADR-019)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reads the hour from our static tile; no tile or no data here is "not available", never borrowed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const hour = 1_791_190_800;
    vi.setSystemTime(hour * 1000 + 600_000);
    const cell = airCell(41.69, 44.8);
    const times = [hour - 3600, hour, hour + 3600];
    const tile = new Uint8Array(100 * times.length).fill(255);
    tile[cell.i * times.length + 1] = 27;
    const index = { v: 1, run: 'r1', createdAt: hour, referenceTime: hour - 7200, times, source: 'CAMS', tiles: [`${cell.ty}/${cell.tx}`] };
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      if (url === '/data/air/latest.json') return Response.json(index);
      if (url === `/data/air/runs/r1/t/${cell.ty}/${cell.tx}.bin`) return new Response(tile, { headers: { 'content-type': 'application/octet-stream' } });
      return new Response('not found', { status: 404 });
    });
    const air = new StaticAirQualityProvider('/data');
    expect(await air.current([44.8, 41.69])).toEqual({ europeanAqi: 27, observedAt: hour * 1000 });
    expect(await air.current([-150, 30])).toBeNull(); // a tile we don't build
    tile[cell.i * times.length + 1] = 255;
    expect(await new StaticAirQualityProvider('/data').current([44.8, 41.69])).toBeNull(); // no value this hour
    expect(asked.every((u) => u.startsWith('/data/'))).toBe(true); // nothing but our own static files
  });
});
