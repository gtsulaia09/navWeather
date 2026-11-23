/**
 * Single bootstrap hook that connects React Native native modules (MMKV, CoreLocation / FusedLocation,
 * react-native-fs, AVSpeechSynthesizer / Android TTS, KeepAwake, Share, Haptics, Notifications,
 * CarPlay, Android Auto, Watch/Wear OS) into wayther's shared `src/platform/*` seams (ADR-010).
 *
 * Keeps `src/*` 100% platform-neutral (enforced by `src/test/architecture.test.ts`).
 */
import { setFileCacheProvider, type FileCacheProvider } from '../../../src/platform/fileCache';
import { setHapticsProvider, type HapticsProvider } from '../../../src/platform/haptics';
import { setLocationProvider, type LocationProvider } from '../../../src/platform/location';
import { setNotificationProvider, type NotificationProvider } from '../../../src/platform/notifications';
import { setShareProvider, type ShareProvider } from '../../../src/platform/share';
import { setStorage, type KeyValueStore } from '../../../src/platform/storage';
import {
  setCarSurfaceBridge,
  setWristCompanionBridge,
  type CarSurfaceBridge,
  type WristCompanionBridge,
} from '../../../src/platform/surfaces';
import { setWakeLockProvider, type WakeLockProvider } from '../../../src/platform/wakeLock';
import { setTtsProvider, type TextToSpeechProvider } from '../../../src/voice/providers';

export interface NativePlatformAdapters {
  /** Synchronous key-value storage (e.g. `react-native-mmkv`). */
  storage?: { device?: KeyValueStore; session?: KeyValueStore };
  /** Offline `/data/*` binary file cache (e.g. `react-native-fs`). */
  fileCache?: FileCacheProvider | null;
  /** Native GPS (`CoreLocation` on iOS; `FusedLocationProviderClient` + FGS on Android). */
  location?: LocationProvider | null;
  /** Local notifications (`UNUserNotificationCenter` / `NotificationManagerCompat`). */
  notifications?: NotificationProvider | null;
  /** Screen wake lock (`UIApplication.isIdleTimerDisabled` / `FLAG_KEEP_SCREEN_ON`). */
  wakeLock?: WakeLockProvider | null;
  /** Native share sheet & clipboard. */
  share?: ShareProvider | null;
  /** Tactile feedback (`UIImpactFeedbackGenerator` / `VibrationEffect`). */
  haptics?: HapticsProvider | null;
  /** Spoken turn-by-turn & weather alerts (`AVSpeechSynthesizer` / Android `TextToSpeech`). */
  tts?: TextToSpeechProvider | null;
  /** CarPlay or Android Auto surface bridge (`carPlayBridge.ts` / `androidAutoBridge.ts`). */
  carSurface?: CarSurfaceBridge | null;
  /** Apple Watch or Wear OS glanceable companion (`wristBridge.ts`). */
  wristCompanion?: WristCompanionBridge | null;
}

/**
 * Call once at React Native startup (before mounting `<App />` or reading settings/routes).
 * Any omitted adapter safely falls back to the platform-neutral default/no-op.
 */
export function registerNativePlatform(adapters: NativePlatformAdapters): void {
  if (adapters.storage) setStorage(adapters.storage);
  if ('fileCache' in adapters) setFileCacheProvider(adapters.fileCache ?? null);
  if ('location' in adapters) setLocationProvider(adapters.location ?? null);
  if ('notifications' in adapters) setNotificationProvider(adapters.notifications ?? null);
  if ('wakeLock' in adapters) setWakeLockProvider(adapters.wakeLock ?? null);
  if ('share' in adapters) setShareProvider(adapters.share ?? null);
  if ('haptics' in adapters) setHapticsProvider(adapters.haptics ?? null);
  if ('tts' in adapters) setTtsProvider(adapters.tts ?? null);
  if ('carSurface' in adapters) setCarSurfaceBridge(adapters.carSurface ?? null);
  if ('wristCompanion' in adapters) setWristCompanionBridge(adapters.wristCompanion ?? null);
}
