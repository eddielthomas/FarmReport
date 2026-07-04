// =============================================================================
// /api/v1/ops/investigations — Investigation typing + evidence + timeline.
// -----------------------------------------------------------------------------
// Specialises the generic ops.case into a typed investigation and exposes the
// append-only evidence + timeline surfaces the Reporting engine builds on.
//
//   GET   /ops/investigation-types          list catalog (cases.read)
//   PATCH /ops/cases/:id/investigation       type a case + set aoi/customer/case_number (cases.manage)
//   GET   /ops/cases/:id/evidence            list evidence (cases.read)
//   POST  /ops/cases/:id/evidence            append evidence (cases.manage)
//   GET   /ops/cases/:id/timeline            list timeline (cases.read)
//   POST  /ops/cases/:id/timeline            append timeline event (cases.manage)
//
// Tenant scoping for evidence/timeline/case_number_seq goes through
// withTenantConn (RLS deny-by-default + FORCE). Every DML mutator calls
// recordAudit. Evidence + timeline are APPEND-ONLY: no UPDATE/DELETE handler.
// =============================================================================

import { q, withTenantConn } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_EVIDENCE_KIND = new Set(['photo','video','document','detection','note']);

// ---- GET /ops/investigation-types -------------------------------------------
// Platform-wide catalog; read-only. No tenant binding needed (system table).
export async function listTypes(req, res) {
  if (!requirePermission(req, res, 'cases.read')) return;
  const { rows } = await q(
    `SELECT key, label, category, default_priority, description, sort_order
       FROM ops.investigation_type
      ORDER BY sort_order ASC, label ASC`,
  );
  ok(res, rows);
}

