import type { LngLat } from '../../types/geo';
import type { SpeedCamera, SpeedLimitWay } from '../../types/route';

export type { SpeedCamera, SpeedLimitWay };

export interface SpeedLimitProvider {
  readonly name: string;
  /** Tagged speed limits for roads along the route geometry (may be incomplete). */
  getSpeedLimits(route: LngLat[], signal?: AbortSignal): Promise<SpeedLimitWay[]>;
  /** Mapped speed cameras along the route (may be incomplete). */
  getSpeedCameras?(route: LngLat[], signal?: AbortSignal): Promise<SpeedCamera[]>;
  /** Mapped railway level crossings along the route (may be incomplete). */
  getLevelCrossings?(route: LngLat[], signal?: AbortSignal): Promise<{ id: string; coordinate: LngLat }[]>;
}
