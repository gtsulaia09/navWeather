# navWeather

**Know what's ahead before you get there.**

A map and navigation app whose difference is the weather: for every part of
your actual road route it works out **where** you will be, **when** you will
get there, and **what the forecast is for that place at that time** — then
tells you what you will run into, in time to matter.

```
Tbilisi → Batumi · 357 km · 4 h 53 min
LEAVE 08:00  Tbilisi     ☁ 18°
ETA   09:10  Gori        ☁ 19°
ETA   10:05  Khashuri    🌧 17°  65%      "Rain is likely in about 55 minutes, near Khashuri."
ETA   11:40  Samtredia   ☀ 21°
ETA   13:00  Batumi      ☁ 23°
```

It runs on open data (OpenStreetMap, ECMWF/GFS forecasts, CAMS, Copernicus DEM) turned into static files that the
app reads on your device — no API keys, no paid service, no server doing your routing — plus a tiny Cloudflare
Worker for live location sharing and driver reports.

## Quick start

```bash
npm install
npm run data:all     # our data, once (and again to refresh): Georgia's OpenStreetMap extract (~100 MB, Geofabrik,
                     # MD5-checked) → places, search index (197 000 places, streets, addresses) and road files;
                     # ground heights (Copernicus DEM); the forecast for the whole world (ECMWF/GFS) and air quality
                     # (CAMS) from the Open-Meteo open-data archive — all as static files under public/data
npm run dev          # app on http://localhost:5173 + the Worker on :8787 (live sharing, driver reports)
npm test             # unit + scenario tests, no network (routing on real roads once data:all has run)
npm run build        # type-check + production build (app + data in dist/)
npm run preview:worker   # the production build served by the Worker, as on Cloudflare: http://127.0.0.1:8787
```

Everything a user does runs **on their device** over those static files — routing (car, walking, cycling, with
turn-by-turn steps), search, forecasts, air quality, heights and the Long Trip planner — so the app costs nothing to
run at any number of users ([ADR-019](docs/architecture/decisions/ADR-019-zero-owner-cost.md)). The Worker only relays
live sharing and driver reports, on Cloudflare's Free plan. Outside the regions we build, routing and search say
"not available here yet"; no public server with limits is ever called.

`npm run dev:web` starts only the app (sharing and reports then say the server is missing);
`npm run dev:api` starts only the Worker.

Use Node 22+ (required by the Cloudflare tooling; the tests need 20+).
Location only works on `https://` or `localhost` — the page opens from a phone via `http://192.168…`, but the
browser refuses it location (so no navigation); use `npm run dev:phone` (below) for that.

## Run it locally and test on a phone

The project uses **npm** (`package-lock.json`) and **Vite 6**. Ports: the app on **5173** (Vite's default; pass
`-- --port N` to change it), the Worker on **8787** — the phone never needs 8787: Vite forwards `/api` to it.

### A. On your computer

```bash
npm install
```

```bash
npm run dev
```

Open <http://localhost:5173>. `npm run dev` starts the app and the Worker together (Ctrl+C stops both); without
`npm run data:all` having run once, routing and search answer "not available here yet".

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run build
```

```bash
npm run e2e
```

`npm test` is the unit and scenario suite (Vitest, no network). `npm run e2e` drives your installed Google Chrome
against the running `npm run dev`: `e2e/smoke.spec.ts` is the whole flow on a desktop window, `e2e/mobile.spec.ts`
the phone and tablet layouts (320×568 up to 768×1024, portrait and landscape, touch) — run one with
`npx playwright test e2e/mobile.spec.ts`. `npm run preview:worker` serves the production build as deployed
(<http://127.0.0.1:8787>).

### B. On a real phone over Wi-Fi

`localhost` on the phone is **the phone itself**, not your computer — so the phone needs your computer's address on
the local network, and the dev server must listen on that network (`0.0.0.0`), not only on `localhost`.

1. Connect the computer and the phone to **the same Wi-Fi network** (not a guest network: those usually stop
   devices from seeing each other; switch off any VPN on either side).
2. Start the dev server on the network. With HTTPS, so the phone allows location, motion and keeping the screen on:

   ```bash
   npm run dev:phone
   ```

   It makes a self-signed certificate for this computer's addresses (`scripts/dev-cert.mjs`, kept in `.cert/`,
   needs `openssl`), starts Vite with `--host` (all interfaces, `0.0.0.0`) and prints the address to open, e.g.
   `[web] phone (same Wi-Fi): https://192.168.1.23:5173`.

   Plain HTTP also works for looking at layouts — the page loads, but the browser gives it no location:

   ```bash
   npm run dev -- --host 0.0.0.0
   ```

