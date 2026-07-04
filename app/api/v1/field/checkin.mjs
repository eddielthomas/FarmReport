// =============================================================================
// /api/v1/field/jobs/:id/check-in + /check-out — GPS-gated time tracking (S9A).
// -----------------------------------------------------------------------------
// Strict-by-default check-in:
//   - Reads tenant flag field.geofence_strict_checkin (default TRUE).
//   - Computes distance to job.location via ST_Distance(geography).
//   - If strict + distance > radius → 422 gps_out_of_geofence with detail.
//   - Otherwise: closes any existing open time_entry for the same user,
//     opens a new one bound to this job, inserts a geofence_event 'checkin'
//     (and 'entered' if not already inside), bumps job status to on_site
//     when currently in (assigned, en_route).
//
// Check-out:
//   - Lenient by default (still records end_location whatever its position).
//   - Closes the most recent open time_entry for (user, job).
//   - Emits geofence_event 'checkout' + workflow envelope.
//
// AuthZ: both endpoints require field.checkin.
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { readBody, ok, badReq, notFound, send } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { publishStateChanged } from '../lib/activity.mjs';
import { publishFieldEvent } from '../lib/field-relay.mjs';
import { validCoord } from '../lib/geo.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readStrictFlag(req) {
  const raw = req.tenant?.flags?.['field.geofence_strict_checkin'];
  if (raw === false || raw === 'false' || raw === 0) return false;
  return true; // default true
}

export async function checkIn(req, res, jobId) {
  if (!requirePermission(req, res, 'field.checkin')) return;
  if (!UUID_RE.test(jobId)) return badReq(res, 'invalid_job_id');
  const body = (await readBody(req)) || {};
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!validCoord(lat, lon)) return badReq(res, 'invalid_coordinates');
  const accuracy = Number.isFinite(Number(body.accuracy_m)) ? Number(body.accuracy_m) : null;
  const captured = body.captured_at ? new Date(body.captured_at) : new Date();
  const userId = req.user?.sub;
  if (!userId || !UUID_RE.test(userId)) return badReq(res, 'caller_not_resolved');
  const strict = readStrictFlag(req);

  const outcome = await withTenantConn(req, async (client) => {
    const jres = await client.query(
      `SELECT id, status, assigned_to, geofence_radius_m,
              ST_Distance(location::geography,
                          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS dist_m,
              location IS NOT NULL AS has_location
         FROM field.job WHERE id = $3`,
      [lat, lon, jobId],
    );
    if (jres.rows.length === 0) return { kind: 'not_found' };
    const job = jres.rows[0];
    if (job.assigned_to !== userId) {
      // Only an assignee may check in. Managers may impersonate via PUT, not
      // via check-in.
      return { kind: 'forbidden' };
    }
    const distance = job.dist_m == null ? null : Number(job.dist_m);
    const radius = Number(job.geofence_radius_m);
    if (job.has_location && distance != null && distance > radius && strict) {
      return { kind: 'out_of_geofence', distance_m: distance, radius_m: radius };
    }

    // Close any pre-existing open entry (different job or same).
    const closedRows = await client.query(
      `UPDATE field.time_entry
          SET ended_at = now(),
              end_location = ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
        WHERE user_id = $3 AND ended_at IS NULL
        RETURNING id, job_id, started_at`,
      [lat, lon, userId],
    );

    // Open a fresh time_entry.
    const teRes = await client.query(
      `INSERT INTO field.time_entry
         (tenant_id, job_id, user_id, start_location, started_at, gps_strict)
       VALUES ($1, $2, $3,
               ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography,
               now(), $6)
       RETURNING id, started_at`,
      [req.tenant.id, jobId, userId, lat, lon, strict],
    );
    const timeEntry = teRes.rows[0];

    // Geofence events — checkin + entered (when inside)
    await client.query(
      `INSERT INTO field.geofence_event
         (tenant_id, job_id, user_id, event_kind, location, distance_m, captured_at, posted_at, payload)
       VALUES ($1, $2, $3, 'checkin',
               ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography,
               $6, $7, now(), $8::jsonb)`,
      [
        req.tenant.id, jobId, userId, lat, lon, distance,
        captured.toISOString(),
        JSON.stringify({ strict, radius_m: radius, time_entry_id: timeEntry.id }),
      ],
    );
    if (distance != null && distance <= radius) {
      await client.query(
        `INSERT INTO field.geofence_event
           (tenant_id, job_id, user_id, event_kind, location, distance_m, captured_at, posted_at, payload)
         VALUES ($1, $2, $3, 'entered',
                 ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography,
                 $6, $7, now(), '{}'::jsonb)`,
        [req.tenant.id, jobId, userId, lat, lon, distance, captured.toISOString()],
      );
    }

    // Advance status to on_site (when currently in assigned/en_route).
    let statusChange = null;
    if (['assigned','en_route','commissioned'].includes(job.status)) {
      const upd = await client.query(
        `UPDATE field.job SET status = 'on_site', updated_at = now()
          WHERE id = $1 AND status = $2 RETURNING status`,
        [jobId, job.status],
      );
      if (upd.rows.length === 1) statusChange = { from: job.status, to: 'on_site' };
    }

    return { kind: 'ok', timeEntry, statusChange, distance_m: distance, radius_m: radius,
             closed: closedRows.rows };
  });

  if (outcome.kind === 'not_found') return notFound(res);
  if (outcome.kind === 'forbidden') return send(res, 403, { success: false, error: 'not_assignee' });
  if (outcome.kind === 'out_of_geofence') {
    return send(res, 422, {
      success: false,
      error: 'gps_out_of_geofence',
      detail: { distance_m: outcome.distance_m, radius_m: outcome.radius_m, strict },
    });
  }

  recordAudit({
    req, action: 'field.checkin', resource: 'field.time_entry',
    resourceId: outcome.timeEntry.id,
    payload: {
      after: { id: outcome.timeEntry.id, job_id: jobId, started_at: outcome.timeEntry.started_at },
      distance_m: outcome.distance_m, radius_m: outcome.radius_m, gps_strict: strict,
    },
  });
  publishFieldEvent(req.io, 'field.time_entry.opened', {
    tenant_id: req.tenant.id, job_id: jobId, user_id: userId,
    time_entry_id: outcome.timeEntry.id, started_at: outcome.timeEntry.started_at,
  });
  if (outcome.statusChange) {
    publishStateChanged({
      tenantId: req.tenant.id, entityKind: 'lead', entityId: jobId,
      fromState: outcome.statusChange.from, toState: outcome.statusChange.to,
      actorId: userId, actorLabel: req.user?.email ?? null,
      metadata: { surface: 'field.job', job_id: jobId, trigger: 'checkin' },
    }).catch(() => {});
    publishFieldEvent(req.io, 'field.job.status_changed', {
      tenant_id: req.tenant.id, job_id: jobId,
      from: outcome.statusChange.from, to: outcome.statusChange.to,
    });
  }
  ok(res, {
    time_entry_id: outcome.timeEntry.id,
    started_at:    outcome.timeEntry.started_at,
    distance_m:    outcome.distance_m,
    radius_m:      outcome.radius_m,
    strict,
  });
}

