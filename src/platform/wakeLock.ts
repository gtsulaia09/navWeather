/**
 * SCREEN WAKE LOCK seam.
 * Web uses Screen Wake Lock API (`navigator.wakeLock`); React Native injects `UIApplication.isIdleTimerDisabled`
 * (iOS) or `FLAG_KEEP_SCREEN_ON` (Android) via `setWakeLockProvider(...)`.
 */
export interface WakeLockHandle {
  readonly released: boolean;
  release(): Promise<void>;
}

export interface WakeLockProvider {
  readonly name: string;
  readonly supported: boolean;
  acquire(): Promise<WakeLockHandle | null>;
}

export const webWakeLockProvider: WakeLockProvider = {
  name: 'web-wake-lock',
  get supported() {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator && typeof navigator.wakeLock?.request === 'function';
  },
  async acquire() {
    if (!this.supported) return null;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      return {
        get released() {
          return sentinel.released;
        },
        release: () => sentinel.release().catch(() => undefined),
      };
    } catch {
      return null;
    }
  },
};

let current: WakeLockProvider = webWakeLockProvider;

export function getWakeLockProvider(): WakeLockProvider {
  return current;
}

export function setWakeLockProvider(provider: WakeLockProvider | null): void {
  current = provider ?? webWakeLockProvider;
}
