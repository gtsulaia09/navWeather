import { gunzipSync, inflateSync } from 'fflate';

/**
 * gzip → bytes via `fflate` (MIT, pure JS — works identically in browsers, Web Workers, Node, and React Native
 * Hermes where `DecompressionStream` does not exist). Plain bytes pass through: a server may already have decoded
 * them (`Content-Encoding`), or the file was never compressed.
 */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  return gunzipSync(bytes);
}

/** deflate-raw → bytes (pure JS via `fflate`, Hermes-compatible). */
export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return inflateSync(bytes);
}
