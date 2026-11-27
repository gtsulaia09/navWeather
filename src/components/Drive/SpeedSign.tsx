import { speedLevel, speedLimitAt } from '../../algorithms/speedLimits';
import { speedValue } from '../../i18n/format';
import { useMessages, useSettings } from '../../state/settings';
import { useAppStore } from '../../state/store';

/**
 * Posted limit (from OSM, when known) + current speed (live GPS only).
 * Never encourages speeding; the note says signs take precedence.
 * The speed box changes colour the moment the speed is above the limit (amber), and turns red above it by more
 * than the tolerance — no waiting: a driver glancing at it must see it at once.
 */
export function SpeedSign() {
  const m = useMessages();
  const units = useSettings((s) => s.units.distance);
  const enabled = useSettings((s) => s.speedWarnings);
  const limit = useAppStore((s) => (s.progress ? speedLimitAt(s.speedLimits, s.progress.distanceAlongM) : null));
  const speedKmh = useAppStore((s) =>
    s.mode === 'navigating' && s.vehicle?.speedMps !== undefined && s.vehicle.speedMps >= 0 ? Math.round(s.vehicle.speedMps * 3.6) : null,
  );
  if (!enabled || (limit === null && speedKmh === null)) return null;
  const unit = units === 'imperial' ? m.units.mph : m.units.kmh;
  const level = speedLevel(speedKmh, limit);
  return (
    <div className={`speed${level === 'ok' ? '' : level === 'over' ? ' is-over' : ' is-over is-far-over'}`} title={m.ui.speedLimitNote}>
      {limit !== null ? (
        <span className="speed__sign tabular" aria-label={`${m.ui.speedLimit} ${speedValue(limit, units)} ${unit}`}>
          {speedValue(limit, units)}
        </span>
      ) : null}
      {speedKmh !== null ? (
        <span className="speed__now tabular" aria-label={`${m.ui.yourSpeed} ${speedValue(speedKmh, units)} ${unit}`}>
          {speedValue(speedKmh, units)}
          <small>{unit}</small>
        </span>
      ) : null}
      {level !== 'ok' ? <span className="sr-only" role="status">{m.ui.speedLimit}</span> : null}
    </div>
  );
}
