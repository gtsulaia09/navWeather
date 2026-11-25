# Mobile, CarPlay, Android Auto and Wearables Strategy

> **Updated 2026-11-23 ([ADR-010](../architecture/decisions/ADR-010-mobile-stack.md),
> [ADR-015](../architecture/decisions/ADR-015-free-software-own-hosting.md),
> [ADR-019](../architecture/decisions/ADR-019-zero-owner-cost.md),
> [ADR-020](../architecture/decisions/ADR-020-free-at-any-scale-overflow.md)):** the owner pays **$0** at any scale
> (hosting, data, APIs, overflow). Store fees (Apple \$99/year, Google Play \$25 once) are the only remaining paid step
> and are strictly optional; every target has a documented free \$0 route below.

## 0. Platform Matrix (2026-11-23)

| Platform | What works today ($0) | What needs native React Native / OS code | Blocked by store fees? | Free $0 route |
| --- | --- | --- | --- | --- |
| **Web — Desktop** (Chrome, Edge, Firefox, Safari on macOS/Windows/Linux) | Full app: on-device routing, search, forecasts, air quality, elevation, Long Trip planner, own Protomaps basemap, live sharing + WebRTC/Nostr overflow, driver reports + static feed, keyboard nav, light/dark/high-contrast | — | No | Direct web / PWA on Cloudflare Workers Free (`*.workers.dev`) |
| **Web — Mobile PWA** (iOS/iPadOS Safari incl. Home Screen, Android Chrome, Samsung Internet, Firefox Android) | Full planning + foreground turn-by-turn navigation, safe areas (notch/Dynamic Island/home indicator), fluid landscape/portrait, visual-viewport dialogs, Wake Lock, offline app shell & cached `/data` | Background navigation with screen locked, car screens, native offline region manager | No | Installable PWA on every platform |
| **iPhone** (all sizes incl. SE 320 px, notch, Dynamic Island) | PWA verified in real iOS 27.2 Simulator Safari + Chrome safe-area E2E; shared TS core verified in Meta `hermesc` (HBC v98, 1–2 ms `derive`); **interim native `WKWebView` iOS shell** (`ios/NavWeather.xcodeproj`, `src/platform/nativeIosBridge.ts`, unsigned CI `.ipa` in `.github/workflows/ios-ipa.yml`) bridges `CoreLocation` (incl. background navigation), `AVSpeechSynthesizer`, haptics, wake lock, and bundled `/data` via `navweather://` | Full React Native shell (`MapLibre Native`, `MMKV`, `UNUserNotificationCenter`, native CarPlay/Watch bridges) per [ADR-010](../architecture/decisions/ADR-010-mobile-stack.md) | **App Store & TestFlight BLOCKED** by Apple Developer Program (\$99/year, ADR-015) | Installable PWA for users; personal native builds on owner's own devices with a free Apple ID (re-signed every 7 days, limited app count) using the unsigned CI `.ipa` or Xcode |
| **iPad** (Split View, Stage Manager, keyboard & trackpad) | Fluid web/PWA layout verified at tablet viewports (768×1024, 1024×768); keyboard focus traps & shortcuts | Same RN iOS shell with adaptive split-view layout & pointer/keyboard support | **App Store & TestFlight BLOCKED** (\$99/year) | Installable PWA; personal 7-day free Apple ID builds |
| **Apple Watch** (glanceable companion: next maneuver, ETA, next weather event — no map required) | Pure `CompanionSnapshot` + `WristCompanionBridge` (`src/platform/surfaces.ts`, `mobile/src/surfaces/wristBridge.ts`) | watchOS SwiftUI companion target + `WatchConnectivity` | **Distribution BLOCKED** (\$99/year Apple Developer Program) | Xcode Watch Simulator only until owner decides to pay |
| **Apple CarPlay** (navigation templates, 1 weather alert at a time, voice-first) | Native `CarPlaySceneDelegate.swift` (`CPMapTemplate`, `CPNavigationSession`, `CPListTemplate` for Saved/Recent & Georgia places + Nearby POIs, single-alert `CPNavigationAlert`, live route + weather stretches on `MKMapView`) wired via `nativeIosBridge.ts` + `useCarSurfaceSync.ts` + `AppRuntime` (runs even with iPhone screen locked) | Optional React Native MapLibre CarPlay window when full RN shell replaces interim `WKWebView` shell | **Entitlement & App Store distribution BLOCKED** (\$99/year Apple Developer Program + Apple CarPlay entitlement approval) | Xcode CarPlay external display simulator at \$0; physical car head-unit works once signed with an Apple CarPlay-entitled provisioning profile |
| **Android phones** (wide sizes/densities, low-end hardware) | PWA verified on real Android 36 Emulator Chrome 134 + 320–430 px & 6× CPU throttled benchmarks; shared core verified in Hermes (`hermesc`) | React Native shell (`FusedLocationProviderClient` + Android 14+ `FOREGROUND_SERVICE_LOCATION`, Android `TextToSpeech`, MapLibre Native, `MMKV`, `NotificationManagerCompat`) | **Google Play BLOCKED** (\$25 once, ADR-015) | **Direct signed APK + F-Droid** (100% free for open-source MIT repo) + PWA |
| **Android tablets & foldables** | Fluid web/PWA layouts; side-docked sheet in landscape/wide viewports | Same RN Android shell with responsive window-size classes (`useWindowDimensions`) | **Google Play BLOCKED** (\$25 once) | **Direct APK + F-Droid** + PWA |
| **Wear OS** (glanceable companion: next maneuver, ETA, next weather event — no map required) | Pure `CompanionSnapshot` + `WristCompanionBridge` (`mobile/src/surfaces/wristBridge.ts`) | Wear OS Compose target + Wearable `DataClient` | **Google Play BLOCKED** (\$25 once) | **Direct APK sideloading** via ADB (100% free) |
| **Android Auto** (Car App Library `NavigationTemplate`, 1 weather alert at a time, voice-first) | Pure `CompanionSnapshot` + `CarSurfaceBridge` + `androidAutoBridge.ts` | `CarAppService` (`NAVIGATION` category) + `NavigationTemplate` + `NavigationManager` + MapLibre Native surface | **Play distribution BLOCKED** (\$25 once) | **Desktop Head Unit (DHU)** simulator + non-Play sideload with phone Android Auto Developer Settings → *"Unknown sources"* |

