#!/usr/bin/env node
/**
 * Zero-cost & allowed-host guard (REQ-COST-012, REQ-COST-013, REQ-COST-015, Gates G2 & G3).
 *
 * Fails if:
 *  1. The production bundle (`dist/assets/*`, `dist/index.html`) contains any forbidden public service with usage
 *     limits (OSRM demo, FOSSGIS, Photon, Nominatim, Overpass, Open-Meteo API, Transitous) or paid/metered APIs.
 *  2. `dist/_headers` CSP `connect-src` allows any host outside the AGENTS.md allowlist (own origin,
 *     `tiles.openfreemap.org`, configured Nostr relays, or own `*.workers.dev`).
 *  3. Any `.env.*` file points to a forbidden host or paid service.
 *
 * Run after `npm run build`: `npm run check:cost` (also in CI).
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_RELAYS } from '../src/p2p/relays.ts';

const FORBIDDEN_HOSTS = [
  'router.project-osrm.org',
  'routing.openstreetmap.de',
  'photon.komoot.io',
  'nominatim.openstreetmap.org',
  'overpass-api.de',
  'overpass.kumi.systems',
  'api.open-meteo.com',
  'air-quality-api.open-meteo.com',
  'api.transitous.org',
  'api.mapbox.com',
  'maps.googleapis.com',
  'sentry.io',
  'google-analytics.com',
  'googletagmanager.com',
  'mixpanel.com',
  'segment.io',
  'amplitude.com',
];

const ALLOWED_STUN = new Set(['stun.cloudflare.com', 'stun.l.google.com']);
const ALLOWED_CONNECT_HOSTS = new Set([
  'tiles.openfreemap.org',
  ...DEFAULT_RELAYS.map((r) => new URL(r).host),
]);

function isOwnOrLocal(host) {
  return (
    host === 'localhost' ||
    host.startsWith('localhost:') ||
    host.startsWith('127.0.0.1') ||
    host.endsWith('.workers.dev')
  );
}

// 1. Check built bundle files (dist/index.html + dist/assets/*).
assert.ok(existsSync('dist/assets'), 'dist/assets not found — run `npm run build` before `npm run check:cost`');
const bundleFiles = ['dist/index.html', ...readdirSync('dist/assets').filter((f) => /\.(js|css)$/.test(f)).map((f) => join('dist/assets', f))];
const violations = [];

for (const file of bundleFiles) {
  const text = readFileSync(file, 'utf8');
  for (const host of FORBIDDEN_HOSTS) {
    if (text.includes(host)) violations.push(`${file} references forbidden host "${host}"`);
  }
  // Check any STUN / TURN URIs embedded in string literals: only allowed free STUN, never paid TURN.
  for (const m of text.matchAll(/['"](stuns?|turns?):([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?['"]/gi)) {
    const scheme = m[1].toLowerCase();
    const host = m[2].toLowerCase();
    if (scheme.startsWith('turn')) violations.push(`${file} embeds TURN server "${m[0]}" (TURN bills past 1 TB/mo, ADR-020)`);
    else if (!ALLOWED_STUN.has(host)) violations.push(`${file} embeds unapproved STUN server "${m[0]}"`);
  }
}

// 2. Check dist/_headers CSP connect-src.
const headersPath = 'dist/_headers';
assert.ok(existsSync(headersPath), 'dist/_headers missing');
const headersText = readFileSync(headersPath, 'utf8');
const connectMatch = /connect-src\s+([^;\n]+)/.exec(headersText);
assert.ok(connectMatch, 'dist/_headers missing connect-src CSP directive');
const connectTokens = connectMatch[1].trim().split(/\s+/);
for (const tok of connectTokens) {
  if (tok === "'self'") continue;
  let u;
  try {
    u = new URL(tok);
  } catch {
    violations.push(`dist/_headers connect-src has unexpected token "${tok}"`);
    continue;
  }
  if (!ALLOWED_CONNECT_HOSTS.has(u.host) && !isOwnOrLocal(u.host)) {
    violations.push(`dist/_headers connect-src allows unapproved host "${u.host}" (${tok})`);
  }
}

// 3. Check .env.* files.
for (const envFile of ['.env.development', '.env.preview', '.env.production', '.env.test']) {
  if (!existsSync(envFile)) continue;
  const text = readFileSync(envFile, 'utf8');
  for (const host of FORBIDDEN_HOSTS) {
    if (text.includes(host)) violations.push(`${envFile} references forbidden host "${host}"`);
  }
}

assert.deepEqual(violations, [], `Cost/host guard violations:\n  - ${violations.join('\n  - ')}`);
console.log(
  `cost guard OK: ${bundleFiles.length} bundle files clean, CSP connect-src (${connectTokens.length} entries) within AGENTS.md allowlist, 0 forbidden hosts`,
);
