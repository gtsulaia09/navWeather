// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — ws ships no types; only its client is used here
import WebSocket from 'ws';
// @ts-expect-error — plain ESM script without types
import { startRelay } from '../../scripts/nostr-relay.mjs';
import {
  committedPow,
  finalizeEvent,
  matchFilter,
  minePow,
  newSecretKey,
  parseRelayList,
  powBits,
  publicKeyHex,
  RelayPool,
  relaysFor,
  verifyEvent,
  type NostrEvent,
  type WebSocketFactory,
} from './nostr';

const factory: WebSocketFactory = (url) => new WebSocket(url) as never;

describe('events', () => {
  it('signs and verifies; any change breaks the signature', () => {
    const sk = newSecretKey();
    const e = finalizeEvent({ kind: 1, tags: [['t', 'x']], content: 'hi' }, sk);
    expect(e.pubkey).toBe(publicKeyHex(sk));
    expect(verifyEvent(e)).toBe(true);
    expect(verifyEvent({ ...e, content: 'hi!' })).toBe(false);
    expect(verifyEvent({ ...e, tags: [] })).toBe(false);
    expect(verifyEvent(null)).toBe(false);
  });

  it('counts leading zero bits and mines proof of work', async () => {
    expect(powBits('000f' + 'f'.repeat(60))).toBe(12);
    expect(powBits('8' + '0'.repeat(63))).toBe(0);
    expect(powBits('1' + '0'.repeat(63))).toBe(3);
    const e = await minePow({ kind: 4207, tags: [['t', 'r']], content: '{}' }, newSecretKey(), 10);
    expect(verifyEvent(e)).toBe(true);
    expect(powBits(e.id)).toBeGreaterThanOrEqual(10);
    expect(committedPow(e)).toBe(10);
  });

  it('matches filters by kind, time and tags', () => {
    const e = finalizeEvent({ kind: 7, tags: [['t', 'room'], ['g', 'abc']], content: '', created_at: 100 }, newSecretKey());
    expect(matchFilter({ kinds: [7], '#t': ['room'] }, e)).toBe(true);
    expect(matchFilter({ kinds: [8] }, e)).toBe(false);
    expect(matchFilter({ '#t': ['other'] }, e)).toBe(false);
    expect(matchFilter({ since: 101 }, e)).toBe(false);
  });

  it('spreads keys over relays deterministically', () => {
    const all = ['wss://a', 'wss://b', 'wss://c', 'wss://d', 'wss://e'];
    expect(relaysFor('room1', all)).toEqual(relaysFor('room1', all));
    expect(relaysFor('room1', all)).toHaveLength(3);
    const firsts = new Set(Array.from({ length: 40 }, (_, i) => relaysFor(`k${i}`, all)[0]));
    expect(firsts.size).toBeGreaterThan(2);
    expect(parseRelayList('wss://a, ws://b  nope /nostr')).toEqual(['wss://a', 'ws://b', '/nostr']);
  });
});

describe('RelayPool against the local relay', () => {
  let relay: { close(): Promise<void> };
  const port = 17_000 + Math.floor(Math.random() * 1000);
  beforeAll(() => {
    relay = startRelay({ port, quiet: true });
  });
  afterAll(async () => {
    await relay.close();
  });

  it('delivers a published event to a subscriber and stores regular kinds', async () => {
    const url = `ws://127.0.0.1:${port}`;
    const a = new RelayPool([url], factory);
    const b = new RelayPool([url], factory);
    const got: NostrEvent[] = [];
    b.subscribe([{ kinds: [24133], '#t': ['room'] }], (e) => got.push(e));
    await new Promise((r) => setTimeout(r, 150));
    const e = finalizeEvent({ kind: 24133, tags: [['t', 'room']], content: 'live' }, newSecretKey());
    expect(await a.publish(e)).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(got.map((x) => x.id)).toEqual([e.id]);

    // A regular event is stored and comes back to a later subscriber; an ephemeral one does not.
    const stored = finalizeEvent({ kind: 4207, tags: [['t', 'feed']], content: 'r' }, newSecretKey());
    await a.publish(stored);
    const later: NostrEvent[] = [];
    const c = new RelayPool([url], factory);
    c.subscribe([{ kinds: [4207, 24133] }], (x) => later.push(x));
    await new Promise((r) => setTimeout(r, 200));
    expect(later.map((x) => x.id)).toEqual([stored.id]);
    a.close();
    b.close();
    c.close();
  });

  it('reports 0 when no relay answers', async () => {
    const pool = new RelayPool(['ws://127.0.0.1:1'], factory);
    expect(await pool.publish(finalizeEvent({ kind: 1, tags: [], content: '' }, newSecretKey()), 300)).toBe(0);
    pool.close();
  });
});
