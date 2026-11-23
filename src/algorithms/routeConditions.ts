import type { TimedRoute } from '../types/route';
import type { RouteWeatherPoint } from '../types/weather';
import type { VehicleKind } from '../trip/types';
import { bearingDeg } from '../utils/distance';
import { crosswindThresholdKmh, HAZARD_THRESHOLDS } from './hazardThresholds';

export interface MountainPassAlert {
  distanceKm: number;
  elevationM: number;
  placeName?: string;
  temperatureC?: number;
  windGustsKmh?: number;
  freezingRisk: boolean;
  fogRisk: boolean;
}

export interface SteepGradeSegment {
  fromKm: number;
  toKm: number;
  gradePct: number;
  kind: 'up' | 'down';
  lengthM: number;
}

export interface RouteConditions {
  /** Total elevation gain (m). */
  ascentM: number;
  /** Total elevation loss (m). */
  descentM: number;
  /** Average headwind component along the route (km/h; positive = headwind, negative = tailwind). */
  avgHeadwindKmh: number;
  /** Dominant wind effect relative to direction of travel. */
  dominantWind: 'headwind' | 'tailwind' | 'crosswind' | 'calm';
  /** Peak crosswind component (km/h) and where it occurs. */
  maxCrosswindKmh: number;
  maxCrosswindKm: number;
  /** True when peak crosswind exceeds the active vehicle profile's threshold. */
  crosswindWarning: boolean;
  /** Crosswind warning threshold used for the active vehicle profile (km/h). */
  crosswindThresholdKmh: number;
  /** Detected mountain passes along the route (peaks >= 1100 m). */
  mountainPasses: MountainPassAlert[];
  /** Sustained steep climbs or descents (>= 6 %). */
  steepGrades: SteepGradeSegment[];
  /** Estimated extra EV battery consumption (%) due to cold temperatures and elevation climb. */
  evExtraConsumptionPct: number | null;
  /** Min and max forecast temperatures along the route (°C). */
  minTempC: number | null;
  maxTempC: number | null;
  /** Estimated weather-related travel slowdown (seconds) for Arrive-by planning. */
  weatherDelayS: number;
  /** First severe weather point along the route (for "shelter before storm" recommendation). */
  firstSevereAtM: number | null;
}

/**
 * Pure, deterministic route condition analysis (zero DOM/React — shared mobile core).
 * Combines route geometry bearings, elevation profile, and arrival-time weather into
 * headwind/crosswind, mountain pass alerts, steep grades (>6%), EV cold/climb impact,
 * and Arrive-by weather slowdown estimates.
 */
