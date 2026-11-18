/**
 * gzip → bytes with the platform's own decompressor (browsers, workers, Node 18+). Plain bytes pass through: a server
 * may already have decoded them (Content-Encoding), or the file was never compressed.
 */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  return decompress(bytes, 'gzip');
}

/** deflate-raw → bytes. */
export function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return decompress(bytes, 'deflate-raw');
}

async function decompress(bytes: Uint8Array, format: CompressionFormat): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
