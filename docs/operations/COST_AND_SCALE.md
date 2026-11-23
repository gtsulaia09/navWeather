# Cost and scale model

Decision: [ADR-019](../architecture/decisions/ADR-019-zero-owner-cost.md) (owner, 2026-11-18) — **the owner pays
nothing, at any number of users** — and [ADR-020](../architecture/decisions/ADR-020-free-at-any-scale-overflow.md)
(owner, 2026-11-21) — **and everything keeps working at any number of users**: what used to stop at the Free plan's
daily limit now overflows to the users' devices. Earlier model (ADR-015/016: "only hosting is paid") and its simulation are in git
history; at 1 billion users (30 % daily) it came to ≈ $200,000 a month, mostly Worker requests and Valhalla/MOTIS in
Containers. Prices verified 2026-11-18 at developers.cloudflare.com.

## 1. Where every part runs and what it costs

| Part | Runs | Cost to the owner | Limit, and what happens past it |
| --- | --- | --- | --- |
| App, map styles | static assets (Worker, Free plan) | $0 | none for requests; 20,000 files × 25 MiB per Worker version |
| Map background | **our basemap**: static packs on the assets-only Worker `navweather-basemap` (ADR-020); OpenFreeMap only while none is deployed | $0 | none for requests; 20,000 files per Worker version (Georgia + world: 1,950) |
| Routing (car, walk, bike) | device, over static road files (`/data/roads`) | $0 | — |
| Public transport (bus, metro, rail, cable) | device (RAPTOR in `src/transit/raptor.ts`), over static gzipped GTFS bundle (`/data/transit`, `223 kB gz` for Tbilisi + Georgian Railway) | $0 | — |
| Search | device, over static index files (`/data/search`) | $0 | — |
| Forecast, air quality, heights | device, over static tiles (`/data/weather`, `/data/air`, `/data/elev`) | $0 | — |
| Places, speed limits, cameras, borders | static tiles / bundled file | $0 | — |
| Long Trip planner | device | $0 | — |
| Data builds | GitHub Actions, public repository | $0 | unlimited minutes for public repositories |
| Report reads | **static feed** on the assets-only Worker `navweather-reports`, rebuilt every ~10 min (`reports-feed.yml`) | $0 | none for requests; reports up to ~10 min old |
| Live sharing, report writes | Worker + Durable Objects, Free plan, **then overflow** (ADR-020): sharing phone to phone (WebRTC, handshake via public Nostr relays), reports as signed Nostr events merged into the feed | $0 | the Worker's 100,000 requests a day; past them the overflow path — no limit of ours, relays carry no guarantee |
| Compression (`fflate`, MIT) | Pure-JS gzip/deflate on device (Browser, Web Worker, Node, Hermes) | $0 | none (zero server calls, zero native-only browser APIs) |
| Mobile / React Native clients (future) | Reuse same shared TS core (`src/*`) and read the exact same static `/data` files (cached on disk via `FileCacheProvider`) and `/api/v1` | $0 | same as web; zero extra backend infrastructure |
| App store publishing (optional) | Web/PWA, Android APK + F-Droid, Wear OS sideload, Android Auto unknown-sources, iOS 7-day free Apple ID, Xcode simulators are **$0**; Apple Developer Program (\$99/yr) & Google Play (\$25 once) are **BLOCKED** until owner decides (ADR-015) | $0 today | publishing to public App Store / Google Play is the sole optional paid step |
| Domain | `*.workers.dev` | $0 | — |

The account has **no payment method**, so nothing can be charged. `npm run check:envs` (CI) fails on any binding that
could bill (D1, R2, Containers, Queues) and on any binding at all in the two asset-only Workers (`wrangler.reports.toml`,
`wrangler.basemap.toml`). `npm run check:cost` (CI) fails if the production bundle (`dist/`), CSP `connect-src`, or any
`.env.*` file references any forbidden public service with limits, any paid/metered API, or any TURN server; `e2e/smoke.spec.ts`
and `e2e/mobile.spec.ts` fail on any network request outside the `AGENTS.md` allowlist.

## 2. What a user downloads (measured 2026-11-18, Georgia)

