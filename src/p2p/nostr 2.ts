/**
 * A minimal Nostr client (NIP-01 events and subscriptions, NIP-13 proof of work, NIP-40 expiry) — the overflow
 * channel of ADR-020: live-sharing handshakes and driver reports go through public relays only when our own free
 * Worker is busy. No DOM except WebSocket (injectable for tests and Node); no React.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type EventTemplate = Pick<NostrEvent, 'kind' | 'tags' | 'content'> & { created_at?: number };

export interface Filter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
}

export function newSecretKey(): Uint8Array {
  return schnorr.utils.randomSecretKey();
}

export function publicKeyHex(sk: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(sk));
}

export function eventHash(e: Pick<NostrEvent, 'pubkey' | 'created_at' | 'kind' | 'tags' | 'content'>): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
}

export function finalizeEvent(t: EventTemplate, sk: Uint8Array): NostrEvent {
  const base = { pubkey: publicKeyHex(sk), created_at: t.created_at ?? Math.floor(Date.now() / 1000), kind: t.kind, tags: t.tags, content: t.content };
  const id = eventHash(base);
  return { ...base, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) };
}

export function verifyEvent(e: unknown): e is NostrEvent {
  if (!e || typeof e !== 'object') return false;
  const v = e as NostrEvent;
  if (typeof v.id !== 'string' || typeof v.pubkey !== 'string' || typeof v.sig !== 'string' || typeof v.content !== 'string') return false;
  if (!Number.isInteger(v.created_at) || !Number.isInteger(v.kind) || !Array.isArray(v.tags)) return false;
  if (!/^[0-9a-f]{64}$/.test(v.id) || !/^[0-9a-f]{64}$/.test(v.pubkey) || !/^[0-9a-f]{128}$/.test(v.sig)) return false;
  if (!v.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))) return false;
  try {
    return eventHash(v) === v.id && schnorr.verify(hexToBytes(v.sig), hexToBytes(v.id), hexToBytes(v.pubkey));
  } catch {
    return false;
  }
}

/** Leading zero bits of an event id (NIP-13). */
export function powBits(idHex: string): number {
  let bits = 0;
  for (const ch of idHex) {
    const n = parseInt(ch, 16);
    if (n === 0) {
      bits += 4;
      continue;
    }
    return bits + Math.clz32(n) - 28;
  }
  return bits;
}

/**
 * Sign an event whose id has at least `difficulty` leading zero bits (NIP-13). Yields to the event loop every few
 * thousand tries so the screen stays responsive; 16 bits take ~65,000 tries on average (well under a second).
 */
export async function minePow(t: EventTemplate, sk: Uint8Array, difficulty: number, signal?: AbortSignal): Promise<NostrEvent> {
  const pubkey = publicKeyHex(sk);
  const created_at = t.created_at ?? Math.floor(Date.now() / 1000);
  const tags = t.tags.filter((x) => x[0] !== 'nonce');
  const nonceTag = ['nonce', '0', String(difficulty)];
  const all = [...tags, nonceTag];
  for (let n = 0; ; n++) {
    nonceTag[1] = String(n);
    const id = eventHash({ pubkey, created_at, kind: t.kind, tags: all, content: t.content });
    if (powBits(id) >= difficulty) return { pubkey, created_at, kind: t.kind, tags: all, content: t.content, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) };
    if (n % 4000 === 3999) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

/** Committed proof of work (the target in the nonce tag, capped by the id's real zero bits). */
export function committedPow(e: NostrEvent): number {
  const nonce = e.tags.find((t) => t[0] === 'nonce');
  const target = nonce ? Number(nonce[2]) : 0;
  return Math.min(Number.isFinite(target) ? target : 0, powBits(e.id));
}

export const tagValue = (e: Pick<NostrEvent, 'tags'>, name: string): string | undefined => e.tags.find((t) => t[0] === name)?.[1];

/** True when the event matches the filter (used by the local relay and by tests). */
export function matchFilter(f: Filter, e: NostrEvent): boolean {
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.authors && !f.authors.includes(e.pubkey)) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;
  for (const [k, values] of Object.entries(f)) {
    if (!k.startsWith('#') || !Array.isArray(values)) continue;
    const name = k.slice(1);
    if (!e.tags.some((t) => t[0] === name && values.includes(t[1]))) return false;
  }
  return true;
}

/**
 * Pick `n` relays for a key (a room or a map cell) deterministically, so one share or one area always uses the same
 * relays while different ones spread over the whole list (rendezvous hashing).
 */
export function relaysFor(key: string, all: string[], n = 3): string[] {
  return all
    .map((url) => ({ url, score: bytesToHex(sha256(utf8ToBytes(`${key}|${url}`))) }))
    .sort((a, b) => (a.score < b.score ? -1 : 1))
    .slice(0, Math.min(n, all.length))
    .map((x) => x.url);
}

type WsLike = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
};
export type WebSocketFactory = (url: string) => WsLike;

const defaultFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WsLike;

interface Sub {
  filters: Filter[];
  onEvent: (e: NostrEvent, relay: string) => void;
  onEose?: (relay: string) => void;
  seen: Set<string>;
}

/** One connection to one relay, reconnecting with backoff while anything needs it. */
class Relay {
  ws: WsLike | null = null;
  open = false;
  private queue: string[] = [];
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private pendingOk = new Map<string, (ok: boolean) => void>();

  readonly url: string;
  private factory: WebSocketFactory;
  private onMessage: (relay: Relay, msg: unknown[]) => void;
  private onOpen: (relay: Relay) => void;

