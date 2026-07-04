// =============================================================================
// DashboardShell — top-level layout for the ops map dashboard.
// -----------------------------------------------------------------------------
// Grid: 36px topnav · main viewport · 180px bottom (collapsible) · 20px status
// Sidebars are 215px / 235px on desktop, slide-out drawers ≤900px.
// =============================================================================

import { useEffect, useState } from 'react';
import { Menu, ChevronDown, Bell, Settings, User, Radio, Wifi } from 'lucide-react';
import { CoachmarkTour } from '@crm/components/ui/coachmark';
import type { CoachmarkStep } from '@crm/components/ui/coachmark';
import { MapViewport } from './panels/MapViewport';
import { LeftPanel }   from './panels/LeftPanel';
import { RightPanel }  from './panels/RightPanel';
import { BottomPanel } from './panels/BottomPanel';
import { StatusBar }   from './panels/StatusBar';
import { TopNav }      from './panels/TopNav';
import { useDashboardStore } from './store';

const DASHBOARD_TOUR_STEPS: CoachmarkStep[] = [
  { target: 'dash.topnav',  title: 'Mission control top bar',   body: 'Tenant, surface, alerts, user — every cross-surface jump lives here.', accent: 'var(--signal-cyan)' },
  { target: 'dash.left',    title: 'Mission + layers',          body: 'Toggle data layers (SAR, leaks, customer GIS overlays) and switch missions. On mobile, swipe in from the left edge.', accent: 'var(--signal-blue)' },
  { target: 'dash.map',     title: 'Live operational map',      body: 'Pan, zoom, click detections. Customer-uploaded pipes / electrical / blueprints render here.', accent: 'var(--signal-green)' },
  { target: 'dash.right',   title: 'Detection feed + intel',    body: 'Real-time alerts, asset metadata, AI summaries. Click any item to fly the camera there.', accent: 'var(--signal-amber)' },
  { target: 'dash.bottom',  title: 'Time + telemetry',          body: 'Scrub the timeline, watch weather, system intelligence. Collapse with the chevron when you need space.', accent: 'var(--signal-magenta)' },
];

export function DashboardShell() {
  const leftOpen   = useDashboardStore((s) => s.leftDrawerOpen);
  const rightOpen  = useDashboardStore((s) => s.rightDrawerOpen);
  const bottomCol  = useDashboardStore((s) => s.bottomCollapsed);
  const setLeft    = useDashboardStore((s) => s.setLeftDrawerOpen);
  const setRight   = useDashboardStore((s) => s.setRightDrawerOpen);

  // Auto-close drawers when crossing back to desktop width.
  useEffect(() => {
    function onResize() {
      if (window.innerWidth > 900) { setLeft(false); setRight(false); }
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setLeft, setRight]);

  return (
    <div
      className={`grid w-screen h-screen overflow-hidden bg-[var(--rwr-bg)] text-[var(--rwr-t1)]`}
      style={{
        gridTemplateRows:    bottomCol ? '36px 1fr 26px 20px' : '36px 1fr 180px 20px',
        gridTemplateColumns: '215px 1fr 235px',
      }}
    >
      <TopNav />
      <LeftPanel  open={leftOpen}  onClose={() => setLeft(false)} />
      <MapViewport />
      <RightPanel open={rightOpen} onClose={() => setRight(false)} />
      <BottomPanel />
      <StatusBar />

      {(leftOpen || rightOpen) && (
        <div
          className="fixed inset-x-0 z-[150] bg-black/55 backdrop-blur-sm lg:hidden"
          style={{ top: 44, bottom: 20 }}
          onClick={() => { setLeft(false); setRight(false); }}
        />
      )}

      <CoachmarkTour tourId="dashboard.v1" steps={DASHBOARD_TOUR_STEPS} />

      {/* Mobile drawer breakpoint — applied via inline style on the grid */}
      <style>{`
        @media (max-width: 1400px) { .dashboard-app { grid-template-columns: 190px 1fr 215px; } }
        @media (max-width: 1180px) { .dashboard-app { grid-template-columns: 170px 1fr 195px; } }
        @media (max-width: 1024px) { .dashboard-app { grid-template-columns: 150px 1fr 180px; } }
        @media (max-width: 900px) {
          .dashboard-app { grid-template-columns: 1fr !important; grid-template-rows: 44px 1fr 20px !important; }
          .dashboard-app .bottom-panel { display: none; }
        }
      `}</style>
    </div>
  );
}
