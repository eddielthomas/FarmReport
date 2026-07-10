// =============================================================================
// StudioMap — the full farm authoring studio (ported from the concept prototype
// studio.index + studio-map, re-skinned to Report.Farm tokens).
// Complete left tool rail + object library + right-panel twin inspector +
// reports/analytics/history + season timeline + layers + live gateway signals.
// =============================================================================

import * as React from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  MousePointer2, StickyNote, TriangleAlert, ListChecks, Ruler, Pentagon, LandPlot,
  Grid2x2, Square, Circle, Spline, Copy, Trash2, Undo2, Redo2, EyeOff, Tag,
  Sparkles, Clock, FileText, MapPin, X, Boxes, ExternalLink, MapPinned, ChevronDown,
  Sprout, Activity, Loader2, Satellite, Waypoints, PenTool, Lock,
} from 'lucide-react';
import { apiGet, apiPost } from '@crm/lib/api';
import { useHasFeature } from '@crm/lib/auth-store';
import { UpsellPill } from '@crm/components/farm/FeatureGate';
import { REPORTS, TOTAL_PLANNED, REPORT_FAMILIES, reportIsLive, type ReportDef } from '@crm/lib/report-catalog';
import { fetchSurfaceMenu } from '@crm/lib/gateway-surface';
import {
  useTwins, CATALOG, CATEGORY_LABEL, makeTwinFromCatalog, twinsToGeoJSON, circlePolygon,
  geomAreaAcres, healthScore, type TwinCategory, type CatalogItem, type Twin, type TwinGeom,
} from '@crm/lib/twins-store';
import { fetchSignals, bboxFromAoi, type SignalFeature, type ScanSignal } from '@crm/lib/gateway-signals';
import { launchScanJob } from '@crm/lib/scan-jobs';
import { ScanJobsRunner } from '@crm/components/farm/studio/ScanJobsRunner';
import { StudioHeader } from './studio-ui';
import strataPhotoUrl from '@crm/assets/strata-photoreal.jpg';

interface FarmProperty {
  id: string; name: string;
  boundaries: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  aoi_west: number | null; aoi_south: number | null; aoi_east: number | null; aoi_north: number | null;
  crops?: string[];
}
type Annotation = { id: string; lng: number; lat: number; label: string; kind: 'note' | 'issue' | 'task' };
type Tool = 'select' | 'edit' | 'note' | 'issue' | 'task' | 'measure' | 'zone' | 'parcel' | 'place' | 'rect' | 'circle' | 'row' | 'freehand';
type Layer = 'satellite' | 'ndvi' | 'moisture' | 'thermal';
type Tab = 'twin' | 'reports' | 'analytics' | 'history';

const LAYER_PAINT: Record<Layer, Record<string, number>> = {
  satellite: { 'raster-saturation': -0.05, 'raster-contrast': 0.1, 'raster-hue-rotate': 0, 'raster-brightness-min': 0, 'raster-brightness-max': 1 },
  ndvi:      { 'raster-saturation': -1, 'raster-contrast': 0.55, 'raster-hue-rotate': 90, 'raster-brightness-min': 0.15, 'raster-brightness-max': 0.9 },
  moisture:  { 'raster-saturation': -0.8, 'raster-contrast': 0.1, 'raster-hue-rotate': 200, 'raster-brightness-min': 0.1, 'raster-brightness-max': 0.75 },
  thermal:   { 'raster-saturation': -0.5, 'raster-contrast': 0.6, 'raster-hue-rotate': -40, 'raster-brightness-min': 0.05, 'raster-brightness-max': 0.95 },
};
const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8, glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  sources: { esri: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, attribution: 'Esri, Maxar, Earthstar Geographics' } },
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b0a08' } }, { id: 'esri', type: 'raster', source: 'esri', paint: { ...LAYER_PAINT.satellite, 'raster-opacity': 1 } }],
};
const CATS: TwinCategory[] = ['structure', 'equipment', 'crop', 'field', 'livestock', 'water', 'infra'];
// Default object for a boundary drawn WITHOUT first picking a catalog type — so a
// parcel/rect/circle/freehand draw always yields a Field twin the user can retype.
const DEFAULT_FIELD = CATALOG.find((c) => c.kind === 'field') ?? CATALOG.find((c) => c.category === 'field') ?? CATALOG[0];
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const LAYERS: Layer[] = ['satellite', 'ndvi', 'moisture', 'thermal'];
const SCAN_OPTIONS: { id: ScanSignal; label: string }[] = [{ id: 'sar', label: 'SAR' }, { id: 'moisture', label: 'Moisture' }, { id: 'thermal', label: 'Thermal' }];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NDVI_12 = [0.42, 0.48, 0.53, 0.58, 0.61, 0.65, 0.68, 0.71, 0.7, 0.72, 0.74, 0.72];

type SignalsState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'unconfigured' } | { kind: 'error'; message: string } | { kind: 'ready'; features: SignalFeature[] };

// Tight lng/lat bounds of a (multi)polygon boundary ring — for fitting to the parcel.
function boundaryBounds(b: GeoJSON.Polygon | GeoJSON.MultiPolygon): [[number, number], [number, number]] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const rings = b.type === 'Polygon' ? [b.coordinates[0]] : b.coordinates.map((p) => p[0]);
  for (const ring of rings) for (const pt of ring as [number, number][]) {
    const [x, y] = pt; if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
  }
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}

