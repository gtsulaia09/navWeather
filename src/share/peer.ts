/**
 * Live sharing phone to phone (ADR-020): when our free Worker relay is busy or unreachable, the sharer and each
 * viewer connect directly with a WebRTC data channel. The handshake — one offer, one answer, each with all its
 * network candidates — travels as ephemeral, end-to-end encrypted Nostr events through 3 public relays; positions
 * then flow phone to phone and never touch a server. If a direct connection cannot be made (strict NAT; we run no
 * TURN server), the viewer asks for, and the sharer publishes, an encrypted snapshot through the relays every 15 s.
 *
 * Privacy: relays see a room tag (a hash of the share id), random one-time public keys and ciphertext. The id itself
 * — the capability in the link — never leaves the link; the AES-GCM key is derived from it.
 */
import { finalizeEvent, newSecretKey, publicKeyHex, RelayPool, relaysFor, resolveRelayUrl, type NostrEvent, type WebSocketFactory } from '../p2p/nostr';
import type { ShareSnapshot } from './protocol';

/** Ephemeral kind (20000–29999): relays forward it to current subscribers and store nothing. */
export const LIVE_EVENT_KIND = 24133;
/** STUN only (free, unlimited); no TURN — Cloudflare's bills past 1,000 GB a month. */
export const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
/** A viewer with no direct channel asks for relay snapshots; the sharer sends one at most this often. */
export const RELAY_SNAP_MS = 15_000;
/** Relay snapshots carry a lighter route (relays cap event size). */
const RELAY_ROUTE_POINTS = 150;

export type PeerMsg =
  | { t: 'here' }
  | { t: 'hello'; relay?: boolean }
  | { t: 'offer'; to: string; sdp: string }
  | { t: 'answer'; to: string; sdp: string }
  | { t: 'snap'; s: ShareSnapshot }
  | { t: 'end' };

const enc = new TextEncoder();
const dec = new TextDecoder();

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface Room {
  tag: string;
  key: CryptoKey;
}

/** The room of a share id: a public tag for relays and a private key for content. */
export async function roomFor(id: string): Promise<Room> {
  const tag = hex(await sha256(`navweather-live-room|${id}`)).slice(0, 32);
  const raw = await sha256(`navweather-live-key|${id}`);
  const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { tag, key };
}

export async function seal(key: CryptoKey, msg: PeerMsg): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(msg))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}

export async function unseal(key: CryptoKey, content: string): Promise<PeerMsg | null> {
  try {
    const all = unb64(content);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12));
    const msg = JSON.parse(dec.decode(pt)) as PeerMsg;
    return msg && typeof msg === 'object' && typeof msg.t === 'string' ? msg : null;
  } catch {
    return null;
  }
}

export interface PeerOptions {
  relays: string[];
  factory?: WebSocketFactory;
  /** RTCPeerConnection factory (tests inject a fake). */
  createPeer?: () => RTCPeerConnection;
  /** How long to wait for network candidates before sending an offer/answer anyway. */
  iceWaitMs?: number;
  /** Viewer: hello again this often while no channel is open (default 10 s). */
  helloEveryMs?: number;
  /** Viewer: ask for relay snapshots after this long without a channel (default 25 s). */
  relayAfterMs?: number;
}

const defaultPeer = () => new RTCPeerConnection({ iceServers: ICE_SERVERS });

/** The encrypted signalling channel of one share: 3 relays, one random key per session. */
class Signal {
  readonly me: string;
  private sk = newSecretKey();
  private pool: RelayPool;
  private unsub: () => void = () => {};

  constructor(
    private room: Room,
    opts: PeerOptions,
    onMsg: (msg: PeerMsg, from: string) => void,
  ) {
    this.me = publicKeyHex(this.sk);
    this.pool = new RelayPool(relaysFor(room.tag, opts.relays.map((r) => resolveRelayUrl(r)), 3), opts.factory);
    this.unsub = this.pool.subscribe([{ kinds: [LIVE_EVENT_KIND], '#t': [room.tag], since: Math.floor(Date.now() / 1000) - 30 }], (e: NostrEvent) => {
      if (e.pubkey === this.me) return;
      void unseal(this.room.key, e.content).then((msg) => msg && onMsg(msg, e.pubkey));
    });
  }

