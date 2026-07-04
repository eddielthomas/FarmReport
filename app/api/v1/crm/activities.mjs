// =============================================================================
// /api/v1/crm/activities — unified polymorphic timeline (EPIC-003 P-003).
// -----------------------------------------------------------------------------
// Reads gated via crm.activity.read; writes via crm.activity.write.
// The underlying table is append-only (triggers reject UPDATE/DELETE) so no
// patch / remove handlers are exposed.
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, created, badReq, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_KINDS = new Set([
  'system','note','status_change','call','email','sms',
  'meeting','assignment','attachment','message','revenue',
]);
const VALID_ENTITY_KINDS = new Set([
  'lead','contact','organization','client','opportunity',
  'meeting','revenue_record','vendor',
]);
const MANUAL_ALLOWED = new Set(['note','call','email','sms','attachment']);

const COLS = `id, tenant_id, entity_kind::text AS entity_kind, entity_id,
              kind::text AS kind, source, actor_id, actor_label, text,
              occurred_at, audit_event_id, metadata, created_at`;

export async function list(req, res) {
  if (!requirePermission(req, res, 'crm.activity.read')) return;
  const qs = parseQuery(req.url);
  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (qs.entity_kind && VALID_ENTITY_KINDS.has(qs.entity_kind)) {
    params.push(qs.entity_kind);
    where += ` AND entity_kind = $${params.length}::sales.activity_entity_kind_t`;
  }
  if (qs.entity_id && UUID_RE.test(qs.entity_id)) {
    params.push(qs.entity_id); where += ` AND entity_id = $${params.length}`;
  }
  if (qs.kind && VALID_KINDS.has(qs.kind)) {
    params.push(qs.kind);
    where += ` AND kind = $${params.length}::sales.activity_kind_t`;
  }
  if (qs.since) { params.push(qs.since); where += ` AND occurred_at >= $${params.length}`; }
  if (qs.until) { params.push(qs.until); where += ` AND occurred_at <  $${params.length}`; }
  const limit = Math.min(Number(qs.limit ?? 50), 500);
  const { rows } = await q(
    `SELECT ${COLS} FROM sales.activity
      WHERE ${where}
      ORDER BY occurred_at DESC
      LIMIT ${limit}`,
    params,
  );
  ok(res, rows);
}

export async function create(req, res) {
  if (!requirePermission(req, res, 'crm.activity.write')) return;
  const body = (await readBody(req)) || {};
  const entityKind = String(body.entity_kind ?? '').trim();
  const entityId   = String(body.entity_id   ?? '').trim();
  const kind       = String(body.kind        ?? 'note').trim();
  if (!VALID_ENTITY_KINDS.has(entityKind)) return badReq(res, 'invalid_entity_kind');
  if (!UUID_RE.test(entityId))             return badReq(res, 'invalid_entity_id');
  if (!MANUAL_ALLOWED.has(kind))           return badReq(res, 'manual_kind_only');
  const text = body.text ? String(body.text) : null;

  const { rows } = await q(
    `INSERT INTO sales.activity
       (tenant_id, entity_kind, entity_id, kind, source,
        actor_id, actor_label, text, metadata)
     VALUES ($1, $2::sales.activity_entity_kind_t, $3,
             $4::sales.activity_kind_t, 'manual',
             $5, $6, $7, $8::jsonb)
     RETURNING ${COLS}`,
    [
      req.tenant.id, entityKind, entityId, kind,
      req.user?.sub ?? null,
      req.user?.email ?? null,
      text,
      JSON.stringify(body.metadata ?? {}),
    ],
  );
  const row = rows[0];
  recordAudit({
    req, action: 'crm.activity.create',
    resource: 'sales.activity', resourceId: row.id,
    payload: { after: row },
  });
  created(res, row);
}
