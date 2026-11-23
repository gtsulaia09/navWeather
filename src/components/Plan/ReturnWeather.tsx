import { useState } from 'react';
import { conditionText, formatTemp } from '../../i18n/format';
import { useMessages, useSettings } from '../../state/settings';
import { useAppStore } from '../../state/store';
import { deviceTimeZone, formatLocalTime, zonedParts } from '../../utils/timezone';
import { WeatherIcon } from '../WeatherIcon/WeatherIcon';

const OFFSETS_H = [2, 4, 6] as const;

/**
 * "Weather on the way back" — zero network calls, reads the already-loaded destination
 * forecast at arrival + 2h / 4h / 6h and flags temperature drops or rain.
 */
export function ReturnWeather() {
  const m = useMessages();
  const unit = useSettings((s) => s.units.temperature);
  const points = useAppStore((s) => s.derived.points);
  const forecasts = useAppStore((s) => s.forecasts);
  const plan = useAppStore((s) => s.plan);
  const [hours, setHours] = useState<number>(3);

  const destPt = points.at(-1);
  if (!plan || !destPt || !destPt.weather) return null;
  const lastSample = plan.samples.at(-1);
  if (!lastSample) return null;
  const forecast = forecasts.get(lastSample.id);
  if (!forecast || forecast.times.length === 0) return null;

  const targetMs = destPt.arrivalMs + hours * 3_600_000;
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < forecast.times.length; i++) {
    const diff = Math.abs(forecast.times[i] - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestDiff > 3 * 3_600_000) return null;

  const retTemp = forecast.hourly.temperature[bestIdx];
  const retCond = forecast.hourly.condition[bestIdx];
  if (retTemp === null || !retCond) return null;

  const tz = destPt.timezone ?? deviceTimeZone();
  const retHour = zonedParts(targetMs, tz).hour;
  const retDay = retHour >= 7 && retHour < 20;
  const diffC = Math.round(retTemp - destPt.weather.temperature);
  const isEn = m.locale === 'en';
  const isKa = m.locale === 'ka';
  const t = (en: string, ru: string, ka: string) => (isKa ? ka : isEn ? en : ru);
  const deltaText =
    Math.abs(diffC) >= 3
      ? diffC < 0
        ? t(`${Math.abs(diffC)}° cooler`, `на ${Math.abs(diffC)}° холоднее`, `${Math.abs(diffC)}°-ით გრილი`)
        : t(`${diffC}° warmer`, `на ${diffC}° теплее`, `${diffC}°-ით თბილი`)
      : null;

  return (
    <section className="retwx" aria-label={t('Return weather', 'Погода на обратную дорогу', 'ამინდი უკანა გზაზე')}>
      <div className="retwx__head">
        <span className="retwx__title">{t('Return weather', 'Обратная дорога', 'უკანა გზა')}</span>
        <div className="retwx__chips" role="group">
          {OFFSETS_H.map((h) => (
            <button
              key={h}
              type="button"
              className={`retwx__chip${hours === h ? ' is-on' : ''}`}
              aria-pressed={hours === h}
              onClick={() => setHours(h)}
            >
              +{h}{t('h', ' ч', ' სთ')}
            </button>
          ))}
        </div>
      </div>
      <div className="retwx__body tabular">
        <WeatherIcon condition={retCond} isDay={retDay} size={22} />
        <span>
          <strong>{formatLocalTime(targetMs, tz)}</strong> · {formatTemp(retTemp, unit)} ·{' '}
          {conditionText({ condition: retCond, description: '' }, m)}
          {deltaText ? ` (${deltaText})` : ''}
        </span>
      </div>
    </section>
  );
}
