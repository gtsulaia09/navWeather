/**
 * OpenStreetMap tags → what a road allows (cars, bikes, walkers), how fast cars go, and its attributes — the rules our
 * road files are built with (ADR-019). The device router reads the result; it never sees raw tags.
 *
 * Speeds are typical free-flow speeds (no traffic), close to the OSRM car profile: a posted limit counts at 80 %
 * (towns, trucks, bends), never faster than 1.3× the class's typical speed.
 */
import { ACCESS, ATTR, CLASS } from '../../src/roads/format.ts';

export const ROUTABLE = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|track|path|footway|cycleway|pedestrian|steps|bridleway)(_link)?$/;

const CAR_KMH = { motorway: 100, trunk: 80, primary: 65, secondary: 55, tertiary: 45, unclassified: 35, residential: 25, living_street: 10, service: 15, track: 12, road: 25 };
const LINK_KMH = { motorway: 60, trunk: 50, primary: 40, secondary: 35, tertiary: 30 };
const TRACK_KMH = { grade1: 25, grade2: 18, grade3: 12, grade4: 8 };
const NO_CAR_CLASS = new Set(['path', 'footway', 'cycleway', 'pedestrian', 'steps', 'bridleway']);
const DENY = new Set(['no', 'private', 'agricultural', 'forestry', 'emergency', 'military', 'use_sidepath']);
const ALLOW = new Set(['yes', 'designated', 'permissive', 'destination', 'customers', 'delivery', 'official']);
const UNPAVED = /^(unpaved|gravel|fine_gravel|dirt|ground|earth|grass|sand|mud|compacted|pebblestone|rock)$/;

/** Implicit urban/rural limits written as "XX:urban" (km/h). */
const ZONE = { urban: 60, rural: 90, motorway: 110, trunk: 90, living_street: 20, walk: 5 };

export function parseMaxspeed(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'none' || s === 'signals' || s === 'variable') return null;
  if (s === 'walk') return 5;
  const zone = /^[a-z]{2}:(\w+)$/.exec(s);
  if (zone) return ZONE[zone[1]] ?? null;
  const m = /^(\d+(?:\.\d+)?)\s*(mph|knots)?/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  return m[2] === 'mph' ? n * 1.609 : m[2] === 'knots' ? n * 1.852 : n;
}

/** Ferry duration tag ("1:30", "90", "PT1H30M") → hours. */
function ferryHours(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return Number(m[1]) + Number(m[2]) / 60 + Number(m[3] ?? 0) / 3600;
  m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i.exec(s);
  if (m) return Number(m[1] ?? 0) + Number(m[2] ?? 0) / 60;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) / 60;
  return null;
}

const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');

/** Is this way something we route on? (`highway` of a routable class, or a ferry route.) */
export function isRoutable(t) {
  if (!t) return false;
  if (t.route === 'ferry') return true;
  if (!t.highway || !ROUTABLE.test(t.highway)) return false;
  if (t.area === 'yes') return false;
  return true;
}

/**
 * The attributes of one way, or null when no mode may use it.
 * Returns { cls, link, carKmh (also the ferry speed for every mode), access bits, attr bits }.
 */
