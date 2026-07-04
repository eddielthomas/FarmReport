// =============================================================================
// /api/v1/crm/projects/:id/scenes — saved map scenes (Sprint 14A).
// -----------------------------------------------------------------------------
// Routes:
//   GET    /crm/projects/:id/scenes                    list (read perm)
//   POST   /crm/projects/:id/scenes                    create (scene.write)
//   GET    /crm/projects/:id/scenes/:scene_id          detail (read perm)
//   PUT    /crm/projects/:id/scenes/:scene_id          update (scene.write)
//   DELETE /crm/projects/:id/scenes/:scene_id          delete (scene.write)
//   POST   /crm/projects/:id/scenes/:scene_id/set-default
//                                                       atomic toggle
//
// set-default flips is_default to TRUE on the target row and FALSE on every
// other scene in the same project, inside a single transaction. The unique
// partial index project_scene_default_uniq guarantees the invariant at the
// storage layer; the transaction ensures we don't violate it mid-flight.
//
// Every mutation emits recordAudit.
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, send } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLS = `id, tenant_id, classification, project_id, title, description,
              is_default, ordinal,
              center_lat, center_lon, zoom, pitch, bearing,
              basemap_id, sar_overlay, sar_opacity, active_layers,
              time_start, time_end, scan_ids, thumbnail_url,
              created_by, created_at, updated_at`;

// S13 brand basemap ids + legacy fallbacks.
const VALID_BASEMAPS = new Set([
  // brand
  'hydrovision','thermsight','pressurepulse','nightwatch','echoscan',
  'coherencemap','greenline','deepgrid','riskatlas','satellite',
  // legacy fallbacks (the user spec allows these explicitly)
  'streets','dark',
]);

// Known active_layer ids (extend as the UI catalog grows). The validator only
// rejects layer ids outside this set when caller passes a non-empty array.
const VALID_LAYERS = new Set([
  'leaks','aoi','sar','pipes','manholes','valves','sensors','field_jobs',
  'cases','heatmap','contours','greenline','riskatlas','thermal','nightwatch',
  'optical','coherence','echo','hydrants','customers','vendors','assignments',
  'overlay','annotations',
]);

const VALID_CLASS = new Set(['public','internal','confidential','secret']);

function validationFail(res, field, reason) {
  return send(res, 400, {
    success: false, error: 'validation_failed',
    detail: { field, reason },
  });
}

function isUuidArray(v) {
  if (!Array.isArray(v)) return false;
  for (const x of v) { if (typeof x !== 'string' || !UUID_RE.test(x)) return false; }
  return true;
}

function isStringArray(v) {
  if (!Array.isArray(v)) return false;
  for (const x of v) { if (typeof x !== 'string' || !x) return false; }
  return true;
}

function parseIso(v) {
  if (v == null) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined; // undefined = invalid
}

