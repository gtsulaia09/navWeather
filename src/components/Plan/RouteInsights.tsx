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
  const isKa = m.locale === 'ka';
  const t = (en: string, ru: string, ka: string) => (isKa ? ka : isEn ? en : ru);
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
      const sp = formatSpeed(conditions.maxCrosswindKmh, units.wind, m);
      return t(
        `Strong crosswind ${sp} around km ${conditions.maxCrosswindKm}`,
        `Сильный боковой ветер ${sp} около ${conditions.maxCrosswindKm} км`,
        `ძლიერი გვერდითი ქარი ${sp} (${conditions.maxCrosswindKm} კმ-თან)`,
      );
    }
    if (conditions.dominantWind === 'headwind') {
      const sp = formatSpeed(Math.abs(conditions.avgHeadwindKmh), units.wind, m);
      return t(`Mostly headwind ${sp}`, `В основном встречный ветер ${sp}`, `ძირითადად შემხვედრი ქარი ${sp}`);
    }
    if (conditions.dominantWind === 'tailwind') {
      const sp = formatSpeed(Math.abs(conditions.avgHeadwindKmh), units.wind, m);
      return t(`Mostly tailwind ${sp}`, `В основном попутный ветер ${sp}`, `ძირითადად ზურგის ქარი ${sp}`);
    }
    if (conditions.dominantWind === 'crosswind') {
      const sp = formatSpeed(conditions.maxCrosswindKmh, units.wind, m);
      return t(`Crosswind up to ${sp}`, `Боковой ветер до ${sp}`, `გვერდითი ქარი ${sp}-მდე`);
    }
    return null;
  })();

  const elevText =
    conditions.ascentM >= 100
      ? t(`Climb +${conditions.ascentM} m`, `Набор высоты +${conditions.ascentM} м`, `სიმაღლის მატება +${conditions.ascentM} მ`)
      : null;

  const aqiLevel = (aqi: number) => {
    if (aqi <= 25) return t('Good air', 'Воздух хороший', 'კარგი ჰაერი');
    if (aqi <= 50) return t('Fair air', 'Воздух умеренный', 'საშუალო ჰაერი');
    if (aqi <= 75) return t('Moderate air', 'Повышенная запылённость', 'მომატებული დაბინძურება');
    return t('Poor air', 'Плохой воздух', 'ცუდი ჰაერი');
  };

  const shelterBeforeStorm = () => {
    if (conditions.firstSevereAtM === null) return;
    const aroundM = Math.max(0, conditions.firstSevereAtM - 10_000);
    void useAppStore.getState().searchPoi('cafe', { aroundM });
  };

  return (
    <section className="insights" aria-label={t('Route conditions', 'Условия по маршруту', 'მარშრუტის პირობები')}>
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
            {t(
              `Mountain pass ${pass.elevationM} m${pass.placeName ? ` (${pass.placeName})` : ''}`,
              `Горный перевал ${pass.elevationM} м${pass.placeName ? ` (${pass.placeName})` : ''}`,
              `მთის უღელტეხილი ${pass.elevationM} მ${pass.placeName ? ` (${pass.placeName})` : ''}`,
            )}
            {pass.temperatureC !== undefined ? ` · ${formatTemp(pass.temperatureC, units.temperature)}` : ''}
            {pass.freezingRisk ? t(' · ice risk', ' · риск гололёда', ' · მოყინვის რისკი') : ''}
            {pass.fogRisk ? t(' · fog', ' · туман', ' · ნისლი') : ''}
          </span>
        </div>
      ))}

      {conditions.steepGrades.length > 0 && (vehicleKind === 'truck' || vehicleKind === 'van' || travelMode === 'bike') ? (
        <div className="insight-row is-warn">
          <AlertIcon size={16} />
          <span>
            {t(
              `Steep grades ≥ 6% (${conditions.steepGrades.length}×, max ${Math.max(...conditions.steepGrades.map((g) => g.gradePct))}%)`,
              `Крутые уклоны ≥ 6% (${conditions.steepGrades.length} уч., до ${Math.max(...conditions.steepGrades.map((g) => g.gradePct))}%)`,
              `ციცაბო დახრილობა ≥ 6% (${conditions.steepGrades.length} მონაკვეთი, მაქს. ${Math.max(...conditions.steepGrades.map((g) => g.gradePct))}%)`,
            )}
          </span>
        </div>
      ) : null}

      {conditions.evExtraConsumptionPct !== null ? (
        <div className="insight-row is-warn">
          <AlertIcon size={16} />
          <span>
            {t(
              `EV estimate: climb & temperature may increase battery use by ~${conditions.evExtraConsumptionPct}%`,
              `Оценка EV: подъём и температура могут увеличить расход батареи на ~${conditions.evExtraConsumptionPct}%`,
              `EV შეფასება: აღმართმა და ტემპერატურამ შეიძლება ბატარეის ხარჯი ~${conditions.evExtraConsumptionPct}%-ით გაზარდოს`,
            )}
          </span>
        </div>
      ) : null}

      {conditions.firstSevereAtM !== null ? (
        <button type="button" className="insight-action" onClick={shelterBeforeStorm}>
          <AlertIcon size={16} />
          <span>
            {t(
              `Wait out bad weather before km ${Math.round(conditions.firstSevereAtM / 1000)} — find café / stop`,
              `Переждать непогоду до ${Math.round(conditions.firstSevereAtM / 1000)} км — найти кафе / остановку`,
              `უამინდობის გადალოდინება ${Math.round(conditions.firstSevereAtM / 1000)} კმ-მდე — კაფე / გაჩერება`,
            )}
          </span>
        </button>
      ) : null}
    </section>
  );
}
