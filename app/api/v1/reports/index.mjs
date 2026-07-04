// =============================================================================
// /api/v1/reports — Sprint ③: Reporting engine.
// -----------------------------------------------------------------------------
// Generates point-in-time reports by aggregating across the CRM / ops / field /
// analytics schemas. Four types:
//
//   exec          — leadership KPI snapshot
//   investigation — ops.case rollups by type/status + evidence/timeline volume
//   field         — field.job dispatch rollups by status + technician
//   sales         — pipeline funnel (leads -> opps -> proposals -> contracts)
//
// Routes:
//   GET  /reports                 list generated reports (?type= filter)
//   POST /reports/:type           generate a report of :type (body: {from,to,title})
//   GET  /reports/:id             fetch a generated report (incl. full payload)
//
// Every access runs inside withTenantConn() so the FORCE'd RLS on reports.report
// (and every source table) binds app.tenant_id. generate() emits recordAudit().
//
// Each source aggregate is wrapped in safe() so a schema variance in one source
// (e.g. an unmigrated field.* table) yields an empty section rather than failing
// the whole report.
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';

const REPORT_TYPES = new Set(['exec', 'investigation', 'field', 'sales']);

const TITLES = {
  exec:          'Executive KPI Snapshot',
  investigation: 'Investigation Operations Report',
  field:         'Field Service Report',
  sales:         'Sales Pipeline Report',
};

// Run a query, returning rows — or [] if the source table/column isn't present
// in this deployment. Wrapped in a SAVEPOINT: withTenantConn() runs everything
// in one transaction, so a failing query would otherwise poison the whole
// transaction ("current transaction is aborted") and break the later INSERT.
// Rolling back to the savepoint keeps the transaction alive for the next query.
async function safe(client, sql, params = []) {
  await client.query('SAVEPOINT rpt');
  try {
    const r = await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT rpt');
    return r.rows;
  } catch (_e) {
    try { await client.query('ROLLBACK TO SAVEPOINT rpt'); } catch (_e2) { /* noop */ }
    return [];
  }
}

const num = (v) => (v == null ? 0 : Number(v));
const firstCount = (rows) => num(rows[0]?.n);