function aoiCenter(p: FarmProperty): [number, number] {
  if (p.aoi_west != null && p.aoi_east != null && p.aoi_south != null && p.aoi_north != null) return [(p.aoi_west + p.aoi_east) / 2, (p.aoi_south + p.aoi_north) / 2];
  return [-93.63, 42.03];
}
function metersBetween(a: [number, number], b: [number, number]): number {
  const R = 6371000, r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b[1] - a[1]), dLng = r(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function twinCenter(t: Twin): [number, number] {
  const g = t.geom;
  if (g.type === 'point') return [g.lng, g.lat];
  if (g.type === 'rect' || g.type === 'circle') return g.center;
  const pts = g.type === 'polygon' ? g.ring : g.points;
  let x = 0, y = 0; for (const p of pts) { x += p[0]; y += p[1]; } return [x / pts.length, y / pts.length];
}
function translate(g: TwinGeom, dLng: number, dLat: number): TwinGeom {
  if (g.type === 'point') return { ...g, lng: g.lng + dLng, lat: g.lat + dLat };
  if (g.type === 'rect' || g.type === 'circle') return { ...g, center: [g.center[0] + dLng, g.center[1] + dLat] };
  if (g.type === 'polygon') return { ...g, ring: g.ring.map(([x, y]) => [x + dLng, y + dLat] as [number, number]) };
  return { ...g, points: g.points.map(([x, y]) => [x + dLng, y + dLat] as [number, number]) };
}

// Outer ring of the property boundary, open (no closing duplicate vertex) — the
// footprint the cutaway slab is extruded from.
function outerRing(b: GeoJSON.Polygon | GeoJSON.MultiPolygon | null | undefined): [number, number][] | null {
  if (!b) return null;
  const raw = (b.type === 'Polygon' ? b.coordinates[0] : b.coordinates[0]?.[0]) as [number, number][] | undefined;
  if (!raw || raw.length < 3) return null;
  const ring = raw.slice();
  const f = ring[0], l = ring[ring.length - 1];
  if (l && f && l[0] === f[0] && l[1] === f[1]) ring.pop();
  return ring.length >= 3 ? ring : null;
}

// -----------------------------------------------------------------------------
// Photoreal soil-strata cutaway. A single <canvas> overlaid on the pitched
// MapLibre view. Each camera-facing parcel edge becomes a "wall" textured with a
// photoreal strata image mapped ONCE — image width → the (tilted) top edge,
// image height → the full drop (depth). Because depth maps identically on every
// face, each soil horizon sits at the same depth fraction all the way around, so
// the layers line up at the block's corners — realistic rock, no wrapped/tiled
// seams. A dark soil gradient underlies the block so corner crevices read as
// shadowed earth, and the parcel footprint is punched clear for the satellite.
// -----------------------------------------------------------------------------
let strataImg: HTMLImageElement | null = null;
let strataImgReady = false;
function getStrataImage(onReady?: () => void): HTMLImageElement | null {
  if (typeof window === 'undefined') return null;
  if (!strataImg) {
    strataImg = new Image();
    strataImg.crossOrigin = 'anonymous';
    strataImg.onload = () => { strataImgReady = true; onReady?.(); };
    strataImg.src = strataPhotoUrl;
  } else if (!strataImgReady && onReady) {
    strataImg.addEventListener('load', onReady, { once: true });
  }
  return strataImgReady ? strataImg : null;
}
// Soil-horizon palette — the crevice under-fill + the fallback before the photo
// loads. [depth fraction 0..1 from surface, base RGB].
const STRATA: Array<[number, [number, number, number]]> = [
  [0.00, [62, 44, 29]], [0.05, [82, 54, 34]], [0.12, [109, 69, 39]],
  [0.22, [145, 95, 52]], [0.32, [170, 120, 68]], [0.42, [137, 86, 47]],
  [0.52, [102, 80, 60]], [0.62, [80, 72, 62]], [0.72, [60, 69, 83]],
  [0.82, [52, 62, 75]], [0.92, [42, 50, 61]], [1.00, [30, 36, 45]],
];
function rgbShade(c: [number, number, number], mul: number): string {
  const k = (v: number) => Math.max(0, Math.min(255, Math.round(v * mul)));
  return `rgb(${k(c[0])},${k(c[1])},${k(c[2])})`;
}

function drawStrataCutaway(map: maplibregl.Map, canvas: HTMLCanvasElement | null, ring: [number, number][] | null, seedStr: string) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!ring || ring.length < 3) return;

  const pts = ring.map(([lng, lat]) => map.project([lng, lat] as maplibregl.LngLatLike));
  // Wall depth is tied to the parcel's ON-SCREEN footprint — not an absolute
  // pixel floor — so the earth block never stretches when you zoom out to a tiny
  // parcel (small footprint → short walls) yet stays substantial when zoomed in.
  let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
  for (const p of pts) { if (p.x < mnX) mnX = p.x; if (p.x > mxX) mxX = p.x; if (p.y < mnY) mnY = p.y; if (p.y > mxY) mxY = p.y; }
  const screenSpan = Math.hypot(mxX - mnX, mxY - mnY);
  const depthPx = Math.max(14, Math.min(120, screenSpan * 0.17));
  const drop = { x: 0, y: depthPx };

  const img = getStrataImage(() => { try { map.triggerRepaint(); } catch { /* ignore */ } });

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, rect.width, rect.height);
  ctx.clip();

  // BASE fill over the whole swept silhouette (footprint translated through the
  // drop) so the thin wedge between adjacent faces is soil, never a black gap.
  const block = new Path2D();
  const STEPS = 12;
  for (let k = 0; k <= STEPS; k++) {
    const dy = (drop.y * k) / STEPS;
    block.moveTo(pts[0].x, pts[0].y + dy);
    for (let i = 1; i < pts.length; i++) block.lineTo(pts[i].x, pts[i].y + dy);
    block.closePath();
  }
  ctx.save();
  ctx.clip(block, 'nonzero');
  const baseGrad = ctx.createLinearGradient(0, mnY, 0, mxY + depthPx);
  for (const [t, c] of STRATA) baseGrad.addColorStop(t, rgbShade(c, 0.68));
  ctx.fillStyle = baseGrad;
  ctx.fillRect(mnX - 4, mnY - 4, (mxX - mnX) + 8, (mxY + depthPx - mnY) + 8);
  ctx.restore();

  // Camera-facing walls, back-to-front (front faces overpaint the ones behind).
  const edges = pts
    .map((a, i) => { const b = pts[(i + 1) % pts.length]; return { a, b, y: (a.y + b.y) / 2 }; })
    .sort((l, r) => l.y - r.y);

  for (let ei = 0; ei < edges.length; ei++) {
    const { a, b } = edges[ei];
    const faceLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (faceLen < 0.5) continue;
    // Front-ness from how horizontal the top edge sits on screen → brighter face.
    const horiz = Math.abs(b.x - a.x) / faceLen;
    const shade = 0.6 + 0.4 * horiz;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.lineTo(b.x + drop.x, b.y + drop.y); ctx.lineTo(a.x + drop.x, a.y + drop.y); ctx.closePath();
    ctx.clip();

    // Photoreal strata mapped ONCE onto the wall: image width → the (tilted) top
    // edge, image height → the full drop. Depth maps identically on every face,
    // so the horizons line up at the shared corners — realistic, never wrapped.
    if (img) {
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      ctx.save();
      ctx.transform((b.x - a.x) / iw, (b.y - a.y) / iw, drop.x / ih, drop.y / ih, a.x, a.y);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    } else {
      const g = ctx.createLinearGradient(a.x, a.y, a.x + drop.x, a.y + drop.y);
      for (const [t, c] of STRATA) g.addColorStop(t, rgbShade(c, shade));
      ctx.fillStyle = g;
      ctx.fillRect(mnX - 4, mnY - 4, (mxX - mnX) + 8, (mxY + depthPx - mnY) + 8);
    }

    // Per-face lighting: darken the more side-on (vertical) faces so the block
    // reads as solid 3D volume without disturbing the strata alignment.
    ctx.fillStyle = `rgba(0,0,0,${((1 - shade) * 0.55).toFixed(3)})`;
    ctx.fillRect(mnX - 4, mnY - 4, (mxX - mnX) + 8, (mxY + depthPx - mnY) + 8);

    // Depth sheen: faint warm light at the surface, shadow pooling toward the base.
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const sheen = ctx.createLinearGradient(cx, cy, cx + drop.x, cy + drop.y);
    sheen.addColorStop(0, 'rgba(255,226,180,0.10)');
    sheen.addColorStop(0.12, 'rgba(0,0,0,0)');
    sheen.addColorStop(0.85, 'rgba(0,0,0,0.16)');
    sheen.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = sheen;
    ctx.fillRect(mnX - 4, mnY - 4, (mxX - mnX) + 8, (mxY + depthPx - mnY) + 8);
    ctx.restore();

    // Accent surface edge + grounded bottom edge.
    ctx.strokeStyle = 'rgba(110, 231, 214, 0.5)';
    ctx.lineWidth = 1.25;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x + drop.x, a.y + drop.y); ctx.lineTo(b.x + drop.x, b.y + drop.y); ctx.stroke();
  }

  // Punch the parcel footprint clear so the satellite ground shows through.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  // Crisp accent outline around the lifted top surface.
  ctx.strokeStyle = 'rgba(110, 231, 214, 0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

