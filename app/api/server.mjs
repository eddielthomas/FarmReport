#!/usr/bin/env node
// =============================================================================
// MVP API â€” read-only Node http server in front of PostGIS (rwr schema).
// -----------------------------------------------------------------------------
// Closes the README "no backend yet" gap: the dashboard's bundled JSON shapes
// are reproduced 1:1 from the seeded rwr.* tables, so the front-end can swap
// `import './harvest/*.json'` for `fetch('/api/...')` without changing the
// data shape consumed by `detections.js`.
//
// Endpoints:
//   GET /healthz                                       â†’ liveness probe
//   GET /readyz                                        â†’ DB ping
//   GET /api/sub-projects                              â†’ catalog list
//   GET /api/sub-projects/:id/overall                  â†’ [recover_overall row]
//   GET /api/sub-projects/:id/links                    â†’ links.json shape
//   GET /api/sub-projects/:id/pois                     â†’ pois.json shape
//   GET /api/sub-projects/:id/field-results            â†’ field-results.json shape
//   GET /api/sub-projects/:id/geometry                 â†’ poi-geometry.geojson
//   GET /api/sub-projects/:id/pipes                    â†’ pipes.geojson
//   GET /api/sub-projects/:id/poi-attrs                â†’ poi-attrs.json
//   GET /api/sub-projects/:id/inspections              â†’ inspections.json
//   GET /api/sub-projects/:id/counts                   â†’ header-counts.json
//   GET /api/sub-projects/:id/header-filters           â†’ header-filters.json
//   GET /api/sub-projects/:id/metrics                  â†’ metrics-values.json
//   GET /api/sub-projects/:id/dashboard                â†’ dashboard.json[:id] subtree
//
// Env (defaults match infra/docker-compose.yml port mapping):
//   PGHOST=localhost PGPORT=5434 PGUSER=rwr PGPASSWORD=rwr PGDATABASE=rwr
//   PORT=5180
// =============================================================================

import http from 'node:http';
import { readFile, stat as fsStat } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import pg from 'pg';
import { handleV1 } from './v1/index.mjs';
import { runMigrations } from './v1/db/migrate.mjs';
import { startAlphaGeoIngest } from './ingest-alphageo.mjs';
import { startAsterraIngest } from './ingest-asterra.mjs';
import { attachSocketIo } from './v1/chat/socket.mjs';
import {
  requireAccessGate,
  stampSyntheticPass,
  PASS_COOKIE_NAME,
} from './v1/middleware/accessGate.mjs';

// Harvest dir is colocated with the bundled JSON the front-end imports â€”
// these endpoints serve it verbatim until/unless the rwr.* schema grows
// columns for them.
const HARVEST = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'harvest');
const readHarvest = async (name) => JSON.parse(await readFile(join(HARVEST, name), 'utf8'));

const cfg = {
  host:     process.env.PGHOST     ?? 'localhost',
  port:     Number(process.env.PGPORT ?? 5434),
  user:     process.env.PGUSER     ?? 'rwr',
  password: process.env.PGPASSWORD ?? 'rwr',
  database: process.env.PGDATABASE ?? 'rwr',
};

const PORT = Number(process.env.PORT ?? 5180);
const ORIGIN = process.env.CORS_ORIGIN ?? '*';

const pool = new pg.Pool(cfg);

// ---- helpers ---------------------------------------------------------------
const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(payload);
};

const notFound = (res) => json(res, 404, { error: 'not_found' });
const serverErr = (res, err) => {
  console.error('[api] error:', err);
  json(res, 500, { error: 'internal_error', detail: String(err?.message ?? err) });
};

// ---- route handlers --------------------------------------------------------
async function listSubProjects(res) {
  const { rows } = await pool.query(`
    SELECT sub_project_id, name, status, captured_at,
           poi_count, leak_count, pipe_km_total, pipe_km_investigated
      FROM rwr.sub_projects
     ORDER BY sub_project_id
  `);
  json(res, 200, rows);
}

async function getOverall(res, id) {
  const { rows } = await pool.query(
    'SELECT raw_overall FROM rwr.sub_projects WHERE sub_project_id = $1',
    [id],
  );
  if (rows.length === 0) return notFound(res);
  // harvest shape is `[{...}]` â€” preserve the array wrapper
  json(res, 200, [rows[0].raw_overall]);
}

async function getLinks(res, id) {
  const { rows } = await pool.query(
    `SELECT web_application_url AS web_application,
            wms_url             AS wms,
            gis_files_url       AS gis_files
       FROM rwr.sub_projects WHERE sub_project_id = $1`,
    [id],
  );
  if (rows.length === 0) return notFound(res);
  json(res, 200, rows[0]);
}