## 1. What the web can and cannot do (PWA reality)

| Capability | Android Chrome (PWA) | iOS Safari (home-screen web app) |
| --- | --- | --- |
| Install, offline shell & cached `/data` | yes | yes |
| Foreground GPS navigation, screen kept on (Wake Lock) | yes | yes (Wake Lock in modern Safari) |
| Navigation with screen locked / app in background | **no** | **no** |
| Push notifications | yes | home-screen web apps only (WebKit, iOS 16.4+) |
| CarPlay / Android Auto | **no** | **no** |
| Background location sharing | **no** | **no** |
| Large offline map regions | constrained by browser storage eviction | constrained |

Conclusion: the PWA is a strong planning tool and foreground navigator on every platform at \$0; real in-car
background navigation, CarPlay, Android Auto, and wrist companions need React Native + native OS modules.

## 2. Shared codebase across Web, iOS and Android

| Layer | Share? | How |
| --- | --- | --- |
| API types & contract | yes | `src/api/v1.ts`, `src/share/protocol.ts`, `src/reports/protocol.ts` → future `packages/api` |
| Route, weather, navigation, trip & surface models (`src/types`, `src/platform/surfaces.ts`) | yes | future `packages/core` |
| Engines: timing, sampling, weather matching, grouping, alert engines, deviation, guidance, voice phrasing, device router (`src/roads`), Long Trip planner (`src/trip`), `fflate` gzip | yes (the main asset) | runs unchanged in Hermes (`npm run spike:mobile`, verified with Meta `hermesc` HBC v98: median 1 ms / p95 2 ms) |
| i18n messages (en, ru) | yes | `src/i18n/*` → future `packages/i18n` (spoken + display forms) |
| UI | no | web React DOM (`src/components`); React Native screens designed per platform (`mobile/` → future `apps/mobile`) |
| Map rendering | partly | same static Protomaps style JSON & packs (`src/map/packs.ts`); MapLibre GL JS / MapLibre Native |
| GPS, background, TTS, notifications, wake lock, share, haptics, car & wrist surfaces | behind interfaces | `src/platform/*` and `src/voice/providers.ts` |

Repository split into `apps/web` + `apps/mobile` + `packages/*` happens only once the full native shell build starts
(avoiding churn while `mobile/` imports `src/*` directly and keeps every web script, test, and Cloudflare deploy green).

