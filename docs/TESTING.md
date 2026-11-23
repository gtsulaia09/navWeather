# Testing

## Commands

```bash
npm test              # unit + store-level scenarios (deterministic fake providers, no network; 91 files, 898 tests)
npm run typecheck     # app + worker + e2e + mobile spike
npm run check:envs    # wrangler environments in step, zero billable bindings (ADR-019/020)
npm run check:cost    # production bundle, CSP connect-src and .env.* guard (zero forbidden hosts, zero TURN)
npm run spike:mobile  # ADR-010 Hermes core bundle + zero-DOM VM latency benchmark (median 1 ms / p95 2 ms)
npm run test:live     # opt-in smoke test against real endpoints (Tbilisi → Batumi)
npm run dev           # app + local Worker + local Nostr relay, then in another terminal:
npm run test:share    # end-to-end checks of the live-sharing relay (run with API=/api too)
npm run test:reports  # end-to-end checks of the driver-reports relay (run with API=/api too)
npm run e2e           # Playwright in Chrome: smoke.spec.ts + mobile.spec.ts (both enforce AGENTS.md host allowlist)
```

**Mobile browser test** (`e2e/mobile.spec.ts`, 2026-11 mobile audit): the same Chrome, emulating phones and a tablet
(viewport, touch, device pixel ratio) at 320×568, 375×667, 390×844, 768×1024 and 844×390 (landscape). It fails on
sideways overflow, a sheet whose content hangs out of it, header controls covered by the sheet's grab handle (a
card's ✕ tapped near its top edge must close it), the landscape plan panel not scrolling to **Start**, the share
dialog focusing its text field on a touch screen, the share dialog's chips shrinking after Settings was opened
(a global `.chip` clash), and a finger slide along the departure chart not showing or picking a time (skipped, with a
note, on a day whose forecast gives no chart). iPhone geometry from the iOS Simulator is replayed with DevTools'
safe-area override: Safari landscape 874×292 with the Dynamic Island's 62 px (map buttons present and clear of the
turn banner), the home-screen app in portrait (status bar 62 px, home indicator 34 px), and no app-text selection or
hard focus ring in Safari portrait 402×714. Run alone: `npx playwright test e2e/mobile.spec.ts`. Emulation is not a device: see
"Mobile devices" below for what was checked on a real browser engine.

**Shared-core boundary** (`src/test/architecture.test.ts`, part of `npm test`): every file of the future mobile core
(`algorithms`, `intelligence`, `navigation`, `types`, `trip`, `utils`, `i18n`, `roads` except its Web Worker
adapter, `share/protocol.ts`, `reports/protocol.ts`) is checked for imports of React, the map library, zustand or the
UI folders, and for browser globals (`window`, `document`, `localStorage`, `navigator`, …).

**Browser test** (`e2e/smoke.spec.ts`, Playwright, DP-2.6): drives the installed Google Chrome headless (`channel:
'chrome'` — nothing to download). `BASE_URL` picks the target: `http://localhost:5173` (`npm run dev`, the default),
`http://127.0.0.1:8787` (`npm run build` + `npm run preview:worker` via `scripts/preview-worker.mjs` — what CI uses),
or the preview Worker (never production: the test shares and reports). Covers pressing "my location" with mocked
geolocation (verifying active `aria-pressed="true"` and visible blue `.me-dot` dimensions/fill), denied geolocation
notice, typing `Tbilisi` → `Batumi` (verifying `"Batumi, Georgia"` ranks #1, submit works with suggestions open, route
line layers render above basemap fills via `data-route-visible="1"`, distance/duration/ETA and real arrival-time
temperatures appear), simulated drive, live sharing and driver reports. `E2E_STRICT=1` — with our data, forecast and
router running — also fails on any request to the public services with usage limits (OSRM, FOSSGIS, Photon, Nominatim,
Overpass, the Open-Meteo forecast API). Both `http://localhost:5173` and `http://127.0.0.1:8787` (`preview:worker`)
pass 15/15 strict E2E tests (`smoke.spec.ts` + `mobile.spec.ts`). The basemap is skipped (`E2E_MAP=1` keeps it): in
headless Chrome every map frame waits on a GPU process without a display and the page stalls for a minute. The CI job
`e2e` builds Georgia's data, a Caucasus forecast and runs it strictly.