// Resolve {from, to} ISO timestamps from the request body, default last 90 days.
function resolveRange(body) {
  const to = body?.to ? new Date(body.to) : new Date();
  let from;
  if (body?.from) {
    from = new Date(body.from);
  } else {
    from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

// ---- builders ---------------------------------------------------------------

async function buildExec(client, range) {
  const leadsByStatus = await safe(client,
    `SELECT status, count(*)::int AS n FROM sales.lead GROUP BY status`);
  const newLeads = firstCount(await safe(client,
    `SELECT count(*)::int AS n FROM sales.lead WHERE created_at BETWEEN $1 AND $2`,
    [range.from, range.to]));
  const leadRevenue = num((await safe(client,
    `SELECT coalesce(sum(total_revenue),0) AS v FROM sales.lead`))[0]?.v);
  const oppsByStage = await safe(client,
    `SELECT stage, count(*)::int AS n, coalesce(sum(amount),0) AS amount
       FROM sales.opportunity GROUP BY stage`);
  const contracts = await safe(client,
    `SELECT status, count(*)::int AS n, coalesce(sum(value),0) AS value
       FROM sales.contract GROUP BY status`);
  const openCases = firstCount(await safe(client,
    `SELECT count(*)::int AS n FROM ops.case WHERE status NOT IN ('closed','cancelled')`));

  const clients = num(leadsByStatus.find((r) => r.status === 'Client')?.n);
  const pipelineValue = oppsByStage
    .filter((r) => !['won', 'lost'].includes(r.stage))
    .reduce((s, r) => s + num(r.amount), 0);
  const activeContractValue = contracts
    .filter((r) => ['active', 'signed'].includes(r.status))
    .reduce((s, r) => s + num(r.value), 0);

  return {
    summary: {
      total_leads: leadsByStatus.reduce((s, r) => s + num(r.n), 0),
      new_leads_in_range: newLeads,
      clients,
      lead_revenue: leadRevenue,
      pipeline_value: pipelineValue,
      active_contract_value: activeContractValue,
      open_cases: openCases,
    },
    payload: { leads_by_status: leadsByStatus, opportunities_by_stage: oppsByStage, contracts_by_status: contracts },
  };
}

async function buildSales(client, range) {
  const leadsByStatus = await safe(client,
    `SELECT status, count(*)::int AS n FROM sales.lead GROUP BY status`);
  const oppsByStage = await safe(client,
    `SELECT stage, count(*)::int AS n, coalesce(sum(amount),0) AS amount
       FROM sales.opportunity GROUP BY stage`);
  const proposalsByStatus = await safe(client,
    `SELECT status, count(*)::int AS n, coalesce(sum(amount),0) AS amount
       FROM sales.proposal GROUP BY status`);
  const contractsByStatus = await safe(client,
    `SELECT status, count(*)::int AS n, coalesce(sum(value),0) AS value
       FROM sales.contract GROUP BY status`);
  const newInRange = firstCount(await safe(client,
    `SELECT count(*)::int AS n FROM sales.lead WHERE created_at BETWEEN $1 AND $2`,
    [range.from, range.to]));

  const proposalsSent = proposalsByStatus
    .filter((r) => ['sent', 'accepted', 'rejected', 'expired'].includes(r.status))
    .reduce((s, r) => s + num(r.n), 0);
  const proposalsAccepted = num(proposalsByStatus.find((r) => r.status === 'accepted')?.n);
  const wonValue = contractsByStatus
    .filter((r) => ['active', 'signed'].includes(r.status))
    .reduce((s, r) => s + num(r.value), 0);

  return {
    summary: {
      leads: leadsByStatus.reduce((s, r) => s + num(r.n), 0),
      new_leads_in_range: newInRange,
      opportunities: oppsByStage.reduce((s, r) => s + num(r.n), 0),
      proposals: proposalsByStatus.reduce((s, r) => s + num(r.n), 0),
      proposal_win_rate_pct: proposalsSent ? Math.round((proposalsAccepted / proposalsSent) * 100) : 0,
      contracts: contractsByStatus.reduce((s, r) => s + num(r.n), 0),
      won_value: wonValue,
    },
    payload: {
      funnel: {
        leads_by_status: leadsByStatus,
        opportunities_by_stage: oppsByStage,
        proposals_by_status: proposalsByStatus,
        contracts_by_status: contractsByStatus,
      },
    },
  };
}

async function buildInvestigation(client, range) {
  const byType = await safe(client,
    `SELECT coalesce(investigation_type,'unspecified') AS investigation_type, count(*)::int AS n
       FROM ops.case GROUP BY investigation_type`);
  const byStatus = await safe(client,
    `SELECT status, count(*)::int AS n FROM ops.case GROUP BY status`);
  const evidenceByKind = await safe(client,
    `SELECT kind, count(*)::int AS n FROM ops.case_evidence GROUP BY kind`);
  const timelineEvents = firstCount(await safe(client,
    `SELECT count(*)::int AS n FROM ops.case_timeline
      WHERE occurred_at BETWEEN $1 AND $2`, [range.from, range.to]));
  const newCases = firstCount(await safe(client,
    `SELECT count(*)::int AS n FROM ops.case WHERE created_at BETWEEN $1 AND $2`,
    [range.from, range.to]));

  const total = byStatus.reduce((s, r) => s + num(r.n), 0);
  const open = byStatus.filter((r) => !['closed', 'cancelled'].includes(r.status))
    .reduce((s, r) => s + num(r.n), 0);

  return {
    summary: {
      total_cases: total,
      open_cases: open,
      new_cases_in_range: newCases,
      evidence_items: evidenceByKind.reduce((s, r) => s + num(r.n), 0),
      timeline_events_in_range: timelineEvents,
      distinct_types: byType.length,
    },
    payload: { by_type: byType, by_status: byStatus, evidence_by_kind: evidenceByKind },
  };
}

async function buildField(client, range) {
  const byStatus = await safe(client,
    `SELECT status, count(*)::int AS n FROM field.job GROUP BY status`);
  const byTech = await safe(client,
    `SELECT assigned_to, count(*)::int AS n FROM field.job
      WHERE assigned_to IS NOT NULL GROUP BY assigned_to ORDER BY n DESC LIMIT 20`);
  const notes = firstCount(await safe(client,
    `SELECT count(*)::int AS n FROM field.job_note
      WHERE created_at BETWEEN $1 AND $2`, [range.from, range.to]));
  const newJobs = firstCount(await safe(client,
    `SELECT count(*)::int AS n FROM field.job WHERE created_at BETWEEN $1 AND $2`,
    [range.from, range.to]));

  const total = byStatus.reduce((s, r) => s + num(r.n), 0);
  const pick = (...names) => byStatus.filter((r) => names.includes(r.status))
    .reduce((s, r) => s + num(r.n), 0);

  return {
    summary: {
      total_jobs: total,
      new_jobs_in_range: newJobs,
      completed: pick('completed', 'verified'),
      in_progress: pick('in_progress', 'on_site', 'en_route', 'paused'),
      open: pick('commissioned', 'assigned'),
      active_technicians: byTech.length,
      notes_in_range: notes,
    },
    payload: { by_status: byStatus, by_technician: byTech },
  };
}

const BUILDERS = {
  exec: buildExec,
  sales: buildSales,
  investigation: buildInvestigation,
  field: buildField,
};

// ---- handlers ---------------------------------------------------------------

const LIST_COLS = `id, tenant_id, report_type, title, summary, generated_by, created_at`;

export async function list(req, res) {
  const qs = parseQuery(req.url);
  const rows = await withTenantConn(req, async (client) => {
    const params = [];
    let where = '1=1';
    if (qs.type && REPORT_TYPES.has(qs.type)) { params.push(qs.type); where += ` AND report_type = $${params.length}`; }
    const r = await client.query(
      `SELECT ${LIST_COLS} FROM reports.report WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
      params,
    );
    return r.rows;
  });
  ok(res, rows);
}

export async function get(req, res, id) {
  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT id, tenant_id, report_type, title, params, summary, payload, generated_by, created_at
         FROM reports.report WHERE id = $1`, [id]);
    return r.rows[0] ?? null;
  });
  if (!row) return notFound(res);
  ok(res, row);
}

export async function generate(req, res, type) {
  if (!REPORT_TYPES.has(type)) return badReq(res, 'unknown_report_type');
  const body = (await readBody(req)) || {};
  const range = resolveRange(body);
  const title = String(body.title ?? '').trim() || TITLES[type];

  const row = await withTenantConn(req, async (client) => {
    const built = await BUILDERS[type](client, range);
    const params = { from: range.from, to: range.to };
    const r = await client.query(
      `INSERT INTO reports.report
         (tenant_id, report_type, title, params, summary, payload, generated_by)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7)
       RETURNING id, tenant_id, report_type, title, params, summary, payload, generated_by, created_at`,
      [
        req.tenant.id,
        type,
        title,
        JSON.stringify(params),
        JSON.stringify(built.summary),
        JSON.stringify(built.payload),
        req.user?.sub ?? null,
      ],
    );
    recordAudit({
      req, action: 'generate', resource: 'reports.report',
      resourceId: r.rows[0].id, payload: { type, range, summary: built.summary },
    });
    return r.rows[0];
  });
  created(res, row);
}
