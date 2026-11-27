import type { BBox, LngLat, Place } from './geo';

/** Where per-vertex travel times came from, most accurate first. */
export type TimingSource = 'annotations' | 'steps' | 'proportional';

/**
 * A stretch of the route geometry with a travel duration.
 *
 * This is the ETA abstraction: the routing provider fills `durationS`
 * (typical, no live traffic). A future TrafficProvider only needs to set
 * `currentDurationS` — route timing prefers it — and the whole weather
 * pipeline re-times itself without any other change.
 */
export interface RouteSegment {
  /** Geometry vertex index where the segment starts. */
  fromIndex: number;
  /** Geometry vertex index where the segment ends (> fromIndex). */
  toIndex: number;
  distanceM: number;
  durationS: number;
  /** Traffic-adjusted duration, when a traffic provider is available. */
  currentDurationS?: number;
  speedMps?: number;
}

/**
 * One lane at a maneuver, straight from routing data (OSM turn:lanes).
 * `indications` use OSRM vocabulary: 'left', 'slight right', 'straight', 'uturn', 'none'…
 */
export interface Lane {
  indications: string[];
  /** Lane can be used for this maneuver. */
  valid: boolean;
}

export interface RouteStep {
  distanceM: number;
  durationS: number;
  name: string;
  ref?: string;
  /** Signposted destinations, e.g. "Kutaisi, Batumi". */
  destinations?: string;
  rotaryName?: string;
  maneuverType: string;
  maneuverModifier?: string;
  /** Roundabout exit number. */
  exit?: number;
  location: LngLat;
  bearingBefore?: number;
  bearingAfter?: number;
  /** Lanes at the maneuver point — only when the routing data has them. */
  lanes?: Lane[];
  /** Metres before the maneuver over which `lanes` hold (the mapped road they are tagged on), when known. */
  lanesApproachM?: number;
  /** Road classes along the step when provided (e.g. 'toll', 'motorway', 'ferry'). */
  classes?: string[];
  drivingSide?: 'left' | 'right';
  /** Geometry vertex range covered by this step, when it could be aligned. */
  fromIndex?: number;
  toIndex?: number;
}

export interface RouteLeg {
  distanceM: number;
  durationS: number;
  summary: string;
  steps: RouteStep[];
}

export interface Route {
  id: string;
  provider: string;
  origin: Place;
  destination: Place;
  /** Intermediate stops (multi-stop trips), in order. */
  waypoints?: Place[];
  /** Full-resolution road geometry. */
  geometry: LngLat[];
  distanceM: number;
  durationS: number;
  legs: RouteLeg[];
  segments: RouteSegment[];
  /** Granularity of `segments`. */
  segmentSource: TimingSource;
  bbox: BBox;
  computedAt: number;
  /** A public-transport trip: timetabled, so it starts at a set time (not whenever you leave). */
  transit?: TransitTrip;
}

/** What a public-transport leg is ridden in ('walk': on foot between stops). */
export type TransitVehicle = 'walk' | 'bus' | 'tram' | 'subway' | 'rail' | 'ferry' | 'cable' | 'plane' | 'other';

/** One part of a public-transport trip: a walk, or one ride on one line. */
export interface TransitLeg {
  vehicle: TransitVehicle;
  /** Line as signed ("476", "M1"); none for a walk. */
  line?: string;
  /** Line colours from the timetable ("#0033b4"), when it has them. */
  color?: string;
  textColor?: string;
  /** Where the vehicle is heading, as shown on it. */
  headsign?: string;
  agency?: string;
  fromName: string;
  toName: string;
  /** UTC ms. */
  departMs: number;
  arriveMs: number;
  distanceM: number;
  /** Stops ridden (the one you get off at included); 0 for a walk. */
  stops: number;
  /** Times include live delays from the operator. */
  realTime: boolean;
  /** Geometry vertex range of this leg. */
  fromIndex: number;
  toIndex: number;
}