async function getPois(res, id) {
  const { rows } = await pool.query(
    `SELECT raw FROM rwr.pois
      WHERE sub_project_id = $1
      ORDER BY id`,
    [id],
  );
  json(res, 200, rows.map((r) => r.raw));
}

async function getFieldResults(res, id) {
  const { rows } = await pool.query(
    `SELECT raw FROM rwr.field_results
      WHERE sub_project_id = $1
      ORDER BY ogc_fid`,
    [id],
  );
  json(res, 200, rows.map((r) => r.raw));
}

// ---- harvest-backed handlers ----------------------------------------------
// These surfaces don't yet have rwr.* columns; serve the harvested JSON
// verbatim so byte-equivalence with the bundled path holds. The :id check
// is just a guard â€” the bundled harvest only contains sub_project 676251.
const SUB_676251 = 676251;

async function getGeometry(res, id) {
  if (id !== SUB_676251) return notFound(res);
  json(res, 200, await readHarvest('poi-geometry.geojson'));
}
async function getPipes(res, id) {
  if (id !== SUB_676251) return notFound(res);
  // pipes.geojson may be missing on a fresh checkout (GIS Cloud requires
  // creds); serve an empty FeatureCollection in that case so the dashboard
  // renders an empty Pipe Network layer instead of erroring.
  try {
    json(res, 200, await readHarvest('pipes.geojson'));
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      json(res, 200, { type: 'FeatureCollection', features: [] });
    } else {
      throw err;
    }
  }
}
async function getPoiAttrs(res, id) {
  if (id !== SUB_676251) return notFound(res);
  try {
    json(res, 200, await readHarvest('poi-attrs.json'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return json(res, 200, {});
    throw err;
  }
}
async function getInspections(res, id) {
  if (id !== SUB_676251) return notFound(res);
  try {
    json(res, 200, await readHarvest('inspections.json'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return json(res, 200, []);
    throw err;
  }
}
async function getCounts(res, id) {
  if (id !== SUB_676251) return notFound(res);
  json(res, 200, await readHarvest('header-counts.json'));
}
async function getHeaderFilters(res, id) {
  if (id !== SUB_676251) return notFound(res);
  json(res, 200, await readHarvest('header-filters.json'));
}
async function getMetrics(res, id) {
  if (id !== SUB_676251) return notFound(res);
  json(res, 200, await readHarvest('metrics-values.json'));
}
async function getDashboard(res, id) {
  if (id !== SUB_676251) return notFound(res);
  const dash = await readHarvest('dashboard.json');
  // dashboard.json is keyed by sub_project_id; surface just the requested
  // subtree (same shape build-ds.js consumes via dashboard[SUB_PROJECT]).
  const sub = dash?.[String(id)] ?? null;
  if (!sub) return notFound(res);
  json(res, 200, sub);
}

// ---- harvest refresh control plane -----------------------------------------
// POST /api/harvest/refresh                  â†’ spawn orchestrator, return {jobId}
// GET  /api/harvest/jobs/:jobId/events       â†’ SSE: NDJSON stdout â†’ typed events
//
// The python orchestrator at services/ingest-service emits one NDJSON line
// per stage transition (discover â†’ kmz â†’ shp â†’ xlsx â†’ giscloud â†’ publish).
// Each line is forwarded to subscribers as `event: harvest.progress |
// harvest.complete | harvest.error`. Replay buffer covers late subscribers
// who connect after the POST returns.

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INGEST_SRC = resolvePath(REPO_ROOT, 'services', 'ingest-service', 'src');
const PYTHON_BIN = process.env.PYTHON_BIN ?? 'python';
const HARVEST_JOB_TTL_MS = 5 * 60 * 1000;
const HARVEST_REPLAY_CAP = 64;

// Harvest execution mode (env-switched — same code runs three ways):
//   • unset ALPHAGEO_HARVEST_BASE  → 'local': spawn the in-repo Python
//     orchestrator (dev box that has services/ingest-service/).
//   • ALPHAGEO_HARVEST_BASE set    → 'relay': POST to the AlphaGeoCore harvest
//     gateway server-to-server (Bearer cap-token, never in the browser) and
//     relay its SSE stream back to our same-origin browser. Point it at a
//     LOCAL gateway (http://127.0.0.1:…) for integration testing or the
//     deployed gateway for prod — the URL is the only thing that changes.
// The browser contract (harvest-refresh.js) is identical in both modes.
const HARVEST_BASE  = (process.env.ALPHAGEO_HARVEST_BASE ?? '').replace(/\/+$/, '');
const HARVEST_TOKEN = process.env.ALPHAGEO_HARVEST_TOKEN ?? '';
const HARVEST_MODE  = HARVEST_BASE ? 'relay' : 'local';
const HARVEST_SUB_PROJECT_ID = process.env.HARVEST_SUB_PROJECT_ID ?? '676251';
// The gateway resolves sub_project_id → AOI bbox via its own table; our demo
// sub-project (676251) isn't in that table, so without an explicit bbox the
// harvest errors `no_bbox`. We always send a bbox (the browser's if provided,
// else this default) — [W,S,E,N], the extent of the bundled 676251 harvest
// geometry (Houston/Demoville AOI). Override with HARVEST_DEFAULT_BBOX='[W,S,E,N]'.
const HARVEST_DEFAULT_BBOX = (() => {
  const raw = process.env.HARVEST_DEFAULT_BBOX;
  if (raw) {
    try { const a = JSON.parse(raw); if (Array.isArray(a) && a.length === 4 && a.every(Number.isFinite)) return a; }
    catch { /* fall through to built-in */ }
  }
  return [-95.76995, 29.97325, -95.69681, 30.04567];
})();
console.log(`[api] harvest mode=${HARVEST_MODE}${HARVEST_BASE ? ` base=${HARVEST_BASE}` : ''}`);

// AlphaGeoCore gateway origin (for the leak read-path + detection APIs, which
// live at /api/fluoridegeo/* and /api/detections/*, NOT under /api/harvest).
// Derived from ALPHAGEO_HARVEST_BASE by stripping the trailing /api/harvest,
// overridable via ALPHAGEO_GATEWAY_ORIGIN. Reuses ALPHAGEO_HARVEST_TOKEN +
// the box's already-allow-listed egress IP.
const GATEWAY_ORIGIN = (process.env.ALPHAGEO_GATEWAY_ORIGIN
  ?? HARVEST_BASE.replace(/\/api\/harvest\/?$/, '')).replace(/\/+$/, '');

// Server-to-server fetch to the AlphaGeoCore gateway. The harvest path takes a
// Bearer token, but /api/fluoridegeo/* + /api/detections/* may sit behind nginx
// Basic auth ("the creds you already use"). Send Bearer first; if 401 and
// ALPHAGEO_GATEWAY_BASIC (user:pass) is set, retry with Basic — so a prod
// auth-scheme mismatch is an env tweak, not a redeploy. `gwPath` is the path +
// query relative to GATEWAY_ORIGIN (e.g. '/api/detections/123/review').
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

// Stream a gateway Response back to the browser, mapping upstream failures to a
// JSON error envelope (422 passthrough; everything else → 502). `label` names
// the relay in error payloads/logs.
async function relayGatewayResponse(res, upstream, label) {
  const text = await upstream.text();
  if (!upstream.ok) {
    return json(res, upstream.status === 422 ? 422 : 502, {
      error: `${label}_gateway_error`, status: upstream.status, detail: text.slice(0, 300),
    });
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': ORIGIN,
  });
  res.end(text);
}

// GET /api/leaks/by-bbox?west=&south=&east=&north= — server-to-server relay of
// the gateway's leak-indicator read-path (returns a GeoJSON FeatureCollection).
// Browser-safe (no token, IP gate is satisfied by the box); the dashboard's
// per-project loader hits this to fetch a project AOI's leaks.
async function getLeaksByBbox(res, url) {
  if (!GATEWAY_ORIGIN) return json(res, 503, { error: 'leaks_gateway_unconfigured' });
  const q = url.searchParams;
  const nums = ['west', 'south', 'east', 'north'].map((k) => Number(q.get(k)));
  if (nums.some((n) => !Number.isFinite(n))) {
    return json(res, 400, { error: 'bad_bbox', message: 'west,south,east,north required (numbers)' });
  }
  const [west, south, east, north] = nums;
  const limit = Math.min(Math.max(Number(q.get('limit')) || 2000, 1), 5000);
  const gwPath = `/api/fluoridegeo/pois-by-bbox`
    + `?west=${west}&south=${south}&east=${east}&north=${north}&limit=${limit}`;
  let upstream;
  try {
    upstream = await gatewayFetch(gwPath);
  } catch (err) {
    console.warn('[api] leaks relay fetch failed:', err?.message ?? err);
    return json(res, 502, { error: 'leaks_gateway_unreachable', message: String(err?.message ?? err) });
  }
  return relayGatewayResponse(res, upstream, 'leaks');
}

// Phase 2 — detection review + field dispatch. Server-to-server relay of the
// gateway's /api/detections/* surface (dossier, review lifecycle, notes,
// workflow definition, dispatch queue). Browser-safe (behind the site access
// gate); the gateway is the authority on the manager-only review transition.
// Supported (validated against DET_ID = digits):
//   GET   /api/detections/workflow
//   GET   /api/detections?status=…&limit=…           (dispatch queue)
//   GET   /api/detections/{id}                        (dossier)
//   PATCH /api/detections/{id}/review                 (manager-only, gateway-enforced)
//   POST  /api/detections/{id}/notes                  (add note)
const DET_ID = /^\d+$/;
async function relayDetections(req, res, url) {
  if (!GATEWAY_ORIGIN) return json(res, 503, { error: 'detections_gateway_unconfigured' });
  const path = url.pathname;
  const method = req.method;

  // Resolve the path → gateway path + allowed method.
  let gwPath = null;
  let needsBody = false;
  if (path === '/api/detections/workflow' && method === 'GET') {
    gwPath = '/api/detections/workflow';
  } else if (path === '/api/detections' && method === 'GET') {
    const status = url.searchParams.get('status') || '';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 1000);
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    qs.set('limit', String(limit));
    gwPath = `/api/detections?${qs.toString()}`;
  } else {
    const m = path.match(/^\/api\/detections\/([^/]+)(\/review|\/notes)?$/);
    if (m && DET_ID.test(m[1])) {
      const id = m[1];
      const sub = m[2] || '';
      if (sub === '' && method === 'GET')          gwPath = `/api/detections/${id}`;
      else if (sub === '/review' && method === 'PATCH') { gwPath = `/api/detections/${id}/review`; needsBody = true; }
      else if (sub === '/notes' && method === 'POST')   { gwPath = `/api/detections/${id}/notes`;  needsBody = true; }
    }
  }
  if (!gwPath) return json(res, 404, { error: 'detections_route_not_found' });

  let body = null;
  if (needsBody) {
    try { body = JSON.stringify((await readBody(req)) || {}); }
    catch { return json(res, 400, { error: 'bad_body' }); }
  }

  let upstream;
  try {
    upstream = await gatewayFetch(gwPath, { method, body });
  } catch (err) {
    console.warn('[api] detections relay fetch failed:', err?.message ?? err);
    return json(res, 502, { error: 'detections_gateway_unreachable', message: String(err?.message ?? err) });
  }
  return relayGatewayResponse(res, upstream, 'detections');
}

// Read + JSON-parse a request body (tolerates an empty body → {}). Used by the
// relay POST so the browser can optionally pass {sub_project_id, stages, bbox};
// today harvest-refresh.js sends none, so we fall back to HARVEST_SUB_PROJECT_ID.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Normalize one harvest tick to the browser envelope harvest-refresh.js parses.
// Accepts BOTH our native `{type:'progress'|'complete'|'error', …}` shape AND
// AlphaGeoCore's native `{stage, state, done, total, message, _final}` shape, so
// the gateway can emit either and the FE contract stays stable. Returns
// {kind:'progress'|'complete'|'error', data} or null for non-data ticks.
function normalizeHarvestTick(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const { type: t, state } = obj;

  const isError = t === 'error' || state === 'error' || state === 'failed' || obj.error != null;
  if (isError) {
    return { kind: 'error', data: { message: String(obj.message ?? obj.error ?? 'harvest failed') } };
  }

  const isComplete = t === 'complete' || obj.stage === '_final' ||
                     state === 'complete' || state === 'done' || obj.done_all === true;
  if (isComplete) {
    const summary = (obj.summary && typeof obj.summary === 'object') ? obj.summary
                  : (obj.counts && typeof obj.counts === 'object') ? obj.counts : {};
    return { kind: 'complete', data: {
      duration_ms: Number(obj.duration_ms ?? obj.elapsed_ms ?? 0) || 0,
      summary,
    } };
  }

  // Progress.
  let pct = (typeof obj.pct === 'number') ? obj.pct : undefined;
  if (pct === undefined) {
    const done = Number(obj.done), total = Number(obj.total);
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0) pct = Math.round((done / total) * 100);
  }
  const data = {};
  if (typeof pct === 'number') data.pct = Math.max(0, Math.min(100, pct));
  if (obj.stage != null) data.stage = String(obj.stage);
  if (obj.message != null) data.message = String(obj.message);
  if (state === 'error' || obj.status === 'error') data.status = 'error';
  if (data.pct === undefined && data.stage === undefined && data.message === undefined) return null;
  return { kind: 'progress', data };
}

function harvestEventName(kind) {
  return kind === 'complete' ? 'harvest.complete'
       : kind === 'error'    ? 'harvest.error'
       :                       'harvest.progress';
}

/** @type {Map<string, {
 *   id: string,
 *   startedAt: number,
 *   finishedAt: number | null,
 *   exitCode: number | null,
 *   listeners: Set<(line: {kind:string, raw:string}) => void>,
 *   endListeners: Set<() => void>,
 *   replay: Array<{kind:string, raw:string}>,
 *   child: import('node:child_process').ChildProcess,
 * }>} */
const harvestJobs = new Map();

function reapStaleHarvestJobs() {
  const cutoff = Date.now() - HARVEST_JOB_TTL_MS;
  for (const [id, job] of harvestJobs) {
    if (job.finishedAt !== null && job.finishedAt < cutoff) harvestJobs.delete(id);
  }
}

function classifyHarvestLine(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const t = parsed?.type;
    if (t === 'progress') return { kind: 'progress', raw: trimmed };
    if (t === 'complete') return { kind: 'complete', raw: trimmed };
    if (t === 'error') return { kind: 'error', raw: trimmed };
    return null;
  } catch {
    return null;
  }
}

