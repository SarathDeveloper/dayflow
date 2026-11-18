import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

/**
 * The site-wide headers from vercel.json (CSP and friends), so `npm run
 * preview` enforces the same policy as the live site. HSTS is left out: it
 * means nothing on http://localhost.
 */
function vercelSiteHeaders(): Record<string, string> {
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'vercel.json'), 'utf8')) as {
    headers?: {source: string; headers: {key: string; value: string}[]}[];
  };
  const site = config.headers?.find((rule) => rule.source === '/(.*)');
  return Object.fromEntries(
    (site?.headers ?? []).filter((header) => header.key !== 'Strict-Transport-Security').map((header) => [header.key, header.value]),
  );
}

export default defineConfig(({mode}) => {
  // The Capacitor build is served from https://localhost inside the native
  // WebView: relative asset paths keep index.html self-contained and the
  // service worker is unnecessary (the app shell is already installed).
  const isCapacitorBuild = mode === 'capacitor';

  return {
    base: isCapacitorBuild ? './' : '/',
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        // Service worker + manifest only matter for the browser/PWA build.
        disable: isCapacitorBuild,
        registerType: 'autoUpdate',
        includeAssets: ['icons/favicon-32.png', 'icons/apple-touch-icon.png'],
        manifest: {
          name: 'Dayflow',
          short_name: 'Dayflow',
          description: 'Tasks, focus sessions, and spending on your phone.',
          theme_color: '#ffffff',
          background_color: '#fafaf9',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: 'icons/icon-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: 'icons/icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: 'icons/icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          // mjs: the pdf.js worker, so encrypted documents still open offline.
          globPatterns: ['**/*.{js,mjs,css,html,ico,png,svg,woff2}'],
          navigateFallback: 'index.html',
          // /supabase/* is the Vercel proxy to the Supabase project (see
          // vercel.json). The service worker must never answer it with the app.
          navigateFallbackDenylist: [/^\/supabase\//],
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    preview: {
      headers: vercelSiteHeaders(),
    },
    build: {
      // pdf.js (~500 kB) is the only larger chunk and loads only when a
      // document is opened; anything else crossing this should be split.
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          // Libraries change less often than app code: separate chunks stay
          // cached across app releases.
          manualChunks(id) {
            if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
            if (/node_modules[\\/]@supabase[\\/]/.test(id)) return 'supabase';
            return undefined;
          },
        },
      },
    },
  };
});
