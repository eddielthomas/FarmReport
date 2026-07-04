// =============================================================================
// crmRepo.mjs — visibility-aware repository (Sprint 1B / EPIC-002).
// -----------------------------------------------------------------------------
// Every read function branches on the caller's effective permissions:
//   - data.read.global   → all rows in tenant
//   - platform.admin.all → all rows in tenant
//   - otherwise          → rows EXISTS-joined with sales.assignment.user_id
//                          (released_at IS NULL)
//
// All returned rows are run through applyFieldMask() so vendor.viewer /
// viewer.exec / customer.viewer redactions apply uniformly.
// =============================================================================

import { q } from '../db/pool.mjs';
import { applyFieldMask } from '../middleware/fieldMask.mjs';

const LEAD_COLS = `l.id, l.tenant_id, l.name, l.email, l.phone, l.company, l.position,
                   l.status, l.source, l.source_details, l.interest, l.total_revenue,
                   l.status_timestamps, l.selected_products,
                   l.organization_id, l.primary_contact_id, l.vendor_id,
                   l.archived_at, l.archived_reason, l.classification,
                   l.created_at, l.updated_at`;

function callerHasGlobal(req) {
  const perms = req.user?.permissions;
  if (perms && (perms.has('platform.admin.all') || perms.has('data.read.global'))) {
    return true;
  }
  // Legacy roles[] compat — sales:manage and platform:admin both imply global.
  const roles = req.user?.roles ?? [];
  if (roles.includes('platform:admin')) return true;
  if (roles.includes('sales:manage'))   return true;
  return false;
}

// Sprint 5B (P-010 Phase 3) — Bell-LaPadula clearance filter applied at the
// app layer to back up the (advisory) RLS policy in 139_classification.sql.
// The rwr app role owns every business table so RLS is not FORCEd; this
// guarantees the lattice always holds regardless of how the connection is
// acquired.
const CLEARANCE_RANK = { public: 0, internal: 1, confidential: 2, secret: 3 };
function clearanceRank(c) {
  return CLEARANCE_RANK[c] ?? -1;
}
// Returns the SQL fragment "l.classification IN (...)" parameterized + the
// list of param values to append. Returns ['', []] when subject can see all
// levels (i.e. secret) so the caller can skip appending an extra predicate.
function clearanceWhere(req, alias = 'l', paramStart = 1) {
  const subject = req?.user?.clearance || 'internal';
  const rank = clearanceRank(subject);
  if (rank < 0) return { sql: '', params: [] };  // unknown -> no extra filter
  const allowed = Object.entries(CLEARANCE_RANK)
    .filter(([, r]) => r <= rank)
    .map(([name]) => name);
  if (allowed.length === 4) return { sql: '', params: [] };  // secret sees all
  const placeholders = allowed.map((_v, i) => `$${paramStart + i}`).join(',');
  return {
    sql: `${alias}.classification IN (${placeholders})`,
    params: allowed,
  };
}

// ---- leads -----------------------------------------------------------------
export async function listLeads(req, { limit = 500, status, contactId } = {}) {
  const tenantId = req.tenant.id;
  const userId   = req.user?.sub ?? null;
  const isGlobal = callerHasGlobal(req);
  const params = [tenantId];
  let where = `l.tenant_id = $1`;

  // S7C — customer portal contact-id join. When a contact_id is supplied AND
  // the lead is linked to that contact via sales.contact_lead OR
  // sales.lead.primary_contact_id, treat the caller as having visibility for
  // that lead regardless of the sales.assignment graph. This is how customer
  // portal users see their own lead without an explicit assignment row.
  if (contactId) {
    params.push(contactId);
    const cp = `$${params.length}`;
    if (!isGlobal) {
      // The contact-id branch fully replaces the assignment EXISTS clause: a
      // contact-id match is the customer's own row by definition.
      where += `
        AND (
          l.primary_contact_id = ${cp}::uuid
          OR EXISTS (
            SELECT 1 FROM sales.contact_lead cl
             WHERE cl.tenant_id  = l.tenant_id
               AND cl.contact_id = ${cp}::uuid
               AND cl.lead_id    = l.id
          )
        )`;
    } else {
      where += `
        AND (
          l.primary_contact_id = ${cp}::uuid
          OR EXISTS (
            SELECT 1 FROM sales.contact_lead cl
             WHERE cl.tenant_id  = l.tenant_id
               AND cl.contact_id = ${cp}::uuid
               AND cl.lead_id    = l.id
          )
        )`;
    }
  } else if (!isGlobal) {
    if (!userId) return [];
    params.push(userId);
    where += `
      AND EXISTS (
        SELECT 1 FROM sales.assignment a
         WHERE a.tenant_id   = l.tenant_id
           AND a.entity_kind = 'lead'
           AND a.entity_id   = l.id
           AND a.user_id     = $${params.length}
           AND a.released_at IS NULL
      )`;
  }

  if (status) { params.push(status); where += ` AND l.status = $${params.length}`; }

  // Sprint 5B clearance filter (app-layer enforcement; RLS is advisory).
  const cl = clearanceWhere(req, 'l', params.length + 1);
  if (cl.sql) { where += ` AND ${cl.sql}`; params.push(...cl.params); }

  const sql = `
    SELECT ${LEAD_COLS}
      FROM sales.lead l
     WHERE ${where}
     ORDER BY l.created_at DESC
     LIMIT ${Math.min(Number(limit) || 500, 1000)}
  `;
  const { rows } = await q(sql, params);
  return await applyFieldMask(req, 'lead', rows);
}

