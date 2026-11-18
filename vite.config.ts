import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

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
  };
});
