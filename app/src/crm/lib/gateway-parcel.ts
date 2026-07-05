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
  return { boundary, address, areaHa };
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
  try {
    const raw = await apiGet<RawParcel>(`${PARCEL_PATH}?${qs.toString()}`);
    return { configured: true, parcel: normalizeParcel(raw) };
  } catch (err) {
    if (isUnconfigured(err)) return { configured: false };
    throw err;
  }
}

/**
 * GET /farm/gw/parcel-by-address?q — resolve an editable parcel boundary from a
 * typed address. Same result contract as findParcelByPoint.
 */
export async function findParcelByAddress(
  q: string,
): Promise<GatewayResult<{ parcel: Parcel | null }>> {
  const qs = new URLSearchParams({ q });
  try {
    const raw = await apiGet<RawParcel>(`${PARCEL_BY_ADDRESS_PATH}?${qs.toString()}`);
    return { configured: true, parcel: normalizeParcel(raw) };
  } catch (err) {
    if (isUnconfigured(err)) return { configured: false };
    throw err;
  }
}

/** Re-export ApiError so callers can narrow on it without a second import. */
export { ApiError };
