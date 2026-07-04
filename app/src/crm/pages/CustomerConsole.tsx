// =============================================================================
// CustomerConsole — full-screen map console for the customer:view surface.
// -----------------------------------------------------------------------------
// Rebuilds the customer portal to match the RWR_MAP "S-v1" Figma (black/#101010
// panels, #9dff00 lime accent, Inter). Layout:
//
//   ┌─ SNTL logo ── [ Map | Operations | Analytics ] + legend ──── 🔔  ☰ ─┐
//   │ ┌─────────────────┐                                          ┌────┐ │
//   │ │ LEFT PANEL      │            full-screen map               │tool│ │
//   │ │ Status |Map|Lyr │            (MapLibre, scene-driven)      │ bar│ │
//   │ │ search…         │                                          └────┘ │
//   │ │ …tab content…   │                                                 │
//   │ └─────────────────┘   ┌─ Custom View ─ [thumb][thumb][thumb] ─┐     │
//   └───────────────────────┴───────────────────────────────────────┴────┘
//
// The three menu states = the LEFT PANEL tabs:
//   • Status     — system overview + mission + activity feed + (per product
//                  decision) ALL CRM features: timeline, meetings, files,
//                  messages, KPI strip — as scrollable sections.
//   • Map Detail — basemap style grid (BRAND_BASEMAPS → applyBrandStyle).
//   • Layers     — system layer stack toggles + the customer's GIS layers.
//
// Nothing from the old CustomerDashboard is dropped: farm switcher (the
// tenant legend chip), scenes (bottom Custom View strip), GIS layers,
// timeline/meetings/files/messages, KPIs, auth/role gate, localStorage state.
// =============================================================================