export interface TransitTrip {
  /** When the trip starts (the walk to the first stop) and ends, UTC ms. */
  departMs: number;
  arriveMs: number;
  transfers: number;
  legs: TransitLeg[];
}

/**
 * A route with cumulative distance and travel time for every geometry vertex.
 * This is what answers "where will I be after N minutes?" and vice versa.
 */
export interface TimedRoute {
  route: Route;
  /** Cumulative great-circle distance per vertex (m), starts at 0. */
  cumDistM: Float64Array;
  /** Cumulative travel time per vertex (s), starts at 0. */
  cumTimeS: Float64Array;
  totalDistM: number;
  totalTimeS: number;
  timingSource: TimingSource;
}

export type SampleReason =
  | 'origin'
  | 'destination'
  | 'settlement'
  | 'elevation'
  | 'junction'
  | 'turn'
  | 'time'
  | 'distance'
  | 'weather-change';

/** A route position selected for a weather lookup. */
export interface RouteSample {
  /** Stable id (route id + distance) — survives forecast refreshes. */
  id: string;
  coordinate: LngLat;
  distanceM: number;
  /** Travel time from the route start to here (s). */
  travelTimeS: number;
  reasons: SampleReason[];
  placeName?: string;
  /** 'in' = the sample is at the settlement, 'near' = closest named place. */
  placeRelation?: 'in' | 'near';
  placeKind?: PlaceKind;
  elevationM?: number;
}

export type PlaceKind = 'city' | 'town' | 'village';

/** A settlement snapped onto the route. */
export interface PlaceAlongRoute {
  id: string;
  name: string;
  kind: PlaceKind;
  population?: number;
  coordinate: LngLat;
  /** Distance along the route of the closest route point (m). */
  distanceAlongM: number;
  /** Perpendicular distance from the route (m). */
  offsetM: number;
}

export interface ElevationProfile {
  distancesM: number[];
  elevationsM: number[];
}

/** A settlement returned by a places source before snapping to a route. */
export interface RawPlace {
  id: string;
  name: string;
  kind: PlaceKind;
  population?: number;
  coordinate: LngLat;
}

/** A road stretch with a posted limit (km/h) from map data. */
export interface SpeedLimitWay {
  kmh: number;
  geometry: LngLat[];
}

/** A fixed speed camera from map data (only where the user enabled camera alerts). */
export interface SpeedCamera {
  id: string;
  coordinate: LngLat;
  /** Enforced limit when mapped, km/h. */
  kmh?: number;
}

export type IncidentKind = 'accident' | 'closure' | 'roadworks' | 'congestion' | 'hazard' | 'weather';

/**
 * A road incident from a provider (official feed or user reports), already
 * normalized. `verified` separates confirmed data from unconfirmed reports —
 * reports are never presented as fact.
 */
export interface Incident {
  id: string;
  kind: IncidentKind;
  coordinate: LngLat;
  severity: 'critical' | 'high' | 'medium' | 'low';
  verified: boolean;
  /** Provider / feed name, shown as the source. */
  source: string;
  reportedAt: number;
  /** UTC ms; unknown when omitted. Expired incidents are dropped. */
  expiresAt?: number;
  description?: string;
  /** Driver reports: the relay's id (to answer "still there?"). */
  reportId?: string;
  /** Driver reports: how many other drivers said it is still there. */
  confirmations?: number;
}

/** A timed route with settlements, elevation, weather samples and non-fatal warnings. */
export interface PlannedRoute {
  timed: TimedRoute;
  places: PlaceAlongRoute[];
  elevation: ElevationProfile | null;
  samples: RouteSample[];
  /** Non-fatal degradations, e.g. place names unavailable. */
  warnings: string[];
  /** Whether weather-change refinement already ran for this plan. */
  refined: boolean;
  /**
   * Settlements that missed the soft deadline. Resolves later (or to []);
   * the store then names samples without re-sampling or refetching weather.
   */
  latePlaces?: Promise<PlaceAlongRoute[]>;
}
