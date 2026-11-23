import { formatDuration } from '../../i18n/format';
import { useMessages } from '../../state/settings';
import { useAppStore } from '../../state/store';
import { TRAVEL_MODES, type TravelMode } from '../../types/travel';
import { BikeIcon, CarIcon, FlightIcon, TransitIcon, WalkIcon } from '../Icons/Icons';
import './TravelModeBar.css';

const ICONS: Record<TravelMode, typeof CarIcon> = { drive: CarIcon, walk: WalkIcon, bike: BikeIcon, transit: TransitIcon, flight: FlightIcon };
const DISABLED_MODES: ReadonlySet<TravelMode> = new Set(['flight']);

/**
 * How are you getting there? Car, walking, bicycle, public transport, flight —
 * the chosen way shows how long the trip takes. Changing it shows the trip that
 * way at once, with the weather you would meet on it.
 */
export function TravelModeBar() {
  const m = useMessages();
  const travelMode = useAppStore((s) => s.travelMode);
  const durationS = useAppStore((s) => (s.plan ? s.plan.timed.totalTimeS : null));
  return (
    <div className="tmodes" role="radiogroup" aria-label={m.travel.label}>
      {TRAVEL_MODES.map((k) => {
        const Icon = ICONS[k];
        const isDisabled = DISABLED_MODES.has(k);
        const on = !isDisabled && k === travelMode;
        const label = m.travel[k];
        const title = isDisabled && k === 'flight' ? (m.travel.flightDisabled ?? label) : label;
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={label}
            aria-disabled={isDisabled || undefined}
            disabled={isDisabled}
            tabIndex={isDisabled ? -1 : undefined}
            title={title}
            className={`tmode${on ? ' is-on' : ''}${isDisabled ? ' is-disabled' : ''}`}
            onClick={() => {
              if (!isDisabled) useAppStore.getState().setTravelMode(k);
            }}
          >
            <Icon size={20} />
            {on && durationS !== null ? <span className="tmode__time tabular">{formatDuration(durationS, m)}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
