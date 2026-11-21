/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev:phone` (scripts/dev.mjs --phone): HTTPS with our own certificate (scripts/dev-cert.mjs), so a phone on
// the same Wi-Fi gets a secure page and may use its location.
const https = process.env.DEV_HTTPS === '1' ? { key: readFileSync('.cert/key.pem'), cert: readFileSync('.cert/cert.pem') } : undefined;

export default defineConfig({
  plugins: [react()],
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
        // MapLibre is large; keep it in its own chunk so the app shell paints first.
        manualChunks: { maplibre: ['maplibre-gl'] },
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
});
