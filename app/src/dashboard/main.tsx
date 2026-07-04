// =============================================================================
// dashboard/main.tsx — React entry for the ops map dashboard.
// -----------------------------------------------------------------------------
// Phase 1 of the dashboard React port. Mounts the shell (top nav, left / right
// drawers, status bar, map viewport, coach-mark tour) as React components that
// share the CRM design tokens. The vanilla MapLibre engine still lives inside
// `<MapViewport>` for now — we'll port detection feed / layer toggles over in
// phase 2.
// =============================================================================

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@crm/styles/tailwind.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import { DashboardShell } from './DashboardShell';

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});

const root = document.getElementById('dashboard-root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={qc}>
        <div className="crm">
          <DashboardShell />
        </div>
      </QueryClientProvider>
    </StrictMode>,
  );
}
