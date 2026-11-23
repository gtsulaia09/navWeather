import { apiPaths } from '../../api/v1';
import { cellsForBoxes, isFeedIndex, type FeedCell, type FeedIndex } from '../../reports/feedIndex';
import { MAX_BBOX_AREA, type PublicReport, type ReportKind, type Vote } from '../../reports/protocol';
import type { LngLat } from '../../types/geo';
import type { Route } from '../../types/route';
import { fetchJson, isAbortError, mapWithConcurrency, ProviderError } from '../http';
import type { Incident, IncidentProvider } from './IncidentProvider';

export type Bbox = [west: number, south: number, east: number, north: number];

/** How much a report of each kind matters to a driver (drives alert timing). */
const SEVERITY: Record<ReportKind, Incident['severity']> = {
  accident: 'high',
  closure: 'high',
  hazard: 'high',
  roadworks: 'medium',
  weather: 'medium',
};

/** Boxes per route; very long routes get larger boxes instead of more requests. */
const MAX_BOXES = 24;
/** ~130 km boxes (well inside the relay's area limit). */
const BASE_SPAN_DEG = 1.2;
/** Reports up to ~1 km beside the line are still fetched (snapping decides later). */
const PAD_DEG = 0.01;

/**
 * Cover a route with a few small boxes that follow the line (one box around
 * a long diagonal route would cover a huge empty area — and the relay caps
 * the area per request). Every vertex lies inside at least one box.
 */
export function routeBoxes(geometry: LngLat[], maxBoxes = MAX_BOXES): Bbox[] {
  if (!geometry.length) return [];
  const maxSpan = Math.sqrt(MAX_BBOX_AREA) - 2 * PAD_DEG - 0.01;
  for (let span = BASE_SPAN_DEG; ; span = Math.min(maxSpan, span * 1.5)) {
    const boxes = chunk(geometry, span);
    if (boxes.length <= maxBoxes || span >= maxSpan) return boxes;
  }
}

function chunk(geometry: LngLat[], span: number): Bbox[] {
  const boxes: Bbox[] = [];
  let [w, s] = geometry[0];
  let [e, n] = geometry[0];
  const close = () => boxes.push([round(w - PAD_DEG), round(s - PAD_DEG), round(e + PAD_DEG), round(n + PAD_DEG)]);
  for (let i = 1; i < geometry.length; i++) {
    const [x, y] = geometry[i];
    const nw = Math.min(w, x);
    const ne = Math.max(e, x);
    const ns = Math.min(s, y);
    const nn = Math.max(n, y);
    if (ne - nw > span || nn - ns > span) {
      close();
      // The next box starts at the previous vertex, so no stretch of road falls between boxes.
      const [px, py] = geometry[i - 1];
      w = Math.min(px, x);
      e = Math.max(px, x);
      s = Math.min(py, y);
      n = Math.max(py, y);
    } else {
      w = nw;
      e = ne;
      s = ns;
      n = nn;
    }
  }
  close();
  return boxes;
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** A relay report as a (never verified) incident; times moved onto this device's clock. */
export function reportToIncident(r: PublicReport, skewMs: number): Incident {
  return {
    id: `report:${r.id}`,
    reportId: r.id,
    kind: r.kind,
    coordinate: [r.lon, r.lat],
    severity: SEVERITY[r.kind] ?? 'medium',
    verified: false,
    source: 'reports',
    reportedAt: r.createdAt + skewMs,
    expiresAt: r.expiresAt + skewMs,
    confirmations: r.confirms,
  };
}

function isPublicReport(x: unknown): x is PublicReport {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.kind === 'string' &&
    Number.isFinite(r.lat) &&
    Number.isFinite(r.lon) &&
    Number.isFinite(r.createdAt) &&
    Number.isFinite(r.expiresAt) &&
    typeof r.confirms === 'number'
  );
}

export interface ReportsOptions {
  /** Static feed base URL (ADR-020); '' = no feed, read the Worker list. */
  feedUrl?: string;
  /** Nostr relays for overflow writes when the Worker is busy; [] = no overflow. */
  relays?: string[];
  timeoutMs?: number;
}

/** How long a feed index is trusted before it is fetched again (the feed is rebuilt every ~10 minutes). */
const INDEX_TTL_MS = 2 * 60_000;

