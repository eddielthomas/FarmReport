// =============================================================================
// twins-store.ts — Digital Twin Studio store (ported from the Farm Report AI
// concept prototype, re-homed into the Report.Farm app).
// -----------------------------------------------------------------------------
// A twin is a farm asset digitized as a manageable object: a structure, a piece
// of equipment, a crop bed, a livestock group or a water asset. Each twin holds
// geometry, live telemetry, a maintenance timeline, docs, and (progressively)
// calendar/routines/yields/treatments/etc.
//
// Persistence is client-side (localStorage) for the workspace layer — this is
// the operator's private twin library. Field geometry + observations come from
// the farm.* API; the enterprise wiring to /api/farm/* + the AlphaGeo gateway
// twin surface lands per docs/08_DIGITAL_TWIN_INTEGRATION_PLAN.md.
// =============================================================================

import { useCallback, useSyncExternalStore } from 'react';

export type TwinCategory =
  | 'structure' | 'equipment' | 'crop' | 'field' | 'livestock' | 'water' | 'infra';

export type TwinGeom =
  | { type: 'point'; lng: number; lat: number; rotation: number; scale: number }
  | { type: 'rect'; center: [number, number]; widthM: number; heightM: number; rotation: number }
  | { type: 'circle'; center: [number, number]; radiusM: number }
  | { type: 'polyline'; points: [number, number][] }
  // An operator-drawn, accurate parcel/field boundary (ring of [lng,lat]).
  | { type: 'polygon'; ring: [number, number][] };

export type MaintenanceEntry = { id: string; date: string; type: string; notes: string };
export type TwinDoc = { id: string; name: string; url?: string; note?: string };

export type CalendarEvent = {
  id: string;
  date: string;
  time?: string;
  title: string;
  kind: 'task' | 'scan' | 'treatment' | 'harvest' | 'maintenance' | 'note';
  notes?: string;
  done?: boolean;
};

export type Routine = {
  id: string;
  name: string;
  cadence: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'seasonal';
  dayOfWeek?: number;
  timeOfDay?: string;
  action: string;
  active: boolean;
  lastRun?: string;
};

export type YieldRecord = {
  id: string;
  season: string;
  crop?: string;
  quantity: number;
  unit: string;
  quality?: string;
  harvestDate?: string;
  notes?: string;
};

export type Treatment = {
  id: string;
  date: string;
  category: 'fertilizer' | 'pesticide' | 'herbicide' | 'fungicide' | 'irrigation' | 'other';
  product: string;
  rate?: string;
  area?: string;
  applicator?: string;
  reentryHours?: number;
  notes?: string;
};

export type Reading = { label: string; value: string; unit?: string };

export type Twin = {
  id: string;
  name: string;
  category: TwinCategory;
  kind: string;
  icon: string;
  color: string;
  parcelId: string | null;
  geom: TwinGeom;
  specs: { sizeLabel?: string; installDate?: string; costUsd?: number; vendor?: string; notes?: string };
  status: { online: boolean; readings: Reading[] };
  maintenance: MaintenanceEntry[];
  docs: TwinDoc[];
  linkedTwinIds: string[];
  events?: CalendarEvent[];
  routines?: Routine[];
  yields?: YieldRecord[];
  treatments?: Treatment[];
  createdAt: number;
  updatedAt: number;
};

export type CatalogItem = {
  kind: string;
  category: TwinCategory;
  name: string;
  icon: string;
  color: string;
  defaultGeomType: TwinGeom['type'];
  defaultSize?: { widthM?: number; heightM?: number; radiusM?: number };
  sampleReadings?: Reading[];
};

