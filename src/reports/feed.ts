/**
 * The static driver-reports feed (ADR-020): who reads it, how it is laid out and how it is built. Pure data rules
 * (no DOM, no Workers APIs) shared by the app, the feed builder (`pipelines/reports/build.mjs`) and tests.
 *
 * Layout of a feed (static files, rebuilt every ~10 minutes):
 *   <base>/index.json                 { v: 1, build, generatedAt, cells: ["41_44", …] }
 *   <base>/builds/<build>/<cell>.json { v: 1, generatedAt, reports: PublicReport[] }   cell = "<floor lat>_<floor lon>"
 *
 * Sources merged into one list: reports the Worker holds, and overflow reports and votes published as Nostr events
 * when the Worker was busy (signed, with proof of work).
 */
import { committedPow, tagValue, type EventTemplate, type NostrEvent } from '../p2p/nostr.ts';
import { approxDistanceM, applyVote, DEDUPE_M, REPORT_TTL_MIN, sanitizeReport, type PublicReport, type ReportKind, type Vote } from './protocol.ts';

/** Nostr kind of an overflow report or vote (regular: relays store it until its NIP-40 expiry). */
export const REPORT_EVENT_KIND = 4207;
export const REPORT_EVENT_TAG = 'navweather-report-v1';
/** NIP-13 proof of work every overflow report and vote carries (~65,000 hashes: < 1 s on a phone). */
export const REPORT_POW_BITS = 16;
/** Per pseudonymous key and day, as the Worker allows per client. */
export const MAX_REPORTS_PER_KEY_PER_DAY = 30;
/** How far back the builder reads relays: the longest report lifetime, three times over. */
export const FEED_LOOKBACK_S = 3 * 12 * 3600;

export const cellOf = (lat: number, lon: number): string => `${Math.floor(lat)}_${Math.floor(lon)}`;

/** Cells (1°×1°) a set of boxes touches. */
export function cellsForBoxes(boxes: [number, number, number, number][]): string[] {
  const out = new Set<string>();
  for (const [w, s, e, n] of boxes) {
    for (let lat = Math.floor(s); lat <= Math.floor(n); lat++) for (let lon = Math.floor(w); lon <= Math.floor(e); lon++) out.add(`${lat}_${lon}`);
  }
  return [...out];
}

/** Quarter-degree area tag ("g") so relays — and the builder — can filter by area without parsing content. */
export function areaTag(lat: number, lon: number): string {
  return `${Math.floor(lat * 4)}_${Math.floor(lon * 4)}`;
}

export interface FeedIndex {
  v: 1;
  build: string;
  generatedAt: number;
  cells: string[];
}

export interface FeedCell {
  v: 1;
  generatedAt: number;
  reports: PublicReport[];
}

export function isFeedIndex(x: unknown): x is FeedIndex {
  const o = x as FeedIndex;
  return !!o && o.v === 1 && typeof o.build === 'string' && /^[\w-]{1,40}$/.test(o.build) && Number.isFinite(o.generatedAt) && Array.isArray(o.cells);
}

/** The Nostr event of an overflow report (to be signed with proof of work). */
export function reportEventTemplate(kind: ReportKind, lat: number, lon: number, nowMs: number): EventTemplate {
  const input = sanitizeReport({ kind, lat, lon });
  if (!input) throw new Error('bad report');
  const created_at = Math.floor(nowMs / 1000);
  return {
    kind: REPORT_EVENT_KIND,
    created_at,
    tags: [
      ['t', REPORT_EVENT_TAG],
      ['g', areaTag(input.lat, input.lon)],
      ['expiration', String(created_at + REPORT_TTL_MIN[input.kind] * 60 * 3)],
    ],
    content: JSON.stringify(input),
  };
}

