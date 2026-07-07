// =============================================================================
// gateway-vision.ts — client for the gateway's unified vision endpoint
// (POST /api/vision/segment + /refine), relayed through /api/v1/farm/gw/vision/*.
// -----------------------------------------------------------------------------
// Contract agreed in wing_farm-agent (c3b3114b): YOLO-seg + Grounding-DINO one-
// shot detect, SAM2 cached-embedding refine. Georeferenced source → lat/lon
// GeoJSON polygons (T3 screening). Powers BOTH:
//   • find-my-farm AI auto-trace — segment { field } at the dropped pin → the
//     pin-containing field polygon → the boundary editor for the user to nudge.
//   • Studio object-to-twin — objects as clickable overlays → refine → assets.
//
// DEPLOY STATE: the endpoint is BUILT but ships in a batched gateway recreate;
// until it deploys the relay returns 404 'vision_not_available'. We surface that
// as { available:false } so the UI shows an honest "coming soon" and never a hard
// error. Sync (cached imagery) returns objects directly; a 202 {jobId} (fresh S2
// fetch) reuses the farm.progress/complete SSE reader we already have.
// =============================================================================

import { apiPost, ApiError } from './api';
import { streamJobEvents, isUnconfigured } from './gateway-signals';

type Polygon = GeoJSON.Polygon;

/** A segmented object: an editable T3 polygon + label/confidence. */
export interface SegObject {
  label?: string;
  confidence?: number;
  tier?: string;              // 'T3'
  areaHa?: number;
  polygon: Polygon;           // lat/lon (EPSG:4326) when georeferenced
  bbox?: [number, number, number, number]; // [W,S,E,N]
  nonGeo?: boolean;
}

interface RawSeg {
  ok?: boolean;               // honest false on nocoverage / no_mask / session_expired
  embedding_session?: string;
  crs?: string;
  jobId?: string;             // present on the 202 async path
  objects?: Array<{
    label?: string; confidence?: number; tier?: string; area_ha?: number;
    polygon?: unknown; geometry?: unknown; bbox?: number[]; non_geo?: boolean;
  }>;
  [k: string]: unknown;
}

/** Uniform result: the endpoint is either unavailable (unconfigured OR not-yet-
 *  deployed 404) or it returned a (possibly empty) set of objects. */
export type SegmentResult =
  | { available: false }
  | { available: true; embeddingSession?: string; objects: SegObject[] };

/** The purpose-built parcel-delineate envelope (POST /api/gis/parcel/delineate):
 *  a clean top-level boundary Polygon at the pin. Preferred for auto-trace. */
interface RawDelineate {
  ok?: boolean;
  boundary?: unknown;         // GeoJSON Polygon (WGS84)
  area_ha?: number;
  source?: string;            // 'sam2_s2cloudless' | 'cadastral' | ...
  tier?: string;              // 'T3'
  confidence?: number;
  embedding_session?: string;
  [k: string]: unknown;
}

// The surface-factory wraps the segment payload under `result`; unwrap it (the
// delineate alias, used for auto-trace, is already flat).
function unwrap(raw: RawSeg): RawSeg {
  const r = (raw as { result?: unknown }).result;
  return r && typeof r === 'object' ? { ...(r as RawSeg) } : raw;
}

function normObjects(raw: RawSeg): SegObject[] {
  const out: SegObject[] = [];
  for (const o of raw.objects ?? []) {
    const g = (o.polygon ?? o.geometry) as { type?: string; coordinates?: unknown } | undefined;
    if (!g || g.type !== 'Polygon' || !Array.isArray(g.coordinates)) continue;
    out.push({
      label: o.label,
      confidence: typeof o.confidence === 'number' ? o.confidence : undefined,
      tier: o.tier,
      areaHa: typeof o.area_ha === 'number' ? o.area_ha : undefined,
      polygon: g as Polygon,
      bbox: Array.isArray(o.bbox) && o.bbox.length === 4 ? (o.bbox as [number, number, number, number]) : undefined,
      nonGeo: o.non_geo === true,
    });
  }
  return out;
}

