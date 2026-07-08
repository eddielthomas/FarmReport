# Report.Farm — Commerce Integration Decision (Dropship, No-Inventory, Margin-Based)

**Status:** Decision-grade · **Owner:** Commerce architect · **Date:** 2026-07-08
**Scope:** How Report.Farm surfaces a supplier catalog, sells farm inputs it does not stock, and keeps a margin — with the least-effort integration into the existing Node (vanilla-http `/api/v1/*`) + React/Vite + Postgres multi-tenant app, flag-gated OFF until real credentials land.

> Sourced from the `commerce-dropship-research` workflow (21 agents: 5 engine + 9 supplier researchers, 6 adversarial verifiers, 1 synthesis). Every "commission" claim was verified to actually be a **margin/markup** model (buy wholesale → sell retail → keep the spread), which is exactly the "collect a % of the sale" the operator wants — with no marketplace split, no Stripe Connect, no affiliate links.

---

## 1. Executive summary + THE RECOMMENDATION

Report.Farm does not need a commerce *platform*. It needs a **thin selling shelf** bolted onto the app it already runs. Every full headless engine evaluated (Medusa, Saleor, Vendure) lands as a **second standalone backend service with its own database, Redis/worker topology, and — critically — no dropship supplier-feed ecosystem and no config-toggle commission**. Adopting one means operating a whole extra platform *and still hand-building* the two things that actually matter here (supplier catalog ingestion and order-to-supplier routing). That is the wrong altitude for a small, no-inventory, margin-earning storefront.

The dropship business model also collapses the "commission" problem. In a dropship margin model **Report.Farm is the merchant of record**: the customer pays Report.Farm full retail through one checkout; Report.Farm pays the supplier wholesale via the supplier's account/API; **the margin (retail − wholesale − payment fee) IS the commission** — collected automatically at checkout, with no marketplace split-payment layer, no Stripe Connect, no Mercur, no affiliate links, and no inventory.

### THE RECOMMENDATION

| Decision | Choice | One-line why |
|---|---|---|
| **Commerce engine / approach** | **Native thin build** — Stripe Checkout for payments + a `farm_catalog` table in the existing Postgres + a small supplier order-routing adapter, exposed as an import-guarded `/api/v1/commerce/*` router | Reuses the app's own Node/Postgres/React stack, reaches first sale in days not weeks, and avoids running a second backend service that *still* wouldn't ship dropship or commission out of the box. |
| **PRIMARY dropship supplier** | **Doba** | One of the few dropship networks with a genuine **order-placement API** plus lawn/garden/ag-adjacent SKUs, so paid orders can be routed and tracked automatically. |
| **FALLBACK dropship supplier** | **VG Supply** | The deepest *true* ag-input catalog (seed, fertilizer, soil amendments, soil tests); no API, so orders route manually/portal at first — acceptable at low volume and the best domain fit. |

**Bottom line:** Build a native margin-based dropship shelf on Stripe + Postgres, start with Doba for API-automated order routing, keep VG Supply as the ag-authentic fallback, and gate the whole thing behind `FARM_COMMERCE_ENABLED` + per-tenant credentials until the operator supplies real supplier and Stripe accounts. Never render a product that isn't backed by a real supplier SKU.

---

## 2. Comparison tables

### 2a. Commerce engine / approach

Scoring 1–10 weighted for THIS need (least effort, no-inventory, dropship, margin, fits existing Node/Postgres app). Higher = better fit.

