import { gunzipSync, inflateSync } from 'fflate';

/**
 * Decompression for our static data and map tiles: gzip and deflate-raw.
 *
 * The default is `fflate` (MIT, pure JS — works identically in browsers, Web Workers, Node, and React Native Hermes
 * where `DecompressionStream` does not exist). It decodes synchronously, so on the page's main thread every map tile
 * and weather file blocked the UI while it was decoded. A platform can install a faster native decoder
 * (`src/platform/decompress.ts` does, with the browser's `DecompressionStream`); this module stays free of Web-only
 * APIs. When the installed decoder is missing or refuses the input, `fflate` is used.
 */
export type CompressionFormat = 'gzip' | 'deflate-raw';
export type Decoder = (bytes: Uint8Array, format: CompressionFormat) => Promise<Uint8Array>;

let decoder: Decoder | null = null;

/** Installs (or with `null`, removes) a platform decoder tried before `fflate`. */
export function setDecoder(next: Decoder | null): void {
  decoder = next;
}

async function decode(bytes: Uint8Array, format: CompressionFormat, fallback: (b: Uint8Array) => Uint8Array): Promise<Uint8Array> {
  if (decoder) {
    try {
      return await decoder(bytes, format);
    } catch {
      /* fall back to fflate below */
    }
  }
  return fallback(bytes);
}

/**
 * gzip → bytes. Plain bytes pass through: a server may already have decoded them (`Content-Encoding`), or the file
 * was never compressed.
 */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  return decode(bytes, 'gzip', gunzipSync);
}

/** deflate-raw → bytes. */
export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return decode(bytes, 'deflate-raw', inflateSync);
}