3. Find the computer's local IP address if you need it (`dev:phone` prints it):
   - macOS: `ipconfig getifaddr en0` (Wi-Fi; `en1` on some Macs)
   - Linux: `hostname -I`
   - Windows: `ipconfig` → "IPv4 Address" of the Wi-Fi adapter
4. On the phone, open `https://COMPUTER_LOCAL_IP:5173` (or `http://…` for the plain-HTTP variant). With
   `dev:phone` the phone warns once that the connection is not private (our own certificate): on iPhone tap
   **Show Details → visit this website**, on Android **Advanced → Proceed**.
5. If the phone can't connect:
   - **Firewall.** macOS asks "Do you want the application node to accept incoming network connections?" the first
     time — choose **Allow** (or System Settings → Network → Firewall → Options → allow `node`). Windows: allow
     Node.js on **Private** networks when asked, or add an inbound rule for TCP 5173. Linux with ufw:
     `sudo ufw allow 5173/tcp`.
   - **Wrong address.** The computer may have several (Wi-Fi, Ethernet, VPN, Docker); use the one on the same
     network as the phone (same first three numbers, e.g. `192.168.1.x`).
   - **Check from the computer first**: `curl -k https://COMPUTER_LOCAL_IP:5173` should print HTML.
   - **Router "AP/client isolation"** (common on guest and office Wi-Fi) blocks phone ↔ computer; use another
     network or the USB options below.

Over USB there is a simpler route on Android: Chrome's port forwarding (C below) or
`adb reverse tcp:5173 tcp:5173` makes `http://localhost:5173` on the phone reach your computer — and `localhost`
counts as secure, so location works without a certificate.

### C. Debugging the site on the phone

**Android (Chrome):** on the phone, Settings → About phone → tap *Build number* 7 times → Developer options →
**USB debugging** on; connect by USB and accept the prompt. On the computer open `chrome://inspect#devices` in
Chrome: the phone's tabs appear; **inspect** gives the full DevTools (console, network, elements, performance with
the phone's real CPU). *Port forwarding…* there (5173 → `localhost:5173`) lets the phone open
`http://localhost:5173`. The Android emulator (Android Studio) works the same way, and `http://10.0.2.2:5173`
reaches the computer from it.

**iOS (Safari):** on the iPhone, Settings → Apps → Safari → Advanced → **Web Inspector** on. On the Mac, Safari →
Settings → Advanced → **Show features for web developers**. Connect the iPhone by cable (once; after that it can
work over the same Wi-Fi), open the page in Safari on the phone, then on the Mac: **Develop → *your iPhone* →
the page**. Needs a Mac. With Xcode, the iOS Simulator runs real Mobile Safari and shares the Mac's network, so
`http://localhost:5173` works there directly (`xcrun simctl openurl booted http://localhost:5173`).

### D. Mobile testing checklist

- [ ] **Sizes:** 320×568, 360×640, 375×667, 390×844, 414×896, 430×932, tablets 768×1024 and 1024×768 — and a desktop
      window. Nothing scrolls sideways; nothing hides under the search bar, banner or sheet.
- [ ] **Orientation:** turn the phone while planning and while driving; in landscape the sheet docks at the side
      and scrolls as a whole — **Start** must be reachable.
- [ ] **Safe areas:** iPhone with a notch / Dynamic Island and the home indicator, portrait and landscape: no
      control under them (also as an installed home-screen app).
- [ ] **Touch:** every button hit easily with a thumb (≥ 44 px); the sheet's grabber drags and taps; a card's ✕
      closes it; press-and-hold on the map opens a place; pinch and pan the map; no double-tap zoom on buttons.
- [ ] **Keyboard:** search and the directions fields keep their suggestions visible above the keyboard; in Share
      and Settings the field being typed in and the dialog's buttons stay above the keyboard; dialogs don't open
      the keyboard by themselves.
- [ ] **Browsers:** iPhone Safari (and as a home-screen app), Android Chrome, Samsung Internet, Firefox; desktop
      Chrome, Safari, Firefox.
