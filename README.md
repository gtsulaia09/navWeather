<p align="center">
  <img src="public/icons/icon-192.png" alt="WayTher icon" width="84" height="84" />
</p>

<h1 align="center">WayTher</h1>

<p align="center">
  <strong>Know what's ahead before you get there.</strong><br />
  Weather-aware navigation that calculates <em>where</em> you'll be, <em>when</em>, and the exact forecast along every part of your route — free, open-data, and running on your device.
</p>

<p align="center">
  <a href="https://gtsulaia09.github.io/navWeather/"><img src="https://img.shields.io/badge/live%20demo-try%20now-0a64e8.svg" alt="Live Demo" /></a>
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" />
  <img src="https://img.shields.io/badge/cost-%240%20at%20any%20scale-157a3a.svg" alt="$0 at any scale" />
  <img src="https://img.shields.io/badge/languages-EN%20%7C%20RU%20%7C%20KA-2f6fe0.svg" alt="Languages: EN, RU, KA" />
  <img src="https://img.shields.io/badge/platforms-Web%20%7C%20PWA%20%7C%20iOS%20%7C%20React%20Native-16181c.svg" alt="Platforms" />
</p>

---

```text
Tbilisi → Batumi · 357 km · 4 h 53 min
LEAVE 08:00  Tbilisi     ☁ 18°
ETA   09:10  Gori        ☁ 19°
ETA   10:05  Khashuri    🌧 17°  65%   "Rain is likely in about 55 minutes, near Khashuri."
ETA   11:40  Samtredia   ☀ 21°
ETA   13:00  Batumi      ☁ 23°
```

WayTher turns open data (**OpenStreetMap**, **ECMWF IFS**, **NOAA GFS**, **CAMS Air Quality**, **Copernicus DEM**, **GTFS**) into compact static files read directly **on the user's device** — no API keys, no paid services, no tracking, and `$0` hosting cost at any scale ([ADR-019](docs/architecture/decisions/ADR-019-zero-owner-cost.md), [ADR-020](docs/architecture/decisions/ADR-020-free-at-any-scale-overflow.md)).

## Key features

- **Route-time weather & alerts** — compares up to 3 genuinely different roads with per-route weather ribbons, rain/storm exposure in minutes, **When to leave** (12-hour departure chart), **Return weather** (+2/+4/+6 h), and **Arrive by** mode with automatic weather-delay buffer.
- **Route insights & vehicle profiles** — adapts risk thresholds for **Car, Van, Truck, and Motorbike**: headwind/crosswind warnings, mountain pass alerts (elevation + freezing/fog), steep grades ≥ 6%, EV cold + climb range estimate, CAMS Air Quality badge for walking/cycling, and one-tap *shelter before bad weather* stop search.
- **On-device multi-modal routing** — **Car, Walking, Bicycle** (Web Worker over static road graphs) and **Public transport** (on-device GTFS + RAPTOR for Tbilisi buses/metro and Georgian Railways, with street-following walk legs).
- **Turn-by-turn navigation** — lane guidance, speed limits, speed cameras, sharp-curve & railway-crossing warnings (factored with wet/icy road surface), low-sun glare, push-to-talk voice assistant, and a **1×–300× drive simulator**.
- **Long Trip Mode** — automatic multi-day planning (800+ km / 10+ h) with breaks, truck tachograph rest limits, meals, fuel/EV stops, overnight towns, border crossings, and early-stop suggestions ahead of storms ([spec](docs/features/LONG_TRIP_MODE.md)).
- **Everyday tools** — Home ↔ Work quick card, saved parked-car spot with 12 h weather watch, *Clear weather nearby* weekend ideas, pick origin/destination directly on the map, places along the route, and an offline cache manager.
- **Live sharing & driver reports** — share a live trip link (1–24 h, no account) and report/confirm road hazards anonymously; runs on Cloudflare Workers Free plan and overflows automatically to **WebRTC** + **Nostr** relays.
- **Multilingual & accessible** — **English, Russian, and Georgian (`ქართული`)** with self-hosted Noto Sans Georgian, light/dark/day-night themes, WCAG 2.1 AA automated checks (`e2e/a11y.spec.ts`), and installable PWA.

## Quick start

Requires **Node.js 22+**.

```bash
npm install
npm run data:all     # build static open-data files under public/data (OSM, roads, transit, DEM, weather, AQI)
npm run dev          # app on http://localhost:5173 + local Worker on :8787 (/api proxied)
```

### Common commands

| Command | Description |
| --- | --- |
| `npm run dev` | App (`:5173`) + Worker (`:8787`) + local Nostr relay |
| `npm run dev:phone` | Same over local HTTPS (self-signed cert) for GPS testing on a real phone |
| `npm test` | Unit & scenario tests (Vitest, offline) |
| `npm run typecheck` | Type-check web app, Worker, E2E, and React Native (`mobile/`) |
| `npm run build` | Production build into `dist/` |
| `npm run preview:worker` | Serve production build through local Worker (`http://127.0.0.1:8787`) |
| `npm run e2e` | Playwright browser suite (desktop smoke, mobile viewports, WCAG a11y) |
| `npm run spike:mobile` | React Native Hermes core verification & latency benchmark (`p95 ≤ 20 ms`) |
| `npm run check:envs` | Verify Wrangler environments & zero billable bindings |
| `npm run check:cost` | Verify production bundle & CSP allowlist (zero forbidden hosts) |

