import { afterEach, describe, expect, it } from 'vitest';
import { deviceStorage, memoryStore, sessionStorageStore, setStorage, type KeyValueStore } from './storage';

describe('platform storage', () => {
  const webDevice = deviceStorage();
  const webSession = sessionStorageStore();
  afterEach(() => setStorage({ device: webDevice, session: webSession }));

  it('uses Web Storage in the browser', () => {
    deviceStorage().setItem('nw.test', '1');
    expect(localStorage.getItem('nw.test')).toBe('1');
    deviceStorage().removeItem('nw.test');
    sessionStorageStore().setItem('nw.test', '2');
    expect(sessionStorage.getItem('nw.test')).toBe('2');
    sessionStorageStore().removeItem('nw.test');
  });

  it('can be replaced by a native store (React Native) without touching state code', () => {
    const calls: string[] = [];
    const native: KeyValueStore = { ...memoryStore(), setItem: (k, v) => void calls.push(`${k}=${v}`) };
    setStorage({ device: native });
    deviceStorage().setItem('a', 'b');
    expect(calls).toEqual(['a=b']);
    expect(sessionStorageStore()).toBe(webSession);
  });

  it('memoryStore keeps values for the session only', () => {
    const m = memoryStore();
    expect(m.getItem('x')).toBeNull();
    m.setItem('x', 'y');
    expect(m.getItem('x')).toBe('y');
    m.removeItem('x');
    expect(m.getItem('x')).toBeNull();
  });
});
