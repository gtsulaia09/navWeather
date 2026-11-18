# ADR-019 — Zero cost for the owner at any scale: Free plan, static data files, engines on the device

**Status:** Accepted · **Date:** 2026-11-18 · **Decision by:** owner
**Replaces:** the "only hosting is paid" part of [ADR-015](ADR-015-free-software-own-hosting.md) and the paid services of
[ADR-016](ADR-016-all-on-cloudflare-workers.md) (Workers Paid, Containers, R2, D1, Queues, Cron for per-user work, a
custom domain). It also revises [ADR-004](ADR-004-routing-engine.md) (routing), [ADR-007](ADR-007-data-storage.md)
(storage), [ADR-011](ADR-011-public-transport.md) (transit), [ADR-012](ADR-012-offline.md) (offline) and
[ADR-013](ADR-013-trip-planner.md) (trip planner). Everything else in ADR-015 stays: free for users, no ads, no
sponsors, only free software and open data, no limited public servers.

## Context
On 2026-11-18 the owner asked what the app would cost at 1 billion users as built (ADR-015/016). A simulation with
Cloudflare list prices (checked 2026-11-18) gave **≈ $200,000 a month** at 30 % daily use: Worker requests
(≈ 25 per active user per day), Valhalla/MOTIS in Containers, Durable Objects, D1 and R2. Routing also needs more than
Cloudflare's 1,500 Container vCPU per account at that size. The owner's decision: **everything must be free for the
owner — hosting included — and fast for users.**

Facts (developers.cloudflare.com, 2026-11-18):
- Requests to **static assets are free and unlimited** on every plan; a Worker version holds 20,000 files on the Free
  plan, 25 MiB each. Requests that run the Worker (`/api/*`) count against the Free plan's **100,000 a day**.
- The **Free plan cannot bill**: past a daily limit, Workers and Durable Objects return errors (Workers error 1027;
  "further operations of that type will fail with an error"). Durable Objects (SQLite) are on the Free plan with
  100,000 requests a day.
- Containers need Workers Paid; R2 and D1 bill past their free allowances.
- GitHub Actions minutes are free for public repositories (this repository is public).
- OpenFreeMap: no limits on map views or requests, commercial use allowed, no keys.

## Options
1. **Keep ADR-016** (paid hosting): ≈ $200 k/month at 1 B users; routing exceeds account limits.
2. **Rented servers** instead of Cloudflare: cheaper per request, still a bill that grows with users.
3. **Zero marginal cost:** everything a user does is a static file plus code on the device; the server keeps only what
   must be shared between users, on the Free plan.

## Decision
**Option 3.**

| Part | Where it runs | Cost |
| --- | --- | --- |
| App, map styles | static assets (one Worker, Free plan, `*.workers.dev`) | $0, unlimited |
| Map background | OpenFreeMap (class C) | $0 |
| **Routing** (car, walk, bike), alternatives, via points, stops, avoid tolls/motorways/ferries, turn restrictions, turn-by-turn steps | **on the device** (`src/roads`, a Web Worker) over **static road files**: one main-roads file per region + street tiles (`public/data/roads/`), built from OSM by `pipelines/roads` | $0 |
| **Search** (suggestions, search, reverse naming) | on the device over **static index shards** (`public/data/search/`) | $0 |
| **Weather, air quality, ground heights** | on the device, reading **static tile files** (`public/data/weather/`, `…/air/`, `…/elevation/`) built on a schedule | $0 |
| Places, speed limits, cameras, borders | static tiles / bundled file (already) | $0 |
| **Long Trip planner** | on the device (same `src/trip` module) | $0 |
| Data builds | GitHub Actions (public repo) → deploy of static assets | $0 |
| Live sharing, driver reports | Worker + Durable Objects on the **Free plan** | $0; past 100,000 requests a day they say "busy" until 00:00 UTC |
| Public transport | **off** until an on-device timetable router over open GTFS exists (no free unlimited source) | — |
| Rough location from the connection (`/whereami`) | removed (the device's location or the map) | — |

Rules that follow:
- **No payment method on the Cloudflare account.** No Workers Paid, Containers, R2, D1, Queues or paid domain.
- **No per-user server work** except live sharing and reports. A new feature that needs the server for each user is
  not accepted; it is redesigned as a static file plus device code, or not built.
- **No public servers with limits, anywhere** (unchanged from ADR-015): the old fallbacks (public OSRM, FOSSGIS, Photon,
  Nominatim, Overpass, Open-Meteo API, Transitous) are removed. Outside the regions we build, the app says
  "not available here yet".
- **Fast by design:** data files are small (gzip, tiled), immutable per build, cached on the device (HTTP cache +
  service worker), and the heavy work runs in a Web Worker so the screen never freezes.

## Reason
- Static files and device code cost the owner nothing at any number of users; the bill cannot grow with users.
- Faster for users: no server round trip for routing, search or forecasts once files are cached; works offline for
  cached regions.
- Privacy improves: trips, searches and positions never leave the device (only sharing and reports do).

## Consequences
- Regions are built one by one (Georgia first). Each region's files must fit the Free plan (20,000 files per Worker
  version, 25 MiB per file); more regions go to more Workers on the same free account if needed.
- Routing quality is ours to maintain: hierarchical search (main roads + street tiles near the ends) instead of
  Valhalla; no travel-time matrix yet (detours are estimated).
- Sharing and reports can pause on very busy days. That is the price of never receiving a bill.
- At very large scale Cloudflare may ask for an Enterprise contract for the static traffic; the risk is a limit, not a
  bill.

## Alternatives rejected
- Paid hosting (ADR-016 as written): grows with users (≈ $200 k/month at 1 B).
- Reading Open-Meteo's AWS open-data bucket directly from each phone: no pipeline needed, but every user then depends
  on a third party's sponsorship; our own static files keep it under our control.
- Valhalla compiled to WebAssembly: no maintained build exists (2026-11-18).
