import type { LngLat, Place } from '../../types/geo';
import { haversineM } from '../../utils/distance';
import { parseOverpassElements } from '../places/OverpassPlacesProvider';
import type { PlacesTiles, TilePoint } from '../places/tiles';
import type { GeocodeOptions, GeocodingProvider } from './GeocodingProvider';

/**
 * The settlement a point is in or near (≤15 km), from OUR settlement tiles — for naming route points and dropped
 * pins with no request beyond the static tiles (ADR-019). Outside the region they cover: null ("not available").
 */
export class TileReverseGeocoder implements GeocodingProvider {
  readonly name = 'tiles-reverse';
  private readonly tiles: PlacesTiles;
  private readonly language: string;

  constructor(tiles: PlacesTiles, language: string) {
    this.tiles = tiles;
    this.language = language;
  }

  async geocode(): Promise<Place | null> {
    return null;
  }

  async reverse(coordinate: LngLat, options: GeocodeOptions = {}): Promise<Place | null> {
    const index = await this.tiles.loadIndex(options.signal);
    if (!index || !this.tiles.covers(index, coordinate)) return null;
    const features = await this.tiles.features<TilePoint>('settlement', [coordinate], 15_000, options.signal);
    const lang = options.language ?? this.language;
    const places = parseOverpassElements(
      features.map(([id, lon, lat, tags]) => ({ type: 'node', id: Number(id.slice(1)), lat, lon, tags })),
      lang,
    );
    let best: (typeof places)[number] | null = null;
    let bestD = 15_000;
    for (const p of places) {
      const d = haversineM(coordinate, p.coordinate);
      if (d < bestD) [best, bestD] = [p, d];
    }
    return best ? { id: best.id, name: best.name, label: best.name, coordinate: best.coordinate, kind: best.kind } : null;
  }
}
