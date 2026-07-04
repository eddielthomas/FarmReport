// =============================================================================
// customer/lib/scope.mjs — derive the set of crm.project ids visible to a
// customer-role caller (Sprint 14A).
// -----------------------------------------------------------------------------
// Walks:
//   req.user.email
//     -> sales.contact rows in tenant where lower(email) = lower(req.user.email)
//     -> sales.contact_lead.lead_id set for those contacts
//     -> crm.project WHERE source_lead_id IN (...) OR customer_contact_id IN (...)
//
// Returns { contact_ids: UUID[], project_ids: UUID[] }.
//
// In-process cache with 60s TTL keyed by (user_id, tenant_id). Cache is
// invalidated when the staff side creates/archives a project — for MVP we let
// it expire naturally (the carousel refresh window is 60s worst-case).
//
// isCustomerOnly(req) returns true if the caller has crm.project.read but
// none of the write/staff perms — used to gate scope enforcement.
// =============================================================================

import { q, withTenantConn } from '../../db/pool.mjs';

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // key `${userId}|${tenantId}` -> { at, contact_ids, project_ids }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Caller is treated as customer-only iff they have crm.project.read but
// NONE of the write/admin paths into the same domain. We do NOT consult
// crm.lead.read here because the legacy 'customer:view' shim expands to
// crm.lead.read (S7C carve-out) which would falsely flag the user as staff.
const STAFF_DISQUALIFIERS = [
  'platform.admin.all',
  'crm.project.write',
  'crm.scene.write',
];

export function isCustomerOnly(req) {
  const perms = req.user?.permissions;
  if (!perms) return false;
  // Caller must have project.read to be in this code path at all.
  if (!perms.has('crm.project.read')) return false;
  // If they have ANY of the staff-tier write perms, they're staff.
  for (const k of STAFF_DISQUALIFIERS) if (perms.has(k)) return false;
  // Otherwise: customer-role only.
  return true;
}

export function invalidateCustomerScope(userId) {
  if (!userId) { cache.clear(); return; }
  for (const k of cache.keys()) {
    if (k.startsWith(String(userId) + '|')) cache.delete(k);
  }
}

// Look up the project ids visible to the caller. Safe on any tenant-bound req.
// Returns { contact_ids:[], project_ids:[] } on any failure path.
export async function customerScope(req) {
  const userId = req.user?.sub ?? null;
  const tenantId = req.tenant?.id ?? null;
  const email = (req.user?.email ?? '').trim().toLowerCase();
  if (!tenantId || !UUID_RE.test(String(tenantId))) return { contact_ids: [], project_ids: [] };

  const key = `${userId ?? ''}|${tenantId}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return { contact_ids: hit.contact_ids, project_ids: hit.project_ids };
  }

  let contact_ids = [];
  let project_ids = [];

  try {
    // RLS on sales.contact / sales.contact_lead / crm.project requires the
    // app.tenant_id session var. Use withTenantConn so the queries run against
    // a connection with the correct binding (raw q() bypassed RLS in S14A and
    // silently returned 0 rows for customer-role callers).
    await withTenantConn(req, async (client) => {
      if (email) {
        const cr = await client.query(
          `SELECT id FROM sales.contact
            WHERE tenant_id = $1 AND lower(email) = $2`,
          [tenantId, email],
        );
        contact_ids = cr.rows.map((r) => r.id);
      }
      // Lead ids the customer is linked to (as a contact).
      let lead_ids = [];
      if (contact_ids.length > 0) {
        const lr = await client.query(
          `SELECT DISTINCT lead_id
             FROM sales.contact_lead
            WHERE tenant_id = $1
              AND contact_id = ANY($2::uuid[])
              AND unlinked_at IS NULL`,
          [tenantId, contact_ids],
        );
        lead_ids = lr.rows.map((r) => r.lead_id);
      }
      // Projects: either source_lead_id matches OR customer_contact_id matches.
      if (contact_ids.length > 0 || lead_ids.length > 0) {
        const pr = await client.query(
          `SELECT id FROM crm.project
            WHERE tenant_id = $1
              AND (
                ($2::uuid[] IS NOT NULL AND customer_contact_id = ANY($2::uuid[]))
                OR ($3::uuid[] IS NOT NULL AND source_lead_id = ANY($3::uuid[]))
              )`,
          [tenantId, contact_ids.length ? contact_ids : null, lead_ids.length ? lead_ids : null],
        );
        project_ids = pr.rows.map((r) => r.id);
      }
    });
  } catch (err) {
    console.error('[customer.scope] lookup_failed:', err?.message ?? err);
    return { contact_ids: [], project_ids: [] };
  }

  cache.set(key, { at: now, contact_ids, project_ids });
  return { contact_ids, project_ids };
}
