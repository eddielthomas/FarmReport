# AI Models, Explainability & Confidence/Alert Framework — Report.Farm Report Layer

**Status:** Framework spec (the contract every one of the ~358 report recipes in `docs/reports/categories/*` must honor).
**Positioning:** Report.Farm is **not a mapping tool** — it is an **AI Executive Operations Center that sells job security**. Every report must close on a decision-maker's fear: *"Will I hit the production target? Will Walmart reject this shipment? Will disease / irrigation / labor cost us millions? What do I tell the CEO Monday?"* The reader is the person who gets **fired** when the farm misses quota — the Operations Director at Dole / Del Monte / Chiquita / Driscoll's / Cargill / Tyson / JBS, a regional farm manager, a DC lead, or a Walmart supply buyer.

**Architecture reality (do not re-derive — see `docs/02_ALPHAGEO_INTEGRATION.md`, `docs/11_FARM_RELAY_ROUTER_SPEC.md`):** Report.Farm is a **thin vertical**. It **orchestrates and presents**; the **AlphaGeo gateway computes** the EO/ML. We call `/api/farm/*`, `/api/eo/scan`, `/api/vision/*`, `/api/gis/*`. No report may claim a capability the gateway does not expose — every recipe carries a **Buildability** tag so the roadmap stays honest.

---

## 0. Honesty discipline — the tier ladder (governs every number we print)

Every quantitative claim in every report is stamped with the **strongest** tier it can defend. Tiers are a promise to the reader about *how much to trust the number*, and they cap Confidence (§3).

| Tier | Meaning | What it may claim | What it may NEVER claim | Confidence ceiling |
|---|---|---|---|---|
| **T1** | **Deterministic** — computed from a physical/geometric algorithm on observed pixels/geometry | "This is measured/derived": area (ha), TWI drainage index, NDVI value on a date, elevation, per-date season curve | Nothing beyond what the math yields | 100% (data-quality-limited only) |
| **T2** | **Relative / screening** — a ranked or thresholded signal, valid *comparatively* not absolutely | "This block is anomalous vs its own history / vs its neighbors", "stress present here", "change occurred" | An absolute rate, a diagnosis, a guaranteed outcome | ~85% |
| **T3** | **Model-inferred estimate** — a learned model projects a value with uncertainty | "Estimated yield P50 = X, P10–P90 = [a,b]", "projected margin", "likely spread direction" | Certainty, a regulatory fact, a diagnosis | ~75% |

**Hard rule — no diagnostic or regulatory claims.** Disease, pest, contamination, and food-safety signals are **SCREENING CORROBORATORS, never diagnoses**. Copy uses *"consistent with / screening indicates / corroborates"* — never *"this field has \<pathogen\>"*. Compliance/MRV outputs are *"evidence supporting"* a claim, never the certification itself. This is a legal and trust boundary; violating it is a P0 defect.

---

## 1. AI Models Matrix (task → model → where used → buildability)

Models live **in / behind the gateway**; Report.Farm composes their outputs. "Where used" names the report families in `docs/reports/categories/`.

