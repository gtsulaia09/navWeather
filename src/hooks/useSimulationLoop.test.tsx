import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSimulationLoop } from './useSimulationLoop';
import { useSettings } from '../state/settings';
import { useAppStore } from '../state/store';

function Harness() {
  useSimulationLoop();
  return null;
}

describe('useSimulationLoop (B-42 pacing & battery saver)', () => {
  let rafCallbacks: Array<(t: number) => void> = [];
  let now = 0;

  beforeEach(() => {
    rafCallbacks = [];
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    useSettings.getState().reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({ mode: 'planning', sim: { ...useAppStore.getState().sim, playing: false } });
  });

  it('paces simulation updates to ~30 fps normally and ~10 fps in battery saver (B-42)', () => {
    const advance = vi.fn();
    const origAdvance = useAppStore.getState().advanceSimulationBy;
    useAppStore.setState({
      mode: 'simulating',
      sim: { ...useAppStore.getState().sim, playing: true },
      advanceSimulationBy: advance,
    });

    const { unmount } = render(<Harness />);
    // Fire 16 ms frames (60 fps): only every second frame (>= 32 ms) advances simulation.
    for (let i = 1; i <= 6; i++) {
      now += 16;
      const cb = rafCallbacks.shift();
      cb?.(now);
    }
    expect(advance.mock.calls.length).toBe(3);

    // Enable battery saver -> drops to ~10 fps (>= 100 ms per step).
    advance.mockClear();
    rafCallbacks = [];
    act(() => {
      useSettings.getState().update({ batterySaver: true });
    });
    for (let i = 1; i <= 10; i++) {
      now += 16;
      const cb = rafCallbacks.shift();
      cb?.(now);
    }
    // 10 * 16 = 160 ms -> only 1 step at >= 100 ms.
    expect(advance.mock.calls.length).toBe(1);

    unmount();
    useAppStore.setState({ advanceSimulationBy: origAdvance });
  });
});
