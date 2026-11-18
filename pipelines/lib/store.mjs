/**
 * Where a pipeline writes (weather, air quality, elevation): static files under `public/data` (ADR-019) — served by
 * Vite on localhost and as free static assets by the Worker when deployed. No R2, no database, no paid storage.
 *   default        public/data (what `npm run dev`, `npm run build` and the deploy pick up)
 *   out            another folder (inspection, CI artefacts)
 * `.bin` objects are gzip-compressed (the device decompresses them; Cloudflare does not compress binary types), and
 * every object of a build lives under its own run folder, so files never change once written (cached as immutable).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

export const STATIC_DATA = 'public/data';

export async function openStore({ env, out } = {}) {
  if (env) throw new Error('--env is gone (ADR-019): data are static files now — build them, then deploy the Worker');
  const root = out ?? STATIC_DATA;
  return {
    kind: `static files in ${root}`,
    put: async (key, bytes) => {
      mkdirSync(dirname(join(root, key)), { recursive: true });
      const data = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
      writeFileSync(join(root, key), key.endsWith('.bin') ? gzipSync(data, { level: 9 }) : data);
    },
    getText: async (key) => {
      try {
        return readFileSync(join(root, key), 'utf8');
      } catch {
        return null;
      }
    },
    has: async (key) => existsSync(join(root, key)),
    /** The "folders" right under a prefix (ending in "/"). */
    prefixes: async (prefix) => {
      try {
        return readdirSync(join(root, prefix), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => `${prefix}${d.name}/`);
      } catch {
        return [];
      }
    },
    deletePrefix: async (prefix) => rmSync(join(root, prefix), { recursive: true, force: true }),
    close: async () => {},
  };
}

/** `--name value` from the command line. */
export function option(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Up to `limit` writes at a time. */
export function writer(store, limit = 8) {
  const pending = new Set();
  let bytes = 0;
  return {
    async put(key, data) {
      while (pending.size >= limit) await Promise.race(pending);
      const p = store.put(key, data).finally(() => pending.delete(p));
      pending.add(p);
      bytes += data.byteLength ?? data.length;
    },
    async flush() {
      await Promise.all(pending);
    },
    get bytes() {
      return bytes;
    },
  };
}
