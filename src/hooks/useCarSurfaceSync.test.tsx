import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchCarSurfaceCommand, setCarSurfaceBridge, type CarSurfaceBridge, type CompanionSnapshot } from '../platform/surfaces';
import { useAppStore } from '../state/store';
import { useCarSurfaceSync } from './useCarSurfaceSync';

function fakeCar(connected: boolean) {
  const sent: CompanionSnapshot[] = [];
  const bridge: CarSurfaceBridge & { connected: boolean } = {
    name: 'test-car',
    connected,
    syncState: (s) => sent.push(s),
    updateNavigation: () => {},
    endNavigation: () => {},
  };
  return { bridge, sent };
}

afterEach(() => {
  setCarSurfaceBridge(null);
  vi.useRealTimers();
});

describe('car surface sync', () => {
  it('sends nothing while no car is connected (the iOS shell always has the bridge)', () => {
    vi.useFakeTimers();
    const { bridge, sent } = fakeCar(false);
    setCarSurfaceBridge(bridge);
    renderHook(() => useCarSurfaceSync());
    useAppStore.setState({ settingsOpen: true });
    useAppStore.setState({ settingsOpen: false });
    vi.advanceTimersByTime(2000);
    expect(sent).toHaveLength(0);
  });

  it('a connected car gets a full snapshot, then only changes', () => {
    vi.useFakeTimers();
    const { bridge, sent } = fakeCar(false);
    setCarSurfaceBridge(bridge);
    renderHook(() => useCarSurfaceSync());
    bridge.connected = true;
    dispatchCarSurfaceCommand({ action: 'requestSync' });
    expect(sent).toHaveLength(1);
    // An app-state change that alters nothing the car shows is not sent again.
    useAppStore.setState({ settingsOpen: !useAppStore.getState().settingsOpen });
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
  });
});