export function StudioMap() {
  const { twins, addTwin, updateTwin, removeTwin, duplicateTwin, undo, redo } = useTwins();
  const mapRef = React.useRef<maplibregl.Map | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [ready, setReady] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const [tool, setTool] = React.useState<Tool>('select');
  const [layer, setLayer] = React.useState<Layer>('satellite');
  const [opacity, setOpacity] = React.useState(1);
  const [isolate, setIsolate] = React.useState(false);
  const [showLabels, setShowLabels] = React.useState(true);
  const [timeIndex, setTimeIndex] = React.useState(11);
  const [cat, setCat] = React.useState<TwinCategory>('crop');
  const [pending, setPending] = React.useState<CatalogItem | null>(null);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>('twin');
  const [verts, setVerts] = React.useState<[number, number][]>([]);
  const [annotations, setAnnotations] = React.useState<Annotation[]>([]);
  const [measurePts, setMeasurePts] = React.useState<[number, number][]>([]);

  const [farms, setFarms] = React.useState<FarmProperty[] | null>(null);
  const [propertyId, setPropertyId] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const property = farms?.find((f) => f.id === propertyId) ?? null;

  const [signals, setSignals] = React.useState<SignalsState>({ kind: 'idle' });
  const [refetchTick, setRefetchTick] = React.useState(0);
  const [scanPick, setScanPick] = React.useState<Set<ScanSignal>>(() => new Set<ScanSignal>(['sar', 'moisture', 'thermal']));
  const [scanBusy, setScanBusy] = React.useState(false);
  const [scanMsg, setScanMsg] = React.useState<string | null>(null);
  const bbox = React.useMemo(() => (property ? bboxFromAoi(property) : null), [property]);
  const bboxKey = bbox ? bbox.join(',') : '';

  const propertyTwins = React.useMemo(() => (propertyId ? twins.filter((t) => t.parcelId === propertyId) : twins.filter((t) => !t.parcelId)), [twins, propertyId]);
  const sel = twins.find((t) => t.id === selected) ?? null;

  // Live refs for once-bound handlers.
  const toolRef = React.useRef(tool); toolRef.current = tool;
  const pendingRef = React.useRef(pending); pendingRef.current = pending;
  const propRef = React.useRef(propertyId); propRef.current = propertyId;
  const selRef = React.useRef(selected); selRef.current = selected;
  const twinsRef = React.useRef(twins); twinsRef.current = twins;
  const vertsRef = React.useRef<[number, number][]>([]); vertsRef.current = verts;
  // Cutaway overlay: the <canvas>, live isolate flag, the parcel ring to extrude,
  // and a redraw hook the effects can call after the map is initialised.
  const strataCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const isolateRef = React.useRef(isolate); isolateRef.current = isolate;
  const cutawayRingRef = React.useRef<[number, number][] | null>(null);
  const drawCutawayRef = React.useRef<() => void>(() => {});

  const commit = (geom: TwinGeom) => {
    const item = pendingRef.current; if (!item) return;
    const twin = makeTwinFromCatalog(item, propRef.current); twin.geom = geom;
    addTwin(twin); setSelected(twin.id); setTab('twin');
  };
  const commitRef = React.useRef(commit); commitRef.current = commit;
  const finishField = () => { const r = vertsRef.current; if (r.length >= 3 && pendingRef.current) commitRef.current({ type: 'polygon', ring: [...r] }); setVerts([]); setTool('select'); };
  const finishRow = () => { const p = vertsRef.current; if (p.length >= 2 && pendingRef.current) commitRef.current({ type: 'polyline', points: [...p] }); setVerts([]); setTool('select'); };
  const finishFieldRef = React.useRef(finishField); finishFieldRef.current = finishField;
  const finishRowRef = React.useRef(finishRow); finishRowRef.current = finishRow;

  React.useEffect(() => {
    let live = true;
    apiGet<FarmProperty[]>('/farm/farms').then((rows) => { if (!live) return; setFarms(rows); if (rows.length && !propertyId) setPropertyId(rows[0].id); }).catch(() => { if (live) setFarms([]); });
    return () => { live = false; };
  }, []);

  React.useEffect(() => {
    const el = containerRef.current; if (!el || mapRef.current) return;
    let map: maplibregl.Map;
    try { map = new maplibregl.Map({ container: el, style: SATELLITE_STYLE, center: [-93.63, 42.03], zoom: 13, attributionControl: { compact: true }, maxPitch: 68, doubleClickZoom: false }); }
    catch (e) { console.warn('[StudioMap] WebGL unavailable', e); setFailed(true); return; }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('error', (ev) => console.warn('[StudioMap] map error', ev?.error ?? ev));
    mapRef.current = map;

    // Photoreal cutaway: redraw the soil-strata slab whenever the camera moves,
    // but only while isolating a property that has a boundary ring.
    const drawCutaway = () => {
      const ring = isolateRef.current ? cutawayRingRef.current : null;
      drawStrataCutaway(map, strataCanvasRef.current, ring, propRef.current ?? '');
    };
    drawCutawayRef.current = drawCutaway;
    map.on('render', drawCutaway);
    map.on('move', drawCutaway);
    map.on('resize', drawCutaway);

    map.on('load', () => {
      for (const s of ['property', 'mask', 'twin-poly', 'twin-line', 'twin-point', 'signals', 'draft', 'measure', 'zone', 'edit-verts', 'edit-mid']) map.addSource(s, { type: 'geojson', data: EMPTY_FC });
      map.addLayer({ id: 'property-fill', type: 'fill', source: 'property', paint: { 'fill-color': '#4C7EFF', 'fill-opacity': 0.05 } });
      // Isolate mask: world fill with the property punched out — dims off-property.
      map.addLayer({ id: 'mask-fill', type: 'fill', source: 'mask', paint: { 'fill-color': '#000000', 'fill-opacity': 1 } });
      map.addLayer({ id: 'property-line', type: 'line', source: 'property', paint: { 'line-color': '#6E97FF', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });
      map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zone', paint: { 'fill-color': '#F59E0B', 'fill-opacity': 0.16 } });
      map.addLayer({ id: 'zone-line', type: 'line', source: 'zone', paint: { 'line-color': '#F59E0B', 'line-width': 1.5, 'line-dasharray': [2, 1] } });
      map.addLayer({ id: 'signals-glow', type: 'circle', source: 'signals', paint: { 'circle-radius': 9, 'circle-color': '#2DD4BF', 'circle-opacity': 0.18, 'circle-blur': 0.6 } });
      map.addLayer({ id: 'signals-dot', type: 'circle', source: 'signals', paint: { 'circle-radius': 4, 'circle-color': '#2DD4BF', 'circle-stroke-color': '#04201c', 'circle-stroke-width': 1 } });
      map.addLayer({ id: 'twin-poly-fill', type: 'fill', source: 'twin-poly', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.32 } });
      map.addLayer({ id: 'twin-poly-line', type: 'line', source: 'twin-poly', paint: { 'line-color': ['get', 'color'], 'line-width': 2 } });
      map.addLayer({ id: 'twin-line', type: 'line', source: 'twin-line', paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-dasharray': [1.5, 1] } });
      map.addLayer({ id: 'twin-point', type: 'circle', source: 'twin-point', paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      map.addLayer({ id: 'twin-label', type: 'symbol', source: 'twin-point', layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top' }, paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.2 } });
      map.addLayer({ id: 'measure-line', type: 'line', source: 'measure', filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#F59E0B', 'line-width': 2, 'line-dasharray': [2, 1] } });
      map.addLayer({ id: 'measure-pt', type: 'circle', source: 'measure', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#F59E0B', 'circle-stroke-width': 2 } });
      map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#4C7EFF', 'fill-opacity': 0.22 } });
      map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#8BB0FF', 'line-width': 2, 'line-dasharray': [1.5, 1] } });
      map.addLayer({ id: 'draft-vert', type: 'circle', source: 'draft', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#4C7EFF', 'circle-stroke-width': 2 } });
      // Boundary-edit handles: midpoints (add) + vertices (drag / right-click delete).
      map.addLayer({ id: 'edit-mid', type: 'circle', source: 'edit-mid', paint: { 'circle-radius': 4, 'circle-color': '#0b0a08', 'circle-stroke-color': '#8BB0FF', 'circle-stroke-width': 1.5, 'circle-opacity': 0.9 } });
      map.addLayer({ id: 'edit-vert', type: 'circle', source: 'edit-verts', paint: { 'circle-radius': 6, 'circle-color': '#4C7EFF', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      setReady(true); map.resize();
      (window as unknown as { __map?: maplibregl.Map }).__map = map;
    });

    const hitLayers = ['twin-poly-fill', 'twin-point', 'twin-line'];
    map.on('click', (e) => {
      const t = toolRef.current; const ll: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      if (t === 'select') { const hits = map.queryRenderedFeatures(e.point, { layers: hitLayers }); const h = hits.find((f) => f.properties && (f.properties as { id?: string }).id); setSelected(h ? String((h.properties as { id: string }).id).replace(/__c$/, '') : null); if (h) setTab('twin'); return; }
      if (t === 'place') { if (pendingRef.current) commitRef.current({ type: 'point', lng: ll[0], lat: ll[1], rotation: 0, scale: 1 }); setTool('select'); return; }
      if (t === 'row' || t === 'zone' || t === 'parcel') { setVerts((v) => [...v, ll]); return; }
      if (t === 'note' || t === 'issue' || t === 'task') { const label = window.prompt(`${t[0].toUpperCase()}${t.slice(1)} label`, t === 'issue' ? 'Issue observed' : t === 'task' ? 'Field task' : 'Note'); if (label === null) return; setAnnotations((a) => [...a, { id: `a_${Date.now()}`, lng: ll[0], lat: ll[1], label: label || 'Annotation', kind: t }]); setTool('select'); return; }
      if (t === 'measure') { setMeasurePts((p) => [...p, ll]); return; }
    });

    let start: [number, number] | null = null;
    map.on('mousedown', (e) => { const t = toolRef.current; if (t === 'rect' || t === 'circle') { e.preventDefault(); start = [e.lngLat.lng, e.lngLat.lat]; map.dragPan.disable(); } });
    map.on('mousemove', (e) => {
      const t = toolRef.current; if (!start || (t !== 'rect' && t !== 'circle')) return;
      const cur: [number, number] = [e.lngLat.lng, e.lngLat.lat]; const src = map.getSource('draft') as maplibregl.GeoJSONSource | undefined; if (!src) return;
      let ring: [number, number][];
      if (t === 'rect') ring = [[start[0], start[1]], [cur[0], start[1]], [cur[0], cur[1]], [start[0], cur[1]], [start[0], start[1]]];
      else { const cx = (start[0] + cur[0]) / 2, cy = (start[1] + cur[1]) / 2; ring = circlePolygon([cx, cy], Math.max(1, metersBetween(start, cur) / 2)); }
      src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] });
    });
    map.on('mouseup', (e) => {
      const t = toolRef.current; if (!start || (t !== 'rect' && t !== 'circle')) return;
      const end: [number, number] = [e.lngLat.lng, e.lngLat.lat]; const s = start; start = null; map.dragPan.enable();
      (map.getSource('draft') as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY_FC);
      const cx = (s[0] + end[0]) / 2, cy = (s[1] + end[1]) / 2;
      const widthM = metersBetween([s[0], cy], [end[0], cy]), heightM = metersBetween([cx, s[1]], [cx, end[1]]);
      if (!pendingRef.current) return;
      if (t === 'rect') { if (widthM < 1 || heightM < 1) return; commitRef.current({ type: 'rect', center: [cx, cy], widthM, heightM, rotation: 0 }); }
      else { const rM = Math.max(widthM, heightM) / 2; if (rM < 1) return; commitRef.current({ type: 'circle', center: [cx, cy], radiusM: rM }); }
      setTool('select');
    });

    // ---- freehand boundary: drag to trace any organic parcel shape ----------
    let freePts: [number, number][] | null = null;
    const freeMinDeg = 0.00004; // ~4-5 m — sample cadence so the ring isn't dense
    map.on('mousedown', (e) => {
      if (toolRef.current !== 'freehand') return;
      e.preventDefault(); freePts = [[e.lngLat.lng, e.lngLat.lat]]; map.dragPan.disable();
    });
    map.on('mousemove', (e) => {
      if (!freePts || toolRef.current !== 'freehand') return;
      const p: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      const last = freePts[freePts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < freeMinDeg) return;
      freePts.push(p);
      const src = map.getSource('draft') as maplibregl.GeoJSONSource | undefined;
      const ring = freePts.length >= 3 ? [...freePts, freePts[0]] : freePts;
      src?.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: freePts.length >= 3 ? { type: 'Polygon', coordinates: [ring] } : { type: 'LineString', coordinates: freePts } }] });
    });
    const endFree = () => {
      if (!freePts) return;
      const pts = freePts; freePts = null; map.dragPan.enable();
      (map.getSource('draft') as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY_FC);
      if (pts.length >= 3 && pendingRef.current) commitRef.current({ type: 'polygon', ring: pts });
      setTool('select');
    };
    map.on('mouseup', endFree);

    let dragId: string | null = null, dragLast: [number, number] | null = null;
    map.on('mousedown', (e) => {
      if (toolRef.current !== 'select' || !selRef.current) return;
      const hits = map.queryRenderedFeatures(e.point, { layers: hitLayers });
      const h = hits.find((f) => f.properties && String((f.properties as { id: string }).id).replace(/__c$/, '') === selRef.current);
      if (!h) return; e.preventDefault(); dragId = selRef.current; dragLast = [e.lngLat.lng, e.lngLat.lat]; map.dragPan.disable(); map.getCanvas().style.cursor = 'grabbing';
    });
    map.on('mousemove', (e) => {
      if (!dragId || !dragLast) return; const cur: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      const dLng = cur[0] - dragLast[0], dLat = cur[1] - dragLast[1]; dragLast = cur;
      const t = twinsRef.current.find((x) => x.id === dragId); if (t) updateTwin(dragId, { geom: translate(t.geom, dLng, dLat) });
    });
    const endDrag = () => { if (dragId) { dragId = null; dragLast = null; map.dragPan.enable(); map.getCanvas().style.cursor = ''; } };
    map.on('mouseup', endDrag); map.on('mouseout', endDrag);

    // ---- boundary vertex editing (edit tool) — precise, always-available -----
    const ringOf = (t: Twin | undefined): [number, number][] | null => t?.geom.type === 'polygon' ? t.geom.ring : t?.geom.type === 'polyline' ? t.geom.points : null;
    const setRing = (id: string, ring: [number, number][]) => { const t = twinsRef.current.find((x) => x.id === id); if (!t) return; if (t.geom.type === 'polygon') updateTwin(id, { geom: { ...t.geom, ring } }); else if (t.geom.type === 'polyline') updateTwin(id, { geom: { ...t.geom, points: ring } }); };
    let editIdx: number | null = null;
    map.on('mousedown', (e) => {
      if (toolRef.current !== 'edit' || !selRef.current) return;
      const h = map.queryRenderedFeatures(e.point, { layers: ['edit-vert'] })[0];
      if (!h || (h.properties as { idx?: number })?.idx == null) return;
      e.preventDefault(); editIdx = Number((h.properties as { idx: number }).idx); map.dragPan.disable();
    });
    map.on('mousemove', (e) => {
      if (editIdx == null || !selRef.current) return;
      const ring = ringOf(twinsRef.current.find((x) => x.id === selRef.current)); if (!ring) return;
      setRing(selRef.current, ring.map((p, i) => (i === editIdx ? [e.lngLat.lng, e.lngLat.lat] as [number, number] : p)));
    });
    const endEdit = () => { if (editIdx != null) { editIdx = null; map.dragPan.enable(); } };
    map.on('mouseup', endEdit); map.on('mouseout', endEdit);
    map.on('click', (e) => {
      if (toolRef.current !== 'edit' || !selRef.current) return;
      const mid = map.queryRenderedFeatures(e.point, { layers: ['edit-mid'] })[0];
      if (!mid || (mid.properties as { idx?: number })?.idx == null) return;
      const ring = ringOf(twinsRef.current.find((x) => x.id === selRef.current)); if (!ring) return;
      const idx = Number((mid.properties as { idx: number }).idx);
      setRing(selRef.current, [...ring.slice(0, idx + 1), [e.lngLat.lng, e.lngLat.lat] as [number, number], ...ring.slice(idx + 1)]);
    });
    map.on('contextmenu', (e) => {
      if (toolRef.current !== 'edit' || !selRef.current) return;
      const v = map.queryRenderedFeatures(e.point, { layers: ['edit-vert'] })[0];
      if (!v || (v.properties as { idx?: number })?.idx == null) return;
      e.preventDefault();
      const ring = ringOf(twinsRef.current.find((x) => x.id === selRef.current)); if (!ring || ring.length <= 3) return;
      const idx = Number((v.properties as { idx: number }).idx);
      setRing(selRef.current, ring.filter((_, i) => i !== idx));
    });

    map.on('dblclick', (e) => {
      const t = toolRef.current;
      if (t === 'parcel' && vertsRef.current.length >= 3) { e.preventDefault(); finishFieldRef.current(); }
      else if ((t === 'row' || t === 'zone') && vertsRef.current.length >= 2) { e.preventDefault(); t === 'zone' ? setVerts([]) : finishRowRef.current(); }
      else if (t === 'measure') setMeasurePts([]);
    });
    map.on('contextmenu', (e) => { const t = toolRef.current; if (['field', 'row', 'zone', 'parcel'].includes(t)) { e.preventDefault(); setVerts((v) => v.slice(0, -1)); } });
    return () => { try { map.remove(); } catch { /* ignore */ } mapRef.current = null; };
  }, []);

  // Keyboard: twin ops + draw finish/cancel.
  React.useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tg = ev.target as HTMLElement | null;
      if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
      const meta = ev.ctrlKey || ev.metaKey;
      if (meta && ev.key.toLowerCase() === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); }
      else if (meta && (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey))) { ev.preventDefault(); redo(); }
      else if (meta && ev.key.toLowerCase() === 'd' && selRef.current) { ev.preventDefault(); duplicateTwin(selRef.current); }
      else if ((ev.key === 'Delete') && selRef.current) { ev.preventDefault(); removeTwin(selRef.current); setSelected(null); }
      else if (ev.key === 'Enter' && toolRef.current === 'parcel') finishFieldRef.current();
      else if (ev.key === 'Enter' && toolRef.current === 'row') finishRowRef.current();
      else if (ev.key === 'Backspace' && ['field', 'row', 'zone', 'parcel'].includes(toolRef.current)) { ev.preventDefault(); setVerts((v) => v.slice(0, -1)); }
      else if (ev.key === 'Escape') { setVerts([]); setPending(null); setLibraryOpen(false); if (toolRef.current !== 'select') setTool('select'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, duplicateTwin, removeTwin]);

  React.useEffect(() => { // property boundary + fly — focus tightly on THIS parcel
    const map = mapRef.current; if (!map || !ready || !property) return;
    const b = property.boundaries;
    (map.getSource('property') as maplibregl.GeoJSONSource | undefined)?.setData(b ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: b }] } : EMPTY_FC);
    // The parcel ring the cutaway slab extrudes from (open, no closing dup).
    cutawayRingRef.current = outerRing(b);
    // Prefer a tight fit to the boundary ring (the parcel itself), not the padded AOI bbox.
    // With a boundary we frame it as a lifted 3D block (pitch + slight bearing).
    // Frame FLAT first (fitBounds mis-centers vertically when a pitch is passed,
    // pushing the parcel off-screen). The isolate effect then pitches around the
    // framed centre, which keeps the parcel put. Asymmetric bottom padding lifts
    // the block into the upper half so its cutaway walls drop into open space.
    const bounds = b ? boundaryBounds(b) : null;
    if (bounds) map.fitBounds(bounds, { padding: { top: 55, bottom: 150, left: 45, right: 45 }, maxZoom: 18, duration: 800 });
    else if (property.aoi_west != null && property.aoi_east != null && property.aoi_south != null && property.aoi_north != null) map.fitBounds([[property.aoi_west, property.aoi_south], [property.aoi_east, property.aoi_north]], { padding: 90, maxZoom: 16, duration: 900 });
    else map.flyTo({ center: aoiCenter(property), zoom: 15 });
    // Default the studio to a spotlighted single-parcel view: the operator is
    // looking at ONLY their parcel while they author twins. They can toggle it off.
    if (b) setIsolate(true);
    map.once('moveend', () => drawCutawayRef.current());
  }, [property, ready]);

  React.useEffect(() => { // isolate: mask everything outside the property
    const map = mapRef.current; if (!map || !ready) return;
    const src = map.getSource('mask') as maplibregl.GeoJSONSource | undefined; if (!src) return;
    const b = property?.boundaries;
    cutawayRingRef.current = outerRing(b);
    // In the spotlighted single-parcel view, hide POIs that sit outside the
    // parcel (the live-signal markers span the whole AOI) so only the parcel reads.
    if (map.isStyleLoaded()) for (const id of ['signals-glow', 'signals-dot']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', isolate && b ? 'none' : 'visible');
    if (!isolate || !b) {
      src.setData(EMPTY_FC);
      drawStrataCutaway(map, strataCanvasRef.current, null, ''); // clear the slab
      if (map.getPitch() > 1) map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
      return;
    }
    // Entering isolate: lift into the pitched block view once any framing move
    // has settled (avoids fighting fitBounds and keeps the parcel centred).
    const applyPitch = () => { if (map.getPitch() < 40) map.easeTo({ pitch: 56, bearing: -22, duration: 650 }); };
    if (map.isMoving()) map.once('moveend', applyPitch); else applyPitch();
    map.once('moveend', () => drawCutawayRef.current());
    map.triggerRepaint();
    const holes: [number, number][][] = b.type === 'Polygon'
      ? [b.coordinates[0] as [number, number][]]
      : b.coordinates.map((poly) => poly[0] as [number, number][]);
    // Outer ring: a large box around the property centroid (avoids the ±180
    // antimeridian span that gets culled), big enough to cover any zoomed view.
    let cx = 0, cy = 0, n = 0;
    for (const [x, y] of holes[0]) { cx += x; cy += y; n++; }
    cx /= n || 1; cy /= n || 1;
    const M = 12;
    const clampLat = (v: number) => Math.max(-85, Math.min(85, v));
    const outer: [number, number][] = [
      [cx - M, clampLat(cy - M)], [cx + M, clampLat(cy - M)],
      [cx + M, clampLat(cy + M)], [cx - M, clampLat(cy + M)], [cx - M, clampLat(cy - M)],
    ];
    src.setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [outer, ...holes] } });
  }, [isolate, property, ready]);

  React.useEffect(() => { // twins → sources
    const map = mapRef.current; if (!map || !ready) return;
    const fc = twinsToGeoJSON(propertyTwins);
    (map.getSource('twin-poly') as maplibregl.GeoJSONSource | undefined)?.setData(fc.polygons);
    (map.getSource('twin-line') as maplibregl.GeoJSONSource | undefined)?.setData(fc.lines);
    (map.getSource('twin-point') as maplibregl.GeoJSONSource | undefined)?.setData(fc.points);
  }, [propertyTwins, ready]);

  React.useEffect(() => { // draft field/row/zone/parcel
    const map = mapRef.current; if (!map || !ready) return;
    const drawing = ['row', 'parcel'].includes(tool);
    const zoneSrc = map.getSource('zone') as maplibregl.GeoJSONSource | undefined;
    const draftSrc = map.getSource('draft') as maplibregl.GeoJSONSource | undefined;
    const feats: GeoJSON.Feature[] = verts.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
    if (verts.length >= 2) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: verts } });
    if ((tool === 'parcel' || tool === 'zone') && verts.length >= 3) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...verts, verts[0]]] } });
    if (tool === 'zone') { zoneSrc?.setData(verts.length ? { type: 'FeatureCollection', features: feats } : EMPTY_FC); draftSrc?.setData(EMPTY_FC); }
    else { draftSrc?.setData(drawing && verts.length ? { type: 'FeatureCollection', features: feats } : EMPTY_FC); }
  }, [verts, tool, ready]);

  React.useEffect(() => { // measure
    const map = mapRef.current; if (!map || !ready) return;
    const feats: GeoJSON.Feature[] = measurePts.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
    if (measurePts.length >= 2) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: measurePts } });
    (map.getSource('measure') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: feats });
  }, [measurePts, ready]);

  // Boundary-edit handles for the selected polygon/line twin.
  React.useEffect(() => {
    const map = mapRef.current; if (!map || !ready) return;
    const vSrc = map.getSource('edit-verts') as maplibregl.GeoJSONSource | undefined;
    const mSrc = map.getSource('edit-mid') as maplibregl.GeoJSONSource | undefined;
    const ring = tool === 'edit' && sel ? (sel.geom.type === 'polygon' ? sel.geom.ring : sel.geom.type === 'polyline' ? sel.geom.points : null) : null;
    if (!ring) { vSrc?.setData(EMPTY_FC); mSrc?.setData(EMPTY_FC); return; }
    vSrc?.setData({ type: 'FeatureCollection', features: ring.map((p, i) => ({ type: 'Feature', properties: { idx: i }, geometry: { type: 'Point', coordinates: p } })) });
    const n = ring.length, segs = sel!.geom.type === 'polygon' ? n : n - 1; const mids: GeoJSON.Feature[] = [];
    for (let i = 0; i < segs; i++) { const a = ring[i], b = ring[(i + 1) % n]; mids.push({ type: 'Feature', properties: { idx: i }, geometry: { type: 'Point', coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] } }); }
    mSrc?.setData({ type: 'FeatureCollection', features: mids });
  }, [tool, sel, twins, ready]);

  React.useEffect(() => { const map = mapRef.current; if (!map || !ready || !map.isStyleLoaded()) return; for (const [k, v] of Object.entries(LAYER_PAINT[layer])) map.setPaintProperty('esri', k, v as number); map.setPaintProperty('esri', 'raster-opacity', opacity); }, [layer, opacity, ready]);
  React.useEffect(() => { const map = mapRef.current; if (!map || !ready || !map.isStyleLoaded()) return; map.setLayoutProperty('twin-label', 'visibility', showLabels ? 'visible' : 'none'); }, [showLabels, ready]);
  React.useEffect(() => { const map = mapRef.current; if (!map || !ready) return; map.getCanvas().style.cursor = tool === 'select' ? '' : 'crosshair'; setVerts([]); if (tool !== 'measure') setMeasurePts([]); }, [tool, ready]);

  // Notes markers.
  const markersRef = React.useRef<maplibregl.Marker[]>([]);
  React.useEffect(() => {
    const map = mapRef.current; if (!map || !ready) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = annotations.map((a) => { const el = document.createElement('div'); const c = a.kind === 'issue' ? '#EF4444' : a.kind === 'task' ? '#F59E0B' : '#fff'; el.style.cssText = `width:12px;height:12px;border-radius:50%;background:${c};border:2px solid #1a1410;box-shadow:0 0 0 4px ${c}40`; el.title = a.label; return new maplibregl.Marker({ element: el }).setLngLat([a.lng, a.lat]).setPopup(new maplibregl.Popup({ offset: 12, closeButton: false }).setHTML(`<div style="font:12px system-ui;color:#111">${a.label}</div>`)).addTo(map); });
  }, [annotations, ready]);

  // Live signals.
  React.useEffect(() => {
    if (!bbox) { setSignals({ kind: 'idle' }); return; }
    let live = true; setSignals({ kind: 'loading' });
    fetchSignals(bbox).then((r) => { if (!live) return; if (!r.configured) { setSignals({ kind: 'unconfigured' }); return; } setSignals({ kind: 'ready', features: r.collection.features ?? [] }); }).catch((e) => { if (live) setSignals({ kind: 'error', message: (e as Error)?.message ?? 'fetch_failed' }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bboxKey, refetchTick]);
  React.useEffect(() => { const map = mapRef.current; if (!map || !ready) return; const hide = isolate && !!property?.boundaries; const feats = (!hide && signals.kind === 'ready') ? signals.features.filter((f) => f && f.geometry) : []; (map.getSource('signals') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: feats as unknown as GeoJSON.Feature[] }); }, [signals, ready, isolate, property]);

  const pickObject = (item: CatalogItem) => {
    setPending(item); setLibraryOpen(false);
    setTool(item.defaultGeomType === 'point' ? 'place'
      : item.defaultGeomType === 'rect' ? 'rect'
      : item.defaultGeomType === 'circle' ? 'circle'
      : item.defaultGeomType === 'polygon' ? 'parcel'
      : 'row');
  };
  // Non-blocking: launch the HD-twin build (awaits only the fast 202 ack) and
  // hand it to the background runner. The 5+ minute build never blocks the UI.
  const runScanNow = async () => {
    if (!bbox || scanBusy) return; const sigs = Array.from(scanPick); if (!sigs.length) return;
    setScanBusy(true); setScanMsg(null);
    try {
      // If a polygon twin is selected, scan its refined boundary; else the property AOI.
      // launchScanJob registers the polygon via /api/aoi/from-geom, then scans the aoi_id.
      const selTwin = twins.find((t) => t.id === selected);
      const ring = selTwin?.geom.type === 'polygon' ? selTwin.geom.ring : null;
      const label = selTwin?.name ?? property?.name ?? 'Property';
      const job = await launchScanJob({ bbox, signals: sigs, ring, propertyId, twinId: selTwin?.id ?? null, label });
      if (!job) { setSignals({ kind: 'unconfigured' }); setScanMsg('Gateway not connected.'); return; }
      setScanMsg('HD twin build queued — runs in the background (~5 min).');
    } catch (e) { setScanMsg((e as Error)?.message ?? 'scan_failed'); } finally { setScanBusy(false); }
  };

  const canPlace = !!propertyId;
  const canAdvancedLayers = useHasFeature('studio.layers.advanced'); // moisture/thermal → Pro

  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg)] text-[var(--fg)]">
      <StudioHeader
        crumbs={<><a href="/studio.html?view=explorer" className="hover:text-[var(--fg)]">Studio</a><span className="mx-2 opacity-40">/</span><span className="text-[var(--fg)]">Property Map</span></>}
        right={
          <>
            <div className="hidden items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--surface)] p-0.5 text-[11px] md:flex">
              {LAYERS.map((l) => {
                const locked = (l === 'moisture' || l === 'thermal') && !canAdvancedLayers;
                return <button key={l} disabled={locked} onClick={() => { if (!locked) setLayer(l); }} title={locked ? 'Moisture & thermal layers are a Pro feature' : undefined} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 capitalize transition ${locked ? 'cursor-not-allowed text-[var(--fg-subtle)] opacity-60' : layer === l ? 'bg-[var(--accent)] text-[var(--fg-on-accent)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg)]'}`}>{l}{locked && <Lock className="size-2.5" />}</button>;
              })}
            </div>
            <div className="relative">
              <button onClick={() => setPickerOpen((v) => !v)} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--fg)] hover:border-[var(--accent)]"><Sprout className="size-3.5 text-[var(--accent)]" /> {property ? property.name : farms === null ? 'Loading…' : 'Select property'} <ChevronDown className="size-3.5 opacity-60" /></button>
              {pickerOpen && (
                <div className="absolute right-0 top-full z-40 mt-1 max-h-72 w-64 overflow-y-auto rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-popover)]">
                  {(farms ?? []).length === 0 ? <div className="px-3 py-3 text-xs text-[var(--fg-muted)]">No farms. <a href="/operations.html?view=onboard" className="text-[var(--accent)] hover:underline">Onboard →</a></div>
                    : (farms ?? []).map((f) => <button key={f.id} onClick={() => { setPropertyId(f.id); setPickerOpen(false); setSelected(null); }} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition ${f.id === propertyId ? 'bg-[color-mix(in_oklch,var(--accent)_12%,transparent)] text-[var(--fg)]' : 'text-[var(--fg-muted)] hover:bg-[var(--surface-sunken)]'}`}><MapPinned className="size-3.5 text-[var(--accent)]" /><span className="flex-1 truncate">{f.name}</span>{f.id === propertyId && <span className="text-[var(--accent)]">✓</span>}</button>)}
                </div>
              )}
            </div>
            <a href="/studio.html?view=explorer" className="inline-flex items-center gap-1 text-xs text-[var(--fg-muted)] hover:text-[var(--accent)]"><Boxes className="size-3.5" /> Explorer</a>
          </>
        }
      />

      <div className="relative flex flex-1">
        <div className="relative flex-1">
          {failed ? <div className="grid h-full min-h-[74vh] place-items-center"><div className="text-center text-[var(--fg-muted)]"><MapPinned className="mx-auto size-6" /><p className="mt-2 text-sm">Map needs WebGL, which this browser couldn't start.</p></div></div>
            : <div ref={containerRef} className="absolute inset-0" style={{ minHeight: '74vh' }} aria-label="Property placement map" />}

          {/* Photoreal soil-strata cutaway overlay — drawn on the pitched map when
              a property is isolated, so the parcel reads as a lifted 3D earth block. */}
          {!failed && <canvas ref={strataCanvasRef} className="pointer-events-none absolute inset-0 z-[4]" style={{ width: '100%', height: '100%', display: isolate && property?.boundaries ? 'block' : 'none' }} aria-hidden />}
          {!failed && isolate && property?.boundaries && (
            <div className="pointer-events-none absolute inset-0 z-[3]" style={{ background: 'radial-gradient(ellipse at 50% 44%, transparent 52%, rgba(4,5,10,0.5) 100%)' }} aria-hidden />
          )}

          {/* LEFT TOOL RAIL */}
          <div className="absolute left-3 top-1/2 z-20 -translate-y-1/2">
            <div className="flex flex-col items-center gap-0.5 rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[color-mix(in_oklch,var(--surface)_92%,transparent)] p-1.5 shadow-[var(--shadow-popover)] backdrop-blur-xl">
              <TB active={tool === 'select'} onClick={() => setTool('select')} title="Select & move" icon={MousePointer2} />
              <TB active={tool === 'edit'} onClick={() => setTool(tool === 'edit' ? 'select' : 'edit')} title="Edit boundary — drag vertices · click an edge to add · right-click to remove" icon={Waypoints} />
              <TB active={tool === 'note'} onClick={() => setTool('note')} title="Drop note" icon={StickyNote} />
              <TB active={tool === 'issue'} onClick={() => setTool('issue')} title="Mark issue" icon={TriangleAlert} />
              <TB active={tool === 'task'} onClick={() => setTool('task')} title="Assign task" icon={ListChecks} />
              <Div />
              <TB active={tool === 'measure'} onClick={() => setTool(tool === 'measure' ? 'select' : 'measure')} title="Measure (dbl-click reset)" icon={Ruler} />
              <TB active={tool === 'zone'} onClick={() => setTool(tool === 'zone' ? 'select' : 'zone')} title="Draw zone (dbl-click finish)" icon={Pentagon} />
              <TB active={tool === 'parcel'} onClick={() => { const on = tool !== 'parcel'; setTool(on ? 'parcel' : 'select'); if (on && !pending) setPending(DEFAULT_FIELD); }} title="Parcel — trace corners (click · dbl-click save). Or use ▢ ◯ ✎ for other shapes." icon={LandPlot} />
              <TB active={tool === 'freehand'} onClick={() => { const on = tool !== 'freehand'; setTool(on ? 'freehand' : 'select'); if (on && !pending) setPending(DEFAULT_FIELD); }} title="Freehand boundary — hold + drag to trace an organic parcel shape" icon={PenTool} />
              <Div />
              <TB active={libraryOpen || tool === 'place'} onClick={() => { setLibraryOpen((v) => !v); if (tool === 'place') setTool('select'); }} title="Object library" icon={Grid2x2} />
              <TB active={tool === 'rect'} onClick={() => { const on = tool !== 'rect'; setTool(on ? 'rect' : 'select'); if (on && !pending) setPending(DEFAULT_FIELD); }} title="Rectangle boundary (drag)" icon={Square} />
              <TB active={tool === 'circle'} onClick={() => { const on = tool !== 'circle'; setTool(on ? 'circle' : 'select'); if (on && !pending) setPending(DEFAULT_FIELD); }} title="Circle / pivot boundary (drag)" icon={Circle} />
              <TB active={tool === 'row'} onClick={() => setTool(tool === 'row' ? 'select' : 'row')} title="Row / line (click · dbl-click finish)" icon={Spline} />
              <TB onClick={() => selected && duplicateTwin(selected)} title="Duplicate (⌘D)" icon={Copy} />
              <TB onClick={() => { if (selected) { removeTwin(selected); setSelected(null); } }} title="Delete (Del)" icon={Trash2} />
              <TB onClick={undo} title="Undo (⌘Z)" icon={Undo2} />
              <TB onClick={redo} title="Redo (⌘⇧Z)" icon={Redo2} />
              <Div />
              <TB active={isolate} onClick={() => setIsolate((v) => !v)} title="Isolate property" icon={EyeOff} />
              <TB active={showLabels} onClick={() => setShowLabels((v) => !v)} title="Toggle labels" icon={Tag} />
              <Div />
              <TB active={tab === 'analytics'} onClick={() => setTab('analytics')} title="Analytics" icon={Sparkles} />
              <TB active={tab === 'history'} onClick={() => setTab('history')} title="History" icon={Clock} />
              <TB active={tab === 'reports'} onClick={() => setTab('reports')} title="Reports" icon={FileText} />
            </div>
            {/* opacity slider */}
            <div className="mt-2 flex flex-col items-center gap-1 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[color-mix(in_oklch,var(--surface)_92%,transparent)] p-2 backdrop-blur-xl">
              <div className="text-[8px] uppercase tracking-wider text-[var(--accent)]">Opac</div>
              <input type="range" min={0.2} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="h-20 w-1.5 accent-[var(--accent)]" style={{ writingMode: 'vertical-lr', WebkitAppearance: 'slider-vertical' } as React.CSSProperties} aria-label="Layer opacity" />
            </div>
          </div>

          {/* background HD-twin build jobs (non-blocking dock) */}
          <ScanJobsRunner onOpenTwin={(id) => { setSelected(id); setTab('twin'); const t = twinsRef.current.find((x) => x.id === id); if (t) mapRef.current?.flyTo({ center: twinCenter(t), zoom: 16 }); }} />

          {/* contextual hint */}
          {(tool !== 'select') && (
            <div className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full border border-[color-mix(in_oklch,var(--accent)_45%,transparent)] bg-[color-mix(in_oklch,var(--surface)_88%,transparent)] px-4 py-1.5 text-xs backdrop-blur-xl">
              {pending && ['place', 'rect', 'circle', 'row', 'freehand', 'parcel'].includes(tool) && <span className="text-lg">{pending.icon}</span>}
              <span className="text-[var(--accent)] capitalize">{tool === 'place' && pending ? `Place ${pending.name}` : tool === 'freehand' ? 'Freehand parcel' : tool}</span>
              <span className="text-[var(--fg-muted)]">
                {tool === 'place' ? 'click to drop'
                  : tool === 'freehand' ? 'hold + drag to trace the parcel outline'
                  : tool === 'rect' ? 'drag a rectangular boundary'
                  : tool === 'circle' ? 'drag a circular / pivot boundary'
                  : tool === 'measure' ? 'click points · dbl-click reset'
                  : tool === 'edit' ? (sel ? 'drag a vertex · click an edge dot to add · right-click a vertex to remove' : 'select a field/parcel twin first, then edit its boundary')
                  : `click corners · dbl-click / ⏎ to ${tool === 'zone' ? 'finish' : 'save'} · ⌫ undo · ${verts.length} pt`}
              </span>
              <button onClick={() => { setTool('select'); setVerts([]); }} className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[var(--fg-muted)] hover:text-[var(--fg)]">Cancel</button>
            </div>
          )}

          {/* layer opacity + no-property prompt */}
          {!canPlace && !failed && <div className="pointer-events-none absolute inset-x-0 top-20 z-10 flex justify-center"><div className="pointer-events-auto rounded-[var(--radius-xl)] border border-[var(--border)] bg-[color-mix(in_oklch,var(--surface)_92%,transparent)] px-4 py-3 text-center text-sm text-[var(--fg-muted)] shadow-[var(--shadow-popover)] backdrop-blur-xl"><Sprout className="mx-auto size-5 text-[var(--accent)]" /><div className="mt-1 font-medium text-[var(--fg)]">Select your property to begin</div></div></div>}

          {/* library drawer */}
          {libraryOpen && (
            <div className="absolute left-16 top-4 z-30 flex w-[340px] max-w-[80vw] flex-col gap-2 rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[color-mix(in_oklch,var(--surface)_96%,transparent)] p-3 shadow-[var(--shadow-popover)] backdrop-blur-xl">
              <div className="flex items-center justify-between"><div><div className="text-[10px] uppercase tracking-[0.22em] text-[var(--accent)]">Object Library</div><div className="text-sm font-medium text-[var(--fg)]">Place a digital twin</div></div><button onClick={() => setLibraryOpen(false)} className="text-[var(--fg-muted)] hover:text-[var(--fg)]"><X className="size-4" /></button></div>
              <div className="flex flex-wrap gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] p-0.5 text-[10px]">{CATS.map((c) => <button key={c} onClick={() => setCat(c)} className={`rounded-full px-2 py-0.5 transition ${cat === c ? 'bg-[var(--accent)] text-[var(--fg-on-accent)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg)]'}`}>{CATEGORY_LABEL[c].split(' ')[0]}</button>)}</div>
              <div className="grid max-h-[46vh] grid-cols-3 gap-2 overflow-y-auto">{CATALOG.filter((i) => i.category === cat).map((it) => <button key={it.kind} onClick={() => pickObject(it)} className="flex flex-col items-center gap-1 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] p-2 text-center transition hover:border-[var(--accent)]"><div className="flex size-10 items-center justify-center rounded-lg text-2xl" style={{ background: it.color + '22', border: `1px solid ${it.color}55` }}>{it.icon}</div><div className="text-[11px] font-medium leading-tight text-[var(--fg)]">{it.name}</div><div className="text-[9px] uppercase tracking-wider text-[var(--fg-subtle)]">{it.defaultGeomType}</div></button>)}</div>
            </div>
          )}

          {/* bottom: parcel strip + season timeline */}
          <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-2 px-4 pb-3">
            {propertyTwins.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">{propertyTwins.slice(0, 12).map((t) => <button key={t.id} onClick={() => { setSelected(t.id); setTab('twin'); mapRef.current?.flyTo({ center: twinCenter(t), zoom: 16 }); }} className={`shrink-0 rounded-xl border px-3 py-2 text-left text-xs backdrop-blur-xl transition ${selected === t.id ? 'border-[var(--accent)] bg-[color-mix(in_oklch,var(--surface)_90%,transparent)]' : 'border-[var(--border)] bg-[color-mix(in_oklch,var(--surface)_80%,transparent)]'}`}><div className="flex items-center gap-2"><span>{t.icon}</span><span className="font-medium text-[var(--fg)]">{t.name}</span></div><div className="mt-0.5 text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">{t.kind}{geomAreaAcres(t.geom) != null ? ` · ${geomAreaAcres(t.geom)!.toFixed(1)} ac` : ''}</div></button>)}</div>
            )}
            <div className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[color-mix(in_oklch,var(--surface)_84%,transparent)] px-4 py-2 backdrop-blur-xl">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-[var(--accent)]"><span>Season timeline</span><span className="text-[var(--fg-muted)]">{MONTHS[timeIndex]} · NDVI {NDVI_12[timeIndex].toFixed(2)}</span></div>
              <input type="range" min={0} max={11} value={timeIndex} onChange={(e) => setTimeIndex(Number(e.target.value))} className="mt-1.5 w-full accent-[var(--accent)]" />
            </div>
          </div>
        </div>

        {/* RIGHT PANEL */}
        <aside className="flex w-[360px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--surface)]" style={{ maxHeight: 'calc(100vh - 3.5rem)' }}>
          <nav className="flex gap-1 border-b border-[var(--border)] p-2 text-xs">
            {(['twin', 'reports', 'analytics', 'history'] as Tab[]).map((k) => <button key={k} onClick={() => setTab(k)} className={`rounded-full px-3 py-1.5 capitalize transition ${tab === k ? 'bg-[var(--accent)] text-[var(--fg-on-accent)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg)]'}`}>{k === 'twin' ? (sel ? 'Twin' : `Twins (${propertyTwins.length})`) : k}</button>)}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'twin' && <TwinInspector sel={sel} twins={propertyTwins} onSelect={(id) => setSelected(id)} onUpdate={updateTwin} onDelete={(id) => { removeTwin(id); setSelected(null); }} onDuplicate={duplicateTwin} onOpenLibrary={() => setLibraryOpen(true)} signals={signals} scanOpts={SCAN_OPTIONS} scanPick={scanPick} setScanPick={setScanPick} runScanNow={runScanNow} scanBusy={scanBusy} scanMsg={scanMsg} bbox={bbox} />}
            {tab === 'reports' && <ReportsPanel property={property} />}
            {tab === 'analytics' && <AnalyticsPanel />}
            {tab === 'history' && <HistoryPanel timeIndex={timeIndex} setTimeIndex={setTimeIndex} annotations={annotations} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

function TB({ active, onClick, title, icon: Icon }: { active?: boolean; onClick?: () => void; title: string; icon: React.ComponentType<{ className?: string }> }) {
  return <button onClick={onClick} title={title} className={`grid size-8 place-items-center rounded-[var(--radius-lg)] transition ${active ? 'bg-[var(--accent)] text-[var(--fg-on-accent)]' : 'text-[var(--fg-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--fg)]'}`}><Icon className="size-4" /></button>;
}
function Div() { return <div className="my-1 h-px w-5 bg-[var(--border)]" />; }

function TwinInspector({ sel, twins, onSelect, onUpdate, onDelete, onDuplicate, onOpenLibrary, signals, scanOpts, scanPick, setScanPick, runScanNow, scanBusy, scanMsg, bbox }: {
  sel: Twin | null; twins: Twin[]; onSelect: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<Twin>) => void; onDelete: (id: string) => void; onDuplicate: (id: string) => void; onOpenLibrary: () => void;
  signals: SignalsState; scanOpts: { id: ScanSignal; label: string }[]; scanPick: Set<ScanSignal>; setScanPick: React.Dispatch<React.SetStateAction<Set<ScanSignal>>>; runScanNow: () => void; scanBusy: boolean; scanMsg: string | null; bbox: [number, number, number, number] | null;
}) {
  if (!sel) {
    return (
      <div className="p-4">
        <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold text-[var(--fg)]">Digital twins</h3><button onClick={onOpenLibrary} className="rounded-full bg-[var(--accent)] px-3 py-1 text-[11px] font-semibold text-[var(--fg-on-accent)]">+ Add twin</button></div>
        {/* live signals for the property */}
        <SignalsCard signals={signals} bbox={bbox} scanOpts={scanOpts} scanPick={scanPick} setScanPick={setScanPick} runScanNow={runScanNow} scanBusy={scanBusy} scanMsg={scanMsg} />
        <div className="mt-3 text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">On this property · {twins.length}</div>
        {twins.length === 0 ? <div className="mt-2 rounded-[var(--radius-lg)] border border-dashed border-[var(--border)] p-6 text-center text-xs text-[var(--fg-muted)]">No twins yet. Open the object library and draw one.</div>
          : <ul className="mt-2 space-y-1.5">{twins.map((t) => <li key={t.id}><button onClick={() => onSelect(t.id)} className="flex w-full items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-2 text-left hover:border-[var(--accent)]"><span className="flex size-8 items-center justify-center rounded-md text-lg" style={{ background: t.color + '22', border: `1px solid ${t.color}55` }}>{t.icon}</span><span className="flex-1"><span className="block text-sm text-[var(--fg)]">{t.name}</span><span className="block text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">{CATEGORY_LABEL[t.category]} · {t.kind}</span></span><span className={`h-2 w-2 rounded-full ${t.status.online ? 'bg-[var(--risk-healthy)]' : 'bg-[var(--fg-subtle)]'}`} /></button></li>)}</ul>}
      </div>
    );
  }
  const t = sel; const g = t.geom;
  const num = (label: string, value: number, on: (v: number) => void) => <label className="flex flex-col gap-1 text-[11px]"><span className="uppercase tracking-wider text-[var(--fg-subtle)]">{label}</span><input type="number" value={Number.isFinite(value) ? value : 0} step={0.1} onChange={(e) => on(Number(e.target.value))} className="rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1 text-sm text-[var(--fg)]" /></label>;
  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2"><button onClick={() => onSelect(null)} className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)]">← All</button><a href={`/studio.html?twin=${t.id}`} className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline">Full detail <ExternalLink className="size-3" /></a></div>
      <div className="mb-3 flex items-start gap-3 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
        <div className="flex size-12 items-center justify-center rounded-lg text-2xl" style={{ background: t.color + '22', border: `1px solid ${t.color}55` }}>{t.icon}</div>
        <div className="flex-1"><input value={t.name} onChange={(e) => onUpdate(t.id, { name: e.target.value })} className="w-full bg-transparent text-base font-medium text-[var(--fg)] outline-none" /><div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">{CATEGORY_LABEL[t.category]} · {t.kind} · {g.type}{geomAreaAcres(g) != null ? ` · ${geomAreaAcres(g)!.toFixed(1)} ac` : ''}</div></div>
      </div>
      <div className="mb-3 grid grid-cols-3 gap-1">
        <button onClick={() => onDuplicate(t.id)} className="rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1 text-[11px] text-[var(--fg)] hover:border-[var(--accent)]">Duplicate</button>
        <button onClick={() => onDelete(t.id)} className="rounded-md border border-[color-mix(in_oklch,var(--risk-critical)_40%,transparent)] bg-[color-mix(in_oklch,var(--risk-critical-fill)_40%,transparent)] px-2 py-1 text-[11px] text-[var(--risk-critical)]">Delete</button>
        <label className="flex items-center justify-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1 text-[11px] text-[var(--fg)]"><input type="checkbox" checked={t.status.online} onChange={(e) => onUpdate(t.id, { status: { ...t.status, online: e.target.checked } })} /> Online</label>
      </div>
      <div className="mb-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] p-2.5"><div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">Health</div><div className="mt-1 h-1.5 w-full rounded-full bg-[var(--border)]"><div className="h-full rounded-full" style={{ width: `${healthScore(t)}%`, background: t.color }} /></div></div>
      {g.type === 'rect' && <div className="mb-3 grid grid-cols-3 gap-2">{num('Width (m)', g.widthM, (v) => onUpdate(t.id, { geom: { ...g, widthM: v } }))}{num('Height (m)', g.heightM, (v) => onUpdate(t.id, { geom: { ...g, heightM: v } }))}{num('Rotation°', g.rotation, (v) => onUpdate(t.id, { geom: { ...g, rotation: v } }))}</div>}
      {g.type === 'circle' && <div className="mb-3">{num('Radius (m)', g.radiusM, (v) => onUpdate(t.id, { geom: { ...g, radiusM: v } }))}</div>}
      {g.type === 'point' && <div className="mb-3 grid grid-cols-2 gap-2">{num('Scale', g.scale, (v) => onUpdate(t.id, { geom: { ...g, scale: v } }))}{num('Rotation°', g.rotation, (v) => onUpdate(t.id, { geom: { ...g, rotation: v } }))}</div>}
      {t.status.readings.length > 0 && <div className="mb-3"><div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">Live readings</div><div className="grid grid-cols-2 gap-1">{t.status.readings.map((r, i) => <div key={i} className="rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1 text-xs"><div className="text-[9px] uppercase tracking-wider text-[var(--fg-subtle)]">{r.label}</div><div className="text-[var(--fg)]">{r.value}{r.unit && <span className="ml-1 text-[var(--fg-muted)]">{r.unit}</span>}</div></div>)}</div></div>}
      <a href={`/studio.html?twin=${t.id}`} className="block rounded-md bg-[var(--accent)] px-3 py-2 text-center text-xs font-semibold text-[var(--fg-on-accent)]">Edit specs · maintenance · docs →</a>
    </div>
  );
}