| # | Task | Model (palette) | Primitive it powers | Where used (families) | Buildability |
|---|---|---|---|---|---|
| M-01 | Field / parcel boundary segmentation | **SAM2 / FastSAM** | Object-Count, (parcel geometry) | onboarding, all (parcel stats) | **LIVE** — `/api/gis/parcel/delineate`, `/api/vision/segment` |
| M-02 | Object detection & counting (machinery, animals, trees, bins, people) | **YOLO12 / RT-DETR** | Object-Count | equipment, operations, executive (asset util), labor | **LIVE** — `/api/vision/segment` (YOLO-seg + SAM2 point-prompt) |
| M-03 | Vegetation index compute (NDVI live) | deterministic raster math | Vegetation-Indices | crop-intelligence, executive, disease, pest, all | **LIVE** — `/api/eo/scan` `s2_ndvi` (T1) |
| M-04 | Extended indices (NDRE / SAVI / EVI / NDMI) | deterministic raster math | Vegetation-Indices, Water-Model | crop-intelligence, disease, water, soil | **GW-LIFTING** — gateway `index_calc` surfacing soon |
| M-05 | Thermal / land-surface temperature | Landsat LST retrieval | Water-Model (ET proxy), Disease-Engine | water, weather, disease, executive | **LIVE** — `/api/eo/scan` `landsat_lst` (T2) |
| M-06 | Split-window LST refinement | `lst_splitwindow` | Water-Model | water, weather | **GW-LIFTING** |
| M-07 | Mineral / soil-composition mapping | **EMIT** 10-mineral | Carbon-Engine, (soil composition) | soil, sustainability, executive (ESG) | **LIVE** — `/api/eo/scan` `emit_minerals` (T2) |
| M-08 | All-weather change detection | **NISAR L-band SAR** | Change-Detection | disease, operations, risk, supply-chain, executive | **LIVE** — `/api/eo/scan` `lband_sar` (T2) |
| M-09 | Terrain / drainage / water-pooling | Whitebox TWI (deterministic) | Terrain-Drainage | soil, water, disease, operations | **LIVE** — `/api/eo/scan` `whitebox_terrain` (T1) |
| M-10 | Per-date season curve (NDVI phenology) | STAC datacube time-series | Phenology-Model | crop-intelligence, predictive-ai, executive | **LIVE** — `/api/eo/scan` `stac_datacube` (T1 series) |
| M-11 | Soil moisture (radar/microwave) | **tau_omega**, SMAP adapter | Water-Model | water, soil, risk | **GW-LIFTING** |
| M-12 | Precipitation / weather grids | GPM / NOAA / ECMWF adapter | Weather-Fusion | weather, disease, pest, risk, all forecasts | **GW-LIFTING** (adapter) + **EXT-DATA** (NOAA/ECMWF feed) |
| M-13 | Canopy height / biomass | GEDI adapter | Yield-Model, Carbon-Engine | crop-intelligence, sustainability, predictive-ai | **GW-LIFTING** |
| M-14 | SAR-change specialization (flood, lodging, harvest) | SAR-change | Change-Detection | risk, operations, predictive-ai | **GW-LIFTING** |
| M-15 | Disease symptom screening | **ViT** (Symptom-Detector) | Disease-Engine | disease, crop-intelligence | **NEW-MODEL** (screening only, never Dx) |
| M-16 | Pest pressure / migration | **GNN + Temporal Transformer** (Pest-Engine) | Pest-Engine | pest, risk | **NEW-MODEL** |
| M-17 | Yield estimation | **XGBoost + Transformer** | Yield-Model | executive, predictive-ai, crop-intelligence, financial, supply-chain | **NEW-MODEL** |
| M-18 | Lodging / stand-count / crop-count | **YOLO12 + regression head** | Object-Count, Yield-Model | crop-intelligence, predictive-ai | **NEW-MODEL** |
| M-19 | Time-series forecasting (yield, water, price, risk curves) | **Chronos / TiDE / PatchTST** | Forecast-Engine | executive, predictive-ai, water, financial, weather | **GW-LIFTING** (Chronos serve) / **NEW-MODEL** where farm-tuned |
| M-20 | Weather fusion & short-horizon prediction | **Temporal Transformer** | Weather-Fusion | weather, disease, pest, risk | **NEW-MODEL** + **EXT-DATA** |
| M-21 | Multi-sensor fusion (EO + IoT + telemetry) | **GNN** | Sensor-Fusion(GNN) | executive, operations, soil, risk | **GW-LIFTING** / **NEW-MODEL** |
| M-22 | Financial impact modeling ($ per unit change) | deterministic model + XGBoost | Financial-Model | every family (the $ line) | **EXT-DATA** (ERP/market/contracts) |
| M-23 | Carbon / MRV estimation | XGBoost biomass + rules | Carbon-Engine | sustainability, executive, grocery-compliance | **GW-LIFTING** + **EXT-DATA** |
| M-24 | Executive narrative synthesis | **LLM** (Exec-Summarizer) | Executive-AI-Summarizer | every family (the top of every report) | **LIVE** (LLM present) — quality scales with inputs |
| M-25 | Ranked recommendations | **LLM** (Recommendation) | Recommendation-LLM | every family (the action list) | **LIVE** — grounded on primitive outputs |
| M-26 | Confidence estimation | **Bayesian network** | Confidence-Scoring | every family (the 0–100% badge) | **GW-LIFTING** (our orchestration layer) |
| M-27 | Scan-combo optimizer (which products to run) | `recommend_scan_combo` | (orchestration) | onboarding, all | **GW-LIFTING** |
| M-28 | Drone tasking / high-res corroboration | DroneOps | Object-Count, Disease-Engine (corroborate) | disease, pest, equipment | **GW-LIFTING** |

