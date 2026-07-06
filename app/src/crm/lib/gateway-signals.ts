// =============================================================================
// gateway-signals.ts — thin client for the AlphaGeo gateway relay.
// -----------------------------------------------------------------------------
// Wraps the app's /api/v1/farm/gw/* byte-forwarding relay (which fronts the live
// gateway /api/farm/* surface). Every call is bbox-driven — a farm/property
// already carries aoi_west/south/east/north, so no gateway AOI mapping is needed.
//
// The relay returns a graceful 503 { error:'gateway_unconfigured' } whenever the
// gateway env (ALPHAGEO_GATEWAY_ORIGIN / ALPHAGEO_HARVEST_TOKEN) is unset — the
// current stub state. This module catches that and surfaces it as an honest
// `{ configured:false }` state so the UI can say "gateway not connected" instead
// of throwing. All other errors propagate as ApiError.
// =============================================================================

import { apiGet, apiPost, ApiError } from './api';
import { useAuthStore } from './auth-store';
import { useTenantStore } from './tenant-store';

/** Bearer + tenant headers for raw fetch() calls (SSE) that bypass api(). */
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  const token = useAuthStore.getState().token;
  if (token) h.authorization = `Bearer ${token}`;
  const tenantId = useTenantStore.getState().currentTenantId;
  if (tenantId) h['x-tenant-id'] = tenantId;
  return h;
}

/** [west, south, east, north] — the shape every FarmProfile bbox unpacks to. */
export type Bbox = [number, number, number, number];

/** Real EO producers the gateway can launch. ndvi/evi are intentionally excluded
 *  (the gateway records them as an honest `no_producer`, never fabricated). */
export type ScanSignal = 'sar' | 'moisture' | 'thermal' | 'superres';

/** A normalized signal feature (schema "farm.signal.v1") already emitted by the
 *  gateway — measurement/value/confidence/acquiredAt, honest sceneId/cloudPct nulls. */
export interface SignalFeatureProps {
  measurement?: string | null;
  value?: number | null;
  confidence?: number | null;
  acquiredAt?: string | null;
  sceneId?: string | null;
  cloudPct?: number | null;
  tier?: string | null;
  category?: string | null;
  name?: string | null;
  source?: string | null;
  [k: string]: unknown;
}

export type SignalFeature = GeoJSON.Feature<GeoJSON.Geometry | null, SignalFeatureProps>;

export interface SignalCollection {
  type: 'FeatureCollection';
  features: SignalFeature[];
  count?: number;
  schema?: string;
}

/** Gateway scan acknowledgement (202). */
export interface ScanAck {
  jobId: string;
  startedAt?: string;
  status?: string;
  aoiId?: string | null;
  subProjectId?: string | null;
  acceptedSignals?: string[];
}

/** Poll-style redis job snapshot. */
export interface JobSnapshot {
  jobId?: string;
  status?: string;
  pct?: number;
  stage?: string;
  producers?: unknown;
  [k: string]: unknown;
}

/** Every gateway result is either the payload (configured) or an honest
 *  not-connected state — never a thrown error for the unconfigured case. */
export type GatewayResult<T> = ({ configured: true } & T) | { configured: false };

/** True when the failure is the relay's graceful "gateway not wired up yet" 503. */
export function isUnconfigured(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503 && /gateway_unconfigured/.test(err.message);
}

function bboxParam(bbox: Bbox): string {
  return bbox.map((n) => Number(n)).join(',');
}

/**
 * GET /farm/gw/signals-by-bbox — real EO signals intersecting the bbox.
 * Returns an honest empty FeatureCollection when no producers have run, or
 * { configured:false } when the gateway env is unset.
 */
export async function fetchSignals(
  bbox: Bbox,
  opts: { category?: string; type?: string; tier?: string; minConfidence?: number; limit?: number } = {},
): Promise<GatewayResult<{ collection: SignalCollection }>> {
  const qs = new URLSearchParams({ bbox: bboxParam(bbox) });
  if (opts.category) qs.set('category', opts.category);
  if (opts.type) qs.set('type', opts.type);
  if (opts.tier) qs.set('tier', opts.tier);
  if (opts.minConfidence != null) qs.set('minConfidence', String(opts.minConfidence));
  if (opts.limit != null) qs.set('limit', String(opts.limit));
  try {
    const collection = await apiGet<SignalCollection>(`/farm/gw/signals-by-bbox?${qs.toString()}`);
    return { configured: true, collection };
  } catch (err) {
    if (isUnconfigured(err)) return { configured: false };
    throw err;
  }
}

/**
 * POST /farm/gw/scan — launch real per-AOI orbiter runs for the bbox.
 * tenant_id is injected server-side from the authenticated tenant; the body just
 * carries the bbox + chosen producers.
 */