- [ ] **Slow devices and networks:** DevTools → Performance → CPU 4–6× slowdown and "Slow 4G": the search answers
      while typing, a route appears without the page freezing, the simulated drive stays smooth.
- [ ] **Offline / flaky network:** airplane mode during a drive keeps guidance and the loaded forecast (labelled
      stale).
- [ ] **Location:** allow, deny, and "approximate" on iOS; GPS following while driving (use `dev:phone` or USB).
- [ ] **Accessibility:** large text (iOS Dynamic Type / Android font size) doesn't cut buttons off; reduced motion
      respected; screen reader reads dialogs and the sheet.

## What it does

**Explore (like any map app)** — search a place or press-and-hold (click on
desktop) anywhere on the map. The card shows the weather now, the next 24
hours and 7 days, and — if your location is known — the drive time and the
**weather when you would arrive**, plus air quality. A chip shows the
weather and AQI at the map centre. Directions start from "Your location".
Save places as Home, Work or favourites; share a place as a link; after a
drive, save where you parked (this device only).

**Travel modes** — car, walking, bicycle, public transport, flight, as tabs like
Google Maps. Walking and cycling are routed by OpenStreetMap's community routing
servers, with the same weather at *your* pace (rain matters more on a bike) and
turn-by-turn; the driving extras (speed limits, cameras, curves, driving breaks,
fuel advice) stay for the car. **Flight is a labelled estimate** — the straight
line and a typical time, no airports, schedules or prices — and is a plan only.
**Public transport** comes from [Transitous](https://transitous.org) — a free,
community-run journey planner over the timetables operators publish openly (no
key). Each trip found is an option with its departure and arrival, the lines to
take on their own colours, every step (walk, board, stops, get off) and the
weather at the times you'd be there; another departure time asks the timetable
again. Coverage is what operators publish: Tbilisi's buses and metro are there,
Georgian intercity trains and marshrutkas are not — then the app says "no public
transport found" (and links to Google Maps timetables, opened only if you tap it)
instead of inventing anything. It is a plan only, like a flight.

**Long Trip Mode** — trips of 800 km+, 10 h+ of driving, or that need a night
switch it on by themselves (thresholds in one config file; you can turn it off or
on for any trip). The planner (a stateless Cloudflare Worker endpoint) lays out
breaks, meals, fuel/charging (only from the range you enter), overnight areas in
real towns, days, a timeline and the weather at the times you'll really be there
— stops included — and suggests stopping earlier when heavy weather falls late
in the day. Hotels, fuel, food and rest areas come from OpenStreetMap with the
reason each was picked (availability, prices and ratings are not claimed), plus
border crossings. While driving, it replans when you fall well behind.
Details: [docs/features/LONG_TRIP_MODE.md](docs/features/LONG_TRIP_MODE.md).

**Plan** — up to three genuinely different **roads** to the destination (near-copies
of the best route are dropped; when the router offers none, the app asks it for
routes *through* points off the main road and keeps the believable ones), each with its own forecast: the road numbers it
follows ("via S1 · S12"), a weather ribbon along its whole length, a few stops with
the time you would be there and the expected weather and temperature, and the
exposure in minutes ("Heavy rain 35 min" vs "Mostly dry"; never auto-selected).
Then the weather timeline at each ETA of the road you pick, heads-up
events, "Where will I be at…", places along the route with real detour times,
multi-stop trips, departure time in the start location's time zone, and
**when to leave**: the next 12 hours of departures compared by rain and severe
weather on the way ("Leaving at 06:30: about 54 min less heavy weather").

**Drive** — turn-by-turn (lanes when OSM has them), speed-adaptive voice
prompts, heading-up camera that re-centres itself, and **following the road you
choose**: if you leave the planned road onto another road the app already knows,
it carries on along that road at once (no waiting, works offline, its forecast is
already loaded); if you turn onto a road it doesn't know, it makes new directions
from there and looks up the other roads from that point with their forecasts.
"Other roads" in the pulled-up sheet lists the roads you can still take from
here — time difference, forecast, "Take this road" — and fades as you pass the fork.
Also:
speed limits (OSM, "signs take precedence"), the "Ahead" list and time-based
weather alerts that stay quiet unless it matters, low-sun glare warnings,
time-zone changes, break reminders, sharp curves and railway crossings (with
the forecast road surface), and speed-camera alerts (OSM, **on by default** — use them only where that is legal;
one switch in Settings). Push-to-talk voice questions ("When will the
rain start?", "Find a gas station", "Recalculate route", "Report an
accident"). Arrival shows a trip summary (not stored).

**Driver reports** — while driving, report an accident, a hazard, road works,
a closure or dangerous weather in one tap (or by voice). Other drivers see it
on their route as *reported* (never as fact), and are asked "still there?"
just after passing it; reports expire on their own. Nothing is sent from a
simulated drive; it can be turned off in Settings.

**Share live location** — create a link (1–24 h). The other person sees you
move on the map, where you're heading, your ETA, the weather where you are and
at your destination on arrival. Only your latest position is kept on the
server, and it is deleted when you stop or the link expires.

**Simulate** — a demo drive (1×–300×) exercises everything above without
leaving your desk; in development a diagnostics panel adds jumps, deviation,
simulated weather and incidents (always labelled as simulated).

**Voice** — Google voices only («Google русский», "Google US English", …;
Chrome has them, free). Settings → Voice lists the Google voices for your
language. Russian text is spelled out for the ear («60 километров в час»,
«на улицу Руставели»). Google voices need a connection: offline, or in a
browser without Google voices (Safari, Firefox), the browser's own voice says
the sentence so guidance is never silent.

**Your location** — the start of a trip is your device position; if the device
can't give one (location off or blocked, no GPS on a desktop), the trip starts
from your approximate area (city level, from your connection via the app's own
Worker — no third party) and the app says so; type an exact start any time.

English and Russian; metric/imperial; appearance **like the device** (a dark phone gets
a dark map in the car too), light, dark, or "day and night" (the sun at the car while
driving); a street-level camera while driving; installable PWA.

## What it costs

**For users: nothing, forever** — no ads, subscriptions or paid features (non-commercial project).
**For the owner: only hosting, on Cloudflare** — and every third-party API, data source and program must stay free
forever, at any scale, in development too ([ADR-015](docs/architecture/decisions/ADR-015-free-software-own-hosting.md),
[ADR-016](docs/architecture/decisions/ADR-016-all-on-cloudflare-workers.md)).

**Today's code** still calls the public free services below. They have usage limits or forbid production use, so
they are being replaced by the same free, open-source engines running on our own Cloudflare hosting (Valhalla,
MOTIS and LibreWXR in Containers; places, geocoder, map tiles and weather cells in D1/R2) — see the
[development plan](docs/DEVELOPMENT_PLAN.md) and the [catalogue of free replacements](docs/FREE_STACK_PLAN.md):

| Part | Service today | Its limits (why it is replaced) |
| --- | --- | --- |
| App + live sharing + driver reports | Cloudflare Workers **Free plan** (static assets, 2 SQLite Durable Objects, rate limits) | 100 000 Worker requests/day (static files don't count); plenty for personal use |
| Map tiles | OpenFreeMap | free, no key |
| Routing | OSRM public demo server | non-commercial, at most 1 request/s (the app queues requests), no uptime guarantee |
| Public transport | Transitous | open-source, **non-commercial** projects; link to its sources (shown with every trip); ask them before heavy use |
| Weather, air quality, elevation | Open-Meteo | free for **non-commercial** use (≈10 000 calls/day) |
| Search | Nominatim (1 request/s) and Photon | fair use |
| Places, speed limits, cameras | Overpass (OpenStreetMap) | fair use, often slow |
| Device voices, speech recognition | built into the browser | free |

Hosting is Cloudflare **Workers** (not Pages); development and the test Worker cost nothing (Workers Free) until
the first engine runs in Cloudflare Containers (Workers Paid). Everything also runs on `localhost`.

## Honest limits

- **No live traffic, no official incident feed.** There is no free source;
  the interfaces exist (`TrafficProvider`, `IncidentProvider`) and the app says
  "not available" instead of inventing data. ETAs use typical road speeds.
  Incidents come only from other drivers' reports, labelled unconfirmed; there
  are no moderation tools yet.
- **Avoid tolls/highways** is not offered: the free OSRM server rejects it.
- **Web app limits:** no navigation or sharing with the screen locked or the
  app in the background (browsers pause location); no CarPlay/Android Auto.
- **Offline:** the loaded route, instructions and cached forecasts keep working
  and are labelled stale; new routes, new forecasts and map tiles need a
  connection.
- **Free services are shared** (Overpass is often slow; the OSRM demo server has
  no uptime guarantee). Swap endpoints in `.env` for production.
- **Translation:** Russian is a draft that needs native review.
- Chrome's speech recognition sends audio to the browser vendor; the mic is
  only opened when you press it.
- **Voice:** Google voices need a connection and come with Chrome; elsewhere
  or offline the browser's own voice speaks. An approximate start (location
  unavailable) is only as good as your connection's location — a VPN moves it.

## Privacy

No account. Stored on the device only: preferences, places you save, recent
destinations (can be turned off and cleared in Settings), and — while you share
— the share's own link/key so you can stop it after a reload. Positions and
routes are never stored. Live sharing sends your position only while you share.
A driver report sends only its kind and your position at that moment; the
relay keeps a daily-salted hash instead of your IP address. Google voices are Google's
online voices (the sentence is sent to Google to be spoken). The approximate
start is worked out by the app's own Worker from the connection and is not
stored.

## Deploy (Cloudflare Workers)

```bash
npx wrangler login
npm run deploy:preview      # Worker navweather-preview: its own Durable Objects, D1, R2 (test data)
npm run seed:preview        # our search index into its D1
npm run data:weather -- --env preview   # our forecast into its R2 (or let .github/workflows/weather.yml do it)
npm run deploy:production   # Worker navweather (real users); seed:production, --env production likewise
```

Or from GitHub: the **Deploy** workflow (secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) builds the data,
deploys and, for preview, runs the Worker smoke tests; the **Weather** workflow refreshes the forecast every hour
when new model runs appear. `public/_headers` sets the CSP. Hosting is one Cloudflare **Worker** project per
environment (not Pages) — see [ADR-016](docs/architecture/decisions/ADR-016-all-on-cloudflare-workers.md);
`npm run check:envs` keeps the environments of `wrangler.toml` in step.

## Licence

Code: [MIT](LICENSE). Map data © OpenStreetMap contributors (ODbL); other data and services keep their own
licences — see the [licensing matrix](docs/legal/LICENSING_MATRIX.md).

## Docs

Start with **[Project requirements](docs/PROJECT_REQUIREMENTS.md)** (single
source of truth) and [AGENTS.md](AGENTS.md) (how to work on the project).

- **[Development plan](docs/DEVELOPMENT_PLAN.md)** (in Russian) — the single plan from start to finish: stages, tasks with localhost and Cloudflare Workers checks, release gates, risks, owner decisions ([ADR-015](docs/architecture/decisions/ADR-015-free-software-own-hosting.md), [ADR-016](docs/architecture/decisions/ADR-016-all-on-cloudflare-workers.md))
- **[Free stack catalogue](docs/FREE_STACK_PLAN.md)** (in Russian) — free self-hosted replacements for every service, the Google Maps features we lack and their free sources, where each part runs on Cloudflare
- [Full audit 2026-10-04](docs/AUDIT/2026-10-04-full-audit.md) (in Russian) — branches, localhost status, what was fixed, open findings, Cloudflare Pages vs Workers
- [Defect register](docs/AUDIT/DEFECTS.md) (in Russian) — confirmed defects B-xx and the tasks that fix them
- [Documentation audit and cleanup 2026-10-04](docs/AUDIT/2026-10-04-docs-audit.md) (in Russian) — what was removed, what remains
- [Architecture decisions](docs/architecture/decisions/README.md) · [Target architecture](docs/architecture/TARGET_ARCHITECTURE.md)
- [API v1](docs/api/API_V1.md) · [Data model](docs/database/DATA_MODEL.md) · [Security](docs/security/SECURITY.md) · [Privacy](docs/legal/PRIVACY.md) · [Licensing matrix](docs/legal/LICENSING_MATRIX.md)
- [Weather engine](docs/architecture/WEATHER_ENGINE.md) · [Maps, routing, GIS](docs/architecture/MAPS_ROUTING_GEO.md) · [Mobile strategy](docs/mobile/MOBILE_STRATEGY.md) · [Cost & scale](docs/operations/COST_AND_SCALE.md) · [Delivery](docs/operations/DELIVERY.md)
- [Architecture](docs/ARCHITECTURE.md) — engines, data flow, providers, state, relay
- [Environment](docs/ENVIRONMENT.md) — every variable and binding
- [Testing](docs/TESTING.md) — what is covered, dev tools, what isn't tested