  async send(msg: PeerMsg): Promise<number> {
    const content = await seal(this.room.key, msg);
    return this.pool.publish(finalizeEvent({ kind: LIVE_EVENT_KIND, tags: [['t', this.room.tag]], content }, this.sk), 6000);
  }

  close() {
    this.unsub();
    this.pool.close();
  }
}

/** Resolves once the connection has gathered its network candidates (or after `ms`). */
function iceGathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

/** Snapshot for a relay message: the route thinned (relays cap event size). */
function lighten(s: ShareSnapshot): ShareSnapshot {
  const route = s.trip?.route;
  if (!route || route.length <= RELAY_ROUTE_POINTS) return s;
  const step = route.length / RELAY_ROUTE_POINTS;
  const thin = Array.from({ length: RELAY_ROUTE_POINTS }, (_, i) => route[Math.floor(i * step)]);
  thin[thin.length - 1] = route[route.length - 1];
  return { ...s, trip: { ...s.trip!, route: thin } };
}

interface Link {
  pc: RTCPeerConnection;
  ch: RTCDataChannel;
  routeSent: string | null;
  createdAt: number;
}

/** A connection attempt still not up after this long is started again when the viewer says hello again. */
const STALE_ATTEMPT_MS = 8000;

/** The SHARER's side: answers every viewer's hello with a direct channel, sends each snapshot to all of them. */
export class PeerSender {
  private signal: Signal | null = null;
  private links = new Map<string, Link>();
  private last: ShareSnapshot | null = null;
  private relayWantedUntil = 0;
  private lastRelayAt = 0;
  private closed = false;

  constructor(
    private id: string,
    private opts: PeerOptions,
  ) {}

  /** Join the room and announce it; resolves with how many relays took the announcement (0 = none reachable). */
  async start(): Promise<number> {
    const room = await roomFor(this.id);
    if (this.closed) return 0;
    this.signal = new Signal(room, this.opts, (m, from) => this.onMsg(m, from));
    return this.signal.send({ t: 'here' });
  }

  get viewers(): number {
    return [...this.links.values()].filter((l) => l.ch.readyState === 'open').length;
  }

  private onMsg(m: PeerMsg, from: string) {
    if (m.t === 'hello') {
      if (m.relay) {
        this.relayWantedUntil = Date.now() + 6 * RELAY_SNAP_MS;
        this.lastRelayAt = 0;
        if (this.last) void this.relaySnap(this.last);
      }
      const old = this.links.get(from);
      const stuck = old && old.pc.connectionState !== 'connected' && Date.now() - old.createdAt > STALE_ATTEMPT_MS;
      if (!old || stuck || old.pc.connectionState === 'failed' || old.pc.connectionState === 'closed') void this.connect(from);
    } else if (m.t === 'answer' && m.to === this.signal?.me) {
      const link = this.links.get(from);
      if (link && link.pc.signalingState === 'have-local-offer') void link.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => undefined);
    }
  }

  private async connect(viewer: string) {
    this.links.get(viewer)?.pc.close();
    const pc = (this.opts.createPeer ?? defaultPeer)();
    const ch = pc.createDataChannel('live', { ordered: true });
    const link: Link = { pc, ch, routeSent: null, createdAt: Date.now() };
    this.links.set(viewer, link);
    ch.onopen = () => this.last && this.sendTo(link, this.last);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (this.links.get(viewer) === link) this.links.delete(viewer);
      }
    });
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await iceGathered(pc, this.opts.iceWaitMs ?? 2500);
      if (!this.closed && pc.localDescription) await this.signal?.send({ t: 'offer', to: viewer, sdp: pc.localDescription.sdp });
    } catch {
      this.links.delete(viewer);
      pc.close();
    }
  }

  private sendTo(link: Link, s: ShareSnapshot) {
    if (link.ch.readyState !== 'open') return;
    const routeId = s.trip?.routeId ?? null;
    // The route goes once per viewer (and again when it changes); viewers keep it while the id stays.
    const withRoute = routeId !== link.routeSent;
    const msg: PeerMsg = { t: 'snap', s: withRoute || !s.trip ? s : { ...s, trip: { ...s.trip, route: undefined } } };
    try {
      link.ch.send(JSON.stringify(msg));
      if (withRoute && s.trip?.route) link.routeSent = routeId;
    } catch {
      /* channel closing */
    }
  }

  private async relaySnap(s: ShareSnapshot) {
    this.lastRelayAt = Date.now();
    await this.signal?.send({ t: 'snap', s: lighten(s) });
  }

  /** Send the latest snapshot to every viewer (and through relays while a viewer without a channel asks). */
  update(s: ShareSnapshot) {
    this.last = s;
    for (const link of this.links.values()) this.sendTo(link, s);
    const now = Date.now();
    if (now < this.relayWantedUntil && now - this.lastRelayAt >= RELAY_SNAP_MS) void this.relaySnap(s);
  }

  async end() {
    if (this.closed) return;
    for (const link of this.links.values()) {
      try {
        if (link.ch.readyState === 'open') link.ch.send(JSON.stringify({ t: 'end' } satisfies PeerMsg));
      } catch {
        /* closing */
      }
    }
    await this.signal?.send({ t: 'end' }).catch(() => 0);
    this.close();
  }

  close() {
    this.closed = true;
    for (const l of this.links.values()) l.pc.close();
    this.links.clear();
    this.signal?.close();
    this.signal = null;
  }
}

