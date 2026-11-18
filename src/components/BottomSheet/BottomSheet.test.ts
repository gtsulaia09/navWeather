import { describe, expect, it } from 'vitest';
import { isSideDocked } from './BottomSheet';

describe('isSideDocked', () => {
  it('is a side panel on an iPhone in landscape, whose panel starts after the Dynamic Island (measured in the iOS Simulator)', () => {
    // iPhone 18 Pro, Safari, landscape: 874 px wide, safe area 62 px → panel at 70…450.
    expect(isSideDocked({ left: 70, width: 380 }, 874)).toBe(true);
  });

  it('is a side panel on a landscape phone without a notch and on desktop', () => {
    expect(isSideDocked({ left: 8, width: 261 }, 568)).toBe(true);
    expect(isSideDocked({ left: 16, width: 400 }, 1280)).toBe(true);
  });

  it('is a bottom sheet on a portrait phone and the tablet card', () => {
    expect(isSideDocked({ left: 0, width: 402 }, 402)).toBe(false);
    expect(isSideDocked({ left: 16, width: 560 }, 768)).toBe(false);
    expect(isSideDocked({ left: 16, width: 560 }, 820)).toBe(false);
  });
});
