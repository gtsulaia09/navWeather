import { lazy, Suspense, useEffect } from 'react';
import { ErrorBoundary } from '../Common/ErrorBoundary';
import { LocateButton } from '../Map/LocateButton';
import { Notice } from '../Notice/Notice';
import { LiveView } from './LiveView';
import { useAppTimers } from '../../hooks/useAppTimers';
import { useApplyTheme } from '../../hooks/useEffectiveTheme';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import { useVisibleViewport } from '../../hooks/useVisibleViewport';
import { useViewer } from '../../share/viewer';
import { useMessages } from '../../state/settings';

const RouteMap = lazy(() => import('../Map/RouteMap'));

/** Someone else's live location (read-only) — loaded in its own chunk only on `/live/:id`. */
export default function LiveApp({
  id,
  peer,
  useInsetVars,
  useLocationSync,
}: {
  id: string;
  peer: boolean;
  useInsetVars: () => void;
  useLocationSync: () => void;
}) {
  useAppTimers();
  useNetworkStatus();
  useApplyTheme();
  useInsetVars();
  useVisibleViewport();
  useLocationSync();
  const m = useMessages();
  useEffect(() => {
    useViewer.getState().start(id, { peer });
    return () => useViewer.getState().stop();
  }, [id, peer]);
  return (
    <div className="app">
      <ErrorBoundary fallback={<div className="map-placeholder map-placeholder--error">{m.ui.mapUnavailable}</div>}>
        <Suspense fallback={<div className="map-placeholder" aria-hidden="true" />}>
          <RouteMap viewer />
        </Suspense>
      </ErrorBoundary>
      <div className="voice">
        <LocateButton />
      </div>
      <Notice />
      <LiveView />
    </div>
  );
}
