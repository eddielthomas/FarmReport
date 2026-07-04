// =============================================================================
// Per-role coach-mark tour configs.
// -----------------------------------------------------------------------------
// Each surface exports its tour id + steps. Targets reference data-coachmark
// attributes placed on the relevant DOM elements within that surface.
// =============================================================================

import type { CoachmarkStep } from '@crm/components/ui/coachmark';

export interface TourConfig {
  id: string;
  label: string;
  steps: CoachmarkStep[];
}

const CYAN    = 'var(--signal-cyan)';
const AMBER   = 'var(--signal-amber)';
const GREEN   = 'var(--signal-green)';
const BLUE    = 'var(--signal-blue)';
const MAGENTA = 'var(--signal-magenta)';

export const TOURS: Record<string, TourConfig> = {
  sales: {
    id: 'sales.v1',
    label: 'Sales walkthrough',
    steps: [
      { target: 'sales.kpis',     title: 'Your day in one glance', body: 'Info requests waiting, active leads, clients, and revenue. These tiles refresh whenever a lead moves.', accent: CYAN },
      { target: 'sales.next',     title: 'Where to start',         body: "When info requests are pending, this banner surfaces them. One click opens the oldest — start the day here.", accent: AMBER },
      { target: 'sales.pipeline', title: 'Your pipeline',           body: 'Three stages: Info Request → Lead → Client. Tap a card to open it; use the convert button to advance.', accent: BLUE },
      { target: 'sales.rail',     title: 'Lead detail',             body: 'The right rail shows everything about the selected lead — contact, status timeline, meetings, notes.', accent: GREEN },
    ],
  },
  pm: {
    id: 'pm.v1',
    label: 'Cases walkthrough',
    steps: [
      { target: 'pm.stale',    title: 'Stale cases first',  body: 'Cases blocked >7 days or assigned >14 days bubble up here. Clear these before opening new ones.', accent: 'var(--signal-red)' },
      { target: 'pm.board',    title: 'Case board',          body: 'Five status columns: Open, Assigned, In Progress, Blocked, Closed. Use the dropdown on each card to transition.', accent: CYAN },
      { target: 'pm.detail',   title: 'Case detail + assign',body: 'Pick the case, assign a team member, log activity. Signal IDs link back to the map.', accent: GREEN },
    ],
  },
  analytics: {
    id: 'analytics.v1',
    label: 'Analytics walkthrough',
    steps: [
      { target: 'analytics.kpis',  title: 'Six KPI tiles', body: 'Leads, info requests, clients, conversion %, open leads, profit. Hover for last-period delta.', accent: CYAN },
      { target: 'analytics.trend', title: 'Trend chart',    body: '12-month rolling leads vs. clients. The diverging curve tells you whether the pipeline is widening or compressing.', accent: BLUE },
      { target: 'analytics.income',title: 'Income period',  body: 'Switch week / month / quarter / year. Use this to spot seasonality and revenue spikes.', accent: GREEN },
    ],
  },
  operations: {
    id: 'operations.v1',
    label: 'Operations walkthrough',
    steps: [
      { target: 'ops.kpis',   title: 'Six-tile vitals',   body: 'Open cases, blocked, high priority, escalations, active teams, active leads. The whole org in one row.', accent: CYAN },
      { target: 'ops.board',  title: 'Compact case board',body: 'Live mirror of the case board, capped at 8 per column. Click any card to deep-link into Cases.', accent: BLUE },
      { target: 'ops.escal',  title: 'Recent escalations',body: 'Cases auto-created from map signals. These need eyes-on attention first.', accent: 'var(--signal-red)' },
      { target: 'ops.teams',  title: 'Team workload',     body: 'Who has what assigned. Use this when reassigning blockers.', accent: AMBER },
    ],
  },
  customer: {
    id: 'customer.v1',
    label: 'Portal walkthrough',
    steps: [
      { target: 'customer.timeline', title: 'Your project status',body: 'Each milestone lights up as we hit it. Tap a step for timestamp details.', accent: CYAN },
      { target: 'customer.map',      title: 'Your fields on the map',body: 'Real-time monitoring — crop-stress signals, your uploaded field data, and zones all in one view.', accent: BLUE },
      { target: 'customer.gis',      title: 'Upload your field data',body: "Drop in field boundaries, crop zones, soil maps, or any GeoJSON / Shapefile / KML / GeoTIFF. We overlay them on your farm map.", accent: MAGENTA },
      { target: 'customer.chat',     title: 'Talk to your analyst',body: 'Direct line to our team. Replies typically within the same business day.', accent: GREEN },
    ],
  },
  staff: {
    id: 'staff.v1',
    label: 'Staff admin walkthrough',
    steps: [
      { target: 'staff.tabs',  title: 'Users + Teams', body: 'Toggle between Users (single staff records) and Teams (functional groups).', accent: CYAN },
      { target: 'staff.users', title: 'User directory', body: 'Invite, deactivate, change roles. Every change is audited.', accent: BLUE },
      { target: 'staff.teams', title: 'Team rosters',   body: 'Add or remove members from a team. Team membership drives case assignment options.', accent: GREEN },
    ],
  },
  tenants: {
    id: 'tenants.v1',
    label: 'Tenants walkthrough',
    steps: [
      { target: 'tenants.list', title: 'Multi-tenant control plane', body: 'Every customer tenant you administer, with status badge + summary stats.', accent: CYAN },
      { target: 'tenants.card', title: 'Per-tenant deep dive',       body: 'Click a card to manage users, brand, and audit log for that tenant.', accent: BLUE },
    ],
  },
};
