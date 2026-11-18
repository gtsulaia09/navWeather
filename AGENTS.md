# Working on navWeather (for AI assistants and new engineers)

navWeather is a **navigation + route + time + weather + prediction + alerts**
platform: for every part of the actual route it works out where you will be,
when, and the forecast there at that time, and warns before significant
weather. It is not "a map site" or "a weather site" — keep that direction.

## Session start protocol (every session, before significant work)
1. **Read** [docs/PROJECT_REQUIREMENTS.md](docs/PROJECT_REQUIREMENTS.md) — the
   single source of truth for what the system *should* be.
2. Read the relevant [ADRs](docs/architecture/decisions/README.md) and
   architecture docs ([current](docs/ARCHITECTURE.md), [target](docs/architecture/TARGET_ARCHITECTURE.md)).
3. Inspect the implementation and its tests — the code is the truth for what
   the system *currently is*.
4. Write down CURRENT STATE → TARGET STATE → GAP for the task, and a short plan.
5. Check the change against: requirements, Cloudflare-first (ADR-001),
   API compatibility (ADR-009), future iOS/Android/CarPlay/Android Auto,
   privacy, security, licensing (docs/legal), performance, cost, scalability.
   If any answer is "no" or unclear, stop and resolve it before coding.

## Change control
- New/changed requirement → update PROJECT_REQUIREMENTS **first**; an ADR if
  architecturally significant (new provider, table, endpoint, Cloudflare
  service, auth method, caching layer); then code, tests, docs.
- Never silently change architecture. If this file, the requirements and a
  request conflict: name the conflict, find which is newer, update the docs,
  then continue.
- Update requirement **status** columns in the same commit as the code.
- End of task: requirements still accurate? ADR needed? API/DB/env/licence
  docs updated? tests present? debt recorded?

## Rules that must not be broken
- **Nothing is paid — not even hosting; free for users (ADR-019, owner, 2026-11-18; ADR-015):** the owner pays for
  nothing at any number of users. Cloudflare Workers **Free plan with no payment method** (it cannot bill: past its
  daily limits it returns errors). Everything a user does is a **static file under `/data`** plus code **on the
  device**: routing (`src/roads`), search, forecasts, air quality, heights, places, the Long Trip planner. Only live
  sharing and driver reports use the Worker (Durable Objects, Free plan; they say "busy" when the day's free requests
  are used up). Never add Workers Paid, Containers, R2, D1, Queues, a paid domain, a paid API, a key with a quota, a
  free tier with a request limit, a public demo server, ads, subscriptions, sponsors or credits — not even "for now"
  or "in development". A new feature that needs the server for each user is redesigned as static data + device code,
  or not built. Data are built on GitHub Actions (public repo: free). Every third-party component is free software or
  open data with its licence recorded. Target scale: Google-Maps-class.
- **Hosting = Cloudflare Workers, not Pages (ADR-016, ADR-019):** static assets (app + data) and `/api/*` (sharing,
  reports) in one Worker project; `wrangler.toml` environments `dev` / `preview` / `production`; `npm run check:envs`
  fails on any billable binding.
- **Localhost parity (REQ-DEV-001):** every feature must work on `http://localhost` with no Cloudflare account and
  no money (Vite serves `public/data`; `wrangler dev` runs sharing and reports locally) **and** on the preview Worker.
  A change verified in only one of the two is not done.
- **Fast for users:** data files are small, gzip-compressed, immutable per build folder and cached on the device
  (HTTP cache + service worker); heavy work runs in a Web Worker (routing) so the screen never freezes.
- Only real data: no source → "not available"; simulations labelled; driver
  reports are "reported", never fact. Weather wording: forecast vs derived
  estimate vs official warning (docs/architecture/WEATHER_ENGINE.md §6).
- No location history on the server; route history (if ever) is opt-in.
- No secrets in the client: `VITE_*` values are public.
- The app calls no public service with limits (no OSRM/FOSSGIS/Photon/Nominatim/Overpass/Open-Meteo API/Transitous):
  the only third-party host it reaches is OpenFreeMap (map background, no limits). Attribution everywhere.
- Navigation and safety-critical calculations stay deterministic; AI may
  only explain or translate requests into deterministic calls.
- Engines (`src/algorithms`, `src/intelligence`, `src/navigation`, `src/types`)
  must not import React or the DOM — they are the future mobile core.

## Commands
```
npm run dev          # app on :5173 + Worker on :8787 (sharing, reports); the dev server proxies /api
npm run dev:web      # only the app        npm run dev:api   # only the Worker (live share, reports)
npm run preview:worker   # production build served by the Worker on :8787 (as deployed)
npm test             # vitest (unit + scenarios; src/roads/realData.test.ts runs once road files exist)
npm run typecheck    # app + Worker + e2e
npm run build        # production build (copies public/data into dist/)
npm run data:all     # all our static data: OSM → places, search, roads; heights; forecast; air quality
npm run data:roads   # just the road files the device routes on (after data:download)
npm run check:envs   # wrangler environments in step, no billable bindings
npm run test:share   # Worker smoke (needs the Worker on :8787); API=/api for legacy paths
npm run test:reports
```

## Git workflow (owner's instruction, 2026-10-02)
Work on branch **`claude/navweather-dev`**; commit every finished change there
and push it. Commit messages: what and why; reference requirement IDs.

## Map of the docs (only current documents; history lives in git)
- Requirements: `docs/PROJECT_REQUIREMENTS.md`
- **Cost rule now: ADR-019** (`docs/architecture/decisions/ADR-019-zero-owner-cost.md`) — where it conflicts with older
  plans (paid hosting, Containers, R2, D1), ADR-019 wins
- **The single work plan: `docs/DEVELOPMENT_PLAN.md`** (stages 0–13, tasks DP-x.y with localhost and Workers checks,
  release gates G1–G13, risks, owner decisions) — ADR-015, ADR-016
- Catalogue of free replacements, Google Maps gaps and Cloudflare placement: `docs/FREE_STACK_PLAN.md` (§1.1 "always
  free" rule, §6a Cloudflare)
- Defect register `B-xx`: `docs/AUDIT/DEFECTS.md` · full audit (branches, localhost, fixes, open findings, Pages vs Workers):
  `docs/AUDIT/2026-10-04-full-audit.md` · documentation audit and cleanup: `docs/AUDIT/2026-10-04-docs-audit.md`
- Decisions: `docs/architecture/decisions/` · Target architecture, weather engine, maps/routing/GIS: `docs/architecture/`
- Current implementation: `docs/ARCHITECTURE.md` · Environment: `docs/ENVIRONMENT.md` · Testing: `docs/TESTING.md`
- API: `docs/api/API_V1.md` · Data: `docs/database/DATA_MODEL.md`, `database/migrations/`
- Security: `docs/security/SECURITY.md` · Privacy, licensing: `docs/legal/`
- Mobile/CarPlay/Android Auto: `docs/mobile/` · UX/SEO/analytics/i18n: `docs/product/`
- Cost & scale ($0 at any scale), CI/CD, DR: `docs/operations/`
- Feature specs (source of truth per feature): `docs/features/` (Long Trip Mode)
- Language: ADRs and technical specs in English; plans, audits and the catalogue in Russian.
