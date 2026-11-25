import { afterEach, describe, expect, it } from 'vitest';
import { gzipSync, deflateSync } from 'fflate';
import { gunzip, inflateRaw, setDecoder } from '../utils/gzip';
import { installNativeDecompression } from './decompress';

const source = 'WayTher '.repeat(2000);
const text = new TextEncoder().encode(source);
// jsdom and Node have different Uint8Array realms, so compare the decoded text.
const str = (b: Uint8Array) => new TextDecoder().decode(b);

describe('native decompression seam', () => {
  afterEach(() => setDecoder(null));

  it('decodes gzip and deflate-raw with the native decoder', async () => {
    expect(installNativeDecompression()).toBe(true);
    expect(str(await gunzip(gzipSync(text)))).toBe(source);
    expect(str(await inflateRaw(deflateSync(text)))).toBe(source);
  });

  it('decodes a view into a larger buffer (map tile inside a pack)', async () => {
    installNativeDecompression();
    const gz = gzipSync(text);
    const pack = new Uint8Array(gz.length + 20);
    pack.set(gz, 10);
    expect(str(await gunzip(new Uint8Array(pack.buffer, 10, gz.length)))).toBe(source);
  });

  it('falls back to fflate when the platform decoder fails', async () => {
    setDecoder(async () => {
      throw new Error('refused');
    });
    expect(str(await gunzip(gzipSync(text)))).toBe(source);
  });

  it('passes plain bytes through untouched', async () => {
    installNativeDecompression();
    expect(await gunzip(text)).toBe(text);
  });
});
