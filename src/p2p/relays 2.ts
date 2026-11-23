/**
 * Public Nostr relays run by independent operators (ADR-020): the overflow channel for live-sharing handshakes and
 * driver reports when our own free Worker is busy. Each message goes to 3 of them picked by a hash, so the load
 * spreads and one relay going down changes nothing. Configuration, not code: `VITE_NOSTR_RELAYS` replaces the list;
 * `npm run check:relays` shows which ones answer.
 */
// Checked 2026-11-21 with `npm run check:relays`: these six answered; relay.damus.io and nostr.oxtr.dev did not.
export const DEFAULT_RELAYS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://relay.nostr.net',
];
