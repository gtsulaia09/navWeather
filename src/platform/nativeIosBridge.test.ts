// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initNativeIosBridge } from './nativeIosBridge';
import { getLocationProvider, setLocationProvider } from './location';
import { getHapticsProvider, setHapticsProvider } from './haptics';
import { getWakeLockProvider, setWakeLockProvider } from './wakeLock';
import { getCustomTtsProvider, setTtsProvider } from '../voice/providers';
import { classifyLocationError } from '../services/location';
import { createProviders } from '../services/providers';

function installWebkitHandlers() {
  const nativeLocation = { postMessage: vi.fn() };
  const nativeHaptics = { postMessage: vi.fn() };
  const nativeWakeLock = { postMessage: vi.fn() };
  const nativeTTS = { postMessage: vi.fn() };
  window.webkit = {
    messageHandlers: { nativeLocation, nativeHaptics, nativeWakeLock, nativeTTS },
  };
  return { nativeLocation, nativeHaptics, nativeWakeLock, nativeTTS };
}

describe('initNativeIosBridge', () => {
  afterEach(() => {
    delete window.webkit;
    delete window.__navweather_native_location_update;
    delete window.__navweather_native_location_error;
    delete window.__navweather_native_tts_end;
    setLocationProvider(null);
    setHapticsProvider(null);
    setWakeLockProvider(null);
    setTtsProvider(null);
  });

  it('returns false outside WKWebView', () => {
    expect(initNativeIosBridge()).toBe(false);
    expect(getCustomTtsProvider()).toBeNull();
  });

  it('stops native GPS after one-shot getCurrentPosition succeeds or fails when no watchers remain', () => {
    const { nativeLocation } = installWebkitHandlers();
    expect(initNativeIosBridge()).toBe(true);

    const loc = getLocationProvider();
    expect(loc.name).toBe('ios-native-corelocation');

    const onSuccess = vi.fn();
    const onError = vi.fn();
    loc.getCurrentPosition(onSuccess, onError);
    expect(nativeLocation.postMessage).toHaveBeenCalledWith({ action: 'getCurrentPosition', id: 1 });

    window.__navweather_native_location_update?.({
      coords: { longitude: 44.8271, latitude: 41.7151, accuracy: 8, heading: 90, speed: 5 },
      timestamp: 1_700_000_000_000,
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(nativeLocation.postMessage).toHaveBeenCalledWith({ action: 'stopWatch', id: 1 });

    // Error path also stops GPS when no other watchers are active
    nativeLocation.postMessage.mockClear();
    loc.getCurrentPosition(onSuccess, onError);
    window.__navweather_native_location_error?.({ code: 2 });
    expect(onError).toHaveBeenCalledWith({ code: 2 });
    expect(classifyLocationError({ code: 2 })).toBe('unavailable');
    expect(classifyLocationError({ code: 1 })).toBe('denied');
    expect(nativeLocation.postMessage).toHaveBeenCalledWith({ action: 'stopWatch', id: 2 });
  });

  it('keeps native GPS running after getCurrentPosition if a watchPosition listener is active', () => {
    const { nativeLocation } = installWebkitHandlers();
    initNativeIosBridge();
    const loc = getLocationProvider();

    const watchCb = vi.fn();
    const onceCb = vi.fn();
    const watchId = loc.watchPosition(watchCb, vi.fn());
    loc.getCurrentPosition(onceCb, vi.fn());
    nativeLocation.postMessage.mockClear();

    window.__navweather_native_location_update?.({
      coords: { longitude: 44.8271, latitude: 41.7151, accuracy: 5, heading: null, speed: null },
      timestamp: 1_700_000_000_000,
    });

    expect(onceCb).toHaveBeenCalledTimes(1);
    expect(watchCb).toHaveBeenCalledTimes(1);
    expect(nativeLocation.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'stopWatch' }));

    loc.clearWatch(watchId);
    expect(nativeLocation.postMessage).toHaveBeenCalledWith({ action: 'stopWatch', id: watchId });
  });

  it('wires nativeTTS into createProviders(), speaks formatted text, and resolves onEnd on finish or cancel', () => {
    const { nativeTTS } = installWebkitHandlers();
    initNativeIosBridge();

    const tts = getCustomTtsProvider();
    expect(tts?.name).toBe('ios-native-avspeech');
    expect(createProviders().tts).toBe(tts);

    const onEnd = vi.fn();
    tts?.speak('Ограничение 60 км/ч', { lang: 'ru-RU', onEnd });
    expect(nativeTTS.postMessage).toHaveBeenCalledWith({
      action: 'speak',
      id: 1,
      text: expect.stringContaining('километров в час'),
      lang: 'ru-RU',
    });
    expect(onEnd).not.toHaveBeenCalled();

    window.__navweather_native_tts_end?.(1);
    expect(onEnd).toHaveBeenCalledTimes(1);

    // Cancel sends cancel action and resolves pending onEnd immediately so VoiceQueue never stalls
    const onCancelEnd = vi.fn();
    tts?.speak('Turn right', { lang: 'en-US', onEnd: onCancelEnd });
    tts?.cancel();
    expect(nativeTTS.postMessage).toHaveBeenCalledWith({ action: 'cancel' });
    expect(onCancelEnd).toHaveBeenCalledTimes(1);
  });

  it('wires haptics and wakeLock handlers cleanly', async () => {
    const { nativeHaptics, nativeWakeLock } = installWebkitHandlers();
    initNativeIosBridge();

    getHapticsProvider().trigger('warning');
    expect(nativeHaptics.postMessage).toHaveBeenCalledWith({ kind: 'warning' });

    const handle = await getWakeLockProvider().acquire();
    expect(nativeWakeLock.postMessage).toHaveBeenCalledWith({ active: true });
    await handle?.release();
    expect(nativeWakeLock.postMessage).toHaveBeenCalledWith({ active: false });
  });
});