<details>
<summary><strong>Testing on a real phone over Wi-Fi / USB</strong></summary>

`localhost` on a phone refers to the phone itself, and browsers require HTTPS for geolocation on LAN IPs:

1. Connect your computer and phone to the **same Wi-Fi** (not a guest network; disable VPN).
2. Run `npm run dev:phone` — it creates a local certificate in `.cert/` and prints `https://<LOCAL_IP>:5173`.
3. Open that URL on your phone and accept the local certificate once (*iOS:* **Show Details → visit this website**; *Android:* **Advanced → Proceed**).
4. **Android over USB (no cert needed):** run `adb reverse tcp:5173 tcp:5173` and open `http://localhost:5173` on the phone.
5. **Remote DevTools:** `chrome://inspect#devices` on Android Chrome; **Develop → your iPhone / Simulator** in macOS Safari.

</details>

## Mobile & React Native

WayTher keeps its core engines (`src/algorithms`, `src/intelligence`, `src/navigation`, `src/roads`, `src/transit`, `src/i18n`, `src/platform`, `src/utils/gzip.ts`) 100% platform-neutral — zero React DOM or browser globals, enforced by `src/test/architecture.test.ts` and `npm run spike:mobile` (verified in Hermes: median `1 ms`, p95 `2 ms`).

- **iOS shell (`ios/`):** native `WKWebView` + `CoreLocation` + `AVSpeechSynthesizer` + haptics + bundled offline `/data`; unsigned `.ipa` built automatically in `.github/workflows/ios-ipa.yml`.
- **React Native (`mobile/`):** Metro, Babel, native platform seam bootstrap (`mobile/src/platform/registerNativePlatform.ts`), and CarPlay / Android Auto / Watch bridges — see [mobile/README.md](mobile/README.md) and [MOBILE_STRATEGY.md](docs/mobile/MOBILE_STRATEGY.md).

## Architecture & $0 cost model

**Free for users forever** (MIT, no ads or subscriptions) and **$0 for the owner at any scale** (Cloudflare Workers Free plan with no payment method):

| Component | Where it runs | Cost |
| --- | --- | --- |
| Web app, styles & static `/data` | Cloudflare Workers Free static assets (unlimited requests) | $0 |
| Vector basemap | Protomaps packs on static Worker `navweather-basemap` (OpenFreeMap fallback) | $0 |
| Routing, transit, search, weather, AQI, heights, Long Trip | **On the user's device** over gzipped static files (`src/roads`, `src/transit`, `src/trip`) | $0 |
| Data pipelines (OSM, GTFS, ECMWF/GFS, CAMS, DEM, basemap) | GitHub Actions (public repo) | $0 |
| Driver-report reads | Static feed rebuilt every ~10 min on static Worker `navweather-reports` | $0 |
| Live sharing & report writes | Worker + SQLite Durable Objects (Free 100k req/day) → **WebRTC + Nostr** overflow | $0 |

## Honest limits & privacy

- **Coverage:** routing, search, transit, places, and elevation work inside built regions (Georgia today; outside built regions the app honestly says *"not available here yet"*). Weather and air quality cover land worldwide.
- **No live commercial traffic API:** `TrafficProvider` stays honestly marked *"not available"* rather than inventing speeds or using quota-limited commercial keys (ADR-019). Driver reports are always labelled *"reported"*.
- **Privacy:** no accounts, no analytics, no server-side location history. Preferences, saved places, and recents stay on your device. Active live sharing keeps only your latest position until stopped or expired.

## Deploy (Cloudflare Workers Free)

```bash
npx wrangler login
npm run check:envs && npm run build && npm run check:cost
npm run deploy:preview      # preview Worker
npm run deploy:production   # production Worker
```

Automated scheduled deploys & data refreshes live in `.github/workflows/` (`deploy.yml`, `reports-feed.yml`, `basemap.yml`, `ci.yml`, `ios-ipa.yml`).

## Documentation

- [Project requirements](docs/PROJECT_REQUIREMENTS.md) · [AGENTS.md](AGENTS.md) · [Development plan](docs/DEVELOPMENT_PLAN.md)
- [Architecture](docs/ARCHITECTURE.md) · [Target architecture](docs/architecture/TARGET_ARCHITECTURE.md) · [ADRs](docs/architecture/decisions/README.md)
- [Weather engine](docs/architecture/WEATHER_ENGINE.md) · [Long Trip Mode](docs/features/LONG_TRIP_MODE.md) · [Mobile strategy](docs/mobile/MOBILE_STRATEGY.md)
- [API v1](docs/api/API_V1.md) · [Environment](docs/ENVIRONMENT.md) · [Testing](docs/TESTING.md) · [Privacy](docs/legal/PRIVACY.md) · [Licensing matrix](docs/legal/LICENSING_MATRIX.md)

## Licence

Code: [MIT](LICENSE). Map data © OpenStreetMap contributors (ODbL); weather & open-data attributions are listed in [docs/legal/LICENSING_MATRIX.md](docs/legal/LICENSING_MATRIX.md).
