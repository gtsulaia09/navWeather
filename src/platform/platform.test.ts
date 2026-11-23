import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCompanionSnapshot,
  getCarSurfaceBridge,
  getFileCacheProvider,
  getHapticsProvider,
  getLocationProvider,
  getNotificationProvider,
  getShareProvider,
  getWakeLockProvider,
  getWristCompanionBridge,
  memoryFileCache,
  setCarSurfaceBridge,
  setFileCacheProvider,
  setHapticsProvider,
  setLocationProvider,
  setNotificationProvider,
  setShareProvider,
  setWakeLockProvider,
  setWristCompanionBridge,
  type LocationProvider,
} from './index';
import { locateOnce, rememberFix } from '../services/location';

describe('platform seams for React Native (iOS / Android / CarPlay / Android Auto / Watch / Wear OS)', () => {
  afterEach(() => {
    setLocationProvider(null);
    setNotificationProvider(null);
    setWakeLockProvider(null);
    setShareProvider(null);
    setFileCacheProvider(null);
    setHapticsProvider(null);
    setCarSurfaceBridge(null);
    setWristCompanionBridge(null);
    rememberFix(null);
  });

  it('injects a custom LocationProvider (REQ-MOB-005)', async () => {
    const nativeLoc: LocationProvider = {
      name: 'rn-core-location',
      isSecureContext: () => true,
      supported: true,
      getCurrentPosition(ok) {
        ok({
          coords: { longitude: 44.8014, latitude: 41.6936, accuracy: 5, heading: 90, speed: 12 },
          timestamp: Date.now(),
        });
      },
      watchPosition: () => 1,
      clearWatch: () => undefined,
    };
    setLocationProvider(nativeLoc);
    expect(getLocationProvider().name).toBe('rn-core-location');
    const fix = await locateOnce();
    expect(fix.coordinate).toEqual([44.8014, 41.6936]);
    expect(fix.accuracyM).toBe(5);
  });

  it('swaps NotificationProvider (REQ-MOB-006), WakeLockProvider, ShareProvider, HapticsProvider', async () => {
    const notify = vi.fn(async () => true);
    setNotificationProvider({
      name: 'rn-notifications',
      supported: true,
      permission: () => 'granted',
      requestPermission: async () => 'granted',
      notify,
      cancel: () => undefined,
    });
    expect(await getNotificationProvider().notify({ id: 'wx-1', title: 'Rain ahead', body: 'In 18 min' })).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);

    const release = vi.fn(async () => undefined);
    setWakeLockProvider({
      name: 'rn-keep-awake',
      supported: true,
      acquire: async () => ({ released: false, release }),
    });
    const handle = await getWakeLockProvider().acquire();
    expect(handle?.released).toBe(false);
    await handle?.release();
    expect(release).toHaveBeenCalledTimes(1);

    setShareProvider({
      name: 'rn-share',
      canShare: () => true,
      share: async () => 'shared',
      copyText: async () => true,
    });
    expect(await getShareProvider().share({ title: 'Tbilisi', url: 'https://example.test' })).toBe('shared');

    const haptic = vi.fn();
    setHapticsProvider({ name: 'rn-haptics', trigger: haptic });
    getHapticsProvider().trigger('warning');
    expect(haptic).toHaveBeenCalledWith('warning');
  });

  it('caches binary data offline via FileCacheProvider (LRU eviction)', async () => {
    const cache = memoryFileCache(2);
    setFileCacheProvider(cache);
    await getFileCacheProvider().put('a', new Uint8Array([1, 2]));
    await getFileCacheProvider().put('b', new Uint8Array([3, 4]));
    expect(await getFileCacheProvider().get('a')).toEqual(new Uint8Array([1, 2]));
    await getFileCacheProvider().put('c', new Uint8Array([5, 6])); // evicts 'b'
    expect(await getFileCacheProvider().get('b')).toBeNull();
    expect(await getFileCacheProvider().get('c')).toEqual(new Uint8Array([5, 6]));
  });

  it('builds a deterministic car/wrist CompanionSnapshot with at most one weather alert', () => {
    const carUpdate = vi.fn();
    const wristPush = vi.fn();
    setCarSurfaceBridge({ name: 'carplay', connected: true, updateNavigation: carUpdate, endNavigation: () => undefined });
    setWristCompanionBridge({ name: 'watchos', connected: true, pushSnapshot: wristPush });

    const snap = buildCompanionSnapshot({
      active: true,
      destinationName: 'Batumi',
      progress: {
        distanceAlongM: 12_000,
        modelTimeS: 600,
        remainingDistanceM: 345_000,
        remainingTimeS: 16_200,
        distanceFromRouteM: 4,
        segmentIndex: 10,
        nowMs: 1_700_000_000_000,
        etaMs: 1_700_016_200_000,
      },
      guidance: {
        next: {
          id: 'm1',
          index: 1,
          kind: 'turn',
          modifier: 'right',
          roadName: 'S1',
          distanceAlongM: 12_450,
          approachM: 450,
          location: [44.7, 41.7],
          legIndex: 0,
          final: false,
          announce: true,
        },
        then: null,
        distanceToNextM: 450,
        timeToNextS: 25,
      },
      instructionText: 'Turn right onto S1',
      alert: { id: 'a1', headline: 'Heavy rain ahead', severity: 'high', condition: 'HEAVY_RAIN', inSeconds: 1080 },
      nextWeatherEvent: { label: 'Heavy rain near Khashuri', condition: 'HEAVY_RAIN', atMs: 1_700_001_080_000, distanceM: 28_000 },
      nowMs: 1_700_000_000_000,
    });

    getCarSurfaceBridge().updateNavigation(snap);
    getWristCompanionBridge().pushSnapshot(snap);
    expect(carUpdate).toHaveBeenCalledWith(expect.objectContaining({ destinationName: 'Batumi', alert: expect.objectContaining({ headline: 'Heavy rain ahead' }) }));
    expect(wristPush).toHaveBeenCalledWith(expect.objectContaining({ nextManeuver: expect.objectContaining({ distanceM: 450 }) }));
  });
});
