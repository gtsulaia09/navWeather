import { useEffect, type RefObject } from 'react';

/**
 * Report an element's box (used for map padding and the insets floating controls sit on).
 *
 * The callback runs in the next animation frame, not inside the ResizeObserver callback: our callbacks change
 * state, which re-renders and resizes other observed elements in the same frame. Inside the observer that is a
 * "ResizeObserver loop": Safari then skips notifications ("loop completed with undelivered notifications"), and a
 * skipped one left the floating buttons where the sheet *used* to end (half under it) until something else
 * resized. A window resize also re-measures: an element pinned to the bottom moves when the viewport height
 * changes (rotation, browser bars) without changing size, so the observer alone would not report it.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>, onSize: (r: DOMRect) => void) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      onSize(el.getBoundingClientRect());
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener('resize', schedule);
    onSize(el.getBoundingClientRect());
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);
}