| Approach | Integration ease | Commission / margin model | No-inventory fit | Ag relevance | Cost to start | **Score** |
|---|---|---|---|---|---|---|
| **Native thin build** (Stripe Checkout + Postgres catalog + supplier adapter) — **RECOMMENDED** | **Highest** — a module inside the current app; reuses app Postgres, app auth, app React; new `/api/v1/commerce/*` router only | Merchant-of-record: margin = retail − wholesale − Stripe fee, captured at checkout. No marketplace/split layer needed | **Native** — no stock objects at all; catalog rows carry wholesale + markup, always "available" | You model ag catalog exactly as you want (bags/tons/acres-of-coverage), tied to recommended actions | ~$0 infra (rides existing app) + Stripe ~2.9%+30¢/txn | **9** |
| **Shopify (hosted)** — Buy Button / Storefront API + dropship apps + Collective | Medium — embed Buy Button/Storefront API in React; but a separate hosted store to run and reconcile | You're merchant-of-record; margin is markup. Payout via Shopify Payments | Good via dropship apps (DSers/Spocket/Syncee) + Collective; disable tracking to sell without stock | Generic, but large lawn/garden/ag supplier pool via apps | $39+/mo + txn fees + app fees | **6** |
| **Medusa.js** (open-source, Node/TS) | Low for this need — **separate two-process service (server+worker) with its OWN Postgres + mandatory Redis**; does not embed in your app or reuse your tables | **No native commission**; only via **Mercur**, a full multi-vendor marketplace layer (over-build for one reseller) | Partial/DIY — `manage_inventory=false` sells without stock, but **no native dropship fulfillment** | None intrinsic; 100% modeled by you | Free (MIT) + ~$35–50/mo infra floor; no GMV fee | **4** |
| **Vendure** (open-source, Node/GraphQL) | Low for this need — standalone NestJS **Server+Worker**, own GraphQL Shop/Admin APIs, own TypeORM schema; a second co-located service | **No commission engine** — hand-coded via `OrderSellerStrategy` + Stripe-Connect analog; official example is "educational only" | Possible via Channels+Sellers, not turnkey; **no supplier feeds, no supplier order routing** | None intrinsic | Free (MIT) + infra + ops | **4** |
| **Saleor** (open-source, Python/GraphQL) | Lowest for this need — separate Python/Django + Postgres + Redis + Celery stack (5+ services); heaviest ops | **No vendor/commission entity** ("vendors are custom models"); DIY Stripe Connect + vendor portal "from scratch" | Stock tracking can be off, but **dropship/feeds not native** | None intrinsic | Self-host free but ops-heavy; **Cloud prod starts $1,599/mo** (wildly oversized) | **3** |

**Read:** the three headless engines are excellent platforms at the wrong altitude — each is a second backend that *still* leaves dropship ingestion + order routing + commission as custom code. Shopify is the only credible off-the-shelf alternative if the operator later wants a fully hosted storefront, but it adds a parallel system to reconcile. The native build wins on effort, fit, and time-to-first-sale.

### 2b. Dropship supplier

| Supplier | Integration (order routing) | Margin / payout model | No-inventory fit | Ag relevance | Cost to start | **Score** |
|---|---|---|---|---|---|---|
| **Doba** — **PRIMARY** | **API** for catalog + **order placement** + tracking sync → automatable order routing | You buy at wholesale, sell at your retail; margin is yours; you pay Doba/supplier wholesale | Pure dropship, zero stock held | Moderate — lawn/garden/outdoor/ag-adjacent categories (not deep agronomic inputs) | Paid monthly tiers (~$25–50/mo range) + wholesale cost of goods | **7** |
| **VG Supply** — **FALLBACK** | **No API** — orders placed via portal/email (manual) | Wholesale → your retail markup; you remit wholesale | Dropship/no-stock | **High** — genuine ag inputs (seed, fertilizer, amendments, soil tests) | Low/account-based | **6** |
| **Inventory Source** — alt automation | Dropship-automation aggregator; connects/normalizes many supplier feeds + routes orders (real "Retailer API") | Markup model; multi-supplier; monthly SaaS, zero per-order fee | Dropship/no-stock | Broad supplier pool incl. outdoor/garden; ag depends on connected suppliers | Paid monthly (feed/automation tiers) | **5** |
| **Shopify Collective** — network | Needs a Shopify store on **both** sides; US-only | Merchant-of-record markup | Dropship/no-stock | Generic; ag only if such suppliers are on Collective | Requires Shopify plan | **4** |

