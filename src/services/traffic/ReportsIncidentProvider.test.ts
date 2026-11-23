import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BBOX_AREA, type PublicReport } from '../../reports/protocol';
import { tbilisiBatumiRoute } from '../../test/helpers';
import type { LngLat } from '../../types/geo';
import { reportFailure, reportToIncident, ReportsIncidentProvider, routeBoxes, type Bbox } from './ReportsIncidentProvider';

const route = tbilisiBatumiRoute();

const inside = (b: Bbox, [x, y]: LngLat) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
const area = (b: Bbox) => (b[2] - b[0]) * (b[3] - b[1]);

function report(p: Partial<PublicReport> & Pick<PublicReport, 'id'>): PublicReport {
  return { kind: 'accident', lat: 42.0, lon: 43.5, createdAt: 1_000, expiresAt: 3_601_000, confirms: 0, denies: 0, ...p };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('route boxes for report lookups', () => {
  it('covers every vertex of the road with a few small boxes', () => {
    const boxes = routeBoxes(route.geometry);
    expect(boxes.length).toBeGreaterThanOrEqual(2); // Tbilisi → Batumi is ~3° wide
    expect(boxes.length).toBeLessThanOrEqual(6);
    for (const b of boxes) expect(area(b)).toBeLessThan(MAX_BBOX_AREA);
    for (const c of route.geometry) expect(boxes.some((b) => inside(b, c))).toBe(true);
  });

  it('a very long route gets larger boxes, never more than the cap or the relay limit', () => {
    // ~3 900 km zig-zag line
    const line: LngLat[] = Array.from({ length: 2000 }, (_, i) => [10 + i * 0.02, 40 + (i % 50) * 0.01 + i * 0.005]);
    const boxes = routeBoxes(line);
    expect(boxes.length).toBeLessThanOrEqual(24);
    for (const b of boxes) expect(area(b)).toBeLessThan(MAX_BBOX_AREA);
    for (const c of line) expect(boxes.some((b) => inside(b, c))).toBe(true);
  });

  it('a short trip is one box', () => {
    expect(routeBoxes([[44.8, 41.7], [44.81, 41.71]])).toHaveLength(1);
    expect(routeBoxes([])).toEqual([]);
  });
});

describe('driver reports → incidents', () => {
  it('are unverified, keep the relay id and confirmations, and move onto the local clock', () => {
    const inc = reportToIncident(report({ id: 'abcdefghijklmnop', kind: 'roadworks', confirms: 2 }), 500);
    expect(inc).toMatchObject({
      id: 'report:abcdefghijklmnop',
      reportId: 'abcdefghijklmnop',
      kind: 'roadworks',
      coordinate: [43.5, 42.0],
      verified: false,
      severity: 'medium',
      confirmations: 2,
      reportedAt: 1_500,
      expiresAt: 3_601_500,
    });
    expect(reportToIncident(report({ id: 'x'.repeat(16) }), 0).severity).toBe('high');
  });

  it('fetches every box, corrects clock skew and drops duplicates and malformed rows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        // The relay's clock is 2 s behind this device.
        return jsonResponse({ reports: [report({ id: 'aaaaaaaaaaaaaaaa' }), { id: 'broken' }], now: 8_000 });
      }),
    );
    const list = await new ReportsIncidentProvider('/api/reports').getIncidents(route);
    expect(urls.length).toBe(routeBoxes(route.geometry).length);
    expect(urls[0]).toMatch(/^\/api\/reports\?bbox=-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
    expect(list).toHaveLength(1);
    expect(list[0].reportedAt).toBe(3_000);
  });

  it('some boxes failing still returns the rest; all failing is an error (service down)', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (n++ === 0 ? new Response('<html>', { status: 502 }) : jsonResponse({ reports: [report({ id: `r${n}`.padEnd(16, 'x') })], now: Date.now() }))),
    );
    const list = await new ReportsIncidentProvider().getIncidents(route);
    expect(list.length).toBe(routeBoxes(route.geometry).length - 1);

    // A static host answers /api/* with the app's HTML page.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    await expect(new ReportsIncidentProvider().getIncidents(route)).rejects.toBeTruthy();
  });

  it('sends a report with just the kind and position', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ id: 'bbbbbbbbbbbbbbbb', expiresAt: 99 }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const res = await new ReportsIncidentProvider('/api/reports/').report('hazard', [44.8, 41.7]);
    expect(res).toEqual({ id: 'bbbbbbbbbbbbbbbb', expiresAt: 99 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/reports');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ kind: 'hazard', lat: 41.7, lon: 44.8 });
  });

  it('answers "still there?"', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ confirms: 0, denies: 2, expiresAt: 1, active: false }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await new ReportsIncidentProvider().vote('cccccccccccccccc', 'gone')).toEqual({ active: false });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/reports/cccccccccccccccc/vote');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ vote: 'gone' });
  });

  it('explains failures in terms a driver can act on', async () => {
    const p = new ReportsIncidentProvider();
    const failWith = async (res: Response | Error) => {
      vi.stubGlobal('fetch', vi.fn(async () => (res instanceof Error ? Promise.reject(res) : res)));
      return reportFailure(await p.report('accident', [44.8, 41.7]).catch((e) => e));
    };
    expect(await failWith(new TypeError('Failed to fetch'))).toBe('offline');
    expect(await failWith(jsonResponse({ error: 'too-many-requests' }, 429))).toBe('busy');
    expect(await failWith(new Response('<html>', { status: 200 }))).toBe('unavailable');
    expect(await failWith(jsonResponse({ error: 'unavailable' }, 503))).toBe('unavailable');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'own-report' }, 409)));
    expect(reportFailure(await p.vote('dddddddddddddddd', 'still').catch((e) => e))).toBe('refused');
  });
});

