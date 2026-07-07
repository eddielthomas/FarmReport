# Report.Farm Mobile — Solution Design (Index)

> **Note:** This top-level solution-design index did not exist before the completeness audit below;
> it was created to (a) host the Coverage Audit and (b) fill the structural gap that there was no
> single master doc / unified coverage matrix tying the six domain docs and four cross-cutting docs
> together. Treat the per-domain docs as authoritative for their surfaces; this file is the map + audit.

## Document set

**Domains** (`domains/`):
- `auth-roles.md` — Auth, Roles & Multi-tenancy (14 inventory features)
- `onboarding.md` — Onboarding & Find-my-farm (15 + 2 relay features)
- `twin-studio.md` — Digital Twin Studio (30 features)
- `gateway-eo.md` — Gateway EO: scan/HD-twin/signals/vision (10 features)
- `portfolio-buyers.md` — Mission Control: portfolio/buyers/suppliers/growers/analytics (19 features)
- `data-model.md` — Data model & API surface / offline DB (18 features)
- `programs-staff-admin.md` — Programs, Staff, Tenants Admin & Settings (re-derived 60-item inventory; **exceeds** the authoritative inventory)

**Cross-cutting** (`cross-cutting/`):
- `ia-navigation-design.md` — IA, navigation, design system (tokens/components)
- `offline-db.md` — Offline-first SQLite/Drizzle schema (implementation-grade)
- `sync-realtime.md` — Outbox, SSE, push (implementation-grade)
- `platform-native.md` — Native capability layer (maps/3D/camera/push/deep-links)

**Buildable artifact:** `BOLT_MEGAPROMPT.md` — the copy-paste Bolt.new scaffold (a deliberately-stubbed shell).

---

## Coverage Audit

*Audit date: 2026-07-07 · Auditor role: Completeness Critic · Method: read all 12 mobile docs + BOLT megaprompt, cross-checked each of the ~106 authoritative inventory features against a screen + user story, then reconciled the domain designs against the two implementation-grade schemas (`offline-db.md`, BOLT) that are the actual buildable deliverables.*

### Verdict

**Estimated coverage: ~96%.** Every one of the ~106 authoritative inventory features is mapped to at least one screen + one user story in a domain doc, and each domain doc carries an explicit, non-hand-wavy coverage table. The design is unusually thorough (honesty tiers, offline behavior, error taxonomy, and native-porting caveats are all first-class). The residual ~4% is a mix of (a) a missing unified master doc/matrix, (b) a handful of P1/P2 data-model entities that the domain design promises but the two implementation-grade schemas omit, (c) three internal inconsistencies where docs disagree with each other and with the shell, and (d) two of five personas landing on placeholder surfaces.

### Strengths

- **Per-domain coverage maps are real and testable** — every feature → screen + story, with priorities carried from the inventory.
- **Honesty tiers (T1/T2/T3), `RiskPill` null→Unmonitored, honest-empty copy, and the 503/502/422/404/409 error taxonomy** are encoded as first-class components (`TierBadge`, `RiskPill`, `EmptyState`, `ErrorState`) and repeated verbatim across every domain — the product's trust backbone survives the port.
- **Offline-first is designed to implementation grade** — `offline-db.md` + `sync-realtime.md` give a durable outbox with dependency-ordered replay, idempotency keys, the exact error-branch table, per-entity cursors, and the "scan job outlives the app / twins-as-source-of-truth" resume pattern.
- **Native reality is confronted honestly** — no MapLibre globe (flat fallback), no `fetch` ReadableStream (react-native-sse header injection), no DOMParser (xmldom KML), background-suspension (push is the completion guarantee), Esri tile ToS risk — all named with mitigations and server-side asks.
- **Deferred/latent features are documented as deferred, not silently dropped** (vision refine object-to-twin; `farm.asset`/connector/imagery "pending endpoint").

### Gaps (precise)

1. **No unified master solution-design doc / cross-domain coverage matrix (structural).** `00_SOLUTION_DESIGN.md` was absent; each domain self-certifies 100% but nothing reconciles across domains. Concretely, the shared **Access Gate + Login** screens are independently re-specified in `auth-roles.md` (S1/S2), `portfolio-buyers.md` (S-0/S-1), and `programs-staff-admin.md` (S1/S2) with no single owner — a divergence risk. *Where it should go: this file (now created) + a single cross-domain feature→domain matrix; designate one domain as owner of the shared gate/login screens.*

