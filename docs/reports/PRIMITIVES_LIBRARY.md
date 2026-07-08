# Report.Farm — Reusable Intelligence Primitive Library

**Purpose:** Build ~70 primitives, orchestrate 358 reports.
**Source:** distilled from the 16 report-family recipe matrices in `docs/reports/categories/` (358 reports total).
**Positioning:** Report.Farm is not a mapping tool. It is an **AI Executive Operations Center that sells job security** — every report answers a decision-maker's fear ("Will I hit quota? Will Walmart reject the load? What do I tell the CEO Monday?"). Primitives are the shared machinery that turns pixels + feeds into a *defensible dollarized decision*.

---

## 1. The strategy: ~70 primitives, not 358 silos

The 358 reports look like 358 products. They are not. They are **358 compositions of ~73 shared processing blocks.** A "Disease Cost Estimate" and a "Pest Cost Estimate" and a "Weather Cost" report are the *same three primitives* (a threat/hazard screen → `Yield-Model` → `Financial-Model`) pointed at different inputs and narrated by the same `Executive-AI-Summarizer`. Ninety percent of the engineering value lives in getting the shared blocks right; the reports are then thin YAML-style recipes (inputs + which primitives + alert threshold + tier).

This matters three ways:

- **Build economics.** We build a primitive once and it lights up dozens of reports. `Confidence-Scoring`, `Financial-Model`, `Weather-Fusion`, `Forecast-Engine`, and `Vegetation-Indices` alone touch the majority of the catalog. Ship those five well and hundreds of reports become "assemble and label."
- **Honesty discipline is centralized.** The T1/T2/T3 tier tag, the "screening not diagnosis" guardrail, and the confidence band are enforced inside `Confidence-Scoring` and the threat engines — so no individual report can silently over-claim. A disease or pest signal is *always* a screening corroborator that points scouts and prices risk, never a regulatory/diagnostic verdict.
- **Buildability is inherited.** A report's honest buildability is the *max* buildability of its primitives. If a recipe needs `Yield-Model` (NEW-MODEL) and a `contracts` feed (EXT-DATA), the report is not LIVE no matter how slick the UI. The table below marks each primitive honestly against the **actually deployed gateway**.

### Gateway ground-truth (what "LIVE" means)
We are a thin vertical: we orchestrate + present, the AlphaGeo gateway computes. LIVE today via `/api/farm/*`, `/api/eo/scan`, `/api/vision/*`, `/api/gis/*`:
- `gis/parcel/delineate` (SAM2 field boundary) · `vision/segment` (YOLO-seg + SAM2 point-prompt) · `farm/signals-by-bbox`
- `eo/scan` products: `s2_ndvi` (Sentinel-2 NDVI) · `landsat_lst` (thermal LST) · `emit_minerals` (EMIT 10-mineral) · `lband_sar` (NISAR L-band all-weather change) · `whitebox_terrain` (TWI drainage, deterministic **T1**) · `stac_datacube` (per-date NDVI season curves, **T1**).

**Buildability legend:** `LIVE` = composes deployed endpoints today · `GW-LIFTING` = gateway capability surfacing soon (index_calc for NDRE/SAVI/EVI/NDMI, tau_omega soil moisture, lst_splitwindow, SMAP/GPM/GEDI/GRACE adapters, SAR-change, recommend_scan_combo, DroneOps) · `NEW-MODEL` = a model we/the gateway must add · `EXT-DATA` = an external feed we must integrate. Where a primitive spans tiers, the **dominant** tag is shown with the secondary in parentheses.

**Honesty tiers:** T1 = deterministic · T2 = relative/screening · T3 = model-inferred estimate. Never a diagnostic/regulatory claim.

