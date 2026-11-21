import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPackProtocol } from './packProtocol';
import { encodePack, packMembers, packOf, packPath, readPackDirectory, tileRange } from './packs';

afterEach(() => vi.unstubAllGlobals());

describe('basemap packs', () => {
  it('finds the pack of a tile in each band', () => {
    expect(packOf(0, 0, 0)).toEqual({ rz: 0, rx: 0, ry: 0 });
    expect(packOf(3, 7, 5)).toEqual({ rz: 0, rx: 0, ry: 0 });
    expect(packOf(6, 40, 23)).toEqual({ rz: 4, rx: 10, ry: 5 });
    expect(packOf(14, 10_080, 6_050)).toEqual({ rz: 11, rx: 1260, ry: 756 });
    expect(packOf(15, 0, 0)).toBeNull();
    expect(packMembers(7, 1, 1)).toHaveLength(1 + 4 + 16 + 64);
    expect(packMembers(0, 0, 0)).toHaveLength(1 + 4 + 16 + 64);
    expect(packMembers(4, 0, 0)).toHaveLength(1 + 4 + 16);
  });

  it('covers Georgia with the expected tiles', () => {
    const r = tileRange([39.9, 40.95, 46.8, 43.7], 7);
    expect(r).toEqual({ x0: 78, x1: 80, y0: 46, y1: 48 });
  });

  it('round-trips a pack', () => {
    const tiles = [
      { z: 7, x: 79, y: 46, data: new Uint8Array([1, 2, 3]) },
      { z: 8, x: 158, y: 92, data: new Uint8Array([9]) },
    ];
    const buf = encodePack(tiles).buffer as ArrayBuffer;
    const dir = readPackDirectory(buf);
    const [off, len] = dir.get('8/158/92')!;
    expect(Array.from(new Uint8Array(buf, off, len))).toEqual([9]);
    expect(() => readPackDirectory(new ArrayBuffer(4))).toThrow();
  });
});

describe('navpack protocol', () => {
  const index = { v: 1, build: 'm1', source: 's', regions: [[39.9, 40.95, 46.8, 43.7]], packs: { '7': ['79/46'] }, langs: ['en', 'ru'] };
  const mvt = new Uint8Array([0x1a, 0x02, 0x08, 0x01]);
  const pack = encodePack([{ z: 8, x: 158, y: 92, data: gzipSync(mvt) }]);
  const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });

  function stub(withIndex: boolean) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === '/b/index.json') return withIndex ? json(index) : new Response('<html>', { headers: { 'content-type': 'text/html' } });
        if (url === `/b/${packPath("m1", 7, 79, 46)}`) return new Response(pack as BodyInit);
        if (url === '/b/m1/style-dark-ru.json') return json({ version: 8, name: 'ours' });
        if (url === 'https://fallback/dark') return json({ version: 8, name: 'fallback' });
        return new Response('nope', { status: 404 });
      }),
    );
    return calls;
  }
  const ctrl = () => new AbortController();

  it('serves styles and tiles from our packs; empty tiles outside them, without a request', async () => {
    const calls = stub(true);
    const load = createPackProtocol({ baseUrl: '/b/', fallbackStyle: (t) => `https://fallback/${t}` });
    expect((await load({ url: 'navpack://style/dark/ru', type: 'json' }, ctrl())).data).toEqual({ version: 8, name: 'ours' });
    const t = (await load({ url: 'navpack://tiles/8/158/92' }, ctrl())).data as ArrayBuffer;
    expect(Array.from(new Uint8Array(t))).toEqual(Array.from(mvt));
    // Another tile of the same pack: no second download.
    await load({ url: 'navpack://tiles/9/317/185' }, ctrl());
    expect(calls.filter((u) => u.endsWith('.pack'))).toHaveLength(1);
    // Outside every pack (open sea at zoom 7+): empty, and nothing fetched.
    const before = calls.length;
    expect(((await load({ url: 'navpack://tiles/9/0/0' }, ctrl())).data as ArrayBuffer).byteLength).toBe(0);
    expect(calls.length).toBe(before);
  });

  it('falls back to the other style when no basemap is deployed', async () => {
    stub(false);
    const load = createPackProtocol({ baseUrl: '/b', fallbackStyle: (t) => `https://fallback/${t}` });
    expect((await load({ url: 'navpack://style/dark/en', type: 'json' }, ctrl())).data).toEqual({ version: 8, name: 'fallback' });
  });
});
