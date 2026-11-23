import type { Guidance } from '../navigation/maneuvers';
import type { RouteProgress } from '../types/navigation';
import type { WeatherCondition } from '../types/weather';

/**
 * CAR & WRIST SURFACES seam (MOBILE_STRATEGY §5 CarPlay, §6 Android Auto, Apple Watch / Wear OS).
 *
 * Pure TypeScript snapshot types + bridges so the exact same deterministic navigation and weather engines drive:
 * - CarPlay (`CPMapTemplate` + `CPNavigationSession`: maneuver, ETA, ONE weather alert banner at a time, voice-first)
 * - Android Auto (`NavigationTemplate` + `NavigationManager.updateTrip`: maneuver, travel estimate, ONE weather alert)
 * - Apple Watch / Wear OS companion (glanceable: next maneuver, distance, ETA, next weather event — no map required)
 *
 * This module has zero DOM or React dependencies so it runs directly inside Hermes and core tests.
 */

export interface SurfaceAlert {
  id: string;
  headline: string;
  detail?: string;
  severity: 'medium' | 'high' | 'critical';
  condition?: WeatherCondition;
  /** Seconds until the vehicle reaches the hazard. */
  inSeconds: number;
}

export interface CompanionSnapshot {
  active: boolean;
  destinationName: string | null;
  etaMs: number | null;
  remainingDistanceM: number | null;
  remainingDurationS: number | null;
  nextManeuver: {
    instruction: string;
    modifier?: string;
    type: string;
    roadName?: string;
    distanceM: number;
  } | null;
  /** At most ONE active weather/road alert at a time (driver distraction rule: MOBILE_STRATEGY §5–§6). */
  alert: SurfaceAlert | null;
  /** Glanceable next significant weather change ahead (for Watch / Wear OS & trip preview). */
  nextWeatherEvent: {
    label: string;
    condition: WeatherCondition;
    atMs: number;
    distanceM: number;
  } | null;
  updatedAtMs: number;
}

export interface CarSurfaceBridge {
  readonly name: string;
  readonly connected: boolean;
  updateNavigation(snapshot: CompanionSnapshot): void;
  endNavigation(): void;
}

export interface WristCompanionBridge {
  readonly name: string;
  readonly connected: boolean;
  pushSnapshot(snapshot: CompanionSnapshot): void;
}

/** Build a car/wrist snapshot purely from shared-core navigation state. */
export function buildCompanionSnapshot(input: {
  active: boolean;
  destinationName: string | null;
  progress: RouteProgress | null;
  guidance: Guidance | null;
  instructionText?: string;
  alert?: SurfaceAlert | null;
  nextWeatherEvent?: CompanionSnapshot['nextWeatherEvent'];
  nowMs: number;
}): CompanionSnapshot {
  const { active, destinationName, progress, guidance, instructionText, alert = null, nextWeatherEvent = null, nowMs } = input;
  return {
    active,
    destinationName,
    etaMs: progress ? progress.etaMs : null,
    remainingDistanceM: progress ? Math.round(progress.remainingDistanceM) : null,
    remainingDurationS: progress ? Math.round(progress.remainingTimeS) : null,
    nextManeuver:
      active && guidance?.next
        ? {
            instruction: instructionText || guidance.next.roadName || guidance.next.kind,
            modifier: guidance.next.modifier,
            type: guidance.next.kind,
            roadName: guidance.next.roadName || undefined,
            distanceM: Math.round(guidance.distanceToNextM),
          }
        : null,
    alert: active ? alert : null,
    nextWeatherEvent,
    updatedAtMs: nowMs,
  };
}

export const noopCarSurfaceBridge: CarSurfaceBridge = {
  name: 'none',
  connected: false,
  updateNavigation() {},
  endNavigation() {},
};

export const noopWristCompanionBridge: WristCompanionBridge = {
  name: 'none',
  connected: false,
  pushSnapshot() {},
};

let carBridge: CarSurfaceBridge = noopCarSurfaceBridge;
let wristBridge: WristCompanionBridge = noopWristCompanionBridge;

export function getCarSurfaceBridge(): CarSurfaceBridge {
  return carBridge;
}
export function setCarSurfaceBridge(bridge: CarSurfaceBridge | null): void {
  carBridge = bridge ?? noopCarSurfaceBridge;
}

export function getWristCompanionBridge(): WristCompanionBridge {
  return wristBridge;
}
export function setWristCompanionBridge(bridge: WristCompanionBridge | null): void {
  wristBridge = bridge ?? noopWristCompanionBridge;
}
