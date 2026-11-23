import { useEffect, useRef, useState } from 'react';
import { analyzeRouteConditions } from '../../algorithms/routeConditions';
import { useMessages } from '../../state/settings';
import { useAppStore, type Departure } from '../../state/store';
import {
  deviceTimeZone,
  formatLocalDate,
  formatLocalTime,
  formatUtcOffset,
  localDateKey,
  parseDateTimeLocal,
  toDateTimeLocalValue,
  zonedParts,
  zonedWallTimeToUtc,
} from '../../utils/timezone';
import { ChevronIcon } from '../Icons/Icons';

/** Departure time, entered in the START location's timezone (never assumed to be the device's). */
export function DepartureSelector() {
  const m = useMessages();
  const departure = useAppStore((s) => s.departure);
  const plan = useAppStore((s) => s.plan);
  const points = useAppStore((s) => s.derived.points);
  const originTz = useAppStore((s) => s.derived.points[0]?.timezone ?? deviceTimeZone());
  const originName = useAppStore((s) => s.plan?.timed.route.origin.name ?? '');
  const [open, setOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<'depart' | 'arrive'>('depart');
  const [arriveHint, setArriveHint] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const firstOption = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstOption.current?.focus();
    const onDoc = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const now = Date.now();
  const when =
    departure.mode === 'now'
      ? m.ui.leaveNow
      : m.ui.leaveAt(
          `${localDateKey(departure.utcMs, originTz) === localDateKey(now, originTz) ? '' : `${formatLocalDate(departure.utcMs, originTz)} `}${formatLocalTime(departure.utcMs, originTz)}`,
        );
  const tomorrow8 = (() => {
    const p = zonedParts(now + 86400000, originTz);
    return zonedWallTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 8, minute: 0 }, originTz);
  })();
  const round5 = (ms: number) => Math.ceil(ms / 300_000) * 300_000;
  const presets: { label: string; value: Departure }[] = [
    { label: m.ui.presetNow, value: { mode: 'now' } },
    { label: m.ui.presetIn1h, value: { mode: 'at', utcMs: round5(now + 3600_000) } },
    { label: m.ui.presetIn3h, value: { mode: 'at', utcMs: round5(now + 3 * 3600_000) } },
    { label: m.ui.presetTomorrow, value: { mode: 'at', utcMs: tomorrow8 } },
  ];
  const choose = (d: Departure) => {
    setArriveHint(null);
    useAppStore.getState().setDeparture(d);
    setOpen(false);
  };
  const isEn = m.locale === 'en';
  const isKa = m.locale === 'ka';
  const t = (en: string, ru: string, ka: string) => (isKa ? ka : isEn ? en : ru);
  const weatherDelayS = plan ? analyzeRouteConditions(plan.timed, points).weatherDelayS : 0;

  return (
    <div className="departure" ref={ref}>
      <button className="linkbtn tabular" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {when}
        <ChevronIcon size={14} />
      </button>
      {arriveHint ? <span className="departure__sla tabular">{arriveHint}</span> : null}
      {open ? (
        <div className="popover departure__pop" role="dialog" aria-label={m.ui.departure}>
          <div className="departure__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={pickerMode === 'depart'}
              className={`departure__tab${pickerMode === 'depart' ? ' is-on' : ''}`}
              onClick={() => setPickerMode('depart')}
            >
              {t('Leave at', 'Выехать в', 'გასვლა')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={pickerMode === 'arrive'}
              className={`departure__tab${pickerMode === 'arrive' ? ' is-on' : ''}`}
              onClick={() => setPickerMode('arrive')}
            >
              {t('Arrive by', 'Прибыть к', 'ჩასვლა')}
            </button>
          </div>
          {pickerMode === 'depart' ? (
            <>
              <ul className="rows">
                {presets.map((p, i) => (
                  <li key={p.label}>
                    <button ref={i === 0 ? firstOption : undefined} className="popover__row" onClick={() => choose(p.value)}>
                      {p.label}
                    </button>
                  </li>
                ))}
              </ul>
              <label className="departure__custom">
                <span>{m.ui.customTime(originName, formatUtcOffset(now, originTz))}</span>
                <input
                  type="datetime-local"
                  min={toDateTimeLocalValue(now - 3600_000, originTz)}
                  max={toDateTimeLocalValue(now + 14 * 86400000, originTz)}
                  defaultValue={toDateTimeLocalValue(departure.mode === 'at' ? departure.utcMs : now, originTz)}
                  onChange={(e) => {
                    const utc = parseDateTimeLocal(e.target.value, originTz);
                    if (utc !== null) {
                      setArriveHint(null);
                      useAppStore.getState().setDeparture({ mode: 'at', utcMs: Math.max(now - 3600_000, Math.min(now + 14 * 86400000, utc)) });
                    }
                  }}
                />
              </label>
            </>
          ) : (
            <label className="departure__custom">
              <span>
                {t(
                  `Target arrival (${formatUtcOffset(now, originTz)})`,
                  `Желаемое прибытие (${formatUtcOffset(now, originTz)})`,
                  `სასურველი ჩასვლა (${formatUtcOffset(now, originTz)})`,
                )}
              </span>
              <input
                type="datetime-local"
                min={toDateTimeLocalValue(now, originTz)}
                max={toDateTimeLocalValue(now + 14 * 86400000, originTz)}
                defaultValue={toDateTimeLocalValue(now + ((plan?.timed.totalTimeS ?? 3600) + weatherDelayS + 600) * 1000, originTz)}
                onChange={(e) => {
                  const targetUtc = parseDateTimeLocal(e.target.value, originTz);
                  if (targetUtc !== null && plan) {
                    const travelMs = (plan.timed.totalTimeS + weatherDelayS) * 1000;
                    const leaveUtc = Math.max(now, targetUtc - travelMs);
                    useAppStore.getState().setDeparture({ mode: 'at', utcMs: leaveUtc });
                    const delayMin = Math.round(weatherDelayS / 60);
                    setArriveHint(
                      delayMin >= 3
                        ? t(`Weather buffer ~${delayMin} min`, `Запас на погоду ~${delayMin} мин`, `ამინდის მარაგი ~${delayMin} წთ`)
                        : t(
                            `Target ${formatLocalTime(targetUtc, originTz)}`,
                            `К ${formatLocalTime(targetUtc, originTz)}`,
                            `ჩასვლა ${formatLocalTime(targetUtc, originTz)}-ზე`,
                          ),
                    );
                  }
                }}
              />
            </label>
          )}
          <p className="departure__hint">{m.ui.horizonHint}</p>
        </div>
      ) : null}
    </div>
  );
}
