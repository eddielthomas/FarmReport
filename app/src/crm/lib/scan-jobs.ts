// =============================================================================
// scan-jobs.ts — background HD-twin build jobs.
// -----------------------------------------------------------------------------
// An HD parcel twin takes 5+ minutes to compose on the AlphaGeo backend. The app
// must NOT block while it runs: launching a scan records a job here (persisted to
// localStorage), returns immediately, and a runner (ScanJobsRunner) drives it to
// completion in the background — surviving navigation away from and back to the
// studio, since the gateway job outlives any one page.
//
// On completion the runner pulls the composed twin (GET /farm/gw/twins/:aoi) and
// materializes it into the twins store. The gateway twin schema is unconfirmed
// (spec ask B4), so extraction is deliberately defensive with a fallback to the
// refined boundary the user submitted.
// =============================================================================

import { useCallback, useSyncExternalStore } from 'react';
import { extractPolygonal } from '@crm/components/farm/BoundaryImport';
import {
  aoiFromGeom, runScan, streamJobEvents, fetchTwins,
  type Bbox, type ScanSignal, type CompositeTwin,
} from './gateway-signals';
import {
  CATALOG, makeTwinFromCatalog, upsertTwinExternal, getTwinById,
  type Twin, type Reading,
} from './twins-store';

export type ScanJobStatus = 'running' | 'complete' | 'error';

export interface ScanJob {
  id: string;                       // local job id
  jobId: string;                    // gateway job id
  aoiId: string | null;             // gateway AOI id (for twins/:aoi)
  propertyId: string | null;
  twinId: string | null;            // twin being (re)built, if launched from one
  label: string;                    // display name (farm / field)
  signals: ScanSignal[];
  boundary: [number, number][] | null; // refined ring — fallback geometry
  status: ScanJobStatus;
  pct: number;                      // 0..100
  stage?: string;
  message?: string;
  startedAt: number;
  updatedAt: number;
  resultTwinId?: string;            // materialized twin id on complete
}

// ---- localStorage-backed store (mirrors twins-store) ------------------------

const STORAGE_KEY = 'rf.studio.scanjobs.v1';
const CHANGE_EVENT = 'rf:scanjobs:change';

let cachedRaw: string | null | undefined;
let cachedJobs: ScanJob[] = [];

function loadJobs(): ScanJob[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === cachedRaw) return cachedJobs;
    cachedRaw = raw;
    cachedJobs = raw ? (JSON.parse(raw) as ScanJob[]) : [];
    if (!Array.isArray(cachedJobs)) cachedJobs = [];
    return cachedJobs;
  } catch {
    cachedJobs = [];
    return cachedJobs;
  }
}

function serverSnapshot(): ScanJob[] { return []; }

function subscribe(cb: () => void) {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}

