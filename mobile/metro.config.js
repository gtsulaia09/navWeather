const path = require('path');

/**
 * Metro configuration for wayther React Native (ADR-010).
 *
 * Watches the repository root so `mobile/src/*` can import the shared platform-free
 * TypeScript core (`../src/algorithms`, `../src/intelligence`, `../src/navigation`,
 * `../src/platform`, `../src/i18n`, `../src/roads`, `../src/transit`, `../src/utils/gzip.ts`)
 * without duplicating code or publishing internal packages.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

/** @type {import('@react-native/metro-config').MetroConfig} */
module.exports = {
  projectRoot,
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
    sourceExts: ['ts', 'tsx', 'js', 'jsx', 'json', 'mjs'],
  },
};
