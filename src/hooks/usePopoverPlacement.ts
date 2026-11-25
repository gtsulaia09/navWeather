import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

export interface PopoverPlacement {
  vertical: 'up' | 'down';
  style: CSSProperties;
}

/**
 * Keeps any anchored `.popover` inside the visible screen (including safe areas and the on-screen keyboard)
 * so menus never clip off the left/right edges or disappear below the bottom of `.app`.
 */
export function usePopoverPlacement(
  anchorRef: RefObject<HTMLElement | null>,
  popRef: RefObject<HTMLElement | null>,
  open: boolean,
  preferred: 'up' | 'down' = 'down',
): PopoverPlacement {
  const [placement, setPlacement] = useState<PopoverPlacement>({ vertical: preferred, style: {} });

  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const measure = () => {
      const anchor = anchorRef.current;
      const pop = popRef.current;
      if (!anchor || !pop) return;
      const vw = window.visualViewport?.width ?? window.innerWidth;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const vTop = window.visualViewport?.offsetTop ?? 0;
      const a = anchor.getBoundingClientRect();
      const naturalH = Math.min(340, Math.max(pop.scrollHeight, 140));
      const spaceAbove = a.top - vTop - 12;
      const spaceBelow = vTop + vh - a.bottom - 12;

      const vertical: 'up' | 'down' =
        preferred === 'up'
          ? spaceAbove >= naturalH || spaceAbove >= spaceBelow
            ? 'up'
            : 'down'
          : spaceBelow >= naturalH || spaceBelow >= spaceAbove
            ? 'down'
            : 'up';

      const availH = Math.max(120, (vertical === 'up' ? spaceAbove : spaceBelow) - 4);
      // Measure horizontal shift after clearing previous horizontal nudge.
      pop.style.setProperty('--pop-shift-x', '0px');
      const p = pop.getBoundingClientRect();
      let dx = 0;
      if (p.right > vw - 10) dx = vw - 10 - p.right;
      if (p.left + dx < 10) dx = 10 - p.left;

      setPlacement({
        vertical,
        style: {
          '--pop-shift-x': `${Math.round(dx)}px`,
          maxHeight: `${Math.round(Math.min(360, availH))}px`,
          overflowY: 'auto',
        } as CSSProperties,
      });
    };

    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [anchorRef, popRef, open, preferred]);

  return placement;
}
