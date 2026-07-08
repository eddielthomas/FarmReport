# Role-Based Views — Report.Farm

**One digital twin. One analytics engine. Six decision-makers, each seeing only the report bundle that keeps them from getting fired.**

Report.Farm is not a mapping tool — it is an **AI Executive Operations Center**. The same per-parcel twin (boundaries, NDVI/season curves, thermal, SAR change, drainage, disease/pest screening, forecasts) is computed **once** on the AlphaGeo gateway (`/api/farm/*`, `/api/eo/scan`, `/api/vision/*`, `/api/gis/*`) and **re-sliced** into role-specific bundles. The Grower and the Walmart buyer are looking at the *same tonnage forecast* — the Grower sees "will this field make quota," the buyer sees "will contract #4471 short my Q3 promotion." **No analytic is duplicated. Each new role is a new customer on the same substrate — that is the market-expansion thesis: one platform sells up and down the entire supply chain.**

This document maps the **358 reports** (16 families: `RF-CRP/DIS/EQP/EXE/FIN/GRO/LAB/OPS/PST/PAI/RSK/SOI/SUP/ESG/WTR/WEA-##`) onto the six roles that pay for them. It does **not** define new reports — it curates the existing library into views. Buildability and tier are inherited from each report's row in `docs/reports/categories/*.md`.

---

## The shared substrate (why one platform serves all six)

```
                         ONE DIGITAL TWIN, COMPUTED ONCE
   AlphaGeo Gateway (delegated)                Report.Farm (orchestrate + present)
   ┌──────────────────────────┐                ┌───────────────────────────────────┐
   │ gis/parcel/delineate      │                │  ~60 reusable PRIMITIVES           │
   │ eo/scan: s2_ndvi          │                │  Vegetation-Indices  Water-Model   │
   │          landsat_lst      │──── twin ─────▶│  Change-Detection    Yield-Model   │
   │          emit_minerals    │   parcel        │  Disease/Pest-Engine Financial-Mdl │
   │          lband_sar        │   stats +       │  Forecast-Engine     Risk-Engine   │
   │          stac_datacube    │   curves        │  Executive-AI-Summarizer  Alert-Eng│
   │ whitebox_terrain          │                │  Confidence-Scoring  Recommend-LLM │
   │ vision/segment            │                └──────────────┬────────────────────┘
   │ farm/signals-by-bbox      │                               │  same features, sliced by ROLE
   └──────────────────────────┘                               ▼
   ┌───────────────────────────────────────────────────────────────────────────────┐
   │ GROWER │ FARM MGR │ REGIONAL OPS DIR │ DC LEAD │ FOOD PROCESSOR │ GROCERY BUYER │
   │ 1 field  1 farm      portfolio/region   inbound    plant/throughput  supplier book│
   └───────────────────────────────────────────────────────────────────────────────┘
```

**Scope is the only thing that changes across roles** — the parcel-stat pipeline is identical. A Grower's view is filtered to `farm_id`; a Regional Director's is a `GROUP BY region`; a Buyer's is a `GROUP BY contract → supplier`. Same SQL over the same twin, different `WHERE` and different rollup grain. This is the entire reason the platform expands: **selling the buyer does not require building new analytics — only granting a new scope on twins that already exist.**

---

## Role summary

| Role | Core fear ("I get fired if…") | KPI they live/die by | Scope grain | Default tier | Primary families |
|---|---|---|---|---|---|
| **Grower** | "…my field misses yield and I don't know why until it's too late." | Yield/acre vs. field target; crop health trend | 1 field / 1 farm | **Basic** (upsell Pro) | CRP, WTR, SOI, WEA |
| **Farm Manager** | "…a block fails, a pump dies, or a crew no-shows and I missed the early signal." | Whole-farm production vs. plan; cost/acre; readiness | 1 farm (all blocks/assets/crews) | **Pro** | CRP, DIS, PST, OPS, EQP, LAB, WTR |
| **Regional Ops Director** | "…a region misses corporate quota and I have no defensible story for the CEO." | Portfolio production vs. quota; region risk exposure ($) | N farms / region rollup | **Business** | EXE, PAI, RSK, SUP, OPS, FIN |
| **Distribution-Center Lead** | "…the dock/coolers overflow or a truck arrives short and the DC clogs." | Inbound tons vs. capacity; OTIF; cold-storage fill % | Inbound lanes → DC | **Business** | SUP, OPS, EQP |
| **Food Processor (Ops Dir)** | "…the line starves or a lot arrives off-spec and we blow the pack plan." | Throughput utilization; grade mix; contract fulfillment % | Supplying fields → plant | **Business** | SUP, GRO, PAI, RSK, FIN |
| **Grocery Buyer (Walmart)** | "…a contracted farm silently slips and the shelf goes empty / a truck is rejected." | Contract fulfillment %; OTIF; shelf-life-on-arrival; audit readiness | Supplier/contract book (multi-farm) | **Business** | GRO, SUP, RSK, ESG, PAI |