export function analyzeRouteConditions(
  timed: TimedRoute,
  points: readonly RouteWeatherPoint[],
  opts: { vehicleKind?: VehicleKind; powertrain?: 'fuel' | 'ev' } = {},
): RouteConditions {
  const vehicleKind = opts.vehicleKind ?? 'car';
  const cwThreshold = crosswindThresholdKmh(vehicleKind);

  let ascentM = 0;
  let descentM = 0;
  const steepGrades: SteepGradeSegment[] = [];
  const mountainPasses: MountainPassAlert[] = [];

  // 1. Elevation gain/loss, steep grades (>6%), and mountain pass peaks
  const elevPts = points.filter((p) => p.elevationM !== undefined);
  for (let i = 1; i < elevPts.length; i++) {
    const prev = elevPts[i - 1];
    const cur = elevPts[i];
    const de = cur.elevationM! - prev.elevationM!;
    const distM = (cur.distanceFromStartKm - prev.distanceFromStartKm) * 1000;
    if (de > 0) ascentM += de;
    else descentM += -de;

    if (distM >= 400) {
      const gradePct = (de / distM) * 100;
      if (Math.abs(gradePct) >= HAZARD_THRESHOLDS.steepGradePct) {
        steepGrades.push({
          fromKm: Math.round(prev.distanceFromStartKm),
          toKm: Math.round(cur.distanceFromStartKm),
          gradePct: Math.round(Math.abs(gradePct) * 10) / 10,
          kind: gradePct > 0 ? 'up' : 'down',
          lengthM: Math.round(distM),
        });
      }
    }
  }

  // Mountain passes: local peaks >= 1100 m (or highest point >= 1100 m with >= 150 m prominence)
  for (let i = 0; i < elevPts.length; i++) {
    const cur = elevPts[i];
    const e = cur.elevationM!;
    if (e < HAZARD_THRESHOLDS.mountainPassMinM) continue;
    const prevE = i > 0 ? elevPts[i - 1].elevationM! : e - 200;
    const nextE = i < elevPts.length - 1 ? elevPts[i + 1].elevationM! : e - 200;
    if (e >= prevE && e >= nextE && (e - Math.min(prevE, nextE) >= 120 || e >= 1500)) {
      // Avoid duplicate passes within 15 km
      const last = mountainPasses[mountainPasses.length - 1];
      if (last && Math.abs(cur.distanceFromStartKm - last.distanceKm) < 15) {
        if (e > last.elevationM) mountainPasses.pop();
        else continue;
      }
      const w = cur.weather;
      const wet =
        !!w &&
        ((w.precipitation ?? 0) > 0.1 ||
          w.condition === 'RAIN' ||
          w.condition === 'HEAVY_RAIN' ||
          w.condition === 'SNOW' ||
          w.condition === 'SLEET' ||
          w.condition === 'THUNDERSTORM');
      mountainPasses.push({
        distanceKm: Math.round(cur.distanceFromStartKm),
        elevationM: Math.round(e),
        placeName: cur.placeName,
        temperatureC: w?.temperature,
        windGustsKmh: w?.windGusts ?? w?.windSpeed,
        freezingRisk: !!w && (w.condition === 'SNOW' || w.condition === 'SLEET' || (wet && w.temperature <= HAZARD_THRESHOLDS.freezingWetC) || w.temperature <= 0),
        fogRisk: !!w && (w.condition === 'FOG' || (w.visibility !== undefined && w.visibility < HAZARD_THRESHOLDS.fogVisibilityM)),
      });
    }
  }

  // 2. Wind components relative to direction of travel + temperature range + weather delay + first severe hazard
  let headwindSum = 0;
  let crosswindSum = 0;
  let windSamples = 0;
  let maxCrosswindKmh = 0;
  let maxCrosswindKm = 0;
  let minTempC: number | null = null;
  let maxTempC: number | null = null;
  let weatherDelayS = 0;
  let firstSevereAtM: number | null = null;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const w = p.weather;
    if (!w) continue;

    if (minTempC === null || w.temperature < minTempC) minTempC = w.temperature;
    if (maxTempC === null || w.temperature > maxTempC) maxTempC = w.temperature;

    // Segment time span for weather slowdown estimate
    const nextT = i + 1 < points.length ? (points[i + 1].arrivalMs - p.arrivalMs) / 1000 : 0;
    const spanS = Math.max(0, nextT);
    const isSevere =
      w.condition === 'THUNDERSTORM' ||
      w.condition === 'HEAVY_RAIN' ||
      w.condition === 'SNOW' ||
      w.condition === 'SLEET' ||
      (w.precipitation ?? 0) >= HAZARD_THRESHOLDS.heavyPrecipMmH;
    const isFog = w.condition === 'FOG' || (w.visibility !== undefined && w.visibility < HAZARD_THRESHOLDS.fogVisibilityM);
    const isRain = w.condition === 'RAIN' || (w.precipitation ?? 0) >= HAZARD_THRESHOLDS.rainPrecipMmH;

    if (isSevere || isFog) {
      weatherDelayS += spanS * 0.2;
      if (firstSevereAtM === null && p.distanceFromStartKm * 1000 >= 5000) {
        firstSevereAtM = Math.round(p.distanceFromStartKm * 1000);
      }
    } else if (isRain) {
      weatherDelayS += spanS * 0.08;
    }

    // Wind vector relative to road bearing
    const speed = w.windSpeed ?? 0;
    const gust = Math.max(speed, w.windGusts ?? 0);
    if (w.windDirection !== undefined && (speed > 0 || gust > 0)) {
      const nextPt = points[Math.min(points.length - 1, i + 1)];
      const prevPt = points[Math.max(0, i - 1)];
      if (prevPt !== nextPt) {
        const roadDeg = bearingDeg([prevPt.longitude, prevPt.latitude], [nextPt.longitude, nextPt.latitude]);
        // Meteorological windDirection is where wind comes FROM (0° = from north).
        // Headwind = wind coming from ahead (windDirection == roadDeg -> cos(0) = +1).
        const rad = ((w.windDirection - roadDeg) * Math.PI) / 180;
        const head = speed * Math.cos(rad);
        const cross = Math.abs(gust * Math.sin(rad));
        headwindSum += head;
        crosswindSum += cross;
        windSamples++;
        if (cross > maxCrosswindKmh) {
          maxCrosswindKmh = cross;
          maxCrosswindKm = Math.round(p.distanceFromStartKm);
        }
      }
    }
  }

  const avgHeadwindKmh = windSamples > 0 ? Math.round(headwindSum / windSamples) : 0;
  const avgCrosswindKmh = windSamples > 0 ? Math.round(crosswindSum / windSamples) : 0;
  const roundedMaxCross = Math.round(maxCrosswindKmh);

  let dominantWind: RouteConditions['dominantWind'] = 'calm';
  if (roundedMaxCross >= cwThreshold || (avgCrosswindKmh >= 18 && avgCrosswindKmh > Math.abs(avgHeadwindKmh) * 1.2)) {
    dominantWind = 'crosswind';
  } else if (avgHeadwindKmh >= 10) {
    dominantWind = 'headwind';
  } else if (avgHeadwindKmh <= -10) {
    dominantWind = 'tailwind';
  }

  // 3. EV cold + climb extra consumption estimate (only when powertrain === 'ev')
  let evExtraConsumptionPct: number | null = null;
  if (opts.powertrain === 'ev' && timed.totalDistM >= 5000) {
    let extra = 0;
    const netClimbM = Math.max(0, ascentM - descentM * 0.55); // regenerative braking recovers ~55% on descents
    const distKm = timed.totalDistM / 1000;
    // Roughly +1% consumption per 60 m net climb per 100 km
    extra += Math.min(25, (netClimbM / Math.max(20, distKm)) * 1.6);
    if (minTempC !== null && minTempC < 10) {
      extra += Math.min(22, (10 - minTempC) * 1.3);
    }
    if (avgHeadwindKmh > 15) {
      extra += Math.min(10, (avgHeadwindKmh - 15) * 0.4);
    }
    const rounded = Math.round(extra);
    if (rounded >= 5) evExtraConsumptionPct = Math.min(45, rounded);
  }

  return {
    ascentM: Math.round(ascentM),
    descentM: Math.round(descentM),
    avgHeadwindKmh,
    dominantWind,
    maxCrosswindKmh: roundedMaxCross,
    maxCrosswindKm,
    crosswindWarning: roundedMaxCross >= cwThreshold,
    crosswindThresholdKmh: cwThreshold,
    mountainPasses: mountainPasses.slice(0, 4),
    steepGrades: steepGrades.slice(0, 6),
    evExtraConsumptionPct,
    minTempC: minTempC !== null ? Math.round(minTempC) : null,
    maxTempC: maxTempC !== null ? Math.round(maxTempC) : null,
    weatherDelayS: Math.round(weatherDelayS),
    firstSevereAtM,
  };
}
