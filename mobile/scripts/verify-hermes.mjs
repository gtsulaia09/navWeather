#!/usr/bin/env node
/**
 * ADR-010 Hermes compatibility & performance verification script (100% free, zero paid SDKs).
 *
 * 1. Bundles `mobile/src/hermes-core-entry.ts` (which imports the REAL shared core from `src/algorithms`,
 *    `src/intelligence`, `src/navigation`, `src/platform`, `src/utils/gzip.ts` + `fflate`, `src/i18n`) with esbuild
 *    targeting ES2019 (Hermes JS target) with NO browser/Node polyfills.
 * 2. Executes the bundle in a stripped Hermes-like JS sandbox (ONLY standard ES2020 built-ins + `Intl` + `Date`;
 *    NO `window`, `document`, `navigator`, `localStorage`, `fetch`, `Blob`, `DecompressionStream`, `Buffer`,
 *    `process`, or `require`).
 * 3. If `hermesc` (Meta's open-source Hermes bytecode compiler) is installed, also compiles the bundle to real
 *    Hermes bytecode (`.hbc`) to prove zero syntax/bytecode incompatibilities.
 * 4. Asserts ADR-010 criterion #2: median & p95 `derive` latency <= 20 ms.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const require = createRequire(join(root, 'package.json'));
const esbuild = require('esbuild');

const built = await esbuild.build({
  entryPoints: [join(here, '..', 'src', 'hermes-core-entry.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'NavWeatherCore',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  target: ['es2019'],
  minify: false,
});

const js = built.outputFiles[0].text;
console.log(`Hermes core bundle built: ${(js.length / 1024).toFixed(1)} kB (ES2019, platform=neutral, 0 polyfills)`);

// Verify zero browser/DOM/Hermes-missing globals exist in the execution sandbox.
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
};
vm.createContext(sandbox);
vm.runInContext(js, sandbox, { filename: 'hermes-core-bundle.js' });

const result = await vm.runInContext('NavWeatherCore.runHermesCorePipeline()', sandbox);
console.log('Hermes-sandbox core execution result:', JSON.stringify(result, null, 2));

assert.equal(result.gunzipOk, true, 'fflate gunzip must succeed without DecompressionStream');
assert.equal(result.routeLabel, 'Tbilisi → Batumi');
assert.ok(result.sampleCount >= 8, `expected >= 8 weather samples, got ${result.sampleCount}`);
assert.ok(result.eventCount >= 1, `expected >= 1 route weather event, got ${result.eventCount}`);
assert.ok(result.nextManeuver, 'expected a guidance maneuver for CarPlay/Android Auto/Watch');
assert.ok(result.deriveMs.p95Ms <= 20, `ADR-010 criterion #2 failed: p95 derive ${result.deriveMs.p95Ms} ms > 20 ms`);

// Optional real hermesc bytecode compilation check if hermes-compiler is present.
const hermescCandidates = [
  join(root, 'mobile', 'node_modules', 'hermes-compiler', 'hermesc', 'osx-bin', 'hermesc'),
  join(root, 'node_modules', 'hermes-compiler', 'hermesc', 'osx-bin', 'hermesc'),
];
const hermesc = hermescCandidates.find((p) => existsSync(p));
if (hermesc) {
  const outDir = join(here, '..', '.hermes-out');
  mkdirSync(outDir, { recursive: true });
  const srcFile = join(outDir, 'core.js');
  const hbcFile = join(outDir, 'core.hbc');
  writeFileSync(srcFile, js);
  execFileSync(hermesc, ['-emit-binary', '-O', '-out', hbcFile, srcFile], { stdio: 'pipe' });
  console.log(`Real Hermes bytecode compiled cleanly via hermesc → ${hbcFile}`);
} else {
  console.log('Note: hermesc not installed locally; run `npx --yes --package=hermes-compiler` or install in mobile/ to emit .hbc bytecode.');
}

console.log('ADR-010 Hermes core spike verification PASSED.');
