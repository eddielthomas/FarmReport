// =============================================================================
// /api/v1/contact/admin — triage routes for inbound contact submissions.
// -----------------------------------------------------------------------------
// All routes require requireAuth + requireTenant + the platform:admin role.
// Submissions are platform-global (no tenant_id on the row itself) but admins
// can promote a submission to a tenant-scoped sales.lead via /promote.
//
// Routes wired by api/v1/index.mjs:
//   GET   /api/v1/contact/admin/list?status=&limit=&cursor=
//   GET   /api/v1/contact/admin/:id
//   PATCH /api/v1/contact/admin/:id        — update status / assigned / notes / spam_score
//   POST  /api/v1/contact/admin/:id/promote { tenant_id }
//   POST  /api/v1/contact/admin/:id/spam
// =============================================================================

import { q, withTx } from './db/pool.mjs';
import { ok, created, badReq, notFound, readBody, parseQuery, send } from './http.mjs';
import { recordAudit } from './audit.mjs';

const VALID_STATUS = new Set(['new','triaged','responded','closed','spam']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ADMIN_COLS = `id, created_at, first_name, last_name, email, company, industry,
                    mission_line, status, assigned_to, spam_score,
                    promoted_lead_id, promoted_at`;

// Full row columns for the detail endpoint — every column on contact_submission.
const FULL_COLS = `id, created_at, first_name, last_name, email, company, industry,
                   mission_line, message, newsletter, source, ip, user_agent,
                   status, notes, phone, role, country, timeline, nda_required,
                   how_heard, consent_privacy, consent_at, assigned_to,
                   spam_score, promoted_lead_id, promoted_tenant_id, promoted_at`;

// ---------------------------------------------------------------------------
// GET /admin/list — paginated by created_at DESC (cursor = ISO timestamp).
// ---------------------------------------------------------------------------
export async function list(req, res) {
  const qs = parseQuery(req.url);
  const status = (qs.status ?? '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(qs.limit ?? 50), 1), 200);
  const cursor = (qs.cursor ?? '').trim();

  const params = [];
  let where = '1=1';
  if (status) {
    if (!VALID_STATUS.has(status)) return badReq(res, 'invalid_status');
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  if (cursor) {
    const d = new Date(cursor);
    if (Number.isNaN(d.getTime())) return badReq(res, 'invalid_cursor');
    params.push(d.toISOString());
    where += ` AND created_at < $${params.length}`;
  }

  const { rows } = await q(
    `SELECT ${ADMIN_COLS}
       FROM public.contact_submission_admin_v1
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ${limit + 1}`,
    params,
  );

  let next_cursor = null;
  if (rows.length > limit) {
    const last = rows[limit - 1];
    next_cursor = last.created_at instanceof Date
      ? last.created_at.toISOString()
      : String(last.created_at);
    rows.length = limit;
  }

  ok(res, { items: rows, next_cursor });
}

// ---------------------------------------------------------------------------
// GET /admin/:id
// ---------------------------------------------------------------------------
export async function getOne(req, res, id) {
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_id');
  const { rows } = await q(
    `SELECT ${FULL_COLS} FROM public.contact_submission WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return notFound(res);
  ok(res, rows[0]);
}

// ---------------------------------------------------------------------------
// PATCH /admin/:id — update status / assigned_to / notes / spam_score
// ---------------------------------------------------------------------------
export async function patch(req, res, id) {
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_id');
  const body = (await readBody(req)) || {};

  const fields = [];
  const params = [id];
  let i = 2;

  if (body.status !== undefined) {
    const s = String(body.status).trim().toLowerCase();
    if (!VALID_STATUS.has(s)) return badReq(res, 'invalid_status');
    fields.push(`status = $${i++}`); params.push(s);
  }
  if (body.assigned_to !== undefined) {
    const v = body.assigned_to === null ? null : String(body.assigned_to).trim().slice(0, 254);
    fields.push(`assigned_to = $${i++}`); params.push(v);
  }
  if (body.notes !== undefined) {
    const v = body.notes === null ? null : String(body.notes).slice(0, 4000);
    fields.push(`notes = $${i++}`); params.push(v);
  }
  if (body.spam_score !== undefined) {
    const n = Math.max(0, Math.min(100, Number(body.spam_score)));
    if (!Number.isFinite(n)) return badReq(res, 'invalid_spam_score');
    fields.push(`spam_score = $${i++}`); params.push(n);
  }

  if (fields.length === 0) return badReq(res, 'no_fields_to_update');

  const { rows } = await q(
    `UPDATE public.contact_submission
        SET ${fields.join(', ')}
      WHERE id = $1
      RETURNING ${FULL_COLS}`,
    params,
  );
  if (rows.length === 0) return notFound(res);

  recordAudit({
    req,
    action:     'contact.admin.patch',
    resource:   'contact_submission',
    resourceId: id,
    payload:    { fields: Object.keys(body) },
  });
  ok(res, rows[0]);
}

// ---------------------------------------------------------------------------
// POST /admin/:id/spam — quick mark-as-spam
// ---------------------------------------------------------------------------
export async function markSpam(req, res, id) {
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_id');
  const { rows } = await q(
    `UPDATE public.contact_submission
        SET status = 'spam', spam_score = 100
      WHERE id = $1
      RETURNING ${FULL_COLS}`,
    [id],
  );
  if (rows.length === 0) return notFound(res);
  recordAudit({
    req,
    action:     'contact.admin.spam',
    resource:   'contact_submission',
    resourceId: id,
  });
  ok(res, rows[0]);
}

// ---------------------------------------------------------------------------
// POST /admin/:id/promote { tenant_id }
//   Inserts a sales.lead row in the target tenant and back-fills
//   contact_submission with the promotion pointers. Idempotent: re-promoting
//   the same submission returns the previously-created lead.
// ---------------------------------------------------------------------------
export async function promote(req, res, id) {
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_id');
  const body = (await readBody(req)) || {};
  const tenantId = String(body.tenant_id ?? '').trim();
  if (!UUID_RE.test(tenantId)) return badReq(res, 'invalid_tenant_id');

  const result = await withTx(async (client) => {
    // Lock the submission row.
    const { rows: srows } = await client.query(
      `SELECT id, first_name, last_name, email, phone, company, role,
              mission_line, message, promoted_lead_id, promoted_tenant_id
         FROM public.contact_submission
        WHERE id = $1
        FOR UPDATE`,
      [id],
    );
    if (srows.length === 0) return { kind: 'not_found' };
    const s = srows[0];

    // Idempotency: if already promoted, return the existing lead.
    if (s.promoted_lead_id) {
      const { rows: lrows } = await client.query(
        `SELECT * FROM sales.lead WHERE id = $1 AND tenant_id = $2`,
        [s.promoted_lead_id, s.promoted_tenant_id],
      );
      if (lrows.length > 0) return { kind: 'already', lead: lrows[0] };
      // The previously-pointed-to lead is gone — fall through and re-promote.
    }

    // Verify tenant exists + active.
    const { rows: trows } = await client.query(
      `SELECT id, status FROM iam.tenant WHERE id = $1`,
      [tenantId],
    );
    if (trows.length === 0) return { kind: 'bad_tenant' };
    if (trows[0].status !== 'active' && trows[0].status !== 'trial') {
      return { kind: 'tenant_suspended' };
    }

    const fullName = [s.first_name, s.last_name].filter(Boolean).join(' ').trim() || s.email;
    const stamps   = { infoRequestedAt: new Date().toISOString() };

    const { rows: lead } = await client.query(
      `INSERT INTO sales.lead
         (tenant_id, name, email, phone, company, position, status, source,
          source_details, interest, status_timestamps)
       VALUES ($1,$2,$3,$4,$5,$6,'Info Request',$7,$8,$9,$10::jsonb)
       RETURNING *`,
      [
        tenantId,
        fullName,
        s.email,
        s.phone,
        s.company,
        s.role,           // sales.lead.position ← contact role
        'contact_form',
        'Promoted from public contact submission ' + s.id,
        s.mission_line,
        JSON.stringify(stamps),
      ],
    );

    // Back-fill submission.
    await client.query(
      `UPDATE public.contact_submission
          SET promoted_lead_id   = $2,
              promoted_tenant_id = $3,
              promoted_at        = now(),
              status             = CASE WHEN status = 'new' THEN 'triaged' ELSE status END
        WHERE id = $1`,
      [id, lead[0].id, tenantId],
    );

    // Best-effort: append the original message as a sales.note (if available).
    if (s.message) {
      try {
        await client.query(
          `INSERT INTO sales.note (tenant_id, lead_id, body, author_id)
           VALUES ($1, $2, $3, NULL)`,
          [tenantId, lead[0].id, `[Promoted from contact form]\n\n${s.message}`],
        );
      } catch (err) {
        // Non-fatal: sales.note may not exist in all environments.
        console.warn('[contact.admin] sales.note insert failed', err?.message);
      }
    }

    return { kind: 'ok', lead: lead[0] };
  });

  if (result.kind === 'not_found')        return notFound(res);
  if (result.kind === 'bad_tenant')       return badReq(res, 'unknown_tenant');
  if (result.kind === 'tenant_suspended') return send(res, 403, { success: false, error: 'tenant_suspended' });
  if (result.kind === 'already') {
    recordAudit({
      req,
      action:     'contact.admin.promote.noop',
      resource:   'contact_submission',
      resourceId: id,
      payload:    { tenant_id: tenantId, lead_id: result.lead.id },
    });
    return ok(res, { lead: result.lead, already_promoted: true });
  }

  recordAudit({
    req,
    action:     'contact.admin.promote',
    resource:   'contact_submission',
    resourceId: id,
    payload:    { tenant_id: tenantId, lead_id: result.lead.id },
  });
  created(res, { lead: result.lead });
}