function SignalsCard({ signals, bbox, scanOpts, scanPick, setScanPick, runScanNow, scanBusy, scanMsg }: { signals: SignalsState; bbox: [number, number, number, number] | null; scanOpts: { id: ScanSignal; label: string }[]; scanPick: Set<ScanSignal>; setScanPick: React.Dispatch<React.SetStateAction<Set<ScanSignal>>>; runScanNow: () => void; scanBusy: boolean; scanMsg: string | null }) {
  const count = signals.kind === 'ready' ? signals.features.length : 0;
  const canHd = useHasFeature('studio.scan.hd'); // on-demand HD EO scan → Pro
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
      <div className="flex items-center justify-between"><div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-[var(--fg-muted)]"><Activity className="size-3.5 text-[var(--risk-healthy)]" /> Live signals</div>{signals.kind === 'loading' ? <Loader2 className="size-3.5 animate-spin text-[var(--fg-subtle)]" /> : signals.kind === 'ready' && <span className="rounded-full bg-[color-mix(in_oklch,var(--risk-healthy-fill)_60%,transparent)] px-2 py-0.5 text-[10px] font-medium text-[var(--risk-healthy)] tabular-nums">{count}</span>}</div>
      <div className="mt-1.5 text-[11px] text-[var(--fg-muted)]">{!bbox ? 'No AOI on this property.' : signals.kind === 'unconfigured' ? 'Connect the AlphaGeo gateway for live signals.' : signals.kind === 'error' ? `Error: ${signals.message}` : signals.kind === 'ready' && count === 0 ? 'No signals yet — run a scan.' : signals.kind === 'ready' ? `${count} signal(s) over this property.` : 'Loading…'}</div>
      <div className="mt-2 flex flex-wrap gap-1">{scanOpts.map((o) => { const on = scanPick.has(o.id); return <button key={o.id} onClick={() => setScanPick((p) => { const n = new Set(p); n.has(o.id) ? n.delete(o.id) : n.add(o.id); return n; })} className={`rounded-full border px-2 py-0.5 text-[11px] transition ${on ? 'border-[var(--accent)] bg-[color-mix(in_oklch,var(--accent)_14%,transparent)] text-[var(--fg)]' : 'border-[var(--border)] text-[var(--fg-muted)]'}`}>{o.label}</button>; })}</div>
      {canHd
        ? <button onClick={runScanNow} disabled={!bbox || scanBusy || scanPick.size === 0} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--fg-on-accent)] hover:brightness-110 disabled:opacity-40">{scanBusy ? <><Loader2 className="size-3.5 animate-spin" /> Queuing…</> : <><Satellite className="size-3.5" /> Build HD twin</>}</button>
        : <a href="/operations.html?view=billing" title="On-demand HD scans are a Pro feature" className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-[color-mix(in_oklch,var(--accent)_40%,transparent)] bg-[color-mix(in_oklch,var(--accent)_10%,transparent)] px-3 py-1.5 text-xs font-semibold text-[var(--fg)] hover:brightness-110"><Satellite className="size-3.5 text-[var(--accent)]" /> Build HD twin <UpsellPill tier="Pro" /></a>}
      {scanMsg && <div className="mt-1.5 text-[10px] text-[var(--fg-subtle)]">{scanMsg}</div>}
    </div>
  );
}

