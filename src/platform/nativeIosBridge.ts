/**
 * Native iOS WebKit Bridge.
 *
 * Connects the platform seams (`src/platform/*` and `src/voice/providers.ts`) to the
 * native iOS shell (`ios/NavWeather/ViewController.swift`) when running inside WKWebView
 * via `window.webkit.messageHandlers`.
 */
import { setLocationProvider, type LocationProvider, type RawPosition, type RawPositionError } from './location';
import { setHapticsProvider, type HapticsProvider, type HapticKind } from './haptics';
import { setWakeLockProvider, type WakeLockProvider, type WakeLockHandle } from './wakeLock';
import { dispatchCarSurfaceCommand, setCarSurfaceBridge, type CarSurfaceBridge, type CarSurfaceCommand, type CompanionSnapshot } from './surfaces';
import { setTtsProvider, type TextToSpeechProvider } from '../voice/providers';
import { speakable } from '../voice/speakable';

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        nativeLocation?: { postMessage: (msg: unknown) => void };
        nativeHaptics?: { postMessage: (msg: unknown) => void };
        nativeWakeLock?: { postMessage: (msg: unknown) => void };
        nativeTTS?: { postMessage: (msg: unknown) => void };
        nativeCarPlay?: { postMessage: (msg: unknown) => void };
      };
    };
    __navweather_native_location_update?: (pos: RawPosition) => void;
    __navweather_native_location_error?: (err: RawPositionError) => void;
    __navweather_native_tts_end?: (id: number) => void;
    __navweather_native_carplay_status?: (connected: boolean) => void;
    __navweather_native_carplay_command?: (cmd: CarSurfaceCommand) => void;
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

    const stopIfIdle = (id: number) => {
      if (listeners.size === 0) {
        handlers.nativeLocation?.postMessage({ action: 'stopWatch', id });
      }
    };

    window.__navweather_native_location_update = (pos: RawPosition) => {
      for (const listener of Array.from(listeners.values())) {
        try {
          listener.success(pos);
        } catch {
          /* ignore listener errors */
        }
      }
    };

    window.__navweather_native_location_error = (err: RawPositionError) => {
      for (const listener of Array.from(listeners.values())) {
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
            stopIfIdle(id);
            onSuccess(pos);
          },
          error: (err) => {
            listeners.delete(id);
            stopIfIdle(id);
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
        stopIfIdle(id);
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

  // 4. Native Text-to-Speech Provider (AVSpeechSynthesizer with background audio support)
  if (handlers.nativeTTS) {
    let utteranceIdCounter = 1;
    const pendingOnEnd = new Map<number, () => void>();

    const finishUtterance = (id: number) => {
      const cb = pendingOnEnd.get(id);
      if (!cb) return;
      pendingOnEnd.delete(id);
      try {
        cb();
      } catch {
        /* ignore callback errors */
      }
    };

    window.__navweather_native_tts_end = (id: number) => {
      finishUtterance(id);
    };

    const nativeTts: TextToSpeechProvider = {
      name: 'ios-native-avspeech',
      supported: true,
      canSpeak: () => true,
      unlock: () => undefined,
      speak(text, opts) {
        const spoken = speakable(text, opts.lang).trim();
        if (!spoken) {
          opts.onEnd();
          return;
        }
        const id = utteranceIdCounter++;
        pendingOnEnd.set(id, opts.onEnd);
        handlers.nativeTTS?.postMessage({ action: 'speak', id, text: spoken, lang: opts.lang });
      },
      cancel() {
        const ids = Array.from(pendingOnEnd.keys());
        handlers.nativeTTS?.postMessage({ action: 'cancel' });
        for (const id of ids) {
          finishUtterance(id);
        }
      },
      preview(text, lang) {
        this.cancel();
        this.speak(text, { lang, onEnd: () => undefined });
      },
    };

    setTtsProvider(nativeTts);
  }

  // 5. Native CarPlay Surface Bridge (CPTemplateApplicationSceneDelegate + CPMapTemplate + CPNavigationSession)
  if (handlers.nativeCarPlay) {
    let connected = false;
    window.__navweather_native_carplay_status = (next: boolean) => {
      connected = Boolean(next);
      if (connected) dispatchCarSurfaceCommand({ action: 'requestSync' });
    };
    window.__navweather_native_carplay_command = (cmd: CarSurfaceCommand) => {
      if (cmd && typeof cmd === 'object' && 'action' in cmd) {
        dispatchCarSurfaceCommand(cmd);
      }
    };

    const postSnapshot = (snapshot: CompanionSnapshot) => {
      handlers.nativeCarPlay?.postMessage({ action: 'sync', snapshot });
    };

    const nativeCarPlayBridge: CarSurfaceBridge = {
      name: 'ios-native-carplay',
      get connected() {
        return connected;
      },
      syncState(snapshot) {
        postSnapshot(snapshot);
      },
      updateNavigation(snapshot) {
        postSnapshot(snapshot);
      },
      endNavigation() {
        handlers.nativeCarPlay?.postMessage({ action: 'endNavigation' });
      },
    };
    setCarSurfaceBridge(nativeCarPlayBridge);
    handlers.nativeCarPlay.postMessage({ action: 'ready' });
  }

  return true;
}
