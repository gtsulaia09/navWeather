import { lazy, Suspense, useEffect } from 'react';
import { ErrorBoundary } from './components/Common/ErrorBoundary';
import { MapWeatherChip } from './components/Explore/MapWeatherChip';
import { NearbySheet } from './components/Explore/Nearby';
import { LayerTimeline } from './components/Map/WeatherLayerControls';
import { LocationPrimer, NavPrompt, Notice } from './components/Notice/Notice';
import { PlanSheet } from './components/Plan/PlanSheet';
import { SearchPanel } from './components/Search/SearchPanel';
import { VoiceControls } from './components/Voice/VoiceControls';
import { useAppTimers } from './hooks/useAppTimers';
import { useApplyTheme } from './hooks/useEffectiveTheme';
import { useNetworkStatus } from './hooks/useNetworkStatus';
import { useAnimatedPresence } from './hooks/useAnimatedPresence';
import { useCarSurfaceSync } from './hooks/useCarSurfaceSync';
import { useVisibleViewport } from './hooks/useVisibleViewport';
import { useSimulationLoop } from './hooks/useSimulationLoop';
import { useWakeLock } from './hooks/useWakeLock';
import { parseLiveLink, parsePlaceUrl } from './share/links';
import { resumeLiveShare, useLiveShare } from './share/liveShare';
import { initTrip } from './state/trip';
import { locationWatcher, useExplore } from './state/explore';
import { useLayoutStore } from './state/layout';
import { useMessages, useSettings } from './state/settings';
import { useAppStore } from './state/store';
import './App.css';

// MapLibre is the heaviest dependency — load it after the shell paints.
const RouteMap = lazy(() => import('./components/Map/RouteMap'));
// Mode-specific and rarely-used UI split out of the main chunk (REQ-PERF-004, DEBT-009).
const loadSettings = () => import('./components/Settings/SettingsDialog').then((mod) => ({ default: mod.SettingsDialog }));
const loadDriveOverlay = () => import('./components/Drive/DriveOverlay');
const SettingsDialog = lazy(loadSettings);
const DriveOverlay = lazy(loadDriveOverlay);
const LiveApp = lazy(() => import('./components/Live/LiveApp'));
const PlaceSheet = lazy(() => import('./components/Explore/PlaceSheet').then((mod) => ({ default: mod.PlaceSheet })));
const ArrivalSheet = lazy(() => import('./components/Drive/ArrivalSheet').then((mod) => ({ default: mod.ArrivalSheet })));
const SharePlaceDialog = lazy(() => import('./components/Share/Share').then((mod) => ({ default: mod.SharePlaceDialog })));
const LiveShareDialog = lazy(() => import('./components/Share/Share').then((mod) => ({ default: mod.LiveShareDialog })));
const ShareStatus = lazy(() => import('./components/Share/Share').then((mod) => ({ default: mod.ShareStatus })));
// Development diagnostics; the import is dropped from production builds.
const DevPanel = import.meta.env.DEV ? lazy(() => import('./dev/DevPanel')) : null;

/** Opened from a live-location link? (/live/:id) */
const live = typeof location !== 'undefined' ? parseLiveLink(location.pathname) : null;

export default function App() {
  // Last line of defence: an unexpected error shows a way back instead of a blank page.
  return (
    <ErrorBoundary fallback={<CrashScreen />}>
      {live ? (
        <Suspense fallback={<div className="map-placeholder" aria-hidden="true" />}>
          <LiveApp id={live.id} peer={live.peer} useInsetVars={useInsetVars} useLocationSync={useLocationSync} />
        </Suspense>
      ) : (
        <MainApp />
      )}
    </ErrorBoundary>
  );
}

function CrashScreen() {
  const m = useMessages();
  return (
    <div className="crash" role="alert">
      <h1>{m.ui.crashTitle}</h1>
      <p>{m.ui.crashBody}</p>
      <button className="btn btn-primary" onClick={() => location.reload()}>
        {m.ui.reload}
      </button>
    </div>
  );
}