describe('static feed and overflow (ADR-020)', () => {
  const feedIndex = (generatedAt = Date.now()) => ({ v: 1, build: 'b1', generatedAt, cells: ['41_44', '41_43', '42_43', '41_41', '41_42'] });

  it('reads the static feed instead of the Worker and keeps only reports along the route', async () => {
    const along = report({ id: 'feed000000000001', lat: route.geometry[10][1], lon: route.geometry[10][0], expiresAt: Date.now() + 600_000 });
    const far = report({ id: 'feed000000000002', lat: 41.0, lon: 41.0, expiresAt: Date.now() + 600_000 });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/index.json')) return jsonResponse(feedIndex());
      if (url.includes('/builds/b1/')) return jsonResponse({ v: 1, generatedAt: Date.now(), reports: [along, far] });
      return jsonResponse({ reports: [] });
    }));
    const p = new ReportsIncidentProvider('/api/v1/reports', { feedUrl: 'https://feed.example' });
    const list = await p.getIncidents(route);
    expect(list.map((i) => i.reportId)).toEqual(['feed000000000001']);
    expect(calls.some((u) => u.startsWith('/api/v1/reports'))).toBe(false);
  });

  it('falls back to the Worker when the feed is missing or stale', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/index.json')) return jsonResponse(feedIndex(Date.now() - 2 * 3_600_000));
      return jsonResponse({ reports: [], now: Date.now() });
    }));
    const p = new ReportsIncidentProvider('/api/v1/reports', { feedUrl: 'https://feed.example' });
    await p.getIncidents(route);
    expect(calls.some((u) => u.startsWith('/api/v1/reports?bbox='))).toBe(true);
  });

  it('publishes to relays when the Worker is busy, and shows the report here at once', async () => {
    vi.resetModules();
    vi.doMock('../../reports/overflow', () => ({
      publishOverflowReport: vi.fn(async () => ({ id: 'abcdef0123456789', expiresAt: Date.now() + 3_600_000 })),
      publishOverflowVote: vi.fn(async () => undefined),
    }));
    const mod = await import('./ReportsIncidentProvider');
    const overflow = await import('../../reports/overflow');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? jsonResponse({ error: 'busy' }, 429) : jsonResponse({ reports: [], now: Date.now() }))));
    const p = new mod.ReportsIncidentProvider('/api/v1/reports', { relays: ['wss://r1', 'wss://r2'] });
    const at = route.geometry[20];
    expect(await p.report('hazard', at)).toMatchObject({ id: 'abcdef0123456789' });
    expect(overflow.publishOverflowReport).toHaveBeenCalledWith('hazard', at[1], at[0], expect.objectContaining({ relays: ['wss://r1', 'wss://r2'] }));
    expect((await p.getIncidents(route)).map((i) => i.reportId)).toContain('abcdef0123456789');
    // A vote on an overflow report goes to the relays too, not to the Worker.
    await p.vote('abcdef0123456789', 'gone');
    expect(overflow.publishOverflowVote).toHaveBeenCalledWith('abcdef0123456789', 'gone', expect.anything());
    expect((await p.getIncidents(route)).map((i) => i.reportId)).not.toContain('abcdef0123456789');
    vi.doUnmock('../../reports/overflow');
  });

  it('does not overflow without relays, or when the Worker refuses the request itself', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'busy' }, 429)));
    await expect(new ReportsIncidentProvider('/api/v1/reports').report('hazard', route.geometry[0])).rejects.toMatchObject({ kind: 'rate-limited' });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad-request' }, 400)));
    await expect(new ReportsIncidentProvider('/api/v1/reports', { relays: ['wss://r'] }).report('hazard', route.geometry[0])).rejects.toMatchObject({ status: 400 });
  });
});
