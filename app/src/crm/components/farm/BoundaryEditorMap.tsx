// =============================================================================
// BoundaryEditorMap — a full satellite map surface with precise editing tools so
// operators can CORRECT an AI auto-traced (or imported) boundary exactly.
// -----------------------------------------------------------------------------
// Tools (frosted rail, top-left):
//   • Edit     — drag a vertex · click an edge dot to add a vertex · right-click
//                a vertex to delete it.
//   • Move     — drag anywhere inside the boundary to slide the whole shape.
//   • Redraw   — click corners to trace a fresh outline (dbl-click / ⏎ to finish).
//   • Freehand — hold + drag to trace an organic outline in one stroke.
//   • Undo · Fit · Expand (near-fullscreen) · Clear.
// Every edit emits the normalized Polygon/MultiPolygon via onChange — the same
// sink FindMyFarm / BoundaryImport feed, so review/create are untouched.
//
// MultiPolygon-safe: vertex handles carry their (polygon, vertex) index, holes
// are preserved, and a redraw/freehand replaces the whole boundary with a single
// Polygon. Degrades to a static note when WebGL is unavailable.
// =============================================================================

import * as React from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  Spline, Move, PenTool, Undo2, Frame, Maximize2, Minimize2, X, MousePointer2, Info,
} from 'lucide-react';
import { cn } from '@crm/lib/utils';
import { geometryBbox, geometryAreaHa, geometryVertexCount } from '@crm/components/farm/BoundaryImport';

type Polygonal = GeoJSON.Polygon | GeoJSON.MultiPolygon;
type Ring = [number, number][];
type Poly = { outer: Ring; holes: Ring[] };
type Tool = 'edit' | 'move' | 'draw' | 'freehand';

const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    'esri-imagery': {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Esri, Maxar, Earthstar Geographics',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0B0A08' } },
    { id: 'esri-imagery', type: 'raster', source: 'esri-imagery' },
  ],
};
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

// --- geometry <-> editable rings -------------------------------------------
function openRing(r: GeoJSON.Position[]): Ring {
  const ring = r.map((p) => [p[0], p[1]] as [number, number]);
  const f = ring[0], l = ring[ring.length - 1];
  if (l && f && l[0] === f[0] && l[1] === f[1]) ring.pop();
  return ring;
}
function toPolys(g: Polygonal | null): Poly[] {
  if (!g) return [];
  const src = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return src.map((rings) => ({ outer: openRing(rings[0] ?? []), holes: (rings.slice(1)).map(openRing) }))
    .filter((p) => p.outer.length >= 3);
}
function closed(r: Ring): GeoJSON.Position[] { return r.length ? [...r, r[0]] : r; }
function toGeometry(polys: Poly[]): Polygonal | null {
  const valid = polys.filter((p) => p.outer.length >= 3);
  if (!valid.length) return null;
  const asRings = (p: Poly) => [closed(p.outer), ...p.holes.map(closed)];
  if (valid.length === 1) return { type: 'Polygon', coordinates: asRings(valid[0]) };
  return { type: 'MultiPolygon', coordinates: valid.map(asRings) };
}
function centroid(polys: Poly[]): [number, number] | null {
  let x = 0, y = 0, n = 0;
  for (const p of polys) for (const [lng, lat] of p.outer) { x += lng; y += lat; n++; }
  return n ? [x / n, y / n] : null;
}

export interface BoundaryEditorMapProps {
  value: Polygonal | null;
  onChange: (geom: Polygonal | null) => void;
  /** Map height in px when not expanded (default 460). */
  height?: number;
  className?: string;
}

