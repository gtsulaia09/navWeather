import { useEffect } from 'react';

/** The part of the layout viewport the on-screen keyboard leaves visible, as distances from its top and bottom. */
export interface VisibleInsets {
  top: number;
  bottom: number;
}

/**
 * Android Chrome (by default) and iOS Safari keep the page's height when the keyboard opens and only shrink the
 * *visual* viewport, so anything pinned to the bottom of the screen — a dialog's fields and buttons — ends up under
 * the keyboard. The visual viewport says what is still visible. Zoomed in by pinching, the page is being looked at,
 * not typed into: nothing is reported then.
 */
export function visibleInsets(layoutHeight: number, vv: Pick<VisualViewport, 'height' | 'offsetTop' | 'scale'> | null | undefined): VisibleInsets {
  if (!vv || Math.abs(vv.scale - 1) > 0.01) return { top: 0, bottom: 0 };
  const top = Math.max(0, Math.round(vv.offsetTop));
  const bottom = Math.max(0, Math.round(layoutHeight - vv.height - vv.offsetTop));
  return { top, bottom };
}

/**
 * Keep `--visible-top` / `--visible-bottom` on <html> in step with the visual viewport (keyboard open, browser
 * bars sliding), so fixed overlays can stay inside what the person can see. One listener, coalesced per frame.
 */
export function useVisibleViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const style = document.documentElement.style;
    let raf = 0;
    let last = '';
    const apply = () => {
      raf = 0;
      const { top, bottom } = visibleInsets(window.innerHeight, vv);
      const key = `${top}:${bottom}`;
      if (key === last) return;
      last = key;
      style.setProperty('--visible-top', `${top}px`);
      style.setProperty('--visible-bottom', `${bottom}px`);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    apply();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    return () => {
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      if (raf) cancelAnimationFrame(raf);
      style.removeProperty('--visible-top');
      style.removeProperty('--visible-bottom');
    };
  }, []);
}
