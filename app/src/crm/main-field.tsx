// =============================================================================
// main-field.tsx — Vite entry for the Field PWA (S9B).
// -----------------------------------------------------------------------------
// Mounts <FieldApp /> at #root and registers the service worker on production
// builds (we skip in dev so the Vite HMR overlay isn't shadowed by stale cache).
//
// Surface mode: the inline boot script in field.html has already set
// data-surface=dark by default; useSurfaceMode() inside FieldApp keeps it in
// sync with localStorage so a user toggle persists.
// =============================================================================

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@crm/styles/tailwind.css';
import { FieldApp } from '@crm/pages/FieldApp';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <FieldApp />
    </QueryClientProvider>
  </StrictMode>,
);

// ---- Service worker (production only) --------------------------------------
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/field-sw.js').catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[field] service worker registration failed:', err?.message ?? err);
    });
  });
}