/** The Nostr event of an overflow vote on a report (from the feed or the Worker). */
export function voteEventTemplate(reportId: string, vote: Vote, nowMs: number): EventTemplate {
  const created_at = Math.floor(nowMs / 1000);
  return {
    kind: REPORT_EVENT_KIND,
    created_at,
    tags: [
      ['t', REPORT_EVENT_TAG],
      ['r', reportId],
      ['expiration', String(created_at + 36 * 3600)],
    ],
    content: JSON.stringify({ vote }),
  };
}

/** Report id of an overflow report: the start of its event id (same shape as the Worker's ids). */
export const reportIdFromEvent = (eventId: string): string => eventId.slice(0, 16);

/**
 * Merge Worker reports and verified Nostr events into the active reports at `nowMs` — the same rules as the Worker
 * (worker/reports.ts): a second report of the same kind within 150 m is a confirmation; one vote per key per report;
 * a reporter cannot vote on their own report; at most 30 reports per key per day; proof of work required.
 * Events must already be signature-verified (RelayPool does that).
 */
export function mergeFeed(workerReports: PublicReport[], events: NostrEvent[], nowMs: number): PublicReport[] {
  const reports = new Map<string, PublicReport & { reporter?: string }>();
  for (const r of workerReports) if (r.expiresAt > nowMs) reports.set(r.id, { ...r });
  const voters = new Map<string, Set<string>>();
  const perKey = new Map<string, number>();
  const nowS = nowMs / 1000;

  const valid = events
    .filter((e) => e.kind === REPORT_EVENT_KIND && tagValue(e, 't') === REPORT_EVENT_TAG && committedPow(e) >= 16)
    .filter((e) => e.created_at <= nowS + 120 && e.created_at >= nowS - FEED_LOOKBACK_S)
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));

  for (const e of valid) {
    let body: unknown;
    try {
      body = JSON.parse(e.content);
    } catch {
      continue;
    }
    const at = e.created_at * 1000;
    const target = tagValue(e, 'r');
    if (target) {
      const vote = (body as { vote?: unknown })?.vote;
      const r = reports.get(target);
      if (!r || (vote !== 'still' && vote !== 'gone') || r.expiresAt <= at || r.reporter === e.pubkey) continue;
      const seen = voters.get(target) ?? new Set<string>();
      if (seen.has(e.pubkey)) continue;
      seen.add(e.pubkey);
      voters.set(target, seen);
      Object.assign(r, applyVote(r, vote, at));
      continue;
    }
    const input = sanitizeReport(body);
    if (!input) continue;
    const day = `${e.pubkey}|${Math.floor(e.created_at / 86400)}`;
    const count = perKey.get(day) ?? 0;
    if (count >= MAX_REPORTS_PER_KEY_PER_DAY) continue;
    perKey.set(day, count + 1);
    const near = [...reports.values()].find(
      (r) => r.kind === input.kind && r.expiresAt > at && approxDistanceM(r.lat, r.lon, input.lat, input.lon) <= DEDUPE_M,
    );
    if (near) {
      const seen = voters.get(near.id) ?? new Set<string>();
      if (near.reporter !== e.pubkey && !seen.has(e.pubkey)) {
        seen.add(e.pubkey);
        voters.set(near.id, seen);
        Object.assign(near, applyVote(near, 'still', at));
      }
      continue;
    }
    const id = reportIdFromEvent(e.id);
    reports.set(id, {
      id,
      kind: input.kind,
      lat: input.lat,
      lon: input.lon,
      createdAt: at,
      expiresAt: at + REPORT_TTL_MIN[input.kind] * 60_000,
      confirms: 0,
      denies: 0,
      src: 'n',
      reporter: e.pubkey,
    });
  }

  return [...reports.values()]
    .filter((r) => r.expiresAt > nowMs)
    .map(({ reporter: _reporter, ...r }) => r)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Group active reports by cell for the feed files. */
export function splitByCell(reports: PublicReport[]): Map<string, PublicReport[]> {
  const out = new Map<string, PublicReport[]>();
  for (const r of reports) {
    const c = cellOf(r.lat, r.lon);
    const list = out.get(c) ?? [];
    list.push(r);
    out.set(c, list);
  }
  return out;
}