**Buildability legend:** `LIVE` = composes existing gateway endpoints today · `GW-LIFTING` = gateway capability surfacing soon · `NEW-MODEL` = a model we or the gateway must add · `EXT-DATA` = an external feed we must integrate. When a recipe needs several, the recipe carries the **weakest** (most-blocking) tag so nothing looks shippable that isn't.

---

## 2. Explainability Standard — the 10 blocks every report MUST carry

No report ships without all ten blocks. This is the schema that makes Report.Farm *defensible to a board* rather than a pretty map. Every block is stored structured (JSON) and rendered per surface (PDF, dashboard card, alert, API). The families in `categories/*` inherit this; they only specify *what fills each block*.

```
REPORT ENVELOPE (report.contract v1)
├─ 1. EXECUTIVE SUMMARY      — 2–4 sentences, the answer-first verdict + $ + deadline
├─ 2. SUPPORTING EVIDENCE    — the primitives/scans/sensors that back the verdict (with tier stamps)
├─ 3. CONFIDENCE (0–100%)    — score + one-line rationale + the tier band that caps it
├─ 4. WHY THIS CHANGED       — root-cause chain (driver → mechanism → observed effect)
├─ 5. HISTORICAL COMPARISON  — vs last period, vs last season, vs same-week-last-year, vs peers
├─ 6. FINANCIAL IMPACT       — $ at risk / $ upside, method + assumptions, P10–P90 range
├─ 7. RECOMMENDED ACTIONS    — ranked by ROI (impact $ ÷ cost/effort), each with owner + cost
├─ 8. ACTION DEADLINE        — the decision window; "act by <date/time>" + cost of delay/day
├─ 9. EVIDENCE TIMELINE      — dated observations that led here (scan dates, sensor events)
└─ 10. DATA-QUALITY ASSESSMENT — cloud cover, revisit gap, sensor coverage, staleness, missing feeds
```

**Block-by-block contract:**

1. **Executive Summary** — *answer-first*, plain-language, no jargon. Names the fear and resolves it: *"Section 7 yield is tracking 12% below the Walmart contract; ~$340K at risk; act by Fri to re-irrigate."* Generated by **Executive-AI-Summarizer (LLM)**, grounded strictly on the structured blocks below — the LLM may **narrate** numbers, never **invent** them.
2. **Supporting Evidence** — the exact scans/primitives/sensors used, each with its **tier stamp** and observation date. This is the audit trail: *"s2_ndvi 2026-07-05 (T1), lband_sar change 2026-06-28→07-05 (T2), soil-moisture sensor #14 (T1)."*
3. **Confidence 0–100% + rationale** — see §3. One line: *"78% — three concordant sources; capped at T3 (yield model estimate); 1 sensor stale."*
4. **Why This Changed** — the **root-cause chain**, not just a delta. Driver → mechanism → observed effect: *"14-day rainfall deficit (−40mm) → soil-moisture drawdown (sensor + tau_omega) → canopy NDVI decline in SW quarter."* Distinguishes **real change** from **artifact** (cloud, sensor drift, phenology-normal senescence).
5. **Historical Comparison** — at least one of: prior period, prior season, same-week-last-year, or **peer/portfolio benchmark**. Anchors "is this bad?" in context.
6. **Financial Impact** — the differentiator. $ at risk **and** $ upside of acting, with **method + assumptions stated** (price source, yield elasticity, area). Always a **range (P10–P90)**, never a false-precision point. Powered by **Financial-Model** (needs EXT-DATA: market/ERP/contracts; degrades to "impact unpriced — connect ERP" when absent).
7. **Recommended Actions** — **ranked by ROI** = expected $ impact ÷ (cost + effort). Each action: what, owner, cost, expected effect, confidence. Generated by **Recommendation-LLM**, grounded on primitives. Max 3–5; the top one is the *"do this first."*
8. **Action Deadline** — the decision window with a **cost-of-delay/day** so urgency is quantified, tied to phenology/weather/contract dates. Drives Alert severity (§4).
9. **Evidence Timeline** — dated sequence of observations (scan dates, sensor spikes, weather events) that produced the finding — lets the reader replay the story.
10. **Data-Quality Assessment** — honest limits: cloud cover %, days-since-last-clear-scan, sensor coverage, missing feeds, staleness. **Directly discounts Confidence** (§3). If data is too thin to defend a verdict, the report says so rather than guessing.

