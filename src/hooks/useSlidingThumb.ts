import { useLayoutEffect, type RefObject } from 'react';

/**
 * A highlight that slides to the chosen option of a radio group (segmented controls, the travel modes), instead of
 * the old one switching off and the new one on. The track (class `thumb-track`, base.css) draws it as a
 * pseudo-element from CSS variables set here: one element moves, nothing else re-lays out.
 *
 * `key` is anything that changes with the choice (the value): the thumb is placed again when it changes, and
 * whenever the track resizes (rotation, longer label, the chosen option growing a duration).
 */
export function useSlidingThumb(ref: RefObject<HTMLElement | null>, key: unknown, selector = '[aria-checked="true"]'): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>(selector);
      if (!on || !on.offsetWidth) {
        el.style.setProperty('--thumb-o', '0');
        return;
      }
      el.style.setProperty('--thumb-x', `${on.offsetLeft}px`);
      el.style.setProperty('--thumb-y', `${on.offsetTop}px`);
      el.style.setProperty('--thumb-w', `${on.offsetWidth}px`);
      el.style.setProperty('--thumb-h', `${on.offsetHeight}px`);
      el.style.setProperty('--thumb-o', '1');
    };
    place();
    // Slide only after the first placement: on open the thumb is simply there.
    const raf = requestAnimationFrame(() => el.setAttribute('data-thumb-ready', ''));
    if (typeof ResizeObserver === 'undefined') return () => cancelAnimationFrame(raf);
    const ro = new ResizeObserver(place);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [ref, key, selector]);
}
