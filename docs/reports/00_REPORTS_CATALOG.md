# Report.Farm — Master Reports & Analytics Catalog

**Status:** Canonical index for the reports + analytics layer (358 reports · 16 families · 73 shared primitives).
**Read first. Everything else in `docs/reports/` hangs off this file.**

---

## 1. The thesis — an AI Executive Operations Center, not a mapping tool

Report.Farm does **not** sell satellite imagery for farms. It sells **job security** to the person who gets **fired when the farm misses quota** — the Operations Director at Dole / Del Monte / Chiquita / Driscoll's / Cargill / Tyson / JBS, the regional farm manager, the distribution-center lead, or the grocery-chain (Walmart) supply buyer.

Every one of the 358 reports is engineered to close on a decision-maker's fear:

> *"Will I hit production targets? Will Walmart reject this shipment? Will disease / irrigation / labor cost us millions? What do I tell the CEO on Monday?"*

A map is a datapoint. A **report** is a decision: it carries a **$ impact**, a **confidence band (T1/T2/T3)**, a **"what to do about it,"** and a **drill-in** to the evidence. The product promise is singular: **you will never be blindsided, and you will always walk into the room already holding the answer and the dollar number.** That is what the subscription pays for — not pixels.

**Honesty is the moat.** Because we sell trust, every number is stamped with the strongest tier it can defend:

- **T1 = deterministic** — measured/derived from physics or geometry (area, TWI drainage, NDVI on a date, season curve).
- **T2 = relative / screening** — a ranked or thresholded signal, valid comparatively (anomaly vs. own history, stress present, change occurred).
- **T3 = model-inferred estimate** — a learned projection with an explicit uncertainty band (yield P50 + P10–P90, projected margin).

**Hard rule:** disease, pest, contamination and food-safety signals are **SCREENING CORROBORATORS, never diagnoses**; compliance/MRV outputs are **evidence supporting** a claim, never the certification itself. Violating this is a P0 defect. See `AI_MODELS_EXPLAINABILITY.md`.

---

## 2. The 16-family index (358 reports)

Each family is a recipe matrix in `docs/reports/categories/<slug>.md`. Report IDs follow `RF-<CODE>-##`.

| # | Family | Code | Reports | The fear it answers | Slug |
|---|---|---|---|---|---|
| 1 | Executive (CEO / Farm Owner) | EXE | 18 | "What's the one-page truth I tell the board — are we on target, what threatens it, what's it worth?" | [executive.md](categories/executive.md) |
| 2 | Operations | OPS | 27 | "Is the day going to run — crews, fields, work orders, bottlenecks — or blow up?" | [operations.md](categories/operations.md) |
| 3 | Crop Intelligence | CRP | 38 | "Is the crop healthy, on-stage, and going to make the tonnage?" | [crop-intelligence.md](categories/crop-intelligence.md) |
| 4 | Water Management | WTR | 22 | "Will water stress, a leak, or an allocation cap cost us the crop or a fine?" | [water.md](categories/water.md) |
| 5 | Soil Intelligence | SOI | 24 | "Is the soil going to hold the yield — moisture, nutrients, salinity, health?" | [soil.md](categories/soil.md) |
| 6 | Weather Intelligence | WEA | 19 | "Will frost / hail / heat / a closed spray window wreck the block this week?" | [weather.md](categories/weather.md) |
| 7 | Disease Intelligence | DIS | 21 | "Is disease pressure building, where, and will it jump to my clean blocks?" | [disease.md](categories/disease.md) |
| 8 | Pest Intelligence | PST | 16 | "Are pests past threshold — do I spray now, and will resistance bite me?" | [pest.md](categories/pest.md) |
| 9 | Equipment Intelligence | EQP | 23 | "Will a machine fail in the harvest window and strand the crop?" | [equipment.md](categories/equipment.md) |
| 10 | Labor Intelligence | LAB | 14 | "Will I have the crews when the fruit is ready — and is labor cost killing margin?" | [labor.md](categories/labor.md) |
| 11 | Supply Chain | SUP | 20 | "Will it ship on grade, on time, in spec — or spoil / short the load?" | [supply-chain.md](categories/supply-chain.md) |
| 12 | Grocery Chain Compliance (Walmart-as-customer) | GRO | 18 | "Will my supplier book miss quota and short the retail promotion?" | [grocery-compliance.md](categories/grocery-compliance.md) |
| 13 | Sustainability / ESG | ESG | 18 | "Can I defend the ESG / carbon / deforestation number to the bank and buyers?" | [sustainability.md](categories/sustainability.md) |
| 14 | Financial Intelligence | FIN | 26 | "Will margin, cash, and covenants survive the season?" | [financial.md](categories/financial.md) |
| 15 | Risk Management | RSK | 25 | "What is most likely to blow up the quarter — and are we insured for it?" | [risk.md](categories/risk.md) |
| 16 | Predictive AI | PAI | 29 | "What's coming in 7 / 14 / 30 days — and how much do I trust the forecast?" | [predictive-ai.md](categories/predictive-ai.md) |
| | **TOTAL** | | **358** | | |

