import { describe, expect, it } from 'vitest';
import { visibleInsets } from './useVisibleViewport';

describe('visibleInsets', () => {
  it('is the keyboard height when the keyboard covers the bottom (Android Chrome, measured: 810 → 450)', () => {
    expect(visibleInsets(810, { height: 450, offsetTop: 0, scale: 1 })).toEqual({ top: 0, bottom: 360 });
  });

  it('accounts for a visual viewport scrolled down to the field (iOS Safari)', () => {
    expect(visibleInsets(844, { height: 500, offsetTop: 120, scale: 1 })).toEqual({ top: 120, bottom: 224 });
  });

  it('is nothing without a keyboard, without the API, or while pinch-zoomed', () => {
    expect(visibleInsets(800, { height: 800, offsetTop: 0, scale: 1 })).toEqual({ top: 0, bottom: 0 });
    expect(visibleInsets(800, undefined)).toEqual({ top: 0, bottom: 0 });
    expect(visibleInsets(800, { height: 300, offsetTop: 200, scale: 2.5 })).toEqual({ top: 0, bottom: 0 });
  });

  it('never goes negative (browser bars sliding away make the visual viewport taller for a moment)', () => {
    expect(visibleInsets(800, { height: 856, offsetTop: 0, scale: 1 })).toEqual({ top: 0, bottom: 0 });
  });
});