Buildability legend (inherited per report): **LIVE** composes gateway endpoints today · **GW-LIFTING** capability surfacing soon · **NEW-MODEL** needs a model to be added · **EXT-DATA** needs an external feed. Confidence: **T1** deterministic · **T2** relative/screening · **T3** model-inferred estimate. Disease/pest are **screening corroborators, never diagnoses.**

---

## 1. GROWER

> *"I farm one place. Tell me if my crop is healthy, if I'm about to lose yield, and what to do this week — in plain language, on my phone."*

- **Core fear:** The field underperforms and the first hard signal is the weigh-ticket at harvest — too late to act. Loses the lease/contract if yield slips two seasons running.
- **KPI they live/die by:** **Yield per acre vs. field target**, backed by the current crop-health (NDVI) trend line.
- **Subscription tier:** **BASIC** (grower essentials). Natural upsell to **PRO** the first time a stress zone or drainage problem appears.

**Report bundle (curated from CRP / WTR / SOI / WEA):**

| Report (family ID) | What it answers for the Grower | Tier | Buildability |
|---|---|---|---|
| Current NDVI / AgriScan readout (`RF-CRP-01`) | "Is my crop healthy right now?" | Basic | **LIVE** (`eo/scan s2_ndvi`) |
| Field boundary + acreage (`RF-CRP` boundary; `gis/parcel/delineate`) | "What exactly am I looking at?" | Basic | **LIVE** |
| Season NDVI curve vs. prior year (`RF-CRP` phenology, `stac_datacube`) | "Am I ahead or behind normal?" | Basic→Pro | **LIVE** |
| Crop stress zones (`RF-CRP` stress, `RF-WTR` water-stress) | "Where's the problem patch?" | Pro | **LIVE** (index screening) |
| Drainage / water-pooling (`RF-WTR`, `whitebox_terrain`) | "Where does water sit and rot my roots?" | Pro | **LIVE** (T1 terrain) |
| Local weather / frost & heat outlook (`RF-WEA-01/02`) | "Should I irrigate or protect tonight?" | Pro | **EXT-DATA** (NOAA/ECMWF) |
| Disease/pest **screening** flag (`RF-DIS`, `RF-PST` corroborator) | "Should I go scout this block?" (never a diagnosis) | Pro | **NEW-MODEL** (ViT screen) |

**Default dashboard — "My Field Today":** one hero tile (current NDVI + traffic-light health), the season curve vs. last year, a single "This Week" recommendation card (Recommendation-LLM), and a stress/drainage mini-map. Everything answers *"is my crop OK, and what do I do?"* — no portfolio, no dollars-at-corporate-scale.

**Alert thresholds (push to phone):**
- NDVI drop **> 15%** week-over-week in any zone → "Scout block now."
- New stress zone **> 0.5 ac** appears → screening alert.
- Frost/heat event forecast within **48 h** → protect/irrigate prompt.
- Standing-water zone detected post-rain (drainage) → root-rot risk nudge.

---

## 2. FARM MANAGER

> *"I run the whole farm — every block, pump, and crew. I need the early signal before a problem becomes a quota miss, and I need it ranked so I know what to fix first."*

- **Core fear:** A block quietly fails, a pump dies mid-irrigation, or a harvest crew no-shows — and the manager missed the early signal, so the farm misses its production plan and the owner asks why.
- **KPI they live/die by:** **Whole-farm production vs. plan**, plus **cost/acre** and **operational readiness** (assets + labor ready when needed).
- **Subscription tier:** **PRO** (full analysis, alerts, season curves, drainage, stress, scheduled reports).