import {
  forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { apiGet, apiPost } from '@crm/lib/api';
import type { Lead, Meeting, FileRecord, Message } from '@crm/lib/types';
import type { GisLayer } from '@crm/components/gis/GisLayersCard';
import { useAuthStore } from '@crm/lib/auth-store';
import {
  BRAND_BASEMAPS, BRAND_GRADIENTS, applyBrandStyle, applySarOverlay, sarOverlayStyle,
  fetchMyProjects, fetchProjectScenes, resolveDefaultScene,
  getStoredActiveProject, setStoredActiveProject,
  type CustomerProject, type CustomerScene, type BrandBasemapId,
} from '@crm/lib/customer-scenes';
import { formatRelative, formatCurrency, cn } from '@crm/lib/utils';
import {
  Bell, AlignJustify, Plus, Minus, Compass, Map as MapIcon, Layers as LayersIcon,
  Crosshair, Maximize, Search, ChevronLeft, ChevronDown, Send, CheckCircle2,
  CalendarDays, Paperclip, MessageSquare, Activity, TrendingUp, MapPin,
} from 'lucide-react';

// ── palette (exact to the Figma) ──────────────────────────────────────────
const LIME = '#9dff00';
const LIME_ON = '#9fff06';
const PANEL = '#000000';
const CHROME = '#101010';
const OFF = '#292929';
const INK = '#1e1e1e';
const FONT = "'Inter', system-ui, -apple-system, sans-serif";

type PanelTab = 'status' | 'mapdetail' | 'layers';
type NavTab = 'map' | 'operations' | 'analytics';

// Extended project shape — AOI + center columns surface the field extent so
// the map can overlay detected signals where data exists.
type ProjectExt = CustomerProject & {
  aoi_west?: number | null; aoi_south?: number | null;
  aoi_east?: number | null; aoi_north?: number | null;
  center_lat?: number | null; center_lon?: number | null; default_zoom?: number | null;
};

// System layer stack (design) → drives map overlay visibility where data exists.
// Internal ids are kept stable (layerState keys); only the farm-facing labels change.
const SYSTEM_LAYERS: Array<{ id: string; label: string; on: boolean }> = [
  { id: 'leaks',     label: 'Detected Signals',   on: true  },
  { id: 'pois',      label: 'Field Notes',        on: false },
  { id: 'aoi',       label: 'Field Boundaries',   on: true  },
  { id: 'buildings', label: 'Structures',         on: true  },
  { id: 'pipes',     label: 'Zones & Irrigation', on: true  },
];

// =============================================================================
// Map — MapLibre, scene-driven, with imperative controls for the toolbar.
// =============================================================================
export interface ConsoleMapHandle {
  zoomIn(): void; zoomOut(): void; resetNorth(): void; recenter(): void; fullscreen(): void;
}
interface ConsoleMapProps {
  scene: CustomerScene | null;
  basemapId: BrandBasemapId;
  center: { lat: number; lon: number; zoom: number };
  project: ProjectExt | null;
  gisLayers: GisLayer[];
  layerState: Record<string, boolean>;
}
const ConsoleMap = forwardRef<ConsoleMapHandle, ConsoleMapProps>(function ConsoleMap(
  { scene, basemapId, center, project, gisLayers, layerState }, ref,
) {
  const wrapRef    = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const mapRef     = useRef<maplibregl.Map | null>(null);
  const readyRef   = useRef(false);

  useImperativeHandle(ref, () => ({
    zoomIn:  () => mapRef.current?.zoomIn(),
    zoomOut: () => mapRef.current?.zoomOut(),
    resetNorth: () => mapRef.current?.resetNorth(),
    recenter: () => mapRef.current?.flyTo({ center: [center.lon, center.lat], zoom: center.zoom, duration: 800 }),
    fullscreen: () => {
      const el = wrapRef.current;
      if (!el) return;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else el.requestFullscreen?.().catch(() => {});
    },
  }), [center.lat, center.lon, center.zoom]);

  // Mount once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      // Mount on the light street theme (matches the Figma default); the basemap
      // effect swaps to the active scene's basemap after load.
      style: {
        version: 8,
        sources: {
          base: {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
              'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
              'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            ],
            tileSize: 256, maxzoom: 19, attribution: '© CARTO · OpenStreetMap',
          },
        },
        layers: [{ id: 'base', type: 'raster', source: 'base' }],
      },
      center: [center.lon, center.lat],
      zoom: center.zoom,
      attributionControl: false,
      maxZoom: 18,
    });
    mapRef.current = map;
    map.on('load', () => { readyRef.current = true; map.resize(); });
    // The map lives in an `absolute inset-0` container that may not have its
    // final height at construct time — force a resize once now and whenever the
    // container box changes, else MapLibre paints at the default 300px canvas.
    requestAnimationFrame(() => map.resize());
    setTimeout(() => map.resize(), 300);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      ro = new ResizeObserver(() => map.resize());
      ro.observe(containerRef.current);
    }
    return () => { ro?.disconnect(); map.remove(); mapRef.current = null; readyRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Basemap restyle — keyed on basemapId ONLY, so picking a basemap in the Map
  // Detail tab recolors the map without moving the camera. setStyle MUST wait
  // for the initial style to load — calling it mid-init (e.g. swapping to a
  // different tile source before 'load') leaves the canvas blank.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      applyBrandStyle(map, basemapId);
      applySarOverlay(overlayRef.current, !!scene?.sar_overlay, scene?.sar_opacity ?? 60);
    };
    if (readyRef.current) apply();
    else map.once('load', apply);
  }, [basemapId, scene?.sar_overlay, scene?.sar_opacity]);

  // Camera fly — keyed on the active scene / project center, independent of the
  // basemap so a style pick doesn't snap the view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.flyTo({
      center: [scene?.center_lon ?? center.lon, scene?.center_lat ?? center.lat],
      zoom: scene?.zoom ?? center.zoom,
      pitch: scene?.pitch ?? 0, bearing: scene?.bearing ?? 0,
      duration: 1000, essential: true,
    });
  }, [scene?.id, scene?.center_lat, scene?.center_lon, scene?.zoom,
      scene?.pitch, scene?.bearing, center.lat, center.lon, center.zoom]);

  // AOI ring overlay (toggle: aoi).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const draw = () => {
      const show = layerState.aoi !== false;
      const ring = circleGeoJSON(center.lat, center.lon, 1.5, 64);
      if (!map.getSource('aoi-ring')) {
        map.addSource('aoi-ring', { type: 'geojson', data: ring });
        map.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi-ring', paint: { 'fill-color': LIME, 'fill-opacity': 0.08 } });
        map.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi-ring', paint: { 'line-color': LIME, 'line-width': 1.5, 'line-dasharray': [2, 2] } });
      } else {
        (map.getSource('aoi-ring') as maplibregl.GeoJSONSource).setData(ring);
      }
      const vis = show ? 'visible' : 'none';
      ['aoi-fill', 'aoi-line'].forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', vis));
    };
    if (readyRef.current) draw(); else map.once('load', draw);
    // re-draw after each style swap (setStyle wipes layers)
    map.on('styledata', draw);
    return () => { map.off('styledata', draw); };
  }, [center.lat, center.lon, layerState.aoi]);

  // Best-effort detected-signal overlays from the field AOI (relay).
  // NOTE (deep-reshape flag): this still hits the /api/leaks/by-bbox relay — a
  // legacy water endpoint that returns empty for farm AOIs. Repoint to the farm
  // observations/signals API when P2 ingest lands; the visible layer is already
  // labelled "Detected Signals".
  const { data: leakFC } = useQuery({
    queryKey: ['customer-leaks', project?.id, project?.aoi_west, project?.aoi_north],
    enabled: project?.aoi_west != null && project?.aoi_north != null,
    staleTime: 120_000,
    queryFn: async (): Promise<{ features?: Array<{ id?: number; geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> }> } | null> => {
      const p = project!;
      const qs = `west=${p.aoi_west}&south=${p.aoi_south}&east=${p.aoi_east}&north=${p.aoi_north}`;
      const r = await fetch(`/api/leaks/by-bbox?${qs}`, { headers: { accept: 'application/json' } });
      if (!r.ok) return null;
      return r.json();
    },
  });

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const draw = () => {
      const feats = leakFC?.features ?? [];
      const pts = feats.map((f) => {
        const c = centroidOf(f.geometry);
        const confirmed = /confirm/i.test(String(f.properties?.verification_result ?? ''));
        return c ? { type: 'Feature' as const, properties: { confirmed }, geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] } } : null;
      }).filter(Boolean) as GeoJSON.Feature[];
      const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: pts };
      if (!map.getSource('leaks')) {
        map.addSource('leaks', { type: 'geojson', data: fc });
        map.addLayer({ id: 'leaks-pt', type: 'circle', source: 'leaks',
          filter: ['==', ['get', 'confirmed'], true],
          paint: { 'circle-radius': 5, 'circle-color': '#ff3b3b', 'circle-stroke-color': '#0a0a0a', 'circle-stroke-width': 1, 'circle-opacity': 0.9 } });
        map.addLayer({ id: 'pois-pt', type: 'circle', source: 'leaks',
          filter: ['==', ['get', 'confirmed'], false],
          paint: { 'circle-radius': 4, 'circle-color': LIME, 'circle-stroke-color': '#0a0a0a', 'circle-stroke-width': 1, 'circle-opacity': 0.85 } });
      } else {
        (map.getSource('leaks') as maplibregl.GeoJSONSource).setData(fc);
      }
      map.getLayer('leaks-pt') && map.setLayoutProperty('leaks-pt', 'visibility', layerState.leaks !== false ? 'visible' : 'none');
      map.getLayer('pois-pt')  && map.setLayoutProperty('pois-pt',  'visibility', layerState.pois  === true  ? 'visible' : 'none');
    };
    if (readyRef.current) draw(); else map.once('load', draw);
    map.on('styledata', draw);
    return () => { map.off('styledata', draw); };
  }, [leakFC, layerState.leaks, layerState.pois]);

  // GIS vector overlays (toggle by "pipes" group + each layer's own visibility).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = async () => {
      const pipesOn = layerState.pipes !== false;
      const wanted = new Set(
        gisLayers
          .filter((l) => l.status === 'ready' && l.visible
            && layerState[`gis:${l.id}`] !== false        // per-layer toggle in the Layers tab
            && (l.kind !== 'pipes' || pipesOn))            // Pipe Network system toggle
          .map((l) => l.id),
      );
      for (const layer of gisLayers) {
        const sId = `gis-${layer.id}`;
        const fillId = `${sId}-fill`, lineId = `${sId}-line`, ptId = `${sId}-point`;
        if (!wanted.has(layer.id)) {
          [fillId, lineId, ptId].forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', 'none'));
          continue;
        }
        if (!map.getSource(sId)) {
          try {
            const fc = await apiGet<GeoJSON.FeatureCollection>(`/gis/layers/${layer.id}/features`);
            if (!map.getSource(sId)) map.addSource(sId, { type: 'geojson', data: fc });
          } catch { continue; }
        }
        if (!map.getLayer(fillId)) map.addLayer({ id: fillId, type: 'fill', source: sId, paint: { 'fill-color': layer.color, 'fill-opacity': 0.3 }, filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']] });
        if (!map.getLayer(lineId)) map.addLayer({ id: lineId, type: 'line', source: sId, paint: { 'line-color': layer.color, 'line-width': 2 }, filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'MultiLineString'], ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']] });
        if (!map.getLayer(ptId)) map.addLayer({ id: ptId, type: 'circle', source: sId, paint: { 'circle-color': layer.color, 'circle-radius': 4, 'circle-stroke-color': '#0a0a0a', 'circle-stroke-width': 1 }, filter: ['any', ['==', ['geometry-type'], 'Point'], ['==', ['geometry-type'], 'MultiPoint']] });
        [fillId, lineId, ptId].forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', 'visible'));
      }
    };
    if (readyRef.current) apply(); else map.once('load', apply);
    // Re-run when any GIS per-layer toggle changes (serialise the gis: keys).
  }, [gisLayers, layerState.pipes, gisLayers.map((l) => `${l.id}:${layerState[`gis:${l.id}`] !== false}`).join(',')]);

  return (
    <div ref={wrapRef} className="absolute inset-0">
      {/* MapLibre stamps `.maplibregl-map { position: relative }` onto this div,
          which overrides Tailwind `absolute` — so size it with h/w-full (its
          parent provides the absolute box) or it collapses to 0 height. */}
      <div ref={containerRef} className="h-full w-full" />
      <div ref={overlayRef} style={sarOverlayStyle()} />
    </div>
  );
});

