import { useEffect, useState } from 'react';
import { useReducedMotion } from './useMediaQuery';

/**
 * Keeps an overlay mounted briefly (`durationMs`) with `closing = true` so its CSS `[data-closing]` exit
 * transition finishes on the compositor before unmounting. Settles immediately in tests / reduced motion.
 */
export function useAnimatedPresence(open: boolean, durationMs = 180): { mounted: boolean; closing: boolean } {
  const reduced = useReducedMotion();
  const instant =
    reduced ||
    typeof window === 'undefined' ||
    typeof Element === 'undefined' ||
    typeof Element.prototype.getAnimations !== 'function';
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (instant) {
      setMounted(false);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), durationMs);
    return () => window.clearTimeout(t);
  }, [open, instant, durationMs]);

  return { mounted: open || (!instant && mounted), closing: !open && !instant && mounted };
}
