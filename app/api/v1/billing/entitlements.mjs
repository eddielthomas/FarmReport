// =============================================================================
// billing/entitlements.mjs — the tier → feature map (single source of truth).
// -----------------------------------------------------------------------------
// RBAC answers "what may this ROLE do"; per-tenant flags answer "what is toggled
// for this TENANT". Neither is keyed by billing tier. This module adds the third,
// orthogonal axis: "what does this PLAN include". Both the API (to authorize
// gateway relay + report calls at the boundary) and the React app (to show / hide
// / upsell) read this one definition.
//
// Plan keys stay stable for Stripe (starter/growth/enterprise); the customer-
// facing tier labels are Basic / Pro / Business. Feature sets are CUMULATIVE:
// Pro ⊇ Basic, Business ⊇ Pro.
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { send } from '../http.mjs';

// Customer-facing tier label per stable plan key.
export const TIER_LABEL = { starter: 'Basic', growth: 'Pro', enterprise: 'Business' };

// Every gate-able feature key, with the plain-language name + the minimum tier
// that unlocks it. Keep keys namespaced and stable — the UI & API both use them.
export const FEATURES = {
  // --- Basic: onboarding + the grower hook (all live today) ---
  'onboard.autotrace':      { label: 'AI field auto-trace + boundary editor', min: 'starter' },
  'studio.twins':           { label: 'Digital twin studio', min: 'starter' },
  'studio.layers.ndvi':     { label: 'Satellite + NDVI layers', min: 'starter' },
  'agriscan.readout':       { label: 'AgriScan one-click field readout', min: 'starter' },
  'weather.current':        { label: 'Current weather', min: 'starter' },
  'commerce.shop':          { label: 'Buy inputs (dropship storefront)', min: 'starter' },
  // --- Pro: full analysis toolkit + alerts + reports ---
  'studio.layers.advanced': { label: 'Moisture / thermal / advanced index layers', min: 'growth' },
  'studio.scan.hd':         { label: 'HD digital-twin scan (on-demand EO)', min: 'growth' },
  'signals.live':           { label: 'Live EO signals overlay', min: 'growth' },
  'analysis.season_curves': { label: 'Season NDVI / phenology curves', min: 'growth' },
  'analysis.drainage':      { label: 'Water-pooling / drainage (TWI)', min: 'growth' },
  'analysis.stress':        { label: 'Crop-stress screen', min: 'growth' },
  'analysis.indices':       { label: 'Advanced spectral indices (NDRE/SAVI/NDMI…)', min: 'growth' },
  'analysis.yield':         { label: 'Yield proxy + planting/harvest windows', min: 'growth' },
  'weather.gdd':            { label: 'Growing-degree-days + spray windows', min: 'growth' },
  'alerts.threshold':       { label: 'Threshold alerts (email / push)', min: 'growth' },
  'reports.season':         { label: 'Season-to-date + field reports', min: 'growth' },
  'export.zones':           { label: 'Zone / variable-rate export (ISOXML)', min: 'growth' },
  // --- Business: portfolio monitoring, compliance, all-weather, API ---
  'analysis.sar_change':    { label: 'All-weather SAR change monitoring', min: 'enterprise' },
  'reports.compliance':     { label: 'MRV / insurance / lender-covenant reports', min: 'enterprise' },
  'portfolio.rollups':      { label: 'Buyer / supplier portfolio rollups', min: 'enterprise' },
  'benchmark.cohort':       { label: 'Region-cohort benchmarking', min: 'enterprise' },
  'api.access':             { label: 'API access + webhooks', min: 'enterprise' },
};

// Plan order (ascending). A plan includes a feature when its rank ≥ the feature's
// minimum rank — so the sets are cumulative without hand-listing each tier.
const PLAN_ORDER = ['starter', 'growth', 'enterprise'];
const rank = (key) => PLAN_ORDER.indexOf(key);

/** All feature keys a plan includes. */
export function featuresForPlan(planKey) {
  const r = rank(planKey);
  if (r < 0) return [];
  return Object.entries(FEATURES).filter(([, f]) => rank(f.min) <= r).map(([k]) => k);
}

/** Does a plan include a feature? */
export function planHasFeature(planKey, featureKey) {
  const f = FEATURES[featureKey];
  if (!f) return false; // unknown feature key → deny (fail closed on typos)
  return rank(planKey) >= rank(f.min);
}

/** Smallest tier (label) that unlocks a feature — for upsell copy. */
export function minTierForFeature(featureKey) {
  const f = FEATURES[featureKey];
  return f ? (TIER_LABEL[f.min] ?? f.min) : null;
}

// Generous default when a tenant has no active subscription — keeps demo/dev and
// existing tenants fully featured; real gating kicks in once a tenant is on a
// lower paid plan. Override with DEFAULT_PLAN=starter to fail-closed instead.
const DEFAULT_PLAN_KEY = process.env.DEFAULT_PLAN || 'enterprise';
// iam.tenant.plan is free-text (mvp|pro|enterprise) and predates the billing keys.
const LEGACY_PLAN_MAP = {
  mvp: 'starter', basic: 'starter', starter: 'starter',
  pro: 'growth', growth: 'growth',
  business: 'enterprise', enterprise: 'enterprise',
};

/** Resolve a tenant's active plan key: live subscription → tenant.plan → default. */
export async function activePlanKeyFor(req) {
  try {
    return await withTenantConn(req, async (c) => {
      const sub = await c.query(
        `SELECT plan_key, status FROM billing.subscription
          WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`, [req.tenant.id]);
      const row = sub.rows[0];
      if (row && ['active', 'trialing', 'past_due'].includes(row.status) && PLAN_ORDER.includes(row.plan_key)) {
        return row.plan_key;
      }
      const t = await c.query('SELECT plan FROM iam.tenant WHERE id = $1', [req.tenant.id]);
      const mapped = LEGACY_PLAN_MAP[(t.rows[0]?.plan ?? '').toLowerCase()];
      return mapped ?? DEFAULT_PLAN_KEY;
    });
  } catch {
    return DEFAULT_PLAN_KEY;
  }
}

/** API gate: 402 + upgrade hint when the tenant's plan lacks a feature. */
export async function requireFeature(req, res, featureKey) {
  const plan = await activePlanKeyFor(req);
  if (planHasFeature(plan, featureKey)) return true;
  send(res, 402, {
    success: false, error: 'feature_not_in_plan',
    feature: featureKey, plan, plan_label: TIER_LABEL[plan] ?? plan,
    upgrade_to: minTierForFeature(featureKey),
  });
  return false;
}
