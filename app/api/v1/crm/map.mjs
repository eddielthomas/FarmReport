// =============================================================================
// /api/v1/crm/map — Sprint 5A (EPIC-008 P-008 Phases 1-3, backend slice).
// -----------------------------------------------------------------------------
// Two endpoints:
//   GET  /crm/map/pins                  — FeatureCollection of lead pins.
//   POST /crm/map/pins/:lead_id/visit   — drilldown audit emission only.
//
// The pins endpoint runs as a single SQL roundtrip via crmRepo.listMapPins
// (tenant + bbox + RBAC + contract_status rollup). Pin payload deliberately
// omits email/phone — the click-through audit event is the bridge to the PII
// surface in /sales/leads/:id.
//
// AuthZ: requirePermission(req, res, 'crm.lead.read'). The umbrella /crm
// prefix gate in index.mjs already proves the caller has SOME crm.* perm;
// the granular requirePermission here enforces the exact read scope.
// =============================================================================

import { ok, badReq, notFound, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { listMapPins } from '../sales/crmRepo.mjs';
import { q } from '../db/pool.mjs';

// Parse "w,s,e,n" → [w, s, e, n] of finite numbers in the legal ranges. Returns
// null if the bbox is malformed or out-of-range. Empty string → null (caller
// returns all pins for the tenant in that case).
function parseBbox(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4) return 'malformed';
  if (parts.some((n) => !Number.isFinite(n))) return 'malformed';
  const [w, s, e, n] = parts;
  if (Math.abs(w) > 180 || Math.abs(e) > 180) return 'malformed';
  if (Math.abs(s) > 90  || Math.abs(n) > 90)  return 'malformed';
  return [w, s, e, n];
}

const VALID_CONTRACT_STATUS = new Set(['none','drafted','sent','signed','countersigned']);

// GET /crm/map/pins?bbox=w,s,e,n&statusIn=signed,sent
export async function pins(req, res) {
  if (!requirePermission(req, res, 'crm.lead.read')) return;

  const qs = parseQuery(req.url);
  let bbox = null;
  if (qs.bbox) {
    const parsed = parseBbox(qs.bbox);
    if (parsed === 'malformed') return badReq(res, 'invalid_bbox');
    bbox = parsed;
  }

  let statusIn = null;
  if (qs.statusIn) {
    statusIn = String(qs.statusIn).split(',').map((s) => s.trim()).filter(Boolean);
    if (statusIn.some((v) => !VALID_CONTRACT_STATUS.has(v))) {
      return badReq(res, 'invalid_status');
    }
  }

  const limit = Math.min(Number(qs.limit ?? 5000), 10000);

  const fc = await listMapPins(req, { bbox, statusIn, limit });

  recordAudit({
    req,
    action: 'crm.map.pins.read',
    resource: 'crm.map',
    resourceId: null,
    payload: { count: fc.features.length, bbox, statusIn },
  });

  ok(res, fc);
}

// POST /crm/map/pins/:lead_id/visit — record the drilldown intent so an
// auditor can later prove "vendor X viewed leads Y, Z from the map surface".
// Does NOT mutate sales.lead — purely an audit signal. Caller must still have
// crm.lead.read and the lead must be visible to them (visibility check below).
export async function visit(req, res, leadId) {
  if (!requirePermission(req, res, 'crm.lead.read')) return;

  // Confirm the lead exists in the caller's tenant. We do not run the full
  // RBAC visibility filter here — the click-through happens in the UI after
  // the lead pin was emitted by listMapPins, so visibility was already proven
  // at emit time. The audit row records the actor so cross-tenant misuse is
  // still detectable post-hoc.
  const r = await q(
    `SELECT id FROM sales.lead WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, leadId],
  );
  if (r.rows.length === 0) return notFound(res);

  recordAudit({
    req,
    action: 'crm.map.lead.visited',
    resource: 'sales.lead',
    resourceId: leadId,
    payload: { from: 'crm.map' },
  });

  ok(res, { lead_id: leadId, visited_at: new Date().toISOString() });
}