// Portfolio-level families roll up as the executive-monthly report; the rest are
// field reports. Both map onto the two kinds the /farm/reports/generate engine
// supports today; richer per-recipe generation (Meridian render) wraps in later.
function reportKind(r: ReportDef): 'field' | 'executive-monthly' {
  return r.family === 'executive' || r.family === 'grocery-compliance' ? 'executive-monthly' : 'field';
}

function ReportRow({ r, liveCaps, farmId }: { r: ReportDef; liveCaps: Set<string>; farmId: string | null }) {
  const unlocked = useHasFeature(r.feature);
  const roadmap = !reportIsLive(r, liveCaps);
  const [state, setState] = React.useState<'idle' | 'busy' | 'done' | 'scheduled' | 'error'>('idle');
  const [msg, setMsg] = React.useState<string | null>(null);

  const generate = async () => {
    if (!farmId) { setState('error'); setMsg('Select a property first.'); return; }
    setState('busy'); setMsg(null);
    try {
      const row = await apiPost<{ id: string; summary?: string }>('/farm/reports/generate', { farm_id: farmId, type: reportKind(r) });
      setState('done'); setMsg(row.summary ? row.summary.slice(0, 120) : 'Report generated.');
    } catch (e) { setState('error'); setMsg(e instanceof Error ? e.message : 'Generate failed.'); }
  };
  const schedule = async () => {
    if (!farmId) { setState('error'); setMsg('Select a property first.'); return; }
    try {
      await apiPost('/farm/reports/schedule', { farm_id: farmId, report_type: reportKind(r), cadence: 'weekly' });
      setState('scheduled'); setMsg('Scheduled weekly — runs automatically.');
    } catch (e) { setState('error'); setMsg(e instanceof Error ? e.message : 'Schedule failed.'); }
  };

  return (
    <li className="flex flex-col gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm text-[var(--fg)]">{r.name}{r.tier !== 'Basic' && !unlocked && <UpsellPill tier={r.tier as 'Pro' | 'Business'} />}</div>
          <div className="truncate text-[11px] text-[var(--fg-muted)]">{r.fear}</div>
        </div>
        {roadmap
          ? <span className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--fg-subtle)]" title={`Lights up when the ${r.buildability} capability lands`}>Soon</span>
          : unlocked
            ? <div className="flex shrink-0 items-center gap-1">
                <button onClick={generate} disabled={state === 'busy'} className="rounded-full border border-[var(--accent)] bg-[color-mix(in_oklch,var(--accent)_10%,transparent)] px-3 py-1 text-[11px] text-[var(--fg)] hover:brightness-110 disabled:opacity-50">{state === 'busy' ? 'Generating…' : state === 'done' ? 'Regenerate' : 'Generate'}</button>
                <button onClick={schedule} title="Schedule weekly" className="grid size-6 place-items-center rounded-full border border-[var(--border)] text-[var(--fg-muted)] hover:border-[var(--accent)] hover:text-[var(--fg)]"><Clock className="size-3" /></button>
              </div>
            : <a href="/operations.html?view=billing" className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1 text-[11px] text-[var(--fg-muted)]">Upgrade</a>}
      </div>
      {msg && <div className={`text-[10px] ${state === 'error' ? 'text-[var(--risk-critical)]' : state === 'done' || state === 'scheduled' ? 'text-[var(--risk-healthy)]' : 'text-[var(--fg-subtle)]'}`}>{state === 'done' ? '✓ ' : state === 'scheduled' ? '✓ ' : ''}{msg}</div>}
    </li>
  );
}