// Farm-native object library — what an operator can twin. Colors are per-object
// identity accents. Grouped to cover the common surface of farm management:
// buildings, machinery, crops/beds, land zones, livestock, water, and access.
export const CATALOG: CatalogItem[] = [
  // ---- Structures --------------------------------------------------------
  { kind: 'barn', category: 'structure', name: 'Barn', icon: '🏚️', color: '#8B5A3C', defaultGeomType: 'rect', defaultSize: { widthM: 30, heightM: 15 } },
  { kind: 'silo', category: 'structure', name: 'Grain Silo', icon: '🏗️', color: '#A8A29E', defaultGeomType: 'circle', defaultSize: { radiusM: 6 } },
  { kind: 'grainbin', category: 'structure', name: 'Grain Bin', icon: '🫙', color: '#B7B0A5', defaultGeomType: 'circle', defaultSize: { radiusM: 5 }, sampleReadings: [{ label: 'Fill', value: '61', unit: '%' }, { label: 'Grain temp', value: '14', unit: '°C' }] },
  { kind: 'shed', category: 'structure', name: 'Machine Shed', icon: '🛖', color: '#B08968', defaultGeomType: 'rect', defaultSize: { widthM: 18, heightM: 10 } },
  { kind: 'workshop', category: 'structure', name: 'Workshop', icon: '🔧', color: '#9A8478', defaultGeomType: 'rect', defaultSize: { widthM: 12, heightM: 9 } },
  { kind: 'greenhouse', category: 'structure', name: 'Greenhouse', icon: '🌿', color: '#7BB661', defaultGeomType: 'rect', defaultSize: { widthM: 20, heightM: 8 } },
  { kind: 'packhouse', category: 'structure', name: 'Pack House', icon: '📦', color: '#C89B3C', defaultGeomType: 'rect', defaultSize: { widthM: 24, heightM: 16 } },
  { kind: 'coldstore', category: 'structure', name: 'Cold Storage', icon: '❄️', color: '#5AB0D6', defaultGeomType: 'rect', defaultSize: { widthM: 16, heightM: 12 }, sampleReadings: [{ label: 'Temp', value: '2', unit: '°C' }, { label: 'RH', value: '90', unit: '%' }] },
  { kind: 'inputstore', category: 'structure', name: 'Input Store', icon: '🧪', color: '#B06AB3', defaultGeomType: 'rect', defaultSize: { widthM: 10, heightM: 8 } },
  { kind: 'fueldepot', category: 'structure', name: 'Fuel Depot', icon: '⛽', color: '#C4632F', defaultGeomType: 'rect', defaultSize: { widthM: 8, heightM: 6 }, sampleReadings: [{ label: 'Diesel', value: '3,400', unit: 'L' }] },
  { kind: 'farmhouse', category: 'structure', name: 'Farmhouse', icon: '🏡', color: '#C77D5E', defaultGeomType: 'rect', defaultSize: { widthM: 14, heightM: 12 } },
  { kind: 'office', category: 'structure', name: 'Farm Office', icon: '🏢', color: '#7E8CA3', defaultGeomType: 'rect', defaultSize: { widthM: 10, heightM: 8 } },
  { kind: 'scalehouse', category: 'structure', name: 'Scale House', icon: '⚖️', color: '#8A8F98', defaultGeomType: 'rect', defaultSize: { widthM: 6, heightM: 4 } },
  { kind: 'solararray', category: 'structure', name: 'Solar Array', icon: '🔆', color: '#EAB308', defaultGeomType: 'rect', defaultSize: { widthM: 20, heightM: 12 }, sampleReadings: [{ label: 'Output', value: '18.4', unit: 'kW' }] },

  // ---- Equipment ---------------------------------------------------------
  { kind: 'tractor', category: 'equipment', name: 'Tractor', icon: '🚜', color: '#4C9F70', defaultGeomType: 'point', sampleReadings: [{ label: 'Engine hrs', value: '1,240', unit: 'h' }, { label: 'Fuel', value: '68', unit: '%' }] },
  { kind: 'combine', category: 'equipment', name: 'Combine', icon: '🌾', color: '#C6972F', defaultGeomType: 'point', sampleReadings: [{ label: 'Engine hrs', value: '860', unit: 'h' }, { label: 'Yield', value: '58', unit: 'bu/ac' }] },
  { kind: 'planter', category: 'equipment', name: 'Planter', icon: '🌱', color: '#5FA052', defaultGeomType: 'point', sampleReadings: [{ label: 'Rows', value: '24' }, { label: 'Pop.', value: '34k', unit: '/ac' }] },
  { kind: 'sprayer', category: 'equipment', name: 'Sprayer', icon: '💦', color: '#4DA3C7', defaultGeomType: 'point', sampleReadings: [{ label: 'Tank', value: '55', unit: '%' }, { label: 'Boom', value: '120', unit: 'ft' }] },
  { kind: 'baler', category: 'equipment', name: 'Baler', icon: '🧺', color: '#B79A5B', defaultGeomType: 'point', sampleReadings: [{ label: 'Bales', value: '146' }] },
  { kind: 'pivot', category: 'equipment', name: 'Center Pivot', icon: '💧', color: '#5B8DEF', defaultGeomType: 'circle', defaultSize: { radiusM: 200 }, sampleReadings: [{ label: 'Flow', value: '820', unit: 'gpm' }, { label: 'Angle', value: '142', unit: '°' }] },
  { kind: 'pump', category: 'equipment', name: 'Irrigation Pump', icon: '⚙️', color: '#5F7A99', defaultGeomType: 'point', sampleReadings: [{ label: 'Pressure', value: '42', unit: 'psi' }, { label: 'Flow', value: '640', unit: 'gpm' }] },
  { kind: 'drone', category: 'equipment', name: 'Scout Drone', icon: '🛸', color: '#8B5CF6', defaultGeomType: 'point', sampleReadings: [{ label: 'Battery', value: '92', unit: '%' }] },
  { kind: 'sensor', category: 'equipment', name: 'Soil Sensor', icon: '📡', color: '#F59E0B', defaultGeomType: 'point', sampleReadings: [{ label: 'Moisture', value: '22', unit: '%VWC' }, { label: 'Temp', value: '18', unit: '°C' }] },
  { kind: 'weather', category: 'equipment', name: 'Weather Station', icon: '🌦️', color: '#0EA5E9', defaultGeomType: 'point', sampleReadings: [{ label: 'Wind', value: '12', unit: 'mph' }, { label: 'Rain 24h', value: '0.3', unit: 'in' }] },
  { kind: 'camera', category: 'equipment', name: 'Field Camera', icon: '📷', color: '#6366F1', defaultGeomType: 'point', sampleReadings: [{ label: 'Uptime', value: '99.2', unit: '%' }] },
  { kind: 'gateway', category: 'equipment', name: 'IoT Gateway', icon: '🛰️', color: '#14B8A6', defaultGeomType: 'point', sampleReadings: [{ label: 'Nodes', value: '18' }, { label: 'Signal', value: '−72', unit: 'dBm' }] },
  { kind: 'generator', category: 'equipment', name: 'Generator', icon: '🔌', color: '#A16207', defaultGeomType: 'point', sampleReadings: [{ label: 'Load', value: '38', unit: '%' }] },

  // ---- Crops & Beds ------------------------------------------------------
  { kind: 'row', category: 'crop', name: 'Crop Row', icon: '🌽', color: '#E8A24B', defaultGeomType: 'polyline' },
  { kind: 'orchard', category: 'crop', name: 'Orchard Block', icon: '🌳', color: '#6B8E23', defaultGeomType: 'rect', defaultSize: { widthM: 60, heightM: 40 } },
  { kind: 'vineyard', category: 'crop', name: 'Vineyard Block', icon: '🍇', color: '#7C3AED', defaultGeomType: 'rect', defaultSize: { widthM: 50, heightM: 40 } },
  { kind: 'berry', category: 'crop', name: 'Berry Field', icon: '🫐', color: '#4338CA', defaultGeomType: 'rect', defaultSize: { widthM: 40, heightM: 30 } },
  { kind: 'plot', category: 'crop', name: 'Trial Plot', icon: '🧬', color: '#C6A15B', defaultGeomType: 'rect', defaultSize: { widthM: 20, heightM: 20 } },
  { kind: 'cover', category: 'crop', name: 'Cover Crop', icon: '🍀', color: '#4B8B3B', defaultGeomType: 'rect', defaultSize: { widthM: 40, heightM: 40 } },
  { kind: 'raisedbed', category: 'crop', name: 'Raised Bed', icon: '🪴', color: '#8D6E63', defaultGeomType: 'rect', defaultSize: { widthM: 12, heightM: 3 } },
  { kind: 'nursery', category: 'crop', name: 'Nursery', icon: '🎋', color: '#6D9F71', defaultGeomType: 'rect', defaultSize: { widthM: 24, heightM: 16 } },

  // ---- Fields & Zones (drawn parcels) ------------------------------------
  { kind: 'field', category: 'field', name: 'Crop Field', icon: '🟩', color: '#65A30D', defaultGeomType: 'polygon' },
  { kind: 'pasture', category: 'field', name: 'Pasture', icon: '🌿', color: '#7CB342', defaultGeomType: 'polygon' },
  { kind: 'hayfield', category: 'field', name: 'Hay Field', icon: '🟨', color: '#CA8A04', defaultGeomType: 'polygon' },
  { kind: 'paddock', category: 'field', name: 'Grazing Paddock', icon: '🔲', color: '#84A17A', defaultGeomType: 'polygon' },
  { kind: 'mgmtzone', category: 'field', name: 'Management Zone', icon: '🗺️', color: '#F59E0B', defaultGeomType: 'polygon' },
  { kind: 'buffer', category: 'field', name: 'Buffer Strip', icon: '🌾', color: '#94A34B', defaultGeomType: 'polygon' },
  { kind: 'fallow', category: 'field', name: 'Fallow Ground', icon: '🟫', color: '#A87C4F', defaultGeomType: 'polygon' },
  { kind: 'terrace', category: 'field', name: 'Terrace', icon: '📶', color: '#8B7355', defaultGeomType: 'polygon' },

  // ---- Livestock ---------------------------------------------------------
  { kind: 'herd', category: 'livestock', name: 'Cattle Herd', icon: '🐄', color: '#8B6F47', defaultGeomType: 'circle', defaultSize: { radiusM: 30 }, sampleReadings: [{ label: 'Head', value: '120' }] },
  { kind: 'dairy', category: 'livestock', name: 'Dairy Herd', icon: '🥛', color: '#B0A99F', defaultGeomType: 'circle', defaultSize: { radiusM: 25 }, sampleReadings: [{ label: 'Milking', value: '84' }, { label: 'Yield', value: '30', unit: 'L/d' }] },
  { kind: 'sheep', category: 'livestock', name: 'Sheep Flock', icon: '🐑', color: '#C9C2B8', defaultGeomType: 'circle', defaultSize: { radiusM: 25 }, sampleReadings: [{ label: 'Head', value: '210' }] },
  { kind: 'goats', category: 'livestock', name: 'Goat Herd', icon: '🐐', color: '#A98B6F', defaultGeomType: 'circle', defaultSize: { radiusM: 20 } },
  { kind: 'poultry', category: 'livestock', name: 'Poultry House', icon: '🐔', color: '#D9A441', defaultGeomType: 'rect', defaultSize: { widthM: 90, heightM: 15 }, sampleReadings: [{ label: 'Birds', value: '28k' }, { label: 'Temp', value: '21', unit: '°C' }] },
  { kind: 'pigbarn', category: 'livestock', name: 'Pig Barn', icon: '🐖', color: '#C58A9B', defaultGeomType: 'rect', defaultSize: { widthM: 40, heightM: 18 } },
  { kind: 'apiary', category: 'livestock', name: 'Apiary', icon: '🐝', color: '#D4A017', defaultGeomType: 'point', sampleReadings: [{ label: 'Hives', value: '16' }] },
  { kind: 'trough', category: 'livestock', name: 'Water Trough', icon: '🪣', color: '#4C87A6', defaultGeomType: 'point', sampleReadings: [{ label: 'Level', value: '80', unit: '%' }] },

  // ---- Water -------------------------------------------------------------
  { kind: 'pond', category: 'water', name: 'Pond', icon: '🪷', color: '#3B82C4', defaultGeomType: 'circle', defaultSize: { radiusM: 25 } },
  { kind: 'reservoir', category: 'water', name: 'Reservoir', icon: '🌊', color: '#2563EB', defaultGeomType: 'polygon', sampleReadings: [{ label: 'Storage', value: '64', unit: '%' }] },
  { kind: 'wetland', category: 'water', name: 'Wetland', icon: '🦆', color: '#0F766E', defaultGeomType: 'polygon' },
  { kind: 'well', category: 'water', name: 'Well', icon: '⛲', color: '#0891B2', defaultGeomType: 'point', sampleReadings: [{ label: 'Depth', value: '120', unit: 'ft' }, { label: 'Table', value: '38', unit: 'ft' }] },
  { kind: 'tank', category: 'water', name: 'Water Tank', icon: '🛢️', color: '#0D9488', defaultGeomType: 'circle', defaultSize: { radiusM: 4 }, sampleReadings: [{ label: 'Level', value: '72', unit: '%' }] },
  { kind: 'canal', category: 'water', name: 'Canal / Ditch', icon: '🏞️', color: '#0EA5A0', defaultGeomType: 'polyline', sampleReadings: [{ label: 'Flow', value: '3.2', unit: 'cfs' }] },
  { kind: 'tiledrain', category: 'water', name: 'Tile Drain', icon: '➰', color: '#64748B', defaultGeomType: 'polyline' },
  { kind: 'raingauge', category: 'water', name: 'Rain Gauge', icon: '🌧️', color: '#38BDF8', defaultGeomType: 'point', sampleReadings: [{ label: 'Rain 24h', value: '0.4', unit: 'in' }] },

  // ---- Access & Utility --------------------------------------------------
  { kind: 'boundary', category: 'infra', name: 'Property Boundary', icon: '📐', color: '#6E97FF', defaultGeomType: 'polygon' },
  { kind: 'road', category: 'infra', name: 'Access Road', icon: '🛣️', color: '#9CA3AF', defaultGeomType: 'polyline' },
  { kind: 'fence', category: 'infra', name: 'Fence Line', icon: '🔗', color: '#78716C', defaultGeomType: 'polyline' },
  { kind: 'powerline', category: 'infra', name: 'Power Line', icon: '⚡', color: '#EAB308', defaultGeomType: 'polyline' },
  { kind: 'gate', category: 'infra', name: 'Farm Gate', icon: '🚪', color: '#A16207', defaultGeomType: 'point' },
  { kind: 'entrance', category: 'infra', name: 'Field Entrance', icon: '📍', color: '#EF6C42', defaultGeomType: 'point' },
  { kind: 'bridge', category: 'infra', name: 'Bridge / Crossing', icon: '🌉', color: '#8B9DC3', defaultGeomType: 'point' },
  { kind: 'parking', category: 'infra', name: 'Yard / Parking', icon: '🅿️', color: '#71717A', defaultGeomType: 'rect', defaultSize: { widthM: 20, heightM: 14 } },
];

