// =============================================================================
// billing/plans.mjs — Report.Farm subscription plan catalog.
// -----------------------------------------------------------------------------
// Plans map a stable plan_key → a Stripe Price ID supplied via env (so the same
// code works across Stripe test/live accounts without a DB change). Set:
//   STRIPE_PRICE_STARTER, STRIPE_PRICE_GROWTH  (recurring Price IDs, price_…)
// Enterprise is "contact sales" (no self-serve Price). Feature copy is farm.
// =============================================================================

export const PLANS = [
  {
    key: 'starter',
    name: 'Starter',
    priceEnv: 'STRIPE_PRICE_STARTER',
    blurb: 'For growers and landowners monitoring their first fields.',
    features: [
      'Up to 5 users',
      'Single tenant workspace',
      'Field, signal & report surfaces',
      'Free-EO monitoring cadence',
      'Email support',
    ],
    contactSales: false,
  },
  {
    key: 'growth',
    name: 'Growth',
    priceEnv: 'STRIPE_PRICE_GROWTH',
    blurb: 'For teams monitoring crop health and supplier risk across many fields.',
    features: [
      'Up to 25 users',
      'Multi-tenant control plane',
      'All role surfaces + grower portal',
      'Higher-cadence passes + live alerts',
      'Portfolio rollups & scheduled reports',
      'Priority support · 4h response',
    ],
    featured: true,
    contactSales: false,
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    priceEnv: null,
    blurb: 'For large buyers, co-ops and land portfolios with custom needs.',
    features: [
      'Unlimited users & tenants',
      'Commercial imagery & tasking on escalation',
      'Dedicated onboarding & agronomy support',
      'FMIS / ERP / GIS & weather integration',
      'Co-located or self-hosted deployment',
      'Named customer-success lead',
    ],
    contactSales: true,
  },
];

/** Stripe Price ID for a plan key (from env), or null (enterprise/contact-sales). */
export function priceIdFor(key) {
  const plan = PLANS.find((p) => p.key === key);
  if (!plan || !plan.priceEnv) return null;
  return process.env[plan.priceEnv] || null;
}

/** Reverse lookup: which plan_key a Stripe Price ID belongs to. */
export function planKeyForPrice(priceId) {
  if (!priceId) return null;
  for (const p of PLANS) {
    if (p.priceEnv && process.env[p.priceEnv] === priceId) return p.key;
  }
  return null;
}

/** Public plan catalog for the pricing/account UI (no secrets). */
export function publicPlans() {
  return PLANS.map((p) => ({
    key: p.key, name: p.name, blurb: p.blurb, features: p.features,
    featured: !!p.featured, contactSales: !!p.contactSales,
    // whether a self-serve Stripe Price is configured for this plan
    purchasable: !p.contactSales && !!priceIdFor(p.key),
  }));
}