/**
 * DRIVER REPORTS (ADR-020). Reads come from the static feed (files, free and unlimited) — or, where no feed is
 * configured or reachable, from the app's own Worker list (`/api/v1/reports`). Writes go to the Worker; when it is
 * busy (Free-plan daily limit) or unreachable they go to public Nostr relays as signed events with proof of work,
 * and reach everyone through the next feed build. Reports made or answered on this phone show here at once.
 * Reports are unverified: the route engine labels them "reported", never as fact.
 */
export class ReportsIncidentProvider implements IncidentProvider {
  readonly name = 'reports';
  private feedUrl: string;
  private relays: string[];
  private timeoutMs: number;
  private index: { at: number; value: FeedIndex | null } | null = null;
  /** Reports sent from this phone, until the feed carries them (memory only). */
  private mine = new Map<string, PublicReport>();
  /** Reports this phone answered "gone" — hidden here at once. */
  private gone = new Set<string>();
  /** Where each listed report came from, so a vote goes the same way. */
  private source = new Map<string, 'n'>();

  constructor(
    private baseUrl: string = apiPaths.reports,
    opts: ReportsOptions | number = {},
  ) {
    const o = typeof opts === 'number' ? { timeoutMs: opts } : opts;
    this.feedUrl = (o.feedUrl ?? '').replace(/\/+$/, '');
    this.relays = o.relays ?? [];
    this.timeoutMs = o.timeoutMs ?? 10_000;
  }

  private get base() {
    return this.baseUrl.replace(/\/$/, '');
  }

  async getIncidents(route: Route, signal?: AbortSignal): Promise<Incident[]> {
    const boxes = routeBoxes(route.geometry);
    const fromFeed = this.feedUrl ? await this.readFeed(boxes, signal) : null;
    const listed = fromFeed ?? (await this.readWorker(boxes, signal));
    const now = Date.now();
    for (const [id, r] of this.mine) if (r.expiresAt <= now) this.mine.delete(id);
    const byId = new Map<string, Incident>();
    for (const inc of listed) if (!this.gone.has(inc.reportId ?? '')) byId.set(inc.id, inc);
    for (const r of this.mine.values()) {
      if (inBoxes(r, boxes) && !this.gone.has(r.id) && !byId.has(`report:${r.id}`)) byId.set(`report:${r.id}`, reportToIncident(r, 0));
    }
    return [...byId.values()];
  }

  /** The feed's reports in these boxes; null when there is no usable feed (then the Worker answers). */
  private async readFeed(boxes: Bbox[], signal?: AbortSignal): Promise<Incident[] | null> {
    const index = await this.feedIndex(signal);
    if (!index) return null;
    const have = new Set(index.cells);
    const cells = cellsForBoxes(boxes).filter((c) => have.has(c));
    let skew = 0;
    let failures = 0;
    const lists = await mapWithConcurrency(cells, 4, async (cell) => {
      try {
        const res = await fetch(`${this.feedUrl}/builds/${index.build}/${cell}.json`, { signal });
        if (!res.ok) throw new Error(String(res.status));
        const date = Date.parse(res.headers.get('date') ?? '');
        if (Number.isFinite(date)) skew = Date.now() - date;
        const body = (await res.json()) as FeedCell;
        return Array.isArray(body?.reports) ? body.reports.filter(isPublicReport) : [];
      } catch (e) {
        if (isAbortError(e)) throw e;
        failures++;
        return [];
      }
    });
    // A build replaced meanwhile (old files gone): fetch the index again next time, use the Worker now.
    if (cells.length && failures === cells.length) {
      this.index = null;
      return null;
    }
    return lists
      .flat()
      .filter((r) => inBoxes(r, boxes))
      .map((r) => {
        if (r.src === 'n') this.source.set(r.id, 'n');
        return reportToIncident(r, skew);
      });
  }

  private async feedIndex(signal?: AbortSignal): Promise<FeedIndex | null> {
    if (this.index && Date.now() - this.index.at < INDEX_TTL_MS) return this.index.value;
    let value: FeedIndex | null = null;
    try {
      const res = await fetch(`${this.feedUrl}/index.json`, { signal, cache: 'no-cache' });
      // A dev server answers unknown paths with the app page: not a feed.
      const body = res.ok && (res.headers.get('content-type') ?? '').includes('json') ? ((await res.json()) as unknown) : null;
      // A feed older than an hour is not trusted (the builder stopped): the Worker answers instead.
      value = isFeedIndex(body) && Date.now() - body.generatedAt < 3_600_000 ? body : null;
    } catch (e) {
      if (isAbortError(e)) throw e;
    }
    this.index = { at: Date.now(), value };
    return value;
  }

