import type { LngLat } from '../../types/geo';
import type { Route } from '../../types/route';
import type { RoadClient } from '../../roads/client';
import { RoadEngineError, type RoutePoint } from '../../roads/engine';
import type { RoadMode } from '../../roads/profiles';
import { isAbortError, ProviderError } from '../http';
import { normalizeOsrmRoute, type OsrmRoute } from './OSRMProvider';
import type { RouteRequest, RoutingCapabilities, RoutingProvider } from './RoutingProvider';

/**
 * Routing on the device (ADR-019): car, walking and cycling over our static road files — alternatives, silent via
 * points, stops, avoiding tolls, motorways and ferries, turn restrictions and lanes. No server, no request limit,
 * nothing about the trip leaves the device.
 */
export class LocalRoutingProvider implements RoutingProvider {
  readonly name = 'navweather';
  readonly capabilities: RoutingCapabilities = {
    alternatives: true,
    avoid: ['tolls', 'highways', 'ferries'],
    laneGuidance: true,
    matrix: false,
    multiStop: true,
    via: true,
  };
  private readonly client: RoadClient;
  private readonly mode: RoadMode;
  private readonly maxAlternatives: number;

  constructor(client: RoadClient, mode: RoadMode, maxAlternatives = 2) {
    this.client = client;
    this.mode = mode;
    this.maxAlternatives = maxAlternatives;
  }

  async calculateRoutes(req: RouteRequest): Promise<Route[]> {
    const via = !req.waypoints?.length ? (req.via ?? []) : [];
    const pt = ([lon, lat]: LngLat, isVia = false): RoutePoint => (isVia ? { lon, lat, via: true } : { lon, lat });
    const points: RoutePoint[] = [
      pt(req.origin.coordinate),
      ...via.map((c) => pt(c, true)),
      ...(req.waypoints ?? []).map((w) => pt(w.coordinate)),
      pt(req.destination.coordinate),
    ];
    try {
      const routes = await this.client.route(
        {
          mode: this.mode,
          points,
          alternatives: req.alternatives && points.length === 2 ? this.maxAlternatives : 0,
          avoid: (req.avoid ?? []).filter((a) => this.capabilities.avoid.includes(a)),
          ...(req.startBearingDeg !== undefined && Number.isFinite(req.startBearingDeg) ? { bearingDeg: req.startBearingDeg } : {}),
          language: req.language === 'ru' ? 'ru' : 'en',
        },
        req.signal,
      );
      return routes.map((r) => ({ ...normalizeOsrmRoute(r as unknown as OsrmRoute, req), provider: this.name }));
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw toProviderError(e);
    }
  }
}

function toProviderError(e: unknown): ProviderError {
  if (e instanceof RoadEngineError) {
    switch (e.code) {
      case 'not-covered':
        return new ProviderError(e.message, 'not-covered', 'Routing');
      case 'no-road-nearby':
      case 'no-route':
        return new ProviderError(e.message, 'no-route', 'Routing');
      case 'data-missing':
        return new ProviderError(e.message, 'data-missing', 'Routing');
      case 'data-unavailable':
        return new ProviderError(e.message, 'network', 'Routing');
    }
  }
  return new ProviderError(e instanceof Error ? e.message : String(e), 'invalid-response', 'Routing');
}
