import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Use relative asset URLs so the bundle works regardless of the path the
  // server is mounted at. Combined with server-side BASE_URL support, this
  // lets the same image run at `/`, `/lifttrace/`, or any other prefix
  // without a rebuild.
  base: './',
  server: {
    proxy: {
      '/api':     'http://localhost:3003',
      '/uploads': 'http://localhost:3003',
    }
  },
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Precache the offline fallback page
        globPatterns: ['offline.html'],
        // navigateFallback explicitly disabled — navigation requests are
        // handled by the NetworkFirst runtimeCaching route below.
        navigateFallback: null,
        navigateFallbackDenylist: [/.*/],
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
            // Navigation: network first (3s timeout), cache index.html for
            // offline use. Deploys are picked up instantly because the
            // network response always wins when the server is reachable.
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pages-cache',
              networkTimeoutSeconds: 3,
            }
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
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/uploads/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'uploads-cache',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
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
