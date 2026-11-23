import type { CarSurfaceBridge, CompanionSnapshot } from '../../../src/platform/surfaces';

/**
 * Android Auto bridge adapter (MOBILE_STRATEGY §6, ADR-010).
 *
 * Maps our platform-free `CompanionSnapshot` onto Android's Car App Library:
 *   - `CarAppService` with `androidx.car.app.category.NAVIGATION`
 *   - `NavigationTemplate` + `NavigationManager.navigationStarted() / updateTrip() / navigationEnded()`
 *   - Map drawn onto the provided Surface via MapLibre Native
 *   - Strictly ONE weather alert banner at a time, voice-first
 *
 * Play Store distribution ($25 once) is BLOCKED by ADR-015; free route: Android Auto Desktop Head Unit (DHU) and
 * non-Play sideloading with phone Developer Settings -> "Unknown sources".
 */
export interface NativeAndroidAutoModule {
  isConnected(): boolean;
  updateTrip(payload: {
    destination: string;
    instruction: string;
    distanceToNextM: number;
    remainingDistanceM: number;
    remainingDurationS: number;
    etaMs: number;
    alertHeadline?: string;
  }): void;
  navigationEnded(): void;
}

export function createAndroidAutoBridge(nativeModule: NativeAndroidAutoModule | null): CarSurfaceBridge {
  return {
    name: 'android-auto',
    get connected() {
      return nativeModule?.isConnected() ?? false;
    },
    updateNavigation(snapshot: CompanionSnapshot) {
      if (!nativeModule || !snapshot.active || !snapshot.nextManeuver) return;
      nativeModule.updateTrip({
        destination: snapshot.destinationName ?? '',
        instruction: snapshot.nextManeuver.instruction,
        distanceToNextM: snapshot.nextManeuver.distanceM,
        remainingDistanceM: snapshot.remainingDistanceM ?? 0,
        remainingDurationS: snapshot.remainingDurationS ?? 0,
        etaMs: snapshot.etaMs ?? snapshot.updatedAtMs,
        alertHeadline: snapshot.alert?.headline,
      });
    },
    endNavigation() {
      nativeModule?.navigationEnded();
    },
  };
}