| Data | Files | Size | Per trip / search |
| --- | --- | --- | --- |
| Main roads of the region | 1 | 0.87 MB gzip | once per build (cached) |
| Street tiles (zoom 11) | 410 | 14.4 MB gzip total, ≈ 35 kB each (largest, central Tbilisi, 1.1 MB) | the tiles around start and end |
| Search index | 2,169 word files + 788 row blocks (250 rows each) | ≈ 66 MB raw, compressed by Cloudflare | one word file + a few row blocks (≈ 55 kB raw each) |
| Forecast (whole world, land and coasts) | 5,050 tiles of 2°, ≈ 45 kB gzip each | ≈ 200 MB per run | the tiles along the route, once per model run |
| Places tiles | 2,681 | 8.7 MB | the tiles near the route |
| Public transport timetables (Georgia: Tbilisi + Georgian Railway) | 1 + manifest | 223 kB gzip (1.18 MB raw; 2,464 stops, 293 routes, 37,436 departures) | once per build (cached), loaded only when Transit mode is chosen |

Everything inside a build folder is immutable: cached by the browser for a year and by the service worker (600 files),
so repeat trips and searches need no download at all. Total files of one deploy (Georgia + the world's forecast):
≈ 14,300 of the 20,000 a Free-plan Worker may hold.

Building the world's forecast reads ≈ 800 MB of open data per run (ECMWF/GFS in the Open-Meteo archive on AWS, read in
8 kB blocks so oceans are skipped; measured 52 MB for Europe's 323 tiles) — free, on GitHub Actions, ≈ 20 minutes.

## 2a. 60 million people online at once (simulation, 2026-11-21, `main` = c68b928 → ADR-020)

| | Before ADR-020 | After ADR-020 |
| --- | --- | --- |
| Owner's bill | $0 | **$0** (optional domain ≤ $12/year) |
| Requests to our Worker | 482,000/s: the daily limit is gone in 0.2 s, then sharing and reports are "busy" | ≤ 100,000 a day (writes only); reads from static files; the rest phone to phone or through relays |
| One reports object (~1,000 req/s) | 122,000 req/s needed | ≈ 1 req/s at most (reads moved to the feed) |
| Map background | OpenFreeMap, ≈ 2.5 million tiles/s — it would fail | our static packs; ≈ 15 packs per user per region, then cached |
| Static traffic on one free account | ≈ 870 Gbit/s | lower (packs and data cached on the device), still hundreds of Gbit/s: Cloudflare may limit the account, it cannot bill |
| If it were paid instead (Workers Paid, DO, R2, an Enterprise contract) | ≈ $1.37 million a month | not needed |

Remaining risks, none of them a bill: public relays without guarantees (3 per message from a list); viewers behind
strict NATs get positions every 15 s through relays; Cloudflare's discretion over a very large free account; GitHub
disables schedules after 60 days without commits.

## 3. Scale rules

- Per-user server work: only sharing and reports. A feature that needs the server per user is redesigned as static
  data + device code, or not built (ADR-019).
- Upstream data volume (OSM extracts, model runs, CAMS, DEM) depends on regions and refresh cadence, **not on users**.
- More regions: each region's road, search and places files are added to the deploy; past 20,000 files, further regions
  go to further Workers on the same free account (static assets of each are free).
- Sharing and reports: the Free plan's daily limits cap only the Worker path; past them the overflow paths of ADR-020
  carry on (phone to phone, Nostr relays, the static feed). No feature waits for "busy" to end.
- At Google-Maps-class traffic Cloudflare may ask for an Enterprise contract for the static traffic: the risk is a limit
  on the account, not a charge.

## 4. Triggers

| Trigger | Action |
| --- | --- |
| A region's street tile > 1 MB (central Tbilisi today) | split dense tiles one zoom level deeper (smaller first download) |
| Files of one deploy near 20,000 (≈ 14,300 now) | move the forecast to its own free Worker (then 1° tiles, ≈ 18,200 files, fit there), or pack places tiles by area |
| Overflow used most of the day | expected at scale (ADR-020); watch `npm run check:relays` and keep ≥ 5 relays answering — never a paid plan |
| A basemap pack > 10 MB | split that band one zoom level deeper (`src/map/packs.ts` BANDS) |
| New region | `pipelines/roads`, `pipelines/osm` for its extract (the forecast already covers the world) |
