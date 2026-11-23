#!/usr/bin/env node
/**
 * A tiny Nostr relay for localhost (ADR-020, REQ-DEV-001): live-sharing handshakes and overflow driver reports work
 * on a laptop with no internet and no third party. In memory only; NIP-01 (EVENT/REQ/CLOSE/EOSE/OK), ephemeral kinds
 * 20000–29999 forwarded and never stored, NIP-40 expiry honoured. Not for production — production uses public relays.
 *
 *   node --experimental-strip-types --no-warnings scripts/nostr-relay.mjs [--port 7777]
 *
 * `npm run dev` starts it; Vite proxies ws(s)://<dev host>/nostr to it, so phones on the same Wi-Fi reach it too.
 * Also importable: `startRelay({ port })` (tests and the reports-feed dev script).
 */
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { matchFilter, verifyEvent, tagValue } from '../src/p2p/nostr.ts';

const MAX_STORED = 20_000;

export function startRelay({ port = 7777, host = '127.0.0.1', quiet = false } = {}) {
  const stored = [];
  const wss = new WebSocketServer({ port, host });
  const log = (...a) => !quiet && console.log('[nostr]', ...a);

  const expired = (e, now) => {
    const exp = Number(tagValue(e, 'expiration'));
    return Number.isFinite(exp) && exp <= now;
  };

  wss.on('connection', (ws) => {
    const subs = new Map();
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      const now = Math.floor(Date.now() / 1000);
      if (msg[0] === 'EVENT') {
        const e = msg[1];
        if (!verifyEvent(e)) {
          ws.send(JSON.stringify(['OK', e?.id ?? '', false, 'invalid: bad event']));
          return;
        }
        if (expired(e, now)) {
          ws.send(JSON.stringify(['OK', e.id, false, 'invalid: expired']));
          return;
        }
        const ephemeral = e.kind >= 20000 && e.kind < 30000;
        if (!ephemeral && !stored.some((x) => x.id === e.id)) {
          stored.push(e);
          if (stored.length > MAX_STORED) stored.splice(0, stored.length - MAX_STORED);
        }
        ws.send(JSON.stringify(['OK', e.id, true, '']));
        for (const client of wss.clients) {
          const cs = client.__subs;
          if (!cs) continue;
          for (const [id, filters] of cs) if (filters.some((f) => matchFilter(f, e))) client.send(JSON.stringify(['EVENT', id, e]));
        }
      } else if (msg[0] === 'REQ' && typeof msg[1] === 'string') {
        const filters = msg.slice(2).filter((f) => f && typeof f === 'object');
        subs.set(msg[1], filters);
        const out = [];
        for (const f of filters) {
          const hits = stored.filter((e) => !expired(e, now) && matchFilter(f, e));
          out.push(...(f.limit ? hits.slice(-f.limit) : hits));
        }
        const seen = new Set();
        for (const e of out) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          ws.send(JSON.stringify(['EVENT', msg[1], e]));
        }
        ws.send(JSON.stringify(['EOSE', msg[1]]));
      } else if (msg[0] === 'CLOSE' && typeof msg[1] === 'string') {
        subs.delete(msg[1]);
      }
    });
    ws.__subs = subs;
  });
  log(`relay on ws://${host}:${port}`);
  return { close: () => new Promise((r) => wss.close(() => r())), stored, wss };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const at = process.argv.indexOf('--port');
  startRelay({ port: at > 0 ? Number(process.argv[at + 1]) : 7777 });
}