### 2a. Platform seams in today's code (2026-11-23)

All shared core folders are enforced platform-free (zero React, DOM, `services/*`, or Hermes-missing Web APIs like
`DecompressionStream`/`Blob`) by `src/test/architecture.test.ts` (78 core files).

| Need | Web implementation today | Seam interface | React Native replacement |
| --- | --- | --- | --- |
| Routing, search, weather, places, elevation, air | static files (`/data`) + on-device engines | `services/providers.ts` (`Providers`) | same TS engines in Hermes; files from `FileCacheProvider` / HTTP |
| Road engine off UI thread | Web Worker (`roads/client.ts`, `roads/worker.ts`) | `RoadClient` (`createRoadClient`, lazy inline fallback) | `react-native-worklets` / JSI worker thread |
| Key-value storage | `localStorage` / `sessionStorage` | `platform/storage.ts` (`KeyValueStore`, `setStorage`) | `react-native-mmkv` (sync) |
| Offline data file cache | Cache Storage API + memory LRU | `platform/fileCache.ts` (`FileCacheProvider`, `setFileCacheProvider`) | native disk cache (`react-native-fs` / filesystem) |
| Device location (REQ-MOB-005) | `navigator.geolocation` (web); `CoreLocation` via `nativeIosBridge.ts` (iOS shell) | `platform/location.ts` (`LocationProvider`, `setLocationProvider`) | Core Location (iOS) / `FusedLocationProviderClient` + FGS (Android) |
| Notifications (REQ-MOB-006) | Web Notification API | `platform/notifications.ts` (`NotificationProvider`, `setNotificationProvider`) | `UNUserNotificationCenter` / `NotificationManagerCompat` |
| Voice prompts & recognition | Web Speech API (web); `AVSpeechSynthesizer` via `nativeIosBridge.ts` (iOS shell) | `voice/providers.ts` (`TextToSpeechProvider`, `setTtsProvider`, `SpeechRecognitionProvider`) | `AVSpeechSynthesizer` / Android `TextToSpeech`, native speech recognition |
| Keep screen awake | Screen Wake Lock API (web); `isIdleTimerDisabled` via `nativeIosBridge.ts` (iOS shell) | `platform/wakeLock.ts` (`WakeLockProvider`, `setWakeLockProvider`) | `UIApplication.isIdleTimerDisabled` / `FLAG_KEEP_SCREEN_ON` |
| gzip / deflate-raw data files | `fflate` pure JS (MIT) | `utils/gzip.ts` (`gunzip`, `inflateRaw`) | **works as-is in Hermes** (zero `DecompressionStream`) |
| Device language | `navigator.language` → `Intl` → `en` | `i18n/systemLanguage.ts` | **works as-is in Hermes** |
| Share sheet & clipboard | Web Share / Clipboard API | `platform/share.ts` (`ShareProvider`, `setShareProvider`) | RN `Share.share` / native Clipboard |
| Haptics | `navigator.vibrate` (web); `UIImpact/Notification/SelectionFeedbackGenerator` via `nativeIosBridge.ts` (iOS shell) | `platform/haptics.ts` (`HapticsProvider`, `setHapticsProvider`) | `UIImpactFeedbackGenerator` / Android `VibrationEffect` |
| Map | MapLibre GL JS (`PackMapProvider`) | `services/map/MapProvider.ts` (style JSON) | MapLibre Native using same Protomaps style JSON |
| Car surfaces (CarPlay / Android Auto) | no-op on web; `nativeCarPlay` → `CarPlaySceneDelegate.swift` in iOS shell (`useCarSurfaceSync.ts`) | `platform/surfaces.ts` (`CarSurfaceBridge`, `buildCompanionSnapshot`, `CarSurfaceCommand`) | `mobile/src/surfaces/carPlayBridge.ts`, `androidAutoBridge.ts` |
| Wrist companions (Watch / Wear OS) | no-op default | `platform/surfaces.ts` (`WristCompanionBridge`, `buildCompanionSnapshot`) | `mobile/src/surfaces/wristBridge.ts` |

## 3. iOS / iPadOS requirements (when store publishing is unblocked)