export async function getLeadById(req, id) {
  const tenantId = req.tenant.id;
  const userId   = req.user?.sub ?? null;
  const isGlobal = callerHasGlobal(req);
  const params = [tenantId, id];
  let where = `l.tenant_id = $1 AND l.id = $2`;
  if (!isGlobal) {
    if (!userId) return null;
    params.push(userId);
    where += `
      AND EXISTS (
        SELECT 1 FROM sales.assignment a
         WHERE a.tenant_id   = l.tenant_id
           AND a.entity_kind = 'lead'
           AND a.entity_id   = l.id
           AND a.user_id     = $${params.length}
           AND a.released_at IS NULL
      )`;
  }
  // Sprint 5B clearance filter.
  const cl = clearanceWhere(req, 'l', params.length + 1);
  if (cl.sql) { where += ` AND ${cl.sql}`; params.push(...cl.params); }

  const { rows } = await q(
    `SELECT ${LEAD_COLS} FROM sales.lead l WHERE ${where} LIMIT 1`,
    params,
  );
  if (rows.length === 0) return null;
  const masked = await applyFieldMask(req, 'lead', rows);
  return masked[0];
}

// ---- assertVisible helpers (write-side) ------------------------------------
// Confirms the caller can see + therefore mutate the entity. Returns true on
// success, false on miss (caller writes 404). Used by sales/leads.update etc.
export async function assertLeadVisible(req, id) {
  const lead = await getLeadById(req, id);
  return lead != null;
}

// ---- map pins (Sprint 5A / EPIC-008 P-008) ---------------------------------
// Returns a GeoJSON FeatureCollection of leads with non-null location. Each
// feature carries the lead-level contract-progression rollup (highest-wins:
// countersigned > signed > sent > drafted > none) and the owner_id. PII
// (email/phone) is intentionally absent — the click-through endpoint owns
// that surface and emits its own audit event.
//
// Single SQL roundtrip. RBAC: data.read.global / platform.admin.all see all
// tenant rows; everyone else sees only leads they own or are assigned to via
// sales.assignment (released_at IS NULL).
export async function listMapPins(req, { bbox = null, statusIn = null, limit = 5000 } = {}) {
  const tenantId = req.tenant.id;
  const userId   = req.user?.sub ?? null;
  const isGlobal = callerHasGlobal(req);

  const params = [tenantId];
  let where = `l.tenant_id = $1 AND l.location IS NOT NULL`;

  if (!isGlobal) {
    if (!userId) return { type: 'FeatureCollection', features: [] };
    params.push(userId);
    const userParam = `$${params.length}`;
    where += `
      AND (
        l.owner_id = ${userParam}::uuid
        OR EXISTS (
          SELECT 1 FROM sales.assignment a
           WHERE a.tenant_id   = l.tenant_id
             AND a.entity_kind = 'lead'
             AND a.entity_id   = l.id
             AND a.user_id     = ${userParam}::uuid
             AND a.released_at IS NULL
        )
      )`;
  }

  if (bbox && Array.isArray(bbox) && bbox.length === 4) {
    params.push(bbox[0], bbox[1], bbox[2], bbox[3]);
    const n = params.length;
    // Cast the lead's geography to geometry for the bbox intersect. PostGIS
    // refuses to build an antipodal geography envelope (edges at ±180 lon),
    // so the planar form is the portable choice for client-supplied bboxes.
    // The GIST index on location remains useful via the && operator that
    // ST_Intersects expands to under the hood for the geometry path.
    where += ` AND ST_Intersects(
                  l.location::geometry,
                  ST_MakeEnvelope($${n - 3}, $${n - 2}, $${n - 1}, $${n}, 4326)
                )`;
  }

  // contract_status rollup: highest-progression value across the lead's
  // opportunities. We compute it as the max over an ordering CASE.
  const sql = `
    SELECT l.id                AS lead_id,
           l.name              AS name,
           l.status            AS status,
           l.owner_id          AS owner_id,
           l.assigned_at       AS assigned_at,
           ST_X(l.location::geometry) AS lon,
           ST_Y(l.location::geometry) AS lat,
           COALESCE(
             (SELECT
                CASE max(
                  CASE o.contract_status
                    WHEN 'countersigned' THEN 5
                    WHEN 'signed'        THEN 4
                    WHEN 'sent'          THEN 3
                    WHEN 'drafted'       THEN 2
                    ELSE 1
                  END
                )
                  WHEN 5 THEN 'countersigned'
                  WHEN 4 THEN 'signed'
                  WHEN 3 THEN 'sent'
                  WHEN 2 THEN 'drafted'
                  ELSE 'none'
                END
                FROM sales.opportunity o
                WHERE o.tenant_id = l.tenant_id
                  AND o.lead_id   = l.id),
             'none'
           ) AS contract_status
      FROM sales.lead l
     WHERE ${where}
     ORDER BY l.created_at DESC
     LIMIT ${Math.min(Number(limit) || 5000, 10000)}
  `;

  const { rows } = await q(sql, params);

  // Optional status filter — applied in-process so the rollup column is
  // available without a CTE wrap.
  const filtered = (Array.isArray(statusIn) && statusIn.length)
    ? rows.filter((r) => statusIn.includes(r.contract_status))
    : rows;

  const features = filtered.map((r) => ({
    type: 'Feature',
    id:   r.lead_id,
    geometry: {
      type: 'Point',
      coordinates: [Number(r.lon), Number(r.lat)],
    },
    properties: {
      lead_id:        r.lead_id,
      name:           r.name,
      status:         r.status,
      contractStatus: r.contract_status,
      owner_id:       r.owner_id,
      assigned_at:    r.assigned_at,
    },
  }));

  return { type: 'FeatureCollection', features };
}
