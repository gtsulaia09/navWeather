#!/usr/bin/env node
/**
 * Which Nostr relays of the list answer right now (ADR-020)? Read-only: opens each relay, asks for one stored event of
 * our report kind and waits for "end of stored events". Publishes nothing.
 *   npm run check:relays [-- --relays wss://a,wss://b]
 */
import { RelayPool, parseRelayList } from '../src/p2p/nostr.ts';
import { DEFAULT_RELAYS } from '../src/p2p/relays.ts';
import { REPORT_EVENT_KIND } from '../src/reports/feed.ts';

const i = process.argv.indexOf('--relays');
const relays = parseRelayList(i > 0 ? process.argv[i + 1] : process.env.NOSTR_RELAYS ?? DEFAULT_RELAYS.join(','));
const results = await Promise.all(
  relays.map(async (url) => {
    const pool = new RelayPool([url]);
    const t0 = Date.now();
    const answered = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 8000);
      pool.subscribe([{ kinds: [REPORT_EVENT_KIND], limit: 1 }], () => {}, () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    pool.close();
    return { url, answered, ms: Date.now() - t0 };
  }),
);
for (const r of results) console.log(`${r.answered ? 'ok  ' : 'DOWN'} ${r.url}${r.answered ? `  ${r.ms} ms` : ''}`);
const up = results.filter((r) => r.answered).length;
console.log(`${up} of ${results.length} relays answer`);
process.exit(up >= 3 ? 0 : 1);