/**
 * POST /farm/gw/aoi/from-geom — register the operator's REFINED polygon as an
 * AOI (find-my-farm → scan keystone). The gateway stores the exact polygon and
 * returns { aoi_id }, which then drives the scan.
 */
export async function aoiFromGeom(
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  name: string,
): Promise<GatewayResult<{ aoiId: string }>> {
  try {
    const r = await apiPost<{ aoi_id?: string; aoiId?: string }>('/farm/gw/aoi/from-geom', { name, geom_geojson: geom });
    const aoiId = r.aoi_id ?? r.aoiId;
    if (!aoiId) throw new ApiError('aoi_from_geom_no_id', 502);
    return { configured: true, aoiId: String(aoiId) };
  } catch (err) {
    if (isUnconfigured(err)) return { configured: false };
    throw err;
  }
}

/**
 * POST /farm/gw/scan — launch a real scan over a REGISTERED AOI (from-geom).
 * The gateway owns validation; returns a 202 { jobId }.
 */
export async function runScan(
  aoiId: string,
  signals: ScanSignal[],
): Promise<GatewayResult<{ ack: ScanAck }>> {
  try {
    const ack = await apiPost<ScanAck>('/farm/gw/scan', { aoi_id: aoiId, signals });
    return { configured: true, ack };
  } catch (err) {
    if (isUnconfigured(err)) return { configured: false };
    throw err;
  }
}

/** A parsed SSE frame from the job-events stream. */
export interface JobEvent { event: string; data: Record<string, unknown>; }

/**
 * GET /farm/gw/jobs/:jobId/events — consume the gateway's SSE progress stream
 * (farm.progress → farm.complete / farm.error) via fetch (so we can attach the
 * Bearer + tenant headers that EventSource can't). Resolves when the stream ends;
 * throws ApiError(503) when the gateway is unconfigured, or on abort.
 */
export async function streamJobEvents(
  jobId: string,
  onEvent: (ev: JobEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/v1/farm/gw/jobs/${encodeURIComponent(jobId)}/events`, {
    headers: authHeaders({ accept: 'text/event-stream' }),
    signal,
  });
  if (res.status === 503) throw new ApiError('gateway_unconfigured', 503);
  if (!res.ok || !res.body) throw new ApiError(`job_events_${res.status}`, res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!frame || frame.startsWith(':')) continue; // heartbeat/comment
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      let data: Record<string, unknown> = {};
      if (dataLines.length) { try { data = JSON.parse(dataLines.join('\n')); } catch { data = { raw: dataLines.join('\n') }; } }
      onEvent({ event, data });
    }
  }
}

/** A composed parcel twin from the gateway (schema unconfirmed — spec ask B4).
 *  We accept it loosely and normalize defensively at materialization time. */
export interface CompositeTwin {
  aoiId?: string;
  geometry?: GeoJSON.Geometry;
  boundary?: unknown;
  aoi?: { geometry?: GeoJSON.Geometry; boundary?: unknown; area_ha?: number } & Record<string, unknown>;
  orbiters?: unknown[];
  rasters?: unknown[];
  signals?: SignalFeature[] | { features?: SignalFeature[] };
  indicators?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * GET /farm/gw/twins/:aoiId — the composed parcel twin the backend builds after a
 * scan completes (AOI geometry + orbiters + rasters + signals + indicators).
 */
export async function fetchTwins(aoiId: string): Promise<GatewayResult<{ twin: CompositeTwin }>> {
  try {
    const twin = await apiGet<CompositeTwin>(`/farm/gw/twins/${encodeURIComponent(aoiId)}`);
    return { configured: true, twin };
  } catch (err) {
    if (isUnconfigured(err)) return { configured: false };
    throw err;
  }
}

/**
 * GET /farm/gw/jobs/:jobId — poll a scan job snapshot (producers land on .producers).
 * Poll fallback for surfaces that don't hold the SSE stream open.
 */
export async function pollJob(jobId: string): Promise<GatewayResult<{ job: JobSnapshot }>> {
  try {
    const job = await apiGet<JobSnapshot>(`/farm/gw/jobs/${encodeURIComponent(jobId)}`);
    return { configured: true, job };
  } catch (err) {
    if (isUnconfigured(err)) return { configured: false };
    throw err;
  }
}

/** Unpack a FarmProfile-style row's aoi_* fields into a Bbox, or null if incomplete. */
export function bboxFromAoi(p: {
  aoi_west: number | string | null;
  aoi_south: number | string | null;
  aoi_east: number | string | null;
  aoi_north: number | string | null;
}): Bbox | null {
  const w = num(p.aoi_west), s = num(p.aoi_south), e = num(p.aoi_east), n = num(p.aoi_north);
  if (w == null || s == null || e == null || n == null) return null;
  return [w, s, e, n];
}

function num(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