// Validate the full scene body. Returns { ok:true, value } or { ok:false, field, reason }.
function validateSceneBody(body, { partial = false } = {}) {
  const out = {};

  if (!partial || 'title' in body) {
    if (typeof body.title !== 'string') return { ok: false, field: 'title', reason: 'required' };
    const t = body.title.trim();
    if (!t || t.length > 200) return { ok: false, field: 'title', reason: 'len_1_200' };
    out.title = t;
  }

  if ('description' in body) {
    if (body.description == null) out.description = null;
    else {
      const d = String(body.description);
      if (d.length > 2000) return { ok: false, field: 'description', reason: 'max_2000' };
      out.description = d;
    }
  }

  if ('is_default' in body) {
    if (typeof body.is_default !== 'boolean') return { ok: false, field: 'is_default', reason: 'boolean' };
    out.is_default = body.is_default;
  }

  if ('ordinal' in body) {
    const n = Number(body.ordinal);
    if (!Number.isInteger(n) || n < 0 || n > 100000) return { ok: false, field: 'ordinal', reason: 'int_0_100000' };
    out.ordinal = n;
  }

  if ('center_lat' in body) {
    if (body.center_lat == null) out.center_lat = null;
    else {
      const n = Number(body.center_lat);
      if (!Number.isFinite(n) || n < -90 || n > 90) return { ok: false, field: 'center_lat', reason: 'range_-90_90' };
      out.center_lat = n;
    }
  }

  if ('center_lon' in body) {
    if (body.center_lon == null) out.center_lon = null;
    else {
      const n = Number(body.center_lon);
      if (!Number.isFinite(n) || n < -180 || n > 180) return { ok: false, field: 'center_lon', reason: 'range_-180_180' };
      out.center_lon = n;
    }
  }

  if ('zoom' in body) {
    if (body.zoom == null) out.zoom = null;
    else {
      const n = Number(body.zoom);
      if (!Number.isFinite(n) || n < 0 || n > 22) return { ok: false, field: 'zoom', reason: 'range_0_22' };
      out.zoom = n;
    }
  }

  if ('pitch' in body) {
    const n = Number(body.pitch);
    if (!Number.isFinite(n) || n < 0 || n > 85) return { ok: false, field: 'pitch', reason: 'range_0_85' };
    out.pitch = n;
  }

  if ('bearing' in body) {
    const n = Number(body.bearing);
    if (!Number.isFinite(n) || n < 0 || n > 360) return { ok: false, field: 'bearing', reason: 'range_0_360' };
    out.bearing = n;
  }

  if (!partial || 'basemap_id' in body) {
    if (typeof body.basemap_id !== 'string' || !VALID_BASEMAPS.has(body.basemap_id)) {
      return { ok: false, field: 'basemap_id', reason: 'unknown_basemap' };
    }
    out.basemap_id = body.basemap_id;
  }

  if ('sar_overlay' in body) {
    if (typeof body.sar_overlay !== 'boolean') return { ok: false, field: 'sar_overlay', reason: 'boolean' };
    out.sar_overlay = body.sar_overlay;
  }

  if ('sar_opacity' in body) {
    const n = Number(body.sar_opacity);
    if (!Number.isInteger(n) || n < 0 || n > 100) return { ok: false, field: 'sar_opacity', reason: 'int_0_100' };
    out.sar_opacity = n;
  }

  if ('active_layers' in body) {
    if (!isStringArray(body.active_layers) && !(Array.isArray(body.active_layers) && body.active_layers.length === 0)) {
      return { ok: false, field: 'active_layers', reason: 'string_array' };
    }
    for (const lid of body.active_layers) {
      if (!VALID_LAYERS.has(lid)) return { ok: false, field: 'active_layers', reason: `unknown_layer:${lid}` };
    }
    out.active_layers = body.active_layers;
  }

  if ('time_start' in body) {
    if (body.time_start == null) out.time_start = null;
    else {
      const iso = parseIso(body.time_start);
      if (iso === undefined) return { ok: false, field: 'time_start', reason: 'iso8601' };
      out.time_start = iso;
    }
  }
  if ('time_end' in body) {
    if (body.time_end == null) out.time_end = null;
    else {
      const iso = parseIso(body.time_end);
      if (iso === undefined) return { ok: false, field: 'time_end', reason: 'iso8601' };
      out.time_end = iso;
    }
  }

  if ('scan_ids' in body) {
    if (!isUuidArray(body.scan_ids) && !(Array.isArray(body.scan_ids) && body.scan_ids.length === 0)) {
      return { ok: false, field: 'scan_ids', reason: 'uuid_array' };
    }
    out.scan_ids = body.scan_ids;
  }

  if ('thumbnail_url' in body) {
    if (body.thumbnail_url == null) out.thumbnail_url = null;
    else {
      const s = String(body.thumbnail_url);
      if (s.length > 2048) return { ok: false, field: 'thumbnail_url', reason: 'max_2048' };
      out.thumbnail_url = s;
    }
  }

  if ('classification' in body) {
    if (!VALID_CLASS.has(body.classification)) return { ok: false, field: 'classification', reason: 'enum' };
    out.classification = body.classification;
  }

  return { ok: true, value: out };
}

async function ensureProject(client, projectId) {
  const r = await client.query(
    `SELECT id, classification, source_lead_id FROM crm.project WHERE id = $1`,
    [projectId],
  );
  return r.rows[0] ?? null;
}

// --- LIST -------------------------------------------------------------------
export async function list(req, res, projectId) {
  if (!requirePermission(req, res, 'crm.scene.read')) return;
  if (!UUID_RE.test(projectId)) return badReq(res, 'invalid_project_id');

  const rows = await withTenantConn(req, async (client) => {
    const proj = await ensureProject(client, projectId);
    if (!proj) return null;
    const r = await client.query(
      `SELECT ${COLS} FROM crm.project_scene
        WHERE project_id = $1
        ORDER BY ordinal ASC, created_at ASC`,
      [projectId],
    );
    return r.rows;
  });
  if (rows === null) return notFound(res, 'project_not_found');
  ok(res, rows);
}

