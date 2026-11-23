import { useEffect } from 'react';
import { useSettings } from '../state/settings';
import { useAppStore } from '../state/store';

/**
 * Drives the demo vehicle while playing.
 * - Pauses automatically when the tab is hidden (zero background CPU/battery drain).
 * - Paces frames to ~30 fps (or ~10 fps in battery saver) so mobile WebKit / low-end GPUs keep idle headroom
 *   between frames and never starve the compositor or UI thread (B-42).
 */
export function useSimulationLoop() {
  const playing = useAppStore((s) => s.mode === 'simulating' && s.sim.playing);
  const batterySaver = useSettings((s) => s.batterySaver);

  useEffect(() => {
    if (!playing) return;
    const minStepMs = batterySaver ? 100 : 32;
    let raf = 0;
    let last = performance.now();

    const frame = (t: number) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        raf = 0;
        return;
      }
      const elapsed = t - last;
      if (elapsed >= minStepMs) {
        // Clamp so a backgrounded tab or GC pause doesn't teleport the car.
        const dt = Math.min(250, elapsed);
        last = t;
        useAppStore.getState().advanceSimulationBy(dt);
      }
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (raf || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [playing, batterySaver]);
}
