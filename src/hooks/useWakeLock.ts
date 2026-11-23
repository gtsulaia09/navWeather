import { useEffect } from 'react';
import { getWakeLockProvider, type WakeLockHandle } from '../platform/wakeLock';

/**
 * Keep the screen on while it matters (navigating, sharing live location):
 * browsers stop location updates when the screen locks. Re-acquired when the
 * page becomes visible again (the system drops the lock when hidden).
 * Goes through `platform/wakeLock.ts` so React Native can bind native screen keep-awake.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    const provider = getWakeLockProvider();
    if (!active || !provider.supported) return;
    let lock: WakeLockHandle | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (lock && !lock.released) return;
      const l = await provider.acquire();
      if (!l) return;
      if (cancelled) void l.release();
      else lock = l;
    };
    const onVisible = () => void acquire();
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release();
    };
  }, [active]);
}
