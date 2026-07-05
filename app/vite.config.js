import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';
import tailwindcss from '@tailwindcss/postcss';
import { resolve } from 'node:path';

// MVP runs on a separate port so it can co-exist with the concept demo.
// vite-plugin-cesium copies the Cesium static assets (Workers / ThirdParty /
// Assets / Widgets) into the build and sets CESIUM_BASE_URL so the lazy-loaded
// Cesium module can find its workers/textures at runtime.
//
// The CRM/SaaS surfaces (sales/pm/analytics/tenants) are React subapps and
// pull in Tailwind v4 via PostCSS. Tailwind preflight is scoped via the .crm
// container class in src/crm/styles/tailwind.css so the vanilla-JS pages
// (dashboard.html, index.html, …) never see Tailwind reset rules.
// Site-wide access gate for the dev + preview servers. Mirrors the production
// gate in api/server.mjs: EVERY html page (incl. marketing) requires the
// `rwr.access_pass` cookie — only access.html + assets are public. The cookie is
// set once via /api/v1/access/verify, so the passcode is asked a single time for
// the whole site. Without this, `vite preview`/`dev` serve every page ungated.
function accessGatePlugin() {
  const middleware = (req, res, next) => {
    const url = (req.url || '/').split('?')[0];
    const isHtml = url === '/' || url.endsWith('.html');
    // Only gate html pages; let assets, /api proxy, /@vite, etc. through. The
    // gate page itself must always be reachable (else there's no way in).
    if (!isHtml || url === '/access.html' || url === '/register.html') return next();
    const cookie = req.headers.cookie || '';
    if (/(?:^|;\s*)rwr\.access_pass=/.test(cookie)) return next();
    const next_ = encodeURIComponent(req.url || '/');
    res.statusCode = 302;
    res.setHeader('location', `/access.html?next=${next_}`);
    res.setHeader('cache-control', 'no-store');
    res.end();
  };
  return {
    name: 'rwr-access-gate',
    // Local `vite dev` is intentionally UNGATED: the pilot access-code gate is a
    // production concern enforced by api/server.mjs, and requiring the passcode
    // (which is validated against the DB) just blocks local development. Preview
    // still mirrors prod so the gate can be exercised before deploy.
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}

// vite-plugin-cesium injects `<script src="/cesium/Cesium.js">` + the widgets
// CSS into EVERY html entry — but only the map surfaces ever mount the Cesium
// 3D globe (via the lazily-loaded hd-3d engine). On the public marketing pages
// that's multiple MB of dead weight on first paint. This post-transform strips
// the Cesium tags from the marketing entries only; the dashboard/app map pages
// keep them. Runs `order: 'post'` so it executes AFTER cesium() has injected.
const CESIUM_FREE_ENTRIES = new Set([
  'index.html', 'solutions.html', 'industries.html', 'platform.html',
  'company.html', 'contact.html', 'access.html', 'login.html', 'register.html',
]);
function stripCesiumFromMarketing() {
  return {
    name: 'rwr-strip-cesium-marketing',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const file = (ctx.filename || ctx.path || '').split(/[\\/]/).pop();
        if (!CESIUM_FREE_ENTRIES.has(file)) return html;
        return html
          .replace(/[ \t]*<link\b[^>]*\/cesium\/[^>]*>\r?\n?/g, '')
          .replace(/[ \t]*<script\b[^>]*\/cesium\/Cesium\.js[^>]*><\/script>\r?\n?/g, '');
      },
    },
  };
}

export default defineConfig({
  plugins: [
    accessGatePlugin(),
    react({ include: /src\/(crm|dashboard)\/.*\.(jsx|tsx)$/ }),
    cesium(),
    stripCesiumFromMarketing(),
  ],
  css: {
    postcss: {
      plugins: [tailwindcss()],
    },
  },
  resolve: {
    alias: {
      '@crm':       resolve(__dirname, 'src/crm'),
      '@dashboard': resolve(__dirname, 'src/dashboard'),
    },
  },
  server: {
    port: 5275,
    strictPort: true,
    host: true,
    // Don't trigger a full page reload when the harvest pipeline rewrites
    // its derived JSON / GeoJSON. The refresh-harvest button drives a soft
    // re-fetch via `engineHost.refreshHarvestLayers()` so we want HMR to
    // stay quiet on these files.
    watch: {
      ignored: [
        '**/src/data/harvest/**',
        '**/harvest/eo-discover/**',
      ],
    },
    // Proxy /api/* to the local API server so React fetchers don't need a
    // separate origin in dev.
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:5180',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5274,
    strictPort: true,
    // `vite preview` does NOT inherit server.proxy — mirror it so the bundled
    // build can reach the local API (used for QA against the production bundle).
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:5180',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      // Explicit multi-page entries — vite's default single-entry build was
      // missing dashboard.html and the other top-level pages on some
      // environments, producing only 2 transformed modules. Listing them
      // here forces all pages to be discovered and built.
      input: {
        index:           resolve(__dirname, 'index.html'),
        access:          resolve(__dirname, 'access.html'),
        company:         resolve(__dirname, 'company.html'),
        contact:         resolve(__dirname, 'contact.html'),
        dashboard:       resolve(__dirname, 'dashboard.html'),
        'dashboard-react': resolve(__dirname, 'dashboard-react.html'),
        industries: resolve(__dirname, 'industries.html'),
        platform:   resolve(__dirname, 'platform.html'),
        solutions:  resolve(__dirname, 'solutions.html'),
        sales:      resolve(__dirname, 'sales.html'),
        pm:         resolve(__dirname, 'pm.html'),
        analytics:  resolve(__dirname, 'analytics.html'),
        tenants:    resolve(__dirname, 'tenants.html'),
        staff:      resolve(__dirname, 'staff.html'),
        operations: resolve(__dirname, 'operations.html'),
        report:     resolve(__dirname, 'report.html'),
        studio:     resolve(__dirname, 'studio.html'),
        customer:   resolve(__dirname, 'customer.html'),
        vendor:     resolve(__dirname, 'vendor.html'),
        login:      resolve(__dirname, 'login.html'),
        register:   resolve(__dirname, 'register.html'),
        field:      resolve(__dirname, 'field.html'),
      },
    },
  },
  optimizeDeps: {
    // Force pre-bundling so HMR doesn't choke on large CJS deps.
    include: [
      'maplibre-gl', '@deck.gl/core', '@deck.gl/layers', '@deck.gl/mapbox',
      'react', 'react-dom', 'react-dom/client', 'react-router-dom',
      '@tanstack/react-query', 'zustand', 'recharts', 'lucide-react',
    ],
    // Cesium is only loaded behind the lazy HD3D toggle; leave it out of
    // the pre-bundle so initial dev server startup stays fast.
    exclude: ['cesium'],
  },
});
