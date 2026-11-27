import { describe, expect, it } from 'vitest';
import { speedLevel, speedTolerance, updateSpeeding } from './speedLimits';

describe('speed box colour (real-drive bug 2026-11-27: 50 km/h in a 40 zone did not stand out)', () => {
  it('at or under the limit: normal; over it: amber at once; over by more than the tolerance: red at once', () => {
    expect(speedLevel(38, 40)).toBe('ok');
    expect(speedLevel(40, 40)).toBe('ok');
    expect(speedLevel(43, 40)).toBe('over');
    expect(speedLevel(45, 40)).toBe('over');
    expect(speedLevel(50, 40)).toBe('far-over');
    expect(speedLevel(94, 90)).toBe('over');
    expect(speedLevel(98, 90)).toBe('far-over');
  });

  it('no limit known or no speed: nothing to warn about', () => {
    expect(speedLevel(120, null)).toBe('ok');
    expect(speedLevel(null, 40)).toBe('ok');
    expect(speedLevel(Number.NaN, 40)).toBe('ok');
  });

  it('the tolerance is the larger of 5 km/h and 5 %', () => {
    expect(speedTolerance(40)).toBe(5);
    expect(speedTolerance(130)).toBeCloseTo(6.5);
  });

  it('the debounced speeding state still waits 5 s above limit + tolerance', () => {
    let s = updateSpeeding({ speeding: false, since: null }, 50, 40, 0);
    expect(s.speeding).toBe(false);
    s = updateSpeeding(s, 50, 40, 5000);
    expect(s.speeding).toBe(true);
  });
});
