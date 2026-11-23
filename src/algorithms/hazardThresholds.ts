import type { VehicleKind } from '../trip/types';

/**
 * SINGLE SOURCE OF TRUTH FOR WEATHER HAZARD THRESHOLDS (B-08).
 * Shared by the alert engine (`weatherAlerts.ts`), route comparison (`derive.ts`),
 * departure planner (`departurePlanner.ts`), Long Trip hazards (`trip/weather/hazards.ts`),
 * and vehicle-aware crosswind/condition analysis (`routeConditions.ts`).
 */
export const HAZARD_THRESHOLDS = {
  /** Heavy precipitation rate (mm/h). */
  heavyPrecipMmH: 4,
  /** Light/moderate rain rate (mm/h). */
  rainPrecipMmH: 0.3,
  /** Wet-road freezing/black-ice risk ceiling (°C). */
  freezingWetC: 1.0,
  /** Dense fog visibility ceiling (m). */
  fogVisibilityM: 1000,
  /** Default strong wind gust threshold (km/h) for a standard car. */
  windGustKmh: 60,
  /** Default sustained wind speed threshold (km/h) for a standard car. */
  windSpeedKmh: 40,
  /** Severe / storm-force wind gust threshold (km/h). */
  severeWindGustKmh: 90,
  /** Steep grade threshold (%) highlighted for trucks, vans, and mountain driving. */
  steepGradePct: 6,
  /** Mountain pass elevation floor (m). */
  mountainPassMinM: 1100,
} as const;

/** Crosswind warning threshold (km/h) adapted to vehicle sail area & stability. */
export function crosswindThresholdKmh(kind: VehicleKind = 'car'): number {
  switch (kind) {
    case 'truck':
      return 45;
    case 'van':
      return 50;
    case 'motorcycle':
      return 40;
    default:
      return HAZARD_THRESHOLDS.windGustKmh;
  }
}

/** Wind gust warning threshold (km/h) adapted to vehicle type. */
export function windGustThresholdKmh(kind: VehicleKind = 'car'): number {
  switch (kind) {
    case 'truck':
      return 48;
    case 'van':
      return 54;
    case 'motorcycle':
      return 45;
    default:
      return HAZARD_THRESHOLDS.windGustKmh;
  }
}
