import { describe, expect, it } from 'vitest';
import { isSideDocked, releaseStep, rubberBand } from './BottomSheet';

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

describe('sheet drag release', () => {
  it('a long pull or a quick flick changes the detent; a small slow nudge does not', () => {
    expect(releaseStep(-60, 0)).toBe(1);
    expect(releaseStep(60, 0)).toBe(-1);
    expect(releaseStep(-12, -0.9)).toBe(1);
    expect(releaseStep(14, 0.8)).toBe(-1);
    expect(releaseStep(10, 0.1)).toBe(0);
  });

  it('pulling past the end follows less and less, never past the limit', () => {
    expect(rubberBand(10, 56)).toBeLessThan(10);
    expect(rubberBand(1000, 56)).toBeLessThan(56);
    expect(rubberBand(200, 56)).toBeGreaterThan(rubberBand(100, 56));
  });
});
