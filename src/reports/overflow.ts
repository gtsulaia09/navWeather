/**
 * Overflow path for driver reports (ADR-020): when our free Worker is busy or unreachable, a report or a vote is
 * published as a signed Nostr event with proof of work to 3 public relays picked by area. The feed builder reads
 * them back and merges them with the Worker's reports.
 *
 * Privacy: each phone signs with a random key that it replaces every UTC day (so per-key daily caps work without a
 * lasting identity); events carry only kind, a position rounded to ~1 m (as the Worker stores) and an expiry.
 */
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { minePow, newSecretKey, RelayPool, relaysFor, resolveRelayUrl, type WebSocketFactory } from '../p2p/nostr.ts';
import { deviceStorage } from '../platform/storage.ts';
import { areaTag, REPORT_POW_BITS, reportEventTemplate, reportIdFromEvent, voteEventTemplate } from './feed.ts';
import { REPORT_TTL_MIN, type ReportKind, type Vote } from './protocol.ts';

const KEY_STORAGE = 'navweather.reporterKey.v1';

/** Today's signing key (rotated every UTC day; kept on this device only). */
export function reporterKey(nowMs = Date.now()): Uint8Array {
  const day = String(Math.floor(nowMs / 86_400_000));
  try {
    const raw = deviceStorage().getItem(KEY_STORAGE);
    if (raw?.startsWith(`${day}:`)) return hexToBytes(raw.slice(day.length + 1));
  } catch {
    /* storage blocked: a fresh key per call still works */
  }
  const sk = newSecretKey();
  try {
    deviceStorage().setItem(KEY_STORAGE, `${day}:${bytesToHex(sk)}`);
  } catch {
    /* ignore */
  }
  return sk;
}

export interface OverflowOptions {
  relays: string[];
  factory?: WebSocketFactory;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function publishTo(key: string, opts: OverflowOptions, build: () => Promise<Parameters<RelayPool['publish']>[0]>): Promise<string> {
  if (!opts.relays.length) throw new Error('no-relays');
  const pool = new RelayPool(relaysFor(key, opts.relays.map((r) => resolveRelayUrl(r)), 3), opts.factory);
  try {
    const e = await build();
    const accepted = await pool.publish(e, opts.timeoutMs ?? 8000);
    if (!accepted) throw new Error('relays-unreachable');
    return e.id;
  } finally {
    pool.close();
  }
}

export async function publishOverflowReport(kind: ReportKind, lat: number, lon: number, opts: OverflowOptions): Promise<{ id: string; expiresAt: number }> {
  const now = Date.now();
  const template = reportEventTemplate(kind, lat, lon, now);
  const eventId = await publishTo(areaTag(lat, lon), opts, () => minePow(template, reporterKey(now), REPORT_POW_BITS, opts.signal));
  return { id: reportIdFromEvent(eventId), expiresAt: now + REPORT_TTL_MIN[kind] * 60_000 };
}

export async function publishOverflowVote(reportId: string, vote: Vote, opts: OverflowOptions): Promise<void> {
  const now = Date.now();
  await publishTo(reportId, opts, () => minePow(voteEventTemplate(reportId, vote, now), reporterKey(now), REPORT_POW_BITS, opts.signal));
}
