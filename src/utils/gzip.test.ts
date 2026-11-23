import { deflateSync, gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { gunzip, inflateRaw } from './gzip';

describe('gzip / inflateRaw (Hermes-safe via fflate)', () => {
  it('decompresses gzip payloads without needing DecompressionStream', async () => {
    const payload = new TextEncoder().encode('Tbilisi → Batumi · heavy rain near Khashuri');
    const gz = gzipSync(payload);
    const out = await gunzip(gz);
    expect(new TextDecoder().decode(out)).toBe('Tbilisi → Batumi · heavy rain near Khashuri');
  });

  it('passes uncompressed bytes through unchanged', async () => {
    const plain = new Uint8Array([1, 2, 3, 4, 5]);
    const out = await gunzip(plain);
    expect(out).toBe(plain);
  });

  it('inflates raw deflate payloads (elevation tiles)', async () => {
    const payload = new TextEncoder().encode('elevation-grid-tile-0123456789');
    const raw = deflateSync(payload);
    const out = await inflateRaw(raw);
    expect(new TextDecoder().decode(out)).toBe('elevation-grid-tile-0123456789');
  });
});
