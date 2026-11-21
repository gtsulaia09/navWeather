// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — ws ships no types; only its client is used here
import WebSocket from 'ws';
// @ts-expect-error — plain ESM script without types
import { startRelay } from '../../scripts/nostr-relay.mjs';
import type { WebSocketFactory } from '../p2p/nostr';
import { mergeSnapshot, newShareId, PeerSender, PeerViewer, roomFor, seal, unseal, type PeerOptions } from './peer';
import { SHARE_ID_RE, type ShareSnapshot } from './protocol';
import { FakePC } from '../test/fakeRtc';

const factory: WebSocketFactory = (url) => new WebSocket(url) as never;

const snap = (over: Partial<ShareSnapshot> = {}): ShareSnapshot => ({
  v: 1,
  name: 'Gio',
  pos: { c: [44.8, 41.7], t: Date.now() },
  trip: { dest: { name: 'Batumi', c: [41.6, 41.6] }, routeId: 'r1', route: [[44.8, 41.7], [41.6, 41.6]] },
  sim: false,
  startedAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  updatedAt: Date.now(),
  ...over,
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(20);
  return cond();
}

describe('room crypto', () => {
  it('derives the same room from the id and opens only its own messages', async () => {
    const a = await roomFor('abc');
    const b = await roomFor('abc');
    const other = await roomFor('xyz');
    expect(a.tag).toBe(b.tag);
    expect(a.tag).not.toContain('abc');
    const sealed = await seal(a.key, { t: 'hello' });
    expect(await unseal(b.key, sealed)).toEqual({ t: 'hello' });
    expect(await unseal(other.key, sealed)).toBeNull();
    expect(SHARE_ID_RE.test(newShareId())).toBe(true);
  });

  it('keeps the route from the previous snapshot while the id is unchanged', () => {
    const first = snap();
    const next = snap({ trip: { ...first.trip!, route: undefined } });
    expect(mergeSnapshot(first, next).trip?.route).toEqual(first.trip?.route);
    expect(mergeSnapshot(first, snap({ trip: { dest: first.trip!.dest, routeId: 'r2' } })).trip?.route).toBeUndefined();
  });
});

describe('phone to phone over a relay', () => {
  let relay: { close(): Promise<void> };
  const port = 18_000 + Math.floor(Math.random() * 1000);
  const opts = (): PeerOptions => ({ relays: [`ws://127.0.0.1:${port}`], factory, createPeer: () => new FakePC() as never, iceWaitMs: 10, helloEveryMs: 150, relayAfterMs: 300 });
  beforeAll(() => {
    relay = startRelay({ port, quiet: true });
  });
  afterAll(async () => {
    await relay.close();
  });

  it('connects directly, sends the route once and ends the share', async () => {
    FakePC.failing = false;
    const id = newShareId();
    const sender = new PeerSender(id, opts());
    expect(await sender.start()).toBe(1);
    const got: { s: ShareSnapshot; via: string }[] = [];
    let ended = false;
    const viewer = new PeerViewer(id, opts(), { onSnapshot: (s, via) => got.push({ s, via }), onEnded: () => (ended = true) });
    await viewer.start();
    expect(await until(() => sender.viewers === 1)).toBe(true);
    sender.update(snap());
    sender.update(snap({ pos: { c: [44.7, 41.7], t: Date.now() } }));
    expect(await until(() => got.length >= 2)).toBe(true);
    expect(got.every((g) => g.via === 'direct')).toBe(true);
    expect(got[0].s.trip?.route).toHaveLength(2);
    expect(got.at(-1)!.s.trip?.route).toBeUndefined();
    expect(mergeSnapshot(got[0].s, got.at(-1)!.s).trip?.route).toHaveLength(2);
    await sender.end();
    expect(await until(() => ended)).toBe(true);
    viewer.close();
  });

  it('falls back to relay snapshots when no direct connection can be made', async () => {
    FakePC.failing = true;
    const id = newShareId();
    const sender = new PeerSender(id, opts());
    await sender.start();
    const got: string[] = [];
    const viewer = new PeerViewer(id, opts(), { onSnapshot: (_s, via) => got.push(via), onEnded: () => {} });
    await viewer.start();
    sender.update(snap());
    expect(await until(() => got.includes('relay'), 4000)).toBe(true);
    expect(viewer.direct).toBe(false);
    sender.close();
    viewer.close();
    FakePC.failing = false;
  });

  it('a stranger with another id hears nothing', async () => {
    const sender = new PeerSender(newShareId(), opts());
    await sender.start();
    const got: unknown[] = [];
    const stranger = new PeerViewer(newShareId(), opts(), { onSnapshot: (s) => got.push(s), onEnded: () => {} });
    await stranger.start();
    sender.update(snap());
    await wait(500);
    expect(got).toEqual([]);
    expect(sender.viewers).toBe(0);
    sender.close();
    stranger.close();
  });
});
