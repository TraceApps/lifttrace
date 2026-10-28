import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { isAppPageLoad, treatServerErrorAsOffline, keepNoPageCopy, useCachedAppOnTimeout } from './src/lib/pwa-navigation.js';

export default defineConfig({
  // Use relative asset URLs so the bundle works regardless of the path the
  // server is mounted at. Combined with server-side BASE_URL support, this
  // lets the same image run at `/`, `/lifttrace/`, or any other prefix
  // without a rebuild.
  base: './',
  server: {
    proxy: {
      '/api':     'http://localhost:3002',
      '/uploads': 'http://localhost:3002',
    }
  },
  plugins: [
    svelte(),
    VitePWA({
      // 'prompt' downloads new bundles in the background but WAITS for
      // us to activate them, so UpdateBanner can pop a "Reload" prompt
      // instead of ripping the page out from under the user mid-session.
      // Activation is driven by lib/pwa-update.js via virtual:pwa-register.
      registerType: 'prompt',
      // Browsers fetch the manifest without the sign-in proxy's cookie unless
      // told otherwise, and the proxy answers with its sign-in page
      // (TraceApps/notetrace#37).
      useCredentials: true,
      workbox: {
        // Precache the app itself, not just the fallback page: with only
        // offline.html here a reload with no connection served a shell whose
        // own JavaScript 404'd, and the installed app came back blank.
        globPatterns: ['**/*.{js,mjs,css,html,woff2,woff,ttf,png,svg,ico,webmanifest}'],
        // heic2any and hls are big and optional (photo conversion, audio
        // streaming); they load from the network the first time they're needed.
        globIgnores: ['vendor/**', 'icons/**', '**/*.map', '**/heic2any-*.js', '**/hls-*.js'],
        // Some chunks (charts, the exercise catalogue) are over the 2 MiB default.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Deletes caches an older service worker kept (public/sw-retired-caches.js).
        importScripts: ['sw-retired-caches.js'],
        // Page loads go to the server first (the first page route below), so
        // no navigateFallback (null, or Vite PWA puts its own back), and '/'
        // isn't answered from the cache as index.html: the precache answered
        // it before any route ran, so a deploy waited a reload.
        navigateFallback: null,
        directoryIndex: null,
        cleanupOutdatedCaches: true,
        // skipWaiting + clientsClaim ensure new SW activates immediately
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            // Audio/media streams must go directly to the network, bypassing the SW.
            // If the SW is suspended (e.g. screen lock), SW-intercepted fetches
            // would stall. NetworkOnly explicitly passes through.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/subsonic/'),
            handler: 'NetworkOnly',
          },
          {
            // The app page: from the server, the cached copy only offline
            // (src/lib/pwa-navigation.js).
            urlPattern: isAppPageLoad,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'app-page',
              networkTimeoutSeconds: 3,
              precacheFallback: { fallbackURL: 'index.html' },
              plugins: [{ fetchDidSucceed: treatServerErrorAsOffline, cacheWillUpdate: keepNoPageCopy, cachedResponseWillBeUsed: useCachedAppOnTimeout }],
            }
          },
          {
            // The API and uploads opened as a page:
            // never kept, so an export or a backup can't outlive the session.
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/wger\.de\/.*/i,
            handler: 'NetworkFirst',
            options: { cacheName: 'wger-api-cache', expiration: { maxEntries: 200, maxAgeSeconds: 86400 } }
          },

          // ── Exercise media: STABLE sources (content-addressable URLs) ──
          // OSS exercisedb serves `/media/{exerciseId}.gif` (derivable from
          // the ID), Free Exercise DB is in a git repo, wger hosts its own.
          // None of these rotate. 30-day cache is safe.
          {
            urlPattern: ({ url }) =>
              /^https:\/\/static\.exercisedb\.dev\/media\//i.test(url.href) ||
              /^https:\/\/raw\.githubusercontent\.com\/yuhonas\/free-exercise-db\//i.test(url.href) ||
              /^https:\/\/wger\.de\/media\//i.test(url.href),
            handler: 'CacheFirst',
            options: {
              cacheName: 'exercise-media-stable',
              expiration: { maxEntries: 3000, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
              matchOptions: { ignoreVary: true },
            },
          },

          // ── Exercise media: ROTATING sources (AscendAPI docs say media
          // URLs rotate every Monday 00:00 UTC on the commercial endpoints).
          // Keep the cache TTL below one week so a stale URL can't survive
          // a rotation and return 404s. Re-import refreshes the stored URL.
          {
            urlPattern: ({ url }) =>
              /^https:\/\/cdn\.exercisedb\.dev\//i.test(url.href) ||
              /^https:\/\/v2\.exercisedb\.io\//i.test(url.href) ||
              /^https:\/\/exercisedb\.p\.rapidapi\.com\//i.test(url.href),
            handler: 'CacheFirst',
            options: {
              cacheName: 'exercise-media-rotating',
              expiration: { maxEntries: 2000, maxAgeSeconds: 60 * 60 * 24 * 6 },
              cacheableResponse: { statuses: [0, 200] },
              matchOptions: { ignoreVary: true },
            },
          },

          // Uploaded images (custom exercises, avatars). Same pattern,
          // but same-origin so they live in the main SW cache anyway.
          {
            // Progress photos are excluded: this cache is shared by every
            // account that signs in on the browser profile, and its entries
            // outlive sign-out, so caching them here would reopen exactly the
            // leak the authenticated photo route closes.
            // Under the worker's own scope, so a BASE_URL subpath
            // (/lifttrace/uploads/...) is kept too, not only the root.
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin
              && url.pathname.startsWith(new URL(self.registration.scope).pathname + 'uploads/')
              && !url.pathname.includes('/body-stats/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'uploads-cache',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 90 },
              // A picture or video, never a page standing in for one: kept
              // here, it would show broken for 90 days, online too. An opaque
              // answer (status 0) is a login proxy's sign-in page on another
              // address; a page is the same proxy's sign-in on this address,
              // or the app's own page for a file that isn't there.
              cacheableResponse: { statuses: [200] },
              plugins: [{
                cacheWillUpdate: async ({ response }) =>
                  /^text\/html/i.test(response.headers.get('Content-Type') || '') ? null : response,
              }],
            },
          },
        ]
      },
      manifest: {
        name: 'LiftTrace',
        short_name: 'LiftTrace',
        description: 'Trace Every Rep — Personal Weightlifting Tracker',
        theme_color: '#0A0B0F',
        background_color: '#0A0B0F',
        display: 'standalone',
        orientation: 'portrait-primary',
        // Relative URLs — browsers resolve them against the manifest's own
        // location. Makes PWA install work at any subpath without rebuild.
        start_url: './',
        scope: './',
        // Long-press the installed app's icon (from TraceApps/nutritrace#278):
        // start or resume today's workout, or log your weight
        // (src/lib/app-shortcut.js).
        shortcuts: [
          { name: 'Start Workout', short_name: 'Start Workout', url: './#/?new=workout', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Log Weight', short_name: 'Log Weight', url: './#/?new=weight', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
        ],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ]
});