function persist(jobs: ScanJob[]) {
  if (typeof window === 'undefined') return;
  const raw = JSON.stringify(jobs);
  cachedRaw = raw;
  cachedJobs = jobs;
  window.localStorage.setItem(STORAGE_KEY, raw);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Patch a job by id from anywhere (the runner lives outside the hook). */
export function patchJob(id: string, patch: Partial<ScanJob>) {
  persist(loadJobs().map((j) => (j.id === id ? { ...j, ...patch, updatedAt: Date.now() } : j)));
}

export function getJob(id: string): ScanJob | null {
  return loadJobs().find((j) => j.id === id) ?? null;
}

// ---- materialization: composed twin → studio Twin ---------------------------

function ringFromComposite(c: CompositeTwin): [number, number][] | null {
  const g = c.geometry ?? c.boundary ?? c.aoi?.geometry ?? c.aoi?.boundary;
  const poly = extractPolygonal(g);
  if (!poly) return null;
  const outer = poly.type === 'Polygon' ? poly.coordinates[0] : poly.coordinates[0]?.[0];
  return (outer as [number, number][]) ?? null;
}

function readingsFromComposite(c: CompositeTwin): Reading[] {
  const out: Reading[] = [];
  const ind = c.indicators;
  if (ind && typeof ind === 'object') {
    for (const [k, v] of Object.entries(ind)) {
      if (v == null || typeof v === 'object') continue;
      out.push({ label: k, value: String(v) });
      if (out.length >= 6) break;
    }
  }
  const sigs = Array.isArray(c.signals) ? c.signals : (c.signals as { features?: unknown[] } | undefined)?.features;
  if (Array.isArray(sigs)) out.unshift({ label: 'Signals', value: String(sigs.length) });
  if (Array.isArray(c.orbiters)) out.push({ label: 'Orbiters', value: String(c.orbiters.length) });
  if (Array.isArray(c.rasters)) out.push({ label: 'Rasters', value: String(c.rasters.length) });
  return out.slice(0, 6);
}

/** Build (or refresh) a studio Twin from the backend-composed parcel twin. */
export function materializeParcelTwin(job: ScanJob, composite: CompositeTwin): Twin {
  const field = CATALOG.find((c) => c.kind === 'field') ?? CATALOG[0];
  const base = job.twinId ? getTwinById(job.twinId) : null;
  const id = base?.id ?? `t_gw_${job.aoiId ?? job.jobId}`;
  const ring = ringFromComposite(composite) ?? job.boundary;
  const seed = base ?? makeTwinFromCatalog(field, job.propertyId);
  const now = Date.now();
  return {
    ...seed,
    id,
    name: base?.name ?? `${job.label} · HD twin`,
    category: 'field',
    kind: base?.kind ?? 'field',
    geom: ring && ring.length >= 3 ? { type: 'polygon', ring } : seed.geom,
    status: { online: true, readings: readingsFromComposite(composite) },
    specs: { ...seed.specs, notes: `HD twin composed by AlphaGeo · AOI ${job.aoiId ?? '—'} · ${new Date(now).toISOString().slice(0, 10)}` },
    createdAt: base?.createdAt ?? now,
    updatedAt: now,
  };
}

// ---- job lifecycle: launch + drive ------------------------------------------

const POLL_MS = 5000;
const MAX_MS = 12 * 60 * 1000; // generous ceiling well past the ~5-min build

function closeRing(r: [number, number][]): [number, number][] {
  return (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) ? [...r, r[0]] : r;
}
function bboxRing(b: Bbox): [number, number][] {
  const [w, s, e, n] = b;
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}

/**
 * Launch the full HD-twin build: register the REFINED polygon as an AOI
 * (/api/aoi/from-geom), then scan it. Awaits only the fast round-trips (from-geom
 * + 202 scan ack), then returns — the runner drives the 5-min build in the
 * background. Returns the job, or null when the gateway is unconfigured.
 */
export async function launchScanJob(args: {
  bbox: Bbox;
  signals: ScanSignal[];
  ring?: [number, number][] | null;
  propertyId: string | null;
  twinId?: string | null;
  label: string;
}): Promise<ScanJob | null> {
  // AOI polygon: the operator's refined ring if present, else the property bbox.
  const ring = args.ring && args.ring.length >= 3 ? closeRing(args.ring) : bboxRing(args.bbox);
  const geom: GeoJSON.Polygon = { type: 'Polygon', coordinates: [ring] };
  // 1) Register the exact polygon → aoi_id.
  const aoi = await aoiFromGeom(geom, args.label);
  if (!aoi.configured) return null;
  // 2) Launch the scan over that AOI.
  const res = await runScan(aoi.aoiId, args.signals);
  if (!res.configured) return null;
  const now = Date.now();
  const job: ScanJob = {
    id: `sj_${now}_${String(res.ack.jobId).slice(0, 10)}`,
    jobId: String(res.ack.jobId),
    aoiId: aoi.aoiId,
    propertyId: args.propertyId,
    twinId: args.twinId ?? null,
    label: args.label,
    signals: args.signals,
    boundary: args.ring ?? ring,
    status: 'running',
    pct: 0,
    stage: res.ack.status ?? 'launched',
    startedAt: now,
    updatedAt: now,
  };
  persist([...loadJobs(), job]);
  return job;
}

function pctOf(d: Record<string, unknown>): number | undefined {
  const v = d.pct ?? d.progress ?? d.percent;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n <= 1 ? n * 100 : n)) : undefined;
}

