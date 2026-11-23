import type { ReportKind, Vote } from '../../reports/protocol';
import type { LngLat } from '../../types/geo';
import type { Incident, IncidentKind, Route } from '../../types/route';

export type { Incident, IncidentKind };

export interface IncidentProvider {
  readonly name: string;
  /** Incidents on or near the route. */
  getIncidents(route: Route, signal?: AbortSignal): Promise<Incident[]>;
  /** Report what the driver sees at their position (providers that accept reports). */
  report?(kind: ReportKind, coordinate: LngLat, signal?: AbortSignal): Promise<{ id: string; expiresAt: number }>;
  /** "Still there?" answer for someone else's report. `active: false` once it was taken down. */
  vote?(reportId: string, vote: Vote, signal?: AbortSignal): Promise<{ active: boolean }>;
}

/**
 * No free, reliable incident source exists for the prototype, so the default
 * returns nothing: the app stays silent rather than inventing hazards.
 */
export class NoIncidentProvider implements IncidentProvider {
  readonly name = 'none';
  async getIncidents(): Promise<Incident[]> {
    return [];
  }
}