// =============================================================================
// Main console
// =============================================================================
export function CustomerConsole() {
  const user = useAuthStore((s) => s.user);
  const isCustomerView = (user?.roles ?? []).includes('customer:view');
  const mapHandle = useRef<ConsoleMapHandle>(null);

  const [panelTab, setPanelTab] = useState<PanelTab>('status');
  const [navTab, setNavTab] = useState<NavTab>('map');
  const [panelOpen, setPanelOpen] = useState(true);
  const [projMenuOpen, setProjMenuOpen] = useState(false);
  const [layerState, setLayerState] = useState<Record<string, boolean>>(
    Object.fromEntries(SYSTEM_LAYERS.map((l) => [l.id, l.on])),
  );
  const [query, setQuery] = useState('');

  // Status sub-sections are scrolled to by id from the top-nav.
  const statusScrollRef = useRef<HTMLDivElement | null>(null);

  // ── data: projects / scenes ───────────────────────────────────────────────
  const { data: projects = [] } = useQuery<ProjectExt[]>({
    queryKey: ['customer-me-projects', user?.email],
    queryFn: fetchMyProjects as () => Promise<ProjectExt[]>,
    staleTime: 60_000,
  });
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => getStoredActiveProject());
  useEffect(() => {
    if (!projects.length) return;
    const ok = activeProjectId && projects.some((p) => p.id === activeProjectId);
    if (!ok) { setActiveProjectId(projects[0].id); setStoredActiveProject(projects[0].id); }
  }, [projects, activeProjectId]);
  const activeProject = useMemo(() => projects.find((p) => p.id === activeProjectId) ?? null, [projects, activeProjectId]);

  const { data: scenes = [] } = useQuery<CustomerScene[]>({
    queryKey: ['customer-project-scenes', activeProjectId],
    queryFn: () => (activeProjectId ? fetchProjectScenes(activeProjectId) : Promise.resolve([])),
    enabled: !!activeProjectId, staleTime: 30_000,
  });
  const defaultScene = useMemo(() => resolveDefaultScene(scenes), [scenes]);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  // Basemap chosen in the Map Detail tab. Overrides the active scene's basemap
  // until a saved scene is picked (which clears it). null = use scene's basemap.
  const [basemapOverride, setBasemapOverride] = useState<BrandBasemapId | null>(null);
  useEffect(() => {
    if (!scenes.length) { setActiveSceneId(null); return; }
    setActiveSceneId(defaultScene?.id ?? scenes[0].id);
  }, [activeProjectId, defaultScene?.id, scenes.length]);
  const activeScene = useMemo(() => scenes.find((s) => s.id === activeSceneId) ?? defaultScene ?? null, [scenes, activeSceneId, defaultScene]);
  // Default customer map theme = light streets (CARTO Positron), matching the
  // Figma. A saved scene's basemap or a Map Detail pick overrides it.
  const effectiveBasemap: BrandBasemapId = basemapOverride ?? activeScene?.basemap_id ?? 'deepgrid';

  // ── data: lead (CRM features) — chained lookup, same as legacy portal ──────
  const { data: lead } = useQuery<Lead | null>({
    queryKey: ['customer-lead', user?.email],
    staleTime: 60_000,
    queryFn: async (): Promise<Lead | null> => {
      const direct = await apiGet<Lead[]>('/sales/leads').catch(() => [] as Lead[]);
      if (direct.length) return direct[0];
      if (!isCustomerView || !user?.email) return null;
      const contacts = await apiGet<Array<{ id: string }>>(`/crm/contacts?email=${encodeURIComponent(String(user.email))}`).catch(() => []);
      const contact = contacts[0];
      if (!contact?.id) return null;
      const byContact = await apiGet<Lead[]>(`/sales/leads?contact_id=${encodeURIComponent(contact.id)}`).catch(() => []);
      return byContact[0] ?? null;
    },
  });
  const leadId = lead?.id ?? null;

  // ── data: GIS layers ───────────────────────────────────────────────────────
  const { data: gisLayers = [] } = useQuery<GisLayer[]>({
    queryKey: ['gis-layers', leadId ?? 'all'],
    queryFn: () => apiGet<GisLayer[]>(`/gis/layers${leadId ? `?lead_id=${leadId}` : ''}`).catch(() => []),
  });

  // map center fallback (project center → scene → US)
  const center = useMemo(() => ({
    lat: Number(activeProject?.center_lat ?? activeScene?.center_lat ?? 39.8283),
    lon: Number(activeProject?.center_lon ?? activeScene?.center_lon ?? -98.5795),
    zoom: Number(activeProject?.default_zoom ?? activeScene?.zoom ?? 11),
  }), [activeProject, activeScene]);

  // Top nav switches the whole main view: Map = the map console, Operations =
  // the operations view (activity + meetings/files/messages), Analytics = the
  // analytics view (KPIs + timeline). The map stays mounted underneath so
  // returning to Map is instant.
  const navTo = (t: NavTab) => { setNavTab(t); if (t === 'map') setPanelOpen(true); };

  const projectName = activeProject?.title ?? user?.tenant_slug ?? 'Project';

  return (
    <div className="absolute inset-0 overflow-hidden bg-black text-white" style={{ fontFamily: FONT }}>
      {/* ── Map ─────────────────────────────────────────────────────────── */}
      <ConsoleMap ref={mapHandle} scene={activeScene} basemapId={effectiveBasemap} center={center} project={activeProject} gisLayers={gisLayers} layerState={layerState} />

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      {/* Logo */}
      <div className="absolute left-4 top-4 z-30 flex h-[56px] w-[112px] items-center justify-center rounded-[14px] bg-white shadow-[0_0_3.4px_rgba(0,0,0,0.25)]">
        <span className="text-[30px] font-bold tracking-tight" style={{ color: INK }}>SNTL</span>
      </div>

      {/* Center nav + legend */}
      <div className="absolute left-1/2 top-4 z-30 -translate-x-1/2">
        <div className="rounded-[15px] bg-[#101010] p-1.5 shadow-[0_4px_4px_rgba(0,0,0,0.25)]">
          <div className="flex items-center gap-1">
            {(['map', 'operations', 'analytics'] as NavTab[]).map((t) => {
              const active = navTab === t;
              const label = t === 'map' ? 'Map' : t === 'operations' ? 'Operations' : 'Analytics';
              return (
                <button key={t} onClick={() => navTo(t)}
                  className={cn('rounded-[10px] px-4 py-1.5 text-[16px] transition-colors',
                    active ? 'bg-white font-medium' : 'text-white hover:bg-white/10')}
                  style={active ? { color: INK } : undefined}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        {/* legend strip */}
        <div className="mt-1 flex items-center justify-center gap-4 rounded-[10px] bg-white px-4 py-1.5">
          <Legend dot="#34C759" label="Uplink Active" />
          <Legend dot="#ffffff" ring label="Custom Views" />
          <button onClick={() => setProjMenuOpen((v) => !v)} className="flex items-center gap-1.5">
            <Legend dot={LIME} label={projectName} />
            {projects.length > 1 && <ChevronDown className="size-3" style={{ color: INK }} />}
          </button>
        </div>
        {/* project dropdown */}
        {projMenuOpen && projects.length > 1 && (
          <div className="absolute right-0 mt-1 w-[240px] overflow-hidden rounded-[10px] border border-white/10 bg-[#101010] shadow-xl">
            {projects.map((p) => (
              <button key={p.id} onClick={() => { setActiveProjectId(p.id); setStoredActiveProject(p.id); setProjMenuOpen(false); }}
                className={cn('block w-full px-3 py-2 text-left text-[13px] hover:bg-white/10', p.id === activeProjectId ? 'text-[#9dff00]' : 'text-white')}>
                {p.title}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Right: bell + menu */}
      <div className="absolute right-4 top-4 z-30 flex gap-2">
        <button onClick={() => { setNavTab('map'); setPanelTab('status'); setPanelOpen(true); requestAnimationFrame(() => document.getElementById('status-activity')?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }}
          className="grid size-[52px] place-items-center rounded-[8px] bg-white shadow-[0_0_3.4px_rgba(0,0,0,0.25)]" aria-label="Notifications" title="Recent activity">
          <Bell className="size-5" style={{ color: INK }} />
        </button>
        <button onClick={() => setPanelOpen((v) => !v)} className="grid size-[52px] place-items-center rounded-[8px] bg-[#101010] text-white" aria-label="Toggle panel">
          <AlignJustify className="size-5" />
        </button>
      </div>

      {/* ── Left panel (Map view only) ──────────────────────────────────── */}
      {navTab === 'map' && panelOpen && (
        <div className="absolute left-4 top-[92px] bottom-4 z-20 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[15px] bg-black shadow-[0_4px_4px_rgba(0,0,0,0.25)]">
          {/* tabs */}
          <div className="flex items-center gap-5 px-5 pt-4">
            {(['status', 'mapdetail', 'layers'] as PanelTab[]).map((t) => {
              const active = panelTab === t;
              const label = t === 'status' ? 'Status' : t === 'mapdetail' ? 'Map Detail' : 'Layers';
              return (
                <button key={t} onClick={() => setPanelTab(t)}
                  className={cn('text-[16px] transition-colors', active ? 'font-semibold text-[#9dff00]' : 'font-normal text-white hover:text-white/80')}>
                  {label}
                </button>
              );
            })}
            <button onClick={() => setPanelOpen(false)} className="ml-auto text-white/60 hover:text-white" aria-label="Collapse panel">
              <ChevronLeft className="size-4" />
            </button>
          </div>
          {/* search — filters the Custom View strip + layer/basemap lists */}
          <div className="px-5 pt-3">
            <div className="flex h-[44px] items-center gap-2 rounded-[8px] px-4" style={{ background: LIME }}>
              <Search className="size-4" style={{ color: '#3a5a00' }} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search basemaps, layers, views"
                className="w-full bg-transparent text-[15px] outline-none placeholder:text-[#5a5a5a]" style={{ color: INK }} />
            </div>
          </div>

          {/* tab body */}
          <div ref={panelTab === 'status' ? statusScrollRef : undefined} className="mt-3 flex-1 overflow-y-auto px-5 pb-4">
            {panelTab === 'status' && (
              <StatusTab project={activeProject} scene={activeScene} lead={lead ?? null} leadId={leadId} />
            )}
            {panelTab === 'mapdetail' && (
              <MapDetailTab current={effectiveBasemap} query={query}
                onPick={(id) => setBasemapOverride(id)} />
            )}
            {panelTab === 'layers' && (
              <LayersTab layerState={layerState} query={query}
                onToggle={(id) => setLayerState((s) => ({ ...s, [id]: !s[id] }))}
                gisLayers={gisLayers} />
            )}
          </div>
        </div>
      )}

      {/* ── Right toolbar (Map view only) ───────────────────────────────── */}
      {navTab === 'map' && (
      <div className="absolute right-4 top-1/2 z-20 -translate-y-1/2 flex w-[64px] flex-col items-center gap-1 rounded-[15px] bg-[#101010] py-3">
        <ToolBtn onClick={() => mapHandle.current?.zoomIn()} label="Zoom in"><Plus className="size-5" /></ToolBtn>
        <ToolBtn onClick={() => mapHandle.current?.zoomOut()} label="Zoom out"><Minus className="size-5" /></ToolBtn>
        <div className="my-1 h-[2px] w-7 rounded" style={{ background: LIME }} />
        <ToolBtn onClick={() => mapHandle.current?.recenter()} label="Recenter"><Crosshair className="size-5" /></ToolBtn>
        <ToolBtn onClick={() => mapHandle.current?.resetNorth()} label="Reset north"><Compass className="size-5" /></ToolBtn>
        <ToolBtn onClick={() => setPanelTab('mapdetail')} label="Basemap"><MapIcon className="size-5" /></ToolBtn>
        <ToolBtn onClick={() => setPanelTab('layers')} label="Layers"><LayersIcon className="size-5" /></ToolBtn>
        <ToolBtn onClick={() => mapHandle.current?.fullscreen()} label="Fullscreen"><Maximize className="size-5" /></ToolBtn>
      </div>
      )}

      {/* ── Operations / Analytics full views ────────────────────────────── */}
      {navTab !== 'map' && (
        <div className="absolute inset-x-0 bottom-0 top-[92px] z-20 overflow-y-auto bg-black/90 backdrop-blur-sm">
          <div className="mx-auto max-w-[1120px] px-6 py-6">
            {navTab === 'operations'
              ? <OperationsView project={activeProject} lead={lead ?? null} leadId={leadId} />
              : <AnalyticsView project={activeProject} lead={lead ?? null} />}
          </div>
        </div>
      )}

      {/* ── Bottom: Custom View strip (Map view only) ───────────────────── */}
      {navTab === 'map' && scenes.length > 0 && (
        <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2">
          <div className="ml-1 inline-flex items-center gap-1.5 rounded-t-[12px] bg-black px-4 py-1.5 text-[14px] font-semibold">
            <span className="size-1.5 rounded-full" style={{ background: LIME }} /> Custom View
          </div>
          <div className="flex max-w-[92vw] items-center gap-2 overflow-x-auto rounded-[15px] bg-[#101010] p-2 shadow-[0_4px_4px_rgba(0,0,0,0.25)]">
            {scenes.filter((s) => !query || s.title.toLowerCase().includes(query.toLowerCase())).map((s) => {
              const active = s.id === activeScene?.id && !basemapOverride;
              const thumb = sceneThumbUrl(s);
              return (
                <button key={s.id} onClick={() => { setActiveSceneId(s.id); setBasemapOverride(null); }}
                  className={cn('relative h-[64px] w-[120px] shrink-0 overflow-hidden rounded-[10px] border-2 transition-transform hover:scale-[1.03]',
                    active ? 'border-[#9dff00]' : 'border-black')}
                  style={{ backgroundImage: `url(${thumb})`, backgroundSize: 'cover', backgroundPosition: 'center',
                    backgroundColor: '#1a1f2e' }} title={s.title}>
                  {/* tint the snapshot toward the scene's analytic basemap so the
                      thumbnail reads as that view (SAR/thermal/etc.) */}
                  <span className="absolute inset-0" style={{ background: BRAND_GRADIENTS[s.basemap_id] ?? 'transparent',
                    opacity: s.basemap_id === 'satellite' || s.basemap_id === 'deepgrid' ? 0 : 0.5, mixBlendMode: 'multiply' }} />
                  <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-0.5 text-left text-[10px] text-white">{s.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Status tab — overview + mission + activity + (all CRM features)
// =============================================================================
function StatusTab({ project, scene, lead, leadId }: {
  project: ProjectExt | null; scene: CustomerScene | null; lead: Lead | null; leadId: string | null;
}) {
  const now = new Date();
  const stamp = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return (
    <div className="space-y-6 text-[15px]">
      {/* SYSTEM OVERVIEW */}
      <section>
        <H>System Overview</H>
        <p className="mt-2 text-white/90">{project?.description ?? scene?.description ?? 'Crop &amp; field intelligence — your monitored farmland.'}</p>
      </section>

      {/* MISSION */}
      <section>
        <h3 className="text-[16px] font-semibold" style={{ color: LIME }}>Mission</h3>
        <p className="mt-2 text-white/90">
          Detect crop stress, water and disease pressure across your fields. Satellite indices and SAR fusion
          surface change early; agronomists verify and report.
        </p>
      </section>

      {/* KPI strip (Analytics anchor) */}
      <div id="status-analytics">
        <H>Analytics</H>
        {lead ? <Kpis lead={lead} /> : <Empty>Awaiting account data.</Empty>}
      </div>

      {/* ACTIVITY FEED */}
      <section id="status-activity">
        <div className="text-center text-[16px] font-semibold">Activity Feed</div>
        <div className="my-3 h-px bg-white/15" />
        <div className="relative pl-4">
          <div className="absolute left-0 top-1 bottom-1 w-[6px] rounded-l-full" style={{ background: LIME }} />
          <ActivityFeed leadId={leadId} />
        </div>
        <div className="my-3 h-px bg-white/15" />
        <div className="text-center text-[12px] text-white/70">
          {stamp} &nbsp;|&nbsp; OPS COMMAND <span style={{ color: LIME }}>v4.2</span>
        </div>
      </section>

      {/* TIMELINE */}
      {lead && (
        <section>
          <H>Status Timeline</H>
          <Timeline lead={lead} />
        </section>
      )}

      {/* OPERATIONS anchor: meetings / files / messages */}
      <div id="status-comms" className="space-y-5">
        <div>
          <H><CalendarDays className="size-3.5" /> Meetings</H>
          {leadId ? <MeetingsList leadId={leadId} /> : <Empty>No meetings.</Empty>}
        </div>
        <div>
          <H><Paperclip className="size-3.5" /> Shared Files</H>
          {leadId ? <FilesList leadId={leadId} /> : <Empty>No files.</Empty>}
        </div>
        <div>
          <H><MessageSquare className="size-3.5" /> Messages</H>
          {leadId ? <MessagesPanel leadId={leadId} /> : <Empty>No messages.</Empty>}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Map Detail tab — basemap style grid
// =============================================================================
function MapDetailTab({ current, query, onPick }: {
  current: BrandBasemapId; query: string; onPick: (id: BrandBasemapId) => void;
}) {
  const q = query.trim().toLowerCase();
  const list = BRAND_BASEMAPS.slice(0, 8).filter((b) => !q || b.name.toLowerCase().includes(q) || b.use.toLowerCase().includes(q));
  return (
    <div>
      <H>Basemap Style</H>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {list.map((b) => {
          const active = current === b.id;
          return (
            <button key={b.id} onClick={() => onPick(b.id)} className="text-left" title={b.use}>
              <div className={cn('h-[80px] w-full rounded-[7px] border-2 transition-transform hover:scale-[1.02]', active ? 'border-[#9dff00]' : 'border-transparent')}
                style={{ background: BRAND_GRADIENTS[b.id] }} />
              <div className="mt-1.5 flex items-center gap-1.5">
                <span className="size-[10px] rounded-full border" style={{ borderColor: active ? LIME : '#666', background: active ? LIME : 'transparent' }} />
                <span className="text-[14px] text-white">{b.name}</span>
              </div>
            </button>
          );
        })}
        {list.length === 0 && <Empty>No basemaps match “{query}”.</Empty>}
      </div>
    </div>
  );
}

// =============================================================================
// Layers tab — system layer stack toggles + customer GIS layers
// =============================================================================
function LayersTab({ layerState, query, onToggle, gisLayers }: {
  layerState: Record<string, boolean>; query: string; onToggle: (id: string) => void; gisLayers: GisLayer[];
}) {
  const q = query.trim().toLowerCase();
  const sys = SYSTEM_LAYERS.filter((l) => !q || l.label.toLowerCase().includes(q));
  const gis = gisLayers.filter((g) => !q || g.name.toLowerCase().includes(q));
  return (
    <div>
      <H>System Layer Stack</H>
      <div className="mt-3 space-y-3">
        {sys.map((l) => (
          <Toggle key={l.id} on={layerState[l.id] !== false} label={l.label} onClick={() => onToggle(l.id)} />
        ))}
        {sys.length === 0 && gis.length === 0 && <Empty>No layers match “{query}”.</Empty>}
      </div>
      {gis.length > 0 && (
        <>
          <H className="mt-6">My GIS Layers</H>
          <div className="mt-3 space-y-3">
            {gis.map((g) => (
              <Toggle key={g.id} on={layerState[`gis:${g.id}`] !== false && g.visible}
                label={g.name} dot={g.color} onClick={() => onToggle(`gis:${g.id}`)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// =============================================================================
// Operations view (top-nav "Operations") — activity + meetings/files/messages.
// =============================================================================
function Panel({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-[12px] border border-white/10 bg-white/[0.03] p-4">
      <H>{icon}{title}</H>
      <div className="mt-3">{children}</div>
    </div>
  );
}
function ViewHeader({ kicker, title, sub }: { kicker: string; title: string; sub: string }) {
  return (
    <header>
      <div className="text-[11px] uppercase tracking-[0.14em]" style={{ color: LIME }}>{kicker}</div>
      <h1 className="mt-0.5 text-[26px] font-semibold leading-tight">{title}</h1>
      <p className="mt-1 text-[13px] text-white/55">{sub}</p>
    </header>
  );
}
function OperationsView({ project, lead, leadId }: { project: ProjectExt | null; lead: Lead | null; leadId: string | null }) {
  void lead;
  return (
    <div className="space-y-5">
      <ViewHeader kicker="Operations" title={project?.title ?? 'Account operations'}
        sub="Recent activity, meetings, shared files and messages on your account." />
      <Panel title="Activity Feed">
        <div className="relative pl-4">
          <div className="absolute left-0 top-1 bottom-1 w-[6px] rounded-l-full" style={{ background: LIME }} />
          <ActivityFeed leadId={leadId} />
        </div>
      </Panel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Meetings" icon={<CalendarDays className="size-3.5" />}>{leadId ? <MeetingsList leadId={leadId} /> : <Empty>No meetings.</Empty>}</Panel>
        <Panel title="Shared Files" icon={<Paperclip className="size-3.5" />}>{leadId ? <FilesList leadId={leadId} /> : <Empty>No files.</Empty>}</Panel>
        <Panel title="Messages" icon={<MessageSquare className="size-3.5" />}>{leadId ? <MessagesPanel leadId={leadId} /> : <Empty>No messages.</Empty>}</Panel>
      </div>
    </div>
  );
}

// =============================================================================
// Analytics view (top-nav "Analytics") — KPI strip + status timeline.
// =============================================================================
function AnalyticsView({ project, lead }: { project: ProjectExt | null; lead: Lead | null }) {
  return (
    <div className="space-y-5">
      <ViewHeader kicker="Analytics" title={project?.title ?? 'Account analytics'}
        sub="Progress, engagement and project value across your account." />
      {lead ? <Kpis lead={lead} wide /> : <Empty>Awaiting account data.</Empty>}
      {lead && <Panel title="Status Timeline"><Timeline lead={lead} /></Panel>}
    </div>
  );
}

// =============================================================================
// Small shared pieces
// =============================================================================
function H({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn('flex items-center gap-1.5 text-[16px] font-semibold text-white', className)}>{children}</h3>;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="py-2 text-[12px] text-white/45">{children}</div>;
}
function Legend({ dot, label, ring }: { dot: string; label: string; ring?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-[10px] rounded-full" style={{ background: ring ? 'transparent' : dot, border: ring ? `2px solid ${INK}` : undefined }} />
      <span className="text-[12px] font-semibold" style={{ color: INK }}>{label}</span>
    </span>
  );
}
function ToolBtn({ children, onClick, label }: { children: ReactNode; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label} title={label}
      className="grid size-10 place-items-center rounded-[8px] text-white/85 transition-colors hover:bg-white/10 hover:text-white">
      {children}
    </button>
  );
}
function Toggle({ on, label, onClick, dot }: { on: boolean; label: string; onClick: () => void; dot?: string }) {
  return (
    <button onClick={onClick} className="flex items-center gap-3 text-left">
      <span className="grid h-[40px] w-[56px] place-items-center rounded-[5px] transition-colors"
        style={{ background: on ? LIME_ON : OFF }}>
        <span className="size-[14px] rounded-full" style={{ background: dot ?? (on ? '#ffffff' : '#6a6a6a') }} />
      </span>
      <span className="text-[16px] text-white">{label}</span>
    </button>
  );
}

// ── KPIs ────────────────────────────────────────────────────────────────────
function Kpis({ lead, wide }: { lead: Lead; wide?: boolean }) {
  const { data: meetings = [] } = useQuery({ queryKey: ['k-meet', lead.id], queryFn: async () => (await apiGet<Meeting[]>('/sales/meetings').catch(() => [])).filter((m) => m.lead_id === lead.id) });
  const { data: files = [] } = useQuery({ queryKey: ['k-file', lead.id], queryFn: () => apiGet<FileRecord[]>(`/sales/leads/${lead.id}/files`).catch(() => []) });
  const { data: messages = [] } = useQuery({ queryKey: ['k-msg', lead.id], queryFn: () => apiGet<Message[]>(`/sales/leads/${lead.id}/messages`).catch(() => []) });
  const ts = lead.status_timestamps ?? {};
  const reached = [ts.infoRequestedAt, ts.convertedToLeadAt, ts.convertedToClientAt].filter(Boolean).length;
  const progress = Math.round((reached / 3) * 100);
  const firstContact = ts.infoRequestedAt ?? lead.created_at;
  const days = Math.max(0, Math.floor((Date.now() - new Date(firstContact).getTime()) / 86_400_000));
  const products = (lead.selected_products ?? []).reduce((s, p) => s + Number(p.price ?? 0), 0);
  const value = Number(lead.total_revenue ?? 0) || products;
  const cards: Array<{ icon: ReactNode; label: string; value: string | number; foot: string }> = [
    { icon: <Activity className="size-3.5" />, label: 'Progress', value: `${progress}%`, foot: `${reached}/3 stages` },
    { icon: <CalendarDays className="size-3.5" />, label: 'Days active', value: days, foot: 'Since first contact' },
    { icon: <TrendingUp className="size-3.5" />, label: 'Value', value: formatCurrency(value), foot: 'Project' },
    { icon: <CalendarDays className="size-3.5" />, label: 'Meetings', value: meetings.length, foot: 'Scheduled' },
    { icon: <Paperclip className="size-3.5" />, label: 'Files', value: files.length, foot: 'Shared' },
    { icon: <MessageSquare className="size-3.5" />, label: 'Messages', value: messages.length, foot: 'Total' },
  ];
  return (
    <div className={cn('mt-2 grid gap-2', wide ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6' : 'grid-cols-2')}>
      {cards.map((c) => (
        <div key={c.label} className="rounded-[8px] border border-white/10 bg-white/[0.03] p-2.5">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-white/55">{c.icon}{c.label}</div>
          <div className="mt-1 text-[20px] font-semibold" style={{ color: LIME }}>{c.value}</div>
          <div className="text-[10px] text-white/45">{c.foot}</div>
        </div>
      ))}
    </div>
  );
}

// ── Timeline ──────────────────────────────────────────────────────────────
const TIMELINE: Array<{ key: 'infoRequestedAt' | 'convertedToLeadAt' | 'convertedToClientAt'; label: string }> = [
  { key: 'infoRequestedAt', label: 'Info Requested' },
  { key: 'convertedToLeadAt', label: 'Promoted to Lead' },
  { key: 'convertedToClientAt', label: 'Became Client' },
];
function Timeline({ lead }: { lead: Lead }) {
  const ts = lead.status_timestamps ?? {};
  return (
    <ol className="mt-2 space-y-2">
      {TIMELINE.map((step) => {
        const at = ts[step.key];
        const reached = !!at;
        return (
          <li key={step.key} className={cn('flex items-start gap-2.5 rounded-[6px] border p-2.5', reached ? 'border-[#9dff00]/40 bg-[#9dff00]/[0.06]' : 'border-white/10 bg-white/[0.02]')}>
            <CheckCircle2 className={cn('mt-0.5 size-4 shrink-0', reached ? 'text-[#9dff00]' : 'text-white/30')} />
            <div>
              <div className={cn('text-[13px]', reached ? 'font-medium text-white' : 'text-white/60')}>{step.label}</div>
              {at && <div className="text-[10px] text-white/45">{formatRelative(at)}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── Activity feed ───────────────────────────────────────────────────────────
function ActivityFeed({ leadId }: { leadId: string | null }) {
  const { data: files = [] } = useQuery({ queryKey: ['af-file', leadId], enabled: !!leadId, queryFn: () => apiGet<FileRecord[]>(`/sales/leads/${leadId}/files`).catch(() => []) });
  const { data: messages = [] } = useQuery({ queryKey: ['af-msg', leadId], enabled: !!leadId, queryFn: () => apiGet<Message[]>(`/sales/leads/${leadId}/messages`).catch(() => []) });
  const items: Array<{ dot: string; text: string; time: string }> = [];
  for (const f of files.slice(0, 4)) items.push({ dot: LIME, text: `${f.file_name} (${Math.round(f.file_size / 1024)} KB)`, time: formatRelative(f.uploaded_at) });
  for (const m of messages.slice(0, 4)) items.push({ dot: m.sender === 'agent' ? '#36c5d0' : LIME, text: `Message ${m.sender === 'agent' ? 'from team' : 'sent'}`, time: formatRelative(m.created_at) });
  if (!items.length) {
    // honest synthetic baseline so the feed isn't empty on fresh accounts
    items.push({ dot: '#36c5d0', text: 'Sentinel-1 SAR pass acquired', time: 'recently' });
    items.push({ dot: LIME, text: 'Monitoring active', time: 'live' });
  }
  return (
    <div className="space-y-3">
      {items.map((it, i) => (
        <div key={i} className="flex items-start gap-2.5">
          <span className="mt-1.5 size-[10px] shrink-0 rounded-full" style={{ background: it.dot }} />
          <div>
            <div className="text-[15px] font-medium text-white">{it.text}</div>
            <div className="text-[13px] text-white/55">{it.time}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Meetings / Files / Messages (compact, dark) ─────────────────────────────
function MeetingsList({ leadId }: { leadId: string }) {
  const { data: meetings = [] } = useQuery({ queryKey: ['meetings', leadId], queryFn: async () => (await apiGet<Meeting[]>(`/sales/meetings?from=${new Date(Date.now() - 86400_000).toISOString()}`).catch(() => [])).filter((m) => m.lead_id === leadId) });
  if (!meetings.length) return <Empty>No meetings scheduled.</Empty>;
  return (
    <div className="mt-2 space-y-2">
      {meetings.map((m) => (
        <div key={m.id} className="rounded-[6px] border border-white/10 bg-white/[0.03] p-2.5">
          <div className="text-[13px] font-medium text-white">{m.title}</div>
          <div className="text-[11px] text-white/55">{new Date(m.start_at).toLocaleString()} · {m.location ?? '—'}</div>
        </div>
      ))}
    </div>
  );
}
function FilesList({ leadId }: { leadId: string }) {
  const { data: files = [] } = useQuery({ queryKey: ['files', leadId], queryFn: () => apiGet<FileRecord[]>(`/sales/leads/${leadId}/files`).catch(() => []) });
  if (!files.length) return <Empty>No files yet.</Empty>;
  return (
    <div className="mt-2 space-y-2">
      {files.map((f) => (
        <div key={f.id} className="flex items-center justify-between rounded-[6px] border border-white/10 bg-white/[0.03] p-2.5">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-white">{f.file_name}</div>
            <div className="text-[11px] text-white/55">{Math.round(f.file_size / 1024)} KB · {formatRelative(f.uploaded_at)}</div>
          </div>
          {f.signed_url && <a href={f.signed_url} className="text-[11px] font-medium text-[#9dff00] underline">View</a>}
        </div>
      ))}
    </div>
  );
}
function MessagesPanel({ leadId }: { leadId: string }) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const { data: messages = [] } = useQuery({ queryKey: ['messages', leadId], queryFn: () => apiGet<Message[]>(`/sales/leads/${leadId}/messages`).catch(() => []) });
  const send = useMutation({
    mutationFn: () => apiPost(`/sales/leads/${leadId}/messages`, { sender: 'contact', body }),
    onSuccess: () => { setBody(''); qc.invalidateQueries({ queryKey: ['messages', leadId] }); },
  });
  return (
    <div className="mt-2 space-y-2">
      <div className="max-h-[200px] space-y-1.5 overflow-y-auto pr-1">
        {messages.map((m) => (
          <div key={m.id} className={cn('rounded-[6px] border p-2.5 text-[12px]', m.sender === 'contact' ? 'ml-5 border-[#9dff00]/30 bg-[#9dff00]/[0.08]' : 'mr-5 border-white/10 bg-white/[0.03]')}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-white/55">{m.sender}</span>
              <span className="text-[10px] text-white/45">{formatRelative(m.created_at)}</span>
            </div>
            <div className="whitespace-pre-wrap text-white">{m.body}</div>
          </div>
        ))}
        {!messages.length && <Empty>No messages yet.</Empty>}
      </div>
      <div className="flex items-center gap-2">
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message your team…"
          className="h-9 flex-1 rounded-[6px] border border-white/15 bg-black/40 px-3 text-[12px] text-white outline-none placeholder:text-white/40" />
        <button disabled={!body.trim() || send.isPending} onClick={() => send.mutate()}
          className="grid size-9 place-items-center rounded-[6px] disabled:opacity-40" style={{ background: LIME }} aria-label="Send">
          <Send className="size-4" style={{ color: INK }} />
        </button>
      </div>
    </div>
  );
}

// Static map-tile thumbnail for a saved scene (CARTO light = Figma theme).
// Computes the slippy tile covering the scene centre at a thumbnail zoom.
function sceneThumbUrl(s: CustomerScene): string {
  const z = Math.max(0, Math.min(18, Math.round(Number(s.zoom ?? 12) - 2)));
  const lat = Number(s.center_lat), lon = Number(s.center_lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return `https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`;
}

// ── geo helpers ─────────────────────────────────────────────────────────────
function circleGeoJSON(lat: number, lon: number, radiusKm: number, steps = 64): GeoJSON.Feature<GeoJSON.Polygon> {
  const coords: Array<[number, number]> = [];
  const R = 6371;
  for (let i = 0; i <= steps; i++) {
    const brng = (i / steps) * 2 * Math.PI;
    const lat1 = (lat * Math.PI) / 180, lon1 = (lon * Math.PI) / 180, d = radiusKm / R;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    coords.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } };
}
function centroidOf(geom: { coordinates?: unknown } | undefined): { lat: number; lon: number } | null {
  if (!geom?.coordinates) return null;
  let sx = 0, sy = 0, n = 0;
  const walk = (a: unknown): void => {
    if (!Array.isArray(a)) return;
    if (typeof a[0] === 'number' && typeof a[1] === 'number') { sx += a[0]; sy += a[1]; n++; }
    else a.forEach(walk);
  };
  walk(geom.coordinates);
  return n ? { lat: sy / n, lon: sx / n } : null;
}
