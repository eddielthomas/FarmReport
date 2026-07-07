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
  polygon: Polygon;           // lat/lon (EPSG:4326) when georeferenced
  bbox?: [number, number, number, number]; // [W,S,E,N]
  nonGeo?: boolean;
}

interface RawSeg {
  embedding_session?: string;
  crs?: string;
  jobId?: string;             // present on the 202 async path
  objects?: Array<{
    label?: string; confidence?: number; tier?: string;
    polygon?: unknown; geometry?: unknown; bbox?: number[]; non_geo?: boolean;
  }>;
  [k: string]: unknown;
}

/** Uniform result: the endpoint is either unavailable (unconfigured OR not-yet-
 *  deployed 404) or it returned a (possibly empty) set of objects. */
export type SegmentResult =
  | { available: false }
  | { available: true; embeddingSession?: string; objects: SegObject[] };

// A small AOI box (deg) around a dropped pin — enough for the gateway to segment
// the S2 tile and return field polygons; the caller keeps the pin-containing one.
const PIN_BOX_DEG = 0.012;

function normObjects(raw: RawSeg): SegObject[] {
  const out: SegObject[] = [];
  for (const o of raw.objects ?? []) {
    const g = (o.polygon ?? o.geometry) as { type?: string; coordinates?: unknown } | undefined;
    if (!g || g.type !== 'Polygon' || !Array.isArray(g.coordinates)) continue;
    out.push({
      label: o.label,
      confidence: typeof o.confidence === 'number' ? o.confidence : undefined,
      tier: o.tier,
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
 * Segment the imagery at a dropped pin and return field-boundary polygons.
 * Handles the async 202 path (fresh S2 fetch) by reusing the farm SSE reader.
 * Returns { available:false } when the endpoint is unconfigured or not yet
 * deployed (404), so the UI degrades gracefully.
 */
export async function segmentFieldAtPoint(
  lat: number,
  lon: number,
  opts: { signal?: AbortSignal } = {},
): Promise<SegmentResult> {
  const d = PIN_BOX_DEG;
  const body = {
    source: { bbox: [lon - d, lat - d, lon + d, lat + d] as [number, number, number, number] },
    classes: ['field'],
    prompt: 'field boundary',
    max: 20,
  };
  let raw: RawSeg;
  try {
    raw = await apiPost<RawSeg>('/farm/gw/vision/segment', body);
  } catch (err) {
    // 404 (not deployed) or 503 (unconfigured) → gracefully unavailable.
    if (err instanceof ApiError && (err.status === 404 || isUnconfigured(err))) return { available: false };
    throw err;
  }

  // Async path: a 202 returned a jobId — await farm.complete, then read objects
  // from the completion payload if the gateway attaches them there.
  if (raw.jobId && !(raw.objects && raw.objects.length)) {
    const jobId = String(raw.jobId);
    const collected: RawSeg = { objects: [] };
    const ctrl = new AbortController();
    const signal = opts.signal ?? ctrl.signal;
    try {
      await streamJobEvents(jobId, (ev) => {
        if (/complete|finished|done/i.test(ev.event)) {
          const objs = (ev.data as { objects?: RawSeg['objects'] }).objects;
          if (Array.isArray(objs)) collected.objects = objs;
        }
      }, signal);
    } catch { /* stream ended/aborted — fall through with whatever we have */ }
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
