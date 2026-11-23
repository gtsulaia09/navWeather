import { getShareProvider } from '../platform/share';
import type { Place } from '../types/geo';
import { SHARE_ID_RE } from './protocol';

/** A place link: `/?p=lat,lon&n=Name`. Contains only that spot — never the sender's position. */
export function placeUrl(place: Place, origin = location.origin): string {
  const [lon, lat] = place.coordinate;
  const u = new URL('/', origin);
  u.searchParams.set('p', `${lat.toFixed(5)},${lon.toFixed(5)}`);
  if (place.name && place.kind !== 'pin') u.searchParams.set('n', place.name.slice(0, 80));
  return u.toString();
}

export function parsePlaceUrl(search: string): Place | null {
  const q = new URLSearchParams(search);
  const p = /^\s*(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(q.get('p') ?? '');
  if (!p) return null;
  const lat = Number(p[1]);
  const lon = Number(p[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = (q.get('n') ?? '').replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const coords = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  return { id: `link:${lat.toFixed(5)},${lon.toFixed(5)}`, name: name || coords, label: coords, coordinate: [lon, lat], kind: name ? 'shared' : 'pin' };
}

/** A live link. `/p` marks a share that runs phone to phone (ADR-020): the viewer skips the Worker. */
export function liveUrl(id: string, origin = location.origin, peer = false): string {
  return new URL(`/live/${id}${peer ? '/p' : ''}`, origin).toString();
}

export function parseLiveUrl(pathname: string): string | null {
  return parseLiveLink(pathname)?.id ?? null;
}

export function parseLiveLink(pathname: string): { id: string; peer: boolean } | null {
  const m = /^\/live\/([^/]+)(\/p)?\/?$/.exec(pathname);
  return m && SHARE_ID_RE.test(m[1]) ? { id: m[1], peer: !!m[2] } : null;
}

/** The system share sheet exists (phones, some desktops, native RN). */
export function canNativeShare(): boolean {
  return getShareProvider().canShare();
}

export function nativeShare(data: { title: string; text?: string; url: string }): Promise<'shared' | 'cancelled' | 'failed'> {
  return getShareProvider().share(data);
}

export function copyText(text: string): Promise<boolean> {
  return getShareProvider().copyText(text);
}