**Report bundle (CRP / DIS / PST / OPS / EQP / LAB / WTR / SOI):**

| Report (family ID) | What it answers for the Manager | Tier | Buildability |
|---|---|---|---|
| Whole-farm health rollup (`RF-CRP` farm-level) | "Which of my blocks are trending wrong?" | Pro | **LIVE** |
| Field-by-field stress ranking (`RF-CRP`, `RF-WTR`) | "What do I fix first this week?" | Pro | **LIVE** |
| Disease screening + spread watch (`RF-DIS-01..`) | "Where do I send scouts / spray crew?" | Pro | **NEW-MODEL** (ViT screen) |
| Pest pressure screening (`RF-PST-01..`) | "Is pressure building anywhere?" | Pro | **NEW-MODEL** / GW-LIFTING |
| Irrigation & water-stress plan (`RF-WTR`, GW-LIFTING NDMI/soil-moisture) | "Where and when do I water?" | Pro | **LIVE** → **GW-LIFTING** |
| Operations readiness / task board (`RF-OPS-01..`) | "Is the farm ready for the next operation?" | Pro | **LIVE** + **EXT-DATA** |
| Equipment/pump status (`RF-EQP-01..`) | "What's about to break?" | Pro | **EXT-DATA** (telemetry) |
| Labor / crew planning (`RF-LAB-01..`) | "Do I have the crews I need, when?" | Pro | **EXT-DATA** (HR) |
| Soil / nutrient screening (`RF-SOI`, `emit_minerals`) | "Any nutrient/soil red flags?" | Pro | **LIVE** (T2/T3) |

**Default dashboard — "Farm Command":** farm-wide health heatmap (all blocks), a **ranked action list** ("Fix first" — Risk-Engine + Recommendation-LLM), readiness strip (equipment · water · labor status lights), and a production-vs-plan gauge. This is the operator's morning cockpit.

**Alert thresholds:**
- Any block NDVI **> 15%** below its own trend or **> 20%** below neighbor blocks → investigate.
- Disease **or** pest screening confidence crosses medium → dispatch scout (screening language, not diagnosis).
- Irrigation zone soil-moisture / NDMI below action band → schedule watering.
- Equipment telemetry fault or predicted-failure flag → maintenance ticket.
- Crew coverage gap vs. upcoming operation → labor re-plan.

---

## 3. REGIONAL OPERATIONS DIRECTOR

> *"I own a region for Dole/Del Monte/Chiquita/Driscoll's. Corporate gave me a number. On Monday I have to tell the CEO whether we hit it, what threatens it, and what it's worth in dollars — with a defensible story."*

- **Core fear:** A region misses corporate quota and the Director has **no defensible narrative** — blindsided by a farm, a heat event, or a disease outbreak they had no portfolio visibility into. This is the person the positioning is built for: **they get fired when the farm misses quota.**
- **KPI they live/die by:** **Portfolio production vs. corporate quota**, plus **region risk exposure in $** (what could still go wrong, priced).
- **Subscription tier:** **BUSINESS** (portfolio rollups, predictive, all-weather SAR, compliance, API).

**Report bundle (EXE / PAI / RSK / SUP / OPS / FIN — the board-grade layer):**

| Report (family ID) | What it answers for the Director | Tier | Buildability |
|---|---|---|---|
| Executive production-vs-quota narrative (`RF-EXE-01..`) | "Will we hit the number, and what's the story?" | Business | **LIVE** compose + **NEW-MODEL** (Yield) |
| Portfolio health rollup (`RF-EXE`, `RF-OPS`) | "Which farms are dragging the region?" | Business | **LIVE** |
| Predictive yield / harvest forecast (`RF-PAI`, `RF-SUP-01/03`) | "How many tons are actually coming?" | Business | **NEW-MODEL** (XGBoost+Transformer) |
| Risk & insurance exposure ($) (`RF-RSK-01..`) | "What could still cost us millions?" | Business | **LIVE** screen + **EXT-DATA** |
| All-weather change / disruption watch (`RF-RSK`, `lband_sar`) | "Did a storm/flood hit a farm I can't see optically?" | Business | **LIVE** (SAR) |
| Supply/commitment coverage (`RF-SUP-15/16`) | "Can the region cover every corporate commit?" | Business | **EXT-DATA** |
| Financial trajectory / margin (`RF-FIN-01..`) | "What's revenue/profit tracking to?" | Business | **EXT-DATA** (market/ERP) |
| Weekly board briefing (Executive-AI-Summarizer) | "What do I tell the CEO Monday?" | Business | **LIVE** (LLM over above) |