function spawnHarvestOrchestrator() {
  reapStaleHarvestJobs();
  const env = {
    ...process.env,
    PYTHONPATH:
      INGEST_SRC + (process.env.PYTHONPATH ? `${process.platform === 'win32' ? ';' : ':'}${process.env.PYTHONPATH}` : ''),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
  };
  const child = spawn(
    PYTHON_BIN,
    ['-m', 'rwr_ingest.orchestrator.refresh', 'run'],
    { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const job = {
    id: randomUUID(),
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    listeners: new Set(),
    endListeners: new Set(),
    replay: [],
    child,
  };

  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (rawLine) => {
    const event = classifyHarvestLine(rawLine);
    if (!event) return;
    if (job.replay.length >= HARVEST_REPLAY_CAP) job.replay.shift();
    job.replay.push(event);
    for (const fn of job.listeners) {
      try { fn(event); } catch (err) { console.warn('[api] harvest listener failed', err); }
    }
  });
  child.stderr.on('data', (chunk) => {
    // Adapter logs go here â€” surface at info level for the operator.
    process.stderr.write(`[harvest:${job.id.slice(0, 8)}] ${chunk}`);
  });
  child.on('close', (code) => {
    job.finishedAt = Date.now();
    job.exitCode = code;
    const sawComplete = job.replay.some((l) => l.kind === 'complete');
    if (!sawComplete) {
      const synth = {
        kind: 'error',
        raw: JSON.stringify({
          type: 'error',
          stage: 'orchestrator',
          message: `orchestrator exited code=${code} without complete event`,
        }),
      };
      job.replay.push(synth);
      for (const fn of job.listeners) fn(synth);
    }
    for (const fn of job.endListeners) {
      try { fn(); } catch { /* ignore */ }
    }
    console.log(
      `[api] harvest.job.finished id=${job.id} exitCode=${code} duration=${job.finishedAt - job.startedAt}ms`,
    );
  });
  child.on('error', (err) => {
    const synth = {
      kind: 'error',
      raw: JSON.stringify({
        type: 'error',
        stage: 'orchestrator',
        message: `spawn failed: ${err.message}`,
      }),
    };
    job.replay.push(synth);
    for (const fn of job.listeners) fn(synth);
    job.finishedAt = Date.now();
    job.exitCode = -1;
  });

  harvestJobs.set(job.id, job);
  console.log(`[api] harvest.job.started id=${job.id}`);
  return job;
}

// Relay mode: kick a remote harvest on the AlphaGeoCore gateway and register a
// local job record that maps our jobId → the gateway's job id.
async function startRemoteHarvestJob(body) {
  reapStaleHarvestJobs();
  const payload = {
    sub_project_id: body?.sub_project_id ?? HARVEST_SUB_PROJECT_ID,
    // Always include a bbox so the gateway never falls back to its AOI table
    // (which lacks our demo sub-project → `no_bbox`).
    bbox: Array.isArray(body?.bbox) ? body.bbox : HARVEST_DEFAULT_BBOX,
    ...(body?.stages ? { stages: body.stages } : {}),
  };
  const resp = await fetch(`${HARVEST_BASE}/refresh`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(HARVEST_TOKEN ? { authorization: `Bearer ${HARVEST_TOKEN}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`gateway refresh ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => ({}));
  const remoteJobId = data.job_id ?? data.jobId ?? data.id;
  if (!remoteJobId) throw new Error('gateway returned no job_id');
  const job = {
    id: randomUUID(),
    remoteJobId: String(remoteJobId),
    startedAt: Date.now(),
    finishedAt: null,
    mode: 'relay',
  };
  harvestJobs.set(job.id, job);
  console.log(`[api] harvest.relay.started id=${job.id} remote=${job.remoteJobId}`);
  return job;
}

// Relay mode: open the gateway's SSE stream and forward normalized ticks to our
// own browser, translating to the browser envelope. Each browser connection
// opens its own upstream stream (the gateway owns replay on its side).
async function streamRemoteHarvestJob(res, job) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': ORIGIN,
  });
  res.write(`: connected job=${job.id} (relay)\n\n`);

  const ac = new AbortController();
  const heartbeat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* socket gone */ }
  }, 15_000);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    job.finishedAt = Date.now();
    try { ac.abort(); } catch { /* ignore */ }
    try { res.end(); } catch { /* ignore */ }
  };
  res.on('close', finish);

  const emit = (kind, data) => {
    try { res.write(`event: ${harvestEventName(kind)}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* drop */ }
  };

  let upstream;
  try {
    upstream = await fetch(`${HARVEST_BASE}/jobs/${encodeURIComponent(job.remoteJobId)}/events`, {
      headers: {
        accept: 'text/event-stream',
        ...(HARVEST_TOKEN ? { authorization: `Bearer ${HARVEST_TOKEN}` } : {}),
      },
      signal: ac.signal,
    });
  } catch (err) {
    emit('error', { message: `cannot reach harvest gateway: ${err?.message ?? err}` });
    return finish();
  }
  if (!upstream.ok || !upstream.body) {
    emit('error', { message: `harvest gateway events ${upstream.status}` });
    return finish();
  }

  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const payload = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (!payload) continue; // heartbeat / comment / event-only frame
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        const norm = normalizeHarvestTick(obj);
        if (!norm) continue;
        emit(norm.kind, norm.data);
        if (norm.kind === 'complete' || norm.kind === 'error') return finish();
      }
    }
    finish(); // upstream ended without an explicit terminal tick
  } catch (err) {
    if (!done && !ac.signal.aborted) {
      emit('error', { message: `harvest stream lost: ${err?.message ?? err}` });
    }
    finish();
  }
}

async function postHarvestRefresh(req, res) {
  if (HARVEST_MODE === 'relay') {
    let body = {};
    try { body = await readBody(req); } catch { /* tolerate empty/invalid body */ }
    let job;
    try {
      job = await startRemoteHarvestJob(body);
    } catch (err) {
      console.warn('[api] harvest relay refresh failed:', err?.message ?? err);
      return json(res, 502, {
        error: 'harvest_gateway_unreachable',
        message: String(err?.message ?? err),
      });
    }
    return json(res, 202, {
      jobId: job.id,
      startedAt: new Date(job.startedAt).toISOString(),
      mode: 'relay',
    });
  }

  // Local mode: spawn the in-repo Python orchestrator (dev only).
  const job = spawnHarvestOrchestrator();
  json(res, 202, {
    jobId: job.id,
    startedAt: new Date(job.startedAt).toISOString(),
    mode: 'local',
  });
}

function streamHarvestJob(res, jobId) {
  const job = harvestJobs.get(jobId);
  if (!job) return notFound(res);

  // Relay-mode jobs forward the gateway's SSE; local jobs stream child stdout.
  if (job.mode === 'relay') return streamRemoteHarvestJob(res, job);

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': ORIGIN,
  });
  res.write(`: connected job=${job.id}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* socket gone */ }
  }, 15_000);

  const sendEvent = (line) => {
    const eventName =
      line.kind === 'complete' ? 'harvest.complete' :
      line.kind === 'error'    ? 'harvest.error'    : 'harvest.progress';
    try { res.write(`event: ${eventName}\ndata: ${line.raw}\n\n`); } catch { /* drop */ }
  };

  for (const past of job.replay) sendEvent(past);

  if (job.finishedAt !== null) {
    clearInterval(heartbeat);
    try { res.end(); } catch { /* ignore */ }
    return;
  }

  const listener = (line) => sendEvent(line);
  const endListener = () => {
    clearInterval(heartbeat);
    job.listeners.delete(listener);
    job.endListeners.delete(endListener);
    try { res.end(); } catch { /* ignore */ }
  };
  job.listeners.add(listener);
  job.endListeners.add(endListener);

  res.on('close', () => {
    clearInterval(heartbeat);
    job.listeners.delete(listener);
    job.endListeners.delete(endListener);
  });
}

