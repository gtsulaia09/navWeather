#!/usr/bin/env node
/**
 * Before `wrangler dev`: the Worker needs a static-assets folder. In development the app and our data are served by
 * Vite on :5173 (public/data), so the Worker gets an empty folder: loading thousands of data files into the local
 * runtime would only slow the API (sharing, reports). `npm run preview:worker` serves the real dist/ instead.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEV_ASSETS = '.wrangler/dev-assets';

export function prepareWorkerAssets() {
  mkdirSync('dist', { recursive: true });
  mkdirSync(DEV_ASSETS, { recursive: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) prepareWorkerAssets();
