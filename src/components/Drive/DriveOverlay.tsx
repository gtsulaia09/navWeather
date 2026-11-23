import { useRef } from 'react';
import { useElementSize } from '../../hooks/useElementSize';
import { useLayoutStore } from '../../state/layout';
import { useMessages } from '../../state/settings';
import { useAppStore } from '../../state/store';
import { AlertBanner } from './AlertBanner';
import { DriveSheet } from './DriveSheet';
import { HazardSign } from './HazardSign';
import { ManeuverBanner } from './ManeuverBanner';
import { ReportDialog, ReportPrompt } from './Reports';
import { RerouteOffer } from './RerouteOffer';
import { SpeedSign } from './SpeedSign';
import './Drive.css';

/** All active-driving UI in one lazy chunk so initial explore/planning loads faster (REQ-PERF-004). */
export default function DriveOverlay() {
  const arrived = useAppStore((s) => s.arrival !== null);
  const reportDialogOpen = useAppStore((s) => s.reportDialogOpen);
  const m = useMessages();

  return (
    <>
      {!arrived ? <DriveTop /> : null}
      {!arrived ? (
        <section className="drive-signs" aria-label={m.ui.roadSigns}>
          <HazardSign />
          <SpeedSign />
        </section>
      ) : null}
      {!arrived ? <DriveSheet /> : null}
      {reportDialogOpen ? <ReportDialog /> : null}
    </>
  );
}

function DriveTop() {
  const ref = useRef<HTMLDivElement>(null);
  const setInsets = useLayoutStore((s) => s.setInsets);
  useElementSize(ref, (r) => setInsets({ top: Math.round(r.bottom) }));
  return (
    <div className="drive-top" ref={ref}>
      <ManeuverBanner />
      <AlertBanner />
      <RerouteOffer />
      <ReportPrompt />
    </div>
  );
}
