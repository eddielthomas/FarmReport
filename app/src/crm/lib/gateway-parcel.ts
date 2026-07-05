// =============================================================================
// gateway-parcel.ts — FIND-MY-FARM parcel lookup client for the gateway relay.
// -----------------------------------------------------------------------------
// Wraps the app's /api/v1/farm/gw/parcel* byte-forwarding relay (which fronts the
// live gateway /api/farm/parcel* surface). Given a dropped pin (lat/lon) or a
// typed address, it resolves a clean, editable parcel boundary that BECOMES the
// farm twin geometry — the keystone onboarding step.
//
// Like gateway-signals.ts, the relay returns a graceful 503
// { error:'gateway_unconfigured' } whenever the gateway env
// (ALPHAGEO_GATEWAY_ORIGIN / ALPHAGEO_HARVEST_TOKEN) is unset — the current stub
// state. This module catches that and surfaces an honest `{ configured:false }`
// so the onboarding UI falls back to the manual import/paste path instead of
// throwing. All other errors propagate as ApiError.
// =============================================================================

import { apiGet, ApiError } from './api';
import { extractPolygonal } from '@crm/components/farm/BoundaryImport';
// Reuse the exact graceful-503 semantics + result union from gateway-signals so
// both gateway clients behave identically.
import { isUnconfigured, type GatewayResult } from './gateway-signals';

export type { GatewayResult } from './gateway-signals';

type Polygonal = GeoJSON.Polygon | GeoJSON.MultiPolygon;

// --- FIND-MY-FARM relay subpaths — the gateway HTTP surface is NOT yet finalized
// by the gateway agent. These are the FIXED app-side relay paths (mounted in
// api/v1/index.mjs under /farm/gw/*, which map through gateway.mjs to the gateway
// GET /api/farm/parcel and /api/farm/parcel-by-address). Change ONLY these two
// consts if the app relay is ever renamed.
const PARCEL_PATH = '/farm/gw/parcel';                       // ?lat=&lon=
const PARCEL_BY_ADDRESS_PATH = '/farm/gw/parcel-by-address'; // ?q=

/** A normalized parcel: an editable Polygon/MultiPolygon boundary plus optional
 *  address + area, ready to seed the farm twin geometry. */
export interface Parcel {
  /** GeoJSON Polygon or MultiPolygon — guaranteed valid (extractPolygonal). */
  boundary: Polygonal;
  /** Resolved postal/place address, if the gateway returned one. */
  address?: string;
  /** Parcel area in hectares, if the gateway returned one. */
  areaHa?: number;
  /** True when the boundary is a geocoder approximation (OSM fallback), not a
   *  cadastral parcel — the UI should prompt the operator to fine-tune it. */
  approximate?: boolean;
  /** Where the boundary came from: the AlphaGeo gateway, or the OSM fallback. */
  source?: 'gateway' | 'osm';
}

/** The raw gateway parcel envelope — field names are not final, so we accept the
 *  known aliases (boundary|geometry, area_ha|areaHa) and normalize below. */
interface RawParcel {
  boundary?: unknown;
  geometry?: unknown;
  address?: string | null;
  area_ha?: number | string | null;
  areaHa?: number | string | null;
  [k: string]: unknown;
}