// =============================================================================
// pause / resume — S17 lifecycle legs.
// -----------------------------------------------------------------------------
// pause:  close the open time_entry (stop tracked hours) WITHOUT completing;
//         set job status in_progress -> paused. No geofence gate.
// resume: open a fresh time_entry; set job status paused -> in_progress. No
//         geofence re-validation (keep it simple per S17 decision).
// Both reuse the same time_entry table the check-in/out helpers write to and
// require the field.checkin permission (assignee-only).
// =============================================================================

export async function pause(req, res, jobId) {
  if (!requirePermission(req, res, 'field.checkin')) return;
  if (!UUID_RE.test(jobId)) return badReq(res, 'invalid_job_id');
  const body = (await readBody(req)) || {};
  const lat = body.lat != null ? Number(body.lat) : null;
  const lon = body.lon != null ? Number(body.lon) : null;
  const hasCoords = lat != null && lon != null && validCoord(lat, lon);
  const userId = req.user?.sub;
  if (!userId || !UUID_RE.test(userId)) return badReq(res, 'caller_not_resolved');

  const outcome = await withTenantConn(req, async (client) => {
    const jres = await client.query(
      `SELECT id, status, assigned_to FROM field.job WHERE id = $1::uuid`, [jobId],
    );
    if (jres.rows.length === 0) return { kind: 'not_found' };
    const job = jres.rows[0];
    if (job.assigned_to !== userId) return { kind: 'forbidden' };
    if (job.status !== 'in_progress') {
      return { kind: 'invalid_transition', from: job.status, to: 'paused' };
    }

    // Close the open time_entry (stop the clock) without completing the job.
    const teRes = await client.query(
      `UPDATE field.time_entry
          SET ended_at     = now(),
              end_location = CASE WHEN $3::double precision IS NULL THEN end_location
                                  ELSE ST_SetSRID(ST_MakePoint($4::double precision, $3::double precision), 4326)::geography END
        WHERE user_id = $1 AND job_id = $2 AND ended_at IS NULL
        RETURNING id, started_at, ended_at, duration_seconds`,
      [userId, jobId, hasCoords ? lat : null, hasCoords ? lon : null],
    );

    const upd = await client.query(
      `UPDATE field.job SET status = 'paused', updated_at = now()
        WHERE id = $1 AND status = 'in_progress' RETURNING status`,
      [jobId],
    );
    if (upd.rows.length !== 1) return { kind: 'invalid_transition', from: job.status, to: 'paused' };

    return { kind: 'ok', closed: teRes.rows[0] ?? null };
  });

  if (outcome.kind === 'not_found') return notFound(res);
  if (outcome.kind === 'forbidden') return send(res, 403, { success: false, error: 'not_assignee' });
  if (outcome.kind === 'invalid_transition') {
    return send(res, 422, { success: false, error: 'invalid_state_transition',
      detail: { from: outcome.from, to: outcome.to } });
  }

  recordAudit({
    req, action: 'field.job.pause', resource: 'field.job', resourceId: jobId,
    payload: { after: { status: 'paused' }, closed_time_entry: outcome.closed?.id ?? null },
  });
  if (outcome.closed) {
    publishFieldEvent(req.io, 'field.time_entry.closed', {
      tenant_id: req.tenant.id, job_id: jobId, user_id: userId,
      time_entry_id: outcome.closed.id, ended_at: outcome.closed.ended_at,
      duration_seconds: outcome.closed.duration_seconds,
    });
  }
  publishStateChanged({
    tenantId: req.tenant.id, entityKind: 'lead', entityId: jobId,
    fromState: 'in_progress', toState: 'paused',
    actorId: userId, actorLabel: req.user?.email ?? null,
    metadata: { surface: 'field.job', job_id: jobId, trigger: 'pause' },
  }).catch(() => {});
  publishFieldEvent(req.io, 'field.job.status_changed', {
    tenant_id: req.tenant.id, job_id: jobId, from: 'in_progress', to: 'paused',
  });
  ok(res, { status: 'paused', closed_time_entry: outcome.closed?.id ?? null });
}

