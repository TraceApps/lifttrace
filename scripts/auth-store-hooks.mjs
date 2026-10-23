/**
 * Loads the real src/stores/auth.js under Node for startup-auth.test.js:
 * what it imports from the browser and Capacitor (the platform, the stored
 * settings, coaching, the photo cache, the local database) is swapped for a
 * stand-in that reads globalThis.__auth, the test's device. Everything else
 * is the app's own code. Each `?case=` import of the store gets its own
 * stand-ins, so the Android and web cases don't share a platform.
 */
const STUBS = {
  'platform.js': `
    const d = () => globalThis.__auth;
    export const isNative = !!globalThis.__auth.native;
    export const getServerUrl = () => d().serverUrl ?? null;
    export const getAuthToken = () => d().token ?? null;
    export const setAuthToken = (t) => { d().token = t; };
    export const apiUrl = (p) => p;
    export const resolveAssetUrl = (p) => p;`,
  'settings.js': `
    export const loadServerSettings = async () => { globalThis.__auth.serverSettingsLoaded = true; };
    export const reloadSettingStores = () => {};`,
  'coaching.js': `
    export const setCoachingFromServer = () => {};
    export const loadCachedCoaching = () => {};
    export const clearCoaching = () => {};`,
  'photo-blobs.js': `export const clearPhotoBlobs = () => {};`,
  'db.js': `export const DB = { getSetting: (k, d) => (globalThis.__auth.settings || {})[k] ?? d };`,
};

export async function resolve(specifier, context, next) {
  const parent = context.parentURL || '';
  if (/\/src\/stores\/auth\.js(\?|$)/.test(parent)) {
    const stub = STUBS[specifier.split('/').pop()];
    if (stub) {
      const tag = new URL(parent).search;
      return { url: 'data:text/javascript,' + encodeURIComponent(`${stub}\n// ${tag}`), shortCircuit: true };
    }
  }
  return next(specifier, context);
}
