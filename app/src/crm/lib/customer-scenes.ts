// =============================================================================
// customer-scenes.ts — Sprint 14C
// -----------------------------------------------------------------------------
// Helpers for the customer portal hero map.  Provides:
//   * `CustomerProject` / `CustomerScene` types — shape of the
//     /api/v1/customer/me/projects and …/:id/scenes responses
//   * `BRAND_BASEMAPS`           — the 10 S13 branded analytic basemaps
//                                  (mirrors dashboard.html BASEMAPS catalogue)
//   * `BRAND_GRADIENTS`          — 4-stop gradients for the scene-strip swatch
//   * `applyBrandStyle(map, id)` — switches MapLibre style + CSS canvas filter
//   * `applySarOverlay(el, on, opacity)` — toggles a procedural radar overlay
//   * `fetchMyProjects` / `fetchProjectScenes` — typed fetch wrappers
//
// Only depends on `maplibregl` + the design-kit token surface; no MapBox-only
// APIs are used so the helpers run anywhere the React shell does.
// =============================================================================

import type { CSSProperties } from 'react';
import maplibregl from 'maplibre-gl';
import { apiGet } from './api';
// Sprint A3 — pack-driven default scene set. The active vertical's seedScenes[]
// are build-time generated into solution-pack.generated.ts. The client read
// path below lets the saved-scene set seed from the pack instead of a
// hardcoded vertical-specific list.
import { GENERATED_CLIENT_PACK } from './solution-pack.generated';
import type { SolutionPackSeedScene } from './auth-store';

// ---- API shapes -----------------------------------------------------------

export type BrandBasemapId =
  | 'satellite' | 'hydrovision' | 'thermsight' | 'pressurepulse'
  | 'nightwatch' | 'echoscan' | 'coherencemap' | 'greenline'
  | 'deepgrid' | 'riskatlas';

