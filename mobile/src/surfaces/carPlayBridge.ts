import type { CarSurfaceBridge, CompanionSnapshot } from '../../../src/platform/surfaces';

/**
 * CarPlay bridge adapter (MOBILE_STRATEGY §5, ADR-010).
 *
 * Maps our platform-free `CompanionSnapshot` onto Apple's CarPlay framework templates:
 *   - `CPMapTemplate` (base map rendered by MapLibre Native into the CarPlay window)
 *   - `CPNavigationSession` (`upcomingManeuvers`, `updateTravelEstimates`)
 *   - `CPNavigationAlert` — strictly ONE weather alert at a time, voice-first (never a timeline while moving)
 *
 * Distribution via App Store / TestFlight / CarPlay entitlement is BLOCKED by the Apple Developer Program fee ($99/yr,
 * ADR-015). Runs free in Xcode's CarPlay external display simulator when linked to a native Xcode target.
 */
export interface NativeCarPlayModule {
  isConnected(): boolean;
  updateManeuver(payload: {
    instruction: string;
    distanceM: number;
    etaMs: number | null;
    remainingDistanceM: number | null;
    remainingDurationS: number | null;
  }): void;
  showAlert(alert: { id: string; headline: string; detail?: string; severity: string } | null): void;
  endSession(): void;
}

export function createCarPlayBridge(nativeModule: NativeCarPlayModule | null): CarSurfaceBridge {
  return {
    name: 'ios-carplay',
    get connected() {
      return nativeModule?.isConnected() ?? false;
    },
    updateNavigation(snapshot: CompanionSnapshot) {
      if (!nativeModule || !snapshot.active) return;
      if (snapshot.nextManeuver) {
        nativeModule.updateManeuver({
          instruction: snapshot.nextManeuver.instruction,
          distanceM: snapshot.nextManeuver.distanceM,
          etaMs: snapshot.etaMs,
          remainingDistanceM: snapshot.remainingDistanceM,
          remainingDurationS: snapshot.remainingDurationS,
        });
      }
      // Driver distraction rule: at most ONE weather alert banner at a time.
      nativeModule.showAlert(
        snapshot.alert
          ? {
              id: snapshot.alert.id,
              headline: snapshot.alert.headline,
              detail: snapshot.alert.detail,
              severity: snapshot.alert.severity,
            }
          : null,
      );
    },
    endNavigation() {
      nativeModule?.endSession();
    },
  };
}
