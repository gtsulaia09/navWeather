# wayther Mobile — React Native (Hermes)

Shared-core mobile workspace for **iOS, Android (incl. F-Droid / direct APK), CarPlay, Android Auto, Apple Watch, and Wear OS** ([ADR-010](../docs/architecture/decisions/ADR-010-mobile-stack.md), [MOBILE_STRATEGY.md](../docs/mobile/MOBILE_STRATEGY.md)).

## Architecture
- **100% shared TypeScript core** imported directly from `../src/*`:
  - `src/algorithms/*` (timing, sampling, weather matching/grouping, hazard thresholds, route conditions)
  - `src/intelligence/*` (weather alerts, driver alerts, route intelligence)
  - `src/navigation/*` (maneuvers, voice instructions, deviation)
  - `src/roads/*` & `src/transit/*` (on-device routing & GTFS RAPTOR)
  - `src/i18n/*` (`en`, `ru`, `ka`)
  - `src/utils/gzip.ts` (`fflate` — works in Hermes without `DecompressionStream`)
- **Zero browser/DOM globals** in shared core (enforced by `src/test/architecture.test.ts` and `npm run spike:mobile`).
- **All native OS capabilities behind interfaces** wired once at startup via `mobile/src/platform/registerNativePlatform.ts`.

## Verify Hermes compatibility (runs in CI)
```bash
npm run spike:mobile
```
Bundles `mobile/src/hermes-core-entry.ts` to ES2019 (`platform=neutral`, zero polyfills), runs the full Tbilisi → Batumi pipeline in a bare Hermes-like VM, verifies `fflate` gunzip and `p95 derive ≤ 20 ms`, and compiles real `.hbc` bytecode if `hermesc` is installed.

## Bootstrap native iOS / Android projects
```bash
cd mobile
# Install React Native + open-source native modules listed in peerDependencies:
npm install react react-native @maplibre/maplibre-react-native react-native-mmkv \
  react-native-safe-area-context react-native-tts react-native-geolocation-service \
  react-native-fs react-native-keep-awake react-native-haptic-feedback

# Start Metro (preconfigured in metro.config.js to watch ../src):
npm start

# Run on device/simulator:
npm run ios
npm run android
```