> **Verified nuance (adversarial pass):** Doba's own "Gardening & Lawn Care" category skews to hardscape/decor (raised beds, edging, rain barrels) — true agronomic inputs (seed, fertilizer, amendments, soil tests) are thin. That's exactly why **VG Supply is the ag-authentic core** and Doba is the **API-automation tail**. Neither charges a per-sale commission; revenue is the wholesale→retail spread (plus their monthly SaaS/account cost).

**Read:** Doba is the only option that makes **automated** order routing realistic at day one; VG Supply is the most *authentic* to the ag use case but manual. Start Doba-first for automation, keep VG Supply for domain-true SKUs (soil tests, amendments) that map cleanly onto Report.Farm's recommended actions. Inventory Source is the growth path if you later want many suppliers behind one normalized feed.

---

## 3. Integration architecture for Report.Farm

The commerce surface mirrors the existing additive, import-guarded router pattern (as `/api/farm/*` does for the AlphaGeo relay). It adds **one router, three tables, and one supplier adapter interface** — nothing else in the app changes.

### 3.1 How products surface in-app: recommended-action → product card

```
AlphaGeo/Report.Farm recommended action
  e.g. { type: "nitrogen_deficiency", field_id, severity, suggested_input: "N-fertilizer", coverage_acres }
        │
        ▼
Catalog resolver  (server: /api/v1/commerce/recommend)
  maps action.type / suggested_input  →  farm_catalog rows (by tag/category + unit + coverage)
  computes retail = wholesale × (1 + markup_pct)  ·  filters to tenant-enabled suppliers
        │
        ▼
React ProductCard(s)  rendered inline beneath the recommendation
  [ Product name · size/unit · retail price · "why this" tie-back to the action · Add / Buy ]
        │
        ▼
Checkout  →  Stripe Checkout Session (hosted)  →  customer pays Report.Farm full retail
```

- Product cards **only ever render from real `farm_catalog` rows** synced from a live supplier. No supplier data → no cards (never fabricate).
- The card carries provenance back to the recommendation that surfaced it, so the shelf is contextual ("apply this fertilizer to Field 3"), not a generic store.

### 3.2 How an order routes to the supplier

```
Stripe webhook: checkout.session.completed  →  /api/v1/commerce/webhooks/stripe
  1. verify signature, idempotency key
  2. INSERT farm_order (tenant_id, status='paid', retail_total, stripe_id, line items→sku)
  3. enqueue fulfillment (outbox row → app's existing transactional-outbox fan-out)
        │
        ▼
SupplierAdapter.placeOrder(order)   ← interface, one impl per supplier
  ├─ DobaAdapter      → Doba order API (wholesale PO, ship-to = farm address) → returns supplier_order_id
  └─ ManualAdapter    → (VG Supply) creates a task/PO email; status='awaiting_manual'
        │
        ▼
farm_order.status = 'ordered' ; store supplier_order_id, wholesale_total
Tracking sync (Doba API poll / webhook)  →  status 'shipped' + tracking → notify customer
```

- `SupplierAdapter` is a tiny interface (`placeOrder`, `getTracking`, `syncCatalog`) so adding Inventory Source or a second supplier later is one new class, no router changes.
- Order routing reuses the app's **existing transactional-outbox** (Decision D3) for retry/fan-out — no new queue infrastructure.

### 3.3 How commission/margin is collected & tracked

- **Collected automatically at checkout.** Customer pays retail to Report.Farm's Stripe account (Report.Farm = merchant of record). Report.Farm separately pays the supplier wholesale. No split payments, no Stripe Connect, no marketplace layer.
- **Tracked per order and per tenant** in a `commerce_ledger` row written when the order is placed:
  `margin = retail_total − wholesale_total − stripe_fee`.
- Rollups (per tenant, per supplier, per period) come from `commerce_ledger` — feeds the operator's revenue reporting and the multi-tenant metering already in the app.
- **No affiliate links anywhere** — revenue is realized margin on goods actually sold and fulfilled.

### 3.4 Where it sits in the stack

