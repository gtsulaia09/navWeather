/**
 * Native iOS WebKit Bridge.
 *
 * Connects the platform seams (`src/platform/*`) to the native iOS shell when running inside
 * WKWebView via `window.webkit.messageHandlers`.
 */
import { setLocationProvider, type LocationProvider, type RawPosition, type RawPositionError } from './location';
import { setHapticsProvider, type HapticsProvider, type HapticKind } from './haptics';
import { setWakeLockProvider, type WakeLockProvider, type WakeLockHandle } from './wakeLock';

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        nativeLocation?: { postMessage: (msg: unknown) => void };
        nativeHaptics?: { postMessage: (msg: unknown) => void };
        nativeWakeLock?: { postMessage: (msg: unknown) => void };
        nativeTTS?: { postMessage: (msg: unknown) => void };
      };
    };
    __navweather_native_location_update?: (pos: RawPosition) => void;
    __navweather_native_location_error?: (err: RawPositionError) => void;
  }
}

export function initNativeIosBridge(): boolean {
  if (typeof window === 'undefined' || !window.webkit?.messageHandlers) {
    return false;
  }

  const handlers = window.webkit.messageHandlers;

  // 1. Native Location Provider (iOS CoreLocation with background navigation support)
  if (handlers.nativeLocation) {
    let watchIdCounter = 1;
    const listeners = new Map<number, { success: (pos: RawPosition) => void; error?: (err: RawPositionError) => void }>();

    window.__navweather_native_location_update = (pos: RawPosition) => {
      for (const listener of listeners.values()) {
        try {
          listener.success(pos);
        } catch {
          /* ignore listener errors */
        }
      }
    };

    window.__navweather_native_location_error = (err: RawPositionError) => {
      for (const listener of listeners.values()) {
        try {
          listener.error?.(err);
        } catch {
          /* ignore listener errors */
        }
      }
    };

    const nativeLocationProvider: LocationProvider = {
      name: 'ios-native-corelocation',
      isSecureContext: () => true,
      supported: true,
      getCurrentPosition(onSuccess, onError) {
        const id = watchIdCounter++;
        listeners.set(id, {
          success: (pos) => {
            listeners.delete(id);
            onSuccess(pos);
          },
          error: (err) => {
            listeners.delete(id);
            onError(err);
          },
        });
        handlers.nativeLocation?.postMessage({ action: 'getCurrentPosition', id });
      },
      watchPosition(onSuccess, onError) {
        const id = watchIdCounter++;
        listeners.set(id, { success: onSuccess, error: onError });
        handlers.nativeLocation?.postMessage({ action: 'startWatch', id });
        return id;
      },
      clearWatch(id) {
        listeners.delete(id);
        if (listeners.size === 0) {
          handlers.nativeLocation?.postMessage({ action: 'stopWatch', id });
        }
      },
    };

    setLocationProvider(nativeLocationProvider);
  }

  // 2. Native Haptics Provider (UIImpactFeedbackGenerator / UINotificationFeedbackGenerator)
  if (handlers.nativeHaptics) {
    const nativeHaptics: HapticsProvider = {
      name: 'ios-native-haptics',
      trigger(kind: HapticKind) {
        handlers.nativeHaptics?.postMessage({ kind });
      },
    };
    setHapticsProvider(nativeHaptics);
  }

  // 3. Native Wake Lock Provider (UIApplication.isIdleTimerDisabled)
  if (handlers.nativeWakeLock) {
    const nativeWakeLock: WakeLockProvider = {
      name: 'ios-native-wakelock',
      supported: true,
      async acquire(): Promise<WakeLockHandle> {
        handlers.nativeWakeLock?.postMessage({ active: true });
        let released = false;
        return {
          get released() {
            return released;
          },
          async release() {
            if (!released) {
              released = true;
              handlers.nativeWakeLock?.postMessage({ active: false });
            }
          },
        };
      },
    };
    setWakeLockProvider(nativeWakeLock);
  }

  return true;
}
