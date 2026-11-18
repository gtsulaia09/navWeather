import { useEffect, useRef, type ReactNode } from 'react';
import './Dialog.css';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';
/** Fields that bring up the on-screen keyboard when focused. */
const TYPING = 'textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=tel], input[type=url], input[type=number], input[type=password]';

/**
 * Where focus goes when a dialog opens: its first control — unless that is a text field on a touch screen, where
 * focusing it would throw the keyboard over half the dialog before the person chose to type. Then the dialog
 * itself takes focus (screen readers still announce it; Tab moves into it).
 */
export function initialFocusTarget(dialog: HTMLElement, touch: boolean): HTMLElement {
  const first = dialog.querySelector<HTMLElement>(FOCUSABLE);
  if (!first || (touch && first.matches(TYPING))) return dialog;
  return first;
}

/** Modal dialog: initial focus, focus trap, Escape, and focus returned on close. */
export function Dialog({
  label,
  onClose,
  children,
  size = 'small',
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  size?: 'small' | 'large';
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Latest onClose without re-running the focus setup: callers often pass a new
  // function each render, and re-running would steal focus mid-typing.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el) initialFocusTarget(el, window.matchMedia?.('(pointer: coarse)').matches ?? false).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    // The keyboard opening shrinks the dialog (Dialog.css, --visible-bottom): keep the field being typed in on
    // screen. A frame later, once the new size applies; scroll-padding keeps it clear of a sticky footer.
    let raf = 0;
    const keepFieldVisible = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => {
          const active = document.activeElement;
          if (el && active instanceof HTMLElement && el.contains(active) && active.matches(TYPING)) active.scrollIntoView({ block: 'nearest' });
        });
      });
    };
    window.visualViewport?.addEventListener('resize', keepFieldVisible);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.visualViewport?.removeEventListener('resize', keepFieldVisible);
      cancelAnimationFrame(raf);
      previous?.focus?.();
    };
  }, []);
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`dialog dialog--${size}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
