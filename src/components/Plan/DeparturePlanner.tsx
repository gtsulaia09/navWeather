import { useMemo, useRef, useState, type PointerEvent } from 'react';
import { planDepartures, type DeparturePlan } from '../../algorithms/departurePlanner';
import { formatDuration } from '../../i18n/format';
import { getProviders } from '../../services/providers';
import { forecastLookupFn } from '../../services/routePlanner';
import { useMessages } from '../../state/settings';
import { useAppStore } from '../../state/store';
import { longTripActive, useTripStore } from '../../state/trip';
import { deviceTimeZone, formatLocalTime } from '../../utils/timezone';

const SLOT = 30 * 60_000;

/** The departure comparison for the current route (recomputed per 30-min slot). */
function useDeparturePlan(): { plan: DeparturePlan | null; tz: string } {
  const route = useAppStore((s) => s.plan);
  const forecasts = useAppStore((s) => s.forecasts);
  const departure = useAppStore((s) => s.departure);
  const slot = useAppStore((s) => Math.floor(s.clockMs / SLOT));
  // A multi-day trip isn't "the same drive, an hour later": its nights move with the start.
  const multiDay = useTripStore((s) => longTripActive(s) && (s.plan?.summary.overnights ?? 0) > 0);
  const tz = useAppStore((s) => s.derived.points[0]?.timezone ?? deviceTimeZone());
  const plan = useMemo(() => {
    // Public transport keeps to a timetable: leaving later is another trip, not this one shifted — no comparison.
    if (!route || forecasts.size === 0 || route.timed.route.transit || multiDay) return null;
    const now = slot * SLOT;
    const chosen = departure.mode === 'at' ? departure.utcMs : Date.now();
    return planDepartures(route.samples, route.timed.totalTimeS, forecastLookupFn(getProviders(), forecasts), chosen, now);
  }, [route, forecasts, departure, slot, multiDay]);
  return { plan, tz };
}

function lessText(p: DeparturePlan, m: ReturnType<typeof useMessages>): string | null {
  const s = p.suggestion;
  if (!s) return null;
  const severe = p.current.severeMinutes - s.severeMinutes;
  const wet = p.current.wetMinutes - s.wetMinutes;
  if (severe >= 10) return m.depart.lessSevere(formatDuration(severe * 60, m));
  if (wet >= 10) return m.depart.lessRain(formatDuration(wet * 60, m));
  return null;
}

/** One line under the weather headline — only when another time is clearly better. */
export function DepartureTip() {
  const m = useMessages();
  const { plan, tz } = useDeparturePlan();
  const mode = useAppStore((s) => s.mode);
  if (!plan?.suggestion || mode !== 'planning') return null;
  const less = lessText(plan, m);
  if (!less) return null;
  const time = formatLocalTime(plan.suggestion.departMs, tz);
  const at = plan.suggestion.departMs;
  return (
    <p className="depart-tip">
      <span>{m.depart.suggest(time, less)}</span>
      <button className="linkbtn" onClick={() => useAppStore.getState().setDeparture({ mode: 'at', utcMs: at })}>
        {m.depart.use(time)}
      </button>
    </p>
  );
}

/** Next 12 hours of departures as bars: how much of the drive is in rain / severe weather. */
export function DepartureChart() {
  const m = useMessages();
  const { plan, tz } = useDeparturePlan();
  const totalMin = useAppStore((s) => (s.plan ? s.plan.timed.totalTimeS / 60 : 1));
  const chart = useRef<HTMLDivElement>(null);
  // Finger scrubbing: the bars are ~10 px wide on a phone, too narrow to hit one by one and with no hover to say
  // which time each is. Sliding a finger along the chart shows the time under it; lifting it picks that time.
  const [scrub, setScrub] = useState<{ start: number; at: number } | null>(null);
  // A touch stays captured by the bar it started on; if the browser still sends a click after a slide, that click
  // must not undo the slide's choice.
  const slid = useRef(false);
  if (!plan) return null;
  const choose = (i: number) => useAppStore.getState().setDeparture({ mode: 'at', utcMs: plan.options[i].departMs });
  const barAt = (clientX: number) => {
    const r = chart.current!.getBoundingClientRect();
    return Math.max(0, Math.min(plan.options.length - 1, Math.floor(((clientX - r.left) / r.width) * plan.options.length)));
  };
  const onPointerDown = (e: PointerEvent) => {
    slid.current = false;
    if (e.pointerType === 'mouse') return; // mouse users click the bar itself
    const i = barAt(e.clientX);
    setScrub({ start: i, at: i });
  };
  const onPointerMove = (e: PointerEvent) => {
    if (scrub) setScrub({ ...scrub, at: barAt(e.clientX) });
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!scrub) return;
    const i = barAt(e.clientX);
    setScrub(null);
    // A tap that stays on its bar is the bar's own click; only a slide to another bar is chosen here.
    if (i !== scrub.start) {
      slid.current = true;
      choose(i);
    }
  };
  const preview = scrub ? plan.options[scrub.at] : null;
  const scores = plan.options.map((o) => o.score);
  const varies = Math.max(...scores) - Math.min(...scores) >= 10;
  const pct = (min: number) => Math.min(100, (min / Math.max(1, totalMin)) * 100);
  const mid = plan.options[Math.floor(plan.options.length / 2)];
  const last = plan.options[plan.options.length - 1];
  return (
    <section className="depart">
      <h3 className="label">{m.depart.title}</h3>
      {!varies ? (
        <p className="depart__note">{m.depart.similar}</p>
      ) : (
        <>
          {plan.current === plan.best ? <p className="depart__note">{m.depart.currentBest}</p> : null}
          <div
            ref={chart}
            className="depart__chart"
            role="group"
            aria-label={m.depart.title}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => setScrub(null)}
          >
            {plan.options.map((o, i) => {
              const time = formatLocalTime(o.departMs, tz);
              const selected = o === plan.current;
              return (
                <button
                  key={o.departMs}
                  className={`depart__bar${selected ? ' is-current' : ''}${o === plan.best ? ' is-best' : ''}${o === preview ? ' is-preview' : ''}`}
                  aria-label={`${m.depart.bar(time, formatDuration(o.wetMinutes * 60, m))}${selected ? ` (${m.depart.selected})` : ''}`}
                  aria-pressed={selected}
                  onClick={() => {
                    if (slid.current) slid.current = false;
                    else choose(i);
                  }}
                >
                  <span className="depart__wet" style={{ height: `${Math.max(3, pct(o.wetMinutes))}%` }}>
                    <span className="depart__severe" style={{ height: `${o.wetMinutes ? (o.severeMinutes / o.wetMinutes) * 100 : 0}%` }} />
                  </span>
                </button>
              );
            })}
          </div>
          <div className="depart__axis tabular" aria-hidden="true">
            {preview ? (
              <span className="depart__readout">{m.depart.bar(formatLocalTime(preview.departMs, tz), formatDuration(preview.wetMinutes * 60, m))}</span>
            ) : (
              <>
                <span>{formatLocalTime(plan.options[0].departMs, tz)}</span>
                <span>{formatLocalTime(mid.departMs, tz)}</span>
                <span>{formatLocalTime(last.departMs, tz)}</span>
              </>
            )}
          </div>
          <p className="depart__legend">
            <span className="depart__key depart__key--wet" aria-hidden="true" /> {m.depart.legendRain}
            <span className="depart__key depart__key--severe" aria-hidden="true" /> {m.depart.legendSevere}
          </p>
        </>
      )}
    </section>
  );
}
