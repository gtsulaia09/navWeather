import type { LngLat } from '../../types/geo';

/**
 * Smooth motion between position fixes. GPS gives a fix about once a second; drawing the car (and moving the
 * camera) only at each fix made both jump and stop. Here the car glides from where it is drawn to the new fix over
 * the time the last fix took to arrive, so it reaches it as the next one comes in, and heading and zoom ease with
 * frame-rate independent exponential smoothing.
 */

/** Exponential approach toward `target` with time constant `tauMs` over `dtMs` (frame-rate independent). */
export function approach(value: number, target: number, dtMs: number, tauMs: number): number {
  if (tauMs <= 0) return target;
  return target + (value - target) * Math.exp(-dtMs / tauMs);
}

/** Signed shortest difference b − a in degrees, in (−180, 180]. */
export function angleDelta(a: number, b: number): number {
  const d = (((b - a) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

/** Like `approach`, along the shorter way round the compass. Result in [0, 360). */
export function approachAngle(value: number, target: number, dtMs: number, tauMs: number): number {
  const next = value + angleDelta(value, target) * (1 - Math.exp(-dtMs / Math.max(1, tauMs)));
  return ((next % 360) + 360) % 360;
}

export function lerpLngLat(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Rough ground distance in metres (equirectangular; for "is this a jump?" decisions only). */
export function roughDistanceM(a: LngLat, b: LngLat): number {
  const k = Math.PI / 180;
  const x = (b[0] - a[0]) * k * Math.cos(((a[1] + b[1]) / 2) * k);
  const y = (b[1] - a[1]) * k;
  return Math.hypot(x, y) * 6_371_000;
}

/** Beyond this the car is moved at once (first fix after a tunnel, a simulation jump), not glided. */
export const JUMP_M = 400;

/** The glide between two fixes. */
export class Glide {
  private from: LngLat | null = null;
  private to: LngLat | null = null;
  private start = 0;
  private duration = 1;
  private lastFixAt: number | null = null;

  /** Where the car is drawn at `now`. */
  at(now: number): LngLat | null {
    if (!this.to) return null;
    if (!this.from) return this.to;
    return lerpLngLat(this.from, this.to, this.progress(now));
  }

  /** 0…1 along the current glide. */
  progress(now: number): number {
    return Math.min(1, Math.max(0, (now - this.start) / this.duration));
  }

  get target(): LngLat | null {
    return this.to;
  }

  /** How long the current glide lasts, in ms. */
  get durationMs(): number {
    return this.duration;
  }

  /** A new fix: glide there from where the car is drawn, over the time this fix took to arrive. */
  push(fix: LngLat, now: number): void {
    const shown = this.at(now);
    const gap = this.lastFixAt !== null ? now - this.lastFixAt : 0;
    this.lastFixAt = now;
    this.duration = gap > 0 ? Math.min(1500, Math.max(60, gap)) : 1;
    this.from = shown && roughDistanceM(shown, fix) <= JUMP_M ? shown : fix;
    this.to = fix;
    this.start = now;
  }

  reset(): void {
    this.from = this.to = null;
    this.lastFixAt = null;
  }
}
