import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { SheetState } from '../../state/store';
import { useLayoutStore } from '../../state/layout';
import { useElementSize } from '../../hooks/useElementSize';
import { useMessages } from '../../state/settings';
import './BottomSheet.css';

const ORDER: SheetState[] = ['compact', 'default', 'expanded'];

/** iOS sheet curve: quick start, long soft landing. Kept in step with --ease-sheet (tokens.css). */
const SHEET_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const SHEET_MS = 380;
/** A flick this fast (px per ms) changes the detent even when the finger moved only a little. */
const FLICK = 0.45;

/**
 * Is the sheet a panel docked at the left (desktop, landscape phone) rather than a bottom sheet (phone, tablet
 * card)? A narrow box in the left part of the screen — wherever its edge is (safe areas move it on iPhones).
 */
export function isSideDocked(r: Pick<DOMRect, 'left' | 'width'>, viewportWidth: number): boolean {
  return r.width < viewportWidth * 0.6 && r.left < viewportWidth * 0.25;
}

/**
 * Where the finger-following sheet goes when the finger lifts: a detent up, down, or back where it was. A short,
 * fast flick counts like a long pull.
 */
export function releaseStep(movedPx: number, velocityPxPerMs: number): -1 | 0 | 1 {
  if (movedPx < -36 || velocityPxPerMs < -FLICK) return 1;
  if (movedPx > 36 || velocityPxPerMs > FLICK) return -1;
  return 0;
}

/** Rubber band past the end of travel: follows the finger less and less, never more than `max`. */
export function rubberBand(px: number, max: number): number {
  return (max * px) / (max + px);
}

/** The vertical offset the sheet's `transform` draws it at right now (a slide in flight or a drag), in px. */
function currentOffset(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return 0;
  try {
    return new DOMMatrixReadOnly(t).m42;
  } catch {
    return 0;
  }
}

/** Everything that draws the sheet away from its layout box: the transform above plus the CSS entrance `translate`. */
function drawnOffset(el: HTMLElement): number {
  const tr = getComputedStyle(el).translate;
  const y = tr && tr !== 'none' ? parseFloat(tr.split(' ')[1] ?? '0') || 0 : 0;
  return currentOffset(el) + y;
}

/** The phone bottom sheet (full width, at the bottom) — the only layout whose height changes are slid, not cut. */
function isPhoneSheet(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return window.innerWidth < 700 && !isSideDocked(r, window.innerWidth);
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
}

interface Props {
  state: SheetState;
  onChange(s: SheetState): void;
  header: ReactNode;
  body?: ReactNode;
  extra?: ReactNode;
  label: string;
  grabber?: boolean;
}

interface Drag {
  y: number;
  id: number;
  active: boolean;
  /** Last few samples, for the release velocity. */
  samples: { y: number; t: number }[];
  offset: number;
}

/**
 * Bottom sheet with three detents (side panel on landscape phones and wide screens keep the bottom layout). Drag
 * the grabber/header, or tap the grabber to cycle compact → default → expanded → compact.
 *
 * Smoothness: the drag moves the sheet with a transform written straight to the element (no React render per
 * frame), and every height change of the phone sheet — a detent, a route arriving, a card opening — is slid with a
 * compositor animation from where the sheet was drawn to where it now sits (FLIP), instead of jumping.
 */