function num(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Reduce a raw gateway parcel to a normalized Parcel, or null if it carries no
 *  usable polygon geometry (so the caller can fall back to manual entry). */
function normalizeParcel(raw: RawParcel | null | undefined): Parcel | null {
  if (!raw || typeof raw !== 'object') return null;
  const boundary = extractPolygonal(raw.boundary ?? raw.geometry);
  if (!boundary) return null;
  const address = typeof raw.address === 'string' && raw.address.trim() ? raw.address.trim() : undefined;
  const areaHa = num(raw.area_ha ?? raw.areaHa);
  return { boundary, address, areaHa, source: 'gateway' };
}

// ---------------------------------------------------------------------------
// OSM (Nominatim) fallback — used ONLY when the AlphaGeo gateway is unconfigured
// so find-my-farm still locates the farm and drops an EDITABLE approximate
// boundary the operator then refines. Cadastral parcels come from the gateway;
// this is a best-effort geolocation, always flagged `approximate`.
// ---------------------------------------------------------------------------

const NOMINATIM = 'https://nominatim.openstreetmap.org';
// A rectangle bigger than this (deg) is a place/city bbox, not a parcel — we
// substitute a sensible starting field square instead of a huge box.
const MAX_BBOX_DEG = 0.05;
const DEFAULT_FIELD_DEG = 0.0035; // ~380 m half-extent → a plausible field to edit.

function rectBoundary(w: number, s: number, e: number, n: number): GeoJSON.Polygon {
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

/** Turn a Nominatim result into an approximate, editable Parcel. */
function osmToParcel(r: {
  geojson?: unknown; boundingbox?: string[]; lat?: string; lon?: string; display_name?: string;
} | null): Parcel | null {
  if (!r) return null;
  const address = typeof r.display_name === 'string' ? r.display_name : undefined;
  // 1) Real polygon geometry (named features) — best case.
  const poly = extractPolygonal(r.geojson);
  if (poly) return { boundary: poly, address, approximate: true, source: 'osm' };
  // 2) A reasonably-sized bounding box → use it as the starting rectangle.
  const lat = Number(r.lat), lon = Number(r.lon);
  const bb = r.boundingbox?.map(Number);
  if (bb && bb.length === 4 && bb.every(Number.isFinite)) {
    const [s, n, w, e] = bb; // Nominatim order: [south, north, west, east]
    if (Math.abs(n - s) <= MAX_BBOX_DEG && Math.abs(e - w) <= MAX_BBOX_DEG) {
      return { boundary: rectBoundary(w, s, e, n), address, approximate: true, source: 'osm' };
    }
  }
  // 3) Point only (or oversized bbox) → a default field square to refine.
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const d = DEFAULT_FIELD_DEG;
    return { boundary: rectBoundary(lon - d, lat - d, lon + d, lat + d), address, approximate: true, source: 'osm' };
  }
  return null;
}

async function osmSearch(q: string): Promise<Parcel | null> {
  const qs = new URLSearchParams({ q, format: 'jsonv2', polygon_geojson: '1', limit: '1', addressdetails: '0' });
  const res = await fetch(`${NOMINATIM}/search?${qs.toString()}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const rows = (await res.json()) as unknown[];
  return osmToParcel((Array.isArray(rows) ? rows[0] : null) as Parameters<typeof osmToParcel>[0]);
}

async function osmReverse(lat: number, lon: number): Promise<Parcel | null> {
  const qs = new URLSearchParams({ lat: String(lat), lon: String(lon), format: 'jsonv2', polygon_geojson: '1' });
  const res = await fetch(`${NOMINATIM}/reverse?${qs.toString()}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const row = (await res.json()) as Parameters<typeof osmToParcel>[0];
  // Reverse geocode returns the enclosing feature's polygon; if it's oversized,
  // osmToParcel falls back to a field square centered on the requested pin.
  return osmToParcel(row ?? { lat: String(lat), lon: String(lon) });
}

/**
 * GET /farm/gw/parcel?lat&lon — resolve an editable parcel boundary from a
 * dropped pin. Returns { configured:false } when the gateway env is unset, and
 * { configured:true, parcel:null } when the gateway ran but found no parcel.
 */
export async function findParcelByPoint(
  lat: number,
  lon: number,
): Promise<GatewayResult<{ parcel: Parcel | null }>> {
  const qs = new URLSearchParams({ lat: String(lat), lon: String(lon) });
  // 1) Try the cadastral gateway. A usable parcel wins outright.
  try {
    const parcel = normalizeParcel(await apiGet<RawParcel>(`${PARCEL_PATH}?${qs.toString()}`));
    if (parcel) return { configured: true, parcel };
  } catch (err) {
    // Any gateway miss (unconfigured 503, not_found 404, error) falls through to
    // the OSM fallback below — find-my-farm never hard-fails on the gateway.
    if (!isUnconfigured(err)) console.warn('[find-my-farm] gateway parcel lookup failed, using OSM', err);
  }
  // 2) OSM fallback → approximate, editable boundary. Only a network failure
  //    (OSM unreachable) collapses to the honest not-connected note.
  try { return { configured: true, parcel: await osmReverse(lat, lon) }; }
  catch { return { configured: false }; }
}

/**
 * GET /farm/gw/parcel-by-address?q — resolve an editable parcel boundary from a
 * typed address. Same result contract as findParcelByPoint.
 */
export async function findParcelByAddress(
  q: string,
): Promise<GatewayResult<{ parcel: Parcel | null }>> {
  const qs = new URLSearchParams({ q });
  // 1) Try the cadastral gateway. A usable parcel wins outright.
  try {
    const parcel = normalizeParcel(await apiGet<RawParcel>(`${PARCEL_BY_ADDRESS_PATH}?${qs.toString()}`));
    if (parcel) return { configured: true, parcel };
  } catch (err) {
    if (!isUnconfigured(err)) console.warn('[find-my-farm] gateway address lookup failed, using OSM', err);
  }
  // 2) OSM geocode fallback → approximate, editable boundary.
  try { return { configured: true, parcel: await osmSearch(q) }; }
  catch { return { configured: false }; }
}

/** Re-export ApiError so callers can narrow on it without a second import. */
export { ApiError };
