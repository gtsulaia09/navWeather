/**
 * Our search index (DEVELOPMENT_PLAN DP-4.4; ADR-019): settlements, named places, streets and addresses of a region
 * as static files the device searches itself (src/search/format.ts) — no search server, no third party (Nominatim,
 * Photon). Collected in the same pass over the extract as the places tiles (build.mjs).
 *
 * Every row has its names in the source script plus English and Russian (OSM `name:en`/`name:ru`, else the
 * app's own transliteration of Georgian — the same as on screen), and the settlement it belongs to for labels
 * ("Rustavelis Ave, Tbilisi").
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCK_ROWS, encodePostings, MAX_POSTINGS, SEARCH_VERSION, shardFile, shardOf, words } from '../../src/search/format.ts';
import { hasGeorgian, localizeScript } from '../../src/i18n/script.ts';
import { countryAt, decodeCountries } from '../../src/trip/countries.ts';

/** Country of a settlement for its label, from Natural Earth (the extract reaches over the border). */
const countries = decodeCountries(JSON.parse(readFileSync(new URL('../../src/trip/data/countries-v1.json', import.meta.url), 'utf8')));
const LOCAL_COUNTRY = { GE: 'საქართველო' };
function countryOf(lon, lat) {
  // A coastal town can fall just outside the simplified (≈1 km) coastline: look a little inland too.
  let p = [lon, lat];
  let en = countryAt(countries, p, 'en');
  for (const r of [0.02, 0.05]) {
    for (let k = 0; !en && k < 8; k++) {
      p = [lon + r * Math.cos((k * Math.PI) / 4), lat + r * Math.sin((k * Math.PI) / 4)];
      en = countryAt(countries, p, 'en');
    }
  }
  if (!en) return null;
  const ru = countryAt(countries, p, 'ru');
  return { en: en.name, ru: ru?.name ?? en.name, local: LOCAL_COUNTRY[en.code] ?? en.name };
}

/** Country names by ISO code (Natural Earth), for the labels of world cities. */
const countryNames = new Map(JSON.parse(readFileSync(new URL('../../src/trip/data/countries-v1.json', import.meta.url), 'utf8')).countries.map((c) => [c.c, c]));

/**
 * World cities (Natural Earth populated places, public domain, `data/raw/ne_10m_populated_places.geojson`) so a
 * search for a destination abroad ("Istanbul", "Ереван") finds the city — not a café of that name in the region.
 * The region's own countries are skipped: OpenStreetMap has their places in more detail.
 */
export function worldCities(path, skipCountries) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const f of JSON.parse(readFileSync(path, 'utf8')).features) {
    const p = f.properties;
    const code = [p.ISO_A2, p.ADM0_A3 && countryNames.has(p.ISO_A2) ? p.ISO_A2 : null].find((c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c));
    if (code && skipCountries.has(code)) continue;
    const [lon, lat] = f.geometry.coordinates;
    const country = code ? countryNames.get(code) : null;
    const local = clean(p.NAME);
    const en = clean(p.NAME_EN) || local;
    const ru = clean(p.NAME_RU) || en;
    const pop = Number(p.POP_MAX) || 0;
    out.push({
      id: `ne${p.NE_ID ?? `${lon},${lat}`}`,
      kind: pop >= 100_000 ? 'city' : 'town',
      rank: (pop >= 100_000 ? 30 : 24) + (pop > 0 ? Math.min(7, Math.log10(pop)) : 0),
      lon,
      lat,
      local,
      en,
      ru,
      all: [...new Set([local, en, ru, clean(p.NAMEASCII), clean(p.NAME_DE), clean(p.NAME_TR)].filter(Boolean))].join(' '),
      ctx: country ? { en: country.en, ru: country.ru, local: country.en } : { en: clean(p.ADM0NAME), ru: clean(p.ADM0NAME), local: clean(p.ADM0NAME) },
    });
  }
  return out;
}

/** Settlement kinds and their base rank (bigger first). */
const PLACE_RANK = { city: 30, town: 24, village: 16, suburb: 14, hamlet: 10, quarter: 8, neighbourhood: 8, isolated_dwelling: 3 };
/** Named features worth finding by name, with a rank; anything else named with one of these keys gets 6. */
const POI_KEYS = ['amenity', 'tourism', 'shop', 'leisure', 'historic', 'railway', 'aeroway', 'natural', 'office', 'healthcare', 'building'];
const BIG_POI = { aerodrome: 22, station: 18, university: 12, hospital: 12, peak: 10, museum: 10, stadium: 10, mall: 10 };
/** Named roads people search for — also while under construction (Tbilisi's Rustaveli Avenue, 2026). */
const STREET = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|service|road|construction)$/;