**Default dashboard — "Region → Quota":** top strip is a **production-vs-quota bar per farm** (green/amber/red) rolling to one regional number; a **$-at-risk** panel (Risk-Engine, ranked by farm and cause); a forecast fan chart (tons, with confidence band); and a one-click **"Monday Board Brief" PDF** (Executive-AI-Summarizer) that writes the narrative — slipped shipment, dropped yield, mitigation. **Nothing is a map; everything is a decision priced in dollars.**

**Alert thresholds:**
- Any farm's forecast tonnage drops **> X%** below its quota-share commit band → quota-risk alert with $ impact.
- Region aggregate forecast crosses below **95%** of corporate quota → escalate.
- SAR change or heat/flood event on any farm above severity threshold → disruption alert.
- Risk exposure ($) crosses insurance/retention threshold → finance + risk notify.

---

## 4. DISTRIBUTION-CENTER LEAD

> *"Product is coming at me. I need to know how many tons, on which day, whether my coolers and docks can take it, and whether any truck is going to arrive short."*

- **Core fear:** The DC **clogs** — coolers overflow, docks back up, or an inbound truck arrives short/late and the downstream stores go empty. The DC lead owns the choke point.
- **KPI they live/die by:** **Inbound tons vs. DC capacity**, **OTIF** (on-time-in-full inbound), and **cold-storage fill %**.
- **Subscription tier:** **BUSINESS** (portfolio inbound rollups + predictive + capacity).

**Report bundle (SUP / OPS / EQP — inbound-logistics slice):**

| Report (family ID) | What it answers for the DC Lead | Tier | Buildability |
|---|---|---|---|
| Expected weekly production inbound (`RF-SUP-03`) | "What lands at my DC next week?" | Business | **NEW-MODEL** |
| Shipment forecast / loads-by-day (`RF-SUP-04`) | "How many loads, and when?" | Business | **EXT-DATA** (TMS) |
| Cold-storage requirement vs. capacity (`RF-SUP-06`) | "Will the coolers overflow or sit empty?" | Business | **EXT-DATA** |
| Truck scheduling vs. fleet (`RF-SUP-07`) | "Do I have trucks on the right days?" | Business | **EXT-DATA** |
| Distribution bottleneck rank (`RF-SUP-14`) | "Where does the pipe clog before it clogs?" | Business | **EXT-DATA** (GNN fusion) |
| Delivery confidence / inbound OTIF (`RF-SUP-17`) | "How sure is each inbound load on time?" | Business | **EXT-DATA** (Bayesian) |
| Shelf-life on arrival (`RF-SUP-18`) | "How many days of life walk in the door?" | Business | **NEW-MODEL** |
| DC ops readiness / dock plan (`RF-OPS`) | "Are docks and crews staged?" | Business | **LIVE** + **EXT-DATA** |
| Cold-chain equipment status (`RF-EQP`) | "Are the coolers/reefers healthy?" | Business | **EXT-DATA** |

**Default dashboard — "Inbound Control":** a **7-day inbound calendar** (tons + loads/day) laid against a **capacity line** (cooler slots, dock throughput) with overflow days flashing; an OTIF probability column per inbound PO; a bottleneck rank strip; and a cold-storage fill gauge. The whole screen answers *"can my DC physically absorb what's coming?"*

**Alert thresholds:**
- Projected inbound tons for any day **> 95%** of dock/cooler capacity → overflow alert.
- Cold-storage projected fill crosses capacity band → re-route/expedite prompt.
- Inbound OTIF probability drops below **SLA** for any PO → chase load.
- Truck demand exceeds booked fleet on any day → scheduling gap alert.

---

## 5. FOOD PROCESSOR (Plant Operations Director — Cargill / Tyson / JBS / Del Monte plant)

> *"My line has to run. If it starves, I burn fixed cost; if a lot arrives off-spec, I blow the pack plan and miss the customer contract. I need to see supply and quality before it reaches my gate."*

