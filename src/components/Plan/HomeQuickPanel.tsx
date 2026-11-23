import { useEffect, useState } from 'react';
import { formatDistance, formatTemp } from '../../i18n/format';
import { getProviders } from '../../services/providers';
import { useExplore } from '../../state/explore';
import { useSavedPlaces } from '../../state/savedPlaces';
import { useMessages, useSettings } from '../../state/settings';
import { useAppStore } from '../../state/store';
import type { LngLat, Place } from '../../types/geo';
import type { WeatherCondition } from '../../types/weather';
import { haversineM } from '../../utils/distance';
import { AlertIcon } from '../Icons/Icons';
import { WeatherIcon } from '../WeatherIcon/WeatherIcon';

interface Getaway {
  id: string;
  en: string;
  ru: string;
  ka: string;
  coordinate: LngLat;
}

const DEFAULT_CENTER: LngLat = [44.8015, 41.6934];

const GETAWAYS: Getaway[] = [
  { id: 'gw-mtskheta', en: 'Mtskheta', ru: 'Мцхета', ka: 'მცხეთა', coordinate: [44.7199, 41.8451] },
  { id: 'gw-sighnaghi', en: 'Sighnaghi', ru: 'Сигнахи', ka: 'სიღნაღი', coordinate: [45.9219, 41.6194] },
  { id: 'gw-telavi', en: 'Telavi', ru: 'Телави', ka: 'თელავი', coordinate: [45.4731, 41.9198] },
  { id: 'gw-gori', en: 'Gori', ru: 'Гори', ka: 'გორი', coordinate: [44.1158, 41.9842] },
  { id: 'gw-borjomi', en: 'Borjomi', ru: 'Боржоми', ka: 'ბორჯომი', coordinate: [43.3828, 41.8414] },
  { id: 'gw-gudauri', en: 'Gudauri', ru: 'Гудаури', ka: 'გუდაური', coordinate: [44.4761, 42.4780] },
  { id: 'gw-kutaisi', en: 'Kutaisi', ru: 'Кутаиси', ka: 'ქუთაისი', coordinate: [42.6997, 42.2679] },
  { id: 'gw-batumi', en: 'Batumi', ru: 'Батуми', ka: 'ბათუმი', coordinate: [41.6367, 41.6168] },
];

interface SunnyItem {
  getaway: Getaway;
  tempC: number;
  condition: WeatherCondition;
  isDay: boolean;
  distM: number;
  score: number;
}

function conditionClarityScore(c: WeatherCondition): number {
  if (c === 'CLEAR') return 100;
  if (c === 'PARTLY_CLOUDY') return 80;
  if (c === 'CLOUDY') return 55;
  if (c === 'FOG') return 30;
  if (c === 'RAIN') return 15;
  return 0;
}

/**
 * Start-screen daily quick actions:
 * - One-tap Home & Work commute buttons (when saved)
 * - "I parked here" + overnight weather alert at the parked car + "Walk back to car"
 * - "Where is it sunny?" weekend getaway cards from local static weather tiles ($0)
 */