// GET /field/time/active — the caller's currently-open time entry (ended_at IS
// NULL), if any, plus its job. "Not clocked in" is a valid state, so this
// returns 200 {time_entry:null, job:null} rather than 404 — the FieldApp polls
// it every 60s to decide whether to stream the location heartbeat (on-shift),
// and a 404 would (a) log a console error each poll and (b) leave on-shift
// detection permanently false. Mirrors the FieldTimeEntry FE shape.
export async function activeTime(req, res) {
  if (!requirePermission(req, res, 'field.checkin')) return;
  const userId = req.user?.sub;
  if (!userId || !UUID_RE.test(userId)) return badReq(res, 'caller_not_resolved');
  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT te.id, te.job_id, te.user_id, te.started_at, te.ended_at, te.duration_seconds,
              j.title AS job_title, j.status AS job_status
         FROM field.time_entry te
         LEFT JOIN field.job j ON j.id = te.job_id
        WHERE te.user_id = $1::uuid AND te.ended_at IS NULL
        ORDER BY te.started_at DESC
        LIMIT 1`,
      [userId],
    );
    return r.rows[0] ?? null;
  });
  if (!row) return ok(res, { time_entry: null, job: null });
  const { job_title, job_status, ...te } = row;
  ok(res, {
    time_entry: te,
    job: te.job_id ? { id: te.job_id, title: job_title, status: job_status } : null,
  });
}

export async function resume(req, res, jobId) {
  if (!requirePermission(req, res, 'field.checkin')) return;
  if (!UUID_RE.test(jobId)) return badReq(res, 'invalid_job_id');
  const body = (await readBody(req)) || {};
  const lat = body.lat != null ? Number(body.lat) : null;
  const lon = body.lon != null ? Number(body.lon) : null;
  const hasCoords = lat != null && lon != null && validCoord(lat, lon);
  const userId = req.user?.sub;
  if (!userId || !UUID_RE.test(userId)) return badReq(res, 'caller_not_resolved');
  const strict = readStrictFlag(req);

  const outcome = await withTenantConn(req, async (client) => {
    const jres = await client.query(
      `SELECT id, status, assigned_to FROM field.job WHERE id = $1::uuid`, [jobId],
    );
    if (jres.rows.length === 0) return { kind: 'not_found' };
    const job = jres.rows[0];
    if (job.assigned_to !== userId) return { kind: 'forbidden' };
    if (job.status !== 'paused') {
      return { kind: 'invalid_transition', from: job.status, to: 'in_progress' };
    }

    // Close any stray open entry first (defensive — should be none after pause).
    await client.query(
      `UPDATE field.time_entry SET ended_at = now()
        WHERE user_id = $1 AND ended_at IS NULL`,
      [userId],
    );

    // Open a fresh time_entry. No geofence gate on resume (S17 decision).
    const teRes = await client.query(
      `INSERT INTO field.time_entry
         (tenant_id, job_id, user_id, start_location, started_at, gps_strict)
       VALUES ($1, $2, $3,
               CASE WHEN $4::double precision IS NULL THEN NULL
                    ELSE ST_SetSRID(ST_MakePoint($5::double precision, $4::double precision), 4326)::geography END,
               now(), $6)
       RETURNING id, started_at`,
      [req.tenant.id, jobId, userId, hasCoords ? lat : null, hasCoords ? lon : null, strict],
    );

    const upd = await client.query(
      `UPDATE field.job SET status = 'in_progress', updated_at = now()
        WHERE id = $1 AND status = 'paused' RETURNING status`,
      [jobId],
    );
    if (upd.rows.length !== 1) return { kind: 'invalid_transition', from: job.status, to: 'in_progress' };

    return { kind: 'ok', timeEntry: teRes.rows[0] };
  });

  if (outcome.kind === 'not_found') return notFound(res);
  if (outcome.kind === 'forbidden') return send(res, 403, { success: false, error: 'not_assignee' });
  if (outcome.kind === 'invalid_transition') {
    return send(res, 422, { success: false, error: 'invalid_state_transition',
      detail: { from: outcome.from, to: outcome.to } });
  }

  recordAudit({
    req, action: 'field.job.resume', resource: 'field.job', resourceId: jobId,
    payload: { after: { status: 'in_progress' }, opened_time_entry: outcome.timeEntry.id },
  });
  publishFieldEvent(req.io, 'field.time_entry.opened', {
    tenant_id: req.tenant.id, job_id: jobId, user_id: userId,
    time_entry_id: outcome.timeEntry.id, started_at: outcome.timeEntry.started_at,
  });
  publishStateChanged({
    tenantId: req.tenant.id, entityKind: 'lead', entityId: jobId,
    fromState: 'paused', toState: 'in_progress',
    actorId: userId, actorLabel: req.user?.email ?? null,
    metadata: { surface: 'field.job', job_id: jobId, trigger: 'resume' },
  }).catch(() => {});
  publishFieldEvent(req.io, 'field.job.status_changed', {
    tenant_id: req.tenant.id, job_id: jobId, from: 'paused', to: 'in_progress',
  });
  ok(res, { status: 'in_progress', time_entry_id: outcome.timeEntry.id, started_at: outcome.timeEntry.started_at });
}

export async function checkOut(req, res, jobId) {
  if (!requirePermission(req, res, 'field.checkin')) return;
  if (!UUID_RE.test(jobId)) return badReq(res, 'invalid_job_id');
  const body = (await readBody(req)) || {};
  const lat = body.lat != null ? Number(body.lat) : null;
  const lon = body.lon != null ? Number(body.lon) : null;
  const hasCoords = lat != null && lon != null && validCoord(lat, lon);
  const captured = body.captured_at ? new Date(body.captured_at) : new Date();
  const userId = req.user?.sub;
  if (!userId || !UUID_RE.test(userId)) return badReq(res, 'caller_not_resolved');

  const outcome = await withTenantConn(req, async (client) => {
    const jres = await client.query(
      `SELECT id, status, assigned_to, geofence_radius_m,
              CASE WHEN $1::double precision IS NULL THEN NULL
                   ELSE ST_Distance(location::geography,
                                    ST_SetSRID(ST_MakePoint($2::double precision, $1::double precision), 4326)::geography) END AS dist_m
         FROM field.job WHERE id = $3::uuid`,
      [hasCoords ? lat : null, hasCoords ? lon : null, jobId],
    );
    if (jres.rows.length === 0) return { kind: 'not_found' };
    const job = jres.rows[0];
    if (job.assigned_to !== userId) return { kind: 'forbidden' };

    const teRes = await client.query(
      `UPDATE field.time_entry
          SET ended_at     = now(),
              end_location = CASE WHEN $3::double precision IS NULL THEN end_location
                                  ELSE ST_SetSRID(ST_MakePoint($4::double precision, $3::double precision), 4326)::geography END
        WHERE user_id = $1 AND job_id = $2 AND ended_at IS NULL
        RETURNING id, started_at, ended_at, duration_seconds`,
      [userId, jobId, hasCoords ? lat : null, hasCoords ? lon : null],
    );
    if (teRes.rows.length === 0) return { kind: 'no_open_entry' };
    const timeEntry = teRes.rows[0];

    await client.query(
      `INSERT INTO field.geofence_event
         (tenant_id, job_id, user_id, event_kind, location, distance_m, captured_at, posted_at, payload)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'checkout',
               CASE WHEN $4::double precision IS NULL THEN NULL
                    ELSE ST_SetSRID(ST_MakePoint($5::double precision, $4::double precision), 4326)::geography END,
               $6::numeric, $7::timestamptz, now(), $8::jsonb)`,
      [
        req.tenant.id, jobId, userId,
        hasCoords ? lat : null, hasCoords ? lon : null,
        job.dist_m,
        captured.toISOString(),
        JSON.stringify({ time_entry_id: timeEntry.id, duration_seconds: timeEntry.duration_seconds }),
      ],
    );

    // Advance status to completed when currently in_progress/on_site.
    let statusChange = null;
    if (['in_progress','on_site'].includes(job.status)) {
      const upd = await client.query(
        `UPDATE field.job SET status = 'completed', updated_at = now()
          WHERE id = $1 AND status = $2 RETURNING status`,
        [jobId, job.status],
      );
      if (upd.rows.length === 1) statusChange = { from: job.status, to: 'completed' };
    }

    return { kind: 'ok', timeEntry, statusChange, dist_m: job.dist_m };
  });

  if (outcome.kind === 'not_found')    return notFound(res);
  if (outcome.kind === 'forbidden')    return send(res, 403, { success: false, error: 'not_assignee' });
  if (outcome.kind === 'no_open_entry') return send(res, 422, { success: false, error: 'no_open_time_entry' });

  recordAudit({
    req, action: 'field.checkout', resource: 'field.time_entry',
    resourceId: outcome.timeEntry.id,
    payload: {
      after: {
        id: outcome.timeEntry.id, job_id: jobId,
        started_at: outcome.timeEntry.started_at,
        ended_at:   outcome.timeEntry.ended_at,
        duration_seconds: outcome.timeEntry.duration_seconds,
      },
      distance_m: outcome.dist_m,
    },
  });
  publishFieldEvent(req.io, 'field.time_entry.closed', {
    tenant_id: req.tenant.id, job_id: jobId, user_id: userId,
    time_entry_id: outcome.timeEntry.id,
    ended_at: outcome.timeEntry.ended_at,
    duration_seconds: outcome.timeEntry.duration_seconds,
  });
  if (outcome.statusChange) {
    publishStateChanged({
      tenantId: req.tenant.id, entityKind: 'lead', entityId: jobId,
      fromState: outcome.statusChange.from, toState: outcome.statusChange.to,
      actorId: userId, actorLabel: req.user?.email ?? null,
      metadata: { surface: 'field.job', job_id: jobId, trigger: 'checkout' },
    }).catch(() => {});
    publishFieldEvent(req.io, 'field.job.status_changed', {
      tenant_id: req.tenant.id, job_id: jobId,
      from: outcome.statusChange.from, to: outcome.statusChange.to,
    });
  }
  ok(res, {
    time_entry_id:    outcome.timeEntry.id,
    started_at:       outcome.timeEntry.started_at,
    ended_at:         outcome.timeEntry.ended_at,
    duration_seconds: outcome.timeEntry.duration_seconds,
  });
}
