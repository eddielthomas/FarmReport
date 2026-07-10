// =============================================================================
// farm/meridian.mjs — server-to-server wrap of the AlphaGeo gateway's
// meridian_render trigger, for report generation (scheduler + Generate button).
// -----------------------------------------------------------------------------
// Contract (gateway drawer f90cc83, 2026-07-10 — RENDER-TRIGGER-LIVE):
//   TRIGGER (sync, no polling for the id):
//     POST /api/meridian/render
//       Mode A: { study_id }
//       Mode B: { aoi:{point|bbox|geojson}, period:{date_from,date_to}, title?, tier_hint? }
//     -> 200 { status:'rendered', report_id(==request_id), study_id, tier:'DRAFT-PENDING|T2', version }
//     -> 422 if neither study_id nor aoi+period given.
//   CONTENT (one hop later, same shape our report library already consumes):
//     GET /api/meridian/reports/{report_id}
//     -> 200 { summary, sections/findings, raster_links, tier, status, ... }
//
// This module is GRACEFUL BY DESIGN — mirrors farm/gateway.mjs: when the gateway
// origin/token is unset (stub mode) or the relay is unreachable/errors/times out,
// every call returns null and the caller falls back to a local-only report with
// an honest "Meridian pending" note. It NEVER fabricates a tier — the tier the
// gateway returns (DRAFT-PENDING when no findings, T2 with real evidence) is
// carried through verbatim. No import back into server.mjs / index.mjs, so there
// is no cycle (reports.mjs → meridian.mjs is a leaf).
// =============================================================================

const HARVEST_BASE   = (process.env.ALPHAGEO_HARVEST_BASE ?? '').replace(/\/+$/, '');
const HARVEST_TOKEN  = process.env.ALPHAGEO_HARVEST_TOKEN ?? '';
const GATEWAY_ORIGIN = (process.env.ALPHAGEO_GATEWAY_ORIGIN
  ?? HARVEST_BASE.replace(/\/api\/harvest\/?$/, '')).replace(/\/+$/, '');

// Cap a single render+fetch so a slow/hung gateway never blocks a scheduler tick
// or the Generate request. Overridable via env for slower links.
const RENDER_TIMEOUT_MS = Number(process.env.ALPHAGEO_MERIDIAN_TIMEOUT_MS ?? 20_000);

export function meridianConfigured() {
  return Boolean(GATEWAY_ORIGIN && HARVEST_TOKEN);
}

// Server-to-server fetch to the gateway with the Bearer harvest token + a bounded
// timeout. Mirrors gateway.mjs gatewayFetch (incl. the optional Basic retry for a
// prod nginx auth mismatch). Returns the Response or throws (caller catches).
async function gatewayFetch(gwPath, { method = 'GET', body = null, signal } = {}) {
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
    ...(signal ? { signal } : {}),
  });
  let upstream = await attempt(HARVEST_TOKEN ? `Bearer ${HARVEST_TOKEN}` : '');
  if (upstream.status === 401 && basic) {
    upstream = await attempt(`Basic ${Buffer.from(basic).toString('base64')}`);
  }
  return upstream;
}

// ISO timestamp (or Date/loose string) → 'YYYY-MM-DD' for the meridian period.
function toYmd(v, fallbackIso) {
  const d = new Date(v ?? fallbackIso);
  const use = Number.isNaN(d.getTime()) ? new Date(fallbackIso) : d;
  return use.toISOString().slice(0, 10);
}

// Build the meridian AOI from a farm's stored bbox. Returns null when the farm
// has no boundary yet (nothing to render against).
export function aoiFromFarmBbox(farm) {
  const w = Number(farm?.aoi_west), s = Number(farm?.aoi_south);
  const e = Number(farm?.aoi_east), n = Number(farm?.aoi_north);
  if (![w, s, e, n].every(Number.isFinite)) return null;
  return { bbox: [w, s, e, n] };
}

// Normalize the gateway report body to the slice our report section stores. Keeps
// findings + raster_links (the render outputs) and the honest tier/status; leaves
// the full body under `raw` for anything the UI wants later.
function shapeReport(report, trigger) {
  if (!report || typeof report !== 'object') return null;
  const findings = report.findings ?? report.sections ?? [];
  return {
    report_id: report.report_id ?? report.id ?? null,
    tier: report.tier ?? null,               // DRAFT-PENDING | T2 — verbatim, never laundered
    status: report.status ?? null,
    summary: report.summary ?? null,
    findings: Array.isArray(findings) ? findings : [],
    raster_links: Array.isArray(report.raster_links) ? report.raster_links : [],
    trigger,
    raw: report,
  };
}

// Render a Meridian report for a farm AOI + period, then fetch its content.
// Returns the shaped enrichment object, or null on any failure (unconfigured,
// unreachable, non-200, timeout, no AOI) so the caller degrades gracefully.
//   opts: { aoi?, studyId?, period:{date_from,date_to} | {start,end}, title?, tierHint?, trigger? }
export async function renderMeridianReport(opts = {}) {
  if (!meridianConfigured()) return null;

  // Build the trigger body: Mode A (study_id) or Mode B (aoi + period).
  const body = {};
  if (opts.studyId) {
    body.study_id = opts.studyId;
  } else if (opts.aoi) {
    body.aoi = opts.aoi;
    const p = opts.period && typeof opts.period === 'object' ? opts.period : {};
    const nowIso = new Date().toISOString();
    const defFromIso = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    body.period = {
      date_from: p.date_from ?? toYmd(p.start, defFromIso),
      date_to:   p.date_to   ?? toYmd(p.end, nowIso),
    };
  } else {
    return null; // neither study_id nor aoi+period → gateway would 422; skip.
  }
  if (opts.title) body.title = opts.title;
  if (opts.tierHint) body.tier_hint = opts.tierHint;

  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch { /* noop */ } }, RENDER_TIMEOUT_MS);
  try {
    // 1) TRIGGER — synchronous, returns report_id inline.
    const rr = await gatewayFetch('/api/meridian/render', {
      method: 'POST', body: JSON.stringify(body), signal: ac.signal,
    });
    if (!rr.ok) return null;
    const rendered = await rr.json().catch(() => null);
    const reportId = rendered?.report_id ?? rendered?.request_id ?? null;
    if (!reportId) return null;

    // 2) CONTENT — same endpoint our report library already uses.
    const gr = await gatewayFetch(`/api/meridian/reports/${encodeURIComponent(reportId)}`, {
      signal: ac.signal,
    });
    if (!gr.ok) {
      // We have the id + tier from the trigger even if content isn't ready.
      return shapeReport({ ...rendered, report_id: reportId }, opts.trigger ?? 'on-demand');
    }
    const report = await gr.json().catch(() => null);
    // Prefer the fetched content; fall back to the trigger envelope for id/tier.
    const merged = report ? { report_id: reportId, tier: rendered?.tier, ...report } : { ...rendered, report_id: reportId };
    return shapeReport(merged, opts.trigger ?? 'on-demand');
  } catch {
    return null; // unreachable / aborted / parse error → graceful no-op.
  } finally {
    clearTimeout(timer);
  }
}