function twinLooksReady(t: CompositeTwin): boolean {
  const sig = Array.isArray(t.signals) ? t.signals : (t.signals as { features?: unknown[] } | undefined)?.features;
  return Boolean(t.geometry || t.aoi?.geometry || (Array.isArray(t.rasters) && t.rasters.length) || (Array.isArray(sig) && sig.length));
}

/** Pull the composed twin and materialize it. Returns true on success. */
async function completeFromTwin(localId: string): Promise<boolean> {
  const job = getJob(localId);
  if (!job?.aoiId) return false;
  const tw = await fetchTwins(job.aoiId);
  if (!tw.configured) return false;
  const twin = materializeParcelTwin(job, tw.twin);
  upsertTwinExternal(twin);
  patchJob(localId, { status: 'complete', pct: 100, resultTwinId: twin.id, message: 'HD twin ready.' });
  return true;
}

/**
 * Drive one running job via the SSE progress stream (farm.progress →
 * farm.complete), then materialize the composed twin from twins/{aoi}. Aborts
 * cleanly on navigation (job stays 'running' → resumes on return). Reconnects on
 * stream drop and, on any clean stream-end, checks twins/{aoi} as the source of
 * truth so a build that finished while we were away still lands. `onDone` fires once.
 */
export async function driveJob(localId: string, signal: AbortSignal, onDone: () => void): Promise<void> {
  const job0 = getJob(localId);
  if (!job0 || job0.status !== 'running') { onDone(); return; }
  const deadline = Date.now() + MAX_MS;
  let settled = false;
  const settle = () => { if (!settled) { settled = true; onDone(); } };

  while (!signal.aborted && Date.now() < deadline) {
    let sawComplete = false, sawError = false;
    try {
      await streamJobEvents(job0.jobId, (ev) => {
        const d = ev.data;
        if (/complete|finished|done/i.test(ev.event)) sawComplete = true;
        else if (/error|failed/i.test(ev.event)) { sawError = true; patchJob(localId, { status: 'error', message: String(d.message ?? 'Backend error.') }); }
        else {
          const pct = pctOf(d);
          const stage = String(d.stage ?? d.status ?? ev.event.replace(/^farm\./, '')) || undefined;
          patchJob(localId, { pct: pct ?? getJob(localId)?.pct ?? 0, stage });
        }
      }, signal);
    } catch (err) {
      if (signal.aborted) return; // navigation — resume on remount
      if (String((err as Error)?.message ?? '').includes('unconfigured')) {
        patchJob(localId, { status: 'error', message: 'Gateway not connected.' }); settle(); return;
      }
      // stream-level error → fall through to a twins check, then reconnect.
    }
    if (sawError) { settle(); return; }
    if (sawComplete) {
      try { if (!(await completeFromTwin(localId))) patchJob(localId, { status: 'complete', pct: 100, message: 'Scan complete (twin not returned).' }); }
      catch { patchJob(localId, { status: 'complete', pct: 100, message: 'Scan complete (twin fetch failed).' }); }
      settle(); return;
    }
    // Stream ended without a verdict — the build may have finished while away.
    try {
      const job = getJob(localId);
      if (job?.aoiId) {
        const tw = await fetchTwins(job.aoiId);
        if (tw.configured && twinLooksReady(tw.twin)) { await completeFromTwin(localId); settle(); return; }
      }
    } catch { /* keep retrying */ }
    await sleep(POLL_MS, signal); // brief backoff before reconnecting the stream
  }
  if (!signal.aborted) patchJob(localId, { status: 'error', message: 'Timed out waiting for the backend.' });
  settle();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// ---- hook -------------------------------------------------------------------

export function useScanJobs() {
  const jobs = useSyncExternalStore(subscribe, loadJobs, serverSnapshot);
  const remove = useCallback((id: string) => persist(loadJobs().filter((j) => j.id !== id)), []);
  const clearFinished = useCallback(() => persist(loadJobs().filter((j) => j.status === 'running')), []);
  return { jobs, remove, clearFinished };
}