  private async readWorker(boxes: Bbox[], signal?: AbortSignal): Promise<Incident[]> {
    let failures = 0;
    let lastError: unknown = null;
    const lists = await mapWithConcurrency(boxes, 3, async (b) => {
      try {
        const data = await fetchJson<{ reports?: unknown[]; now?: number }>(`${this.base}?bbox=${b.join(',')}`, {
          provider: 'Driver reports',
          signal,
          timeoutMs: this.timeoutMs,
        });
        if (!data || !Array.isArray(data.reports)) throw new ProviderError('Unexpected reports response', 'invalid-response', 'Driver reports');
        const skew = typeof data.now === 'number' && Number.isFinite(data.now) ? Date.now() - data.now : 0;
        return data.reports.filter(isPublicReport).map((r) => reportToIncident(r, skew));
      } catch (e) {
        if (isAbortError(e)) throw e;
        failures++;
        lastError = e;
        return [];
      }
    });
    // Some boxes answering is still useful; none answering means the service is down.
    if (boxes.length && failures === boxes.length) throw lastError;
    return lists.flat();
  }

  async report(kind: ReportKind, [lon, lat]: LngLat, signal?: AbortSignal): Promise<{ id: string; expiresAt: number }> {
    let out: { id: string; expiresAt: number };
    try {
      const res = await fetchJson<{ id?: unknown; expiresAt?: unknown }>(this.base, {
        provider: 'Driver reports',
        signal,
        timeoutMs: this.timeoutMs,
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, lat, lon }) },
      });
      if (typeof res?.id !== 'string' || typeof res.expiresAt !== 'number') {
        throw new ProviderError('Unexpected reports response', 'invalid-response', 'Driver reports');
      }
      out = { id: res.id, expiresAt: res.expiresAt };
    } catch (e) {
      if (!this.overflowAllowed(e)) throw e;
      try {
        const { publishOverflowReport } = await import('../../reports/overflow');
        out = await publishOverflowReport(kind, lat, lon, { relays: this.relays, signal });
      } catch (e2) {
        if (isAbortError(e2)) throw e2;
        throw e; // say what the Worker said
      }
      this.source.set(out.id, 'n');
    }
    const now = Date.now();
    this.mine.set(out.id, { id: out.id, kind, lat, lon, createdAt: now, expiresAt: out.expiresAt, confirms: 0, denies: 0 });
    return out;
  }

  async vote(reportId: string, vote: Vote, signal?: AbortSignal): Promise<{ active: boolean }> {
    if (vote === 'gone') this.gone.add(reportId);
    const viaRelays = async () => {
      const { publishOverflowVote } = await import('../../reports/overflow');
      await publishOverflowVote(reportId, vote, { relays: this.relays, signal });
      return { active: vote !== 'gone' };
    };
    if (this.source.get(reportId) === 'n' && this.relays.length) return viaRelays();
    try {
      const res = await fetchJson<{ active?: unknown }>(`${this.base}/${encodeURIComponent(reportId)}/vote`, {
        provider: 'Driver reports',
        signal,
        timeoutMs: this.timeoutMs,
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vote }) },
      });
      return { active: res?.active !== false };
    } catch (e) {
      if (!this.overflowAllowed(e)) throw e;
      return viaRelays();
    }
  }

  /** The Worker is busy (daily limit), failing or unreachable, and relays are configured. */
  private overflowAllowed(e: unknown): boolean {
    if (!this.relays.length || isAbortError(e)) return false;
    if (!(e instanceof ProviderError)) return true;
    if (e.kind === 'rate-limited' || e.kind === 'network' || e.kind === 'timeout') return true;
    return e.kind === 'http' && (e.status ?? 0) >= 500;
  }
}

function inBoxes(r: Pick<PublicReport, 'lat' | 'lon'>, boxes: Bbox[]): boolean {
  return boxes.some(([w, s, e, n]) => r.lon >= w && r.lon <= e && r.lat >= s && r.lat <= n);
}

export type ReportFailure = 'offline' | 'busy' | 'unavailable' | 'gone' | 'refused';

/** What went wrong, in terms the driver can act on. */
export function reportFailure(e: unknown): ReportFailure {
  if (e instanceof ProviderError) {
    if (e.kind === 'network' || e.kind === 'timeout') return 'offline';
    if (e.kind === 'rate-limited') return 'busy';
    if (e.kind === 'http' && e.status === 404) return 'gone';
    if (e.kind === 'http' && e.status === 409) return 'refused';
  }
  return 'unavailable';
}
