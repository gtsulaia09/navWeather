#!/usr/bin/env node
/**
 * `npm run dev` — the whole app on localhost with one command (REQ-DEV-001):
 *   - the Worker (live sharing, driver reports, approximate location, Long Trip planner) on
 *     http://127.0.0.1:8787 with local Durable Objects and rate limits (`wrangler dev`, no Cloudflare account);
 *   - a tiny Nostr relay on ws://127.0.0.1:7777 (scripts/nostr-relay.mjs) for the overflow paths of ADR-020 — live
 *     sharing phone to phone and reports past the Worker's daily limit — so they work with no internet;
 *   - the Vite dev server on http://localhost:5173, which proxies /api to the Worker and /nostr to the relay.
 *
 * `npm run dev:phone` does the same over HTTPS on this computer's network addresses, for testing on a phone on the
 * same Wi-Fi (scripts/dev-cert.mjs makes the certificate).
 *
 * Extra arguments go to Vite (`npm run dev -- --port 5174`). If a Worker already answers on :8787
 * (`npm run dev:api` in another terminal), it is reused. Ctrl+C stops both.
 * Only the app: `npm run dev:web`. Only the Worker: `npm run dev:api`.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { DEV_ASSETS, prepareWorkerAssets } from './worker-assets.mjs';

const API = 'http://127.0.0.1:8787/api/v1/health';
const children = [];
let stopping = false;

function run(name, color, cmd, args, env = process.env) {
  const isCmd = process.platform === 'win32' && (cmd.endsWith('.cmd') || cmd.endsWith('.bat'));
  const child = spawn(cmd, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...env, FORCE_COLOR: '1' },
    shell: isCmd,
  });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (from, to) => {
    let rest = '';
    from.on('data', (chunk) => {
      const lines = (rest + chunk.toString()).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) to.write(tag + line + '\n');
    });
    from.on('end', () => rest && to.write(tag + rest + '\n'));
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`${tag}stopped (${signal ?? `exit ${code}`}) — stopping the rest.`);
    stop(code ?? 1);
  });
  children.push(child);
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}

async function apiRunning() {
  try {
    const res = await fetch(API, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForApi(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await apiRunning()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

if (await apiRunning()) {
  console.log('\x1b[36m[api]\x1b[0m a Worker already answers on :8787 — using it');
} else {
  prepareWorkerAssets(); // the app and data come from Vite here; the Worker only answers /api
  run('api', 36, npx, ['wrangler', 'dev', '--port', '8787', '--ip', '127.0.0.1', '--assets', DEV_ASSETS]);
  // Vite can start meanwhile; say clearly when the API is (not) there.
  void waitForApi(60_000).then((ok) =>
    console.log(ok ? '\x1b[36m[api]\x1b[0m ready on http://127.0.0.1:8787 (proxied as /api)' : '\x1b[36m[api]\x1b[0m not answering yet — sharing, reports and Long Trip plans need it'),
  );
}
// The local Nostr relay (ADR-020), unless one already listens on :7777.
const relayUp = await new Promise((resolve) => {
  const sock = connect(7777, '127.0.0.1');
  sock.once('connect', () => (sock.destroy(), resolve(true)));
  sock.once('error', () => resolve(false));
});
if (relayUp) console.log('\x1b[33m[relay]\x1b[0m a relay already listens on :7777 — using it');
else run('relay', 33, process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/nostr-relay.mjs']);

// `--phone` (npm run dev:phone): HTTPS on every network address, so a phone on the same Wi-Fi can open the app with
// location working (phones allow it only on secure pages). Vite reads DEV_HTTPS (vite.config.ts).
const args = process.argv.slice(2);
const phone = args.includes('--phone');
const viteArgs = args.filter((a) => a !== '--phone');
const viteEnv = { ...process.env };
if (phone) {
  const { ensureDevCert } = await import('./dev-cert.mjs');
  const { ips } = ensureDevCert();
  viteEnv.DEV_HTTPS = '1';
  viteArgs.push('--host');
  const at = viteArgs.indexOf('--port');
  const port = at >= 0 && viteArgs[at + 1] ? viteArgs[at + 1] : '5173';
  console.log(
    ips.length
      ? `\x1b[35m[web]\x1b[0m phone (same Wi-Fi): ${ips.map((ip) => `https://${ip}:${port}`).join('  ')}` +
          '\n\x1b[35m[web]\x1b[0m the phone warns "not private" once (our own certificate): open the details and continue to the site'
      : '\x1b[35m[web]\x1b[0m no network address found — is this computer on Wi-Fi?',
  );
}
run('web', 35, npx, ['vite', ...viteArgs], viteEnv);