2. **`farm.recommendation` + `farm.action_feedback` (data-model feature #9, P1) have NO offline table or outbox entity anywhere in the implementation-grade docs.** `data-model.md` E4-S3/E4-S4 promise offline recommendation cards (ROI, status open/accepted/dismissed/done) and "ideal offline-queued" thumbs feedback (useful/not-useful/false-positive), but neither `offline-db.md`, `BOLT_MEGAPROMPT.md`, nor the `sync-realtime.md` outbox entity list (`farm|parcel|zone|alert|report|twin|scan_job|annotation|farm_draft`) includes them. Recommendation *display* can piggyback on `alert.recommended_actions` JSON, but the standalone entity + the feedback write have no home. *Where it should go: add `recommendation` + `action_feedback` tables to `offline-db.md` §4.2 and BOLT schema; add `feedback` to the outbox `op`/`entity` enum.*

3. **`farm.disruption_alert` (data-model E6-S4, buyer-level, P0-for-buyer) has no dedicated offline table.** It is buyer-scoped (nullable farm_id, sourcing_region_id/supplier_id, share_at_risk_pct) and distinct from farm-scoped `alert`. `data-model.md` claims it is "cached + ackable offline," but `offline-db.md`/BOLT model only the farm-scoped `alert`. Buyer-level disruptions are currently served via the farm `alert` feed (portfolio-buyers), which loses the supply-chain fields. *Where it should go: add a `disruption_alert` table (or document the decision to fold it into `alert` and drop the supply-chain fields).*

4. **Twin Routines / Yields / Treatments — three docs disagree and the shell omits the UI.** `data-model.md` (S9) and `ia-navigation-design.md` (§7.3) say **build** Routines/Yields/Treatments as twin-detail tabs; `twin-studio.md` (§7 coverage) says they are "future tabs (not built here)"; the BOLT shell ships `twin_routine/twin_yield/twin_treatment` **tables** but the `twin/[twinId]` screen has only Overview/Telemetry/Maintenance/Calendar/Docs — no UI for them. (Web parity = no UI, so severity is low, but the docs contradict each other and the buildable artifact.) *Where it should go: pick one position; if "build," add the three tabs to `twin-studio.md` §5 + BOLT twin route; if "defer," correct `data-model.md` S9 and `ia-navigation` §7.3.*

5. **`farm.asset` and `farm.scan`-history mirror tables (features #4 P1, #5 P1) are absent from both implementation-grade schemas.** `data-model.md` covers assets via the twin analog (acceptable) and scan via the client `scan_job`, but the read-mirror tables it lists in §0.1 don't exist in `offline-db.md`/BOLT. Acknowledged as "pending endpoint," so this is a documented deferral rather than an oversight, but the domain design and the schemas are out of sync. *Where it should go: either add the mirror tables or annotate `data-model.md` §0.1 that they are design-only until endpoints land (offline-db already does this for asset implicitly; make it explicit).*

6. **Two of five personas land on placeholder surfaces.** The **Vendor** (`vendor:*`, isolated to a single "Supplier" surface) and **Grower** (`customer:view`, bare full-screen map console) personas are routed to throughout every domain, but no domain doc specs the *contents* of their landing surface — both are placeholder + web-fallback (`portfolio-buyers.md` S-9). The whole app's role-routing pivots on 5 personas; 2 of them have no real screen design. Scope-justified (relabeled CRM = separate domain), but worth an explicit "Vendor/Grower mobile home is P2/web-fallback" callout so it isn't mistaken for covered. *Where it should go: a short "Vendor & Grower surfaces (deferred)" section, or a real minimal spec for each landing surface.*

7. **Priority/scope drift between the domain designs and the shell.** (a) **Analytics** (Mission Control #13) is P1 with real rollup-derived content in `portfolio-buyers.md` S-8, but BOLT ships it as a "P2 analytics placeholder." (b) **Programs / Billing (Stripe) / Cases / Registrations** are *fully* designed in `programs-staff-admin.md` (60 items, exceeding the authoritative inventory) yet BOLT stubs `crm/programs.tsx` as "Coming in a later phase" and `ia-navigation` classifies them P2. Not a coverage gap against the authoritative inventory (which only requires Programs/Staff/Tenants as P2 nav surfaces), but the ambition is inconsistent across docs. *Where it should go: reconcile priorities in `ia-navigation-design.md` §10 build order.*

### Recommendations

1. Add a single **cross-domain feature→domain→screen matrix** to this file (all ~106 inventory rows) and designate owners for the shared Access-Gate/Login/Tenant-switcher/District-switcher components (currently triple-specified).
2. Close the one true implementation gap: add `recommendation` + `action_feedback` (and decide `disruption_alert`) to `offline-db.md` and the BOLT schema, and extend the outbox `op`/`entity` enum for feedback — otherwise the P1 "thumbs feedback" and recommendation-status stories have nowhere to persist.
3. Resolve the Routines/Yields/Treatments contradiction in one edit pass across `data-model.md`, `twin-studio.md`, `ia-navigation-design.md`, and BOLT.
4. Add an explicit "deferred surfaces" callout for the **Vendor** and **Grower** personas so their placeholder status is unambiguous.
5. Reconcile the P1/P2 priority drift for **Analytics** and **Programs/Billing** between the domain docs and the BOLT/IA build order.
6. Annotate the data-model §0.1 mirror-table list to mark which tables are design-only ("pending endpoint") vs materialized in the offline schema, so the schema and the domain design stop diverging silently.
