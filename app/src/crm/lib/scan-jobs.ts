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
  runScan, pollJob, fetchTwins,
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

const TERMINAL_OK = ['complete', 'completed', 'finished', 'done', 'success'];
const TERMINAL_ERR = ['error', 'failed', 'cancelled', 'canceled'];
const POLL_MS = 5000;
const MAX_MS = 12 * 60 * 1000; // generous ceiling well past the ~5-min build

/**
 * Launch a scan and record a background job. Awaits ONLY the fast 202 ack, then
 * returns — the runner drives the 5-min build. Returns the created job, or null
 * when the gateway is unconfigured (caller shows "not connected").
 */
export async function launchScanJob(args: {
  bbox: Bbox;
  signals: ScanSignal[];
  boundary?: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  ring?: [number, number][] | null;
  propertyId: string | null;
  twinId?: string | null;
  label: string;
}): Promise<ScanJob | null> {
  const res = await runScan(args.bbox, args.signals, args.boundary);
  if (!res.configured) return null;
  const now = Date.now();
  const job: ScanJob = {
    id: `sj_${now}_${res.ack.jobId}`.slice(0, 48),
    jobId: String(res.ack.jobId),
    aoiId: res.ack.aoiId ?? null,
    propertyId: args.propertyId,
    twinId: args.twinId ?? null,
    label: args.label,
    signals: args.signals,
    boundary: args.ring ?? null,
    status: 'running',
    pct: 0,
    stage: res.ack.status ?? 'launched',
    startedAt: now,
    updatedAt: now,
  };
  persist([...loadJobs(), job]);
  return job;
}

function pctOf(job: Record<string, unknown>): number | undefined {
  const v = job.pct ?? job.progress ?? job.percent;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n <= 1 ? n * 100 : n)) : undefined;
}

/**
 * Drive one running job to a terminal state by polling, then materialize the
 * composed twin. Idempotent-safe: aborts cleanly via the signal (navigation),
 * leaving the job 'running' so it resumes on return. `onDone` fires once.
 */
export async function driveJob(jobId_local: string, signal: AbortSignal, onDone: () => void): Promise<void> {
  const deadline = Date.now() + MAX_MS;
  while (!signal.aborted && Date.now() < deadline) {
    await sleep(POLL_MS, signal);
    if (signal.aborted) return;
    const job = getJob(jobId_local);
    if (!job || job.status !== 'running') return;
    let snap;
    try { snap = await pollJob(job.jobId); }
    catch { continue; } // transient — keep polling
    if (!snap.configured) { patchJob(jobId_local, { status: 'error', message: 'Gateway disconnected mid-run.' }); onDone(); return; }
    const s = snap.job as Record<string, unknown>;
    const status = String(s.status ?? '').toLowerCase();
    const pct = pctOf(s);
    const aoiId = (s.aoiId as string | undefined) ?? job.aoiId;
    if (pct != null || aoiId !== job.aoiId || status) patchJob(jobId_local, { pct: pct ?? job.pct, stage: status || job.stage, aoiId: aoiId ?? null });

    if (TERMINAL_ERR.includes(status)) { patchJob(jobId_local, { status: 'error', message: `Backend reported ${status}.` }); onDone(); return; }
    if (TERMINAL_OK.includes(status)) {
      // Compose the twin from the backend.
      const fresh = getJob(jobId_local);
      const useAoi = fresh?.aoiId;
      if (useAoi) {
        try {
          const tw = await fetchTwins(useAoi);
          if (tw.configured) {
            const twin = materializeParcelTwin(fresh!, tw.twin);
            upsertTwinExternal(twin);
            patchJob(jobId_local, { status: 'complete', pct: 100, resultTwinId: twin.id, message: 'HD twin ready.' });
            onDone(); return;
          }
        } catch { /* fall through to complete-without-twin */ }
      }
      patchJob(jobId_local, { status: 'complete', pct: 100, message: 'Scan complete (no composed twin returned).' });
      onDone(); return;
    }
  }
  if (!signal.aborted) patchJob(jobId_local, { status: 'error', message: 'Timed out waiting for the backend.' });
  onDone();
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
