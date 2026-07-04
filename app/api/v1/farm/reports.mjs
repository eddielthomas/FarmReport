// =============================================================================
// /api/v1/farm/reports — report generation over REAL twin data (Wave-2 Lane 2).
// -----------------------------------------------------------------------------
//   POST /farm/reports/generate {farm_id, type, period{start,end}}
//   GET  /farm/reports?farm_id
//   GET  /farm/reports/:id
//
// generate() builds farm.report.sections from what actually exists in the twin:
// the farm profile, its zones + operator intents, observation/alert counts, and
// (for executive-monthly) the buyer portfolio rollup. It NEVER fabricates
// measurements — when farm.observation is empty (the case until P2 ingest), the
// observations section carries an honest data-quality note instead of numbers.
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, send } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { farmGate, UUID_RE } from './gate.mjs';

const REPORT_SELECT = `
  id, tenant_id, farm_id, type, title, period_start, period_end,
  status, summary, sections, artifact_url, artifact_urls, channels,
  generated_by, created_at, updated_at`;

const VALID_KINDS = new Set(['field', 'executive-monthly']);

const NO_OBS_NOTE =
  'No satellite observations ingested yet — monitoring begins with the AlphaGeo connection (P2).';

function parseTs(v, fallback) {
  if (v == null || v === '') return fallback;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

// --- LIST -------------------------------------------------------------------
export async function list(req, res) {
  if (!farmGate(req, res, 'farm.report.read', 'farm:view')) return;
  const qs = new URL(req.url, 'http://x').searchParams;
  const farmId = qs.get('farm_id');
  if (farmId && !UUID_RE.test(farmId)) return badReq(res, 'invalid_farm_id');

  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (farmId) { params.push(farmId); where += ` AND farm_id = $${params.length}`; }

  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${REPORT_SELECT} FROM farm.report
        WHERE ${where} ORDER BY created_at DESC LIMIT 500`, params);
    return r.rows;
  });
  ok(res, rows);
}

// --- GET ONE ----------------------------------------------------------------
export async function get(req, res, id) {
  if (!farmGate(req, res, 'farm.report.read', 'farm:view')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_report_id');
  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${REPORT_SELECT} FROM farm.report WHERE id = $1`, [id]);
    return r.rows[0] ?? null;
  });
  if (!row) return notFound(res);
  ok(res, row);
}