// ---- PATCH /ops/cases/:id/investigation -------------------------------------
// Types a case. Sets investigation_type / aoi / customer_id, and lazily mints a
// per-tenant case_number (INV-<year>-<seq>) on first typing. Appends a timeline
// row + recordAudit. AOI accepts GeoJSON Polygon OR a WKT polygon string.
export async function patchInvestigation(req, res, id) {
  if (!requirePermission(req, res, 'cases.manage')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_case_id');
  const body = (await readBody(req)) || {};

  // Validate investigation_type against the catalog (if supplied).
  let typeKey;
  if (body.investigation_type !== undefined && body.investigation_type !== null) {
    typeKey = String(body.investigation_type).trim();
    const chk = await q(
      `SELECT 1 FROM ops.investigation_type WHERE key = $1`, [typeKey],
    );
    if (chk.rows.length === 0) return badReq(res, 'invalid_investigation_type');
  }

  // customer_id (optional). Validated as UUID only; not FK-constrained.
  let customerId;
  if (body.customer_id !== undefined && body.customer_id !== null) {
    customerId = String(body.customer_id).trim();
    if (!UUID_RE.test(customerId)) return badReq(res, 'invalid_customer_id');
  }

  // AOI (optional). Accept GeoJSON Polygon object OR a WKT string. NULL clears.
  let aoiSql = null;       // { expr, value } when present
  if (body.aoi !== undefined) {
    if (body.aoi === null) {
      aoiSql = { expr: 'NULL', value: undefined };
    } else if (typeof body.aoi === 'object') {
      // GeoJSON -> geometry -> geography. PostGIS 3.4 ships ST_GeomFromGeoJSON
      // (geometry) but not a geography GeoJSON variant, so we cast. ST_SetSRID
      // guards GeoJSON without an explicit CRS (defaults to 4326 per spec).
      aoiSql = { expr: 'ST_SetSRID(ST_GeomFromGeoJSON($AOI::text), 4326)::geography', value: JSON.stringify(body.aoi) };
    } else if (typeof body.aoi === 'string') {
      aoiSql = { expr: 'ST_GeogFromText($AOI::text)', value: body.aoi };
    } else {
      return badReq(res, 'invalid_aoi');
    }
  }

  const result = await withTenantConn(req, async (client) => {
    const cur = await client.query(
      `SELECT id, investigation_type, case_number FROM ops.case
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [req.tenant.id, id],
    );
    if (cur.rows.length === 0) return { notFound: true };

    // Mint a case_number on first typing if one isn't already set.
    let caseNumber = cur.rows[0].case_number;
    const wantsTyping = typeKey !== undefined;
    if (!caseNumber && (wantsTyping || cur.rows[0].investigation_type)) {
      const year = new Date().getUTCFullYear();
      const seqRes = await client.query(
        `SELECT ops.next_case_number($1, $2) AS seq`, [req.tenant.id, year],
      );
      const seq = Number(seqRes.rows[0].seq);
      caseNumber = `INV-${year}-${String(seq).padStart(6, '0')}`;
    }

    // Build the dynamic SET clause.
    const sets = [];
    const params = [req.tenant.id, id];
    let i = 3;
    if (typeKey !== undefined)   { sets.push(`investigation_type = $${i++}`); params.push(typeKey); }
    if (customerId !== undefined){ sets.push(`customer_id = $${i++}`);        params.push(customerId); }
    if (caseNumber && caseNumber !== cur.rows[0].case_number) {
      sets.push(`case_number = $${i++}`); params.push(caseNumber);
    }
    if (aoiSql) {
      if (aoiSql.expr === 'NULL') {
        sets.push(`aoi = NULL`);
      } else {
        const ph = `$${i++}`;
        params.push(aoiSql.value);
        sets.push(`aoi = ${aoiSql.expr.replace('$AOI', ph)}`);
      }
    }
    if (sets.length === 0) return { noop: true };

    const upd = await client.query(
      `UPDATE ops.case SET ${sets.join(', ')}
        WHERE tenant_id = $1 AND id = $2
        RETURNING id, tenant_id, title, status, priority,
                  investigation_type, customer_id, case_number,
                  ST_AsGeoJSON(aoi) AS aoi, opened_at, closed_at`,
      params,
    );

    // Append a timeline row narrating the typing event (append-only).
    await client.query(
      `INSERT INTO ops.case_timeline (tenant_id, case_id, event_kind, body, payload, actor_id)
       VALUES ($1, $2, 'typed', $3, $4::jsonb, $5)`,
      [req.tenant.id, id,
       typeKey ? `typed as ${typeKey}` : 'investigation updated',
       JSON.stringify({
         investigation_type: typeKey ?? null,
         customer_id: customerId ?? null,
         case_number: caseNumber ?? null,
         aoi_set: aoiSql ? aoiSql.expr !== 'NULL' : undefined,
       }),
       req.user?.sub && UUID_RE.test(req.user.sub) ? req.user.sub : null],
    );

    const row = upd.rows[0];
    if (row.aoi) { try { row.aoi = JSON.parse(row.aoi); } catch { /* leave as-is */ } }
    return { row };
  });

  if (result.notFound) return notFound(res);
  if (result.noop) return badReq(res, 'no_fields_to_update');

  recordAudit({
    req, action: 'investigation.type', resource: 'ops.case', resourceId: id,
    payload: {
      investigation_type: typeKey ?? null,
      customer_id: customerId ?? null,
      case_number: result.row.case_number ?? null,
      aoi_set: aoiSql ? aoiSql.expr !== 'NULL' : false,
    },
  });
  ok(res, result.row);
}

// ---- GET /ops/cases/:id/evidence --------------------------------------------
export async function listEvidence(req, res, id) {
  if (!requirePermission(req, res, 'cases.read')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_case_id');
  const rows = await withTenantConn(req, async (client) => {
    const guard = await client.query(
      `SELECT 1 FROM ops.case WHERE id = $1`, [id],
    );
    if (guard.rows.length === 0) return null;
    const r = await client.query(
      `SELECT e.id, e.case_id, e.kind, e.ref_id, e.title, e.body,
              e.created_by, e.created_at,
              p.display_name AS created_by_name, p.email AS created_by_email
         FROM ops.case_evidence e
         LEFT JOIN iam.user_profile p ON p.id = e.created_by
        WHERE e.case_id = $1
        ORDER BY e.created_at DESC
        LIMIT 500`,
      [id],
    );
    return r.rows;
  });
  if (rows === null) return notFound(res);
  ok(res, rows);
}

// ---- POST /ops/cases/:id/evidence -------------------------------------------
// Append-only. INSERT + recordAudit + a sibling timeline row.
export async function createEvidence(req, res, id) {
  if (!requirePermission(req, res, 'cases.manage')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_case_id');
  const body = (await readBody(req)) || {};
  const kind = String(body.kind ?? 'note').trim();
  if (!VALID_EVIDENCE_KIND.has(kind)) return badReq(res, 'invalid_evidence_kind');
  const title = body.title != null ? String(body.title).trim() : null;
  const text  = body.body  != null ? String(body.body).trim()  : null;
  const refId = body.ref_id != null ? String(body.ref_id).trim() : null;
  // A note must carry text; a ref-kind must carry a ref_id; otherwise require one of them.
  if (!text && !refId && !title) return badReq(res, 'evidence_payload_required');
  if (text && text.length > 50000) return badReq(res, 'body_too_long');
  const createdBy = req.user?.sub && UUID_RE.test(req.user.sub) ? req.user.sub : null;

  const row = await withTenantConn(req, async (client) => {
    const guard = await client.query(`SELECT 1 FROM ops.case WHERE id = $1`, [id]);
    if (guard.rows.length === 0) return null;
    const r = await client.query(
      `INSERT INTO ops.case_evidence (tenant_id, case_id, kind, ref_id, title, body, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, case_id, kind, ref_id, title, body, created_by, created_at`,
      [req.tenant.id, id, kind, refId, title, text, createdBy],
    );
    const ev = r.rows[0];
    // Narrate the evidence addition on the timeline (append-only).
    await client.query(
      `INSERT INTO ops.case_timeline (tenant_id, case_id, event_kind, body, payload, actor_id)
       VALUES ($1, $2, 'evidence_added', $3, $4::jsonb, $5)`,
      [req.tenant.id, id, `${kind} evidence added`,
       JSON.stringify({ evidence_id: ev.id, kind, ref_id: refId, title }), createdBy],
    );
    return ev;
  });
  if (!row) return notFound(res);

  recordAudit({
    req, action: 'investigation.evidence.create', resource: 'ops.case_evidence',
    resourceId: row.id, payload: { after: row, case_id: id },
  });
  created(res, { ...row, created_by_email: req.user?.email ?? null });
}

// ---- GET /ops/cases/:id/timeline --------------------------------------------
export async function listTimeline(req, res, id) {
  if (!requirePermission(req, res, 'cases.read')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_case_id');
  const rows = await withTenantConn(req, async (client) => {
    const guard = await client.query(`SELECT 1 FROM ops.case WHERE id = $1`, [id]);
    if (guard.rows.length === 0) return null;
    const r = await client.query(
      `SELECT t.id, t.case_id, t.event_kind, t.body, t.payload,
              t.actor_id, t.occurred_at,
              p.display_name AS actor_name, p.email AS actor_email
         FROM ops.case_timeline t
         LEFT JOIN iam.user_profile p ON p.id = t.actor_id
        WHERE t.case_id = $1
        ORDER BY t.occurred_at DESC
        LIMIT 1000`,
      [id],
    );
    return r.rows;
  });
  if (rows === null) return notFound(res);
  ok(res, rows);
}

// ---- POST /ops/cases/:id/timeline -------------------------------------------
// Append-only. INSERT + recordAudit.
export async function createTimeline(req, res, id) {
  if (!requirePermission(req, res, 'cases.manage')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_case_id');
  const body = (await readBody(req)) || {};
  const eventKind = String(body.event_kind ?? 'note').trim();
  if (!eventKind) return badReq(res, 'event_kind_required');
  if (eventKind.length > 64) return badReq(res, 'event_kind_too_long');
  const text = body.body != null ? String(body.body).trim() : null;
  if (text && text.length > 50000) return badReq(res, 'body_too_long');
  const actorId = req.user?.sub && UUID_RE.test(req.user.sub) ? req.user.sub : null;

  const row = await withTenantConn(req, async (client) => {
    const guard = await client.query(`SELECT 1 FROM ops.case WHERE id = $1`, [id]);
    if (guard.rows.length === 0) return null;
    const r = await client.query(
      `INSERT INTO ops.case_timeline (tenant_id, case_id, event_kind, body, payload, actor_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING id, case_id, event_kind, body, payload, actor_id, occurred_at`,
      [req.tenant.id, id, eventKind, text, JSON.stringify(body.payload ?? {}), actorId],
    );
    return r.rows[0];
  });
  if (!row) return notFound(res);

  recordAudit({
    req, action: 'investigation.timeline.create', resource: 'ops.case_timeline',
    resourceId: row.id, payload: { after: row, case_id: id },
  });
  created(res, { ...row, actor_email: req.user?.email ?? null });
}