/** True if a lat/lon point falls inside a polygon's outer ring (ray-cast). */
export function pointInPolygon(lng: number, lat: number, poly: Polygon): boolean {
  const ring = poly.coordinates[0] as [number, number][];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * FIND-MY-FARM AUTO-TRACE — SAM2-delineate the field at a dropped pin via the
 * purpose-built /api/gis/parcel/delineate alias, which returns a CLEAN top-level
 * boundary Polygon (WGS84). Verified live (Glennville → 3.15 ha, source
 * sam2_s2cloudless, T3). Returns { available:false } when the endpoint is
 * unconfigured/not-deployed (404) so the UI degrades gracefully.
 */
export async function segmentFieldAtPoint(
  lat: number,
  lon: number,
): Promise<SegmentResult> {
  let raw: RawDelineate;
  try {
    raw = await apiPost<RawDelineate>('/farm/gw/vision/delineate', { point: { lat, lon } });
  } catch (err) {
    // 404 (not deployed) or 503 (unconfigured) → gracefully unavailable.
    if (err instanceof ApiError && (err.status === 404 || isUnconfigured(err))) return { available: false };
    throw err;
  }
  // Honest empty: ok:false or no polygon → no field to trace (caller falls back).
  const poly = raw.boundary as { type?: string; coordinates?: unknown } | undefined;
  if (raw.ok === false || !poly || poly.type !== 'Polygon' || !Array.isArray(poly.coordinates)) {
    return { available: true, embeddingSession: raw.embedding_session, objects: [] };
  }
  const obj: SegObject = {
    label: 'field',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : undefined,
    tier: raw.tier,
    areaHa: typeof raw.area_ha === 'number' ? raw.area_ha : undefined,
    polygon: poly as Polygon,
  };
  return { available: true, embeddingSession: raw.embedding_session, objects: [obj] };
}

/**
 * OBJECT-TO-TWIN — one-shot segment of a source (tile/bbox/image_ref) returning
 * many objects for click-to-twin. Unwraps the surface-factory `result` envelope.
 * Handles the async 202 path via the farm SSE reader. (Wired for the Studio flow;
 * not used by find-my-farm.)
 */
export async function segmentSource(
  body: { source?: unknown; point?: unknown; prompt?: string; classes?: string[]; max?: number },
  opts: { signal?: AbortSignal } = {},
): Promise<SegmentResult> {
  let raw: RawSeg;
  try {
    raw = unwrap(await apiPost<RawSeg>('/farm/gw/vision/segment', body));
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || isUnconfigured(err))) return { available: false };
    throw err;
  }
  if (raw.jobId && !(raw.objects && raw.objects.length)) {
    const jobId = String(raw.jobId);
    const collected: RawSeg = { objects: [] };
    const ctrl = new AbortController();
    const signal = opts.signal ?? ctrl.signal;
    try {
      await streamJobEvents(jobId, (ev) => {
        if (/complete|finished|done/i.test(ev.event)) {
          const objs = unwrap(ev.data as RawSeg).objects;
          if (Array.isArray(objs)) collected.objects = objs;
        }
      }, signal);
    } catch { /* stream ended/aborted — use what we have */ }
    return { available: true, embeddingSession: raw.embedding_session, objects: normObjects(collected) };
  }
  return { available: true, embeddingSession: raw.embedding_session, objects: normObjects(raw) };
}

/**
 * Pick the best field polygon for a dropped pin: prefer the one whose ring
 * contains the pin; else the highest-confidence field; else the first object.
 */
export function pickFieldForPin(objects: SegObject[], lng: number, lat: number): SegObject | null {
  if (!objects.length) return null;
  const containing = objects.filter((o) => pointInPolygon(lng, lat, o.polygon));
  const pool = containing.length ? containing : objects;
  return pool.slice().sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0] ?? null;
}
