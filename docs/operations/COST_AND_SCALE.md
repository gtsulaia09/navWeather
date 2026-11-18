# Cost and scale model

Decision: [ADR-019](../architecture/decisions/ADR-019-zero-owner-cost.md) (owner, 2026-11-18) — **the owner pays
nothing, at any number of users.** Earlier model (ADR-015/016: "only hosting is paid") and its simulation are in git
history; at 1 billion users (30 % daily) it came to ≈ $200,000 a month, mostly Worker requests and Valhalla/MOTIS in
Containers. Prices verified 2026-11-18 at developers.cloudflare.com.

## 1. Where every part runs and what it costs

| Part | Runs | Cost to the owner | Limit, and what happens past it |
| --- | --- | --- | --- |
| App, map styles | static assets (Worker, Free plan) | $0 | none for requests; 20,000 files × 25 MiB per Worker version |
| Map background | OpenFreeMap | $0 | none ("no limits on map views or requests") |
| Routing (car, walk, bike) | device, over static road files (`/data/roads`) | $0 | — |
| Search | device, over static index files (`/data/search`) | $0 | — |
| Forecast, air quality, heights | device, over static tiles (`/data/weather`, `/data/air`, `/data/elev`) | $0 | — |
| Places, speed limits, cameras, borders | static tiles / bundled file | $0 | — |
| Long Trip planner | device | $0 | — |
| Data builds | GitHub Actions, public repository | $0 | unlimited minutes for public repositories |
| Live sharing, driver reports | Worker + Durable Objects, Free plan | $0 | 100,000 Worker requests and 100,000 Durable Object requests a day: past that, errors until 00:00 UTC — the app says "busy", never a bill |
| Domain | `*.workers.dev` | $0 | — |

The account has **no payment method**, so nothing can be charged. `npm run check:envs` (CI) fails on any binding that
could bill (D1, R2, Containers, Queues).

## 2. What a user downloads (measured 2026-11-18, Georgia)

| Data | Files | Size | Per trip / search |
| --- | --- | --- | --- |
| Main roads of the region | 1 | 0.87 MB gzip | once per build (cached) |
| Street tiles (zoom 11) | 410 | 14.4 MB gzip total, ≈ 35 kB each (largest, central Tbilisi, 1.1 MB) | the tiles around start and end |
| Search index | 2,169 word files + 197 row blocks | ≈ 66 MB raw, compressed by Cloudflare | one word file + a few row blocks |
| Forecast | 1° tiles, ≈ 30 kB gzip | Caucasus box | the tiles along the route, once per model run |
| Places tiles | 2,681 | 8.7 MB | the tiles near the route |

Everything inside a build folder is immutable: cached by the browser for a year and by the service worker (600 files),
so repeat trips and searches need no download at all. Total files of one deploy (Georgia): ≈ 8,000 of the 20,000 a
Free-plan Worker may hold.

## 3. Scale rules

- Per-user server work: only sharing and reports. A feature that needs the server per user is redesigned as static
  data + device code, or not built (ADR-019).
- Upstream data volume (OSM extracts, model runs, CAMS, DEM) depends on regions and refresh cadence, **not on users**.
- More regions: each region's road, search and places files are added to the deploy; past 20,000 files, further regions
  go to further Workers on the same free account (static assets of each are free).
- Sharing and reports: the Free plan's daily limits cap them. At very large scale they will often be "busy"; that is the
  price of never receiving a bill.
- At Google-Maps-class traffic Cloudflare may ask for an Enterprise contract for the static traffic: the risk is a limit
  on the account, not a charge.

## 4. Triggers

| Trigger | Action |
| --- | --- |
| A region's street tile > 1 MB (central Tbilisi today) | split dense tiles one zoom level deeper (smaller first download) |
| Files of one deploy near 20,000 | move a data set (search, places) to its own free Worker |
| Sharing/reports "busy" on most days | shard reports per region; consider peer-to-peer sharing — never a paid plan |
| New region | `pipelines/roads`, `pipelines/osm` for its extract; forecast box widened |
