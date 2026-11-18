import { describe, expect, it } from 'vitest';

/**
 * THE SHARED CORE STAYS PLATFORM-FREE (AGENTS.md, docs/mobile/MOBILE_STRATEGY.md §2). These folders are what a
 * React Native app (iOS/Android) will reuse as-is: no React, no map library, no DOM or browser globals, no UI
 * layers. Platform needs go through an interface (services/providers.ts, platform/storage.ts) instead.
 */
const CORE = import.meta.glob(
  [
    '../algorithms/**/*.ts',
    '../intelligence/**/*.ts',
    '../navigation/**/*.ts',
    '../types/**/*.ts',
    '../trip/**/*.ts',
    '../utils/**/*.ts',
    '../i18n/**/*.ts',
    '../roads/**/*.ts',
    '../share/protocol.ts',
    '../reports/protocol.ts',
    // Web adapters of the road engine (Web Worker + fetch) and tests are not core.
    '!../roads/client.ts',
    '!../roads/worker.ts',
    '!../**/*.test.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const FORBIDDEN_IMPORTS = /from\s+['"](react|react-dom|react\/[^'"]*|maplibre-gl|zustand)['"]|from\s+['"](\.\.\/)+(components|hooks|state|dev)\//;
const BROWSER_GLOBALS = /\b(window|document|localStorage|sessionStorage|matchMedia|requestAnimationFrame|HTMLElement|navigator)\s*[.(]/;

/** Source without comments and string contents, so prose and messages can mention anything. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

describe('shared core (future iOS/Android code)', () => {
  const files = Object.entries(CORE);

  it('covers the core folders', () => {
    expect(files.length).toBeGreaterThan(60);
  });

  it.each(files)('%s imports no UI or platform library', (_path, src) => {
    const bad = src.split('\n').filter((line) => FORBIDDEN_IMPORTS.test(line) && !/^\s*import\s+type\b/.test(line));
    expect(bad).toEqual([]);
  });

  it.each(files)('%s uses no browser globals', (_path, src) => {
    const hits = code(src)
      .split('\n')
      .filter((line) => BROWSER_GLOBALS.test(line));
    expect(hits).toEqual([]);
  });
});
