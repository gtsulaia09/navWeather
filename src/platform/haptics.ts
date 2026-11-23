/**
 * HAPTICS seam.
 * Web uses `navigator.vibrate` where available (silent no-op on iOS Safari / desktop); React Native injects
 * UIImpactFeedbackGenerator / UINotificationFeedbackGenerator (iOS) or VibrationEffect (Android).
 */
export type HapticKind = 'selection' | 'warning' | 'alert';

export interface HapticsProvider {
  readonly name: string;
  trigger(kind: HapticKind): void;
}

const PATTERNS: Record<HapticKind, number | number[]> = {
  selection: 10,
  warning: [20, 40, 20],
  alert: [35, 50, 35, 50, 35],
};

export const webHapticsProvider: HapticsProvider = {
  name: 'web-haptics',
  trigger(kind) {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(PATTERNS[kind]);
      } catch {
        /* ignore */
      }
    }
  },
};

let current: HapticsProvider = webHapticsProvider;

export function getHapticsProvider(): HapticsProvider {
  return current;
}

export function setHapticsProvider(provider: HapticsProvider | null): void {
  current = provider ?? webHapticsProvider;
}