export function BottomSheet({ state, onChange, header, body, extra, label, grabber = true }: Props) {
  const ref = useRef<HTMLElement>(null);
  const grab = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const raf = useRef(0);
  /** The drag offset still drawn after the finger lifted, waiting for the new detent's layout to take over. */
  const releasedAt = useRef<number | null>(null);
  const anim = useRef<Animation | null>(null);
  // The default detent is ~62 % of the screen, but never shorter than the header: on a small phone (or with large
  // text) the header — travel modes, title, Start — would otherwise be cut off at the bottom (BottomSheet.css).
  const [headPx, setHeadPx] = useState(0);
  useElementSize(grab, (r) => setHeadPx(Math.ceil(r.height)));
  const setInsets = useLayoutStore((s) => s.setInsets);
  const setSheetCovers = useLayoutStore((s) => s.setSheetCovers);
  const m = useMessages();

  useElementSize(ref, (r) => {
    // Where the sheet *is*, not where an animation draws it this frame: the map padding and the floating buttons
    // follow the final position (they glide there themselves).
    const el = ref.current;
    const off = el ? drawnOffset(el) : 0;
    const top = r.top - off;
    // Docked at the side (desktop panel, landscape phones): the map loses width, not height. Not "left ≤ 40 px":
    // in landscape an iPhone's panel starts after the Dynamic Island's safe area (~70 px from the edge).
    const side = isSideDocked(r, window.innerWidth);
    setInsets(side ? { bottom: 0, left: Math.round(r.right) } : { bottom: Math.round(window.innerHeight - top), left: 0 });
    setSheetCovers(!side && top < window.innerHeight * 0.42);
  });
  useEffect(() => () => useLayoutStore.getState().setSheetCovers(false), []);

  /** Slide the sheet from `fromPx` (drawn offset) to its place. */
  const settle = (el: HTMLElement, fromPx: number) => {
    anim.current?.cancel();
    anim.current = null;
    el.style.transform = '';
    if (Math.abs(fromPx) < 1 || prefersReducedMotion() || typeof el.animate !== 'function') return;
    // Longer travel, a little longer slide (clamped): a detent change feels the same at any distance.
    const duration = Math.round(Math.min(SHEET_MS + 80, Math.max(240, SHEET_MS * Math.sqrt(Math.abs(fromPx) / 260))));
    const a = el.animate([{ transform: `translate3d(0, ${fromPx}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }], {
      duration,
      easing: SHEET_EASE,
    });
    anim.current = a;
    a.onfinish = a.oncancel = () => {
      if (anim.current === a) anim.current = null;
    };
  };

  // Height changes of the phone sheet slide instead of jumping (FLIP). The observer runs after layout and before
  // paint, so the first frame at the new size is already drawn at the old position.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastH = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      const grew = h - lastH;
      lastH = h;
      if (drag.current?.active) return;
      const released = releasedAt.current;
      releasedAt.current = null;
      if (!isPhoneSheet(el)) {
        settle(el, 0);
        return;
      }
      // Drawn offset now (drag left-over or a slide in flight) plus how far the top edge just moved.
      const drawn = released ?? (anim.current ? currentOffset(el) : 0);
      settle(el, drawn + grew);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      anim.current?.cancel();
      cancelAnimationFrame(raf.current);
    };
  }, []);

  const step = (dir: 1 | -1): boolean => {
    const i = ORDER.indexOf(state);
    const next = ORDER[Math.max(0, Math.min(ORDER.length - 1, i + dir))];
    if (next === state) return false;
    onChange(next);
    return true;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!grabber) return;
    const t = e.target as HTMLElement;
    if (t.closest('button:not(.sheet__handle), input, a, select, [role="dialog"], [role="menu"]')) return;
    drag.current = { y: e.clientY, id: e.pointerId, active: false, samples: [{ y: e.clientY, t: e.timeStamp }], offset: 0 };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || d.id !== e.pointerId || !el) return;
    const dyNow = e.clientY - d.y;
    if (!d.active) {
      if (Math.abs(dyNow) < 6) return;
      d.active = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      // Catch a sheet that is still sliding where it is drawn, so it doesn't jump under the finger.
      const drawn = anim.current ? currentOffset(el) : 0;
      anim.current?.cancel();
      anim.current = null;
      d.y -= drawn;
      el.classList.add('is-dragging');
    }
    d.samples.push({ y: e.clientY, t: e.timeStamp });
    if (d.samples.length > 5) d.samples.shift();
    const moved = e.clientY - d.y;
    // Down: follow the finger. Up: rubber band (the sheet can't grow past its detent by dragging).
    d.offset = moved < 0 ? -rubberBand(-moved, 56) : moved;
    if (!raf.current) {
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        const cur = drag.current;
        if (cur?.active && ref.current) ref.current.style.transform = `translate3d(0, ${cur.offset}px, 0)`;
      });
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.active || !el) return;
    el.classList.remove('is-dragging');
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const dt = Math.max(1, last.t - first.t);
    const velocity = (last.y - first.y) / dt;
    const moved = e.clientY - d.y;
    const offset = currentOffset(el);
    const dir = releaseStep(moved, velocity);
    if (dir !== 0 && step(dir)) {
      // The new detent's layout slides in from here (FLIP above). If its height doesn't change (content shorter
      // than both detents), nothing observes a resize: settle on the next frames instead.
      releasedAt.current = offset;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (releasedAt.current === null || !ref.current) return;
          const from = releasedAt.current;
          releasedAt.current = null;
          settle(ref.current, from);
        }),
      );
    } else {
      settle(el, offset);
    }
  };

  const nextState: SheetState = state === 'expanded' ? 'compact' : state === 'compact' ? 'default' : 'expanded';

  return (
    <section ref={ref} className={`sheet sheet--${state}`} style={{ '--sheet-head': `${headPx}px` } as CSSProperties} aria-label={label}>
      <div ref={grab} className="sheet__grab" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        {grabber ? (
          <button
            className="sheet__handle"
            aria-label={
              ORDER.indexOf(nextState) > ORDER.indexOf(state) ? m.ui.sheetMore : nextState === 'compact' ? m.ui.sheetMinimize : m.ui.sheetLess
            }
            aria-expanded={state === 'expanded'}
            onClick={() => onChange(nextState)}
          >
            <span className="sheet__grabber" />
          </button>
        ) : (
          <div className="sheet__spacer" />
        )}
        <div className="sheet__header">{header}</div>
      </div>
      <div className="sheet__scroll">
        {state !== 'compact' && body ? <div className="sheet__body">{body}</div> : null}
        {state !== 'compact' && extra ? <div className="sheet__extra">{extra}</div> : null}
      </div>
    </section>
  );
}
