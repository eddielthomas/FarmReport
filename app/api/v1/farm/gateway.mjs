// =============================================================================
// /api/v1/farm/gw/* — thin byte-forwarding relay to the AlphaGeo gateway's
// additive /api/farm/* surface (twins, signals, scan, jobs, job-events SSE).
// -----------------------------------------------------------------------------
// This module is a DUMB relay. The gateway already: resolves bbox from AOI,
// enforces the 0.25° span limit (→ 422 bbox_too_large), normalizes signals to
// farm.signal.v1 (measurement/value/confidence/acquiredAt/sceneId:null/…),
// launches orbiters + run_harvest, and emits farm.* named SSE events with the
// exact harvest tick shape. We MUST NOT redo any of that — we only:
//   (a) map /api/v1/farm/gw/* → gateway /api/farm/*,
//   (b) inject Authorization: Bearer <ALPHAGEO_HARVEST_TOKEN>,
//   (c) gate every handler with farmGate (tenant/permission scoping),
//   (d) passthrough JSON (422 preserved) or SSE (heartbeats + close teardown),
//   (e) return 503 {gateway_unconfigured} when env is unset — the app then
//       behaves exactly as today (stub mode, no crash).
//
// Self-contained (mirrors farm/farms.mjs) — re-derives GATEWAY_ORIGIN + token
// from env and re-implements the fetch/SSE clones so there is no import cycle
// back into server.mjs (server → v1/index → farm/gateway).
//
// Routes (dispatched from api/v1/index.mjs, all behind farmGate):
//   GET  /farm/gw/twins/:aoiId
//   GET  /farm/gw/signals-by-bbox?bbox=W,S,E,N&…
//   POST /farm/gw/scan
//   GET  /farm/gw/jobs/:jobId
//   GET  /farm/gw/jobs/:jobId/events            (SSE passthrough)
// =============================================================================

import { readBody, send } from '../http.mjs';
import { farmGate } from './gate.mjs';
import { requireFeature } from '../billing/entitlements.mjs';

const ORIGIN = process.env.CORS_ORIGIN ?? '*';

// GATEWAY_ORIGIN derivation mirrors server.mjs L233-258: prefer an explicit
// ALPHAGEO_GATEWAY_ORIGIN, else strip the trailing /api/harvest off the harvest
// base. Farm paths hang off the bare origin (…/api/farm/scan). Empty in the
// current stub state (env unset) → every handler short-circuits to a 503.
const HARVEST_BASE   = (process.env.ALPHAGEO_HARVEST_BASE ?? '').replace(/\/+$/, '');
const HARVEST_TOKEN  = process.env.ALPHAGEO_HARVEST_TOKEN ?? '';
const GATEWAY_ORIGIN = (process.env.ALPHAGEO_GATEWAY_ORIGIN
  ?? HARVEST_BASE.replace(/\/api\/harvest\/?$/, '')).replace(/\/+$/, '');

// --- FIND-MY-FARM parcel lookup — CONFIRMED gateway surface (GATEWAY_TO_
// REPORTFARM_RESPONSE.md §B1). Parcel is NOT farm-namespaced: it lives in the
// gis_parcel router as POST /api/gis/parcel {point:{lat,lon} | address}. The app
// relay paths (/api/v1/farm/gw/parcel?lat&lon, /parcel-by-address?q) stay fixed —
// this module POSTs the JSON body the gateway expects. No cadastral table is
// loaded yet → the gateway returns source=osm_landuse (T3) or honest nocoverage;
// the client prefers the gateway boundary only when source==cadastral.
const GW_PARCEL = '/api/gis/parcel'; // POST {point:{lat,lon}} | {address}

// True only when we can actually reach the gateway (origin + bearer token).
function configured() { return Boolean(GATEWAY_ORIGIN && HARVEST_TOKEN); }
function unconfigured(res) {
  return send(res, 503, { success: false, error: 'gateway_unconfigured' });
}

