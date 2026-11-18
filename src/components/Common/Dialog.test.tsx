import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, initialFocusTarget } from './Dialog';

function dialogWith(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('initialFocusTarget', () => {
  it('is the first control with a mouse and keyboard', () => {
    const d = dialogWith('<input type="text" id="name"><button>Go</button>');
    expect(initialFocusTarget(d, false).id).toBe('name');
  });

  it('is the dialog itself on a touch screen when the first control is a text field (no keyboard pop-up)', () => {
    const d = dialogWith('<input type="text"><button>Go</button>');
    expect(initialFocusTarget(d, true)).toBe(d);
    expect(initialFocusTarget(dialogWith('<input type="number">'), true).tagName).toBe('DIV');
    expect(initialFocusTarget(dialogWith('<textarea></textarea>'), true).tagName).toBe('DIV');
  });

  it('is still the first control on touch when that control opens no keyboard', () => {
    expect(initialFocusTarget(dialogWith('<button id="b">Ok</button><input>'), true).id).toBe('b');
    expect(initialFocusTarget(dialogWith('<select id="s"></select>'), true).id).toBe('s');
    expect(initialFocusTarget(dialogWith('<input type="radio" id="r">'), true).id).toBe('r');
  });

  it('is the dialog when it has nothing to focus', () => {
    const d = dialogWith('<p>Text</p>');
    expect(initialFocusTarget(d, false)).toBe(d);
  });
});

describe('Dialog', () => {
  afterEach(() => vi.unstubAllGlobals());

  const touch = (coarse: boolean) =>
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: coarse && q.includes('coarse'), media: q, addEventListener() {}, removeEventListener() {} }));

  it('focuses the name field with a mouse, the dialog with a finger', () => {
    touch(false);
    const { unmount } = render(
      <Dialog label="Share" onClose={() => {}}>
        <input aria-label="Name" />
      </Dialog>,
    );
    expect(screen.getByLabelText('Name')).toHaveFocus();
    unmount();

    touch(true);
    render(
      <Dialog label="Share" onClose={() => {}}>
        <input aria-label="Name" />
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'Share' })).toHaveFocus();
  });
});
