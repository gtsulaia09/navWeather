import { useEffect } from 'react';
import { formatDuration } from '../i18n/format';
import { instructionText } from '../navigation/instructions';
import {
  buildCompanionSnapshot,
  getCarSurfaceBridge,
  getWristCompanionBridge,
  setCarCommandListener,
  type CarSurfaceCommand,
  type CompanionSnapshot,
  type SurfaceAlert,
  type SurfaceRouteOption,
  type SurfaceSavedPlace,
} from '../platform/surfaces';
import type { PoiCategory } from '../services/places/PoiProvider';
import { useExplore } from '../state/explore';
import { quickPlaces, useSavedPlaces } from '../state/savedPlaces';
import { currentMessages, useSettings } from '../state/settings';
import { useAppStore } from '../state/store';
import type { LngLat } from '../types/geo';
import { sliceLine } from '../utils/distance';
import { exposureLine, roadNames } from '../components/Plan/RouteOptions';

/** Downsample a polyline to at most `maxPoints` vertices while keeping start and end exact. */
function sampleCoords(coords: LngLat[], maxPoints = 240): [number, number][] {
  if (coords.length <= maxPoints) return coords.map(([lon, lat]) => [lon, lat]);
  const out: [number, number][] = [];
  const step = (coords.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints - 1; i++) {
    const [lon, lat] = coords[Math.round(i * step)];
    out.push([lon, lat]);
  }
  const [endLon, endLat] = coords[coords.length - 1];
  out.push([endLon, endLat]);
  return out;
}

/** Route geometry for the surfaces, computed once per route and weather colouring (not on every update). */
let geometryCache: {
  timed: unknown;
  segments: unknown;
  key: string;
  routeCoordinates: [number, number][];
  weatherSegments: { coordinates: [number, number][]; cls: string }[];
} | null = null;
let geometrySeq = 0;

function routeGeometry(): typeof geometryCache {
  const s = useAppStore.getState();
  const timed = s.plan?.timed ?? null;
  if (!timed) return null;
  if (geometryCache && geometryCache.timed === timed && geometryCache.segments === s.derived.routeSegments) return geometryCache;
  geometryCache = {
    timed,
    segments: s.derived.routeSegments,
    key: `r${++geometrySeq}`,
    routeCoordinates: sampleCoords(timed.route.geometry, 240),
    weatherSegments: s.derived.routeSegments
      .map((seg) => ({
        coordinates: sampleCoords(sliceLine(timed.route.geometry, timed.cumDistM, seg.startM, seg.endM), 60),
        cls: seg.groupClass,
      }))
      .filter((seg) => seg.coordinates.length >= 2),
  };
  return geometryCache;
}

function buildSnapshot(): CompanionSnapshot {
  const s = useAppStore.getState();
  const m = currentMessages();
  const settings = useSettings.getState();
  const active = s.mode !== 'planning';
  const timed = s.plan?.timed ?? null;

  const instruction =
    active && s.guidance?.next ? instructionText(s.guidance.next, m) : undefined;

  let alert: SurfaceAlert | null = null;
  if (active && s.activeAlert) {
    const sub = [m.time.in(formatDuration(s.activeAlert.minutes * 60, m)), s.activeAlert.message].filter(Boolean).join(' · ');
    alert = {
      id: s.activeAlert.id,
      headline: s.activeAlert.title,
      detail: sub,
      severity: s.activeAlert.severity === 'critical' ? 'critical' : s.activeAlert.severity === 'high' ? 'high' : 'medium',
      inSeconds: Math.max(0, Math.round(s.activeAlert.minutes * 60)),
    };
  }

  const nextWx = s.derived.intelligence.ahead.find((e) => e.category === 'weather' && e.severity !== 'low');
  const nextWeatherEvent: CompanionSnapshot['nextWeatherEvent'] = nextWx
    ? {
        label: nextWx.shortMessage ? `${nextWx.title} · ${nextWx.shortMessage}` : nextWx.title,
        condition: 'RAIN',
        atMs: Date.now() + nextWx.estimatedMinutesFromCurrent * 60_000,
        distanceM: Math.max(0, Math.round(nextWx.estimatedMinutesFromCurrent * 60 * 14)),
      }
    : null;

  const names = roadNames(s.derived.options, m);
  const routeOptions: SurfaceRouteOption[] = s.routeOptions.map((opt, index) => {
    const summary = s.derived.options.find((o) => o.index === index);
    return {
      index,
      name: names.get(index) ?? `${m.ui.alternative} ${index + 1}`,
      durationS: Math.round(opt.timed.totalTimeS),
      distanceM: Math.round(opt.timed.totalDistM),
      weatherNote: summary?.hasWeather ? exposureLine(summary, m, 1) : '',
      selected: index === s.selectedOption,
    };
  });

  const savedPlaces: SurfaceSavedPlace[] = quickPlaces()
    .slice(0, 12)
    .map((q) => ({
      id: q.place.id,
      name:
        q.slot === 'home'
          ? m.explore.home
          : q.slot === 'work'
            ? m.explore.work
            : q.slot === 'parking'
              ? m.parking.title
              : q.place.name,
      subtitle: q.slot === 'home' || q.slot === 'work' ? q.place.name : (q.place.label ?? ''),
      slot: q.slot,
      coordinate: [q.place.coordinate[0], q.place.coordinate[1]],
    }));

  const geometry = routeGeometry();

  const base = buildCompanionSnapshot({
    active,
    destinationName: timed?.route.destination.name ?? null,
    progress: s.progress,
    guidance: s.guidance,
    instructionText: instruction,
    alert,
    nextWeatherEvent,
    nowMs: Date.now(),
  });

  return {
    ...base,
    originName: timed?.route.origin.name ?? null,
    weatherSummary: s.derived.summary?.headline
      ? [s.derived.summary.headline, s.derived.summary.detail].filter(Boolean).join(' · ')
      : null,
    routeKey: geometry?.key ?? null,
    routeCoordinates: geometry?.routeCoordinates,
    weatherSegments: geometry?.weatherSegments,
    vehicle: s.vehicle
      ? {
          coordinate: [s.vehicle.coordinate[0], s.vehicle.coordinate[1]],
          headingDeg: s.vehicle.headingDeg,
          speedMps: s.vehicle.speedMps,
        }
      : useExplore.getState().myLocation
        ? {
            coordinate: [
              useExplore.getState().myLocation!.coordinate[0],
              useExplore.getState().myLocation!.coordinate[1],
            ],
            headingDeg: useExplore.getState().myLocation!.headingDeg,
            speedMps: useExplore.getState().myLocation!.speedMps,
          }
        : null,
    routeOptions,
    savedPlaces,
    units: settings.units.distance,
    locale: settings.language,
  };
}

