import type { DeviationState } from '../types/navigation';

export interface DeviationConfig {
  /** Threshold bounds (m). The spec asks for ~30–100 m depending on road and GPS. */
  minThresholdM: number;
  maxThresholdM: number;
  /** Readings worse than this accuracy are ignored for decisions. */
  maxUsableAccuracyM: number;
  /** Off-route must persist for this many readings… */
  persistReadings: number;
  /** …and this long before we call it a real deviation. */
  persistSeconds: number;
}

export interface DeviationReading {
  distanceFromRouteM: number;
  accuracyM?: number;
  timestampMs: number;
  /** Expected speed of the matched road segment (m/s) — proxy for road type. */
  roadSpeedMps?: number;
  /** Angle between the car's GPS course and the route's direction where it is matched (degrees). */
  headingOffDeg?: number;
  /** The car's own speed (m/s) — a course is only trusted when it moves. */
  speedMps?: number;
}

/** The car has turned away: its course is this far off the route's direction, at a speed where a course means something. */
const TURNED_AWAY_DEG = 55;
const TURNED_AWAY_MIN_MPS = 3;

/**
 * Clear evidence of a turn onto another road: the car moves, and in a different direction from the route. Then a
 * couple of fixes beyond the minimum distance are enough — no waiting out the timer (a driver who turned off
 * expects the new route at once).
 */
export function turnedAway(reading: DeviationReading): boolean {
  return (reading.headingOffDeg ?? 0) >= TURNED_AWAY_DEG && (reading.speedMps ?? 0) >= TURNED_AWAY_MIN_MPS;
}

export const initialDeviationState: DeviationState = {
  status: 'on-route',
  consecutiveOff: 0,
  offSinceMs: null,
  lastDistanceM: 0,
  lastThresholdM: 0,
};

/**
 * Off-route threshold: wider roads (motorways) tolerate more lateral
 * offset, and poor GPS accuracy widens the tolerance, within bounds.
 */
export function offRouteThreshold(reading: DeviationReading, cfg: DeviationConfig): number {
  const highway = (reading.roadSpeedMps ?? 0) >= 70 / 3.6;
  const accuracy = Math.max(0, reading.accuracyM ?? 20);
  // Turned away from the route: the course already says so — the minimum distance (and the fix's own accuracy,
  // checked in updateDeviation) is enough proof.
  if (turnedAway(reading)) return Math.max(cfg.minThresholdM, Math.min(cfg.maxThresholdM, (highway ? 40 : 25) + accuracy * 0.25));
  const base = highway ? 50 : 30;
  return Math.max(cfg.minThresholdM, Math.min(cfg.maxThresholdM, base + accuracy * 0.75));
}

/**
 * Pure deviation state machine. Never reacts to a single bad fix: the
 * vehicle must be beyond the threshold for N consecutive usable readings
 * AND for a minimum duration — or, when its course shows it turned away from
 * the route (`turnedAway`), for two readings in a row. Hysteresis (70 % of
 * the threshold) avoids flapping at the boundary.
 */
export function updateDeviation(
  state: DeviationState,
  reading: DeviationReading,
  cfg: DeviationConfig,
): DeviationState {
  if ((reading.accuracyM ?? 0) > cfg.maxUsableAccuracyM) {
    // Unreliable fix: don't advance or reset the deviation evidence.
    return { ...state, status: state.status === 'off-route' ? 'off-route' : state.consecutiveOff > 0 ? 'uncertain' : state.status };
  }
  // Never call a fix off-route when it is within its own uncertainty.
  const threshold = Math.max(offRouteThreshold(reading, cfg), reading.accuracyM ?? 0);
  const d = reading.distanceFromRouteM;

  if (d <= threshold * 0.7 || (d <= threshold && state.consecutiveOff === 0)) {
    return {
      status: 'on-route',
      consecutiveOff: 0,
      offSinceMs: null,
      lastDistanceM: d,
      lastThresholdM: threshold,
    };
  }
  if (d <= threshold) {
    // In the hysteresis band: hold current evidence.
    return { ...state, lastDistanceM: d, lastThresholdM: threshold };
  }
  const consecutiveOff = state.consecutiveOff + 1;
  const offSinceMs = state.offSinceMs ?? reading.timestampMs;
  const persisted =
    (turnedAway(reading) && consecutiveOff >= 2) ||
    (consecutiveOff >= cfg.persistReadings && reading.timestampMs - offSinceMs >= cfg.persistSeconds * 1000);
  return {
    status: persisted ? 'off-route' : 'uncertain',
    consecutiveOff,
    offSinceMs,
    lastDistanceM: d,
    lastThresholdM: threshold,
  };
}
