import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — plain ESM script without types
import { startRelay } from '../../scripts/nostr-relay.mjs';
import { rememberFix } from '../services/location';
import { useAppStore } from '../state/store';
import { FakePC } from '../test/fakeRtc';
import { __isPeerShare, __resetLiveShare, useLiveShare } from './liveShare';
import { mergeSnapshot, PeerViewer } from './peer';
import { setPeerOptions } from './peerConfig';
import type { ShareSnapshot } from './protocol';

/** ADR-020: the Worker relay is busy → the share runs phone to phone, same link shape, nothing lost. */
describe('sharing when the Worker is busy', () => {
  let relay: { close(): Promise<void> };
  const port = 19_000 + Math.floor(Math.random() * 1000);
  const opts = () => ({ relays: [`ws://127.0.0.1:${port}`], createPeer: () => new FakePC() as never, iceWaitMs: 10, helloEveryMs: 150 });
  beforeAll(() => {
    relay = startRelay({ port, quiet: true });
    setPeerOptions(opts());
  });
  afterAll(async () => {
    setPeerOptions({ relays: [] });
    await relay.close();
  });
  afterEach(() => {
    __resetLiveShare();
    vi.unstubAllGlobals();
  });

  it('starts phone to phone when the Worker answers "busy", and a viewer gets the position directly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"too-many-requests"}', { status: 429, headers: { 'content-type': 'application/json' } })));
    rememberFix({ coordinate: [44.79, 41.71], accuracyM: 12, timestampMs: Date.now() });
    await useLiveShare.getState().start({ minutes: 60, name: 'Gio' });
    const st = useLiveShare.getState();
    expect(st.status).toBe('active');
    expect(st.url).toMatch(/\/live\/[A-Za-z0-9_-]{22}\/p$/);
    expect(__isPeerShare()).toBe(true);

    const got: ShareSnapshot[] = [];
    const viewer = new PeerViewer(st.id!, opts(), { onSnapshot: (s) => got.push(s), onEnded: () => {} });
    await viewer.start();
    await vi.waitFor(() => expect(got.length).toBeGreaterThan(0), { timeout: 5000, interval: 50 });
    const last = got.reduce<ShareSnapshot | null>((a, s) => mergeSnapshot(a, s), null)!;
    expect(last).toMatchObject({ name: 'Gio', pos: { c: [44.79, 41.71] }, sim: false });
    expect(useAppStore.getState().mode).not.toBe('simulating');

    await useLiveShare.getState().stop({ silent: true });
    viewer.close();
  });

  it('says why when neither the Worker nor any relay answers', async () => {
    setPeerOptions({ relays: ['ws://127.0.0.1:1'] });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await useLiveShare.getState().start({ minutes: 60, name: '' });
    expect(useLiveShare.getState()).toMatchObject({ status: 'idle', error: expect.any(String) });
    setPeerOptions(opts());
  });
});