Supporting docs (read alongside the families):
- **`PRIMITIVES_LIBRARY.md`** — the 73 reusable processing blocks (P01–P73) that all 358 reports compose, with per-primitive buildability and reuse heatmap.
- **`NEVER_GET_FIRED_DASHBOARD.md`** — the 11-section executive dashboard that surfaces the highest-value reports on one morning screen.
- **`ROLE_VIEWS.md`** — the six role bundles (Grower → Grocery Buyer) that re-slice the same twin; the "compute-once, sell-six-times" market thesis.
- **`AI_MODELS_EXPLAINABILITY.md`** — the T1/T2/T3 honesty ladder, 28-row AI Models Matrix, the 10-block Explainability Standard, the tiered Bayesian Confidence Model, and the Alert Engine spec.

---

## 3. The standard Recipe structure (12 fields)

Every report in every family is one row in a recipe matrix with these **12 columns**. A report is a *thin composition* — inputs + which primitives + a threshold + a tier — not bespoke code.

| # | Field | What it holds |
|---|---|---|
| 1 | **Recipe ID** | `RF-<CODE>-##` — stable, globally unique; the report feature-key. |
| 2 | **Report** | Human name. |
| 3 | **Fear it answers** | The decision-maker's fear, in their words. Non-negotiable — a report with no fear is a datapoint, cut it. |
| 4 | **Output / KPI** | The single decision-grade number or tile the reader acts on. |
| 5 | **Inputs (data sources)** | Gateway endpoints (`/api/eo/scan` products, `/api/gis/*`, `/api/vision/*`, `signals-by-bbox`) + any EXT feed. |
| 6 | **AI Models** | Model palette entries used (SAM2, YOLO12/RT-DETR, ViT, XGBoost+Transformer, Chronos/TiDE/PatchTST, Temporal Transformer, GNN, LLM, Bayesian). |
| 7 | **Primitives** | Named blocks from `PRIMITIVES_LIBRARY.md` — this is what makes the report composable, not siloed. |
| 8 | **Alert trigger** | The threshold/anomaly/forecast-breach that fires a push via Alert-Engine. |
| 9 | **Confidence** | T1 / T2 / T3 — the strongest tier the output can defend (caps the confidence band). |
| 10 | **Refresh** | Cadence (event-driven / daily / weekly / monthly / on-scan). |
| 11 | **Buildability** | LIVE / GW-LIFTING / NEW-MODEL / EXT-DATA — honest, inherited as the *max* of its primitives. |
| 12 | **Tier** | BASIC / PRO / BUSINESS entitlement. |

A report's **buildability = the least-available of its primitives.** A slick UI on a `Yield-Model` (NEW-MODEL) + `contracts` (EXT-DATA) recipe is still not LIVE. This keeps the roadmap honest.

---

## 4. Buildability rollup & phased build roadmap

We are a **thin vertical**: we orchestrate + present, the AlphaGeo gateway computes. A report is **LIVE** only if it composes endpoints already deployed (`/api/gis/parcel/delineate`, `/api/vision/segment`, `/api/farm/signals-by-bbox`, and `/api/eo/scan` products `s2_ndvi` · `landsat_lst` · `emit_minerals` · `lband_sar` · `whitebox_terrain` (T1) · `stac_datacube` (T1)).

**Approximate rollup across the 358 recipes** (counted from the Buildability column; bands are indicative, not audited to the unit):

| Buildability | ~Reports | Share | What it needs | Gates which tier |
|---|---|---|---|---|
| **LIVE** | ~50 | ~14% | Compose deployed gateway endpoints today | BASIC + the shippable core of PRO |
| **GW-LIFTING** | ~80 | ~22% | A gateway capability surfacing soon (`index_calc` NDRE/SAVI/EVI/NDMI, `tau_omega` soil moisture, `lst_splitwindow`, SMAP/GPM/GEDI/GRACE adapters, SAR-change, `recommend_scan_combo`, DroneOps) | PRO |
| **NEW-MODEL** | ~60 | ~17% | A model we or the gateway must add (disease ViT, pest migration, Yield XGBoost+Transformer, lodging, stand-count, ripeness/grade/shelf-life, carbon MRV) | BUSINESS |
| **EXT-DATA** | ~168 | ~47% | An external feed we must integrate (weather NOAA/ECMWF, market/commodity, equipment telemetry, labor/HR, inventory/ERP, contracts, regulatory) | BUSINESS |

