import { ProviderError } from '../http';
import { gunzip } from '../../utils/gzip';
import { indexTransitNetwork, planTransit } from '../../transit/raptor';
import type { RawTransitBundle, TransitManifest, TransitNetwork, TransitRegionMeta } from '../../transit/types';
import type { Route } from '../../types/route';
import type { RouteRequest, RoutingCapabilities, RoutingProvider } from './RoutingProvider';

function inBBox(coord: [number, number], b: [number, number, number, number]): boolean {
  return coord[0] >= b[0] && coord[0] <= b[2] && coord[1] >= b[1] && coord[1] <= b[3];
}

/**
 * On-device public-transport routing over static gzipped GTFS bundles under `/data/transit/`
 * (ADR-019: $0 per user, zero API calls, works offline once cached).
 */
export class StaticTransitProvider implements RoutingProvider {
  readonly name = 'static-transit';
  readonly capabilities: RoutingCapabilities = {
    alternatives: true,
    avoid: [],
    laneGuidance: false,
    matrix: false,
    multiStop: false,
  };
  private manifestPromise: Promise<TransitManifest> | null = null;
  private regionCache = new Map<string, Promise<TransitNetwork>>();

  constructor(private readonly dataRoot: string) {}

  private loadManifest(signal?: AbortSignal): Promise<TransitManifest> {
    if (!this.manifestPromise) {
      const url = `${this.dataRoot.replace(/\/$/, '')}/transit.json`;
      this.manifestPromise = fetch(url, { signal })
        .then(async (res) => {
          if (!res.ok) {
            throw new ProviderError('Static transit timetables are not available yet', 'data-missing', this.name);
          }
          const ct = res.headers.get('content-type') ?? '';
          if (ct.includes('text/html')) {
            throw new ProviderError('Static transit timetables are not available yet', 'data-missing', this.name);
          }
          return (await res.json()) as TransitManifest;
        })
        .catch((err) => {
          this.manifestPromise = null;
          if (err instanceof ProviderError) throw err;
          throw new ProviderError('Static transit timetables could not be loaded', 'data-missing', this.name, err);
        });
    }
    return this.manifestPromise;
  }

  private loadRegion(region: TransitRegionMeta, signal?: AbortSignal): Promise<TransitNetwork> {
    let cached = this.regionCache.get(region.file);
    if (!cached) {
      const url = `${this.dataRoot.replace(/\/$/, '')}/${region.file}`;
      cached = fetch(url, { signal })
        .then(async (res) => {
          if (!res.ok) {
            throw new ProviderError('Transit timetable file is missing', 'data-missing', this.name);
          }
          const buf = new Uint8Array(await res.arrayBuffer());
          const raw = buf[0] === 0x1f && buf[1] === 0x8b ? await gunzip(buf) : buf;
          const json = new TextDecoder().decode(raw);
          return indexTransitNetwork(JSON.parse(json) as RawTransitBundle);
        })
        .catch((err) => {
          this.regionCache.delete(region.file);
          if (err instanceof ProviderError) throw err;
          throw new ProviderError('Transit timetable data could not be loaded', 'network', this.name, err);
        });
      this.regionCache.set(region.file, cached);
    }
    return cached;
  }

  async calculateRoutes(req: RouteRequest): Promise<Route[]> {
    const manifest = await this.loadManifest(req.signal);
    const region = manifest.regions.find(
      (r) => inBBox(req.origin.coordinate, r.bbox) && inBBox(req.destination.coordinate, r.bbox),
    );
    if (!region) {
      throw new ProviderError('No public transport found', 'no-route', this.name);
    }
    const net = await this.loadRegion(region, req.signal);
    const departAtMs = req.departAtMs ?? Date.now();
    const routes = planTransit(net, req.origin, req.destination, departAtMs);
    if (routes.length === 0) {
      throw new ProviderError('No public transport found', 'no-route', this.name);
    }
    return routes;
  }
}