/**
 * Keeps CarPlay / Android Auto / wrist companion surfaces in step with the app's deterministic route, navigation,
 * and single-alert weather state, and handles commands sent back from the car display.
 */
export function useCarSurfaceSync(): void {
  useEffect(() => {
    let lastSentAt = 0;
    let timer = 0;
    let wasActive = useAppStore.getState().mode !== 'planning';
    /** Route geometry the car already has; null after (re)connecting, so it is sent in full. */
    let carRouteKey: string | null | undefined = undefined;
    let wristRouteKey: string | null | undefined = undefined;
    /** The light part of the last snapshot sent: an identical one is not sent again. */
    let lastLight = '';

    // Only to a surface that is there: the iOS shell always has the CarPlay bridge, but building and posting a
    // snapshot (route, weather stretches, places) to native code on every change, with no car connected, was
    // steady main-thread work on the phone — felt as stutters while planning and driving.
    const carOn = () => {
      const car = getCarSurfaceBridge();
      return car.name !== 'none' && car.connected;
    };
    const wristOn = () => {
      const wrist = getWristCompanionBridge();
      return wrist.name !== 'none' && wrist.connected;
    };

    const pushNow = (force = false) => {
      window.clearTimeout(timer);
      timer = 0;
      const car = getCarSurfaceBridge();
      const wrist = getWristCompanionBridge();
      const toCar = carOn();
      const toWrist = wristOn();
      if (!toCar) carRouteKey = undefined;
      if (!toWrist) wristRouteKey = undefined;
      if (!toCar && !toWrist) return;
      const snap = buildSnapshot();
      const { routeCoordinates, weatherSegments, ...light } = snap;
      const lightKey = JSON.stringify({ ...light, updatedAtMs: 0 });
      const carKnows = !toCar || carRouteKey === snap.routeKey;
      const wristKnows = !toWrist || wristRouteKey === snap.routeKey;
      if (!force && lightKey === lastLight && carKnows && wristKnows) return;
      lastLight = lightKey;
      lastSentAt = performance.now();
      const forSurface = (known: string | null | undefined): CompanionSnapshot =>
        known === snap.routeKey && known !== undefined ? light : { ...light, routeCoordinates, weatherSegments };
      if (toCar) {
        const out = forSurface(carRouteKey);
        carRouteKey = snap.routeKey;
        if (car.syncState) car.syncState(out);
        else if (snap.active) car.updateNavigation(out);
        if (wasActive && !snap.active) car.endNavigation();
      }
      if (toWrist) {
        wrist.pushSnapshot(forSurface(wristRouteKey));
        wristRouteKey = snap.routeKey;
      }
      wasActive = snap.active;
    };

    const schedulePush = () => {
      if (!carOn() && !wristOn()) return;
      const active = useAppStore.getState().mode !== 'planning';
      const minGapMs = active ? 450 : 200;
      const elapsed = performance.now() - lastSentAt;
      if (elapsed >= minGapMs) {
        pushNow();
      } else if (!timer) {
        timer = window.setTimeout(pushNow, minGapMs - elapsed);
      }
    };

    const handleCommand = (cmd: CarSurfaceCommand) => {
      const app = useAppStore.getState();
      const ex = useExplore.getState();
      switch (cmd.action) {
        case 'requestSync':
          // A (re)connected car: everything again, geometry included.
          carRouteKey = undefined;
          wristRouteKey = undefined;
          pushNow(true);
          break;
        case 'routeTo': {
          const place = {
            id: cmd.place.id,
            name: cmd.place.name,
            label: cmd.place.label ?? cmd.place.name,
            coordinate: cmd.place.coordinate as LngLat,
          };
          void ex.directionsTo(place);
          break;
        }
        case 'selectRouteOption':
          void app.selectRouteOption(cmd.index);
          break;
        case 'startNavigation':
          if (app.plan) {
            // On CarPlay the user explicitly tapped Start on the car screen: start GPS guidance directly.
            app.startNavigation();
          }
          break;
        case 'stopNavigation':
          if (app.mode === 'navigating') app.stopNavigation();
          else if (app.mode === 'simulating') app.exitSimulation();
          break;
        case 'dismissAlert':
          app.dismissAlert();
          break;
        case 'searchNearby':
          void ex.searchNearby(cmd.category as PoiCategory);
          break;
      }
    };

    setCarCommandListener(handleCommand);
    pushNow(true);

    const unsubs = [
      useAppStore.subscribe(schedulePush),
      useSavedPlaces.subscribe(schedulePush),
      useSettings.subscribe(schedulePush),
      useExplore.subscribe((s) => s.myLocation, schedulePush),
    ];

    return () => {
      window.clearTimeout(timer);
      setCarCommandListener(null);
      unsubs.forEach((u) => u());
    };
  }, []);
}
