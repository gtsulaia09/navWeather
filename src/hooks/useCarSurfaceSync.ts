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

  const weatherSegments = timed
    ? s.derived.routeSegments
        .map((seg) => ({
          coordinates: sampleCoords(sliceLine(timed.route.geometry, timed.cumDistM, seg.startM, seg.endM), 60),
          cls: seg.groupClass,
        }))
        .filter((seg) => seg.coordinates.length >= 2)
    : undefined;

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
    routeCoordinates: timed ? sampleCoords(timed.route.geometry, 240) : undefined,
    weatherSegments,
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

    const pushNow = () => {
      window.clearTimeout(timer);
      timer = 0;
      const car = getCarSurfaceBridge();
      const wrist = getWristCompanionBridge();
      if (car.name === 'none' && wrist.name === 'none') return;
      lastSentAt = performance.now();
      const snap = buildSnapshot();
      if (car.name !== 'none') {
        if (car.syncState) car.syncState(snap);
        else if (snap.active) car.updateNavigation(snap);
        if (wasActive && !snap.active) car.endNavigation();
      }
      if (wrist.name !== 'none') wrist.pushSnapshot(snap);
      wasActive = snap.active;
    };

    const schedulePush = () => {
      const car = getCarSurfaceBridge();
      const wrist = getWristCompanionBridge();
      if (car.name === 'none' && wrist.name === 'none') return;
      const active = useAppStore.getState().mode !== 'planning';
      const minGapMs = active ? 450 : 120;
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
          pushNow();
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
    pushNow();

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