```
React/Vite app
  └─ CommerceShelf components  ← consume /api/v1/commerce/*  (same auth/session as the rest of the app)

Node vanilla-http app  (/api/v1/*)
  └─ commerce router (import-guarded)      ← mirrors the /api/farm/* additive pattern
       ├─ /recommend   (action → cards)
       ├─ /catalog     (browse/sync)
       ├─ /checkout    (create Stripe session)
       ├─ /webhooks/stripe
       └─ SupplierAdapter (Doba | Manual/VG | …)

Postgres (existing app DB — no new database)
  ├─ farm_catalog      (sku, supplier, wholesale, markup_pct, unit, ag_tags, active)
  ├─ farm_order        (tenant, status, retail_total, wholesale_total, supplier_order_id, stripe_id)
  └─ commerce_ledger   (order_id, tenant, retail, wholesale, fee, margin, period)

External: Stripe (payments) · Doba API (catalog+orders+tracking) · VG Supply (manual)
```

Note the deliberate contrast with the rejected engines: **no second service, no second Postgres, no mandatory Redis/worker, no GraphQL layer** — three tables and a router inside the app you already run.

### 3.5 The flag-gate

- **Global kill-switch:** `FARM_COMMERCE_ENABLED` (env). Default **OFF**. When unset/false, the commerce router is not mounted and no commerce UI renders.
- **Import-guarded:** router mount is wrapped so a missing supplier/Stripe SDK or missing config degrades gracefully (mirrors the `/api/farm/*` "graceful until endpoint deploys" pattern), never breaking the core app.
- **Per-tenant + credential-gated:** a tenant sees the shelf only when (a) global flag on, (b) tenant opted in, and (c) valid Stripe + supplier credentials are present. **No credentials ⇒ no catalog sync ⇒ no product cards.** This structurally prevents fabricated products.
- **Test/live isolation:** Stripe test keys and Doba sandbox until the operator explicitly promotes to live.
- **Commerce as a feature key:** in the tier system, `commerce.shop` is available to **all tiers** (Basic/Pro/Business) — commerce is a revenue channel, not a gated feature — but still only renders when the flag + credentials are present.

---

## 4. Integration plan — smallest viable path to first sale

Numbered, streamlined; each step is independently shippable behind the flag.

1. **Add the flag + guarded router skeleton.** Introduce `FARM_COMMERCE_ENABLED` (default OFF) and mount an import-guarded `/api/v1/commerce/*` router that returns 404/empty when off. No behavior change to the running app.
2. **Migrate three tables.** `farm_catalog`, `farm_order`, `commerce_ledger` in the existing Postgres. No new database, no Redis.
3. **Stand up Stripe (test mode).** Add Stripe keys to per-tenant config; implement `/checkout` (create Checkout Session) and `/webhooks/stripe` (signature-verified, idempotent). Prove a test card can pay Report.Farm.
4. **Define `SupplierAdapter` + ship `ManualAdapter` first.** Simplest possible fulfillment: on paid order, create a PO task/email (VG Supply style). This proves the *money* path end-to-end before any supplier API. First real sale is possible here.
5. **Seed the catalog from ONE real supplier.** Implement `syncCatalog` for the chosen primary. If Doba credentials are ready, build `DobaAdapter.syncCatalog`; otherwise hand-load a small **real** VG Supply SKU set (never placeholder products). Store wholesale + `markup_pct`.
6. **Wire recommended-action → product card.** Implement `/recommend` mapping action types to catalog tags; render `ProductCard` in React beneath recommendations. Retail = wholesale × (1 + markup).
7. **Implement `DobaAdapter.placeOrder` + tracking.** Automate order routing and tracking sync for the primary supplier; flip fulfilled orders to `ordered`/`shipped` and notify the customer.
8. **Write the ledger + rollups.** On order placement, write `commerce_ledger` (margin = retail − wholesale − fee); expose per-tenant/per-supplier margin rollups to the operator dashboard.
9. **Go live per tenant.** Swap Stripe + Doba to live credentials for a pilot tenant, place a real low-value order end-to-end, verify payout/margin math, then enable the flag for that tenant.
10. **Grow via the adapter interface only.** Add Inventory Source or additional suppliers as new `SupplierAdapter` classes when volume justifies — no router or schema changes.