### How the count breaks down
73 canonical primitives. Aliases in the source matrices were consolidated (e.g. `ShelfLife-Model`≡`Shelf-Life-Model`; `Telematics-Ingest`≡`Equipment-Telemetry`+`Fleet-Location-Tracker`; `Bottleneck-Engine`≡`Bottleneck-Analyzer`; `Compliance-Engine`≡`Compliance-Ledger`+`Certification-Rules-Engine`). Financial specializations (`Market-Risk-Model`, `Liquidity-Model`, `Insurance-Exposure-Model`, `Downtime-Cost-Model`, `Amendment-ROI-Model`) fold into `Financial-Model` as modes; several single-use LLM optimizers (`Treatment-Optimizer`, `Scouting-Prioritizer`, `Irrigation-Scheduler`, `Emergency-Playbook`) fold into `Recommendation-LLM`; regulatory/geopolitical/water-authority feeds fold into `Regulatory-Feed`; `Energy-Model`+`Emissions-Factor-DB`+`Nutrient-Budget` fold into `Emissions-Accounting`.
- **~13 "spine" primitives** reused across ≥6 families (the real moat).
- **~22 mid-reuse** primitives (2–5 families).
- **~38 specialized** primitives (mostly one family, but reused across that family's 15–38 reports).

> Reuse counts below are **estimates from scanning the Primitives column of all 358 recipes** — indicative, not audited to the unit. They exist to rank engineering priority, not to bill.

---

## 2. THE PRIMITIVE TABLE

Family codes: CRP crop · DIS disease · PST pest · SOI soil · WTR water · WEA weather · EQP equipment · LAB labor · OPS operations · FIN financial · EXE executive · RSK risk · SUP supply-chain · GRO grocery-compliance · ESG sustainability · PAI predictive-AI.

### Shelf A — Vegetation & soil spectral (EO index layer)

| Primitive ID | Name | What it computes | Inputs | Model/method | Buildability | Reused-by | Example reports |
|---|---|---|---|---|---|---|---|
| P01 | Vegetation-Indices | Per-zone NDVI/EVI/GNDVI/SAVI/NDRE/chlorophyll/LAI/canopy indices + field stats | s2_ndvi, S2 bands (green/red-edge/NIR), soil-line L | index math; `index_calc` for non-NDVI | GW-LIFTING (NDVI LIVE) | ~82 (all EO families) | RF-CRP-01 NDVI, RF-SOI-09 N-Proxy, RF-SUP-09 Quality |
| P02 | Bare-Soil-Model | Bare-Soil Index, % exposed acres, crust/erosion exposure | Sentinel-2 bands (BSI) | index_calc (BSI) | GW-LIFTING | ~5 | RF-SOI-22 BSI, RF-SOI-15 Erosion, RF-ESG-12 Cover-Crop |
| P03 | Soil-Spectral-Engine | EMIT-driven SOM/SOC/texture/CEC/pH/P/K/salinity spectral inference | emit_minerals, bare-soil S2, samples (opt) | XGBoost regression on hyperspectral | GW-LIFTING (NEW for SOC/P/K) | ~10 | RF-SOI-05 SOC, RF-SOI-07 Salinity, RF-SOI-12 pH |
| P04 | Object-Count | Count/segment discrete objects (plants, gaps, machines, structures) | vision/segment (drone/hi-res), s2_ndvi | YOLO12/RT-DETR + SAM2 | LIVE | ~15 | RF-CRP-27 Stand-Count, RF-EXE-10 Asset-Util, RF-ESG-11 Biodiversity |

### Shelf B — Water & terrain

| Primitive ID | Name | What it computes | Inputs | Model/method | Buildability | Reused-by | Example reports |
|---|---|---|---|---|---|---|---|
| P05 | Water-Model | Soil-moisture / crop-water / stress (CWSI-style) / consumption / groundwater proxy | tau_omega SM, landsat_lst, s2_ndvi, SMAP/GPM/GRACE | GNN fusion + water balance | GW-LIFTING (LST/NDVI LIVE) | ~40 | RF-WTR-01 Soil-Moisture, RF-CRP-21 Water-Stress, RF-PAI-07 Water-Shortage |
| P06 | Terrain-Drainage | TWI drainage / pooling / trafficability / cold-air pooling — deterministic | whitebox_terrain (TWI), DEM | WhiteBox terrain (deterministic) | LIVE | ~36 | RF-WTR-11 Drainage, RF-OPS-06 Field-Readiness, RF-WEA-02 Frost-Pooling |
| P07 | Moisture-Retrieval | Multi-depth soil-moisture retrieval (0-5 / root-zone / subsoil) | lband_sar dielectric, SMAP L4, GPM | tau_omega / water-balance + GNN | GW-LIFTING | ~5 | RF-SOI-01 Surface-SM, RF-SOI-02 Root-Zone, RF-SOI-03 Subsoil |
| P08 | ET-Model | Evapotranspiration / crop water demand (ETc, Kc) | landsat_lst, s2_ndvi (Kc), weather | lst_splitwindow + energy balance | GW-LIFTING | ~5 | RF-WTR-02 Consumption, RF-WEA-16 ET-Demand, RF-EXE-15 Water-Use |
| P09 | Hydro-Extent-Model | Open-water surface extent + volume (ponds, reservoirs, canals, flood) | lband_sar, s2_ndwi, DEM | SAR/optical extent + SAM2/regression | LIVE (extent) | ~6 | RF-WTR-08 Pond-Volume, RF-WTR-09 Reservoir, RF-WTR-13 Canal |
| P10 | Leak-Anomaly-Detector | Anomalous persistent wet/thermal hotspot (buried-line/valve leak) | landsat_lst, lband_sar, tau_omega SM | Temporal-Transformer anomaly | GW-LIFTING | ~2 | RF-WTR-15 Leak, RF-WTR-14 Water-Loss |
| P11 | Pedotransfer-Model | Texture→CEC→AWC/water-holding pedotransfer functions | texture est, SOM index, terrain | XGBoost pedotransfer | GW-LIFTING (NEW for AWC) | ~3 | RF-SOI-13 CEC, RF-SOI-16 Texture, RF-SOI-19 AWC |
| P12 | Field-Readiness-Index | Go/No-Go trafficability + workability per field | whitebox_terrain, lband_sar, tau_omega SM, weather | GNN + Temporal-Transformer | GW-LIFTING | ~3 | RF-OPS-06 Field-Readiness, RF-SOI-17 Tilth, RF-EXE-09 Op-Readiness |

### Shelf C — Change detection

| Primitive ID | Name | What it computes | Inputs | Model/method | Buildability | Reused-by | Example reports |
|---|---|---|---|---|---|---|---|
| P13 | Change-Detection | Multi-date gain/loss, anomaly clusters, event extents (all-weather via SAR) | stac_datacube multi-date, s2_ndvi, lband_sar | differential cube + SAR-change | LIVE (GW-LIFTING for SAR-change) | ~51 | RF-CRP-33 Veg-Change, RF-WTR-06 Flood, RF-ESG-16 Deforestation |

### Shelf D — Weather & hazard

| Primitive ID | Name | What it computes | Inputs | Model/method | Buildability | Reused-by | Example reports |
|---|---|---|---|---|---|---|---|
| P14 | Weather-Fusion | Public forecast physics downscaled to parcel using farm LST/terrain/NDVI state | NOAA/NWS, ECMWF/HRRR, GPM, SMAP, landsat_lst | Temporal Transformer downscale | EXT-DATA | ~97 | RF-WEA-01 Op-Forecast, RF-DIS-01 Disease-Risk, RF-PAI-08 Frost |
| P15 | Forecast-Engine(time-series) | P10/P50/P90 trajectory + ETA/date for any signal | stac_datacube history, weather, any series | Chronos / TiDE / PatchTST | GW-LIFTING (EXT for feeds) | ~109 | RF-PAI-01 7-Day, RF-CRP-34 Growth-Forecast, RF-FIN-03 Cash-Flow |
| P16 | Degree-Day-Model | GDD/HDD/chill accumulation vs lifecycle & phenology thresholds | weather temp, base/cap temps, planting date | deterministic accumulation | EXT-DATA | ~6 | RF-PST-04 Degree-Day, RF-WEA-14 GDD, RF-WEA-15 Chill |
| P17 | Frost-Model | Per-block min-temp, frost-hours, kill-temp exposure, protect/no-protect call | NWS min-temp/dewpoint/wind, LST, terrain | Temporal Transformer + Bayesian | EXT-DATA (LST/terrain LIVE) | ~2 | RF-WEA-02 Frost, RF-WEA-03 Hard-Freeze |
| P18 | Storm-Risk-Model | Hail/wind/severe composite probability + stone size + exposed acres | NOAA SPC, HRRR reflectivity, crop value | classifier + Temporal Transformer | EXT-DATA | ~2 | RF-WEA-06 Hail, RF-WEA-13 Severe-Weather |
| P19 | Spray-Window-Model | Hourly drift/efficacy window (wind + Delta-T + inversion + rain) | NWS 10m wind/RH/dewpoint, buffer geometry | PatchTST forecast + rules | EXT-DATA | ~2 | RF-WEA-05 Drift-Window, RF-WEA-17 Spray-Suitability |
| P20 | Peril-Model | Discrete peril probability × extent (flood/frost/hail/cat) for risk register | weather, lband_sar, whitebox_terrain, GPM | peril classifiers + Bayesian | GW-LIFTING (EXT for forecast) | ~4 | RF-RSK-07 Flood, RF-RSK-08 Frost, RF-RSK-18 Hail |

### Shelf E — Crop biology

| Primitive ID | Name | What it computes | Inputs | Model/method | Buildability | Reused-by | Example reports |
|---|---|---|---|---|---|---|---|
| P21 | Phenology-Model | Growth-stage / emergence / flowering / senescence / maturity from season curves | stac_datacube per-date curves, GDD | curve-fit + Chronos | LIVE (GW-LIFTING for stage) | ~44 | RF-CRP-29 Maturity, RF-SUP-19 Ripeness, RF-LAB-01 Labor-Demand |
| P22 | Yield-Model | Yield t/ha + tonnage + variability + confidence band | s2_ndvi, lband_sar, phenology, weather, GEDI | XGBoost+Transformer | NEW-MODEL | ~51 | RF-CRP-14 Yield, RF-EXE-05 Production-Forecast, RF-GRO-01 Miss-Quota |
| P23 | Ripeness-Model | Predicted pick/ship-ready date + maturity curve | stac_datacube, s2_ndvi, landsat_lst, GDD | Temporal Transformer + XGBoost | NEW-MODEL | ~3 | RF-SUP-19 Ripeness, RF-SUP-02 Harvest-Calendar, RF-SUP-11 Retail-Ready |
| P24 | Grade-Model | Predicted A/B/C grade distribution + defect-risk band | s2_ndvi, landsat_lst, stac_datacube, vision/segment | XGBoost + ViT/RT-DETR corroborate | NEW-MODEL | ~6 | RF-SUP-10 Grade, RF-GRO-04 Quality-Forecast, RF-SUP-08 Export |
| P25 | Shelf-Life-Model | Post-harvest shelf-life days + spoilage drivers | landsat_lst field-heat, stress indices, weather, cold-chain specs | XGBoost+Transformer | NEW-MODEL | ~5 | RF-SUP-18 Shelf-Life, RF-GRO-09 Shelf-Life, RF-SUP-20 Food-Waste |

### Shelf F — Bio-threat screening (SCREENING corroborators, never diagnosis)

| Primitive ID | Name | What it computes | Inputs | Model/method | Buildability | Reused-by | Example reports |
|---|---|---|---|---|---|---|---|
| P26 | Disease-Engine | Disease-pressure screening score, infection heatmap, spread front, reinfection, quarantine line | s2_ndvi/NDRE anomaly, whitebox_terrain, weather humidity | ViT + weather-coupled model | NEW-MODEL | ~27 | RF-DIS-01 Risk-Score, RF-CRP-23 Disease-Stress, RF-RSK-04 Disease-Risk |
| P27 | Symptom-Detector(ViT) | Per-disease early-symptom flags (blight/rust/mildew/rot/wilt/spot) — screening | NDRE, s2_ndvi, vision/segment (hi-res) | ViT symptom classifier + YOLO12 | NEW-MODEL | ~13 | RF-DIS-05 Early-Symptoms, RF-DIS-11 Blight, RF-DIS-12 Rust |
| P28 | Spore-Dispersal-Model | Directional spread front + arrival ETA to adjacent blocks | infection foci, weather wind/humidity, gis/parcel | dispersal + Temporal Transformer | NEW-MODEL | ~3 | RF-DIS-03 Spread, RF-DIS-19 Quarantine, RF-DIS-21 Spread-vs-Weather |
| P29 | Pest-Engine | Composite pest-risk index, infestation intensity, damage screen — screening | s2_ndvi anomaly, landsat_lst, weather, trap counts | XGBoost risk + SAM2/YOLO patches | NEW-MODEL | ~21 | RF-PST-01 Pest-Risk, RF-CRP-22 Pest-Stress, RF-RSK-05 Pest-Risk |
| P30 | Migration-Model | 7–14d pest spread vector + probability surface toward clean fields | infestation history, weather wind, signals-by-bbox | GNN + Chronos + Temporal Transformer | NEW-MODEL | ~3 | RF-PST-03 Migration, RF-PST-14 Reinfestation, RF-PAI-06 Pest-Migration |
| P31 | Trap-Fusion | Fuses pheromone/sticky trap counts w/ remote signal; pest:beneficial balance | trap counts (pest + beneficial), scouting, weather | XGBoost + GNN + Bayesian | EXT-DATA | ~2 | RF-PST-08 Trap-Correlation, RF-PST-07 Beneficial-Balance |
| P32 | Economic-Threshold-Model | Pest density vs economic threshold → spray/no-spray $ call | infestation intensity, trap counts, market px, treat cost | XGBoost + rules | EXT-DATA | ~2 | RF-PST-11 Econ-Threshold, RF-PST-13 Treatment-Rec |
| P33 | Resistance-Model | Resistance-risk by MOA + rotation flag | spray history/ERP, efficacy trend, regional DB | XGBoost + Bayesian | EXT-DATA | ~2 | RF-PST-10 Resistance, RF-PST-13 Treatment-Rec |

### Shelf G — Financial & risk

| Primitive ID | Name | What it computes | Inputs | Model/method | Buildability | Reused-by | Example reports |
|---|---|---|---|---|---|---|---|
| P34 | Financial-Model | $ conversion of any signal: revenue/cost/margin/cash/VaR/ROI/exposure/downtime (unit-economics engine; absorbs market/liquidity/insurance-exposure/amendment-ROI modes) | any model output, ERP/cost ledger, market/commodity feed, contracts, policy | unit-economics + Monte-Carlo/VaR | EXT-DATA | ~104 | RF-FIN-01 Revenue, RF-DIS-08 Disease-Cost, RF-CRP-36 ROI-Forecast |
| P35 | Risk-Engine | Probability × $ risk register, per-peril scoring, ranking (absorbs biosecurity) | eo/scan (all), weather, market, contracts | Bayesian + GNN + LLM | GW-LIFTING | ~73 | RF-RSK-01 Composite-Risk, RF-EXE-11 Exec-Risk, RF-PAI-19 Insurance-Claim |
| P36 | Supply-Chain-Graph | Node/edge disruption graph (supplier→logistics→market) + node exposure | supplier/ERP, logistics feeds, geopolitical | GNN + LLM | EXT-DATA | ~2 | RF-RSK-14 Supply-Disruption, RF-RSK-23 Geopolitical |

### Shelf H — Carbon & ESG

| Primitive ID | Name | What it computes | Inputs | Model/method | Buildability | Reused-by | Example reports |
|---|---|---|---|---|---|---|---|
| P37 | Carbon-Engine | Soil+biomass carbon stock/trend + credit-eligible tCO2e | emit_minerals, s2_ndvi, GEDI biomass, whitebox_terrain, stac_datacube | XGBoost (C stock) + Chronos trend | NEW-MODEL (GW-LIFTING inputs) | ~14 | RF-ESG-04 Carbon-Stored, RF-EXE-14 Carbon-Opportunity, RF-SOI-05 SOC |
| P38 | Carbon-MRV | Registry-grade SOC stock + uncertainty + additionality + sampling plan | Carbon-Engine stock, baseline, methodology | XGBoost + Bayesian uncertainty | NEW-MODEL | ~3 | RF-ESG-13 Soil-Carbon-MRV, RF-ESG-05 Credits, RF-SOI-06 SOC-Trend |
| P39 | ESG-Scoring | 0–100 composite E/S/G index + A–F grade + peer band | sub-scores, ERP records, WRI water, cert status | Bayesian + LLM | GW-LIFTING | ~2 | RF-ESG-01 ESG-Score, RF-ESG-02 Sustainability-Grade |
| P40 | Biodiversity-Model | Habitat-diversity index + hedgerow/margin area | vision/segment land cover, s2 heterogeneity, change | SAM2/YOLO12 + GNN | NEW-MODEL | ~1 | RF-ESG-11 Biodiversity |
| P41 | Deforestation-Ledger | Pass/fail vs 2020 cutoff + geolocated forest-loss ledger (EUDR) | lband_sar change, s2_ndvi baseline, parcel delineate | deterministic change-detect | LIVE | ~1 | RF-ESG-16 Deforestation-Free-Proof |
| P42 | Regen-Practice-Tracker | Regen score (cover, low-till, rotation, diversity) + practice-reversal flag | tillage SAR-change, cover-crop signal, rotation history | GNN + LLM | GW-LIFTING | ~1 | RF-ESG-14 Regen-Practice-Score |
| P43 | Emissions-Accounting | kgCO2e/ton + energy/fuel/N intensity vs buyer cap (Scope 1/2/3, nutrient budget) | equipment telemetry, fuel/utility, ERP fertilizer, emission factors | activity-data × factors + XGBoost | EXT-DATA | ~3 | RF-ESG-15 Emissions/Ton, RF-ESG-09 Energy, RF-ESG-10 Fertilizer-Intensity |
| P44 | Soil-Health-Index | 0–100 fused soil-health scorecard + variable-rate zone Rx | all SOI layers (moisture/SOM/salinity/nutrients/structure/drainage) | GNN fusion + Chronos + LLM | NEW-MODEL | ~1 | RF-SOI-24 Soil-Health-Composite |

### Shelf I — Equipment & ops assets (EXT-DATA gated: no telemetry feed = no data)

| Primitive ID | Name | What it computes | Inputs | Model/method | Buildability | Reused-by | Example reports |
|---|---|---|---|---|---|---|---|
| P45 | Equipment-Telemetry | Normalized DTC/hours/fuel/GPS/load/temps + geofence + heartbeat (absorbs location tracker) | AEMP/ISO 15143-3, JDLink, AGCO, CNH, CAN/ISOBUS; gis/parcel for geofence | ingest/normalize + rules | EXT-DATA (GIS overlay LIVE) | ~28 | RF-EQP-07 Telematics-Health, RF-EQP-15 Location, RF-OPS-08 Failures |
| P46 | Fleet-Availability-Model | Fleet uptime %, machines-ready, readiness-vs-window | telematics status/hours, CMMS, weather window | roll-up + Forecast-Engine | EXT-DATA | ~3 | RF-EQP-01 Availability, RF-EQP-08 Harvest-Readiness, RF-EQP-22 Bottleneck |
| P47 | Utilization-Model | Engine-hrs vs idle vs productive %, $/productive-hr, hrs/ac by field | telematics hours/load/PTO/idle/GPS, lease/cost | roll-up + LLM | EXT-DATA | ~6 | RF-EQP-02 Utilization, RF-EQP-10 Idle-Time, RF-EQP-21 Util-by-Field |
| P48 | Maintenance-Engine | Prioritized work-order queue, service-due, warranty coverage | CMMS/ERP, OEM intervals, warranty registry, telematics severity | rules + LLM ranking | EXT-DATA | ~6 | RF-EQP-04 Maint-Queue, RF-EQP-13 Service-Schedule, RF-EQP-19 Warranty |
| P49 | Failure-Prediction-Model | Per-machine fail-probability + RUL days + wear index | telematics history (DTC/temps/load/hours), maint log | XGBoost + Chronos/PatchTST + Bayesian | NEW-MODEL | ~3 | RF-EQP-03 Failure-Prediction, RF-EQP-11 Breakdown-Risk, RF-PAI-13 Equip-Failure |
| P50 | Calibration-Engine | Rate/section/nozzle drift, guidance/autosteer overlap-skip vs spec | implement telemetry, as-applied maps, GNSS/RTK | rules + LLM screening | EXT-DATA | ~3 | RF-EQP-09 Sprayer-Calibration, RF-EQP-16 Implement-Wear, RF-EQP-23 Autosteer |
| P51 | Bottleneck-Analyzer | Ranked constraint (asset/crew/field/input/node) + throughput loss | fused telematics, maint, labor, inventory, logistics | GNN + LLM | EXT-DATA | ~3 | RF-EQP-22 Bottleneck, RF-OPS-23 Ops-Bottlenecks, RF-SUP-14 Distribution-Bottlenecks |
| P52 | Inventory-Ledger | On-hand vs planned use, days-of-cover, reorder (chem/fert/seed/parts/tank) | ERP/inventory, POs, plan, IoT tank levels | balance + Forecast-Engine | EXT-DATA | ~4 | RF-OPS-12 Chemical-Inv, RF-OPS-11 Tank-Status, RF-EQP-12 Parts-Inventory |
| P53 | Work-Order-Engine | Open/assigned/overdue WO board + EO-verified completion | app WO state, crew roster, before/after s2_ndvi/SAR | state machine + Change-Detection | LIVE | ~3 | RF-OPS-15 Work-Orders, RF-OPS-18 Completed-Activities, RF-OPS-27 Handover |
| P54 | Task-Orchestrator | Ranked task/resource assignment from live signals | signals-by-bbox, rosters, field priority, inventory | Recommendation-LLM + XGBoost | LIVE | ~8 | RF-OPS-16 AI-Tasks, RF-OPS-24 Resource-Allocation, RF-OPS-20 Inspections |
| P55 | Drone-Ops | Mission plan/coverage, flagged AOIs, gaps | DroneOps flight logs, orthomosaic, priority fields | YOLO12 + SAM2 | GW-LIFTING | ~2 | RF-OPS-19 Drone-Missions, RF-CRP-25 Weed-Pressure |

### Shelf J — Labor & workforce (EXT-DATA: EO gives demand timing, HR feed gives the rest)

| Primitive ID | Name | What it computes | Inputs | Model/method | Buildability | Reused-by | Example reports |
|---|---|---|---|---|---|---|---|
| P56 | Labor-Demand-Model | Crew-days demanded by field/week (EO ripeness → labor need) | s2_ndvi + stac_datacube ripeness, parcel acreage, crop calendar | Chronos/PatchTST + XGBoost | GW-LIFTING (demand model NEW) | ~4 | RF-LAB-01 Demand-Forecast, RF-LAB-09 Task-Allocation, RF-LAB-12 H-2A |
| P57 | Workforce-Supply-Model | Available heads: rosters, absenteeism, H-2A pipeline, headcount-vs-plan | HR/HRIS, timekeeping, FLC rosters, H-2A filings | Chronos + XGBoost + Bayesian | EXT-DATA | ~7 | RF-LAB-02 Shortage, RF-LAB-08 Headcount, RF-LAB-10 Absenteeism |
| P58 | Crew-Productivity-Model | Units/hr & acres/crew-day vs benchmark, $/acre labor | timekeeping punches, production counts, acreage, payroll | XGBoost + LLM | EXT-DATA | ~4 | RF-LAB-03 Productivity, RF-LAB-04 Cost/Acre, RF-LAB-13 Wage-Variance |

### Shelf K — Supply, fulfillment & compliance

| Primitive ID | Name | What it computes | Inputs | Model/method | Buildability | Reused-by | Example reports |
|---|---|---|---|---|---|---|---|
| P59 | Fulfillment-Model | Per-grower projected volume vs contracted quota + gap/surplus | stac_datacube, eo/scan, contracts/quota, ERP | Yield-Model + Chronos | NEW-MODEL | ~10 | RF-GRO-01 Miss-Quota, RF-GRO-03 Behind, RF-GRO-16 Delivery-Confidence |
| P60 | Inventory-Model | Projected on-hand vs demand, stock-out date, capacity vs inflow | production forecast, ERP/inventory, contracts/PO, capacity | Chronos/TiDE + LLM | EXT-DATA | ~9 | RF-SUP-12 Inventory-Forecast, RF-SUP-06 Cold-Storage, RF-SUP-13 Processing-Capacity |
| P61 | Logistics-Engine | Loads/pallets/trucks/containers plan, OTIF, lane congestion | shipment forecast, logistics/TMS, gis/parcel distance, contracts | Chronos + LLM + GNN | EXT-DATA | ~6 | RF-SUP-07 Truck-Scheduling, RF-SUP-17 Delivery-Confidence, RF-PAI-28 Transport-Bottleneck |
| P62 | Portfolio-Rollup | Aggregates per-farm intelligence into buyer/exec portfolio KPIs + rankings | all per-parcel outputs, contracts, supplier registry | weighted aggregation | GW-LIFTING | ~18 | RF-GRO-17 Weekly-Briefing, RF-EXE-08 Crop-Portfolio, RF-GRO-06 Supply-Shortages |
| P63 | Compliance-Ledger | Requirement/cert status vs spec + gap checklist (absorbs cert-rules-engine) | records, MRV, contract specs, cert criteria, EO evidence | rules + LLM gap reasoning | EXT-DATA | ~8 | RF-OPS-22 Compliance-Status, RF-ESG-03 Cert-Readiness, RF-GRO-14 Traceability |
| P64 | Compliance-Pack-Builder | Bundled, timestamped, citation-linked audit dossier | outputs of any compliance/ESG report | LLM assembly + provenance | LIVE | ~3 | RF-ESG-18 Audit-Pack, RF-ESG-13 MRV-Package, RF-SOI-06 MRV-Audit |
| P65 | Safety-Ledger | Incident/TRIR trend, heat-exposure, inspection compliance, corrective actions | EHS/HR incident feed, landsat_lst heat, inspection records | rules + XGBoost + LLM | EXT-DATA | ~3 | RF-OPS-21 Safety-Incidents, RF-EQP-20 Safety-Inspection, RF-LAB-07 Safety |
| P66 | Regulatory-Feed | External regulatory/allocation/geopolitical/water-authority feed adapter | water-authority, DOL, tariff/trade, WRI Aqueduct feeds | feed ingest + LLM context | EXT-DATA | ~5 | RF-WTR-16 Water-Restrictions, RF-RSK-23 Export-Risk, RF-ESG-17 Water-Stewardship |
| P67 | Food-Safety-Engine | Contamination/recall screening (water source, flood proximity, audit gap) | irrigation water source, whitebox_terrain flood, lband_sar, audit log | Bayesian + GNN screening | EXT-DATA | ~2 | RF-RSK-15 Food-Safety, RF-GRO-12 Food-Safety-Risk |

### Shelf L — Orchestration & AI (cross-cutting spine)

| Primitive ID | Name | What it computes | Inputs | Model/method | Buildability | Reused-by | Example reports |
|---|---|---|---|---|---|---|---|
| P68 | Sensor-Fusion(GNN) | Fuses heterogeneous EO/IoT/station/telemetry layers into one state | all EO layers, IoT, station, telemetry | Graph Neural Network | GW-LIFTING | ~41 | RF-CRP-17 Crop-Stress, RF-EXE-04 Scorecard, RF-OPS-17 High-Priority-Alerts |
| P69 | Executive-AI-Summarizer | Board-grade narrative: target-vs-actual, top-3 risks, $ impact, what-to-tell-CEO | all report outputs, alerts, confidence | LLM (long-context summarize) | GW-LIFTING (LIVE for briefs) | ~50 | RF-EXE-01 Exec-Summary, RF-OPS-01 Daily-Ops, RF-FIN-26 Exec-Financial |
| P70 | Recommendation-LLM | Ranked action list + $ ROI; spray/irrigate/scout/replant/emergency Rx (absorbs treatment/scouting/irrigation/emergency optimizers) | fused signals, thresholds, cost/intervention library | LLM (reasoning + ranking) | GW-LIFTING | ~53 | RF-EXE-18 Strategic-Recs, RF-PST-13 Treatment-Rec, RF-OPS-26 Emergency-Response |
| P71 | Alert-Engine | Threshold/anomaly/forecast-breach detection → SSE + Redis-Stream push | any KPI + thresholds, live signals | rules + change/forecast triggers | LIVE | ~51 | RF-OPS-17 High-Priority-Alerts, RF-WEA-02 Frost-Alert, RF-DIS-05 Early-Symptoms |
| P72 | Confidence-Scoring | Per-report T1/T2/T3 tag + confidence band + data-gap/quality drivers | all outputs, scan cloud/quality, feed completeness | Bayesian network | LIVE | ~150 (≈ all 358) | every report — e.g. RF-CRP-35 Yield-Confidence, RF-PST-16 Confidence, RF-FIN-24 Financial-Confidence |
| P73 | Prediction-Horizon | Assigns/validates forecast lead-time + horizon-decay to any forward report | Forecast-Engine outputs, historical skill | horizon calibration | GW-LIFTING | ~29 (all PAI) | RF-PAI-01..29 (7/14/30-day, harvest-date, yield/revenue/fulfillment prediction) |

---

## 3. Primitive → reports reuse heatmap

Ranked by estimated reports touched. The steep head is the build priority: the top ~13 primitives are the moat — nail them and the majority of the 358-report catalog becomes assembly.

```
PRIMITIVE (ID)                     REPORTS  BUILDABILITY   BAR (each block ≈ 5 reports)
Confidence-Scoring       (P72)     ~150     LIVE           ██████████████████████████████ 
Forecast-Engine          (P15)     ~109     GW-LIFTING     ██████████████████████ 
Financial-Model          (P34)     ~104     EXT-DATA       █████████████████████ 
Weather-Fusion           (P14)      ~97     EXT-DATA       ███████████████████ 
Vegetation-Indices       (P01)      ~82     GW-LIFTING     ████████████████ 
Risk-Engine              (P35)      ~73     GW-LIFTING     ███████████████ 
Recommendation-LLM       (P70)      ~53     GW-LIFTING     ███████████ 
Change-Detection         (P13)      ~51     LIVE           ██████████ 
Alert-Engine             (P71)      ~51     LIVE           ██████████ 
Yield-Model              (P22)      ~51     NEW-MODEL      ██████████ 
Executive-AI-Summarizer  (P69)      ~50     GW-LIFTING     ██████████ 
Phenology-Model          (P21)      ~44     LIVE           █████████ 
Sensor-Fusion(GNN)       (P68)      ~41     GW-LIFTING     ████████ 
Water-Model              (P05)      ~40     GW-LIFTING     ████████ 
Terrain-Drainage         (P06)      ~36     LIVE           ███████ 
Prediction-Horizon       (P73)      ~29     GW-LIFTING     ██████ 
Equipment-Telemetry      (P45)      ~28     EXT-DATA       ██████ 
Disease-Engine           (P26)      ~27     NEW-MODEL      █████ 
Pest-Engine              (P29)      ~21     NEW-MODEL      ████ 
Portfolio-Rollup         (P62)      ~18     GW-LIFTING     ████ 
Object-Count             (P04)      ~15     LIVE           ███ 
Carbon-Engine            (P37)      ~14     NEW-MODEL      ███ 
Symptom-Detector(ViT)    (P27)      ~13     NEW-MODEL      ███ 
Fulfillment-Model        (P59)      ~10     NEW-MODEL      ██ 
Inventory-Model          (P60)       ~9     EXT-DATA       ██ 
Compliance-Ledger        (P63)       ~8     EXT-DATA       ██ 
Task-Orchestrator        (P54)       ~8     LIVE           ██ 
Workforce-Supply-Model   (P57)       ~7     EXT-DATA       █ 
Grade-Model / Logistics / Utilization / Maintenance         ~6 each         █ 
Hydro-Extent / Degree-Day / Bare-Soil / Shelf-Life / ET     ~5 each         █ 
[long tail: ~40 specialized primitives, 1–4 reports each]                    ▏
```

### Reading the heatmap for the build roadmap

- **The 4 free wins (LIVE + huge reuse):** `Confidence-Scoring` (P72), `Change-Detection` (P13), `Alert-Engine` (P71), and `Phenology-Model` (P21, LIVE from datacube) sit on deployed gateway endpoints and touch ~300 report-slots combined. **Build these first** — they are pure orchestration over what the gateway already returns, and they carry the honesty discipline (tier tags, screening guardrails, event push).
- **The 3 high-leverage lifts (GW-LIFTING, top reuse):** `Forecast-Engine` (P15), `Vegetation-Indices` full family (P01, NDRE/EVI/SAVI via `index_calc`), and `Sensor-Fusion` (P68). Unlocking `index_calc` and Chronos/TiDE serving alone lights up ~200 report-slots.
- **The paid dependencies (EXT-DATA, top reuse):** `Weather-Fusion` (P14, NOAA/ECMWF) and `Financial-Model` (P34, ERP/market/contracts). These are #2/#4 by reuse but **cannot be faked** — no weather feed, no forecast; no cost ledger, no dollars. They are the gating integrations for the entire BUSINESS tier and the "sells job security" dollar frame. Prioritize the connectors.
- **The two NEW-MODEL keystones:** `Yield-Model` (P22, ~51 slots) and `Disease-Engine`/`Pest-Engine` (P26/P29, ~48 combined). Yield-Model is the single highest-value model to build — it is the backbone of production, revenue, quota, fulfillment, contract-risk and ROI reports across 8 families. Disease/Pest engines must ship with the screening-not-diagnosis guardrail baked in.
- **The long tail earns its keep inside a family.** A primitive like `Calibration-Engine` (~3) or `Soil-Health-Index` (~1) looks low-reuse globally, but each powers its family's flagship BUSINESS report. They are not waste — they are the last mile that makes a family sellable. Build them after the spine, gated on their family's EXT-DATA/telemetry feed landing.

### Tier coverage sanity check
- **BASIC** (grower essentials) is almost entirely LIVE primitives (P01, P04, P06, P13, P72) — shippable now.
- **PRO** adds GW-LIFTING index/forecast/water primitives (P05, P08, P15, P21, P27) + `Alert-Engine` + `Recommendation-LLM`.
- **BUSINESS** is where NEW-MODEL + EXT-DATA concentrate (`Yield-Model`, `Fulfillment-Model`, `Carbon-MRV`, `Financial-Model`, `Portfolio-Rollup`, all telemetry/HR/logistics engines) — the portfolio, compliance/MRV, predictive and buyer-watchtower surface. This is the honest paywall: BUSINESS requires the feeds + models, not just prettier pixels.