// Server-to-server fetch to the gateway with the Bearer harvest token (matches
// the gateway's ALPHAGEO_FARM_TOKEN→ALPHAGEO_HARVEST_TOKEN fallback). Optional
// Basic retry mirrors server.mjs gatewayFetch for a prod nginx auth mismatch.
async function gatewayFetch(gwPath, { method = 'GET', body = null } = {}) {
  const target = `${GATEWAY_ORIGIN}${gwPath}`;
  const basic = process.env.ALPHAGEO_GATEWAY_BASIC || '';
  const attempt = (authHeader) => fetch(target, {
    method,
    headers: {
      accept: 'application/json',
      ...(body != null ? { 'content-type': 'application/json' } : {}),
      ...(authHeader ? { authorization: authHeader } : {}),
    },
    ...(body != null ? { body } : {}),
  });
  let upstream = await attempt(HARVEST_TOKEN ? `Bearer ${HARVEST_TOKEN}` : '');
  if (upstream.status === 401 && basic) {
    upstream = await attempt(`Basic ${Buffer.from(basic).toString('base64')}`);
  }
  return upstream;
}

// JSON passthrough (mirrors server.mjs relayGatewayResponse): preserve the
// gateway's 422 (bbox_too_large / unknown_aoi_or_no_bbox), map any other
// upstream failure to 502, else stream the body bytes through verbatim so the
// farm.signal.v1 / farm.twin.v1 envelope reaches the browser un-reshaped.
async function relay(res, upstream, label) {
  const text = await upstream.text();
  if (!upstream.ok) {
    return send(res, upstream.status === 422 ? 422 : 502, {
      success: false,
      error: `${label}_gateway_error`,
      status: upstream.status,
      detail: text.slice(0, 300),
    });
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': ORIGIN,
  });
  res.end(text);
}

// Shared wrapper for the four JSON relay routes: gate → configured? → fetch →
// relay, with a clean 502 on an unreachable gateway (never a 500 crash).
async function jsonRelay(req, res, gwPath, label, opts = {}) {
  if (!farmGate(req, res, 'farm.profile.read', 'farm:view')) return;
  if (!configured()) return unconfigured(res);
  let upstream;
  try {
    upstream = await gatewayFetch(gwPath, opts);
  } catch (err) {
    return send(res, 502, {
      success: false, error: `${label}_gateway_unreachable`,
      detail: String(err?.message ?? err),
    });
  }
  return relay(res, upstream, label);
}

// --- GET /farm/gw/twins/:aoiId ---------------------------------------------
// Composed twin read (farm.twin.v1): aoi + orbiters + rasters + signals.
export async function twins(req, res, aoiId) {
  return jsonRelay(req, res, `/api/farm/twins/${encodeURIComponent(aoiId)}`, 'farm_twins');
}