> The catalog is **EXT-DATA-heavy by design.** The "sells job security" dollar frame *requires* cost ledgers, contracts and weather — those cannot be faked. The honest paywall for BUSINESS is: the feeds + models, not prettier pixels.

### The phased roadmap (ship the fear-closers first)

- **Phase 0 — the "Never Get Fired" LIVE core.** Build the 4 free-win primitives that sit on deployed endpoints and touch ~300 report-slots: **Confidence-Scoring (P72)**, **Change-Detection (P13)**, **Alert-Engine (P71)**, **Phenology-Model (P21)** — plus **Vegetation-Indices (NDVI)**, **Terrain-Drainage**, **Object-Count**. Ship the LIVE-backed dashboard sections (§1 Critical Issues, §5 Bottlenecks-from-EO, §9 Confidence) from `NEVER_GET_FIRED_DASHBOARD.md`. **This is the demo that closes the first customer.**
- **Phase 1 — PRO analysis (GW-LIFTING).** Unlock `index_calc` (full vegetation-index family), Chronos/TiDE serving (**Forecast-Engine P15**), `tau_omega`/ET (**Water-Model**), and **Sensor-Fusion (P68)**. Lights up season curves, drainage, stress, scorecards, alerts, recommendations — the full PRO tier.
- **Phase 2 — BUSINESS predictive + compliance (NEW-MODEL + EXT-DATA).** Build the keystone models — **Yield-Model (P22)** first (backbone of production/revenue/quota/fulfillment/ROI across 8 families), then **Disease/Pest-Engine (P26/P29)** with the screening guardrail baked in — and land the paid connectors (**Weather-Fusion**, **Financial-Model**, telemetry, HR, logistics, contracts). This unlocks portfolio rollups, compliance/MRV, all-weather SAR, the buyer watchtower, and the predictive family.

---

## 5. How it plugs into what we already built

**Tier entitlements + report feature-keys.** The multi-tenant SaaS shell (cloned from `D:\Projects\RWR\mvp` into `app/`) already gates features by plan. Each report's **Recipe ID is its feature-key**; the resolver is `tenant.plan ≥ report.tier`. BASIC (grower essentials — current NDVI, AgriScan readout, boundary) → PRO (full analysis + alerts + season curves + drainage + stress + reports) → BUSINESS (portfolio rollups + compliance/MRV + all-weather SAR + predictive + API). Commerce is open to all tiers. Distribution across the catalog is roughly **~10 BASIC / ~170 PRO / ~178 BUSINESS** — the value (and the models/feeds) concentrate at BUSINESS, exactly where the fear is worth millions.

**The AlphaGeo relay.** Report.Farm mirrors RWR's proven harvest relay: the additive, import-guarded **`/api/farm/*`** router on the deployed gateway delegates to AlphaGeo's scan/EO/indicator pipeline (`/api/eo/scan`, `/api/vision/*`, `/api/gis/*`, `signals-by-bbox`). We compose those outputs into primitives, primitives into reports. We build **no EO/ML** — buildability tags mark exactly where the gateway must lift a capability before a report is real.

**The change-event backbone (alerts + scheduled reports).** Reports are not just polled — they **react**. A Postgres transactional outbox fans out app-internal events, and **Core→app Redis Streams push** (co-located) or a **signed WebhookSource** (remote), via the `ChangeEventSource` abstraction, deliver change events from day one. **Alert-Engine (P71)** turns any report's alert-trigger (column 8) into an SMS/email/Slack push even when the screen is closed; the same backbone drives **scheduled report** delivery. Harvest-relay SSE animates interactive in-flight scans; background-ingest polling is fallback/backfill only. Event names stay Kafka-spec-compatible (transport-only swap later).

---

## 6. Pointers

- **Primitives** → [`PRIMITIVES_LIBRARY.md`](PRIMITIVES_LIBRARY.md) — 73 blocks, reuse heatmap, per-primitive buildability. *Top-5 most-reused: Confidence-Scoring (~150, effectively all 358) · Forecast-Engine (~109) · Financial-Model (~104) · Weather-Fusion (~97) · Vegetation-Indices (~82).*
- **The morning screen** → [`NEVER_GET_FIRED_DASHBOARD.md`](NEVER_GET_FIRED_DASHBOARD.md) — 11-section executive dashboard; ship-first LIVE sections are §1 / §5 / §9.
- **Who buys what** → [`ROLE_VIEWS.md`](ROLE_VIEWS.md) — six role bundles on one twin; "compute-once, sell-six-times."
- **Models, honesty, confidence & alerts** → [`AI_MODELS_EXPLAINABILITY.md`](AI_MODELS_EXPLAINABILITY.md) — T1/T2/T3 ladder, AI Models Matrix, 10-block Explainability Standard, Bayesian Confidence Model, Alert Engine spec.
- **Report families** → [`categories/`](categories/) — the 16 recipe matrices, 358 rows.
