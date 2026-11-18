import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectLocale } from './index';
import { defaultUnits } from './format';
import { systemLanguage } from './systemLanguage';

describe('systemLanguage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is the browser's language when there is one", () => {
    vi.stubGlobal('navigator', { language: 'ru-RU' });
    expect(systemLanguage()).toBe('ru-RU');
    expect(detectLocale()).toBe('ru');
  });

  it('falls back to Intl where navigator has no language (React Native)', () => {
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    expect(typeof systemLanguage()).toBe('string');
    // Used to throw "Cannot read properties of undefined (reading 'slice')".
    expect(() => detectLocale()).not.toThrow();
    expect(() => defaultUnits()).not.toThrow();
  });

  it('works with no navigator at all (Node, some workers)', () => {
    vi.stubGlobal('navigator', undefined);
    expect(systemLanguage().length).toBeGreaterThan(0);
    expect(['en', 'ru']).toContain(detectLocale());
  });
});