  // No TypeScript parameter properties: Node runs this file with type stripping only (pipelines/reports).
  constructor(url: string, factory: WebSocketFactory, onMessage: (relay: Relay, msg: unknown[]) => void, onOpen: (relay: Relay) => void) {
    this.url = url;
    this.factory = factory;
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    let ws: WsLike;
    try {
      ws = this.factory(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.retry = 0;
      for (const m of this.queue.splice(0)) ws.send(m);
      this.onOpen(this);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      if (msg[0] === 'OK' && typeof msg[1] === 'string') {
        this.pendingOk.get(msg[1])?.(msg[2] === true);
        this.pendingOk.delete(msg[1]);
        return;
      }
      this.onMessage(this, msg);
    };
    ws.onerror = () => undefined;
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.open = false;
      this.ws = null;
      for (const done of this.pendingOk.values()) done(false);
      this.pendingOk.clear();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.closed) return;
    this.retry++;
    this.timer = setTimeout(() => this.connect(), Math.min(30_000, 500 * 2 ** Math.min(this.retry, 6)));
  }

  send(msg: unknown[]) {
    const s = JSON.stringify(msg);
    if (this.open && this.ws) this.ws.send(s);
    else this.queue.push(s);
  }

  publish(e: NostrEvent, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pendingOk.delete(e.id);
        resolve(false);
      }, timeoutMs);
      this.pendingOk.set(e.id, (ok) => {
        clearTimeout(t);
        resolve(ok);
      });
      this.send(['EVENT', e]);
    });
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const done of this.pendingOk.values()) done(false);
    this.pendingOk.clear();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
    this.open = false;
  }
}

let subCounter = 0;

/**
 * A set of relays used together: publish to all, subscribe on all, de-duplicate events by id, verify signatures.
 */
export class RelayPool {
  private relays: Relay[];
  private subs = new Map<string, Sub>();

  constructor(urls: string[], factory: WebSocketFactory = defaultFactory) {
    this.relays = urls.map(
      (u) =>
        new Relay(
          u,
          factory,
          (r, msg) => this.onMessage(r, msg),
          (r) => {
            for (const [id, s] of this.subs) r.send(['REQ', id, ...s.filters]);
          },
        ),
    );
  }

  get urls(): string[] {
    return this.relays.map((r) => r.url);
  }

  private onMessage(relay: Relay, msg: unknown[]) {
    if (msg[0] === 'EOSE' && typeof msg[1] === 'string') {
      this.subs.get(msg[1])?.onEose?.(relay.url);
      return;
    }
    if (msg[0] !== 'EVENT' || typeof msg[1] !== 'string') return;
    const sub = this.subs.get(msg[1]);
    const e = msg[2];
    if (!sub || !verifyEvent(e) || sub.seen.has(e.id)) return;
    if (!sub.filters.some((f) => matchFilter(f, e))) return;
    sub.seen.add(e.id);
    if (sub.seen.size > 5000) sub.seen.clear();
    sub.onEvent(e, relay.url);
  }

  /** Subscribe on every relay; returns the unsubscribe function. */
  subscribe(filters: Filter[], onEvent: (e: NostrEvent, relay: string) => void, onEose?: (relay: string) => void): () => void {
    const id = `nw${++subCounter}`;
    this.subs.set(id, { filters, onEvent, onEose, seen: new Set() });
    for (const r of this.relays) if (r.open) r.send(['REQ', id, ...filters]);
    return () => {
      if (!this.subs.delete(id)) return;
      for (const r of this.relays) if (r.open) r.send(['CLOSE', id]);
    };
  }

  /** Publish to every relay; resolves with how many accepted it (0 = nowhere). */
  async publish(e: NostrEvent, timeoutMs = 8000): Promise<number> {
    const results = await Promise.all(this.relays.map((r) => r.publish(e, timeoutMs)));
    return results.filter(Boolean).length;
  }

  /**
   * Stored events matching the filters: collected until every relay has sent "end of stored events" or the timeout
   * passes (a relay that never answers must not stall a build).
   */
  fetchEvents(filters: Filter[], timeoutMs = 15_000): Promise<NostrEvent[]> {
    return new Promise((resolve) => {
      const out: NostrEvent[] = [];
      const done = new Set<string>();
      let unsub = () => {};
      const finish = () => {
        clearTimeout(t);
        unsub();
        resolve(out);
      };
      const t = setTimeout(finish, timeoutMs);
      unsub = this.subscribe(
        filters,
        (e) => out.push(e),
        (relay) => {
          done.add(relay);
          if (done.size >= this.relays.length) finish();
        },
      );
    });
  }

  close() {
    for (const r of this.relays) r.close();
    this.subs.clear();
  }
}

/**
 * Relay list from config: comma- or space-separated ws(s) URLs; an entry starting with "/" is a path on the page's
 * own origin (the dev server proxies `/nostr` to the local relay — see `resolveRelayUrl`).
 */
export function parseRelayList(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^wss?:\/\/[^\s]+$/.test(s) || /^\/[\w/-]*$/.test(s)))];
}

/** A same-origin relay path ("/nostr") as a ws(s) URL for this page; full URLs unchanged. */
export function resolveRelayUrl(entry: string, loc: { protocol: string; host: string } | undefined = typeof location === 'undefined' ? undefined : location): string {
  if (!entry.startsWith('/')) return entry;
  if (!loc) return `ws://127.0.0.1:7777${entry}`;
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${entry}`;
}