## What is covered

| Area | Where | Highlights |
| --- | --- | --- |
| Route timing, ETA | `algorithms/routeTiming.test.ts` | annotations → steps → proportional fallback; "where will I be at…" |
| Sampling | `algorithms/routeSampling.test.ts` | ≤45 min guarantee, settlements, turns, density by length |
| Weather matching | `algorithms/weatherMatching.test.ts` | interval vs instant values, no extrapolation, time zones |
| Grouping / summary / timeline | `weatherGrouping`, `timeline`, `WeatherStrip` tests | localized text, highlights |
| Deviation, progress, arrival | `routeDeviation`, `routeProgress` tests | hysteresis, opposite carriageway, out-and-back routes |
| Weather alerts | `intelligence/weatherAlerts.test.ts` | latching, stable ids, confidence, severity caps |
| Driver alerts | `intelligence/driverAlerts.test.ts` | windows by severity, cooldown, grouping, recurrence, hourly cap, escalation |
| Route intelligence | `routeIntelligence.test.ts`, `incidents.test.ts` | fuel/EV advice, break reminders, incidents (verified vs reported, expiry) |
| Voice | `voice/queue.test.ts`, `voice/parser.test.ts` | priorities, interruption, expiry; en/ru commands |
| Navigation | `navigation/navigation.test.ts` | maneuvers, lanes, speed-adaptive prompts, localized instructions |
| Location | `services/location.test.ts` | error classification, shared watcher, GPS→Wi-Fi fallback, one-shot fix |
| Explore | `state/explore.test.ts` | place card weather + drive time, dropped pins, directions from "Your location", blocked location |
| Sharing | `share/*.test.ts`, `scripts/share-smoke.mjs` | validation, merge (route once, latest position only), cadence, relay auth/limits/ordering/stop |
| Saved places, parking | `state/savedPlaces.test.ts` | slots, dedupe, recents opt-out, one parking spot |
| Best time to leave | `algorithms/departurePlanner.test.ts` | exposure per departure, nearest clearly-better suggestion, forecast horizon |
| Sun, clocks, cameras | `routeIntelligence.test.ts`, `algorithms/cameras.test.ts` | sun azimuth, glare only into a low sun under clear sky, time-zone change wording, cameras snapped and announced once |
| Names and grammar | `i18n/script.test.ts` | Georgian OSM names → Latin/Cyrillic (streets, road numbers) |
| Store end-to-end | `state/store.test.ts`, `state/scenarios.test.ts` | Tbilisi → Batumi: plan, weather, refresh, simulate, alerts, deviation + recalculation, network loss, arrival summary, assistant |
| Several roads | `algorithms/routeAlternatives.test.ts`, `services/routing/OSRMProvider.test.ts`, `state/store.test.ts › a forecast along every road`, `components/Plan/RouteOptions.test.tsx` | near-copies of a road dropped, order and cap; `alternatives=3` and the fallback; each road has its own ribbon/stops/arrival (rain only on the northern road); naming ("Fastest", "Alternative 1…"), card per road |
| Choosing a road while driving | `state/roads.test.ts`, `components/Drive/OtherRoads.test.tsx` | taking a known road switches at once (no routing request, offline too, forecast kept, names added later, same road object); crossing a road or a stopped car doesn't; unknown road → new directions, then other roads from there (a failing router is harmless); other roads listed until the fork is passed; "Take this road", simulation, "show another route" |
| More roads (via probing) | `algorithms/routeAlternatives.test.ts`, `services/routing/OSRMProvider.test.ts`, `services/routePlanner.test.ts`, `utils/distance.test.ts` | probe points on both sides at 6–40 km, out-and-back spurs and absurdly slow roads rejected, legs merged so a via point is no stop and no instruction, probing only when the router offers too few / no stops / provider can, a deadline that holds even if the router ignores abort, cancel |
| Travel modes | `services/routing/FlightEstimateProvider.test.ts`, `services/routing/TransitousProvider.test.ts`, `state/travelModes.test.ts`, `components/Plan/TravelModeBar.test.tsx`, `state/driveSession.test.ts` | each mode uses its own router; walking timed ~9× with the weather at those times; flight is the straight line (~45 min Tbilisi–Batumi), plan only; transit: a real Transitous answer (Tbilisi buses) decoded into routes timed to the timetable, planned from the chosen departure, every departure an option, a new time re-plans, "no public transport found" leaves no trip of another mode, switched off says so, plan only; mode locked while navigating; car-only extras (limits, cameras, crossings, curves, breaks) absent for a walk; saved session keeps the mode |
| Settings, theme, zoom | `components/Settings/SettingsDialog.test.tsx`, `hooks/useEffectiveTheme.test.ts`, `state/settings.test.ts`, `navigation/navigation.test.ts` | sections, segmented controls, camera switch on by default (and an old stored "off" that was only the old default), "same as device" even while driving, close auto-zoom |
| PWA | `test/serviceWorker.test.ts` | shell only; provider, tile and `/api` traffic never cached |
| Long Trip Mode | `trip/trip.test.ts`, `state/trip.test.tsx`, `utils/polyline.test.ts` | classification bands and thresholds; schedule (breaks, meal windows, overnights, latest arrival, multi-day, merging); fuel/EV only from declared range; overnight areas (towns with hotels, no extra night, user choice); opening hours subset; place ranking (closed removed, unknown labelled, stars, distance); Overpass failure/budget; stop-aware weather risks and "stop earlier"; replanning; validation; borders; in the app: auto/override, ETAs include stops, events replace reminders, plan screen, departure change, planner failure, delay replanning, "Stay in X instead" |
| API versioning | `api/v1.test.ts`, smoke scripts with `API=/api/v1` (default) and `API=/api` | `/api/v1/…` and the legacy `/api/…` reach the same routes; other versions refused; client calls versioned paths |
| Public routers' rate limit | `services/routing/OSRMProvider.test.ts` | requests to one server ≥ the interval apart and never concurrent, shared across walking/cycling on one host; a self-hosted router (0) is not slowed |
| Driver reports | `services/traffic/ReportsIncidentProvider.test.ts`, `state/reports.test.ts`, `reports/protocol.test.ts`, `scripts/reports-smoke.mjs` | route boxes (count/area caps, full coverage), clock skew, partial outages, failure wording; real drives only, offline, "still there?" once and never for your own or in a simulation, 5-minute refresh, off switch; relay rules |
| Drive extras | `state/driveExtras.test.ts` | cameras without limit warnings, loading when switched on mid-drive, never the old route's cameras after a re-route |
| Settings, saved places | `state/settings.test.ts`, `state/savedPlaces.test.ts` | stored values validated; toggling a favourite removes that place only |
| Messages | `i18n/messages.test.ts`, `voice/parser.test.ts` | Russian agreement, report kinds named in every language; voice "report …" commands vs. questions |
| Voice | `voice/voices.test.ts`, `voice/providers.test.ts`, `voice/speakable.test.ts`, `services/places/OverpassPlacesProvider.test.ts` | only Google voices listed and used (the chosen one per language), the browser's own voice when there is none or offline, a failed Google voice repeated on the device; Russian text spelled out (units, temperatures, street types by case, road numbers); town names in Cyrillic in the Russian UI |
| Location | `services/location.test.ts` | watcher: shared, precise→coarse on timeout, coarse→GPS once on "unavailable"; one-shot: GPS retry on timeout/unavailable; trip start falls back to the approximate area (denied, unavailable, insecure page), remembers a failure for a minute, device reason when nothing works, malformed answers ignored |

