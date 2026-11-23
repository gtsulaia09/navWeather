#!/usr/bin/env node
/**
 * `npm run preview:worker` — builds the production app and serves ./dist via the local Cloudflare Worker
 * (`wrangler dev`, REQ-DEV-001). Sets `CHOKIDAR_USEPOLLING=1` so wrangler's asset watcher does not open
 * thousands of fs.watch file descriptors across dist/data/ on macOS (which otherwise crashes miniflare with
 * `Error: spawn EBADF`, B-48).
 *
 * Pass `--no-build` to reuse an existing dist/.
 */
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const skipBuild = args.includes('--no-build');
const extra = args.filter((a) => a !== '--no-build');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

if (!skipBuild) {
  const build = spawnSync(npm, ['run', 'build'], { stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const child = spawn(npx, ['wrangler', 'dev', '--port', '8787', '--ip', '127.0.0.1', ...extra], {
  stdio: 'inherit',
  env: { ...process.env, CHOKIDAR_USEPOLLING: '1' },
});

const stop = (sig) => {
  if (child.exitCode === null) child.kill(sig);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 0));
