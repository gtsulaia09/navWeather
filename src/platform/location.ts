/**
 * DEVICE LOCATION seam (REQ-MOB-005).
 * Web uses `navigator.geolocation`; React Native injects Core Location (iOS) or FusedLocationProviderClient +
 * foreground service type `location` (Android 14+) via `setLocationProvider(...)`.
 */
export interface PositionCoords {
  longitude: number;
  latitude: number;
  accuracy: number;
  heading: number | null;
  speed: number | null;
}

export interface RawPosition {
  coords: PositionCoords;
  timestamp: number;
}

export interface RawPositionError {
  code: number;
}

export interface LocationOptions {
  enableHighAccuracy?: boolean;
  maximumAge?: number;
  timeout?: number;
}

export interface LocationProvider {
  readonly name: string;
  /** False on insecure HTTP web pages where browsers refuse geolocation. Always true on native. */
  isSecureContext(): boolean;
  readonly supported: boolean;
  getCurrentPosition(
    onSuccess: (pos: RawPosition) => void,
    onError: (err: RawPositionError) => void,
    options?: LocationOptions,
  ): void;
  watchPosition(
    onSuccess: (pos: RawPosition) => void,
    onError: (err: RawPositionError) => void,
    options?: LocationOptions,
  ): number;
  clearWatch(id: number): void;
}

/** Browser implementation reading `navigator.geolocation` dynamically (so tests can stub it). */
export const browserLocationProvider: LocationProvider = {
  name: 'browser-geolocation',
  isSecureContext() {
    return typeof window === 'undefined' || window.isSecureContext !== false;
  },
  get supported() {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator && !!navigator.geolocation;
  },
  getCurrentPosition(onSuccess, onError, options) {
    navigator.geolocation.getCurrentPosition(onSuccess, onError, options);
  },
  watchPosition(onSuccess, onError, options) {
    return navigator.geolocation.watchPosition(onSuccess, onError, options);
  },
  clearWatch(id) {
    navigator.geolocation.clearWatch(id);
  },
};

let current: LocationProvider = browserLocationProvider;

export function getLocationProvider(): LocationProvider {
  return current;
}

/** Swap the platform location adapter (React Native startup, or tests). Pass `null` to restore browser default. */
export function setLocationProvider(provider: LocationProvider | null): void {
  current = provider ?? browserLocationProvider;
}