The critical path from the brief (plan → sample → ETA → weather → events →
alerts → simulate → deviate → recalculate → stale data gone) is
`state/scenarios.test.ts › critical path: deviation mid-drive`.

## Development tools

In `npm run dev`, a "dev" tab (or Ctrl/⌘+Shift+D) opens diagnostics: route,
weather requests and cache hits, upcoming events, alert state, voice log,
providers, location watcher, live-share status. During a simulated drive it
adds +10 km, +30 min, next event, deviate, "heavy rain ahead" and "accident
report". Injected data is flagged and the UI labels it as simulated. None of
this is in production builds.

## Screenshot and accessibility audit

Every state (explore, search, place card, directions, route, expanded route,
settings, driving, expanded driving, report dialog, "still there?", share
dialog, arrival) is captured at 320, 375, 390, 430, 768, 1024, 1280, 1440 and
1920 px wide, light and dark, English and Russian, with headless
Chrome driving the dev build (emulated GPS; provider responses replayed from
the test fixtures when the network is closed). Each capture is also checked
for page-level horizontal overflow, controls off screen, tiny touch targets
and unlabelled buttons. axe-core runs on 10 states in both themes (0 violations after fixes, 2026-10-02);
automation of this check is DEVELOPMENT_PLAN DP-11.4.