// --- GET /farm/gw/signals-by-bbox?bbox=W,S,E,N&… ---------------------------
// Forward the query string verbatim — the gateway owns the mapping layer and
// returns an honest {type:'FeatureCollection',…,schema:'farm.signal.v1'}.
export async function signalsByBbox(req, res, url) {
  const qs = url?.search ?? (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  return jsonRelay(req, res, `/api/farm/signals-by-bbox${qs}`, 'farm_signals');
}

// Shared POST → /api/gis/parcel with a JSON body (point or address). The gateway
// returns {ok, parcel:Feature|null, twinSeed, source, tier, area_ha, ...}; the
// client normalizes it. 400 on a bad request; 502 on an unreachable gateway.
async function parcelPost(req, res, body, label) {
  if (!farmGate(req, res, 'farm.profile.read', 'farm:view')) return;
  if (!configured()) return unconfigured(res);
  let upstream;
  try {
    upstream = await gatewayFetch(GW_PARCEL, { method: 'POST', body: JSON.stringify(body) });
  } catch (err) {
    return send(res, 502, { success: false, error: `${label}_gateway_unreachable`, detail: String(err?.message ?? err) });
  }
  return relay(res, upstream, label);
}

// --- GET /farm/gw/parcel?lat=<>&lon=<> -------------------------------------
// FIND-MY-FARM (drop-a-pin): resolve an editable parcel boundary from a point.
// POST {point:{lat,lon}} to the gateway's gis_parcel router.
export async function parcel(req, res, url) {
  const sp = url?.searchParams;
  const lat = Number(sp?.get('lat')); const lon = Number(sp?.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return send(res, 400, { success: false, error: 'farm_parcel_bad_latlon' });
  }
  return parcelPost(req, res, { point: { lat, lon }, include_context: false }, 'farm_parcel');
}

// --- GET /farm/gw/parcel-by-address?q=<address> ----------------------------
// FIND-MY-FARM (typed address): same gis_parcel endpoint, POST {address}.
export async function parcelByAddress(req, res, url) {
  const q = (url?.searchParams?.get('q') ?? '').trim();
  if (!q) return send(res, 400, { success: false, error: 'farm_parcel_missing_q' });
  return parcelPost(req, res, { address: q, include_context: false }, 'farm_parcel_by_address');
}

// --- POST /farm/gw/scan -----------------------------------------------------
// Forward the JSON body verbatim; inject tenant_id from the resolved tenant if
// the client omitted it. The gateway owns all validation (span/AOI → 422).
export async function scan(req, res) {
  // Scan launches real orbiter work → gate on the farm write permission…
  if (!farmGate(req, res, 'farm.profile.write', 'farm:onboard')) return;
  // …and on the plan tier — on-demand HD EO scans are a Pro/Business feature.
  if (!(await requireFeature(req, res, 'studio.scan.hd'))) return;
  if (!configured()) return unconfigured(res);
  let body;
  try { body = await readBody(req); } catch { body = null; }
  const payload = (body && typeof body === 'object') ? { ...body } : {};
  if (payload.tenant_id == null && req.tenant?.id != null) payload.tenant_id = req.tenant.id;
  let upstream;
  try {
    upstream = await gatewayFetch('/api/farm/scan', { method: 'POST', body: JSON.stringify(payload) });
  } catch (err) {
    return send(res, 502, {
      success: false, error: 'farm_scan_gateway_unreachable',
      detail: String(err?.message ?? err),
    });
  }
  return relay(res, upstream, 'farm_scan');
}

// --- POST /farm/gw/aoi/from-geom -------------------------------------------
// FIND-MY-FARM → SCAN keystone: register the operator's REFINED polygon as an AOI
// so a scan can run against the exact boundary. Forward { name, geom_geojson }
// verbatim; the gateway stores the polygon in app_meta.aoi and returns { aoi_id }.
// (Gateway exposes this with NO app-layer auth — the nginx allow-list is the gate
// — but we still inject the Bearer for uniformity; it is simply ignored there.)
export async function aoiFromGeom(req, res) {
  if (!farmGate(req, res, 'farm.profile.write', 'farm:onboard')) return;
  if (!configured()) return unconfigured(res);
  let body;
  try { body = await readBody(req); } catch { body = null; }
  const payload = (body && typeof body === 'object') ? { ...body } : {};
  let upstream;
  try {
    upstream = await gatewayFetch('/api/aoi/from-geom', { method: 'POST', body: JSON.stringify(payload) });
  } catch (err) {
    return send(res, 502, {
      success: false, error: 'aoi_from_geom_gateway_unreachable',
      detail: String(err?.message ?? err),
    });
  }
  return relay(res, upstream, 'aoi_from_geom');
}

// --- POST /farm/gw/vision/segment  and  /farm/gw/vision/segment/refine -----
// AI PARCEL AUTO-TRACE + OBJECT-TO-TWIN: the gateway's unified vision endpoint
// (YOLO-seg + Grounding-DINO one-shot; SAM2 cached-embedding refine). Contract
// agreed in wing_farm-agent (c3b3114b). The endpoint is BUILT but ships in a
// batched gateway recreate — until then it 404s. We forward the JSON body
// verbatim and, unlike the generic relay, PRESERVE a 404 as a clean
// {error:'vision_not_available'} so the client shows an honest "coming soon"
// instead of a hard error. 200 (cached imagery) or 202 {jobId} (fresh S2 fetch,
// reuses the farm.progress/complete SSE) both pass through untouched.
async function visionRelay(req, res, gwPath, label) {
  if (!farmGate(req, res, 'farm.profile.read', 'farm:view')) return;
  if (!configured()) return unconfigured(res);
  let body;
  try { body = await readBody(req); } catch { body = null; }
  const payload = (body && typeof body === 'object') ? { ...body } : {};
  let upstream;
  try {
    upstream = await gatewayFetch(gwPath, { method: 'POST', body: JSON.stringify(payload) });
  } catch (err) {
    return send(res, 502, { success: false, error: `${label}_gateway_unreachable`, detail: String(err?.message ?? err) });
  }
  // Endpoint not deployed yet (batched recreate pending) → honest 404 signal.
  if (upstream.status === 404) {
    return send(res, 404, { success: false, error: 'vision_not_available' });
  }
  return relay(res, upstream, label);
}

export async function visionSegment(req, res) {
  return visionRelay(req, res, '/api/vision/segment', 'vision_segment');
}
export async function visionRefine(req, res) {
  return visionRelay(req, res, '/api/vision/segment/refine', 'vision_refine');
}
// Purpose-built parcel auto-trace: the gis_parcel delineate alias runs SAM2 at a
// point and returns a CLEAN top-level { ok, boundary:<Polygon>, area_ha, source,
// tier, confidence, twinSeed } — no surface-factory wrapper. Preferred for
// find-my-farm; same graceful-404 posture.
export async function visionDelineate(req, res) {
  return visionRelay(req, res, '/api/gis/parcel/delineate', 'vision_delineate');
}

// --- GET /farm/gw/jobs/:jobId ----------------------------------------------
// Poll-style redis job snapshot (producer results land on .producers).
export async function job(req, res, jobId) {
  return jsonRelay(req, res, `/api/farm/jobs/${encodeURIComponent(jobId)}`, 'farm_job');
}

// --- GET /farm/gw/jobs/:jobId/events ---------------------------------------
// SSE passthrough. We forward gateway frames straight through (already
// farm.progress|farm.complete|farm.error named events with the exact harvest
// tick shape — no reshaping). Skeleton clones streamRemoteHarvestJob: manual
// event-stream headers, 15s ': ping' heartbeat, AbortController on client close.
export async function jobEvents(req, res, jobId) {
  if (!farmGate(req, res, 'farm.profile.read', 'farm:view')) return;
  if (!configured()) return unconfigured(res);

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': ORIGIN,
  });
  res.write(`: connected job=${jobId} (farm relay)\n\n`);

  const ac = new AbortController();
  const heartbeat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* socket gone */ }
  }, 15_000);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    try { ac.abort(); } catch { /* ignore */ }
    try { res.end(); } catch { /* ignore */ }
  };
  res.on('close', finish);

  const emitError = (message) => {
    try { res.write(`event: farm.error\ndata: ${JSON.stringify({ type: 'error', message })}\n\n`); }
    catch { /* drop */ }
  };

  let upstream;
  try {
    upstream = await fetch(
      `${GATEWAY_ORIGIN}/api/farm/jobs/${encodeURIComponent(jobId)}/events`,
      {
        headers: {
          accept: 'text/event-stream',
          ...(HARVEST_TOKEN ? { authorization: `Bearer ${HARVEST_TOKEN}` } : {}),
        },
        signal: ac.signal,
      },
    );
  } catch (err) {
    emitError(`cannot reach farm gateway: ${err?.message ?? err}`);
    return finish();
  }
  if (!upstream.ok || !upstream.body) {
    emitError(`farm gateway events ${upstream.status}`);
    return finish();
  }

  // Byte-forward: reframe on \n\n boundaries and write each complete frame
  // straight through (the gateway's event names + tick shape are already the
  // browser contract, so no normalization — just faithful passthrough).
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        try { res.write(frame + '\n\n'); } catch { return finish(); }
      }
    }
    if (buf.length) { try { res.write(buf); } catch { /* ignore */ } }
    finish();
  } catch (err) {
    if (!done && !ac.signal.aborted) emitError(`farm stream lost: ${err?.message ?? err}`);
    finish();
  }
}