export const CATEGORY_LABEL: Record<TwinCategory, string> = {
  structure: 'Structures',
  equipment: 'Equipment',
  crop: 'Crops & Beds',
  field: 'Fields & Zones',
  livestock: 'Livestock',
  water: 'Water',
  infra: 'Access & Utility',
};

// A sensible default AOI (central Iowa) so a freshly-placed twin has geometry.
const DEFAULT_CENTER: [number, number] = [-93.63, 42.03];

export function makeTwinFromCatalog(item: CatalogItem, parcelId: string | null = null): Twin {
  const now = Date.now();
  const jitter = () => (Math.random() - 0.5) * 0.004;
  const center: [number, number] = [DEFAULT_CENTER[0] + jitter(), DEFAULT_CENTER[1] + jitter()];
  let geom: TwinGeom;
  switch (item.defaultGeomType) {
    case 'circle': geom = { type: 'circle', center, radiusM: item.defaultSize?.radiusM ?? 20 }; break;
    case 'rect':   geom = { type: 'rect', center, widthM: item.defaultSize?.widthM ?? 20, heightM: item.defaultSize?.heightM ?? 20, rotation: 0 }; break;
    case 'polyline': geom = { type: 'polyline', points: [center, [center[0] + 0.001, center[1] + 0.0006]] }; break;
    case 'polygon': { const d = 0.0009; geom = { type: 'polygon', ring: [[center[0] - d, center[1] - d], [center[0] + d, center[1] - d], [center[0] + d, center[1] + d], [center[0] - d, center[1] + d], [center[0] - d, center[1] - d]] }; break; }
    default: geom = { type: 'point', lng: center[0], lat: center[1], rotation: 0, scale: 1 };
  }
  return {
    id: `t_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name: item.name,
    category: item.category,
    kind: item.kind,
    icon: item.icon,
    color: item.color,
    parcelId,
    geom,
    specs: {},
    status: { online: Math.random() > 0.15, readings: item.sampleReadings ?? [] },
    maintenance: [],
    docs: [],
    linkedTwinIds: [],
    events: [],
    routines: [],
    yields: [],
    treatments: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ---- localStorage-backed external store -------------------------------------

const STORAGE_KEY = 'rf.studio.twins.v1';
const CHANGE_EVENT = 'rf:twins:change';

let cachedRaw: string | null | undefined;
let cachedTwins: Twin[] = [];

function loadTwins(): Twin[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === cachedRaw) return cachedTwins;
    cachedRaw = raw;
    cachedTwins = raw ? (JSON.parse(raw) as Twin[]) : [];
    if (!Array.isArray(cachedTwins)) cachedTwins = [];
    return cachedTwins;
  } catch {
    cachedTwins = [];
    return cachedTwins;
  }
}

function serverSnapshot(): Twin[] { return []; }

function subscribe(cb: () => void) {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}

function persist(twins: Twin[]) {
  if (typeof window === 'undefined') return;
  const raw = JSON.stringify(twins);
  cachedRaw = raw;
  cachedTwins = twins;
  window.localStorage.setItem(STORAGE_KEY, raw);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

const HISTORY_LIMIT = 50;
let undoStack: Twin[][] = [];
let redoStack: Twin[][] = [];

export function useTwins() {
  const twins = useSyncExternalStore(subscribe, loadTwins, serverSnapshot);

  const commit = useCallback((next: Twin[] | ((prev: Twin[]) => Twin[])) => {
    const prev = loadTwins();
    const value = typeof next === 'function' ? (next as (p: Twin[]) => Twin[])(prev) : next;
    undoStack.push(prev);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    persist(value);
  }, []);

  const addTwin = useCallback((twin: Twin) => commit((p) => [...p, twin]), [commit]);
  const updateTwin = useCallback(
    (id: string, patch: Partial<Twin> | ((t: Twin) => Twin)) =>
      commit((p) => p.map((t) => (t.id === id
        ? (typeof patch === 'function' ? (patch as (t: Twin) => Twin)(t) : { ...t, ...patch, updatedAt: Date.now() })
        : t))),
    [commit],
  );
  const removeTwin = useCallback((id: string) => commit((p) => p.filter((t) => t.id !== id)), [commit]);
  const duplicateTwin = useCallback((id: string) => commit((p) => {
    const src = p.find((t) => t.id === id);
    if (!src) return p;
    return [...p, { ...src, id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name: `${src.name} copy`, createdAt: Date.now(), updatedAt: Date.now() }];
  }), [commit]);

  const undo = useCallback(() => { const prev = undoStack.pop(); if (!prev) return; redoStack.push(loadTwins()); persist(prev); }, []);
  const redo = useCallback(() => { const next = redoStack.pop(); if (!next) return; undoStack.push(loadTwins()); persist(next); }, []);

  return { twins, addTwin, updateTwin, removeTwin, duplicateTwin, undo, redo };
}

export function getTwinById(id: string): Twin | null {
  return loadTwins().find((t) => t.id === id) ?? null;
}

/** Add-or-replace a twin from outside the React tree (e.g. the background scan
 *  runner materializing a backend-composed parcel twin). Persists + notifies;
 *  does not touch the undo stack. */
export function upsertTwinExternal(twin: Twin) {
  const list = loadTwins();
  const idx = list.findIndex((t) => t.id === twin.id);
  persist(idx >= 0 ? list.map((t) => (t.id === twin.id ? twin : t)) : [...list, twin]);
}

export function healthScore(twin: Twin): number {
  let s = twin.status.online ? 70 : 30;
  if (twin.maintenance.length > 0) s += 10;
  if (twin.specs.installDate) s += 5;
  if (twin.specs.vendor) s += 5;
  if (twin.docs.length > 0) s += 5;
  s += Math.min(twin.status.readings.length * 2, 10);
  return Math.max(0, Math.min(100, s));
}

export function geomCenter(g: TwinGeom): [number, number] {
  if (g.type === 'point') return [g.lng, g.lat];
  if (g.type === 'rect' || g.type === 'circle') return g.center;
  const pts = g.type === 'polygon' ? g.ring : g.points;
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

// Planar shoelace area (equirectangular meters about the ring centroid) → m².
function ringAreaM2(ring: [number, number][]): number {
  if (ring.length < 3) return 0;
  let cy = 0;
  for (const [, y] of ring) cy += y;
  cy /= ring.length;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((cy * Math.PI) / 180);
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += (x1 * mPerDegLng) * (y2 * mPerDegLat) - (x2 * mPerDegLng) * (y1 * mPerDegLat);
  }
  return Math.abs(a) / 2;
}

export function geomAreaAcres(g: TwinGeom): number | null {
  if (g.type === 'circle') return (Math.PI * g.radiusM * g.radiusM) / 4046.86;
  if (g.type === 'rect') return (g.widthM * g.heightM) / 4046.86;
  if (g.type === 'polygon') return ringAreaM2(g.ring) / 4046.86;
  return null;
}

// ---- geometry → lng/lat helpers (for the property placement map) ------------

export function metersToLngLat(centerLat: number, dxM: number, dyM: number): [number, number] {
  const dLat = dyM / 111320;
  const dLng = dxM / (111320 * Math.cos((centerLat * Math.PI) / 180));
  return [dLng, dLat];
}

export function circlePolygon(center: [number, number], radiusM: number, segments = 48): [number, number][] {
  const [cx, cy] = center;
  const ring: [number, number][] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const [dLng, dLat] = metersToLngLat(cy, Math.cos(a) * radiusM, Math.sin(a) * radiusM);
    ring.push([cx + dLng, cy + dLat]);
  }
  ring.push(ring[0]);
  return ring;
}

export function rectPolygon(center: [number, number], widthM: number, heightM: number, rotationDeg: number): [number, number][] {
  const [cx, cy] = center;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const hw = widthM / 2, hh = heightM / 2;
  const local: [number, number][] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  const ring: [number, number][] = local.map(([x, y]) => {
    const rx = x * cos - y * sin, ry = x * sin + y * cos;
    const [dLng, dLat] = metersToLngLat(cy, rx, ry);
    return [cx + dLng, cy + dLat];
  });
  ring.push(ring[0]);
  return ring;
}

/** Split twins into polygon / line / point FeatureCollections for the map. */
export function twinsToGeoJSON(twins: Twin[]) {
  const polygons: GeoJSON.Feature[] = [];
  const lines: GeoJSON.Feature[] = [];
  const points: GeoJSON.Feature[] = [];
  for (const t of twins) {
    const props = { id: t.id, name: t.name, color: t.color, icon: t.icon, category: t.category, kind: t.kind };
    if (t.geom.type === 'point') {
      points.push({ type: 'Feature', id: t.id, properties: props, geometry: { type: 'Point', coordinates: [t.geom.lng, t.geom.lat] } });
    } else if (t.geom.type === 'circle') {
      polygons.push({ type: 'Feature', id: t.id, properties: props, geometry: { type: 'Polygon', coordinates: [circlePolygon(t.geom.center, t.geom.radiusM)] } });
      points.push({ type: 'Feature', id: `${t.id}__c`, properties: props, geometry: { type: 'Point', coordinates: t.geom.center } });
    } else if (t.geom.type === 'rect') {
      polygons.push({ type: 'Feature', id: t.id, properties: props, geometry: { type: 'Polygon', coordinates: [rectPolygon(t.geom.center, t.geom.widthM, t.geom.heightM, t.geom.rotation)] } });
      points.push({ type: 'Feature', id: `${t.id}__c`, properties: props, geometry: { type: 'Point', coordinates: t.geom.center } });
    } else if (t.geom.type === 'polygon') {
      const ring = t.geom.ring.length && (t.geom.ring[0][0] !== t.geom.ring[t.geom.ring.length - 1][0] || t.geom.ring[0][1] !== t.geom.ring[t.geom.ring.length - 1][1])
        ? [...t.geom.ring, t.geom.ring[0]] : t.geom.ring;
      polygons.push({ type: 'Feature', id: t.id, properties: props, geometry: { type: 'Polygon', coordinates: [ring] } });
      points.push({ type: 'Feature', id: `${t.id}__c`, properties: props, geometry: { type: 'Point', coordinates: geomCenter(t.geom) } });
    } else {
      lines.push({ type: 'Feature', id: t.id, properties: props, geometry: { type: 'LineString', coordinates: t.geom.points } });
      if (t.geom.points.length) points.push({ type: 'Feature', id: `${t.id}__c`, properties: props, geometry: { type: 'Point', coordinates: t.geom.points[0] } });
    }
  }
  return {
    polygons: { type: 'FeatureCollection' as const, features: polygons },
    lines: { type: 'FeatureCollection' as const, features: lines },
    points: { type: 'FeatureCollection' as const, features: points },
  };
}