## Mobile devices (2026-11-18)

- **Emulated in desktop Chrome** (scripts in the audit, now `e2e/mobile.spec.ts`): 320×568, 360×640, 360×800,
  375×667, 375×812, 390×844, 393×852, 414×896, 430×932, 768×1024, 820×1180, 1024×768, landscape 568×320, 640×360,
  844×390, 932×430, desktop 1280×800, 1440×900, 1920×1080 — explore, suggestions, place card, route, expanded
  route, settings, simulated drive, share dialog, live viewer (171 states): checked for page overflow, controls
  off screen or covered by another element, sheets cut off, small touch targets, inputs under 16 px (iOS zoom).
- **Low-end & mid-range profiles (2026-11-23 before/after, production build, Chrome 360×800, Slow 4G 1.6 Mbit/s / 150 ms, 12-min simulated drive at 60×):**
  - Bundle size: app entry JS **720.3 kB (240.3 kB gz) → 379.2 kB (130.5 kB gz)** (+ immutable `react` vendor chunk 223.1 kB / 69.4 kB gz); entry CSS **53.4 kB (11.1 kB gz) → 32.5 kB (7.5 kB gz)**.
  - **4× CPU slowdown:** search ready **1,836 ms → 1,607 ms**, FCP/LCP **1,588 ms**, route **7,975 ms → 6,777 ms**, route long tasks **1,014 ms → 662 ms** (8 → 6), drive long tasks **728 ms → 596 ms** (7 → 5), max interaction event (INP) **216 ms → 184 ms** (within ≤ 200 ms budget), heap after exit **57.2 MB → 26.6 MB** (pre-drive 28.6 MB).
  - **6× CPU slowdown:** FCP/LCP **1,944 ms → 1,756 ms**, search ready **1,984 ms → 1,800 ms**, pause latency **473 ms → 397 ms**, max interaction event (INP) **304 ms → 248 ms**, drive long tasks **968 ms → 855 ms** (8 → 6).
