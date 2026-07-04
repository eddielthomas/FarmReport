// =============================================================================
// Surface mode store (S7A)
// -----------------------------------------------------------------------------
// Tracks the per-user surface mode (`light` | `dark`) and mirrors it to
// `<html data-surface="…">` so the CSS token cascade in `theme/tokens.css`
// resolves correctly. Persisted to localStorage under `rwr.surface-mode`.
//
// Default = `light`, matching the Sales Dashboard concept boards.
//
// Usage:
//   const { mode, toggle, setMode } = useSurfaceMode();
// =============================================================================

import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SurfaceMode } from '@crm/theme/tokens.types';

export const SURFACE_STORAGE_KEY = 'rwr.surface-mode';
const SURFACE_ATTR = 'data-surface';

interface SurfaceState {
  mode: SurfaceMode;
  setMode: (mode: SurfaceMode) => void;
  toggle: () => void;
}

export const useSurfaceStore = create<SurfaceState>()(
  persist(
    (set, get) => ({
      mode: 'light',
      setMode: (mode) => set({ mode }),
      toggle: () => set({ mode: get().mode === 'light' ? 'dark' : 'light' }),
    }),
    {
      name: SURFACE_STORAGE_KEY,
      storage: {
        getItem: (name) => {
          if (typeof window === 'undefined') return null;
          const raw = window.localStorage.getItem(name);
          return raw ? JSON.parse(raw) : null;
        },
        setItem: (name, value) => {
          if (typeof window === 'undefined') return;
          window.localStorage.setItem(name, JSON.stringify(value));
        },
        removeItem: (name) => {
          if (typeof window === 'undefined') return;
          window.localStorage.removeItem(name);
        },
      },
    },
  ),
);

/**
 * `useSurfaceMode` — read + mutate the active surface mode. Side-effect: when
 * called, it syncs `<html data-surface>` so global CSS selectors pick up the
 * change before children render.
 */
export function useSurfaceMode() {
  const mode    = useSurfaceStore((s) => s.mode);
  const setMode = useSurfaceStore((s) => s.setMode);
  const toggle  = useSurfaceStore((s) => s.toggle);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute(SURFACE_ATTR, mode);
    // Mirror onto every `.crm` wrapper too — CSS selectors are written for
    // both placements so either is enough, but we want to be defensive.
    document.querySelectorAll('.crm').forEach((el) => el.setAttribute(SURFACE_ATTR, mode));
  }, [mode]);

  return { mode, setMode, toggle };
}

/**
 * Synchronous helper for non-React entry-points (e.g. inline `<script>` tags
 * in the HTML head that need to set the attribute before the first paint to
 * avoid a flash of the wrong mode).
 */
export function applySurfaceModeFromStorage(): SurfaceMode {
  if (typeof document === 'undefined' || typeof window === 'undefined') return 'light';
  try {
    const raw = window.localStorage.getItem(SURFACE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const mode: SurfaceMode = parsed?.state?.mode === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute(SURFACE_ATTR, mode);
    return mode;
  } catch {
    document.documentElement.setAttribute(SURFACE_ATTR, 'light');
    return 'light';
  }
}