// --- GET ONE ----------------------------------------------------------------
export async function get(req, res, projectId, sceneId) {
  if (!requirePermission(req, res, 'crm.scene.read')) return;
  if (!UUID_RE.test(projectId)) return badReq(res, 'invalid_project_id');
  if (!UUID_RE.test(sceneId))   return badReq(res, 'invalid_scene_id');

  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${COLS} FROM crm.project_scene WHERE id = $1 AND project_id = $2`,
      [sceneId, projectId],
    );
    return r.rows[0] ?? null;
  });
  if (!row) return notFound(res);
  ok(res, row);
}

// --- CREATE -----------------------------------------------------------------
export async function create(req, res, projectId) {
  if (!requirePermission(req, res, 'crm.scene.write')) return;
  if (!UUID_RE.test(projectId)) return badReq(res, 'invalid_project_id');

  const body = (await readBody(req)) || {};
  const v = validateSceneBody(body, { partial: false });
  if (!v.ok) return validationFail(res, v.field, v.reason);

  const outcome = await withTenantConn(req, async (client) => {
    const proj = await ensureProject(client, projectId);
    if (!proj) return { kind: 'not_found' };

    // If is_default=true requested, clear other defaults first inside this tx.
    if (v.value.is_default === true) {
      await client.query(
        `UPDATE crm.project_scene SET is_default = FALSE, updated_at = now()
          WHERE project_id = $1 AND is_default = TRUE`,
        [projectId],
      );
    }

    const r = await client.query(
      `INSERT INTO crm.project_scene
         (tenant_id, classification, project_id, title, description,
          is_default, ordinal,
          center_lat, center_lon, zoom, pitch, bearing,
          basemap_id, sar_overlay, sar_opacity, active_layers,
          time_start, time_end, scan_ids, thumbnail_url, created_by)
       VALUES ($1, $2, $3, $4, $5,
               COALESCE($6, false), COALESCE($7, 0),
               $8, $9, $10, COALESCE($11, 0), COALESCE($12, 0),
               $13, COALESCE($14, false), COALESCE($15, 60), COALESCE($16::text[], ARRAY[]::text[]),
               $17::timestamptz, $18::timestamptz, COALESCE($19::uuid[], ARRAY[]::uuid[]), $20, $21)
       RETURNING ${COLS}`,
      [
        req.tenant.id,
        v.value.classification ?? 'internal',
        projectId,
        v.value.title,
        v.value.description ?? null,
        v.value.is_default ?? false,
        v.value.ordinal ?? 0,
        v.value.center_lat ?? null,
        v.value.center_lon ?? null,
        v.value.zoom ?? null,
        v.value.pitch ?? 0,
        v.value.bearing ?? 0,
        v.value.basemap_id,
        v.value.sar_overlay ?? false,
        v.value.sar_opacity ?? 60,
        v.value.active_layers ?? [],
        v.value.time_start ?? null,
        v.value.time_end ?? null,
        v.value.scan_ids ?? [],
        v.value.thumbnail_url ?? null,
        UUID_RE.test(req.user?.sub ?? '') ? req.user.sub : null,
      ],
    );
    return { kind: 'ok', row: r.rows[0] };
  });

  if (outcome.kind === 'not_found') return notFound(res, 'project_not_found');

  recordAudit({
    req, action: 'crm.scene.create',
    resource: 'crm.project_scene', resourceId: outcome.row.id,
    payload: { after: outcome.row, classification: outcome.row.classification,
               project_id: projectId },
  });
  created(res, outcome.row);
}

// --- UPDATE -----------------------------------------------------------------
export async function update(req, res, projectId, sceneId) {
  if (!requirePermission(req, res, 'crm.scene.write')) return;
  if (!UUID_RE.test(projectId)) return badReq(res, 'invalid_project_id');
  if (!UUID_RE.test(sceneId))   return badReq(res, 'invalid_scene_id');

  const body = (await readBody(req)) || {};
  const v = validateSceneBody(body, { partial: true });
  if (!v.ok) return validationFail(res, v.field, v.reason);
  if (Object.keys(v.value).length === 0) return badReq(res, 'no_fields_to_update');

  const outcome = await withTenantConn(req, async (client) => {
    const beforeRes = await client.query(
      `SELECT ${COLS} FROM crm.project_scene WHERE id = $1 AND project_id = $2`,
      [sceneId, projectId],
    );
    if (beforeRes.rows.length === 0) return { kind: 'not_found' };
    const before = beforeRes.rows[0];

    // Default toggle: if setting is_default=true, clear sibling defaults first.
    if (v.value.is_default === true && before.is_default !== true) {
      await client.query(
        `UPDATE crm.project_scene SET is_default = FALSE, updated_at = now()
          WHERE project_id = $1 AND is_default = TRUE AND id <> $2`,
        [projectId, sceneId],
      );
    }

    const sets = []; const params = [sceneId]; let i = 2;
    for (const [k, val] of Object.entries(v.value)) {
      if (k === 'active_layers') {
        sets.push(`active_layers = $${i++}::text[]`); params.push(val);
      } else if (k === 'scan_ids') {
        sets.push(`scan_ids = $${i++}::uuid[]`); params.push(val);
      } else if (k === 'time_start' || k === 'time_end') {
        sets.push(`${k} = $${i++}::timestamptz`); params.push(val);
      } else {
        sets.push(`${k} = $${i++}`); params.push(val);
      }
    }
    sets.push('updated_at = now()');
    const upd = await client.query(
      `UPDATE crm.project_scene SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLS}`,
      params,
    );
    return { kind: 'ok', before, after: upd.rows[0] };
  });

  if (outcome.kind === 'not_found') return notFound(res);

  recordAudit({
    req, action: 'crm.scene.update',
    resource: 'crm.project_scene', resourceId: outcome.after.id,
    payload: { before: outcome.before, after: outcome.after,
               classification: outcome.after.classification,
               project_id: projectId },
  });
  ok(res, outcome.after);
}

// --- DELETE -----------------------------------------------------------------
export async function remove(req, res, projectId, sceneId) {
  if (!requirePermission(req, res, 'crm.scene.write')) return;
  if (!UUID_RE.test(projectId)) return badReq(res, 'invalid_project_id');
  if (!UUID_RE.test(sceneId))   return badReq(res, 'invalid_scene_id');

  const before = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${COLS} FROM crm.project_scene WHERE id = $1 AND project_id = $2`,
      [sceneId, projectId],
    );
    if (r.rows.length === 0) return null;
    await client.query(
      `DELETE FROM crm.project_scene WHERE id = $1 AND project_id = $2`,
      [sceneId, projectId],
    );
    return r.rows[0];
  });
  if (!before) return notFound(res);

  recordAudit({
    req, action: 'crm.scene.delete',
    resource: 'crm.project_scene', resourceId: sceneId,
    payload: { before, classification: before.classification, project_id: projectId },
  });
  ok(res, { id: sceneId, deleted: true });
}