// ---- router ----------------------------------------------------------------
const SUB_PATH = /^\/api\/sub-projects\/(\d+)\/(overall|links|pois|field-results|geometry|pipes|poi-attrs|inspections|counts|header-filters|metrics|dashboard)$/;
const HARVEST_JOB_PATH = /^\/api\/harvest\/jobs\/([0-9a-f-]+)\/events$/i;

// ---- Sprint 10B: static-HTML serving with access-code gate -----------------
// The Node http server normally only handles `/api/*`, `/healthz`, `/readyz`
// and lets Vite (dev) or Nginx (prod) serve the static HTML entrypoints. We
// add a defense-in-depth layer here so the gate is enforced even when the
// Node server is fronted by something that doesn't itself check the
// `rwr.access_pass` cookie.
//
// GATED_HTML  â€” authenticated surfaces; require the access-pass cookie.
// PUBLIC_HTML â€” marketing surfaces + access.html itself; always served.
// STATIC_PREFIXES â€” arbitrary asset trees that bypass the gate.

const MVP_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

const GATED_HTML = new Set([
  '/dashboard.html',
  '/sales.html',
  '/pm.html',
  '/analytics.html',
  '/tenants.html',
  '/staff.html',
  '/customer.html',
  '/operations.html',
  '/vendor.html',
  '/field.html',
  '/login.html',
  // dashboard-react is the WIP shell; gate it too so it never leaks pre-login.
  '/dashboard-react.html',
  // Private-preview posture: the marketing pages are gated too, so the single
  // access passcode protects the ENTIRE site (asked once via the cookie). Only
  // access.html + bot/asset files below stay public.
  '/',
  '/index.html',
  '/solutions.html',
  '/industries.html',
  '/platform.html',
  '/company.html',
  '/contact.html',
]);

