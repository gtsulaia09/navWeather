# ADR-010 — Mobile stack: React Native (Hermes) + native car/wrist modules (core spike passed)

**Status:** Partially verified (Hermes core spike passed 2026-11-23; native shell / car simulator criteria pending toolchain) · **Date:** 2026-10-02 · **Updated:** 2026-11-23

## Context
iOS and Android native apps do not exist yet. They are needed for what the web cannot do: background navigation with
the screen locked, Apple CarPlay, Android Auto, native offline packs, and wearable companions (Apple Watch, Wear OS).
The product's value lives in our deterministic, framework-free TypeScript core (`src/algorithms`, `src/intelligence`,
`src/navigation`, `src/types`, `src/trip`, `src/utils`, `src/i18n`, `src/roads`, `src/platform/surfaces.ts`). Car
surfaces are native by definition: CarPlay uses Apple's CarPlay framework templates (`CPMapTemplate`, entitlement
required); Android Auto uses Android's Car App Library (`androidx.car.app.category.NAVIGATION`, `NavigationTemplate`,
`NavigationManager`).

## Options
1. **Native Swift + Kotlin**, engines ported twice (or shared via Kotlin Multiplatform, ported once to Kotlin).
2. **React Native** (Hermes) reusing the TS engines directly; MapLibre Native for maps (same style JSON); native
   modules for CarPlay / Android Auto / Watch / Wear OS / background location / TTS.
3. **Flutter**, engines ported to Dart.
4. **Native UI + embedded JS runtime** (JavaScriptCore / QuickJS) running only the TS core.
5. **Capacitor/PWA wrapper** — rejected up front: Apple 4.2 ("beyond a repackaged website") and no CarPlay/AA or
   reliable background navigation.

## Decision & Free Spike Outcome (2026-11-23)
We favour **Option 2 (React Native + Hermes + native car/wrist modules)** and ran the free portion of the spike in
`mobile/` (`npm run spike:mobile`) with zero paid accounts, zero paid SDKs, and zero closed-source dependencies:

| Criterion | Status | Evidence (2026-11-23) |
| --- | --- | --- |
| 1. Background location for 60 min with screen off (iOS + Android 14+ FGS `location`) | PENDING native shell | `LocationProvider` seam ready (`src/platform/location.ts`, REQ-MOB-005); needs native RN iOS/Android shell build (CocoaPods + Android NDK not installed on this host). |
| 2. Shared TS engines run unchanged in Hermes with ≤ 20 ms per `derive` | **PASSED** | `mobile/src/hermes-core-entry.ts` bundles all core engines + `fflate` gzip (MIT, replacing browser `DecompressionStream`) into a 146.6 kB ES2019 `platform: 'neutral'` bundle with 0 browser polyfills; **compiles cleanly with Meta `hermesc` 250829098.0.19 (HBC bytecode v98 → 151 kB `.hbc`, 0 errors)**; 50 full route-timing + sampling + weather-matching + grouping + intelligence + alert + guidance + `CompanionSnapshot` iterations ran in a stripped zero-DOM ES2020 VM at **median 1 ms, p95 2 ms, max 2 ms**. Enforced continuously by `src/test/architecture.test.ts` (78 core files) and `npm run spike:mobile`. |
| 3. CarPlay `CPMapTemplate` & Android Auto `NavigationTemplate` driven by shared state | PARTIAL (bridge adapters ready; live car simulators pending) | Pure `CompanionSnapshot` + `CarSurfaceBridge` / `WristCompanionBridge` (`src/platform/surfaces.ts`) and typed RN adapters (`mobile/src/surfaces/carPlayBridge.ts`, `androidAutoBridge.ts`, `wristBridge.ts`) enforce the one-weather-alert-at-a-time rule. Running the live Xcode CarPlay external display simulator and Android Auto Desktop Head Unit (DHU) requires linking the native iOS/Android RN targets (CocoaPods, Android NDK, SDK Manager `extras/google/auto` DHU). |
| 4. MapLibre Native rendering of our style JSON at 60 fps | PENDING native shell | Same static Protomaps style JSON + packs (`src/map/packs.ts`) verified on real Mobile Safari (iOS 27.2 Simulator) and Chrome (Android 36 Emulator). |
| 5. Voice via AVSpeechSynthesizer / Android TTS from shared instruction IDs | PARTIAL | Shared instruction/voice phrasing (`src/navigation/instructions.ts`, `src/voice/providers.ts` `TextToSpeechProvider`) is decoupled; native TTS bindings arrive with the RN shell. |

## Cost & Store Fees (Owner Decision Point — aligns with ADR-015 / ADR-019)
Building the entire React Native codebase, running tests, and verifying on simulators/emulators costs **$0**. Money
appears only at optional public app-store publishing (never triggered automatically):
- **Apple Developer Program (\$99/year):** required for App Store, TestFlight, the CarPlay entitlement, and
  distributing watchOS apps. **Status: BLOCKED until the owner decides to pay.**
- **Google Play Console (\$25 one-time):** required for Google Play distribution (including Play-distributed Android
  Auto). **Status: BLOCKED until the owner decides to pay.**
- **Free \$0 routes supported without paying:**
  - Web / installable PWA on every platform (desktop, iOS/iPadOS, Android).
  - Android phones/tablets/foldables via direct APK and **F-Droid** (open-source repo, MIT).
  - Wear OS via direct ADB/APK sideloading.
  - Android Auto for non-Play apps via Desktop Head Unit (DHU) and the phone's Android Auto Developer Settings →
    *"Unknown sources"*.
  - Personal iOS/iPadOS builds on the owner's own devices with a free Apple ID (re-signed every 7 days, limited app
    count).
  - CarPlay and watchOS in Xcode's built-in simulators.

## Consequences
- All platform seams (`storage`, `location`, `notifications`, `wakeLock`, `share`, `fileCache`, `haptics`,
  `car/wrist surfaces`, `fflate` gzip) now live in `src/platform/*` and `src/utils/gzip.ts`, with zero `services/*`
  imports inside core folders.
- Repository monorepo split (`apps/web`, `apps/mobile`, `packages/*` per MOBILE_STRATEGY §2) stays deferred until
  the native iOS/Android shell build is initialized (the `mobile/` spike already imports `src/*` directly with zero
  churn to web build, tests, or Cloudflare Worker deploys).
- Native apps consume the exact same static `/data/*` files (cached on disk via `FileCacheProvider`) and versioned
  `/api/v1/*` endpoints (ADR-009, ADR-019, ADR-020).

## Alternatives rejected
- **Flutter:** rewrite all deterministic engines in Dart; doubles correctness risk.
- **Capacitor/PWA wrapper:** App Store 4.2 risk, no CarPlay/Android Auto or reliable background navigation.
