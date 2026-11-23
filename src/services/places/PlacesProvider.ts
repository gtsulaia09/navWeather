import type { LngLat } from '../../types/geo';
import type { RawPlace } from '../../types/route';

export type { RawPlace };

/** Settlements near a route (for naming weather points and sampling anchors). */
export interface PlacesProvider {
  readonly name: string;
  getPlacesNearRoute(
    geometry: LngLat[],
    options: { includeVillages: boolean; signal?: AbortSignal; language?: string },
  ): Promise<RawPlace[]>;
}
