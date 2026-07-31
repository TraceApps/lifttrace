/**
 * version-source.js — resolves the server's APP_VERSION at boot.
 *
 * Resolution order (first hit wins):
 *   1. process.env.TRACEAPPS_APP_VERSION  — Docker ARG/ENV injection.
 *   2. process.env.npm_package_version    — set when launched via `npm start`.
 *   3. readFileSync('./package.json')     — best-effort, resolved against
 *                                            process cwd. Works in dev and
 *                                            in Docker (WORKDIR /app).
 *   4. 'unknown'                          — safe fallback; the /server-status
 *                                            endpoint returns available=false
 *                                            when version isn't a real semver.
 *
 * Earlier iterations tried to import from `../../src/lib/version.js`, which
 * only exists in the source tree — not in the Docker runtime image, where
 * `src/` is a build stage that never gets copied to the runtime layer.
 * That import threw ERR_MODULE_NOT_FOUND at boot and hard-crashed the
 * container. Everything here is inside a try/catch so no failure path
 * can crash the server again.
 */
import { readFileSync } from 'node:fs';

function _resolve() {
  const envInjected = process.env.TRACEAPPS_APP_VERSION;
  if (envInjected) return envInjected.startsWith('v') ? envInjected : `v${envInjected}`;

  const npmVer = process.env.npm_package_version;
  if (npmVer) return `v${npmVer}`;

  try {
    const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
    if (pkg?.version) return `v${pkg.version}`;
  } catch { /* fall through */ }

  return 'unknown';
}

let cached = null;
try {
  cached = _resolve();
} catch {
  cached = 'unknown';
}

export const APP_VERSION = cached;
