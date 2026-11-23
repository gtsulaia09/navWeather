# ADR-020 — Everything works at any scale for $0: own basemap files, a static reports feed, overflow to the users' devices

**Status:** Accepted · **Date:** 2026-11-21 · **Decision by:** owner ("remove these limits: everything must work for
users and stay free for me; at most a domain, $12 a year")
**Amends:** [ADR-019](ADR-019-zero-owner-cost.md) (what may use the Worker; which third parties the app may reach) and
the "no public server with limits" rule of [ADR-015](ADR-015-free-software-own-hosting.md) for one narrow case
(signalling and overflow over public Nostr relays, below). Revises [ADR-006](ADR-006-map-stack.md) (map tiles).

## Context
A simulation of 60 million people online at once (2026-11-21, `main` = c68b928) showed four limits of ADR-019. None of
them costs money (the account has no payment method), but each one stops a feature:

1. The Free plan's 100,000 Worker requests a day last 0.2 s at that load: 482,000 requests a second, 75 % of them live
   location updates (one PUT every 5 s per sharer) and 25 % driver-report reads (every navigating phone every 5 min).
2. All driver reports go through one Durable Object (`idFromName('global')`), which handles about 1,000 requests a second.
3. The map background comes from OpenFreeMap: about 2.5 million tiles a second (≈ 600 Gbit/s) — far beyond a
   donation-funded service.
4. ≈ 870 Gbit/s of static traffic on one free Cloudflare account; Cloudflare may limit an account at that size.

The only resources that grow with the number of users at no cost to the owner are **the users' own devices** and
**Cloudflare static assets** (free and unlimited by tariff). The design moves everything else onto those two.

## Decision

| Limit | Change | Owner cost |
| --- | --- | --- |
| Report reads (25 % of requests) | A **static reports feed**: one small JSON file per 1°×1° cell plus an index, rebuilt every ~10 minutes by GitHub Actions and deployed as static assets of a second Worker (`navweather-reports`, assets only). Phones read files, never the Worker. The Worker list endpoint stays as the fallback when no feed is configured (localhost) or the feed is unreachable. | $0 |
| Report writes and votes | First the Worker (as now). When it answers "busy" (Free-plan limit) or is unreachable, the phone publishes the report as a **signed Nostr event with proof of work** (NIP-13, 16 bits) to several public relays. The feed builder merges both sources with the same rules (de-duplication within 150 m, votes, per-reporter caps). | $0 |
| One reports object | Kept on purpose: with reads moved to static files the Worker sees at most 100,000 requests a day (≈ 1 a second), far below one object's capacity. Sharding would add nothing on the Free plan. | $0 |
| Live location (75 % of requests) | First the Worker relay (as now). When it is busy or unreachable — at share start or mid-share — sharer and viewers connect **directly with WebRTC data channels**; the handshake (one offer, one answer) goes through **public Nostr relays** as ephemeral, end-to-end encrypted events. Positions then flow phone to phone. If a direct connection fails (strict NAT, no TURN server), the sharer also publishes the encrypted position to the relays every 15 s while such a viewer asks for it. | $0 |
| Map background | **Our own vector tiles as static files**: the Protomaps basemap (OpenStreetMap, ODbL) extracted from the free daily planet build (open data file, class B) for the world at zoom 0–6 and for every region we build at zoom 7–14, packed into small immutable files (85 tiles each, no HTTP range requests needed) and served as static assets of a third Worker (`navweather-basemap`). Fonts and sprites are static files too. OpenFreeMap remains only as the fallback while no basemap is deployed. | $0 |
| Static traffic | Less of it: map packs and data files are immutable and cached on the device (HTTP cache, service worker on localhost / same origin); the basemap and the reports feed live on their own Workers so each deploy uploads only what changed. Residual risk stated below. | $0 |
| Domain | Not needed. A custom domain (Cloudflare Registrar, at cost, ≈ $10–12 a year) is optional. | ≤ $12/year |

### Nostr relays: why this is allowed and how it is fenced
ADR-015 forbids public servers with limits. Nostr is different from a demo server: hundreds of independent relays run
by different people, an open protocol (no account, no key with a quota, no paid tier the app depends on), and the app
uses it **only for overflow** — after our own free Worker says busy — and only for small, encrypted messages:

- Live sharing: relays see random one-time public keys, a room tag (SHA-256 of the share id; the id itself never
  leaves the link) and ciphertext (AES-GCM, key derived from the share id). Events are ephemeral (kinds 20000–29999):
  relays forward them and do not store them.
- Driver reports: reports are public anyway (anyone driving by sees them). Events carry kind, rounded position, an
  expiry tag (NIP-40) and proof of work; each phone signs with a random key that it rotates daily.
- Every message goes to 3 relays picked from a configurable list by a hash of the room or cell, so the load spreads
  over the whole list and one relay going down changes nothing. `VITE_NOSTR_RELAYS` sets the list; localhost runs its
  own tiny relay (`scripts/nostr-relay.mjs`), so development needs no internet and no third party.
- STUN for WebRTC: `stun.cloudflare.com` (free and unlimited, Cloudflare Realtime docs) and `stun.l.google.com`.
  No TURN: Cloudflare's TURN bills past 1,000 GB a month, so it is not used.

## Consequences
- At small scale nothing changes for users: the Worker relay and the Worker reports list keep working as before.
- At large scale everything keeps working: reads are static files; live sharing is phone to phone; reports written
  past the Worker's daily limit arrive through relays and appear in the feed within ~10 minutes.
- Reports from other drivers can be up to ~10 minutes old (feed cadence; GitHub cron may run late). A report made on
  this phone shows at once on this phone.
- Honest limits that remain — none of them is a bill:
  - Public relays carry no guarantee. With 3 relays per message out of a list of ~10 the chance that all three are
    down at once is small; the list is configuration, not code.
  - A small share of direct connections fails behind strict NATs; those viewers get positions every 15 s through
    relays instead of every 5 s.
  - Cloudflare can still decide to limit a free account that serves hundreds of Gbit/s. No free provider promises
    that bandwidth in a contract; the design minimises bytes per user and keeps every file cacheable.
  - GitHub disables scheduled workflows in a repository with no activity for 60 days; any commit re-enables them.
- New third-party components (licences in LICENSING_MATRIX): `@noble/curves`, `@noble/hashes` (MIT, Nostr signatures),
  `pmtiles` (BSD-3, build only), `@protomaps/basemaps` (BSD-3, style generation at build), Protomaps basemap tiles
  (ODbL, © OpenStreetMap contributors), Noto fonts (OFL) and Protomaps sprites (CC0) from `protomaps/basemaps-assets`.

## Alternatives rejected
- **Workers Paid / sharding the reports object / R2 for tiles:** each bills past a limit (≈ $1.37 million a month at
  60 million people online, simulation of 2026-11-21).
- **Cloudflare TURN:** 1,000 GB a month free, then $0.05/GB.
- **Firebase, Supabase, Ably free tiers:** 100–200 simultaneous connections.
- **GitHub Pages / Netlify / Vercel for static files:** about 100 GB a month each.
- **jsDelivr for data:** its terms forbid hosting files in large quantities (fine for code, not for maps and forecasts).
- **Only Nostr for live positions (no WebRTC):** every position of every sharer would pass through public relays —
  ~100× more relay load than handshakes only.
- **Planetiler for the basemap:** builds one region well, but its low zooms then show empty neighbours; the Protomaps
  daily planet build gives a seamless world at low zoom from one open file.