function MainApp() {
  useEffect(() => initTrip(), []);
  useAppTimers();
  useLocationSync();
  useOnLoad();
  useSimulationLoop();
  useNetworkStatus();
  useApplyTheme();
  useDisplayPointNaming();
  useInsetVars();
  useVisibleViewport();
  useCarSurfaceSync();
  useIdleChunkWarmup();
  const driving = useAppStore((s) => s.mode !== 'planning');
  const shareStatus = useLiveShare((s) => s.status);
  const shareDialogOpen = useLiveShare((s) => s.dialogOpen);
  const sharing = shareStatus === 'active';
  useWakeLock(driving || sharing);
  const hasCard = useExplore((s) => s.card !== null);
  const hasNearby = useExplore((s) => s.nearby !== null);
  const hasSharePlace = useExplore((s) => s.sharePlace !== null);
  const arrived = useAppStore((s) => s.arrival !== null);
  const hasPlan = useAppStore((s) => s.plan !== null);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const settingsAnim = useAnimatedPresence(settingsOpen, 300);
  const showShareStatus = shareStatus === 'active' || shareStatus === 'paused';
  const m = useMessages();

  return (
    <div className="app">
      <ErrorBoundary fallback={<div className="map-placeholder map-placeholder--error">{m.ui.mapUnavailable}</div>}>
        <Suspense fallback={<div className="map-placeholder" aria-hidden="true" />}>
          <RouteMap />
        </Suspense>
      </ErrorBoundary>
      {!driving && !arrived ? <SearchPanel /> : null}
      {driving ? (
        <Suspense fallback={null}>
          <DriveOverlay />
        </Suspense>
      ) : null}
      <VoiceControls />
      {showShareStatus || !driving ? (
        <div className="map-status-stack">
          {showShareStatus ? (
            <Suspense fallback={null}>
              <ShareStatus />
            </Suspense>
          ) : null}
          {!driving ? <MapWeatherChip /> : null}
        </div>
      ) : null}
      {!driving && !arrived ? <LayerTimeline /> : null}
      <Notice />
      {arrived ? (
        <Suspense fallback={null}>
          <ArrivalSheet />
        </Suspense>
      ) : driving ? null : hasCard ? (
        <Suspense fallback={null}>
          <PlaceSheet />
        </Suspense>
      ) : hasNearby && !hasPlan ? (
        <NearbySheet />
      ) : (
        <PlanSheet />
      )}
      {settingsAnim.mounted ? (
        <Suspense fallback={null}>
          <SettingsDialog closing={settingsAnim.closing} />
        </Suspense>
      ) : null}
      <LocationPrimer />
      <NavPrompt />
      {hasSharePlace ? (
        <Suspense fallback={null}>
          <SharePlaceDialog />
        </Suspense>
      ) : null}
      {shareDialogOpen ? (
        <Suspense fallback={null}>
          <LiveShareDialog />
        </Suspense>
      ) : null}
      {DevPanel ? (
        <Suspense fallback={null}>
          <DevPanel />
        </Suspense>
      ) : null}
    </div>
  );
}

/** Pre-warm essential lazy UI chunks once the shell is idle so offline opening never fails (B-12). */
function useIdleChunkWarmup() {
  useEffect(() => {
    if (typeof window === 'undefined' || !navigator.onLine || useSettings.getState().batterySaver) return;
    const warm = () => {
      void loadSettings().catch(() => undefined);
      void loadDriveOverlay().catch(() => undefined);
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(warm, { timeout: 5000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(warm, 4000);
    return () => window.clearTimeout(t);
  }, []);
}

/**
 * One device-location watcher, shared: "show my location", GPS navigation,
 * and live sharing each hold it while they need it.
 */
function useLocationSync() {
  useEffect(() => {
    locationWatcher.setBatterySaver(useSettings.getState().batterySaver);
    const unsubs = [
      useSettings.subscribe((s, prev) => {
        if (s.batterySaver !== prev.batterySaver) locationWatcher.setBatterySaver(s.batterySaver);
      }),
      useAppStore.subscribe(
        (s) => s.mode === 'navigating',
        (on) => (on ? locationWatcher.acquire('navigate') : locationWatcher.release('navigate')),
        { fireImmediately: true },
      ),
      useExplore.subscribe(
        (s) => s.locate !== 'off',
        (on) => (on ? locationWatcher.acquire('locate') : locationWatcher.release('locate')),
        { fireImmediately: true },
      ),
    ];
    // Sharing needs real GPS unless a simulated drive is what's being shared.
    const syncShare = () => {
      const want = useLiveShare.getState().status === 'active' && useAppStore.getState().mode !== 'simulating';
      if (want) locationWatcher.acquire('share');
      else locationWatcher.release('share');
    };
    syncShare();
    unsubs.push(useLiveShare.subscribe(syncShare), useAppStore.subscribe((s) => s.mode, syncShare));
    return () => unsubs.forEach((u) => u());
  }, []);
}

/** Shared place links (?p=lat,lon&n=Name) and a live share left running before a reload. */
function useOnLoad() {
  useEffect(() => {
    const place = parsePlaceUrl(location.search);
    if (place) useExplore.getState().selectPlace(place, 'link');
    resumeLiveShare();
  }, []);
}

/** Expose overlay insets to CSS (floating controls sit just above the sheet). */
function useInsetVars() {
  const insets = useLayoutStore((s) => s.insets);
  useEffect(() => {
    const st = document.documentElement.style;
    st.setProperty('--inset-bottom', `${insets.bottom}px`);
    st.setProperty('--inset-top', `${insets.top}px`);
    st.setProperty('--inset-left', `${insets.left}px`);
  }, [insets.bottom, insets.top, insets.left]);
  // Floating map buttons step aside while a sheet covers the map.
  const covers = useLayoutStore((s) => s.sheetCovers);
  useEffect(() => {
    document.documentElement.toggleAttribute('data-sheet-covers', covers);
  }, [covers]);
}

/** Name the few visible points that have no settlement nearby (lazy reverse geocoding). */
function useDisplayPointNaming() {
  // Keyed by ids so fast re-derives (simulation) don't starve the debounce.
  const key = useAppStore((s) => s.derived.displayPoints.filter((p) => !p.placeName).map((p) => p.id).join('|'));
  useEffect(() => {
    if (!key) return;
    const t = window.setTimeout(() => void useAppStore.getState().nameDisplayPoints(), 400);
    return () => window.clearTimeout(t);
  }, [key]);
}