const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

function namesOf(t, base = t.name || t.brand || t['brand:en'] || t.operator) {
  const local = clean(base);
  const en = clean(t['name:en']) || clean(t.int_name) || clean(t['brand:en']) || (hasGeorgian(local) ? localizeScript(local, 'en') : local);
  const ru = clean(t['name:ru']) || clean(t['brand:ru']) || (hasGeorgian(local) ? localizeScript(local, 'ru') : local);
  // Georgian `ფ` romanizes to `p` on road signs (`Poti`), while foreign brands spell it `f`/`ph` (`Fresco` = `ფრესკო`).
  const fAlias = local.includes('ფ') ? localizeScript(local, 'en').replace(/p/gi, (m) => (m === 'P' ? 'F' : 'f')) : '';
  const all = new Set(
    [
      local,
      en,
      ru,
      fAlias,
      clean(t['name:ka']),
      clean(t.int_name),
      clean(t.old_name),
      clean(t.alt_name),
      clean(t.brand),
      clean(t['brand:en']),
      clean(t['brand:ru']),
      clean(t['brand:ka']),
      clean(t.operator),
    ].filter(Boolean),
  );
  return { local, en, ru, all: [...all].join(' ') };
}

export function createGeocodeCollector() {
  const rows = [];
  const settlements = [];
  const streets = new Map();

  function add(id, kind, rank, lon, lat, n, extra = {}) {
    rows.push({ id, kind, rank, lon, lat, ...n, ...extra });
  }

  return {
    /** A node or way (with its centre) from the extract. */
    add(type, id, tags, lon, lat, wayCoords) {
      const t = tags;
      const place = t.place && PLACE_RANK[t.place] !== undefined;
      if (place && t.name) {
        const pop = Number(String(t.population ?? '').replace(/[^\d]/g, ''));
        const rank = PLACE_RANK[t.place] + (pop > 0 ? Math.min(6, Math.log10(pop)) : 0);
        const n = namesOf(t);
        add(`${type}${id}`, t.place, rank, lon, lat, n, { country: true });
        if (/^(city|town|village)$/.test(t.place)) settlements.push({ lon, lat, en: n.en, ru: n.ru, local: n.local, rank });
        return;
      }
      if (type === 'w' && t.highway && STREET.test(t.highway) && t.name && wayCoords?.length) {
        // One row per street name and place: the street's ways are merged later, nearest settlement decides.
        const key = clean(t.name);
        const mid = wayCoords[Math.floor(wayCoords.length / 2)];
        const list = streets.get(key) ?? [];
        list.push({ lon: mid[0], lat: mid[1], tags: t, len: wayCoords.length });
        streets.set(key, list);
      }
      if (t['addr:housenumber'] && t['addr:street']) {
        const street = namesOf({ name: t['addr:street'] });
        const num = clean(t['addr:housenumber']);
        add(`${type}${id}`, 'address', 2, lon, lat, {
          local: `${street.local} ${num}`,
          en: `${street.en} ${num}`,
          ru: `${street.ru} ${num}`,
          all: `${street.all} ${num}`,
        }, { city: clean(t['addr:city']) });
        if (!t.name) return;
      }
      if (t.name || t.brand || t['brand:en']) {
        const key = POI_KEYS.find((k) => t[k] && t[k] !== 'no' && !(k === 'building' && t[k] === 'yes'));
        if (key) add(`${type}${id}`, t[key], BIG_POI[t[key]] ?? 6, lon, lat, namesOf(t));
      }
    },

    /** Rows with their own label (world cities): no nearest-settlement lookup. */
    addRows(list) {
      for (const r of list) rows.push({ ...r, fixedCtx: r.ctx });
    },

    /** Resolve settlements for labels and write the static search files under `dir` (public/data). */
    write(dir, meta) {
      // Streets: per name, cluster ways that are within 3 km of each other (one row per town's street).
      for (const [, ways] of streets) {
        const clusters = [];
        for (const w of ways) {
          const c = clusters.find((c) => Math.abs(c.lat - w.lat) < 0.03 && Math.abs(c.lon - w.lon) < 0.04);
          if (c) {
            if (w.len > c.len) Object.assign(c, w);
          } else clusters.push({ ...w });
        }
        for (const c of clusters) add(`s${c.lon.toFixed(5)},${c.lat.toFixed(5)}`, 'street', 5, c.lon, c.lat, namesOf(c.tags));
      }
      // Nearest settlement (grid of 0.1°) for every row's label.
      const grid = new Map();
      for (const s of settlements) {
        const k = `${Math.floor(s.lon * 10)},${Math.floor(s.lat * 10)}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(s);
      }
      const nearest = (lon, lat) => {
        let best = null;
        let bestScore = Infinity;
        const [gx, gy] = [Math.floor(lon * 10), Math.floor(lat * 10)];
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            for (const s of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
              const d = Math.hypot((s.lon - lon) * Math.cos((lat * Math.PI) / 180), s.lat - lat);
              const score = d / (1 + s.rank / 30); // a city wins over a village at a similar distance
              if (d < 0.12 && score < bestScore) [best, bestScore] = [s, score];
            }
        return best;
      };
      // Rows best first (rank), then static files (ADR-019, format: src/search/format.ts).
      const built = rows.map((r) => {
        const s = r.country || r.fixedCtx ? null : nearest(r.lon, r.lat);
        const ctx = r.fixedCtx ?? (r.country ? countryOf(r.lon, r.lat) : s ?? (r.city ? namesOf({ name: r.city }) : null));
        // A street or place counts more in a bigger town: Tbilisi's Rustaveli Avenue before a village's.
        const rank = r.rank + (s ? s.rank * (r.kind === 'street' ? 0.25 : 0.08) : 0);
        const ctxText = ctx ? [...new Set([ctx.local, ctx.en, ctx.ru])].join(' ') : '';
        return { r, ctx, rank, nameWords: [...new Set(words(r.all))], ctxWords: [...new Set(words(ctxText))] };
      });
      built.sort((x, y) => y.rank - x.rank);
      const root = join(dir, 'search', meta.build);
      rmSync(join(dir, 'search'), { recursive: true, force: true });
      const postings = new Map();
      const total = new Map();
      built.forEach((b, id) => {
        // Name words count fully; place-name words (the town) only to narrow a search down ("Rustaveli Tbilisi").
        for (const w of new Set([...b.nameWords, ...b.ctxWords])) {
          if ([...w].length < 2) continue;
          total.set(w, (total.get(w) ?? 0) + 1);
          let l = postings.get(w);
          if (!l) postings.set(w, (l = []));
          if (l.length < MAX_POSTINGS) l.push(id);
        }
      });
      const shards = new Map();
      for (const [w, ids] of postings) {
        const k = shardOf(w);
        let sh = shards.get(k);
        if (!sh) shards.set(k, (sh = {}));
        sh[w] = [total.get(w), encodePostings(ids)];
      }
      for (const [k, sh] of shards) {
        mkdirSync(join(root, 'w'), { recursive: true });
        writeFileSync(join(root, 'w', `${shardFile(k)}.json`), JSON.stringify(sh));
      }
      mkdirSync(join(root, 'r'), { recursive: true });
      const round = (v) => Math.round(v * 1e5) / 1e5;
      for (let i = 0; i < built.length; i += BLOCK_ROWS) {
        const block = built.slice(i, i + BLOCK_ROWS).map((b) => [
          b.r.id,
          b.r.kind,
          Math.round(b.rank * 100) / 100,
          round(b.r.lon),
          round(b.r.lat),
          b.r.en,
          b.r.ru,
          b.ctx?.en ?? '',
          b.ctx?.ru ?? '',
          b.nameWords.join(' ') + (b.ctxWords.length ? ` | ${b.ctxWords.join(' ')}` : ''),
        ]);
        writeFileSync(join(root, 'r', `${i / BLOCK_ROWS}.json`), JSON.stringify(block));
      }
      let w = 180, so = 90, e = -180, n = -90;
      for (const b of built) {
        if (b.r.fixedCtx) continue; // world cities don't widen the region
        w = Math.min(w, b.r.lon);
        e = Math.max(e, b.r.lon);
        so = Math.min(so, b.r.lat);
        n = Math.max(n, b.r.lat);
      }
      const index = {
        version: SEARCH_VERSION,
        build: meta.build,
        rows: built.length,
        blockRows: BLOCK_ROWS,
        shards: [...shards.keys()].sort(),
        bbox: [w, so, e, n].map((v) => Math.round(v * 1e4) / 1e4),
        source: meta.source,
      };
      writeFileSync(join(dir, 'search.json'), JSON.stringify(index));
      const kinds = {};
      for (const r of rows) kinds[r.kind === 'address' || r.kind === 'street' || PLACE_RANK[r.kind] !== undefined ? r.kind : 'place'] = (kinds[r.kind === 'address' || r.kind === 'street' || PLACE_RANK[r.kind] !== undefined ? r.kind : 'place'] ?? 0) + 1;
      return { rows: rows.length, kinds };
    },
  };
}
