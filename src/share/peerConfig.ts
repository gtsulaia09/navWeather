import { config } from '../config';
import { parseRelayList } from '../p2p/relays';
import type { PeerOptions } from './peer';

/** Relays and timings for phone-to-phone sharing (ADR-020); tests replace it with `setPeerOptions`. */
let override: PeerOptions | null = null;

export function peerOptions(): PeerOptions {
  return override ?? { relays: parseRelayList(config.endpoints.nostrRelays) };
}

export function setPeerOptions(opts: PeerOptions | null): void {
  override = opts;
}