export interface CustomerProject {
  id: string;
  tenant_id: string;
  title: string;
  description?: string | null;
  status?: string | null;
  source_lead_id?: string | null;
  customer_contact_id?: string | null;
  customer_organization_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface CustomerScene {
  id: string;
  project_id: string;
  title: string;
  description?: string | null;
  is_default: boolean;
  ordinal: number;
  center_lat: number;
  center_lon: number;
  zoom: number;
  pitch: number;
  bearing: number;
  basemap_id: BrandBasemapId;
  sar_overlay: boolean;
  sar_opacity: number;
  active_layers: string[];
  time_start?: string | null;
  time_end?: string | null;
  scan_ids?: string[];
  thumbnail_url?: string | null;
  created_at?: string;
}

// ---- Brand catalogue (S13 parity) ----------------------------------------
// Each entry mirrors the BASEMAPS table in dashboard.html so the customer
// portal applies the same look-and-feel as ops.  `tile` is the base raster
// source we mount; `filter` is a CSS `filter` chain applied to the MapLibre
// canvas to recolor it; `sar` requests the procedural radar overlay.

export interface BrandBasemapDef {
  id: BrandBasemapId;
  name: string;
  use: string;
  tile: 'satellite' | 'dark' | 'streets';
  filter: string;
  sar?: boolean;
}

export const BRAND_BASEMAPS: BrandBasemapDef[] = [
  { id: 'satellite',     name: 'Satellite',     use: 'True-color imagery — operational baseline',
    tile: 'satellite', filter: '' },
  { id: 'hydrovision',   name: 'MoistureMap',   use: 'Soil-moisture saturation pseudo-color — irrigation gaps and waterlogging pop',
    tile: 'satellite', filter: 'hue-rotate(200deg) saturate(2.2) brightness(0.85)' },
  { id: 'thermsight',    name: 'CropTherm',     use: 'Thermal infrared — canopy heat stress and frost-risk corridors',
    tile: 'satellite', filter: 'hue-rotate(330deg) saturate(2) contrast(1.3) brightness(0.75)' },
  { id: 'pressurepulse', name: 'StressPulse',   use: 'Crop-stress heatmap — green healthy · amber stress · red failure',
    tile: 'dark',      filter: 'hue-rotate(95deg) saturate(1.4) brightness(0.95)' },
  { id: 'nightwatch',    name: 'NightWatch',    use: 'Dark satellite with field infrastructure highlighting — night-ops shift',
    tile: 'dark',      filter: 'brightness(0.6) contrast(1.2)' },
  { id: 'echoscan',      name: 'EchoScan',      use: 'Sentinel-1 SAR backscatter baked in — soil-structure and field-moisture radar view',
    tile: 'satellite', filter: 'grayscale(1) contrast(1.8) brightness(0.7)', sar: true },
  { id: 'coherencemap',  name: 'CoherenceMap',  use: 'InSAR change-detection — tillage, harvest, and growth shifts between passes',
    tile: 'satellite', filter: 'hue-rotate(120deg) saturate(1.5) contrast(1.4)' },
  { id: 'greenline',     name: 'GreenLine',     use: 'NDVI vegetation index — crop vigor and canopy health',
    tile: 'satellite', filter: 'hue-rotate(60deg) saturate(2.5) brightness(0.95)' },
  { id: 'deepgrid',      name: 'DeepGrid',      use: 'Minimal-clutter streets — field-boundary drawing and route planning',
    tile: 'streets',   filter: '' },
  { id: 'riskatlas',     name: 'YieldAtlas',    use: 'Yield-risk heatmap fused over satellite — buyer briefing view',
    tile: 'satellite', filter: 'contrast(1.1) saturate(1.15)' },
];

// 4-stop gradients for the scene-strip brand swatches.  These are the same
// linear-gradient angles used by the .mcp-basemap-swatch.{brand} CSS rules in
// dashboard.html so the scene strip reads as a smaller version of the ops
// basemap picker.
export const BRAND_GRADIENTS: Record<BrandBasemapId, string> = {
  satellite:     'linear-gradient(45deg,#1f3a5a 0%,#3a6da8 35%,#7da8d8 70%,#cfe0f0 100%)',
  hydrovision:   'linear-gradient(45deg,#00fff5 0%,#00b3ff 35%,#0066ff 70%,#5500ff 100%)',
  thermsight:    'linear-gradient(45deg,#0a0820 0%,#5a1a40 30%,#ff3a3a 65%,#ffb840 100%)',
  pressurepulse: 'linear-gradient(45deg,#00b35a 0%,#a8c437 35%,#ffc040 65%,#ff3060 100%)',
  nightwatch:    'linear-gradient(45deg,#03060f 0%,#0a1a2c 35%,#1a3050 70%,#3a6090 100%)',
  echoscan:      'linear-gradient(45deg,#1a1a1a 0%,#4a4a4a 35%,#8a8a8a 70%,#dadada 100%)',
  coherencemap:  'linear-gradient(45deg,#1a002a 0%,#400060 30%,#0080a0 65%,#00d0c0 100%)',
  greenline:     'linear-gradient(45deg,#1a3010 0%,#5a8030 35%,#a8c040 70%,#e0f08a 100%)',
  deepgrid:      'linear-gradient(45deg,#1a1f2e 0%,#2c3654 35%,#4a5a7a 70%,#aab8d0 100%)',
  riskatlas:     'linear-gradient(45deg,#0a1030 0%,#4d9fff 25%,#ffc040 55%,#ff3a3a 100%)',
};

// ---- Tile-source style URLs ----------------------------------------------
// `satellite` → ESRI World Imagery (matches the existing CustomerDashboard
// ProjectMap baseline). `dark` and `streets` → CARTO tile sources because
// they ship a free no-key endpoint and read clean under our CSS filters.

function baseStyleFor(tile: BrandBasemapDef['tile']): maplibregl.StyleSpecification {
  if (tile === 'dark') {
    return {
      version: 8,
      sources: {
        base: {
          type: 'raster',
          tiles: [
            'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
            'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
            'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
          ],
          tileSize: 256,
          maxzoom: 19,
          attribution: '© CARTO · OpenStreetMap',
        },
      },
      layers: [{ id: 'base', type: 'raster', source: 'base' }],
    };
  }
  if (tile === 'streets') {
    return {
      version: 8,
      sources: {
        base: {
          type: 'raster',
          tiles: [
            'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
          ],
          tileSize: 256,
          maxzoom: 19,
          attribution: '© CARTO · OpenStreetMap',
        },
      },
      layers: [{ id: 'base', type: 'raster', source: 'base' }],
    };
  }
  // satellite (default)
  return {
    version: 8,
    sources: {
      base: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Imagery © Esri',
      },
    },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

// ---- applyBrandStyle ------------------------------------------------------
// Swaps the MapLibre base style to the brand's underlying raster source and
// installs a `.style.filter` on the live `.maplibregl-canvas` element.  The
// canvas filter is deferred two frames so MapLibre has time to mount the new
// canvas after a `setStyle()` swap.
//
// Side-effects:
//   * `map.setStyle(...)` — replaces the base layer
//   * `canvas.style.filter = ...`
//
// Returns the resolved brand def (handy for tests + the scene strip).
export function applyBrandStyle(
  map: maplibregl.Map,
  brandId: BrandBasemapId,
): BrandBasemapDef {
  const def = BRAND_BASEMAPS.find((b) => b.id === brandId) ?? BRAND_BASEMAPS[0];
  try {
    map.setStyle(baseStyleFor(def.tile));
  } catch (e) {
    console.warn('[customer-scenes] setStyle failed', brandId, e);
  }
  const pushFilter = () => {
    const container = map.getContainer();
    const canvases = container.querySelectorAll<HTMLCanvasElement>('.maplibregl-canvas');
    canvases.forEach((c) => {
      c.style.transition = 'filter .25s ease';
      c.style.filter = def.filter || '';
      if (def.filter) c.setAttribute('data-rwr-basemap-filter', '1');
      else c.removeAttribute('data-rwr-basemap-filter');
    });
  };
  // MapLibre needs a tick to remount the canvas after setStyle — push the
  // filter on the next frame AND once more at 400 ms in case the style swap
  // is still in flight (matches dashboard.html's S13 timing).
  requestAnimationFrame(pushFilter);
  setTimeout(pushFilter, 400);
  return def;
}

// ---- SAR overlay ----------------------------------------------------------
// Renders the procedurally-synthesised radar speckle texture from S13 over
// the map container.  The overlay is a child <div> the caller passes in;
// `applySarOverlay` toggles its visibility + opacity.  When `on` is false the
// overlay is hidden (display:none) so it cannot block pointer events.

export function applySarOverlay(
  el: HTMLDivElement | null,
  on: boolean,
  opacity: number,
): void {
  if (!el) return;
  el.style.display = on ? 'block' : 'none';
  const op = Math.max(0.1, Math.min(1, (opacity || 60) / 100));
  el.style.opacity = String(op);
}

/** CSS for the SAR overlay surface — applied inline so the helper has no
 *  external CSS dependency.  Matches the .rwr-sar-overlay rule in
 *  dashboard.html.  Returns a style object the caller spreads onto the div. */
export function sarOverlayStyle(): CSSProperties {
  return {
    position: 'absolute',
    inset: 0,
    zIndex: 8,
    pointerEvents: 'none',
    opacity: 0.6,
    mixBlendMode: 'multiply',
    display: 'none',
    backgroundColor: '#2a2a2a',
    backgroundImage: [
      'repeating-radial-gradient(circle at 13% 27%,rgba(255,255,255,0.18) 0,rgba(255,255,255,0.18) 0.4px,transparent 0.5px,transparent 2.3px)',
      'repeating-radial-gradient(circle at 47% 71%,rgba(0,0,0,0.32) 0,rgba(0,0,0,0.32) 0.5px,transparent 0.6px,transparent 1.9px)',
      'repeating-radial-gradient(circle at 83% 19%,rgba(255,255,255,0.12) 0,rgba(255,255,255,0.12) 0.3px,transparent 0.45px,transparent 2.6px)',
      'repeating-linear-gradient(37deg,rgba(255,255,255,0.04) 0,rgba(255,255,255,0.04) 0.5px,transparent 0.6px,transparent 4px)',
      'linear-gradient(180deg,#222 0%,#2c2c2c 100%)',
    ].join(','),
    backgroundSize: '7px 7px,9px 9px,11px 11px,40px 40px,100% 100%',
    filter: 'grayscale(1) contrast(1.6) brightness(0.85)',
  };
}

// ---- Fetch wrappers -------------------------------------------------------

export function fetchMyProjects(): Promise<CustomerProject[]> {
  return apiGet<CustomerProject[]>('/customer/me/projects').catch(() => [] as CustomerProject[]);
}

export function fetchProjectScenes(projectId: string): Promise<CustomerScene[]> {
  return apiGet<CustomerScene[]>(`/customer/me/projects/${encodeURIComponent(projectId)}/scenes`)
    .catch(() => [] as CustomerScene[]);
}

// ---- localStorage helpers -------------------------------------------------

const ACTIVE_KEY = 'rwr.customer.active-project';

export function getStoredActiveProject(): string | null {
  try { return window.localStorage.getItem(ACTIVE_KEY); }
  catch { return null; }
}
export function setStoredActiveProject(id: string | null) {
  try {
    if (id) window.localStorage.setItem(ACTIVE_KEY, id);
    else    window.localStorage.removeItem(ACTIVE_KEY);
  } catch {}
}

// ---- Pack-driven seed scenes (Sprint A3) ----------------------------------
// The active SolutionPack declares the default saved-scene set (seedScenes[]).
// `getPackSeedScenes()` returns it in the camelCase pack shape; `toSeedScene()`
// maps one pack scene into the snake_cased CustomerScene shape the portal +
// scene seeders consume (project_id/tenant ids are filled in by the caller).
// For the RWR pack these equal the 3 scenes in 152_demo_customer_seed.sql.

/** The active pack's declared seed scenes (camelCase, read-only). Empty array
 *  when the pack ships none. */
export function getPackSeedScenes(): ReadonlyArray<SolutionPackSeedScene> {
  const list = GENERATED_CLIENT_PACK.seedScenes;
  return Array.isArray(list) ? list : [];
}

/** Map a pack seed scene onto the CustomerScene shape (snake_case). The caller
 *  supplies `project_id` (and may override `id`); tenant scoping is the
 *  server's job. Defaults mirror the SQL seeder column defaults. */
export function toSeedScene(
  s: SolutionPackSeedScene,
  project_id: string,
  id = `${project_id}:${s.ordinal ?? 0}`,
): CustomerScene {
  return {
    id,
    project_id,
    title: s.title,
    description: s.description ?? null,
    is_default: s.isDefault ?? false,
    ordinal: s.ordinal ?? 0,
    center_lat: s.centerLat,
    center_lon: s.centerLon,
    zoom: s.zoom ?? 12,
    pitch: s.pitch ?? 0,
    bearing: s.bearing ?? 0,
    basemap_id: (s.basemapId as BrandBasemapId),
    sar_overlay: s.sarOverlay ?? false,
    sar_opacity: s.sarOpacity ?? 60,
    active_layers: s.activeLayers ? [...s.activeLayers] : [],
  };
}

// ---- Default-scene resolver ----------------------------------------------
// `is_default` true wins; otherwise the lowest ordinal.  Returns undefined
// when the scenes array is empty so callers can fall back to the legacy
// ProjectMap.

export function resolveDefaultScene(scenes: CustomerScene[]): CustomerScene | undefined {
  if (!scenes.length) return undefined;
  const def = scenes.find((s) => s.is_default);
  if (def) return def;
  return [...scenes].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))[0];
}