// --- SET DEFAULT -------------------------------------------------------------
// Atomic: set is_default=true on target and FALSE on every other scene in the
// project, inside one transaction.
export async function setDefault(req, res, projectId, sceneId) {
  if (!requirePermission(req, res, 'crm.scene.write')) return;
  if (!UUID_RE.test(projectId)) return badReq(res, 'invalid_project_id');
  if (!UUID_RE.test(sceneId))   return badReq(res, 'invalid_scene_id');

  const outcome = await withTenantConn(req, async (client) => {
    const before = await client.query(
      `SELECT ${COLS} FROM crm.project_scene WHERE id = $1 AND project_id = $2`,
      [sceneId, projectId],
    );
    if (before.rows.length === 0) return { kind: 'not_found' };

    // Clear all other defaults first, then promote target. Order matters to
    // satisfy project_scene_default_uniq during the UPDATE phase.
    await client.query(
      `UPDATE crm.project_scene SET is_default = FALSE, updated_at = now()
        WHERE project_id = $1 AND is_default = TRUE AND id <> $2`,
      [projectId, sceneId],
    );
    const promoted = await client.query(
      `UPDATE crm.project_scene SET is_default = TRUE, updated_at = now()
        WHERE id = $1 RETURNING ${COLS}`,
      [sceneId],
    );
    return { kind: 'ok', before: before.rows[0], after: promoted.rows[0] };
  });

  if (outcome.kind === 'not_found') return notFound(res);

  recordAudit({
    req, action: 'crm.scene.set_default',
    resource: 'crm.project_scene', resourceId: outcome.after.id,
    payload: { before: outcome.before, after: outcome.after,
               classification: outcome.after.classification,
               project_id: projectId },
  });
  ok(res, outcome.after);
}