**First sale** is reachable at **step 4–6** (Stripe + manual fulfillment + one real SKU set). API automation (step 7) is an optimization, not a blocker.

---

## 5. Risks + exactly what the operator must supply

### Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Merchant-of-record liability** — Report.Farm sells the goods, so it owns returns, chargebacks, product-quality complaints, and sales-tax collection. | Keep pilot SKUs low-value/low-risk (soil tests, small inputs). Publish clear returns/fulfillment terms. Use Stripe Tax for automated sales-tax calc. |
| **Margin squeeze** — wholesale price/shipping changes erode markup silently. | Store wholesale on every catalog row; recompute retail on each sync; alert if `markup_pct` falls below a floor. |
| **Supplier API/stock drift** — Doba item goes unavailable after checkout. | Sync availability on `syncCatalog`; on `placeOrder` failure, auto-refund via Stripe and flag the SKU; never leave a paid order un-fulfilled. |
| **Manual-fallback latency (VG Supply)** — no API means human-in-loop delays. | Surface `awaiting_manual` orders as operator tasks with SLA; reserve manual path for low volume; migrate hot SKUs to an API supplier. |
| **Fabricated-product risk** — cards shown without a real backing SKU. | Structural gate: no supplier credentials ⇒ no catalog sync ⇒ no cards. Cards render only from `farm_catalog` rows with `active=true` and a supplier_id. |
| **Ag relevance gap (Doba)** — catalog skews lawn/garden, not deep agronomic. | Use Doba for the API-automated tail; use VG Supply for the ag-authentic core SKUs tied to recommendations. |
| **Regulated inputs** — some fertilizers/chemicals have licensing/shipping restrictions. | Exclude restricted categories from the pilot catalog; add a compliance allow-list before enabling those SKUs. |

### What the operator must provide (nothing ships live without these)

1. **Supplier accounts & API credentials**
   - **Doba** (primary): active account + API key/credentials for catalog + order + tracking endpoints; sandbox first.
   - **VG Supply** (fallback): wholesale account + agreed order-placement channel (portal/email) and any ship-direct/dropship terms.
2. **Payment / payout setup**
   - **Stripe** account for Report.Farm (merchant of record): test + live keys, webhook signing secret, bank/payout details, and **Stripe Tax** enabled for sales-tax.
   - Business bank account + a funding method to **pay suppliers wholesale** (the cost side of each margin).
3. **Tax / compliance / legal**
   - Sales-tax registration / nexus determination for states where it sells.
   - Reseller/resale certificate(s) as required by suppliers.
   - Storefront legal: Terms of Sale, Returns/Refund policy, Shipping policy, Privacy — since Report.Farm is the seller of record.
   - Confirmation of any licensing needed for regulated ag inputs before those SKUs are enabled.
4. **Commercial config**
   - Default and per-category **`markup_pct`** (the margin the operator wants to keep).
   - Which tenants get the shelf first (pilot list) and the go-live approval to flip `FARM_COMMERCE_ENABLED`.

Until items 1–2 are supplied with valid credentials, the commerce module stays **flag-OFF, un-mounted, and card-free** — the app runs exactly as it does today.

---

### Appendix — why not the "obvious" engines (one line each)
- **Medusa / Vendure / Saleor:** all are excellent full commerce *platforms* that run as a **separate service with their own DB**, ship **no dropship supplier feeds and no config-toggle commission**, and would leave you building catalog ingestion + supplier routing anyway — maximum ops for minimum fit.
- **Shopify:** the only real off-the-shelf alternative; reconsider it only if the operator later wants a fully hosted, standalone storefront rather than an in-app shelf.
- **Mercur / Stripe Connect / marketplace splits:** unnecessary — dropship makes Report.Farm the merchant of record, so margin is captured in one checkout with no split-payment machinery.
- **Spocket / Syncee / Zendrop / Modalyst / AutoDS:** all verified to have **no self-serve public order API** for a headless app (they bind to Shopify/Woo/Wix connectors, or gate the API behind partner approval + fees) — poor fit for a native in-app shelf.