export function HomeQuickPanel() {
  const m = useMessages();
  const units = useSettings((s) => s.units);
  const saved = useSavedPlaces((s) => s.saved);
  const myLocation = useExplore((s) => s.myLocation);
  const viewCenter = useExplore((s) => s.view?.center ?? DEFAULT_CENTER);
  const [parkAlert, setParkAlert] = useState<string | null>(null);
  const [sunny, setSunny] = useState<SunnyItem[]>([]);

  const home = saved.find((p) => p.slot === 'home') ?? null;
  const work = saved.find((p) => p.slot === 'work') ?? null;
  const parking = saved.find((p) => p.slot === 'parking') ?? null;
  const isEn = m.locale === 'en';
  const isKa = m.locale === 'ka';
  const t = (en: string, ru: string, ka: string) => (isKa ? ka : isEn ? en : ru);

  const routeTo = (place: Place, mode: 'drive' | 'walk' = 'drive') => {
    const app = useAppStore.getState();
    app.setTravelMode(mode);
    if (myLocation) {
      app.setOriginPlace({
        id: 'here',
        name: m.ui.currentLocation,
        label: m.ui.currentLocation,
        coordinate: myLocation.coordinate,
        kind: 'here',
      });
    } else {
      app.setOriginText('Tbilisi, Georgia');
    }
    app.setDestinationPlace(place);
    void app.calculateRoute();
  };

  const parkHere = () => {
    const coord = myLocation?.coordinate ?? viewCenter;
    useSavedPlaces.getState().save(
      {
        id: `parking-${Date.now()}`,
        name: t('Parked car', 'Припаркованная машина', 'დაპარკინგებული მანქანა'),
        label: `${coord[1].toFixed(4)}, ${coord[0].toFixed(4)}`,
        coordinate: coord,
        kind: 'parking',
      },
      'parking',
    );
  };

  // Overnight weather check at parked car (next 12h: freezing, storm/hail, strong wind >= 50 km/h)
  useEffect(() => {
    setParkAlert(null);
    if (!parking) return;
    const ac = new AbortController();
    const now = Date.now();
    const wx = getProviders().weather;
    const pLat = parking.coordinate[1];
    const pLon = parking.coordinate[0];
    wx.getForecasts([{ latitude: pLat, longitude: pLon }], { signal: ac.signal, needUntilMs: now + 14 * 3_600_000 })
      .then((lookup) => {
        if (ac.signal.aborted) return;
        const f = lookup.forecasts.get(wx.keyFor(pLat, pLon)) ?? lookup.forecasts.values().next().value;
        if (!f) return;
        let freeze = false;
        let storm = false;
        let wind = 0;
        for (let i = 0; i < f.times.length; i++) {
          if (f.times[i] < now || f.times[i] > now + 12 * 3_600_000) continue;
          const temp = f.hourly.temperature[i];
          const cond = f.hourly.condition[i];
          const gust = f.hourly.windGusts[i] ?? 0;
          if (temp !== null && temp <= 0) freeze = true;
          if (cond === 'THUNDERSTORM' || cond === 'HEAVY_RAIN' || cond === 'SNOW') storm = true;
          if (gust > wind) wind = gust;
        }
        const warns: string[] = [];
        if (freeze) warns.push(t('frost (≤0°C)', 'заморозок (≤0°C)', 'ყინვა (≤0°C)'));
        if (storm) warns.push(t('heavy precipitation', 'сильные осадки', 'ძლიერი ნალექი'));
        if (wind >= 50) warns.push(t(`gusts ${Math.round(wind)} km/h`, `порывы ${Math.round(wind)} км/ч`, `ქარი ${Math.round(wind)} კმ/სთ`));
        if (warns.length) {
          setParkAlert(t(`Next 12h at car: ${warns.join(', ')}`, `У машины в ближайшие 12 ч: ${warns.join(', ')}`, `მანქანასთან 12 სთ-ში: ${warns.join(', ')}`));
        }
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [parking?.id, m.locale]);

  // "Where is it sunny?" — query local static weather tiles once for nearby getaways
  useEffect(() => {
    const ac = new AbortController();
    const refCoord: LngLat = myLocation?.coordinate ?? [44.8015, 41.6934];
    const now = Date.now();
    const wx = getProviders().weather;
    wx.getForecasts(
        GETAWAYS.map((g) => ({ latitude: g.coordinate[1], longitude: g.coordinate[0] })),
        { signal: ac.signal, needUntilMs: now + 6 * 3_600_000 },
      )
      .then((lookup) => {
        if (ac.signal.aborted) return;
        const items: SunnyItem[] = [];
        for (let i = 0; i < GETAWAYS.length; i++) {
          const g = GETAWAYS[i];
          const f = lookup.forecasts.get(wx.keyFor(g.coordinate[1], g.coordinate[0]));
          if (!f || f.times.length === 0) continue;
          let bestIdx = 0;
          let bestDiff = Infinity;
          for (let k = 0; k < f.times.length; k++) {
            const d = Math.abs(f.times[k] - now);
            if (d < bestDiff) {
              bestDiff = d;
              bestIdx = k;
            }
          }
          const tempC = f.hourly.temperature[bestIdx];
          const cond = f.hourly.condition[bestIdx];
          const hour = new Date(now).getHours();
          const isDay = hour >= 7 && hour < 20;
          if (tempC === null || !cond) continue;
          const distM = haversineM(refCoord, GETAWAYS[i].coordinate) * 1.25;
          if (distM < 8_000) continue; // skip the city you're already in
          const score = conditionClarityScore(cond) + tempC * 1.5 - distM / 80_000;
          items.push({ getaway: GETAWAYS[i], tempC, condition: cond, isDay, distM, score });
        }
        items.sort((a, b) => b.score - a.score);
        setSunny(items.slice(0, 4));
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [myLocation?.coordinate[0]?.toFixed(2), myLocation?.coordinate[1]?.toFixed(2)]);

  return (
    <div className="hq">
      <div className="hq__row">
        {home ? (
          <button type="button" className="hq__btn" onClick={() => routeTo(home)}>
            {t('Home', 'Домой', 'სახლი')}
          </button>
        ) : null}
        {work ? (
          <button type="button" className="hq__btn" onClick={() => routeTo(work)}>
            {t('Work', 'На работу', 'სამსახური')}
          </button>
        ) : null}
        {!parking ? (
          <button type="button" className="hq__btn" onClick={parkHere}>
            {t('I parked here', 'Я припарковался', 'აქ დავაპარკინგე')}
          </button>
        ) : null}
      </div>

      {parking ? (
        <div className="hq__park">
          <div className="hq__park-head">
            <span>{parking.name}</span>
            <button type="button" className="linkbtn" onClick={() => useSavedPlaces.getState().remove(parking.id, 'parking')}>
              {t('Clear', 'Удалить', 'წაშლა')}
            </button>
          </div>
          {parkAlert ? (
            <div className="hq__park-warn">
              <AlertIcon size={15} />
              <span>{parkAlert}</span>
            </div>
          ) : null}
          <div className="hq__park-actions">
            <button type="button" className="btn btn-quiet" onClick={() => routeTo(parking, 'walk')}>
              {t('Walk to car', 'Пешком к машине', 'ფეხით მანქანამდე')}
            </button>
          </div>
        </div>
      ) : null}

      {sunny.length > 0 ? (
        <div className="hq__sunny">
          <h4 className="hq__sunny-title">{t('Clear weather nearby', 'Куда поехать, где ясно', 'სად არის კარგი ამინდი')}</h4>
          <div className="hq__sunny-grid">
            {sunny.map((item) => {
              const name = isKa ? item.getaway.ka : isEn ? item.getaway.en : item.getaway.ru;
              return (
                <button
                  key={item.getaway.id}
                  type="button"
                  className="hq__sunny-card"
                  onClick={() =>
                    routeTo({
                      id: item.getaway.id,
                      name,
                      label: `${name}, Georgia`,
                      coordinate: item.getaway.coordinate,
                    })
                  }
                >
                  <span className="hq__sunny-top tabular">
                    <span>{name}</span>
                    <WeatherIcon condition={item.condition} isDay={item.isDay} size={18} />
                  </span>
                  <span className="hq__sunny-meta tabular">
                    {formatTemp(item.tempC, units.temperature)} · ~{formatDistance(item.distM, units.distance, m)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
