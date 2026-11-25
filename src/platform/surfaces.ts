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

export interface SurfaceRouteOption {
  index: number;
  name: string;
  durationS: number;
  distanceM: number;
  weatherNote: string;
  selected: boolean;
}

export interface SurfaceSavedPlace {
  id: string;
  name: string;
  subtitle: string;
  slot: string;
  coordinate: [number, number];
}

export interface CompanionSnapshot {
  active: boolean;
  originName?: string | null;
  destinationName: string | null;
  weatherSummary?: string | null;
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
  /**
   * Identity of the route geometry below. When it equals the last one sent, `routeCoordinates` and
   * `weatherSegments` are left out (the surface keeps what it has): they are the heavy part of every update.
   */
  routeKey?: string | null;
  /** Simplified route polyline ([lon, lat]) for native CarPlay / Android Auto map rendering. */
  routeCoordinates?: [number, number][];
  /** Weather-coloured stretches along the planned route. */
  weatherSegments?: { coordinates: [number, number][]; cls: string }[];
  /** Current vehicle position & heading while navigating or simulating. */
  vehicle?: { coordinate: [number, number]; headingDeg?: number; speedMps?: number } | null;
  /** Candidate routes with travel time & weather summary for CarPlay route selection. */
  routeOptions?: SurfaceRouteOption[];
  /** Saved & recent destinations for 1-tap CarPlay destination selection. */
  savedPlaces?: SurfaceSavedPlace[];
  units?: 'metric' | 'imperial';
  locale?: string;
  updatedAtMs: number;
}

export type CarSurfaceCommand =
  | { action: 'routeTo'; place: { id: string; name: string; label?: string; coordinate: [number, number] } }
  | { action: 'selectRouteOption'; index: number }
  | { action: 'startNavigation' }
  | { action: 'stopNavigation' }
  | { action: 'dismissAlert' }
  | { action: 'searchNearby'; category: string }
  | { action: 'requestSync' };

export interface CarSurfaceBridge {
  readonly name: string;
  readonly connected: boolean;
  /** Full state sync (planning preview, saved places, route options, and active navigation). */
  syncState?(snapshot: CompanionSnapshot): void;
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
let carCommandListener: ((cmd: CarSurfaceCommand) => void) | null = null;

export function getCarSurfaceBridge(): CarSurfaceBridge {
  return carBridge;
}
export function setCarSurfaceBridge(bridge: CarSurfaceBridge | null): void {
  carBridge = bridge ?? noopCarSurfaceBridge;
}

export function setCarCommandListener(listener: ((cmd: CarSurfaceCommand) => void) | null): void {
  carCommandListener = listener;
}
export function dispatchCarSurfaceCommand(cmd: CarSurfaceCommand): void {
  carCommandListener?.(cmd);
}

export function getWristCompanionBridge(): WristCompanionBridge {
  return wristBridge;
}
export function setWristCompanionBridge(bridge: WristCompanionBridge | null): void {
  wristBridge = bridge ?? noopWristCompanionBridge;
}
