import type { CompanionSnapshot, WristCompanionBridge } from '../../../src/platform/surfaces';

/**
 * Glanceable wrist companion bridge for Apple Watch (WatchConnectivity) and Wear OS (DataClient).
 * Scope: next maneuver, distance, ETA, and next weather event — no map required.
 *
 * Free routes: Wear OS sideloading via ADB/APK; watchOS in Xcode Watch Simulator (App Store distribution blocked by
 * Apple Developer Program $99/yr fee, ADR-015).
 */
export interface NativeWristModule {
  readonly platform: 'watchos' | 'wearos';
  isPaired(): boolean;
  sendContext(payload: {
    active: boolean;
    maneuver: string | null;
    distanceM: number | null;
    etaMs: number | null;
    nextWeather: string | null;
  }): void;
}

export function createWristCompanionBridge(nativeModule: NativeWristModule | null): WristCompanionBridge {
  return {
    name: nativeModule?.platform ?? 'wrist-none',
    get connected() {
      return nativeModule?.isPaired() ?? false;
    },
    pushSnapshot(snapshot: CompanionSnapshot) {
      if (!nativeModule) return;
      nativeModule.sendContext({
        active: snapshot.active,
        maneuver: snapshot.nextManeuver?.instruction ?? null,
        distanceM: snapshot.nextManeuver?.distanceM ?? null,
        etaMs: snapshot.etaMs,
        nextWeather: snapshot.nextWeatherEvent?.label ?? snapshot.alert?.headline ?? null,
      });
    },
  };
}
