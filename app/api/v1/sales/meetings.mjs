// =============================================================================
// /api/v1/sales/meetings — calendar entries scoped to a tenant.
// -----------------------------------------------------------------------------
// S4A (EPIC-007 P-007 Phase 1) — adds provider/owner_id/status/etag/version
// columns. All meeting state transitions emit via lib/calendar-events.mjs
// which pairs a sales.activity envelope with a recordAudit row.
//
// Phase 1 only supports provider='internal' creation through this endpoint.
// Provider integrations (google/outlook/ical) ship in Phase 2.
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { emitActivity } from '../lib/activity.mjs';
import { emitMeetingTransition } from '../lib/calendar-events.mjs';
import { notifyMeetingScheduled } from '../email/notify.mjs';

const COLS = `
  id, tenant_id, lead_id, title, start_at, end_at, location, attendees, notes,
  provider, external_id, etag, sync_token, last_synced_at, owner_id, status,
  updated_at, version, created_at
`;

export async function list(req, res) {
  const qs = parseQuery(req.url);
  const from = qs.from ? new Date(qs.from) : null;
  const to   = qs.to   ? new Date(qs.to)   : null;
  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (from && !isNaN(from)) { params.push(from.toISOString()); where += ` AND start_at >= $${params.length}`; }
  if (to   && !isNaN(to))   { params.push(to.toISOString());   where += ` AND start_at <  $${params.length}`; }
  if (qs.provider) { params.push(String(qs.provider)); where += ` AND provider = $${params.length}`; }
  if (qs.status)   { params.push(String(qs.status));   where += ` AND status   = $${params.length}`; }
  if (qs.owner_id) { params.push(String(qs.owner_id)); where += ` AND owner_id = $${params.length}`; }
  const { rows } = await q(
    `SELECT ${COLS} FROM sales.meeting WHERE ${where} ORDER BY start_at ASC`,
    params,
  );
  ok(res, rows);
}

export async function create(req, res) {
  const body = (await readBody(req)) || {};
  const title = String(body.title ?? '').trim();
  const start_at = body.start_at ?? null;
  const end_at   = body.end_at ?? null;
  if (!title || !start_at || !end_at) return badReq(res, 'title_start_end_required');

  // Phase 1: only `internal` is creatable via this endpoint. Non-internal
  // providers ship in Phase 2 with the OAuth connect flows.
  const provider = body.provider ?? 'internal';
  if (provider !== 'internal') {
    return badReq(res, 'provider_not_supported_in_phase1');
  }
  const owner_id = body.owner_id ?? req.user?.sub ?? null;

  const { rows } = await q(
    `INSERT INTO sales.meeting
       (tenant_id, lead_id, title, start_at, end_at, location, attendees, notes,
        provider, owner_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'scheduled')
     RETURNING ${COLS}`,
    [
      req.tenant.id,
      body.lead_id ?? null,
      title,
      start_at,
      end_at,
      body.location ?? null,
      JSON.stringify(body.attendees ?? []),
      body.notes ?? null,
      provider,
      owner_id,
    ],
  );
  recordAudit({ req, action: 'create', resource: 'sales.meeting', resourceId: rows[0].id, payload: { after: rows[0] } });

  // S4A — state-transition envelope (null -> scheduled). Pairs an audit event
  // keyed on the destination state with the workflow envelope timeline row.
  emitMeetingTransition(req, rows[0].id, null, 'scheduled', {
    provider, owner_id, lead_id: rows[0].lead_id,
  }).catch(() => {});

  // Sprint 2A — dual-write into the unified activity timeline. If the meeting
  // is bound to a lead, the timeline pivots on the lead; otherwise on the
  // meeting row itself.
  const entityKind = rows[0].lead_id ? 'lead' : 'meeting';
  const entityId   = rows[0].lead_id ? rows[0].lead_id : rows[0].id;
  emitActivity({
    tenantId: req.tenant.id, entityKind, entityId,
    kind: 'meeting', source: 'manual',
    actorId: req.user?.sub ?? null, actorLabel: req.user?.email ?? null,
    text: title,
    metadata: { meeting_id: rows[0].id, start_at, end_at, location: body.location ?? null, provider },
  }).catch(() => {});

  // S3B — email notification (fire-and-forget, enqueues into email.outbox).
  notifyMeetingScheduled(req, rows[0].id, { meeting: rows[0] })
    .catch((e) => console.error('[notify] meeting_scheduled failed', e?.message ?? e));

  created(res, rows[0]);
}

export async function update(req, res, id) {
  const body = (await readBody(req)) || {};
  const fields = []; const params = [req.tenant.id, id]; let i = 3;
  const changing = [];
  for (const k of ['title','start_at','end_at','location','notes','lead_id','owner_id','status']) {
    if (body[k] !== undefined) { fields.push(`${k} = $${i++}`); params.push(body[k]); changing.push(k); }
  }
  if (body.attendees !== undefined) {
    fields.push(`attendees = $${i++}::jsonb`); params.push(JSON.stringify(body.attendees)); changing.push('attendees');
  }
  if (fields.length === 0) return badReq(res, 'no_fields_to_update');
  const beforeRes = await q(`SELECT ${COLS} FROM sales.meeting WHERE tenant_id = $1 AND id = $2`, [req.tenant.id, id]);
  const before = beforeRes.rows[0] ?? null;
  // Bump updated_at on every accepted UPDATE so consumers can poll by it.
  fields.push(`updated_at = now()`);
  const { rows } = await q(
    `UPDATE sales.meeting SET ${fields.join(', ')}
      WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`,
    params,
  );
  if (rows.length === 0) return notFound(res);
  recordAudit({ req, action: 'update', resource: 'sales.meeting', resourceId: id, payload: { before, after: rows[0], fields: changing } });

  // S4A — emit state-transition envelope whenever status actually moved.
  if (before && body.status !== undefined && before.status !== rows[0].status) {
    emitMeetingTransition(req, id, before.status, rows[0].status, {
      provider: rows[0].provider, fields: changing,
    }).catch(() => {});
  }
  ok(res, rows[0]);
}

export async function remove(req, res, id) {
  const beforeRes = await q(`SELECT ${COLS} FROM sales.meeting WHERE tenant_id = $1 AND id = $2`, [req.tenant.id, id]);
  const before = beforeRes.rows[0] ?? null;
  const { rowCount } = await q(
    `DELETE FROM sales.meeting WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (rowCount === 0) return notFound(res);
  recordAudit({ req, action: 'delete', resource: 'sales.meeting', resourceId: id, payload: { before } });

  // S4A — DELETE is treated as a transition to cancelled for the workflow envelope.
  emitMeetingTransition(req, id, before?.status ?? 'scheduled', 'cancelled', {
    provider: before?.provider ?? 'internal', via: 'delete',
  }).catch(() => {});
  ok(res, { id });
}
