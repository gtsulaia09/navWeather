/// <reference types="vitest/config" />
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { DEFAULT_RELAYS, parseRelayList } from './src/p2p/relays';

/**
 * The CSP's connect-src lists exactly the hosts this build talks to (ADR-020): its own origin, the reports feed and
 * basemap Workers, the Nostr relays of the overflow paths, and OpenFreeMap as the fallback basemap. Written into
 * dist/_headers at build time from the same VITE_* values the app is built with.
 */
function cspConnectSrc(mode: string): Plugin {
  return {
    name: 'navweather-csp-connect-src',
    apply: 'build',
    writeBundle(opts) {
      const env = loadEnv(mode, process.cwd(), 'VITE_');
      const origins = new Set<string>(["'self'", 'https://tiles.openfreemap.org']);
      for (const key of ['VITE_BASEMAP_URL', 'VITE_REPORTS_FEED_URL', 'VITE_MAP_STYLE_LIGHT', 'VITE_MAP_STYLE_DARK', 'VITE_API_ORIGIN']) {
        const v = env[key];
        if (v && /^https?:\/\//.test(v)) origins.add(new URL(v).origin);
      }
      for (const r of parseRelayList(env.VITE_NOSTR_RELAYS || DEFAULT_RELAYS.join(','))) {
        if (/^wss?:\/\//.test(r)) origins.add(`${new URL(r).protocol}//${new URL(r).host}`);
      }
      const file = `${opts.dir ?? 'dist'}/_headers`;
      if (!existsSync(file)) return;
      writeFileSync(file, readFileSync(file, 'utf8').replace(/connect-src [^;]*/, `connect-src ${[...origins].join(' ')}`));
    },
  };
}

// `npm run dev:phone` (scripts/dev.mjs --phone): HTTPS with our own certificate (scripts/dev-cert.mjs), so a phone on
// the same Wi-Fi gets a secure page and may use its location.
const https = process.env.DEV_HTTPS === '1' ? { key: readFileSync('.cert/key.pem'), cert: readFileSync('.cert/cert.pem') } : undefined;

export default defineConfig(({ mode }) => ({
  plugins: [react(), cspConnectSrc(mode)],
  // MapLibre's worker is an ES module that imports shared chunks.
  worker: { format: 'es' },
  // Live location relay: `npm run dev:api` runs the Worker locally.
  // The local Nostr relay (scripts/nostr-relay.mjs, ADR-020) behind /nostr, so phones on the Wi-Fi reach it too.
  server: { https, proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true }, '/nostr': { target: 'ws://127.0.0.1:7777', ws: true } } },
  preview: { proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } } },
  build: {
    target: 'es2022',
    // MapLibre (~1 MB) is an intentional, lazily-loaded chunk.
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        // Keep MapLibre and React vendor code in their own immutable chunks so the app shell paints fast and caches well.
        manualChunks: {
          react: ['react', 'react-dom', 'react-dom/client', 'zustand'],
          maplibre: ['maplibre-gl'],
        },
      },
    },
  },
  test: {
    // Browser tests (Playwright, e2e/) run with `npm run e2e`, not here.
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
}));