function ReportsPanel({ property }: { property: FarmProperty | null }) {
  // Auto-grow LIVE reports from the gateway's self-describing capability menu.
  // Graceful: until the menu is reachable it returns empty and we show the static
  // LIVE set (see gateway-surface.ts).
  const [liveCaps, setLiveCaps] = React.useState<Set<string>>(() => new Set());
  React.useEffect(() => {
    let live = true;
    fetchSurfaceMenu().then((m) => { if (live && m.available) setLiveCaps(m.capabilities); }).catch(() => { /* fall back to static */ });
    return () => { live = false; };
  }, []);
  return (
    <div className="p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Reports</h3>
        <a href="/operations.html" className="text-xs text-[var(--accent)]">Farm detail →</a>
      </div>
      <ul className="space-y-2">{REPORTS.map((r) => <ReportRow key={r.id} r={r} liveCaps={liveCaps} farmId={property?.id ?? null} />)}</ul>
      <div className="mt-4 rounded-[var(--radius-lg)] border border-dashed border-[var(--border)] p-3 text-[11px] text-[var(--fg-muted)]">
        <span className="font-medium text-[var(--fg)]">{TOTAL_PLANNED} reports</span> across {REPORT_FAMILIES.length} intelligence families — executive, operations, crop, water, disease, supply-chain, grocery compliance, financial, risk & predictive — light up as each capability lands and by your plan tier.
      </div>
    </div>
  );
}
function AnalyticsPanel() {
  const cards = [{ t: 'NDVI · 12mo', v: '0.66', d: '▲ 0.03', data: NDVI_12, tone: 'var(--risk-healthy)' }, { t: 'Moisture · 12mo', v: '22%', d: 'stable', data: [22, 24, 21, 19, 18, 20, 23, 25, 24, 22, 21, 22], tone: 'var(--accent)' }, { t: 'Yield idx · 12mo', v: '184', d: '▲ 3.2%', data: [155, 158, 162, 160, 164, 168, 172, 175, 178, 180, 182, 184], tone: 'var(--risk-stress)' }];
  const spark = (data: number[], tone: string) => { const w = 200, h = 34, mn = Math.min(...data), mx = Math.max(...data); const pts = data.map((d, i) => `${(i / (data.length - 1)) * w},${h - ((d - mn) / (mx - mn || 1)) * h}`).join(' L '); return <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 h-8 w-full"><path d={`M ${pts}`} stroke={tone} strokeWidth="1.5" fill="none" /></svg>; };
  return <div className="p-4"><h3 className="mb-3 text-sm font-semibold text-[var(--fg)]">Analytics</h3><div className="space-y-3">{cards.map((c) => <div key={c.t} className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3"><div className="flex items-baseline justify-between"><div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">{c.t}</div><div className="text-[11px] text-[var(--accent)]">{c.d}</div></div><div className="text-2xl font-semibold text-[var(--fg)]">{c.v}</div>{spark(c.data, c.tone)}</div>)}</div></div>;
}
function HistoryPanel({ timeIndex, setTimeIndex, annotations }: { timeIndex: number; setTimeIndex: (n: number) => void; annotations: Annotation[] }) {
  const events = [{ m: 2, t: 'Planting', by: 'crew' }, { m: 4, t: 'Fertigation pass', by: 'plan' }, { m: 7, t: 'NDVI peak', by: 'system' }, { m: 9, t: 'Harvest window', by: 'copilot' }];
  return <div className="p-4"><h3 className="mb-3 text-sm font-semibold text-[var(--fg)]">History</h3><div className="mb-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3"><div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">Season scrubber</div><input type="range" min={0} max={11} value={timeIndex} onChange={(e) => setTimeIndex(Number(e.target.value))} className="mt-2 w-full accent-[var(--accent)]" /><div className="mt-1 text-xs text-[var(--fg-muted)]">Viewing <span className="text-[var(--fg)]">{MONTHS[timeIndex]}</span></div></div><ol className="relative ml-2 border-l border-[var(--border)]">{events.map((e, i) => <li key={i} className="mb-4 ml-4"><span className={`absolute -left-1.5 mt-1 size-3 rounded-full border-2 border-[var(--surface)] ${e.m <= timeIndex ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'}`} /><div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">{MONTHS[e.m]}</div><div className="text-sm text-[var(--fg)]">{e.t}</div><div className="text-[11px] text-[var(--fg-muted)]">{e.by}</div></li>)}</ol><div className="mt-2 text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">Annotations ({annotations.length})</div><ul className="mt-1 space-y-1 text-sm">{annotations.map((a) => <li key={a.id} className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2"><span className="text-[var(--fg)]">{a.label}</span><span className="text-[10px] text-[var(--fg-subtle)]">{a.kind}</span></li>)}</ul></div>;
}