- **Core fear:** The **line starves** (inbound gap → idle throughput → burned margin) **or** a lot arrives **off-spec** and wrecks the grade/pack plan, so a downstream contract (often Walmart) is missed.
- **KPI they live/die by:** **Plant throughput utilization**, **grade mix vs. spec**, and **contract fulfillment %**.
- **Subscription tier:** **BUSINESS** (supplier-portfolio + predictive + compliance + API into ERP/MES).

**Report bundle (SUP / GRO / PAI / RSK / FIN — supply→plant slice):**

| Report (family ID) | What it answers for the Processor | Tier | Buildability |
|---|---|---|---|
| Expected weekly production (`RF-SUP-03`) | "Will the line be fed next week?" | Business | **NEW-MODEL** |
| Processing-capacity vs. inbound (`RF-SUP-13`) | "Can the line handle the peak / avoid starving?" | Business | **EXT-DATA** |
| Quality & grade prediction (`RF-SUP-09/10`) | "What Grade A/B/C mix hits my intake?" | Business | **NEW-MODEL** |
| Ripeness / harvest timing (`RF-SUP-19`) | "When is each supplier field actually ready?" | Business | **NEW-MODEL** |
| Contract fulfillment & penalty $ (`RF-SUP-16`, `RF-FIN`) | "Am I tracking to every downstream contract?" | Business | **EXT-DATA** |
| Food-waste / reject prediction (`RF-SUP-20`) | "How much do I lose to spoil/reject?" | Business | **NEW-MODEL** |
| Supplier disruption / all-weather risk (`RF-RSK`, `lband_sar`) | "Did a supplier region just get hit?" | Business | **LIVE** (SAR) |
| Compliance / traceability evidence (`RF-GRO`) | "Can I document every lot for audit?" | Business | **LIVE** + **EXT-DATA** |
| Yield/volume forecast per supplier (`RF-PAI`) | "Which suppliers cover the intake plan?" | Business | **NEW-MODEL** |

**Default dashboard — "Line Feed & Spec":** a **throughput-utilization gauge** (inbound vs. plant capacity, next 4–8 weeks); a **grade-mix forecast bar** against contract spec floors; a supplier-fulfillment table (commit vs. projected, penalty $ exposure); and a supplier-disruption risk strip. Answers *"will the line run, and will what it runs be in-spec?"*

**Alert thresholds:**
- Projected inbound below line-throughput plan (**starve risk**) → expedite/source alert.
- Predicted Grade-A share below contract floor → quality escalation.
- Supplier field disruption (SAR/heat/disease screen) above threshold → sourcing risk.
- Contract fulfillment projected below commit + penalty trip → finance + procurement notify.

---

## 6. GROCERY-CHAIN SUPPLY BUYER (Walmart / Kroger / Costco / Sysco)

> *"I own a book of contracted growers I've never set foot on. My fear isn't agronomy — it's the empty shelf, the rejected truck, and the CEO asking why the promotion ran out. Show me which contracts are safe, which are at risk, and the mitigation."*

- **Core fear:** A contracted farm **silently slips** its quota, a load arrives **short on shelf life**, a disease/heat event **wipes a sourcing region** the buyer had no visibility into, or an **ESG/traceability audit** surfaces a supplier they can't document. Any one empties a shelf or rejects a truck.
- **KPI they live/die by:** **Contract fulfillment %** across the supplier book, **OTIF**, **shelf-life-on-arrival**, and **audit readiness**.
- **Subscription tier:** **BUSINESS** (buyer-side portfolio watchtower + compliance/MRV + API). This role is the **market-expansion apex** — it pays for the *same twins* the growers already generate, at a portfolio grain.

**Report bundle (GRO / SUP / RSK / ESG / PAI — buyer watchtower):**