export function BoundaryEditorMap({ value, onChange, height = 460, className }: BoundaryEditorMapProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [tool, setTool] = React.useState<Tool>(value ? 'edit' : 'draw');
  const [expanded, setExpanded] = React.useState(false);

  // Editable model + a small undo stack, kept in refs for once-bound handlers.
  const polysRef = React.useRef<Poly[]>(toPolys(value));
  const historyRef = React.useRef<Poly[][]>([]);
  const toolRef = React.useRef(tool); toolRef.current = tool;
  const onChangeRef = React.useRef(onChange); onChangeRef.current = onChange;
  const draftRef = React.useRef<Ring>([]);
  const [draftLen, setDraftLen] = React.useState(0);

  const clone = (ps: Poly[]): Poly[] => ps.map((p) => ({ outer: p.outer.map((v) => [...v] as [number, number]), holes: p.holes.map((h) => h.map((v) => [...v] as [number, number])) }));
  const pushHistory = React.useCallback(() => { historyRef.current.push(clone(polysRef.current)); if (historyRef.current.length > 40) historyRef.current.shift(); }, []);

  // Push the current model into the map sources (boundary + edit handles + draft).
  const paint = React.useCallback(() => {
    const map = mapRef.current; if (!map || !map.isStyleLoaded()) return;
    const geom = toGeometry(polysRef.current);
    (map.getSource('bnd') as maplibregl.GeoJSONSource | undefined)?.setData(geom ? { type: 'Feature', geometry: geom, properties: {} } : EMPTY_FC);
    // vertex + midpoint handles (only in edit mode)
    const vFeats: GeoJSON.Feature[] = [];
    const mFeats: GeoJSON.Feature[] = [];
    if (toolRef.current === 'edit') {
      polysRef.current.forEach((poly, p) => {
        const r = poly.outer, n = r.length;
        r.forEach((v, i) => vFeats.push({ type: 'Feature', properties: { p, i }, geometry: { type: 'Point', coordinates: v } }));
        for (let i = 0; i < n; i++) { const a = r[i], b = r[(i + 1) % n]; mFeats.push({ type: 'Feature', properties: { p, i }, geometry: { type: 'Point', coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] } }); }
      });
    }
    (map.getSource('verts') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: vFeats });
    (map.getSource('mids') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: mFeats });
    const d = draftRef.current;
    const draftFeat: GeoJSON.Feature[] = d.length
      ? [{ type: 'Feature', properties: {}, geometry: d.length >= 3 ? { type: 'Polygon', coordinates: [closed(d)] } : { type: 'LineString', coordinates: d } },
         ...d.map((v) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: v } }))]
      : [];
    (map.getSource('draft') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: draftFeat });
  }, []);

  const commit = React.useCallback((emit = true) => { paint(); if (emit) onChangeRef.current(toGeometry(polysRef.current)); }, [paint]);

  const fit = React.useCallback(() => {
    const map = mapRef.current; if (!map) return;
    const geom = toGeometry(polysRef.current); if (!geom) return;
    const bb = geometryBbox(geom); if (bb) map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, maxZoom: 17, duration: 700 });
  }, []);

  // Sync incoming value (auto-trace / import) into the model.
  React.useEffect(() => {
    const incoming = toPolys(value);
    // Only adopt when it differs from what we already hold (avoid clobbering an in-progress edit echo).
    const same = JSON.stringify(incoming) === JSON.stringify(polysRef.current);
    if (!same) { polysRef.current = incoming; historyRef.current = []; if (ready) { paint(); fit(); } if (incoming.length && tool === 'draw') setTool('edit'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, ready]);

  // When the map finishes loading, paint + fit whatever model we already hold —
  // covers the common case where the auto-trace value arrives BEFORE the map is
  // ready (otherwise the "same" guard above skips the first paint and it stays blank).
  React.useEffect(() => { if (ready) { paint(); fit(); } }, [ready, paint, fit]);

  React.useEffect(() => {
    const el = containerRef.current; if (!el || mapRef.current) return;
    let map: maplibregl.Map;
    try { map = new maplibregl.Map({ container: el, style: SATELLITE_STYLE, center: [-30, 12], zoom: 1.4, attributionControl: { compact: true }, maxPitch: 0 }); }
    catch (e) { console.warn('[BoundaryEditorMap] WebGL unavailable', e); setFailed(true); return; }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('error', (ev) => console.warn('[BoundaryEditorMap] map error', ev?.error ?? ev));
    mapRef.current = map;

    map.on('load', () => {
      for (const s of ['bnd', 'verts', 'mids', 'draft']) map.addSource(s, { type: 'geojson', data: EMPTY_FC });
      map.addLayer({ id: 'bnd-fill', type: 'fill', source: 'bnd', paint: { 'fill-color': '#4C7EFF', 'fill-opacity': 0.2 } });
      map.addLayer({ id: 'bnd-line', type: 'line', source: 'bnd', paint: { 'line-color': '#6E97FF', 'line-width': 2.5 } });
      map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#4C7EFF', 'fill-opacity': 0.18 } });
      map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#8BB0FF', 'line-width': 2, 'line-dasharray': [1.5, 1] } });
      map.addLayer({ id: 'draft-vert', type: 'circle', source: 'draft', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#4C7EFF', 'circle-stroke-width': 2 } });
      map.addLayer({ id: 'mid', type: 'circle', source: 'mids', paint: { 'circle-radius': 4, 'circle-color': '#0b0a08', 'circle-stroke-color': '#8BB0FF', 'circle-stroke-width': 1.5, 'circle-opacity': 0.9 } });
      map.addLayer({ id: 'vert', type: 'circle', source: 'verts', paint: { 'circle-radius': 6, 'circle-color': '#4C7EFF', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      setReady(true);
      map.resize();
      if (polysRef.current.length) { paint(); fit(); }
    });

    // --- vertex drag / add / delete (edit tool) ---
    let dragVert: { p: number; i: number } | null = null;
    map.on('mousedown', (e) => {
      if (toolRef.current !== 'edit') return;
      const h = map.queryRenderedFeatures(e.point, { layers: ['vert'] })[0];
      const pr = h?.properties as { p?: number; i?: number } | undefined;
      if (!h || pr?.p == null || pr?.i == null) return;
      e.preventDefault(); pushHistory(); dragVert = { p: Number(pr.p), i: Number(pr.i) }; map.dragPan.disable();
    });
    map.on('mousemove', (e) => {
      if (!dragVert) return;
      const poly = polysRef.current[dragVert.p]; if (!poly) return;
      poly.outer[dragVert.i] = [e.lngLat.lng, e.lngLat.lat];
      commit(false); // live-repaint without spamming onChange
    });
    const endVert = () => { if (dragVert) { dragVert = null; map.dragPan.enable(); commit(true); } };
    map.on('mouseup', endVert); map.on('mouseout', endVert);

    map.on('click', (e) => {
      const t = toolRef.current;
      if (t === 'edit') { // click an edge midpoint → insert a vertex
        const m = map.queryRenderedFeatures(e.point, { layers: ['mid'] })[0];
        const pr = m?.properties as { p?: number; i?: number } | undefined;
        if (!m || pr?.p == null || pr?.i == null) return;
        pushHistory();
        const poly = polysRef.current[Number(pr.p)]; const i = Number(pr.i);
        poly.outer.splice(i + 1, 0, [e.lngLat.lng, e.lngLat.lat]);
        commit(true);
      } else if (t === 'draw') {
        draftRef.current = [...draftRef.current, [e.lngLat.lng, e.lngLat.lat]];
        setDraftLen(draftRef.current.length); paint();
      }
    });
    map.on('contextmenu', (e) => { // right-click a vertex → delete
      if (toolRef.current !== 'edit') return;
      const h = map.queryRenderedFeatures(e.point, { layers: ['vert'] })[0];
      const pr = h?.properties as { p?: number; i?: number } | undefined;
      if (!h || pr?.p == null || pr?.i == null) return;
      e.preventDefault();
      const poly = polysRef.current[Number(pr.p)]; if (!poly || poly.outer.length <= 3) return;
      pushHistory(); poly.outer.splice(Number(pr.i), 1); commit(true);
    });

    // --- move whole boundary ---
    let moveLast: [number, number] | null = null;
    map.on('mousedown', (e) => {
      if (toolRef.current !== 'move' || !polysRef.current.length) return;
      e.preventDefault(); pushHistory(); moveLast = [e.lngLat.lng, e.lngLat.lat]; map.dragPan.disable();
    });
    map.on('mousemove', (e) => {
      if (!moveLast) return;
      const dx = e.lngLat.lng - moveLast[0], dy = e.lngLat.lat - moveLast[1]; moveLast = [e.lngLat.lng, e.lngLat.lat];
      for (const poly of polysRef.current) { poly.outer = poly.outer.map(([x, y]) => [x + dx, y + dy] as [number, number]); poly.holes = poly.holes.map((h) => h.map(([x, y]) => [x + dx, y + dy] as [number, number])); }
      commit(false);
    });
    const endMove = () => { if (moveLast) { moveLast = null; map.dragPan.enable(); commit(true); } };
    map.on('mouseup', endMove); map.on('mouseout', endMove);

    // --- freehand draw ---
    let freePts: Ring | null = null;
    const freeMinDeg = 0.00004;
    map.on('mousedown', (e) => { if (toolRef.current !== 'freehand') return; e.preventDefault(); freePts = [[e.lngLat.lng, e.lngLat.lat]]; map.dragPan.disable(); });
    map.on('mousemove', (e) => {
      if (!freePts || toolRef.current !== 'freehand') return;
      const p: [number, number] = [e.lngLat.lng, e.lngLat.lat]; const last = freePts[freePts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < freeMinDeg) return;
      freePts.push(p); draftRef.current = freePts; setDraftLen(freePts.length); paint();
    });
    const endFree = () => {
      if (!freePts) return; const pts = freePts; freePts = null; map.dragPan.enable();
      draftRef.current = []; setDraftLen(0);
      if (pts.length >= 3) { pushHistory(); polysRef.current = [{ outer: pts, holes: [] }]; commit(true); setTool('edit'); }
      else paint();
    };
    map.on('mouseup', endFree);

    map.on('dblclick', (e) => {
      if (toolRef.current !== 'draw') return;
      if (draftRef.current.length >= 3) { e.preventDefault(); finishDraw(); }
    });

    function finishDraw() {
      const d = draftRef.current; if (d.length < 3) return;
      pushHistory(); polysRef.current = [{ outer: [...d], holes: [] }];
      draftRef.current = []; setDraftLen(0); commit(true); setTool('edit');
    }
    (map as unknown as { __finishDraw?: () => void }).__finishDraw = finishDraw;

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.resize()) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); try { map.remove(); } catch { /* ignore */ } mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Repaint handles when the tool changes; keep the cursor honest.
  React.useEffect(() => {
    const map = mapRef.current; if (!map || !ready) return;
    paint();
    map.getCanvas().style.cursor = tool === 'edit' || tool === 'move' ? '' : 'crosshair';
    if (tool !== 'draw' && tool !== 'freehand' && draftRef.current.length) { draftRef.current = []; setDraftLen(0); paint(); }
  }, [tool, ready, paint]);

  // Keyboard: Enter finishes a redraw, Esc cancels a draft.
  React.useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tg = ev.target as HTMLElement | null;
      if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
      if (ev.key === 'Enter' && toolRef.current === 'draw') { (mapRef.current as unknown as { __finishDraw?: () => void })?.__finishDraw?.(); }
      else if (ev.key === 'Escape') { draftRef.current = []; setDraftLen(0); paint(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paint]);

  const undo = React.useCallback(() => {
    const prev = historyRef.current.pop(); if (!prev) return;
    polysRef.current = prev; commit(true); fit();
  }, [commit, fit]);
  const clearAll = React.useCallback(() => { pushHistory(); polysRef.current = []; draftRef.current = []; setDraftLen(0); commit(true); setTool('draw'); }, [commit, pushHistory]);

  const geom = value;
  const areaHa = geom ? geometryAreaHa(geom) : 0;
  const pts = geom ? geometryVertexCount(geom) : 0;

  // Expand toggles CSS on the SAME node (no re-parenting) so the live WebGL map
  // is never remounted; a ResizeObserver keeps the canvas sized to the box.
  const shell = (
    <div
      className={cn('relative w-full overflow-hidden border border-[var(--border)] bg-[#05060a]', expanded ? 'fixed inset-0 z-[100] rounded-none' : 'rounded-[var(--radius-lg)]', className)}
      style={expanded ? { position: 'fixed' } : { height, position: 'relative' }}
    >
      <div ref={containerRef} className="h-full w-full" aria-label="Boundary editor map" />

      {/* Tool rail */}
      <div className="absolute left-2.5 top-2.5 z-10 flex flex-col gap-1 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[color-mix(in_oklch,var(--surface)_88%,transparent)] p-1 shadow-[var(--shadow-popover)] backdrop-blur-xl">
        <Tool2 active={tool === 'edit'} onClick={() => setTool('edit')} title="Edit — drag a vertex · click an edge dot to add · right-click to delete" icon={MousePointer2} />
        <Tool2 active={tool === 'move'} onClick={() => setTool('move')} title="Move the whole boundary" icon={Move} />
        <Tool2 active={tool === 'draw'} onClick={() => setTool('draw')} title="Redraw — click corners, double-click / ⏎ to finish" icon={Spline} />
        <Tool2 active={tool === 'freehand'} onClick={() => setTool('freehand')} title="Freehand — hold + drag to trace an outline" icon={PenTool} />
        <div className="my-0.5 h-px w-full bg-[var(--border)]" />
        <Tool2 onClick={undo} title="Undo" icon={Undo2} disabled={historyRef.current.length === 0} />
        <Tool2 onClick={fit} title="Fit to boundary" icon={Frame} disabled={!geom} />
        <Tool2 onClick={() => setExpanded((v) => !v)} title={expanded ? 'Collapse map' : 'Expand map'} icon={expanded ? Minimize2 : Maximize2} />
        <Tool2 onClick={clearAll} title="Clear boundary" icon={X} disabled={!geom} />
      </div>

      {/* Contextual hint */}
      <div className="pointer-events-none absolute left-1/2 top-2.5 z-10 -translate-x-1/2 rounded-[var(--radius-full)] border border-[color-mix(in_oklch,var(--accent)_40%,transparent)] bg-[color-mix(in_oklch,var(--surface)_86%,transparent)] px-3 py-1 text-[11px] text-[var(--fg-muted)] backdrop-blur-xl">
        {tool === 'edit' && (geom ? 'Drag a vertex · click an edge dot to add · right-click to delete' : 'No boundary yet — use Redraw or Freehand to trace one')}
        {tool === 'move' && 'Drag inside the boundary to move it'}
        {tool === 'draw' && `Click corners · double-click / ⏎ to finish${draftLen ? ` · ${draftLen} pts` : ''}`}
        {tool === 'freehand' && 'Hold + drag to trace the outline'}
      </div>

      {/* Readout */}
      {geom && (
        <div className="pointer-events-none absolute bottom-2.5 left-2.5 z-10 inline-flex items-center gap-2.5 rounded-[var(--radius-full)] bg-[color-mix(in_oklch,var(--bg)_70%,transparent)] px-3 py-1 text-[11px] tabular-nums text-[var(--fg)] backdrop-blur-sm">
          <span className="font-medium">{areaHa.toLocaleString(undefined, { maximumFractionDigits: 1 })} ha</span>
          <span className="text-[var(--fg-subtle)]">{pts} pts</span>
        </div>
      )}
    </div>
  );

  if (failed) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] px-4 text-center', className)} style={{ height }}>
        <Info className="size-5 text-[var(--fg-subtle)]" />
        <div className="text-[12px] font-medium text-[var(--fg-muted)]">Map editor unavailable in this browser</div>
        <div className="text-[11px] text-[var(--fg-subtle)]">Import or paste your boundary instead — it will still be saved.</div>
      </div>
    );
  }

  return shell;
}

function Tool2({ active, onClick, title, icon: Icon, disabled }: { active?: boolean; onClick?: () => void; title: string; icon: React.ComponentType<{ className?: string }>; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={title} disabled={disabled}
      className={cn('grid size-8 place-items-center rounded-[var(--radius-md)] transition', disabled ? 'cursor-not-allowed text-[var(--fg-subtle)] opacity-40' : active ? 'bg-[var(--accent)] text-[var(--fg-on-accent)]' : 'text-[var(--fg-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--fg)]')}>
      <Icon className="size-4" />
    </button>
  );
}