| Item | Class | Notes |
| --- | --- | --- |
| Apple Developer Program (\$99/year) | REQUIRED for App Store / TestFlight / CarPlay / watchOS | Owner decision point (ADR-015). Free Apple ID allows 7-day personal device builds. |
| `NSLocationWhenInUseUsageDescription` + `UIBackgroundModes: location` | REQUIRED | Navigation needs When-In-Use + background location mode (not Always). |
| App Store 5.1.5 location consent & `PrivacyInfo.xcprivacy` | REQUIRED | Location primer already implemented; verify privacy manifest at native build time. |
| App Store 4.2 minimum functionality | REQUIRED | Native background navigation, offline packs, CarPlay justify native app. |
| Account deletion in-app (5.1.1(v)) | REQUIRED only if accounts ever ship | Anonymous-first today (no accounts). |
| Dynamic Type, safe areas, iPad Split View / Stage Manager / keyboard | REQUIRED | Fluid layouts & safe areas enforced on web already; carry into RN screens. |

## 4. Android requirements (APK / F-Droid free; Play optional)

| Item | Class | Notes |
| --- | --- | --- |
| Open-source build for **F-Droid** / direct APK | FREE (\$0) | MIT repo, zero proprietary/closed SDKs, zero Google Play Services dependency required for core routing/weather (use OS `LocationManager` fallback alongside Fused when GMS absent). |
| `ACCESS_FINE_LOCATION` + `FOREGROUND_SERVICE_LOCATION` (Android 14+) | REQUIRED | Active navigation runs as a foreground service with ongoing notification; avoids `ACCESS_BACKGROUND_LOCATION`. |
| `POST_NOTIFICATIONS` (Android 13+) | REQUIRED | Needed for navigation FGS notification and weather alerts. |
| Audio focus ducking + Android `TextToSpeech` | REQUIRED | Implemented behind `TextToSpeechProvider`. |
| Play Console account (\$25 once) | OPTIONAL | Owner decision point (ADR-015); only needed for Google Play & Play-distributed Android Auto. |

## 5. CarPlay
- **Implementation (`ios/NavWeather/CarPlaySceneDelegate.swift`):** `CPTemplateApplicationSceneDelegate` + `CarPlayCoordinator` + `CarPlayMapViewController` (`CPMapTemplate`, `CPNavigationSession`, `CPListTemplate` for Saved/Recent destinations & Nearby categories incl. Fresco/supermarkets/fuel/EV, `CPTripPreviewTextConfiguration` with route weather summary, and `CPNavigationAlert` enforcing **at most ONE weather alert banner at a time**, voice-first via `.spokenAudio` + `.interruptSpokenAudioAndMixWithOthers`). `AppRuntime.shared` boots the shared engine automatically even if CarPlay connects while the iPhone is locked in a pocket.
- **Entitlement:** physical retail CarPlay projection requires signing with Apple's CarPlay navigation entitlement (paid Apple Developer Program, ADR-015).
- **Free testing:** Xcode → I/O → External Displays → CarPlay simulator works out of the box at \$0.

## 6. Android Auto
- **Library:** Android Car App Library, `CarAppService` with `androidx.car.app.category.NAVIGATION`, `NavigationTemplate`, `NavigationManager.navigationStarted() / updateTrip() / navigationEnded()`, MapLibre Native surface.
- **Weather rule:** identical to CarPlay — one alert banner at a time, voice-first (`mobile/src/surfaces/androidAutoBridge.ts`).
- **Free testing / sideloading:** Android Auto Desktop Head Unit (DHU) and non-Play APK with phone Android Auto Developer Settings → *"Unknown sources"*.

## 7. Offline (native)
Same static `/data` files (roads, search, places, weather, air, elevation, Protomaps basemap packs) cached on disk
behind `FileCacheProvider`, with explicit stale labels when offline (ADR-012). Never promise offline live forecasts.

## 8. API readiness checklist for mobile
- [x] Versioned `/api/v1`, additive-only changes (ADR-009).
- [x] JSON errors, no cookie dependence for anonymous endpoints (Bearer key for live sharing).
- [x] Zero-DOM shared core verified in Hermes (`npm run spike:mobile`, `src/test/architecture.test.ts`).
- [x] Platform seams implemented (`src/platform/*`).
- [ ] Bearer-token user auth + refresh rotation (only if optional accounts ship, ADR-008).
- [ ] Minimum-supported-client hint in `GET /api/v1/health` (`minClient` per platform — additive).
- [ ] Generated OpenAPI file for native clients.
