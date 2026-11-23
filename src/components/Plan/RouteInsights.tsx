import { useEffect, useMemo, useState } from 'react';
import { analyzeRouteConditions } from '../../algorithms/routeConditions';
import { formatSpeed, formatTemp } from '../../i18n/format';
import type { AirQuality } from '../../services/air/AirQualityProvider';
import { getProviders } from '../../services/providers';
import { useMessages, useSettings } from '../../state/settings';
import { useAppStore } from '../../state/store';
import { AlertIcon } from '../Icons/Icons';

/**
 * Compact, high-signal route condition cards:
 * - headwind / tailwind / crosswind (adapted to Car / Van / Truck / Moto profile) + elevation gain;
 * - mountain pass alerts (elevation + freezing/fog/wind);
 * - steep grades >= 6% (climb/descent);
 * - EV cold + climb range impact estimate;
 * - live CAMS Air Quality (AQI) badge for walk & bike;
 * - "Shelter before storm" one-tap search for cafes/fuel ahead of severe weather.
 */
export function RouteInsights() {
  const m = useMessages();
  const units = useSettings((s) => s.units);
  const vehicleKind = useSettings((s) => s.vehicleKind);
  const powertrain = useSettings((s) => s.vehicle);
  const plan = useAppStore((s) => s.plan);
  const points = useAppStore((s) => s.derived.points);
  const travelMode = useAppStore((s) => s.travelMode);
  const [air, setAir] = useState<AirQuality | null>(null);

  const conditions = useMemo(() => {
    if (!plan || points.length === 0) return null;
    return analyzeRouteConditions(plan.timed, points, { vehicleKind, powertrain });
  }, [plan, points, vehicleKind, powertrain]);

  // Fetch local CAMS AQI for walking and cycling routes (zero external API calls).
  useEffect(() => {
    setAir(null);
    if (!plan || (travelMode !== 'walk' && travelMode !== 'bike')) return;
    const airProvider = getProviders().air;
    if (!airProvider) return;
    const mid = plan.timed.route.geometry[Math.floor(plan.timed.route.geometry.length / 2)];
    if (!mid) return;
    const ac = new AbortController();
    airProvider
      .current(mid, ac.signal)
      .then((res) => {
        if (!ac.signal.aborted && res) setAir(res);
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [plan, travelMode]);

  if (!conditions) return null;

  const isEn = m.locale === 'en';
  const showWindElevation =
    travelMode === 'bike' ||
    travelMode === 'walk' ||
    vehicleKind === 'motorcycle' ||
    vehicleKind === 'truck' ||
    vehicleKind === 'van' ||
    conditions.crosswindWarning ||
    conditions.ascentM >= 250;

  const hasAny =
    showWindElevation ||
    conditions.mountainPasses.length > 0 ||
    conditions.steepGrades.length > 0 ||
    conditions.evExtraConsumptionPct !== null ||
    air !== null ||
    conditions.firstSevereAtM !== null;

  if (!hasAny) return null;

  const windText = (() => {
    if (conditions.crosswindWarning) {
      return isEn
        ? `Strong crosswind ${formatSpeed(conditions.maxCrosswindKmh, units.wind, m)} around km ${conditions.maxCrosswindKm}`
        : `Сильный боковой ветер ${formatSpeed(conditions.maxCrosswindKmh, units.wind, m)} около ${conditions.maxCrosswindKm} км`;
    }
    if (conditions.dominantWind === 'headwind') {
      return isEn
        ? `Mostly headwind ${formatSpeed(Math.abs(conditions.avgHeadwindKmh), units.wind, m)}`
        : `В основном встречный ветер ${formatSpeed(Math.abs(conditions.avgHeadwindKmh), units.wind, m)}`;
    }
    if (conditions.dominantWind === 'tailwind') {
      return isEn
        ? `Mostly tailwind ${formatSpeed(Math.abs(conditions.avgHeadwindKmh), units.wind, m)}`
        : `В основном попутный ветер ${formatSpeed(Math.abs(conditions.avgHeadwindKmh), units.wind, m)}`;
    }
    if (conditions.dominantWind === 'crosswind') {
      return isEn
        ? `Crosswind up to ${formatSpeed(conditions.maxCrosswindKmh, units.wind, m)}`
        : `Боковой ветер до ${formatSpeed(conditions.maxCrosswindKmh, units.wind, m)}`;
    }
    return null;
  })();

  const elevText =
    conditions.ascentM >= 100
      ? isEn
        ? `Climb +${conditions.ascentM} m`
        : `Набор высоты +${conditions.ascentM} м`
      : null;

  const aqiLevel = (aqi: number) => {
    if (aqi <= 25) return isEn ? 'Good air' : 'Воздух хороший';
    if (aqi <= 50) return isEn ? 'Fair air' : 'Воздух умеренный';
    if (aqi <= 75) return isEn ? 'Moderate air' : 'Повышенная запылённость';
    return isEn ? 'Poor air' : 'Плохой воздух';
  };

  const shelterBeforeStorm = () => {
    if (conditions.firstSevereAtM === null) return;
    const aroundM = Math.max(0, conditions.firstSevereAtM - 10_000);
    void useAppStore.getState().searchPoi('cafe', { aroundM });
  };

  return (
    <section className="insights" aria-label={isEn ? 'Route conditions' : 'Условия по маршруту'}>
      {air ? (
        <div className={`insight-chip${air.europeanAqi > 50 ? ' is-warn' : ' is-good'}`}>
          <span className="insight-chip__dot" aria-hidden="true" />
          <span>
            {aqiLevel(air.europeanAqi)} · AQI {Math.round(air.europeanAqi)}
          </span>
        </div>
      ) : null}

      {showWindElevation && (windText || elevText) ? (
        <div className={`insight-row${conditions.crosswindWarning ? ' is-warn' : ''}`}>
          {conditions.crosswindWarning ? <AlertIcon size={16} /> : null}
          <span>{[windText, elevText].filter(Boolean).join(' · ')}</span>
        </div>
      ) : null}

      {conditions.mountainPasses.map((pass) => (
        <div key={pass.distanceKm} className={`insight-row${pass.freezingRisk || pass.fogRisk ? ' is-warn' : ''}`}>
          <AlertIcon size={16} />
          <span>
            {isEn
              ? `Mountain pass ${pass.elevationM} m${pass.placeName ? ` (${pass.placeName})` : ''}`
              : `Горный перевал ${pass.elevationM} м${pass.placeName ? ` (${pass.placeName})` : ''}`}
            {pass.temperatureC !== undefined ? ` · ${formatTemp(pass.temperatureC, units.temperature)}` : ''}
            {pass.freezingRisk ? (isEn ? ' · ice risk' : ' · риск гололёда') : ''}
            {pass.fogRisk ? (isEn ? ' · fog' : ' · туман') : ''}
          </span>
        </div>
      ))}

      {conditions.steepGrades.length > 0 && (vehicleKind === 'truck' || vehicleKind === 'van' || travelMode === 'bike') ? (
        <div className="insight-row is-warn">
          <AlertIcon size={16} />
          <span>
            {isEn
              ? `Steep grades ≥ 6% (${conditions.steepGrades.length}×, max ${Math.max(...conditions.steepGrades.map((g) => g.gradePct))}%)`
              : `Крутые уклоны ≥ 6% (${conditions.steepGrades.length} уч., до ${Math.max(...conditions.steepGrades.map((g) => g.gradePct))}%)`}
          </span>
        </div>
      ) : null}

      {conditions.evExtraConsumptionPct !== null ? (
        <div className="insight-row is-warn">
          <AlertIcon size={16} />
          <span>
            {isEn
              ? `EV estimate: climb & temperature may increase battery use by ~${conditions.evExtraConsumptionPct}%`
              : `Оценка EV: подъём и температура могут увеличить расход батареи на ~${conditions.evExtraConsumptionPct}%`}
          </span>
        </div>
      ) : null}

      {conditions.firstSevereAtM !== null ? (
        <button type="button" className="insight-action" onClick={shelterBeforeStorm}>
          <AlertIcon size={16} />
          <span>
            {isEn
              ? `Wait out bad weather before km ${Math.round(conditions.firstSevereAtM / 1000)} — find café / stop`
              : `Переждать непогоду до ${Math.round(conditions.firstSevereAtM / 1000)} км — найти кафе / остановку`}
          </span>
        </button>
      ) : null}
    </section>
  );
}