export interface PeerViewerEvents {
  onSnapshot(s: ShareSnapshot, via: 'direct' | 'relay'): void;
  onEnded(): void;
}

/** The VIEWER's side: says hello until a direct channel opens; falls back to relay snapshots if it never does. */
export class PeerViewer {
  private signal: Signal | null = null;
  private pc: RTCPeerConnection | null = null;
  private from: string | null = null;
  private open = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private closed = false;

  constructor(
    private id: string,
    private opts: PeerOptions,
    private ev: PeerViewerEvents,
  ) {}

  async start() {
    const room = await roomFor(this.id);
    if (this.closed) return;
    this.signal = new Signal(room, this.opts, (m, from) => this.onMsg(m, from));
    this.startedAt = Date.now();
    void this.hello();
    // Say hello again until a channel is open (the sharer may join later or lose its connection); after 25 s
    // without one, ask for relay snapshots too.
    this.timer = setInterval(() => {
      if (!this.open) void this.hello();
    }, this.opts.helloEveryMs ?? 10_000);
  }

  get direct(): boolean {
    return this.open;
  }

  private hello() {
    const relay = Date.now() - this.startedAt >= (this.opts.relayAfterMs ?? 25_000) || undefined;
    return this.signal?.send({ t: 'hello', relay }) ?? Promise.resolve(0);
  }

  private onMsg(m: PeerMsg, from: string) {
    if (m.t === 'here' && !this.open) void this.hello();
    else if (m.t === 'offer' && m.to === this.signal?.me) void this.answer(m.sdp, from);
    else if (m.t === 'snap' && !this.open) this.ev.onSnapshot(m.s, 'relay');
    else if (m.t === 'end') this.ev.onEnded();
  }

  private async answer(sdp: string, from: string) {
    if (this.open) return;
    this.pc?.close();
    const pc = (this.opts.createPeer ?? defaultPeer)();
    this.pc = pc;
    this.from = from;
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      ch.onopen = () => (this.open = true);
      ch.onclose = () => (this.open = false);
      ch.onmessage = (msg) => {
        if (typeof msg.data !== 'string') return;
        try {
          const m = JSON.parse(msg.data) as PeerMsg;
          if (m.t === 'snap') this.ev.onSnapshot(m.s, 'direct');
          else if (m.t === 'end') this.ev.onEnded();
        } catch {
          /* ignore */
        }
      };
      if (ch.readyState === 'open') this.open = true;
    };
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') this.open = false;
    });
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await iceGathered(pc, this.opts.iceWaitMs ?? 2500);
      if (!this.closed && pc.localDescription && this.from === from) await this.signal?.send({ t: 'answer', to: from, sdp: pc.localDescription.sdp });
    } catch {
      /* the next hello brings a new offer */
    }
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.pc?.close();
    this.signal?.close();
    this.signal = null;
  }
}

/** Keep the route geometry from the previous snapshot while the route id is unchanged (it is sent once). */
export function mergeSnapshot(prev: ShareSnapshot | null, next: ShareSnapshot): ShareSnapshot {
  if (!next.trip || next.trip.route || !prev?.trip?.route || prev.trip.routeId !== next.trip.routeId) return next;
  return { ...next, trip: { ...next.trip, route: prev.trip.route } };
}

/** A fresh 128-bit share id (the same shape as the Worker's), for a share that starts phone to phone. */
export function newShareId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
