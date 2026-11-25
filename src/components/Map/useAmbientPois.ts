import type { Map as MLMap, MapLayerMouseEvent } from 'maplibre-gl';
import { useEffect, useRef, type RefObject } from 'react';
import type { Poi, PoiCategory } from '../../services/places/PoiProvider';
import { getProviders } from '../../services/providers';
import { useExplore } from '../../state/explore';
import { useSettings } from '../../state/settings';
import { useAppStore } from '../../state/store';
import { EMPTY_FC, pointFeature, setData } from './mapLayers';

const CATEGORY_RANK: Record<PoiCategory, number> = {
  hospital: 1,
  supermarket: 1,
  fuel: 1,
  ev_charging: 1,
  attraction: 2,
  hotel: 2,
  pharmacy: 2,
  rest_area: 2,
  restaurant: 3,
  cafe: 3,
  atm: 4,
  car_repair: 4,
  car_wash: 4,
  parking: 5,
  toilets: 6,
};

function poiRank(p: Poi): number {
  const base = CATEGORY_RANK[p.category] ?? 4;
  if (p.brand && p.name) return base;
  if (p.name || p.brand) return base + 0.5;
  return base + 3;
}

/**
 * Ambient Georgia locations & POIs from our static `/data/places/v1` tiles (ADR-019: $0, zero Worker/third-party calls).
 *
 * Our Protomaps regional extract stops at z14 where Tilezen omits neighbourhood shops/supermarkets (Fresco, Carrefour,
 * pharmacies, cafes, fuel, ATMs). Reading the visible z11 static place tiles fills the map with clickable local places
 * as soon as the user zooms into a town or taps "Show my location", while hiding while driving so the HUD stays calm.
 */
export function useAmbientPois(mapRef: RefObject<MLMap | null>, styleVersion: number, viewer: boolean) {
  const language = useSettings((s) => s.language);
  const mode = useAppStore((s) => s.mode);
  const activeRouteCategory = useAppStore((s) => s.poi?.category ?? null);
  const activeNearbyCategory = useExplore((s) => s.nearby?.category ?? null);
  const byIdRef = useRef(new Map<string, Poi>());
  /** What the layer shows now: an unchanged set is not sent again (that re-placed and re-faded every icon). */
  const shownKey = useRef('');

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleVersion) return;
    const show = (key: string, fc: GeoJSON.FeatureCollection) => {
      if (key === shownKey.current) return;
      shownKey.current = key;
      setData(map, 'ambient-pois', fc);
    };
    // A new basemap style re-creates the source empty: send the set again.
    shownKey.current = '\u0000';
    if (viewer || mode !== 'planning') {
      byIdRef.current.clear();
      show('', EMPTY_FC);
      return;
    }

    let ctrl: AbortController | null = null;
    let timer = 0;

    const refresh = () => {
      const provider = getProviders().poi;
      if (!provider?.searchBounds) return;
      const zoom = map.getZoom();
      if (zoom < 11) {
        byIdRef.current.clear();
        show('', EMPTY_FC);
        return;
      }
      ctrl?.abort();
      const nextCtrl = new AbortController();
      ctrl = nextCtrl;
      const b = map.getBounds();
      const bbox: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      void provider
        .searchBounds(bbox, zoom, { signal: nextCtrl.signal, language })
        .then((pois) => {
          if (nextCtrl.signal.aborted) return;
          const skipCategory = activeRouteCategory ?? activeNearbyCategory;
          const visible = skipCategory ? pois.filter((p) => p.category !== skipCategory) : pois;
          const nextById = new Map<string, Poi>();
          const features: GeoJSON.Feature[] = [];
          for (const p of visible) {
            nextById.set(p.id, p);
            features.push(
              pointFeature(p.coordinate, {
                id: p.id,
                category: p.category,
                name: p.name ?? p.brand ?? '',
                rank: poiRank(p),
              }),
            );
          }
          byIdRef.current = nextById;
          show(`${language}|${[...nextById.keys()].join(',')}`, { type: 'FeatureCollection', features });
        })
        .catch(() => {
          /* aborted or unavailable */
        });
    };

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 120);
    };

    refresh();
    map.on('moveend', schedule);
    return () => {
      window.clearTimeout(timer);
      ctrl?.abort();
      map.off('moveend', schedule);
    };
  }, [mapRef, styleVersion, viewer, mode, language, activeRouteCategory, activeNearbyCategory]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleVersion || viewer) return;
    const onClick = (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id;
      const hit = typeof id === 'string' ? byIdRef.current.get(id) : undefined;
      const app = useAppStore.getState();
      if (!hit || app.mode !== 'planning') return;
      const ex = useExplore.getState();
      if (ex.directionsOpen && (ex.pickTarget !== null || !app.plan)) {
        const name = hit.name ?? hit.brand ?? hit.category;
        void ex.pickOnMap(hit.coordinate, {
          id: hit.id,
          name,
          label: name,
          coordinate: hit.coordinate,
          kind: hit.category,
        });
      } else {
        ex.openPoi(hit);
      }
    };
    const enter = () => (map.getCanvas().style.cursor = 'pointer');
    const leave = () => (map.getCanvas().style.cursor = '');
    map.on('click', 'ambient-pois', onClick);
    map.on('mouseenter', 'ambient-pois', enter);
    map.on('mouseleave', 'ambient-pois', leave);
    return () => {
      map.off('click', 'ambient-pois', onClick);
      map.off('mouseenter', 'ambient-pois', enter);
      map.off('mouseleave', 'ambient-pois', leave);
    };
  }, [mapRef, styleVersion, viewer]);
}