- **Real Android Chrome 134** (Android Studio emulator `Medium_Phone_API_36.1`, 411×813 CSS px, DPR 2.625): verified 2026-11-18 (keyboard visual viewport, dialogs, top-edge ✕ tap) and re-verified 2026-11-23 on the production build (own Protomaps static basemap rendered, zero horizontal overflow, Web Worker routing triggered).
- **Real iOS Simulator Safari (iOS 27.2, iPhone 18 Pro, 402×714 CSS px, DPR 3):** verified 2026-11-19 (B-37…B-41) and re-verified 2026-11-23 on the production build (`preview:worker` with own Protomaps static basemap) — full Tbilisi → Batumi route + 8 s simulated drive at 60× ran at **251 frames (~31 fps), 0 freezes (B-42 fixed), 166 ms pause response, 0 horizontal overflow**; start screen and category chips / place card re-verified after B-43 and Part 2 visual polish.
- **Desktop Safari (`safaridriver`):** Safari 26.6.2 requires the user to enable "Allow remote automation" in Safari Settings (not altered automatically; WebKit rendering verified via iOS 27.2 Simulator Safari).
- **Real Meta Hermes bytecode compiler (`hermesc` 250829098.0.19, HBC v98, 2026-11-23):** shared TS core (`mobile/src/hermes-core-entry.ts`, 146.6 kB ES2019 `platform: 'neutral'`, 0 browser polyfills, `fflate` gzip) compiled to 151 kB `.hbc` with 0 errors and ran 50 full `derive` iterations in a zero-DOM ES2020 sandbox at **median 1 ms / p95 2 ms**.
- **Not run on:** physical iPhone / Android handsets, Samsung Internet, Firefox for Android, live CarPlay external display / Android Auto DHU (CocoaPods, Android NDK, and SDK Manager `extras/google/auto` not installed on this host).

## Manual / browser checks performed

- Desktop (Chrome in the app's browser pane) and a 390×844 touch phone profile
  (headless Chrome with emulated GPS): locate, press-and-hold pin, place card,
  directions from "Your location", share place, live share between two tabs
  (simulated drive and real GPS), stop sharing, arrival summary.
- Production build served by Cloudflare's runtime (`wrangler dev`): headers,
  SPA fallback, service worker offline reload.

Live check 2026-10-03 (code audit; defects in [AUDIT/DEFECTS.md](AUDIT/DEFECTS.md)): dev build against the real public providers —
Tbilisi → Batumi (OSRM `alternatives=3` + via probes answered; one alternative road), Tbilisi → Istanbul and
Tbilisi → Berlin Long Trip plans through the local Worker, and a 60× simulated drive that spoke a heavy-rain
alert ~35 min ahead. Both public Overpass instances failed one request each during that run.

## "Your location" in the browser

Dev build with mocked providers and a controllable `navigator.geolocation`:
Directions → "Your location" → destination → Go, when location works (route
from the position), is unavailable or blocked (route from the approximate
area, notice names the city; English and Russian), and when the approximate
area is unavailable too (short message, and Go says the start is missing).

## Not tested (be explicit)

- The OSM community walking/cycling servers (`routing.openstreetmap.de`): reachability from a browser (CORS),
  speed and answers for long or remote trips; and how many extra roads via-point probing really finds on the
  live car server. The sandbox this was built in could not reach any of them, so they are tested against fakes.
- Flight is an estimate, not data: no airports, schedules or prices.
- Public transport is only as complete as the timetables operators publish to Transitous (checked live on
  2 Oct 2026: Tbilisi buses answer, Tbilisi → Batumi finds nothing). Live delays appear only where an operator
  publishes them. The adapter is tested against a recorded answer, not the live server.
- The live OSRM demo server's answer to `alternatives=3` for real trips (the sandbox this was
  built in could not reach it): how many distinct roads it finds for a given trip, and its
  latency with alternatives, are unverified — the code is tested against fixtures and fakes.
- Real GPS behaviour at a fork (heading noise at low speed, parallel roads): the matching rules
  (30–60 m, heading within 60°, no heading → plan a new route) are unit-tested, not road-tested.
- Real iOS Safari and Android Chrome devices (only emulation).
- Microphone speech recognition end to end (browser speech APIs need a user
  device; the parser and assistant are unit-tested).
- A deployed Cloudflare account (the Worker was verified locally only).
- Driver reports with many real users (moderation, abuse patterns at scale).
- Long real drives with a phone in a car.
