import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

// App version (bumped on every update by scripts/bump-version.mjs), shown in the footer and on the sign-in page
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-180.png', 'punjab-logo-white.png'],
      manifest: {
        name: 'Employee Performance Dashboard',
        short_name: 'KPI Dashboard',
        description: 'KPIs, targets and performance reviews',
        theme_color: '#187a43',
        background_color: '#f6f8f5',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            // Show last-known data when officers are offline / on weak signal.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth'),
            handler: 'NetworkFirst',
            // Cache is only a fallback when the network fails (no timeout race); it is cleared on login/logout/user change (lib/auth.tsx).
            options: { cacheName: 'api', cacheableResponse: { statuses: [200] }, expiration: { maxEntries: 100, maxAgeSeconds: 86400 } },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_PROXY ?? 'http://127.0.0.1:4000' }, // IPv4: another local app may hold [::1]:4000
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: { charts: ['recharts'], vendor: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'] },
      },
    },
  },
});
