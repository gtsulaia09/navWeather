/**
 * Rendering tier: `full` on most phones, `lite` on weak ones (few cores, little memory, Data Saver) and in battery
 * saver. Lite keeps every animation but draws cheaper pixels: no live blur behind overlays, lighter shadows
 * (tokens.css `[data-perf='lite']`), the map at ≤1.5× pixels, no 3D buildings and no symbol fade (RouteMap).
 */
export type PerfTier = 'full' | 'lite';

export interface DeviceHints {
  cores?: number;
  memoryGb?: number;
  saveData?: boolean;
  batterySaver?: boolean;
}

/** The tier for what the device tells us about itself. */
export function perfTierFrom(h: DeviceHints): PerfTier {
  if (h.batterySaver || h.saveData) return 'lite';
  if (h.memoryGb !== undefined && h.memoryGb > 0 && h.memoryGb <= 2) return 'lite';
  if (h.cores !== undefined && h.cores > 0 && h.cores <= 2) return 'lite';
  return 'full';
}

/** What this browser reports (Chrome: cores, memory, Data Saver; Safari: cores only). */
export function deviceHints(): DeviceHints {
  if (typeof navigator === 'undefined') return {};
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return { cores: nav.hardwareConcurrency, memoryGb: nav.deviceMemory, saveData: nav.connection?.saveData };
}

let tier: PerfTier = 'full';
const listeners = new Set<(t: PerfTier) => void>();

export function getPerfTier(): PerfTier {
  return tier;
}

/** Re-evaluate (at start, and when battery saver changes) and mark the document for CSS. */
export function updatePerfTier(batterySaver: boolean): PerfTier {
  const next = perfTierFrom({ ...deviceHints(), batterySaver });
  if (typeof document !== 'undefined') document.documentElement.dataset.perf = next;
  if (next !== tier) {
    tier = next;
    for (const l of listeners) l(next);
  }
  return next;
}

export function onPerfTierChange(l: (t: PerfTier) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
