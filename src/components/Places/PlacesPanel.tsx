import { useState } from 'react';
import { formatDistance } from '../../i18n/format';
import type { PoiCategory } from '../../services/places/PoiProvider';
import { useMessages, useSettings } from '../../state/settings';
import { useAppStore } from '../../state/store';
import { getProviders } from '../../services/providers';
import { chargingLine } from '../Explore/Nearby';
import { CloseIcon } from '../Icons/Icons';
import './Places.css';

const QUICK: PoiCategory[] = ['restaurant', 'cafe', 'fuel', 'ev_charging', 'car_wash', 'hotel', 'parking', 'rest_area', 'pharmacy', 'hospital'];
const INITIAL_VISIBLE = 6;

/**
 * "Places along my route" — prominent quick-discovery card covering the full
 * route from A to B (while planning) or ahead on the road (while driving),
 * with distance along the route and real detour time when available.
 */
export function PlacesPanel() {
  const m = useMessages();
  const units = useSettings((s) => s.units.distance);
  const poi = useAppStore((s) => s.poi);
  const [showAll, setShowAll] = useState(false);
  if (!getProviders().poi) return null;

  const total = poi?.status === 'ready' ? poi.results.length : 0;
  const visible = poi?.status === 'ready' ? (showAll ? poi.results : poi.results.slice(0, INITIAL_VISIBLE)) : [];

  const selectCategory = (c: PoiCategory) => {
    setShowAll(false);
    if (poi?.category === c) {
      useAppStore.getState().clearPoi();
      return;
    }
    void useAppStore.getState().searchPoi(c);
  };

  return (
    <section className="places" aria-label={m.ui.findAlongRoute}>
      <div className="places__head">
        <h3 className="places__title">{m.ui.findAlongRoute}</h3>
        {total > 0 ? <span className="places__count tabular">{total}</span> : null}
        {poi ? (
          <button
            type="button"
            className="places__clear"
            aria-label={m.ui.close}
            onClick={() => {
              setShowAll(false);
              useAppStore.getState().clearPoi();
            }}
          >
            <CloseIcon size={16} />
          </button>
        ) : null}
      </div>
      <div className="places__cats" role="group" aria-label={m.ui.findAlongRoute}>
        {QUICK.map((c) => {
          const active = poi?.category === c;
          return (
            <button
              key={c}
              type="button"
              className={`places__cat${active ? ' is-active' : ''}`}
              aria-pressed={active}
              onClick={() => selectCategory(c)}
            >
              {m.poi.categoryPlural[c]}
            </button>
          );
        })}
      </div>
      {poi?.status === 'loading' ? (
        <p className="places__status" role="status">
          <span className="spinner" aria-hidden="true" /> {m.poi.searching}
        </p>
      ) : null}
      {poi?.status === 'error' ? <p className="places__status">{m.poi.unavailable}</p> : null}
      {poi?.status === 'ready' && total === 0 ? <p className="places__status">{m.poi.none}</p> : null}
      {visible.length > 0 ? (
        <>
          <ul className="rows places__list">
            {visible.map((r) => {
              const name = r.poi.name ?? r.poi.brand ?? m.poi.unnamed(m.poi.category[r.poi.category]);
              const detourMin = r.detourS !== undefined ? Math.round(r.detourS / 60) : null;
              return (
                <li key={r.poi.id} className="place">
                  <span className="place__main">
                    <span className="place__name">{name}</span>
                    <span className="place__meta tabular">
                      {m.poi.ahead(formatDistance(r.aheadM, units, m))} ·{' '}
                      {r.offRouteM < 150 ? m.poi.onRoute : m.poi.offRoute(formatDistance(r.offRouteM, units, m))}
                    </span>
                    {r.poi.category === 'ev_charging' ? <span className="place__meta">{chargingLine(r.poi, m)}</span> : null}
                  </span>
                  {detourMin !== null ? <span className="place__detour tabular">{m.poi.detourMin(detourMin)}</span> : null}
                  <button
                    type="button"
                    className="btn btn-quiet place__add"
                    onClick={() =>
                      void useAppStore.getState().addStop({
                        id: r.poi.id,
                        name,
                        label: name,
                        coordinate: r.poi.coordinate,
                        kind: r.poi.category,
                      })
                    }
                  >
                    {m.poi.addStop}
                  </button>
                </li>
              );
            })}
          </ul>
          {total > INITIAL_VISIBLE ? (
            <button type="button" className="places__more" onClick={() => setShowAll((v) => !v)}>
              {showAll ? m.poi.showLess : m.poi.showAll(total)}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
