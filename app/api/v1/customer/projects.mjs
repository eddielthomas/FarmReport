// =============================================================================
// /api/v1/customer/me/projects — customer self-service projection (Sprint 14A).
// -----------------------------------------------------------------------------
// Read-only namespace. The caller is bound to their identity (req.user) and
// the underlying tenant is auto-resolved via req.tenant; mutations belong to
// the staff-side /crm/projects/* routes.
//
// Routes:
//   GET /customer/me/projects                 — projects owned by caller
//   GET /customer/me/projects/:id             — single project (404 if not mine)
//   GET /customer/me/projects/:id/scenes      — saved scenes for one project
//
// Authorization: crm.project.read / crm.scene.read enforced by the
// requirePermission gate. SQL filter additionally scopes to the caller's
// customerScope().project_ids so the customer role can never see projects
// outside their identity even if they spoof a project id.
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { ok, badReq, notFound } from '../http.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { customerScope } from './lib/scope.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROJECT_COLS = `id, tenant_id, classification,
                      customer_contact_id, customer_organization_id, source_lead_id,
                      title, description, status,
                      created_by, created_at, updated_at`;

const SCENE_COLS = `id, tenant_id, classification, project_id, title, description,
                    is_default, ordinal,
                    center_lat, center_lon, zoom, pitch, bearing,
                    basemap_id, sar_overlay, sar_opacity, active_layers,
                    time_start, time_end, scan_ids, thumbnail_url,
                    created_by, created_at, updated_at`;

export async function listMyProjects(req, res) {
  if (!requirePermission(req, res, 'crm.project.read')) return;
  const scope = await customerScope(req);
  if (scope.project_ids.length === 0) { ok(res, []); return; }

  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${PROJECT_COLS} FROM crm.project
        WHERE id = ANY($1::uuid[])
          AND status <> 'archived'
        ORDER BY created_at DESC`,
      [scope.project_ids],
    );
    return r.rows;
  });
  ok(res, rows);
}

export async function getMyProject(req, res, id) {
  if (!requirePermission(req, res, 'crm.project.read')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_project_id');
  const scope = await customerScope(req);
  if (!scope.project_ids.includes(id)) return notFound(res);

  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${PROJECT_COLS} FROM crm.project WHERE id = $1`, [id],
    );
    return r.rows[0] ?? null;
  });
  if (!row) return notFound(res);
  ok(res, row);
}

export async function listMyProjectScenes(req, res, id) {
  if (!requirePermission(req, res, 'crm.scene.read')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_project_id');
  const scope = await customerScope(req);
  if (!scope.project_ids.includes(id)) return notFound(res, 'project_not_found');

  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${SCENE_COLS} FROM crm.project_scene
        WHERE project_id = $1
        ORDER BY is_default DESC, ordinal ASC, created_at ASC`,
      [id],
    );
    return r.rows;
  });
  ok(res, rows);
}
