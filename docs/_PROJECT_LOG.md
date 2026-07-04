# Report.Farm — Project Log (findings · progress · lessons · state)

> Comprehensive session capture. **Also intended for ingestion into mempalace** (the mempalace MCP
> server was disconnected at write time — sync this doc's sections into it when it reconnects).
> Companion to the planning set `00`–`07` and the working notes `_STATUS.md` / `_RESUME_PHASE0.md`.

---

## 1. CURRENT STATE (as of this session)

**Running locally**
- `farm-postgis` :5444 (healthy) · `farm-minio` :9010/9011 (healthy) — isolated farm stack, coexists with the user's live RWR + AlphaGeoCore stacks.
- Node API :5180 — farm vertical, env-gated via `.env.local` (see lessons). Farm routes live.
- Vite dev :5275 — HMR; **local dev is ungated** (access passcode is a prod-only concern).
- App entry: `http://localhost:5275/operations.html` → dev-login `admin@demo-buyer.demo` (tenant `demo-buyer`).

**Verified working (browser + API)**
- New **theme** live across the `.crm` shell (cobalt "Orbital" accent, warm-neutral canvas, semantic risk ramp, dark "Mission Control").
- **Portfolio Dashboard** (`/operations.html`) renders with live data, 0 console errors: KPI row, supplier risk table (RiskPill), disruptions feed, monitored-farms grid, risk legend. Honest empty-states (no observations yet).
- **Farm API** proven end-to-end: dev-login → `portfolio/rollup` (Demo Buyer Co · 1 supplier · 1 region · 1 farm) → `farms` (Demo Corn Farm, Iowa, 1200 ha). Tenant-scoped, RLS-enforced.
- **Onboarding Copilot** wired + compiling (0 errors) via a URL-router (`?view=onboard`).

**Build status by surface** — see `docs/07_BLUEPRINT.md` (🟢 BUILT / 🟡 THEMED / 🟣 PLANNED).
- 🟢 Portfolio Dashboard, farm API (11 endpoints), auth flow, farm data model.
- 🟡 sales/analytics/grower/vendor/field/admin (new theme, RWR-domain shell — rewrite queued).
- 🟣 Farm Detail (in progress), Report Viewer, Alert Inbox.

---

## 2. PROGRESS BY PHASE

**P0 — Clone & foundation (DONE)**
- Cloned `D:\Projects\RWR\mvp` → `D:\Projects\FarmReport\app`; quarantined RWR leak-domain seeds to `_rwr_legacy/`; kept tenant/demo-account fixtures (099/100) the QA harness needs.
- Isolated docker stack (shifted ports), `.env.local` wiring, `--env-file` on npm scripts.
- 69 foundation migrations applied + idempotent. `qa:rls` PASS (zero cross-tenant leak). `audit:tenant` 101/101. API boots; smoke:rbac 266/314 (48 fails are inherited RWR expectation-drift, not clone damage).

**P1 — Data model + SolutionPack + design (DONE, 3 parallel lanes)**
- **Data model**: migrations `200`–`211` + `299` (18 farm tables: profile/parcel/zone/asset → scan/observation → derived-signal/alert → report/recommendation/feedback → connector/scene; supply-chain overlay supplier/region/risk/yield-at-risk/disruption + `v_*_rollup` views). RLS on all; `audit:tenant` 119/119; demo buyer/supplier/Iowa-farm seed, zero fabricated observations.
- **SolutionPack**: `packages/config/verticals/farm.yaml` (28 roles, vocab remap), `RWR_VERTICAL=farm`, role-pack regen, brand sweep. Permission strings byte-identical to the DB seed (verified).
- **Design**: `docs/design/{DESIGN_SYSTEM,tokens,SCREENS,BRAND,IMPLEMENTATION_PLAN}.md` + 4 Stitch screen renders + nano-banana brand assets in `app/public/brand/`.

**Wave 2 — Theme + functional processes + copy (IN PROGRESS)**
- ✅ Theme tokens landed into `src/crm/theme/tokens.css` (drop-in, same var names).
- ✅ Farm API routes **wired** into `api/v1/index.mjs` (Lane 2's modules existed but were never dispatched — the critical gap). `300_farm_demo_accounts.sql` added (demo-buyer logins).
- ✅ Portfolio Dashboard + RiskPill/RiskLegend + farm-types built and rendering.
- ✅ Onboarding Copilot (screen C) built by subagent + wired via FarmConsole router.
- 🔄 Farm Detail (screen B) — subagent building.
- 🔶 Copy: homepage hero/stats/audience/SEO done; JSON-LD + FAQ + marketing sub-pages pending.

---

## 3. KEY FINDINGS (architecture & integration)

1. **RWR already relays to AlphaGeo** via a harvest relay + `api/ingest-alphageo.mjs` — the farm pipeline mirrors it (add an additive `/api/farm/*` gateway router). The Gateway's `/v1/*` control plane is **flag-gated OFF by default** — do NOT build against it.
2. **RWR has a monorepo `packages/` layer** next to `mvp/` (not in the original clone plan): `config` (the vertical SolutionPack switch — `RWR_VERTICAL` selects `<id>.yaml`), `jobs`, **`outbox`** (evaluate for the D3 Postgres-outbox decision before writing a new one), `shared-types`, `ui-system`. The app hard-imports `packages/config/verticals/` at boot; it was copied into `D:\Projects\FarmReport\packages\`.
3. **The re-skin is a SolutionPack, not a string sweep** — `farm.yaml` + `RWR_VERTICAL=farm` + `gen-role-pack.mjs` regen drives vocab/roles/surfaces.
4. Farm API design is sound: PostGIS geometry validation (`ST_IsValid` → 422), server-computed hectares, RLS via `withTenantConn`, permission gates, audit logging.
5. Integration decisions locked in `docs/06_DECISIONS.md`: thin vertical; supply-chain-first wedge; Redis Streams push + Postgres outbox from day one; deployment-agnostic (`ChangeEventSource`: Redis co-located / webhook remote).

---

## 4. LESSONS LEARNED (operational — the expensive ones)

1. **Host is severely RAM-constrained** (~15.7 GB, often <1 GB free; runs a radian-weapons k8s cluster + AlphaGeoCore + RWR). `npm install` OOM-crashed repeatedly, leaving half-extracted `node_modules`; Git Bash `fork()` fails and even `Get-CimInstance` times out when thrashing. **Bring down `radian-weapons` (k8s scale-to-0) or stop GeoServers to free RAM** — WSL2 `vmmem` holds memory and releases slowly. Ask the user before stopping ANY of their services.
2. **npm OOM recovery recipe (works):** `rm -rf node_modules package-lock.json` → `npm install --package-lock-only` (registry-only) → validate lockfile has no missing versions → `npm ci`. `--prefer-offline` fails on cold cache.
3. **The app has NO dotenv** — reads `process.env` directly (defaults `rwr/rwr@5434`). Non-default DB/ports require `node --env-file=.env.local` on every script (Node 24 supports it).
4. **Three env gates or the app is unusable** (all in `.env.local`): `NODE_ENV=development`, `ALLOW_DEV_LOGIN=1` (else dev-login 404s), `SKIP_ACCESS_GATE=1` (else every API call 401s `access_gate_required`).
5. **The access-code gate blocks local dev** — the public `/access/verify` can't see the global (NULL-tenant) code under RLS, so the passcode 401s. Fixed by **ungating `vite dev`** (removed `configureServer` gate; `App.tsx` bypasses the cookie check when `import.meta.env.DEV`). The passcode is a production concern (enforced by `api/server.mjs`), not a dev one. → This was the "the code does not work" report.
6. **Subagents die to session rate limits mid-task.** Wave-2's 4 agents all failed at the limit; only the API lane's files survived — and its routes were **written but never wired into `index.mjs`**. Lesson: after a subagent dies, verify its work is actually *integrated*, not just present; recover the glue directly.
7. **Under memory thrash, prefer the browser (playwright fetch) over curl/bash** to check Vite compiles — bash times out, `fetch('/src/...tsx')` returning 200 reliably confirms a clean transform.
8. **Verify build status honestly** — "themed" ≠ "farm-native". Several console surfaces carry the new look over inherited RWR structure; the blueprint marks each truthfully.

---

## 5. OPEN ITEMS / NEXT

- **Farm Detail** (screen B) — subagent in flight; wire its `?farm=<id>` branch into `FarmConsole.tsx` + verify.
- **Copy**: finish homepage JSON-LD + FAQ; rewrite marketing sub-pages (solutions/industries/platform/company/contact — currently deferred).
- **Themed → farm-native**: rewrite sales/analytics/grower/vendor surfaces to the farm domain.
- **P2 integration**: build the `/api/farm/*` gateway router + relay (`docs/02`) and Redis Streams push (`docs/06` D3/D4); evaluate `packages/outbox` first. The gateway agent's `DIGITAL_TWIN_COPILOT_PATTERN.md` §7.5 (report.farm↔AlphaGeo contract) governs this — locate it (not found under D:\Projects\{FarmReport,alphageoserver,AlphaGeoCore}).
- **smoke:rbac**: replace water-domain expectation matrix with farm permissions.
- **mempalace**: sync sections 1–5 of this doc when the MCP server reconnects.
