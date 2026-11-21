/**
 * Public Nostr relays run by independent operators (ADR-020): the overflow channel for live-sharing handshakes and
 * driver reports when our own free Worker is busy. Each message goes to 3 of them picked by a hash, so the load
 * spreads and one relay going down changes nothing. Configuration, not code: `VITE_NOSTR_RELAYS` replaces the list;
 * `npm run check:relays` shows which ones answer.
 */
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://relay.nostr.net',
  'wss://nostr.oxtr.dev',
];
