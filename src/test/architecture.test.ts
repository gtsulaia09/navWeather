import { describe, expect, it } from 'vitest';

/**
 * THE SHARED CORE STAYS PLATFORM-FREE (AGENTS.md, docs/mobile/MOBILE_STRATEGY.md §2, REQ-MOB-001).
 * These folders are what a React Native (Hermes) app for iOS and Android reuses as-is:
 *   - no React, no map library, no zustand, no UI folders;
 *   - no imports from `services/*` (core defines its own types in `src/types/`);
 *   - no DOM, browser globals, or Web-only Streams (`DecompressionStream`, `Blob`) that Hermes lacks.
 * Platform needs go through `src/platform/*` or `services/providers.ts` interfaces instead.
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
    '../transit/**/*.ts',
    '../search/format.ts',
    '../map/packs.ts',
    '../platform/surfaces.ts',
    '../share/protocol.ts',
    '../reports/protocol.ts',
    // Web adapters of the road engine (Web Worker + fetch) and tests are not core.
    '!../roads/client.ts',
    '!../roads/worker.ts',
    '!../**/*.test.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const FORBIDDEN_IMPORTS =
  /from\s+['"](react|react-dom|react\/[^'"]*|maplibre-gl|zustand)['"]|from\s+['"](\.\.\/)+(components|hooks|state|dev|services)\//;
const BROWSER_GLOBALS =
  /\b(window|document|localStorage|sessionStorage|matchMedia|requestAnimationFrame|HTMLElement|navigator|DecompressionStream|CompressionStream)\s*[.(]|\bnew\s+(Blob|DecompressionStream|CompressionStream)\b/;

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
    expect(files.length).toBeGreaterThan(65);
  });

  it.each(files)('%s imports no UI, service layer or platform library', (_path, src) => {
    const bad = src.split('\n').filter((line) => FORBIDDEN_IMPORTS.test(line));
    expect(bad).toEqual([]);
  });

  it.each(files)('%s uses no browser globals or Hermes-missing Web APIs', (_path, src) => {
    const hits = code(src)
      .split('\n')
      .filter((line) => BROWSER_GLOBALS.test(line));
    expect(hits).toEqual([]);
  });
});