| Report (family ID) | What it answers for the Buyer | Tier | Buildability |
|---|---|---|---|
| Contract fulfillment forecast (`RF-GRO-01..`, `RF-SUP-16`) | "Which contracts are safe vs. at risk?" | Business | **NEW-MODEL** + **EXT-DATA** |
| Portfolio harvest / supply forecast (`RF-SUP-01/03`, `RF-PAI`) | "How much is actually coming across all suppliers?" | Business | **NEW-MODEL** |
| Quality & grade prediction (`RF-SUP-09/10`) | "What grade does the DC actually see?" | Business | **NEW-MODEL** |
| Shelf-life on arrival (`RF-SUP-18`, `RF-GRO`) | "Will berries arrive with the planogram's shelf life?" | Business | **NEW-MODEL** |
| Delivery confidence / OTIF (`RF-SUP-17`) | "Will each contracted load land on time, in full?" | Business | **EXT-DATA** |
| Sourcing-region disruption watch (`RF-RSK`, `lband_sar`) | "Did a region I source from just get hit — even under cloud?" | Business | **LIVE** (all-weather SAR) |
| Replacement-supplier options (`RF-GRO`, Recommendation-LLM) | "If a farm fails, who can cover?" | Business | **NEW-MODEL** + **EXT-DATA** |
| ESG / traceability audit evidence (`RF-ESG`, `RF-GRO`) | "Can I document every supplier for audit?" | Business | **LIVE** (Carbon-Engine) + **EXT-DATA** |
| Category-review portfolio brief (Executive-AI-Summarizer) | "What do I bring to Monday's category review?" | Business | **LIVE** (LLM) |

**Default dashboard — "Supplier Watchtower":** a **portfolio grid** of contracted growers (fulfillment %, OTIF, shelf-life, risk — each a green/amber/red cell); a **map-free risk ranking** of at-risk contracts with $ and mitigation; a sourcing-region disruption banner (SAR-backed, works under cloud); and an **audit-ready evidence** panel per supplier. The buyer walks into category review already knowing *which contracts are safe, which are at risk, and the mitigation* — exactly the promised outcome.

**Alert thresholds:**
- Any contract's projected fulfillment below floor (+ penalty trip) → at-risk contract alert with replacement options.
- Shelf-life-on-arrival projected below planogram window → reject-risk / expedite alert.
- OTIF probability below SLA on any contracted load → chase + backfill.
- Sourcing-region disruption (SAR/heat/disease screen) above severity → region-wipe early warning.
- Missing/expiring traceability or ESG evidence on any active supplier → audit-gap alert.

---

## The market-expansion thesis (why this is one product, not six)

1. **Compute once, sell six times.** The twin — boundaries, NDVI curves, thermal, SAR change, drainage, forecasts, disease/pest screens — is produced by the gateway a single time per parcel. Every role above is a **projection** of that same feature set at a different scope (`field → farm → region → lane → plant → contract`). Adding the Walmart buyer added **zero new analytics** — only a new rollup grain and a new `WHERE` over twins the growers already generate.

2. **The supply chain funds its own visibility.** The Grower pays Basic to see one field. That same field's tonnage/grade/shelf-life forecast is exactly what the Processor and Buyer pay Business to see aggregated. **The data a grower generates for himself is the data his buyer will pay far more to monitor** — the platform monetizes the *same twin* at every tier of the chain.

3. **One narrative engine, many audiences.** `Executive-AI-Summarizer` + `Recommendation-LLM` + `Risk-Engine` re-voice identical underlying numbers into "scout this block" (Grower), "fix first" (Manager), "tell the CEO" (Director), "absorb the inbound" (DC), "feed the line" (Processor), and "protect the shelf" (Buyer). **Same math, role-specific fear answered.**

4. **Honesty scales with the buyer.** T1/T2/T3 confidence and the screening-not-diagnosis discipline travel with every report into every role — the buyer's audit view inherits the same provenance the grower saw, so the platform never over-claims up the chain.

**Net:** six roles, one digital twin, ~60 primitives, 358 reports — no duplicated analytics. Each role added is pure margin on infrastructure that already exists. That is the expansion engine.

---

### Cross-references
- Report definitions, buildability, and tiers per report: `docs/reports/categories/*.md`
- Personas & shared pipelines: `executive.md`, `supply-chain.md`, `grocery-compliance.md`
- Data model / scope grain: `docs/03_DATA_MODEL.md` · Decisions (wedge = buyers): `docs/06_DECISIONS.md` (D2)
- Gateway capability surface: `docs/02_ALPHAGEO_INTEGRATION.md`, `docs/11_FARM_RELAY_ROUTER_SPEC.md`
