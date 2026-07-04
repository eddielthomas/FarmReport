# Report.Farm — Build Status

> Live working note. P0 ✅ · P1 wave 1 ✅ (2026-07-02) · Next: P1 wave 2 (design implementation).

## Running right now (dev)
- API :5180 (farm vertical, `.env.local` env-gated: NODE_ENV=development, ALLOW_DEV_LOGIN=1, SKIP_ACCESS_GATE=1)
- Vite :5275 · farm-postgis :5444 · farm-minio :9010/9011
- Front door: http://localhost:5275/ → access code `RWR-DEMO-2026` → dev-login `admin@demoville-a.demo`

## P1 wave 1 — three parallel lanes, all delivered

**A · Data model** — migrations 200–211+299 applied & idempotent; 18 farm tables; supply-chain overlay (supplier/sourcing-region/risk/yield-at-risk/disruption-alert) + buyer rollup views; RLS on all (qa:rls PASS); audit:tenant 119/119; RBAC seed; demo buyer/supplier/Iowa-farm seed, ZERO fabricated observations. RLS policies key on `rwr.tenant_id` (canonical GUC), rollups are invoker-rights VIEWs.

**B · SolutionPack + rebrand** — `packages/config/verticals/farm.yaml` (28 roles, 11 surfaces, vocab remap detection→observation/AOI→parcel/POI→zone, supplier_risk investigation type, satellite-default basemaps); `RWR_VERTICAL=farm`; role pack regenerated; brand.js + all 15 shell titles → Report.Farm. Permission strings byte-identical to Lane A's 211 seed (verified).

**C · Design system** — docs/design/{DESIGN_SYSTEM.md, tokens.css, SCREENS.md, BRAND.md, IMPLEMENTATION_PLAN.md} + 4 Stitch screen renders + nano-banana brand assets in app/public/brand/. Direction: "mission-control for the food supply chain" — cobalt accent, green reserved as SEMANTIC risk/vegetation ramp, WCAG AA, token names match RWR's so the swap is drop-in.

## P1 wave 2 — punch list (from docs/design/IMPLEMENTATION_PLAN.md + lane follow-ups)
1. Land tokens.css → app/src/crm/theme/tokens.css + dashboard-tokens.css mirror.
2. Wire risk-*/viz-*/font-display into styles/tailwind.css @theme (single Vite build to verify — memory-constrained box).
3. RiskPill/RiskLegend + badge risk variants (icon+label pairing is a HARD rule — adjacent ramp stops are colorblind-floor by design).
4. SupplierRiskTable + DisruptionAlertCard + KPI row → assemble Buyer Portfolio Dashboard (screen A) on the farm schema.
5. Self-host Geist; tabular-nums; verify screen A light+dark at 1440/1024/768/480.
6. Deep copy sweep the shells (RWR body copy, aria-labels, SVG <title>s — e.g. access.html:30) + farm demo-login accounts for the `demo-buyer` tenant.

## Deferred / later phases
- P2: `/api/farm/*` gateway router + relay (docs/02) + Redis Streams push (06_DECISIONS D3/D4; evaluate RWR's packages/outbox first).
- Marketing pages re-skin; smoke:rbac matrix rewrite for farm permissions (48 inherited drift failures documented in P0).
