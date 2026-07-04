// =============================================================================
// /api/v1/field/location — technician GPS telemetry (S9A).
// -----------------------------------------------------------------------------
// Routes:
//   POST /field/location              tech posts own position; upserts
//                                     field.technician_location + appends to
//                                     field.technician_location_history.
//                                     Detects geofence crossings vs assigned
//                                     jobs and writes geofence_event rows.
//   GET  /field/technicians/positions manager-only — all last-known positions
//                                     in the tenant (+ optional staleness
//                                     filter).
//
// AuthZ:
//   POST  → field.location.write
//   GET   → field.location.read.tenant
//
// Events: field.tech.moved on every post; field.geofence.entered/exited on
// crossings.
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { readBody, ok, created, badReq, parseQuery, send } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { publishFieldEvent } from '../lib/field-relay.mjs';
import { validCoord } from '../lib/geo.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function postPosition(req, res) {
  if (!requirePermission(req, res, 'field.location.write')) return;
  const body = (await readBody(req)) || {};
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!validCoord(lat, lon)) return badReq(res, 'invalid_coordinates');
  const accuracy = Number.isFinite(Number(body.accuracy_m)) ? Number(body.accuracy_m) : null;
  const heading  = Number.isFinite(Number(body.heading_deg)) ? Number(body.heading_deg) : null;
  const speed    = Number.isFinite(Number(body.speed_mps))   ? Number(body.speed_mps)   : null;
  const captured = body.captured_at ? new Date(body.captured_at) : new Date();
  const userId = req.user?.sub;
  if (!userId || !UUID_RE.test(userId)) return badReq(res, 'caller_not_resolved');

  const result = await withTenantConn(req, async (client) => {
    const before = await client.query(
      `SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon, posted_at
         FROM field.technician_location WHERE user_id = $1`, [userId],
    );

    await client.query(
      `INSERT INTO field.technician_location
         (user_id, tenant_id, location, accuracy_m, heading_deg, speed_mps, captured_at, posted_at)
       VALUES ($1, $2,
               ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography,
               $5, $6, $7, $8, now())
       ON CONFLICT (user_id) DO UPDATE
         SET tenant_id   = EXCLUDED.tenant_id,
             location    = EXCLUDED.location,
             accuracy_m  = EXCLUDED.accuracy_m,
             heading_deg = EXCLUDED.heading_deg,
             speed_mps   = EXCLUDED.speed_mps,
             captured_at = EXCLUDED.captured_at,
             posted_at   = now()`,
      [userId, req.tenant.id, lat, lon, accuracy, heading, speed, captured.toISOString()],
    );

    await client.query(
      `INSERT INTO field.technician_location_history
         (tenant_id, user_id, location, accuracy_m, heading_deg, speed_mps, captured_at, posted_at)
       VALUES ($1, $2,
               ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography,
               $5, $6, $7, $8, now())`,
      [req.tenant.id, userId, lat, lon, accuracy, heading, speed, captured.toISOString()],
    );

    // Geofence detection — over every assigned, non-terminal job. For each
    // job compute distance now and (when we have a prior position) before.
    const jobsRes = await client.query(
      `SELECT id, status, geofence_radius_m,
              ST_Distance(location::geography,
                          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS dist_now,
              CASE WHEN $3::double precision IS NULL OR $4::double precision IS NULL THEN NULL
                   ELSE ST_Distance(location::geography,
                                    ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography) END AS dist_prev
         FROM field.job
        WHERE assigned_to = $5
          AND status NOT IN ('verified','cancelled','completed')
          AND location IS NOT NULL`,
      [
        lat, lon,
        before.rows[0]?.lat ?? null,
        before.rows[0]?.lon ?? null,
        userId,
      ],
    );
    const crossings = [];
    for (const j of jobsRes.rows) {
      const r = Number(j.geofence_radius_m);
      const dn = j.dist_now == null ? null : Number(j.dist_now);
      const dp = j.dist_prev == null ? null : Number(j.dist_prev);
      if (dn == null) continue;
      const inside = dn <= r;
      const wasInside = dp == null ? null : dp <= r;
      let kind = null;
      if (wasInside === null) {
        // First position — record near if we are inside, else nothing.
        if (inside) kind = 'entered';
      } else if (inside && !wasInside) {
        kind = 'entered';
      } else if (!inside && wasInside) {
        kind = 'exited';
      }
      if (kind) {
        await client.query(
          `INSERT INTO field.geofence_event
             (tenant_id, job_id, user_id, event_kind, location, distance_m, captured_at, posted_at, payload)
           VALUES ($1, $2, $3, $4,
                   ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography,
                   $7, $8, now(), $9::jsonb)`,
          [
            req.tenant.id, j.id, userId, kind,
            lat, lon, dn, captured.toISOString(),
            JSON.stringify({ radius_m: r, source: 'location_post' }),
          ],
        );
        crossings.push({ job_id: j.id, kind, distance_m: dn });
      }
    }
    return { crossings };
  });

  recordAudit({
    req, action: 'field.location.post', resource: 'field.technician_location',
    resourceId: userId,
    payload: {
      after: { lat, lon, accuracy_m: accuracy, captured_at: captured.toISOString() },
      crossings: result.crossings,
    },
  });
  publishFieldEvent(req.io, 'field.tech.moved', {
    tenant_id: req.tenant.id,
    user_id:   userId,
    lat, lon,
    accuracy_m: accuracy,
    captured_at: captured.toISOString(),
  });
  for (const c of result.crossings) {
    publishFieldEvent(req.io,
      c.kind === 'entered' ? 'field.geofence.entered' : 'field.geofence.exited',
      {
        tenant_id: req.tenant.id, job_id: c.job_id,
        user_id: userId, distance_m: c.distance_m,
      });
  }
  created(res, { ok: true, crossings: result.crossings });
}

export async function listPositions(req, res) {
  if (!requirePermission(req, res, 'field.location.read.tenant')) return;
  const qs = parseQuery(req.url);
  const staleSeconds = Number.isFinite(Number(qs.stale_seconds))
    ? Math.max(0, Math.min(86_400, Math.round(Number(qs.stale_seconds))))
    : null;
  const rows = await withTenantConn(req, async (client) => {
    const params = [];
    let where = 'tl.tenant_id = current_setting(\'app.tenant_id\', true)::uuid';
    if (staleSeconds != null) {
      params.push(staleSeconds);
      where += ` AND tl.posted_at > now() - ($${params.length} || ' seconds')::interval`;
    }
    const r = await client.query(
      `SELECT tl.user_id,
              ST_Y(tl.location::geometry) AS lat,
              ST_X(tl.location::geometry) AS lon,
              tl.accuracy_m, tl.heading_deg, tl.speed_mps,
              tl.captured_at, tl.posted_at,
              up.email AS user_email, up.display_name AS user_display_name,
              (SELECT j.id FROM field.job j
                WHERE j.assigned_to = tl.user_id
                  AND j.status IN ('assigned','en_route','on_site','in_progress')
                ORDER BY j.scheduled_for NULLS LAST, j.commissioned_at DESC LIMIT 1) AS current_job_id
         FROM field.technician_location tl
         LEFT JOIN iam.user_profile up ON up.id = tl.user_id
        WHERE ${where}
        ORDER BY tl.posted_at DESC`,
      params,
    );
    return r.rows;
  });
  ok(res, rows);
}
