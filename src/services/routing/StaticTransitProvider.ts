import { ProviderError } from '../http';
import { gunzip } from '../../utils/gzip';
import { indexTransitNetwork, planTransit } from '../../transit/raptor';
import type { RawTransitBundle, TransitManifest, TransitNetwork, TransitRegionMeta } from '../../transit/types';
import type { LngLat } from '../../types/geo';
import type { Route, RouteSegment } from '../../types/route';
import type { RouteRequest, RoutingCapabilities, RoutingProvider } from './RoutingProvider';

function inBBox(coord: [number, number], b: [number, number, number, number]): boolean {
  return coord[0] >= b[0] && coord[0] <= b[2] && coord[1] >= b[1] && coord[1] <= b[3];
}

/**
 * Replace straight-line first/last walk legs with real street-following walking geometry
 * from our on-device `walk` router (`LocalRoutingProvider`), falling back cleanly when
 * road tiles aren't loaded or the walk is very short (< 80 m).
 */
async function refineTransitWalkLegs(route: Route, walkRouter: RoutingProvider, signal?: AbortSignal): Promise<Route> {
  const trip = route.transit;
  if (!trip || trip.legs.length === 0) return route;

  const first = trip.legs[0];
  const last = trip.legs[trip.legs.length - 1];
  const needFirst = first.vehicle === 'walk' && first.distanceM >= 80 && first.toIndex > first.fromIndex;
  const needLast = last !== first && last.vehicle === 'walk' && last.distanceM >= 80 && last.toIndex > last.fromIndex;
  if (!needFirst && !needLast) return route;

  const walkGeom = async (from: LngLat, to: LngLat): Promise<{ geom: LngLat[]; distM: number; durS: number } | null> => {
    try {
      const res = await walkRouter.calculateRoutes({
        origin: { id: 'w0', name: '', label: '', coordinate: from },
        destination: { id: 'w1', name: '', label: '', coordinate: to },
        alternatives: false,
        signal,
      });
      const best = res[0];
      if (!best || best.geometry.length < 2) return null;
      return { geom: best.geometry, distM: Math.round(best.distanceM), durS: Math.max(60, Math.round(best.durationS)) };
    } catch {
      return null;
    }
  };

  const [firstWalk, lastWalk] = await Promise.all([
    needFirst ? walkGeom(route.geometry[first.fromIndex], route.geometry[first.toIndex]) : Promise.resolve(null),
    needLast ? walkGeom(route.geometry[last.fromIndex], route.geometry[last.toIndex]) : Promise.resolve(null),
  ]);
  if (!firstWalk && !lastWalk) return route;

  const newGeom: LngLat[] = [];
  const newLegs = trip.legs.map((l) => ({ ...l }));
  const newSegments: RouteSegment[] = [];

  const appendCoords = (coords: LngLat[]): { fromIndex: number; toIndex: number } => {
    const start = newGeom.length > 0 ? newGeom.length - 1 : 0;
    for (const c of coords) {
      const prev = newGeom[newGeom.length - 1];
      if (!prev || prev[0] !== c[0] || prev[1] !== c[1]) newGeom.push(c);
    }
    return { fromIndex: start, toIndex: Math.max(start, newGeom.length - 1) };
  };

  const addSegs = (fromIndex: number, toIndex: number, distM: number, durS: number) => {
    const count = Math.max(1, toIndex - fromIndex);
    for (let i = fromIndex; i < toIndex; i++) {
      newSegments.push({ fromIndex: i, toIndex: i + 1, distanceM: distM / count, durationS: durS / count });
    }
  };

  let totalDistM = 0;
  for (let i = 0; i < newLegs.length; i++) {
    const leg = newLegs[i];
    if (i === 0 && firstWalk) {
      const span = appendCoords(firstWalk.geom);
      leg.fromIndex = span.fromIndex;
      leg.toIndex = span.toIndex;
      leg.distanceM = firstWalk.distM;
      addSegs(span.fromIndex, span.toIndex, firstWalk.distM, Math.max(60, (leg.arriveMs - leg.departMs) / 1000));
      totalDistM += firstWalk.distM;
    } else if (i === newLegs.length - 1 && lastWalk) {
      const span = appendCoords(lastWalk.geom);
      leg.fromIndex = span.fromIndex;
      leg.toIndex = span.toIndex;
      leg.distanceM = lastWalk.distM;
      addSegs(span.fromIndex, span.toIndex, lastWalk.distM, Math.max(60, (leg.arriveMs - leg.departMs) / 1000));
      totalDistM += lastWalk.distM;
    } else {
      const slice = route.geometry.slice(leg.fromIndex, leg.toIndex + 1);
      const span = appendCoords(slice);
      leg.fromIndex = span.fromIndex;
      leg.toIndex = span.toIndex;
      addSegs(span.fromIndex, span.toIndex, Math.max(1, leg.distanceM), Math.max(60, (leg.arriveMs - leg.departMs) / 1000));
      totalDistM += leg.distanceM;
    }
  }

  return {
    ...route,
    geometry: newGeom,
    distanceM: totalDistM,
    segments: newSegments,
    transit: { ...trip, legs: newLegs },
  };
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

  constructor(
    private readonly dataRoot: string,
    private readonly walkRouter?: RoutingProvider,
  ) {}

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
    if (!this.walkRouter) return routes;
    return Promise.all(routes.map((r) => refineTransitWalkLegs(r, this.walkRouter!, req.signal)));
  }
}
