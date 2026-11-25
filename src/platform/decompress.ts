/**
 * Native decompression for the web app (and the iOS WKWebView shell).
 *
 * `DecompressionStream` (Safari/WKWebView 16.4+, Chrome, Firefox) decodes with the engine's native zlib — several
 * times faster than JavaScript — and streams in chunks, so the UI thread is no longer held for the whole of each map
 * tile or data file. Installed into the shared `utils/gzip` seam at startup; engines without it (or without
 * 'deflate-raw') keep the pure-JS `fflate` path.
 */
import { setDecoder, type CompressionFormat } from '../utils/gzip';

const supported = new Map<CompressionFormat, boolean>();

function canDecode(format: CompressionFormat): boolean {
  let ok = supported.get(format);
  if (ok === undefined) {
    try {
      // Constructing it throws for a format this engine does not know.
      ok = typeof DecompressionStream !== 'undefined' && typeof Blob !== 'undefined' && typeof Response !== 'undefined' && !!new DecompressionStream(format);
    } catch {
      ok = false;
    }
    supported.set(format, ok);
  }
  return ok;
}

async function decodeNative(bytes: Uint8Array, format: CompressionFormat): Promise<Uint8Array> {
  if (!canDecode(format)) throw new Error(`no native ${format}`);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Installs the native decoder when this engine has `DecompressionStream`. Returns whether it did. */
export function installNativeDecompression(): boolean {
  if (!canDecode('gzip')) return false;
  setDecoder(decodeNative);
  return true;
}