**Degradation rule:** a block that cannot be filled is rendered as an explicit gap (*"Financial impact unpriced — no ERP/price feed connected"*), never silently dropped and never fabricated. Missing blocks lower Confidence and are surfaced in Data-Quality.

---

## 3. Confidence Model — multi-source Bayesian weighting

Confidence is a **0–100% score** answering *"how much should the decision-maker trust this verdict?"* It is produced by **Confidence-Scoring (Bayesian network)** and is **capped by tier** (§0): a T3 verdict cannot exceed ~75% no matter how clean the data, because it is an estimate; a T1 measurement can approach 100%, limited only by data quality.

### 3.1 Inputs (the Bayesian evidence nodes)

| Node | Raises confidence | Lowers confidence |
|---|---|---|
| **Source agreement** | Multiple independent sources concur (EO + SAR + ground sensor + weather all point the same way) | Sources conflict |
| **Source count & independence** | ≥3 independent modalities | Single source |
| **Tier of weakest link** | All contributing signals T1 | Any T3 in the chain caps the whole |
| **Data recency** | Fresh scan/sensor within revisit window | Stale (past 2× expected revisit) |
| **Data quality** | Low cloud, full coverage, calibrated sensors | High cloud, gaps, drift |
| **Model calibration** | Model's historical hit-rate high on this crop/region | Out-of-distribution crop/geography |
| **Historical consistency** | Signal persists across the timeline | One-off spike (possible artifact) |

### 3.2 Computation

A source-weighted Bayesian update, not a naive average:

```
prior            = model/base rate for this signal type
per-source        = P(signal | source) weighted by source reliability × recency × quality
posterior         = Bayesian fusion of concordant/discordant sources (independence-adjusted)
tier_cap          = {T1: 1.00, T2: 0.85, T3: 0.75}  (weakest contributing tier)
dq_multiplier     = f(cloud, coverage, staleness, missing_feeds)  ∈ [0.5, 1.0]
Confidence        = round( min(posterior, tier_cap) × dq_multiplier × 100 )
```

Concordance across independent modalities is the biggest lever — this is why the palette fuses **EO + SAR + thermal + IoT + weather (GNN Sensor-Fusion)**: three weak-but-agreeing T2 signals often beat one lonely T3.

### 3.3 Tier → confidence band mapping

| Tier | Typical band | Reader guidance | UI badge |
|---|---|---|---|
| **T1** (deterministic) | **90–100%** | "Measured — act on it." | green |
| **T2** (screening) | **70–89%** | "Strong signal — corroborate before high-cost action." | amber |
| **T3** (model estimate) | **50–74%** | "Best estimate with a range — plan against P10–P90." | amber/grey |
| Any | **<50%** | "Insufficient/conflicting data — do not decide on this alone." | grey |

Confidence and its one-line rationale render in **Block 3** and gate **Alert severity** (§4): low confidence downgrades severity and adds a *"corroborate"* recommendation rather than a *"do it now."*

---

## 4. Alert Engine — spec

Alerts are how Report.Farm earns its "operations center" claim: the reader is **told before Monday**, out-of-band, on the channel they watch. Alerts ride the app's **change-event backbone** (Postgres transactional outbox + Core→app **Redis Streams push**; SSE for interactive scans — see `docs/06_DECISIONS.md` D3/D4). The engine is the **Alert-Engine** primitive; the notification path is the `ChangeEventSource` abstraction (`RedisStreamSource` co-located / signed-webhook `WebhookSource` remote — D4).

### 4.1 Trigger types

| Type | Fires when | Example |
|---|---|---|
| **Threshold** | A metric crosses an absolute or contract bound | Projected yield < contracted tonnage |
| **Anomaly** | A value deviates from its own history/peers (T2) | NDVI z-score < −2 vs same-week-last-year |
| **Change** | Change-Detection/SAR flags a step | Flood/lodging/harvest/structure change |
| **Trend / forecast** | Forecast-Engine projects a future breach | Water-use run-rate exceeds allocation by season end |
| **Deadline** | An action window is closing | Spray window closes in 48h |
| **Compliance** | An MRV/food-safety screening floor is crossed | ESG score below buyer floor (evidence, not cert) |
| **Data-quality** | A feed goes stale/dark | No clear scan in 3× revisit; sensor offline |

### 4.2 Severity (drives channel + escalation)