const PUBLIC_HTML = new Set([
  '/access.html',
  // Self-service registration must be reachable WITHOUT the pilot access pass —
  // a prospect won't have the site passcode; their access code is the gate.
  '/register.html',
  '/access-gate.js',
  '/favicon.svg',
  '/field-manifest.json',
  '/field-sw.js',
  '/robots.txt',
  '/sitemap.xml',
  '/sitemap-images.xml',
  '/llms.txt',
  '/llms-full.txt',
]);

const PUBLIC_PREFIXES = ['/assets/', '/textures/', '/cesium/', '/og/', '/screenshots/', '/marketing/'];

const CONTENT_TYPE_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
};

function contentTypeFor(p) {
  const dot = p.lastIndexOf('.');
  const ext = dot >= 0 ? p.slice(dot).toLowerCase() : '';
  return CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';
}

// Resolve and serve a single file from the mvp/ root. Returns true if served,
// false if the file does not exist (caller then 404s).
async function serveStaticFile(res, relPath) {
  const safe = relPath.replace(/^\/+/, '');
  const abs  = resolvePath(MVP_ROOT, safe);
  // Path traversal guard.
  if (!abs.startsWith(MVP_ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return true;
  }
  try {
    const st = await fsStat(abs);
    if (!st.isFile()) return false;
    const buf = await readFile(abs);
    res.writeHead(200, {
      'content-type': contentTypeFor(abs),
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    res.end(buf);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

function redirectToAccess(res, nextPath) {
  const next = encodeURIComponent(nextPath || '/login.html');
  res.writeHead(302, {
    'location': `/access.html?next=${next}`,
    'cache-control': 'no-store',
  });
  res.end();
}

function isPublicStaticPath(path) {
  if (PUBLIC_HTML.has(path)) return true;
  for (const pref of PUBLIC_PREFIXES) {
    if (path.startsWith(pref)) return true;
  }
  return false;
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, x-tenant-id',
    });
    return res.end();
  }

  // /api/v1 router â€” CRM/SaaS/multitenant surface. Returns true if handled.
  if (await handleV1(req, res)) return;

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  // Detection review + dispatch relay (GET/PATCH/POST) — routed before the
  // method gates below since it accepts more than GET.
  if (path === '/api/detections' || path.startsWith('/api/detections/')) {
    return relayDetections(req, res, url);
  }

  // Harvest control plane is the only POST endpoint; SSE follow-up is GET.
  if (req.method === 'POST') {
    if (path === '/api/harvest/refresh') return postHarvestRefresh(req, res);
    return json(res, 405, { error: 'method_not_allowed' });
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

  const harvestJobMatch = path.match(HARVEST_JOB_PATH);
  if (harvestJobMatch) return streamHarvestJob(res, harvestJobMatch[1]);

  if (path === '/healthz') return json(res, 200, { ok: true });
  if (path === '/readyz') {
    try {
      await pool.query('SELECT 1');
      return json(res, 200, { ok: true, db: 'up' });
    } catch (err) {
      return json(res, 503, { ok: false, db: 'down', detail: String(err?.message ?? err) });
    }
  }
  if (path === '/api/leaks/by-bbox') return getLeaksByBbox(res, url);
  if (path === '/api/sub-projects') return listSubProjects(res);

  const m = path.match(SUB_PATH);
  if (m) {
    const id = Number(m[1]);
    const kind = m[2];
    if (kind === 'overall')         return getOverall(res, id);
    if (kind === 'links')           return getLinks(res, id);
    if (kind === 'pois')            return getPois(res, id);
    if (kind === 'field-results')   return getFieldResults(res, id);
    if (kind === 'geometry')        return getGeometry(res, id);
    if (kind === 'pipes')           return getPipes(res, id);
    if (kind === 'poi-attrs')       return getPoiAttrs(res, id);
    if (kind === 'inspections')     return getInspections(res, id);
    if (kind === 'counts')          return getCounts(res, id);
    if (kind === 'header-filters')  return getHeaderFilters(res, id);
    if (kind === 'metrics')         return getMetrics(res, id);
    if (kind === 'dashboard')       return getDashboard(res, id);
  }

  // ---- Sprint 10B: static HTML + asset serving with access-code gate ------
  // Only attempt static serving for GETs. Other methods already returned
  // method_not_allowed above.
  // 1) Gated authenticated surfaces: require a valid rwr.access_pass cookie
  //    (or the dev escape hatch). Without it, 302 â†’ /access.html?next=â€¦
  // 2) Public marketing pages + access.html + assets bypass the gate.
  // 3) Anything else falls through to 404.
  if (GATED_HTML.has(path)) {
    const gate = requireAccessGate(req);
    if (!gate.ok) return redirectToAccess(res, path);
    stampSyntheticPass(res);
    if (await serveStaticFile(res, path)) return;
    return notFound(res);
  }
  if (isPublicStaticPath(path)) {
    stampSyntheticPass(res);
    const target = path === '/' ? '/index.html' : path;
    if (await serveStaticFile(res, target)) return;
    return notFound(res);
  }

  return notFound(res);
}

// `io` is bound after server.listen() â€” see attachSocketIo call below.
let ioRef = null;

const server = http.createServer((req, res) => {
  // Decorate every request with the active socket.io server so /api/v1/chat/*
  // handlers can publish realtime envelopes via lib/chat-relay.publishChatEvent.
  // ioRef is null until attachSocketIo finishes; publishChatEvent is a no-op in
  // that window so REST keeps working.
  req.io = ioRef;
  handle(req, res).catch((err) => serverErr(res, err));
});

// Run /api/v1 migrations on boot. Failures log and continue â€” the legacy
// /api/* routes don't depend on the v1 schemas so the server can still come
// up if Postgres rejects the migration (e.g. missing pgcrypto privileges).
runMigrations(pool).catch((err) => {
  console.warn('[api/v1] migrations failed:', err?.message ?? err);
});

server.listen(PORT, () => {
  console.log(`[api] listening http://localhost:${PORT}`);
  console.log(`[api] db  postgres://${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
  // Automatic AlphaGeo (gateway) → crm.detection ingest (no-op unless
  // ALPHAGEO_AUTO_INGEST=1; enabled on prod where the gateway is reachable).
  try { startAlphaGeoIngest(); } catch (e) { console.warn('[alphageo-ingest] start failed:', e?.message ?? e); }
  // Automatic ASTERRA (Recover API) → crm.detection ingest (no-op unless
  // ASTERRA_AUTO_INGEST=1 AND ASTERRA_USERNAME/PASSWORD are set).
  try { startAsterraIngest(); } catch (e) { console.warn('[asterra-ingest] start failed:', e?.message ?? e); }
  // Report scheduler — generates + delivers due scheduled reports (farm.report_schedule).
  import('./v1/farm/report-schedule.mjs')
    .then(({ startReportScheduler }) => startReportScheduler())
    .catch((e) => console.warn('[report-scheduler] start failed:', e?.message ?? e));
  // S6A â€” attach socket.io to the live http server. attachSocketIo lazy-imports
  // the socket.io package so the server still boots when it is absent (CI
  // parity smoke / scripts that only exercise REST).
  attachSocketIo(server)
    .then((io) => {
      if (io) {
        ioRef = io;
        console.log('[api/chat] socket.io attached (path=/socket.io/)');
      } else {
        console.warn('[api/chat] socket.io not attached (module missing)');
      }
    })
    .catch((err) => {
      console.error('[api/chat] attach_failed:', err?.message ?? err);
    });
});

const shutdown = async (sig) => {
  console.log(`[api] ${sig} â€” shutting down`);
  server.close(() => { /* noop */ });
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