export function roadOf(t, lengthM = 0) {
  if (!isRoutable(t)) return null;
  const ferry = t.route === 'ferry';
  const hw = ferry ? 'ferry' : t.highway;
  const link = !ferry && hw.endsWith('_link');
  const base = link ? hw.slice(0, -5) : hw;
  const cls = ferry ? CLASS.ferry : CLASS[base];
  if (cls === undefined) return null;

  const general = t.access;
  const vehicle = first(t.vehicle, general);
  const motor = first(t.motorcar, t.motor_vehicle, vehicle);
  const bikeTag = first(t.bicycle, vehicle);
  const footTag = first(t.foot, general);

  // Cars
  let car;
  if (ferry) car = ALLOW.has(first(t.motorcar, t.motor_vehicle) ?? '');
  else if (NO_CAR_CLASS.has(base)) car = ALLOW.has(first(t.motorcar, t.motor_vehicle) ?? '');
  else car = !DENY.has(motor ?? '') && !(base === 'track' && t.tracktype === 'grade5') && t.service !== 'emergency_access';

  // Bikes
  let bike;
  if (ferry) bike = true;
  else if (base === 'motorway') bike = bikeTag === 'yes' || bikeTag === 'designated';
  else if (base === 'steps') bike = bikeTag === 'yes' || bikeTag === 'designated';
  else bike = !DENY.has(bikeTag ?? '');

  // Walkers
  let foot;
  if (ferry) foot = true;
  else if (base === 'motorway') foot = footTag === 'yes' || footTag === 'designated';
  else foot = !DENY.has(footTag ?? '');
  if (!car && !bike && !foot) return null;

  // Direction (cars, and bikes unless exempt)
  const ow = t.oneway;
  const roundabout = t.junction === 'roundabout' || t.junction === 'circular';
  let fwdOnly = ow === 'yes' || ow === '1' || ow === 'true' || ((roundabout || base === 'motorway') && ow !== 'no');
  let bwdOnly = ow === '-1' || ow === 'reverse';
  if (ferry) fwdOnly = bwdOnly = false;
  const bikeExempt = t['oneway:bicycle'] === 'no' || /^opposite/.test(t.cycleway ?? '');
  let access = 0;
  if (car) access |= (bwdOnly ? 0 : ACCESS.carFwd) | (fwdOnly ? 0 : ACCESS.carBwd);
  if (bike) access |= bikeExempt ? ACCESS.bikeFwd | ACCESS.bikeBwd : (bwdOnly ? 0 : ACCESS.bikeFwd) | (fwdOnly ? 0 : ACCESS.bikeBwd);
  if (foot) access |= ACCESS.foot;
  if (!access) return null;

  // Speed (cars; ferries: every mode)
  let kmh = 0;
  if (ferry) {
    const h = ferryHours(t.duration);
    kmh = h && lengthM > 0 ? Math.max(5, Math.min(60, lengthM / 1000 / h)) : 20;
  } else if (car) {
    const typical = link ? (LINK_KMH[base] ?? 30) : base === 'track' ? (TRACK_KMH[t.tracktype] ?? CAR_KMH.track) : (CAR_KMH[base] ?? 25);
    const posted = parseMaxspeed(first(t.maxspeed, t['maxspeed:forward']));
    kmh = posted ? Math.min(posted * 0.8, typical * 1.3) : typical;
    if (base === 'service' && (t.service === 'parking_aisle' || t.service === 'driveway')) kmh = Math.min(kmh, 10);
    if (base !== 'track' && UNPAVED.test(t.surface ?? '')) kmh *= 0.6;
    kmh = Math.max(5, Math.round(kmh));
  }

  let attr = 0;
  if (t.toll === 'yes' || t['toll:motorcar'] === 'yes') attr |= ATTR.toll;
  if (ferry) attr |= ATTR.ferry;
  if (roundabout) attr |= ATTR.roundabout;
  if (link) attr |= ATTR.link;
  if (t.tunnel && t.tunnel !== 'no') attr |= ATTR.tunnel;
  if (t.bridge && t.bridge !== 'no') attr |= ATTR.bridge;

  return { cls, link, carKmh: Math.round(kmh), access, attr };
}

/** Names and signage kept for turn-by-turn instructions. */
export function wayText(t) {
  return {
    name: t.name,
    nameEn: first(t['name:en'], t.int_name),
    nameRu: t['name:ru'],
    ref: t.ref,
    dest: first(t.destination, t['destination:forward']),
    lanesFwd: first(t['turn:lanes:forward'], t['turn:lanes']),
    lanesBwd: t['turn:lanes:backward'],
  };
}

/** A turn restriction relation → { from, via, to, only } (OSM ids), or null for kinds we don't model. */
export function restrictionOf(rel) {
  const t = rel.tags ?? {};
  if (t.type !== 'restriction') return null;
  const kind = first(t['restriction:motorcar'], t['restriction:motor_vehicle'], t.restriction);
  if (!kind || !/^(no|only)_/.test(kind)) return null;
  if (/(^|;)\s*(motorcar|motor_vehicle)\s*(;|$)/.test(t.except ?? '')) return null;
  const from = rel.members.filter((m) => m.role === 'from' && m.type === 'way');
  const via = rel.members.filter((m) => m.role === 'via');
  const to = rel.members.filter((m) => m.role === 'to' && m.type === 'way');
  if (from.length !== 1 || to.length !== 1 || via.length !== 1 || via[0].type !== 'node') return null;
  return { from: from[0].ref, via: via[0].ref, to: to[0].ref, only: kind.startsWith('only_') };
}