Severity = **f(financial impact × probability × urgency)**, gated by Confidence (§3).

| Severity | Meaning | Confidence gate | Default channel |
|---|---|---|---|
| **P1 Critical** | Quota/contract/millions at imminent risk; act within hours | ≥70% (or T1 any $) | Phone/SMS + push + email + dashboard banner |
| **P2 High** | Material $ at risk; act within days | ≥60% | Push + email + dashboard |
| **P3 Medium** | Watch item; act within the period | ≥50% | Email digest + dashboard |
| **P4 Info** | FYI / positive signal / resolved | any | Dashboard + weekly brief |

Low confidence **downgrades** severity by one band and appends a *"corroborate first"* action rather than suppressing the signal.

### 4.3 Dedup, correlation & noise control

- **Fingerprint** = hash(farm, field, trigger-type, metric, direction) — repeated firings of the same condition **update** the open alert (bump count, refresh timeline), they do not spawn new ones.
- **Suppression window** — per fingerprint, no re-notify until state materially changes or a cool-down elapses (severity-scaled: P1 short, P4 long).
- **Correlation / rollup** — sibling alerts under one root cause collapse into a single **incident** (e.g. 6 fields flagged by one rainfall deficit → one "drought stress — 6 fields" incident) so an exec sees the *cause*, not 6 pings.
- **Flap damping** — a value oscillating across a threshold must persist N observations before re-firing.
- **Hysteresis** — separate fire/clear thresholds so alerts don't chatter at the boundary.

### 4.4 Escalation

- Per-alert **ACK deadline** by severity (P1 minutes, P2 hours). Unacknowledged → escalate to the next contact in the farm's org chain (operator → manager → Ops Director).
- **Auto-resolve** when the triggering condition clears (with a P4 "resolved" note + what changed).
- Every alert links back to its **full report envelope** (§2) — the alert is the headline, the report is the defense.

### 4.5 Delivery via the change-event backbone

```
Core/gateway signal ──▶ Postgres OUTBOX (durable, transactional)
                              │
                    Alert-Engine (evaluate triggers, dedup, severity, confidence-gate)
                              │
          ┌───────────────────┴───────────────────┐
   ChangeEventSource                         In-app fan-out
   RedisStreamSource (co-located)            (dashboard, SSE live scans)
   WebhookSource (remote, signed TLS)               │
          │                                          │
   push / SMS / email ◀──────────────────────────────┘
```

Event names stay **spec-compatible** (Kafka is a later transport-only swap — D3). Background-ingest polling is **fallback/backfill only**; the app **reacts** to change events, it does not poll for them.

---

## 5. How a report is assembled (putting it together)

```
1. Orchestrate   → recommend_scan_combo picks products; call /api/eo/scan, /api/vision/*, /api/gis/*, EXT feeds
2. Compute prims → Vegetation-Indices, Water-Model, Change-Detection, ... (each emits value + TIER stamp)
3. Fuse          → Sensor-Fusion(GNN) reconciles EO + SAR + IoT + weather
4. Model         → Yield/Disease/Pest/Forecast models produce estimates + P10–P90 ranges (T3)
5. Price         → Financial-Model attaches $ at risk / upside (EXT-DATA)
6. Score         → Confidence-Scoring (Bayesian) → 0–100%, tier-capped, DQ-discounted
7. Narrate       → Executive-AI-Summarizer + Recommendation-LLM fill the 10 explainability blocks (grounded only on 1–6)
8. Alert         → Alert-Engine evaluates triggers → severity (confidence-gated) → dedup → ChangeEventSource
9. Render        → same envelope → PDF (board) / dashboard card / alert headline / API JSON
```

**Grounding invariant:** steps 7–8 may **only** reference numbers produced in 1–6. The LLM narrates and ranks; it never originates a figure, a tier, a confidence, or a dollar amount. Every printed number traces to a primitive output with a tier stamp — that traceability *is* the product.

---

## 6. Cross-references
- Report recipe matrices (per persona/family): `docs/reports/categories/*.md`
- AlphaGeo integration & live endpoints: `docs/02_ALPHAGEO_INTEGRATION.md`, `docs/11_FARM_RELAY_ROUTER_SPEC.md`
- Event backbone & deployment decisions: `docs/06_DECISIONS.md` (D3 events, D4 ChangeEventSource)
- Data model (`farm.*`): `docs/03_DATA_MODEL.md`