// --- GENERATE ---------------------------------------------------------------
export async function generate(req, res) {
  if (!farmGate(req, res, 'farm.report.generate', 'report:generate')) return;
  const body = (await readBody(req)) || {};
  const farmId = body.farm_id;
  const kind = body.type;
  if (!UUID_RE.test(String(farmId ?? ''))) return badReq(res, 'farm_id_required');
  if (!VALID_KINDS.has(kind)) return badReq(res, 'invalid_type');

  const period = (body.period && typeof body.period === 'object') ? body.period : {};
  const nowIso = new Date().toISOString();
  const defStart = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const periodStart = parseTs(period.start, defStart);
  const periodEnd   = parseTs(period.end, nowIso);

  // Gather everything the report is built from, in one tenant-bound tx.
  const gathered = await withTenantConn(req, async (client) => {
    const farmR = await client.query(
      `SELECT id, name, farm_types, crops, total_area_ha, timezone, currency,
              signal_source, aoi_west, aoi_south, aoi_east, aoi_north, status,
              supplier_id
         FROM farm.farm_profile WHERE id = $1`, [farmId]);
    if (farmR.rows.length === 0) return null;
    const farm = farmR.rows[0];

    const zonesR = await client.query(
      `SELECT id, name, type, intent FROM farm.zone
        WHERE farm_id = $1 ORDER BY created_at`, [farmId]);

    const parcelR = await client.query(
      `SELECT count(*)::int AS n, COALESCE(sum(area_ha), 0) AS area_ha
         FROM farm.parcel WHERE farm_id = $1`, [farmId]);

    // Observation count + breakdown by measurement, bounded to the period.
    const obsR = await client.query(
      `SELECT measurement, count(*)::int AS n
         FROM farm.observation
        WHERE farm_id = $1
          AND (acquired_at IS NULL OR acquired_at BETWEEN $2 AND $3)
        GROUP BY measurement`, [farmId, periodStart, periodEnd]);
    const obsTotal = obsR.rows.reduce((a, r) => a + r.n, 0);

    const alertR = await client.query(
      `SELECT status, count(*)::int AS n FROM farm.alert
        WHERE farm_id = $1 GROUP BY status`, [farmId]);

    // Portfolio rollup (executive-monthly only).
    let portfolio = null; let suppliers = [];
    if (kind === 'executive-monthly') {
      const pr = await client.query(
        `SELECT supplier_count, region_count, farm_count,
                avg_risk_score, max_risk_score, revenue_at_risk_usd
           FROM farm.v_buyer_rollup WHERE tenant_id = $1`, [req.tenant.id]);
      portfolio = pr.rows[0] ?? null;
      const sr = await client.query(
        `SELECT supplier_name, farm_count, avg_risk_score, max_risk_score,
                revenue_at_risk_usd
           FROM farm.v_supplier_rollup
          WHERE tenant_id = $1
          ORDER BY max_risk_score DESC NULLS LAST, supplier_name`, [req.tenant.id]);
      suppliers = sr.rows;
    }

    return { farm, zones: zonesR.rows, parcels: parcelR.rows[0],
             obs: obsR.rows, obsTotal, alerts: alertR.rows, portfolio, suppliers };
  });

  if (!gathered) return notFound(res);

  const { farm, zones, parcels, obs, obsTotal, alerts, portfolio, suppliers } = gathered;
  const alertCounts = { open: 0, ack: 0, resolved: 0, suppressed: 0, total: 0 };
  for (const a of alerts) { alertCounts[a.status] = a.n; alertCounts.total += a.n; }

  const dataQuality = [];
  if (obsTotal === 0) dataQuality.push(NO_OBS_NOTE);

  // ---- build sections from real data ----------------------------------------
  const sections = [];
  sections.push({
    key: 'overview', title: 'Farm Overview',
    data: {
      name: farm.name, status: farm.status,
      farm_types: farm.farm_types, crops: farm.crops,
      total_area_ha: farm.total_area_ha,
      parcels: parcels.n, parcel_area_ha: parcels.area_ha,
      timezone: farm.timezone, currency: farm.currency,
      signal_source: farm.signal_source,
      aoi: { west: farm.aoi_west, south: farm.aoi_south,
             east: farm.aoi_east, north: farm.aoi_north },
    },
  });

  sections.push({
    key: 'zones', title: 'Zones & Operator Intent',
    data: {
      zone_count: zones.length,
      zones: zones.map((z) => ({ id: z.id, name: z.name, type: z.type, intent: z.intent })),
    },
    notes: zones.length === 0
      ? ['No zones defined yet — add zones with intent to drive alerting.'] : [],
  });

  sections.push({
    key: 'observations', title: 'Satellite Observations',
    data: {
      period: { start: periodStart, end: periodEnd },
      total: obsTotal,
      by_measurement: Object.fromEntries(obs.map((o) => [o.measurement, o.n])),
    },
    data_quality: obsTotal === 0 ? [NO_OBS_NOTE] : [],
  });

  sections.push({
    key: 'alerts', title: 'Alerts',
    data: alertCounts,
    notes: alertCounts.total === 0
      ? ['No alerts — alerts derive from ingested observations (P2).'] : [],
  });

  if (kind === 'executive-monthly') {
    sections.push({
      key: 'portfolio', title: 'Supply-Chain Portfolio',
      data: portfolio ?? {
        supplier_count: 0, region_count: 0, farm_count: 0,
        avg_risk_score: null, max_risk_score: null, revenue_at_risk_usd: 0,
      },
      suppliers: suppliers.map((s) => ({
        supplier_name: s.supplier_name, farm_count: s.farm_count,
        avg_risk_score: s.avg_risk_score, max_risk_score: s.max_risk_score,
        revenue_at_risk_usd: s.revenue_at_risk_usd,
      })),
      data_quality: (portfolio && Number(portfolio.avg_risk_score) > 0)
        ? [] : ['Risk scores are 0/absent until the rollup worker computes from real observations (P3.5).'],
    });
  }

  const title = kind === 'executive-monthly'
    ? `Executive Monthly Report — ${farm.name}`
    : `Field Report — ${farm.name}`;
  const summary = kind === 'executive-monthly'
    ? `Executive supply-chain summary for ${farm.name}. ${obsTotal} observation(s) in period; ${alertCounts.total} alert(s).`
    : `Field report for ${farm.name}. ${zones.length} zone(s), ${obsTotal} observation(s) in period.`;

  const generatedBy = UUID_RE.test(String(req.user?.sub ?? '')) ? req.user.sub : null;

  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `INSERT INTO farm.report
         (tenant_id, farm_id, type, title, period_start, period_end,
          status, summary, sections, generated_by)
       VALUES ($1, $2, 'on-demand', $3, $4, $5, 'final', $6, $7::jsonb, $8)
       RETURNING ${REPORT_SELECT}`,
      [req.tenant.id, farmId, title, periodStart, periodEnd, summary,
       JSON.stringify({ kind, data_quality: dataQuality, sections }), generatedBy]);
    return r.rows[0];
  });

  recordAudit({ req, action: 'farm.report.generate', resource: 'farm.report',
    resourceId: row.id, payload: { farm_id: farmId, kind, obs_total: obsTotal } });
  created(res, row);
}
