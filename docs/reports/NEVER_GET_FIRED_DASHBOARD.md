# The "NEVER GET FIRED" Executive Dashboard — Design Spec

## What this screen is
The single screen the **Operations Director opens first, every morning, before the crews arrive.** Not a map. An **AI Executive Operations Center** whose entire job is to answer the fear that pays for the subscription:

> *"Will I hit production targets? Will Walmart reject this shipment? Will disease / irrigation / labor cost us millions? What do I tell the CEO on Monday?"*

The persona gets **fired** if the farm misses quota. So the screen is engineered around one promise: **you will never be blindsided, and you will always walk into the room already holding the answer and the dollar number.** Every tile is a decision, not a datapoint. Every tile carries a **$ impact**, a **confidence band (T1/T2/T3)**, a **"what to do about it,"** and a **drill-in** to the underlying report.

Personas served (same screen, role-scoped rollups): **Operations Director** (Dole / Del Monte / Chiquita / Driscoll's / Cargill / Tyson / JBS) · **Regional Farm Manager** · **Distribution-Center Lead** · **Grocery-Chain (Walmart) Supply Buyer**.

---

## Screen layout (top to bottom, F-pattern; red before green)
```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  HEADLINE STRIP — "Are we on track?" one sentence + traffic light + $ at risk today │
├───────────────────────────────┬──────────────────────────────────────────────────┤
│ 1 CRITICAL ISSUES (act now)   │ 2 ISSUES TRENDING CRITICAL (48–72h to act)       │
├───────────────────────────────┼──────────────────────────────────────────────────┤
│ 3 PRODUCTION AT RISK          │ 4 FINANCIAL EXPOSURE ($ at risk today)           │
├───────────────────────────────┼──────────────────────────────────────────────────┤
│ 5 OPERATIONAL BOTTLENECKS     │ 6 WEATHER IMPACTS (today + 7–14d)                │
├───────────────────────────────┴──────────────────────────────────────────────────┤
│ 7 CUSTOMER COMMITMENTS — retailer/distributor contracts on track? (wall-to-wall)   │
├────────────────────────────────────────────────────────────────────────────────────┤
│ 8 TOP 10 AI RECOMMENDATIONS — ranked by $/operational benefit (the "do this" list)  │
├───────────────────────────────┬──────────────────────────────────────────────────┤
│ 9 CONFIDENCE & EVIDENCE       │ 10 EXECUTIVE OUTLOOK (quarter on track?)         │
└───────────────────────────────┴──────────────────────────────────────────────────┘
```
**Refresh model:** Section-level cadence below. Live push via **Redis Streams (co-located) / signed webhook (remote)** through `ChangeEventSource` — the screen reacts to change events, it does not poll. Harvest-relay SSE animates in-flight scans. Every tile has a `last_updated` + `source` chip. **Alert-Engine** raises anything red to push (SMS/email/Slack) even when the screen is closed.

**Shared pipeline (whole screen):** `INPUTS (/api/eo/scan · /api/gis/parcel/delineate · /api/vision/segment · /api/farm/signals-by-bbox · EXT: weather/market/ERP/labor/contracts/telemetry)` → **PRIMITIVES** → **MODELS (Chronos/TiDE/PatchTST · XGBoost+Transformer · ViT · GNN · Bayesian · LLM)** → **Executive-AI-Summarizer + Confidence-Scoring** → **Alert-Engine** → tiles + drill-in reports.

---

## Section 1 — CRITICAL ISSUES (act before crews arrive)
**Question answered:** *"What is on fire right now that I must fix before I lose the day / the field / the shipment?"*
**What it shows:** Ranked red cards — field/facility, the failure, the $ and quota consequence, and the one action + owner. Empty state says "No critical issues — 0 fields red" (that emptiness is the product).

| Attribute | Spec |
|---|---|
| Inputs | `/api/eo/scan` s2_ndvi + lband_sar (all-weather change) + landsat_lst; `/api/vision/segment`; `/api/farm/signals-by-bbox`; EXT equipment telemetry, ERP inventory |
| Primitives | Change-Detection, Vegetation-Indices, Water-Model, Alert-Engine, Financial-Model, Executive-AI-Summarizer, Confidence-Scoring |
| Models | GNN (Sensor-Fusion), LLM (Exec-Summarizer), Bayesian (Confidence) |
| Refresh | Live (event push); full recompute 6-hourly + on new scene |
| Alert threshold | Any field crosses hard-red band: NDVI drop >X vs field baseline, SAR change >threshold, LST heat-kill, standing-water on >Y% of parcel, or equipment/telemetry fault on a harvest-critical asset |
| Confidence | T2 (screen) — EO screening corroborated by ≥2 primitives before it shows red |
| Drill-in | RF-OPS-17 High Priority Alerts · RF-OPS-02 Fields Requiring Attention · RF-OPS-26 Emergency Response · RF-CRP-17 Crop Stress · RF-WTR-06 Flood Detection · RF-EQP-08 Harvest-Fleet Readiness |
| Buildability | **LIVE** |
| Tier | PRO |

---

## Section 2 — ISSUES TRENDING CRITICAL
**Question answered:** *"What is not red yet but will be in 48–72h if I do nothing — where can I still act cheaply?"*
**What it shows:** Trajectory cards with a mini season-curve sparkline, the slope, projected cross-over date, and cost-to-fix-now vs cost-if-ignored.

| Attribute | Spec |
|---|---|
| Inputs | `/api/eo/scan` stac_datacube (per-date NDVI season curve), s2_ndvi, landsat_lst; EXT weather (NOAA/ECMWF) |
| Primitives | Change-Detection, Phenology-Model, Forecast-Engine(time-series), Weather-Fusion, Risk-Engine, Confidence-Scoring |
| Models | Chronos / TiDE / PatchTST (forecast), Temporal Transformer (weather), Bayesian (Confidence) |
| Refresh | Daily; re-forecast on each new scene or weather update |
| Alert threshold | Forecasted trajectory crosses a critical band within 72h at ≥P60; or degradation slope steeper than seasonal norm |
| Confidence | T3 (est.) — forecasted, always shown with band |
| Drill-in | RF-PAI-01 7-Day Crop Forecast · RF-CRP-33 Vegetation Change · RF-CRP-34 Growth Forecast · RF-DIS-03 Disease Spread Prediction · RF-WTR-05 Water Deficit · RF-RSK-19 Yield-Shortfall Probability |
| Buildability | **GW-LIFTING** (needs richer stac_datacube forecast surface; degrades gracefully to slope-of-last-N-scenes today) |
| Tier | PRO |

---

## Section 3 — PRODUCTION AT RISK
**Question answered:** *"Which fields / facilities threaten this week's and this month's tonnage target — and by how much?"*
**What it shows:** Projected volume vs contracted/quota volume, the gap in tons and %, per field/region, with the biggest shortfall drivers named.

| Attribute | Spec |
|---|---|
| Inputs | stac_datacube (season NDVI), s2_ndvi + landsat_lst, `/api/gis/parcel/delineate` (acreage); EXT contracts/quota, weather |
| Primitives | Yield-Model, Phenology-Model, Vegetation-Indices, Forecast-Engine, Financial-Model, Confidence-Scoring |
| Models | XGBoost+Transformer (Yield-Model), Chronos (forecast), LLM (Summarizer) |
| Refresh | Weekly; re-run on new scene or contract change |
| Alert threshold | Projected volume falls below quota band (this-week or this-month bucket) at ≥P50; any field's contribution gap widens >X tons WoW |
| Confidence | T3 (est.) — yield is model-inferred, shown as P10/P50/P90 |
| Drill-in | RF-EXE-05 Production Forecast · RF-CRP-14 Yield Estimate · RF-CRP-13 Harvest Readiness · RF-SUP-03 Expected Weekly Production · RF-GRO-01 Which Farms May Miss Quota · RF-RSK-20 Quota-Miss Probability |
| Buildability | **NEW-MODEL** (Yield-Model = XGBoost+Transformer to be added; interim shows NDVI-integral proxy vs quota, marked T2) |
| Tier | BUSINESS |

---

## Section 4 — FINANCIAL EXPOSURE ($ at risk today)
**Question answered:** *"If today's problems play out, how many dollars are on the line — and which line item is bleeding?"*
**What it shows:** One big $-at-risk number, decomposed into a waterfall: disease loss, water/irrigation, weather peril, quality-rejection, contract penalty, labor overrun, equipment downtime. Each bar drills in.

| Attribute | Spec |
|---|---|
| Inputs | Outputs of §1–3, §6, §7; EXT market/commodity prices, ERP costs, contracts (penalty clauses), insurance policy data |
| Primitives | Financial-Model, Risk-Engine, Change-Detection, Weather-Fusion, Confidence-Scoring, Executive-AI-Summarizer |
| Models | Bayesian (Confidence), Chronos (price/cost forecast), LLM (Summarizer) |
| Refresh | Live (recomputes when any feeder tile changes); price refresh intraday |
| Alert threshold | Total $-at-risk crosses a director-set daily ceiling; or any single peril exceeds its coverage/penalty trigger |
| Confidence | T3 (est.) — probability × $ impact; band shown per bar |
| Drill-in | RF-FIN-15 Risk Cost · RF-FIN-17 Disease Cost · RF-FIN-16 Weather Cost · RF-FIN-22 Budget Variance · RF-EXE-11 Executive Risk Report · RF-RSK-11 Insurance Exposure · RF-EXE-12 Insurance Exposure |
| Buildability | **EXT-DATA** (requires price + ERP + contract feeds; EO-driven physical risk portion is LIVE/GW-LIFTING) |
| Tier | BUSINESS |

---

## Section 5 — OPERATIONAL BOTTLENECKS
**Question answered:** *"What will stall the crews, the trucks, or the pack-house today — the constraint that caps our throughput?"*
**What it shows:** The binding constraint(s): equipment down, blocked/flooded field access, crew shortfall vs ready acreage, chemical/seed/fertilizer stockout, cold-storage/processing capacity. Ranked by throughput lost.

| Attribute | Spec |
|---|---|
| Inputs | `/api/vision/segment` (machinery/asset count), lband_sar + whitebox_terrain (access/flooding), `/api/eo/scan`; EXT equipment telemetry, labor/HR, ERP inventory |
| Primitives | Object-Count, Change-Detection, Terrain-Drainage, Sensor-Fusion(GNN), Alert-Engine, Financial-Model |
| Models | RT-DETR / YOLO12 (Object-Count), SAM2 (segmentation), GNN (Sensor-Fusion) |
| Refresh | Hourly during work hours; live on telemetry/access change |
| Alert threshold | Any resource utilization/availability below the go-line while dependent work is queued (e.g., harvest-fleet ready < ripe acreage; access road flooded; stockout imminent) |
| Confidence | T2 (screen) for EO-derived access/asset; T1 for terrain drainage (deterministic) |
| Drill-in | RF-OPS-23 Operations Bottlenecks · RF-OPS-09 Roads Blocked · RF-OPS-10 Flooded Access · RF-EQP-22 Bottleneck · RF-LAB-05 Harvest-Crew Readiness · RF-SUP-14 Distribution Bottlenecks · RF-OPS-12 Chemical Inventory |
| Buildability | **LIVE** (EO/terrain/vision portion); **EXT-DATA** for telemetry/labor/inventory feeds |
| Tier | PRO |

---

## Section 6 — WEATHER IMPACTS (today + 7–14d)
**Question answered:** *"What is the sky about to do to my quota — frost tonight, heat this week, rain shutting the field, a spray window closing?"*
**What it shows:** Today's operational verdict (can we work / spray / harvest?) plus a 7–14d risk ribbon: frost, hard-freeze, heat, wind/hail, rain/flood, drought, spray-window, GDD pace. Each with the field(s) exposed and the $ hit.

| Attribute | Spec |
|---|---|
| Inputs | EXT weather NOAA/ECMWF/GPM; `/api/eo/scan` landsat_lst (ET/heat), whitebox_terrain (cold-air pooling / inundation), s2_ndvi (exposure) |
| Primitives | Weather-Fusion, Terrain-Drainage, Water-Model, Forecast-Engine, Alert-Engine, Financial-Model |
| Models | Temporal Transformer (Weather-Fusion), Chronos (forecast), Bayesian (Confidence) |
| Refresh | Hourly (nowcast) + 4×/day model runs |
| Alert threshold | Frost/hard-freeze below crop-kill temp within 24–72h; heat-stress days ≥N; hail/storm probability > threshold; spray window closing; rain shutting field access |
| Confidence | T3 (forecast); terrain pooling/inundation overlay T1 |
| Drill-in | RF-WEA-01 7/14-Day Operations Forecast · RF-WEA-02 Frost Risk · RF-WEA-03 Hard-Freeze/Crop-Kill · RF-WEA-06 Hail Risk · RF-WEA-08 Heat-Stress Days · RF-WEA-17 Spray-Window · RF-PAI-08 Frost Prediction |
| Buildability | **GW-LIFTING / EXT-DATA** (needs NOAA/ECMWF/GPM adapters; terrain-pooling overlay is LIVE via whitebox_terrain) |
| Tier | PRO |

---

## Section 7 — CUSTOMER COMMITMENTS (retailer/distributor contracts on track?)
**Question answered:** *"Will I fill every contract on time, at grade — or is a Walmart/Dole PO about to be short or rejected?"*
**What it shows:** One row per contract/PO: committed volume & grade, projected fulfillment %, delivery-date confidence, quality/rejection risk, and the recommended fix (re-source, re-route, re-grade) if red. This is the buyer's and the director's shared source of truth.

| Attribute | Spec |
|---|---|
| Inputs | Production-at-Risk (§3), Quality/shelf-life EO (s2_ndvi, landsat_lst, stac_datacube); EXT contracts/PO terms, ERP inventory, logistics/cold-chain |
| Primitives | Yield-Model, Phenology-Model, Financial-Model, Risk-Engine, Forecast-Engine, Executive-AI-Summarizer, Recommendation-LLM |
| Models | XGBoost+Transformer (Yield), Chronos (delivery/quality forecast), LLM (Summarizer + Recommendation) |
| Refresh | Daily; live on production/logistics change |
| Alert threshold | Projected fulfillment < committed volume; delivery-date confidence < floor; quality-rejection risk > buyer spec (e.g., Walmart grade/brix/shelf-life) |
| Confidence | T3 (est.) — fulfillment & quality are inferred; rejection framed as **screening risk, not a grade guarantee** |
| Drill-in | RF-SUP-15 Customer Commitments · RF-SUP-16 Contract Fulfillment · RF-SUP-17 Delivery Confidence · RF-GRO-16 Delivery Confidence · RF-GRO-04 Produce Quality Forecast · RF-GRO-10 Replacement Supplier Recommendations · RF-RSK-21 Quality-Rejection Risk · RF-PAI-17 Grocery Chain Fulfillment Prediction |
| Buildability | **EXT-DATA** (contracts/PO/logistics feeds required; EO quality-proxy portion GW-LIFTING) |
| Tier | BUSINESS |

---

## Section 8 — TOP 10 AI RECOMMENDATIONS (ranked by $/operational benefit)
**Question answered:** *"Of everything I could do today, what are the 10 highest-value moves — and what does each save or make?"*
**What it shows:** A ranked action list. Each row: action, target field/asset, expected $ benefit (or loss avoided), effort/owner, deadline, and confidence. One-click "assign as work order." This is the section that turns fear into a to-do list.

| Attribute | Spec |
|---|---|
| Inputs | Every section above (§1–7, §10 forecasts); EXT market prices, ERP costs, contracts |
| Primitives | Recommendation-LLM, Financial-Model, Risk-Engine, Confidence-Scoring, Executive-AI-Summarizer, Alert-Engine |
| Models | LLM (Recommendation + ranking rationale), Bayesian (Confidence), XGBoost (benefit estimate) |
| Refresh | Live re-rank whenever any feeder tile changes; morning digest pinned |
| Alert threshold | A new action surfaces above a $-benefit floor, or an existing recommendation's deadline enters the danger window |
| Confidence | T3 (est.) — each ranked with confidence; low-confidence items flagged "verify before acting" |
| Drill-in | RF-EXE-18 Strategic Recommendations · RF-OPS-16 AI Generated Tasks · RF-FIN-20 ROI Opportunities · RF-FIN-21 Savings Opportunities · RF-RSK-25 Risk-Mitigation ROI · RF-PST-13 Treatment Recommendation · RF-DIS-07 Fungicide Recommendation |
| Buildability | **GW-LIFTING** (orchestration + Recommendation-LLM over live primitives; $-benefit precision improves with EXT cost/price feeds) |
| Tier | BUSINESS |

---

## Section 9 — CONFIDENCE & EVIDENCE (why + how certain)
**Question answered:** *"Can I stand behind this in front of the CEO — what's the evidence and how sure are we?"*
**What it shows:** For every headline claim on the screen: the tier badge (**T1 deterministic / T2 screening / T3 estimate**), the corroborating sources (which scenes/dates/sensors/feeds), the model + confidence band, and a plain-English "why we believe this." Turns the dashboard from a black box into a defensible brief. Makes the honesty discipline visible — disease/pest are labeled **screening corroborators, never diagnoses**.

| Attribute | Spec |
|---|---|
| Inputs | Provenance/metadata from all scans (scene dates, cloud cover, sensor), model outputs + variance, feed freshness |
| Primitives | Confidence-Scoring, Sensor-Fusion(GNN), Executive-AI-Summarizer |
| Models | Bayesian network (Confidence), GNN (agreement across sensors), LLM (evidence narrative) |
| Refresh | Live (mirrors whatever tile is in focus) |
| Alert threshold | Confidence on any red/critical claim drops below the actionable floor, or key input is stale/cloud-obscured → "verify before acting" banner |
| Confidence | Meta — this IS the confidence layer (Bayesian + Confidence-Scoring across T1/T2/T3) |
| Drill-in | RF-DIS-10 Confidence Score · RF-FIN-24 Financial Confidence · RF-CRP-35 Yield Confidence · RF-GRO-14 Traceability Confidence · RF-SUP-17 Delivery Confidence |
| Buildability | **LIVE** (provenance + Confidence-Scoring exist today; richer Bayesian fusion is GW-LIFTING) |
| Tier | PRO |

---

## Section 10 — EXECUTIVE OUTLOOK (quarter on track?)
**Question answered:** *"Zoom out — is the quarter on track for production, quality, profit, and sustainability, and what do I tell the CEO Monday?"*
**What it shows:** Four trajectory gauges (Production / Quality / Profit / Sustainability-ESG) each vs plan, with P50 landing and confidence band, the top-3 quarter risks, and an LLM-written 3-sentence CEO paragraph. The "Monday morning" section.

| Attribute | Spec |
|---|---|
| Inputs | Rollups of all sections; stac_datacube season curves, emit_minerals + whitebox_terrain (ESG/carbon/water); EXT market, ERP, contracts, quota |
| Primitives | Forecast-Engine, Yield-Model, Financial-Model, Carbon-Engine, Water-Model, Risk-Engine, Executive-AI-Summarizer, Confidence-Scoring |
| Models | Chronos / TiDE (forecast), XGBoost+Transformer (Yield), GNN (Sensor-Fusion), LLM (Exec-Summarizer), Bayesian (Confidence) |
| Refresh | Weekly (pinned); re-forecast on material change |
| Alert threshold | Any of the four pillars projected >10% off plan at quarter-end; or composite health drops a band |
| Confidence | T3 (est.) — quarter forecast, P10/P50/P90 |
| Drill-in | RF-EXE-01 Executive Summary · RF-EXE-03 Monthly Business Review · RF-PAI-29 Executive AI Outlook · RF-EXE-07 Profit Forecast · RF-GRO-18 Seasonal Outlook · RF-ESG-01 ESG Score · RF-EXE-13 Sustainability Score |
| Buildability | **GW-LIFTING / EXT-DATA** (EO trajectory + ESG portion GW-LIFTING; profit/quota needs ERP+contract feeds) |
| Tier | BUSINESS |

---

## Buildability roll-up (honest MVP path)
- **Ship first (LIVE today):** §1 Critical Issues, §5 Bottlenecks (EO/terrain/vision half), §9 Confidence & Evidence — all compose existing gateway endpoints (`/api/eo/scan` s2_ndvi/landsat_lst/lband_sar, `whitebox_terrain`, `stac_datacube`, `/api/vision/segment`, `/api/gis/parcel/delineate`, `/api/farm/signals-by-bbox`).
- **Ship next (GW-LIFTING):** §2 Trending, §6 Weather (terrain overlay live now), §8 Top-10 Recommendations, §10 Outlook — need surfacing index_calc / forecast surfaces / adapters + Recommendation-LLM orchestration.
- **Needs a model (NEW-MODEL):** §3 Production at Risk — Yield-Model (XGBoost+Transformer). Interim NDVI-integral proxy, marked T2.
- **Needs external feeds (EXT-DATA):** §4 Financial Exposure, §7 Customer Commitments, and the profit/quota half of §10 — market/commodity prices, ERP/inventory, contracts/PO, logistics/cold-chain, labor/HR, equipment telemetry, insurance policy.

## Non-negotiable design rules
1. **Every tile carries a $ number and a T1/T2/T3 badge.** No naked metrics.
2. **Red before green, action before analysis.** The top-left quadrant is always "what to do now."
3. **Screening, never diagnosis.** Disease/pest/quality are corroborators; the copy says so.
4. **Empty state is a feature.** "0 fields red" is the reassurance the persona pays for.
5. **One click from fear to work order.** Every red tile and every recommendation assigns a task with an owner and a deadline.
6. **Reacts, never polls.** Redis Streams / webhook push via `ChangeEventSource`; the director gets the alert even with the laptop shut.
