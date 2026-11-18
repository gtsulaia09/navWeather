/**
 * KEY–VALUE STORAGE behind one small interface, so state code doesn't name a browser API. The web uses
 * localStorage / sessionStorage; a React Native app calls `setStorage` once at start-up with its own (e.g. MMKV,
 * which is synchronous like these). Values are strings; callers JSON-encode and keep their own try/catch, because
 * a browser may refuse storage (private mode, quota, blocked site data).
 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A store that forgets on reload: where the platform has none (tests, workers, storage switched off). */
export function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** The Web Storage object named `which`, looked up on each call (it can appear late, or throw when blocked). */
function webStore(which: 'localStorage' | 'sessionStorage'): KeyValueStore {
  const fallback = memoryStore();
  const target = (): KeyValueStore => (globalThis as unknown as Record<string, KeyValueStore | undefined>)[which] ?? fallback;
  return {
    getItem: (k) => target().getItem(k),
    setItem: (k, v) => target().setItem(k, v),
    removeItem: (k) => target().removeItem(k),
  };
}

let device: KeyValueStore = webStore('localStorage');
let session: KeyValueStore = webStore('sessionStorage');

/** Kept on this device across restarts: settings, saved places, an active live share's key. */
export const deviceStorage = (): KeyValueStore => device;
/** Kept until this tab / app session ends: "continue the drive after a reload". */
export const sessionStorageStore = (): KeyValueStore => session;

/** Swap the stores (native apps; tests). Pass only the ones to replace. */
export function setStorage(stores: { device?: KeyValueStore; session?: KeyValueStore }): void {
  if (stores.device) device = stores.device;
  if (stores.session) session = stores.session;
}
