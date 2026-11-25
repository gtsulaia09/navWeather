import { describe, expect, it } from 'vitest';
import { angleDelta, approach, approachAngle, Glide, JUMP_M } from './smoothFollow';

describe('smooth follow between position fixes', () => {
  it('glides from fix to fix over the time the last fix took to arrive', () => {
    const g = new Glide();
    g.push([44.8, 41.7], 0);
    expect(g.at(0)).toEqual([44.8, 41.7]);
    g.push([44.801, 41.7], 1000);
    // Half-way through the one-second gap: half-way between the fixes, not already at the new one.
    expect(g.at(1500)![0]).toBeCloseTo(44.8005, 6);
    expect(g.at(2000)).toEqual([44.801, 41.7]);
    expect(g.progress(2600)).toBe(1);
  });

  it('a fix arriving mid-glide continues from where the car is drawn (no jump back)', () => {
    const g = new Glide();
    g.push([0, 0], 0);
    g.push([0.001, 0], 1000);
    const drawn = g.at(1400)!;
    g.push([0.002, 0], 1400);
    expect(g.at(1400)![0]).toBeCloseTo(drawn[0], 9);
  });

  it('moves at once after a big jump (tunnel exit, simulation seek)', () => {
    const g = new Glide();
    g.push([44.8, 41.7], 0);
    g.push([44.9, 41.7], 1000); // ~8 km
    expect(JUMP_M).toBeLessThan(8000);
    expect(g.at(1000)).toEqual([44.9, 41.7]);
  });

  it('eases toward a target independently of the frame rate', () => {
    const sixty = Array.from({ length: 60 }).reduce<number>((v) => approach(v, 10, 1000 / 60, 300), 0);
    const thirty = Array.from({ length: 30 }).reduce<number>((v) => approach(v, 10, 1000 / 30, 300), 0);
    expect(sixty).toBeCloseTo(thirty, 6);
    expect(sixty).toBeGreaterThan(9.5);
  });

  it('turns the short way round the compass', () => {
    expect(angleDelta(350, 10)).toBe(20);
    expect(angleDelta(10, 350)).toBe(-20);
    const next = approachAngle(350, 10, 100, 100);
    expect(next === 0 || next > 350 || next < 10).toBe(true);
    expect(approachAngle(350, 10, 10_000, 100)).toBeCloseTo(10, 3);
  });
});
