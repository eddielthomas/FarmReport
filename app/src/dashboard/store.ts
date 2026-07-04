// =============================================================================
// dashboard/store.ts — Zustand store for the React dashboard shell.
// -----------------------------------------------------------------------------
// Phase 1 covers UI state (drawer open/closed, bottom collapsed, current
// surface). Phase 2 will add layer toggles, current mission, detection feed.
// =============================================================================

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface LayerState {
  id: string;
  name: string;
  on: boolean;
  color: string;
  group: 'core' | 'customer';
}

interface DashboardState {
  leftDrawerOpen:  boolean;
  rightDrawerOpen: boolean;
  bottomCollapsed: boolean;
  activeTab: 'overview' | 'detections' | 'analytics' | 'assets' | 'reports' | 'settings';
  layers: LayerState[];

  setLeftDrawerOpen:  (v: boolean) => void;
  setRightDrawerOpen: (v: boolean) => void;
  setBottomCollapsed: (v: boolean) => void;
  setActiveTab: (t: DashboardState['activeTab']) => void;
  toggleLayer: (id: string) => void;
  setLayers:   (ls: LayerState[]) => void;
}

const DEFAULT_LAYERS: LayerState[] = [
  { id: 'sar',           name: 'SAR Imagery',       on: true,  color: '#00d4ff', group: 'core' },
  { id: 'leaks',         name: 'Detected Leaks',    on: true,  color: '#ff4060', group: 'core' },
  { id: 'assets',        name: 'Network Assets',    on: false, color: '#4d9fff', group: 'core' },
  { id: 'weather',       name: 'Weather Overlay',   on: false, color: '#a855f7', group: 'core' },
];

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set) => ({
      leftDrawerOpen:  false,
      rightDrawerOpen: false,
      bottomCollapsed: false,
      activeTab: 'overview',
      layers: DEFAULT_LAYERS,
      setLeftDrawerOpen:  (v) => set({ leftDrawerOpen:  v }),
      setRightDrawerOpen: (v) => set({ rightDrawerOpen: v }),
      setBottomCollapsed: (v) => set({ bottomCollapsed: v }),
      setActiveTab: (t) => set({ activeTab: t }),
      toggleLayer: (id) =>
        set((s) => ({ layers: s.layers.map((l) => (l.id === id ? { ...l, on: !l.on } : l)) })),
      setLayers: (ls) => set({ layers: ls }),
    }),
    {
      name: 'rwr.dashboard.v1',
      partialize: (s) => ({ bottomCollapsed: s.bottomCollapsed, activeTab: s.activeTab }),
    },
  ),
);
