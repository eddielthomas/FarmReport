# Operations Report Family — Intelligence Recipe Matrix

## Persona & the fear it answers

The **Operations Director / regional farm manager** owns the daily heartbeat of the farm and gets fired if the farm *stalls* — a missed planting window, an irrigation call made 48 hours too late, a harvest crew idle because the access road flooded, a chemical stock-out that halts spraying, or a Walmart delivery slipping because equipment went down. This family is the **executive operations center**: it fuses the field (EO/SAR/terrain), the assets (equipment, tanks, inventory), and the people (work orders, crews, inspections) into one prioritized "what breaks the farm today, and what do I do about it" briefing. Every report answers the same fear in a different slice: *"Will the farm keep moving — and if it stalls, will I be the one who saw it coming, or the one explaining it to the CEO on Monday?"*

## Shared pipeline (Operations family)

```
INPUTS                         PRIMITIVES                      MODELS                    OUTPUTS            ALERT            REPORT
------                         ----------                      ------                    -------            -----            ------
Sentinel-2 NDVI ┐              Vegetation-Indices ┐            Chronos/TiDE ┐            per-field         Alert-Engine     Executive-AI
Landsat LST     │              Water-Model        │            (forecast)   │            priority score    threshold +      -Summarizer
EMIT minerals   ├─ /api/eo ───▶ Change-Detection  ├─▶ GNN ────▶ XGBoost      ├─▶ rank ──▶ ranked queues ──▶ playbook ──────▶ + Recommendation
NISAR L-SAR     │              Terrain-Drainage   │   Sensor-  (yield)       │            work orders       trigger          -LLM →
WhiteBox TWI    │              Phenology-Model     │   Fusion   ViT/YOLO      │            asset status      (SSE + Redis     scheduled brief
STAC datacube   ┘              Field-Readiness-Idx │           (screen)      │            KPI deltas        Stream push)     + urgent alert
                               ┌───────────────────┘                         │
Equipment telem ┐  EXT-DATA    │ Equipment-Telemetry                         │
Inventory/ERP   ├──────────────┤ Inventory-Ledger                            │
Labor/HR        │              │ Labor-Model                                 │
Weather NOAA    │              │ Weather-Fusion                              │
Contracts/MRV   ┘              │ Compliance-Ledger, Work-Order-Engine,       │
                               │ Bottleneck-Analyzer, Task-Orchestrator ─────┘
                               └─▶ Confidence-Scoring (Bayesian) tags every KPI T1/T2/T3
```

## The Recipe Matrix

| Recipe ID | Report | Fear it answers | Output / KPI | Inputs (data sources) | AI Models | Primitives | Alert trigger | Confidence | Refresh | Buildability | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|
| RF-OPS-01 | Daily Operations Report | "What do I tell the CEO this morning?" | 1-page ranked briefing: top risks, today's must-dos, KPI deltas | s2_ndvi, landsat_lst, lband_sar, signals-by-bbox, app work-order state | LLM, Bayesian | Executive-AI-Summarizer, Alert-Engine, Change-Detection, Confidence-Scoring | Any field/asset crosses red threshold overnight | T2 | Daily 05:00 | LIVE | PRO |
| RF-OPS-02 | Fields Requiring Attention | "Which fields are silently going bad?" | Ranked field list w/ stress cause + severity | s2_ndvi, landsat_lst, lband_sar, stac_datacube | Chronos, GNN | Vegetation-Indices, Change-Detection, Sensor-Fusion(GNN), Alert-Engine | NDVI drop >15% vs 10-day baseline | T2 | Per-pass (2–5 d) | LIVE | PRO |
| RF-OPS-03 | Irrigation Priority | "Am I about to lose yield to water stress?" | Ranked irrigation queue, mm-deficit estimate | landsat_lst, s2_ndvi, whitebox_terrain, tau_omega SM, NDMI | TiDE, GNN | Water-Model, Vegetation-Indices, Terrain-Drainage, Sensor-Fusion(GNN) | LST anomaly + SM below refill point | T2/T3 | Daily | GW-LIFTING | PRO |
| RF-OPS-04 | Harvest Priority | "Will I harvest at peak or miss the window?" | Ranked harvest order, days-to-maturity, dry-down | stac_datacube, s2_ndvi, Weather-Fusion, Yield-Model | Chronos, XGBoost+Transformer | Phenology-Model, Yield-Model, Weather-Fusion, Forecast-Engine | Senescence + weather closes window <5 d | T3 | Daily | GW-LIFTING | PRO |
| RF-OPS-05 | Planting Progress | "Are we behind on the planting window?" | % planted by field, ha/day pace vs plan | s2_ndvi time-series, lband_sar, app plan | Chronos | Change-Detection, Phenology-Model, Forecast-Engine | Pace behind plan to miss agronomic window | T2 | Daily | LIVE | PRO |
| RF-OPS-06 | Field Readiness | "Can the crew get in and work tomorrow?" | Go/No-Go trafficability + soil-moisture index per field | whitebox_terrain, lband_sar, tau_omega SM, Weather-Fusion | GNN, Temporal Transformer | Field-Readiness-Index, Terrain-Drainage, Water-Model, Weather-Fusion | Field flips No-Go / back to Go | T2/T3 | Daily | GW-LIFTING | PRO |
| RF-OPS-07 | Equipment Availability | "Do I have the machines to hit today's plan?" | Fleet up/down roster, utilization %, gap vs demand | Equipment telemetry, ERP/CMMS, app schedule | Forecast-Engine | Equipment-Telemetry, Task-Orchestrator | Available units < scheduled demand | T1 | Hourly | EXT-DATA | BUSINESS |
| RF-OPS-08 | Equipment Failures | "What just broke and what does it stall?" | Fault list w/ affected fields/ops + downtime cost | Equipment telemetry (fault codes), ERP | LLM | Equipment-Telemetry, Financial-Model, Alert-Engine | Critical fault code / no-heartbeat | T1 | Real-time | EXT-DATA | BUSINESS |
| RF-OPS-09 | Roads Blocked | "Can trucks and crews actually move?" | Blocked-segment map, alt-route note | lband_sar change, whitebox_terrain, vision/segment | RT-DETR, GNN | Change-Detection, Terrain-Drainage, Object-Count | New obstruction/wash-out detected on route | T2/T3 | Per-pass | GW-LIFTING | PRO |
| RF-OPS-10 | Flooded Access | "Is water cutting off a field or the depot?" | Standing-water extent on access + fields | lband_sar (all-weather), whitebox_terrain | GNN | Water-Model, Terrain-Drainage, Change-Detection, Alert-Engine | SAR water on access route / pooling in low ground | T2 | Per-pass | LIVE | PRO |
| RF-OPS-11 | Water Tank Status | "Will we run dry mid-irrigation?" | Tank level %, hours-to-empty, refill ETA | Tank IoT level sensors, flow meters, weather | TiDE | Inventory-Ledger, Water-Model, Forecast-Engine | Level < reserve or drain rate spikes | T1 | 15 min | EXT-DATA | PRO |
| RF-OPS-12 | Chemical Inventory | "Will a stock-out halt spraying?" | On-hand vs planned use, days-of-cover, reorder list | ERP/inventory, spray plan, REI/label data | Forecast-Engine | Inventory-Ledger, Task-Orchestrator | Days-of-cover < lead time | T1 | Daily | EXT-DATA | BUSINESS |
| RF-OPS-13 | Fertilizer Inventory | "Do I have inputs to hit the fertigation plan?" | On-hand vs plan, N-P-K cover days, reorder | ERP/inventory, nutrient plan | Forecast-Engine | Inventory-Ledger, Forecast-Engine | Cover days < lead time | T1 | Daily | EXT-DATA | BUSINESS |
| RF-OPS-14 | Seed Inventory | "Can I finish planting with seed on hand?" | Seed lots vs remaining ha, shortfall by variety | ERP/inventory, planting plan | Forecast-Engine | Inventory-Ledger, Task-Orchestrator | Projected shortfall before window closes | T1 | Daily | EXT-DATA | BUSINESS |
| RF-OPS-15 | Work Orders | "Is the work actually getting assigned and done?" | Open/assigned/overdue WO board, aging | App WO state, crew roster, field signals | LLM | Work-Order-Engine, Task-Orchestrator, Alert-Engine | WO overdue / high-priority unassigned | T1 | Real-time | LIVE | PRO |
| RF-OPS-16 | AI Generated Tasks | "What should I be doing that I haven't thought of?" | Auto-drafted task list from live signals, ranked | signals-by-bbox, s2_ndvi, lst, sar, weather | Recommendation-LLM, Bayesian | Recommendation-LLM, Task-Orchestrator, Confidence-Scoring | New high-confidence action surfaced | T3 | Daily | LIVE | PRO |
| RF-OPS-17 | High Priority Alerts | "What is on fire right now?" | Live P1/P2 alert feed w/ impact + action | All EO signals, telemetry, inventory, weather | GNN, LLM | Alert-Engine, Sensor-Fusion(GNN), Executive-AI-Summarizer | Any P1 threshold crossed | T2 | Real-time | LIVE | PRO |
| RF-OPS-18 | Completed Activities | "Did what I ordered actually happen?" | Done-log w/ EO verification of field ops | App WO log, s2_ndvi/sar before-after | Chronos | Work-Order-Engine, Change-Detection, Confidence-Scoring | WO marked done but no field change detected | T2 | Daily | LIVE | PRO |
| RF-OPS-19 | Drone Missions | "Did we cover the fields we needed to see?" | Mission plan/coverage, flagged AOIs, gaps | DroneOps flight logs, orthomosaic, priority fields | YOLO12, SAM2 | Drone-Ops, Object-Count, Change-Detection | Priority field uncovered / new anomaly from flight | T2 | Per-mission | GW-LIFTING | BUSINESS |
| RF-OPS-20 | Inspection Schedule | "Am I missing a scout/audit that will bite me?" | Due/overdue inspection calendar, risk-ranked | App schedule, field risk signals, compliance rules | LLM | Task-Orchestrator, Risk-Engine, Compliance-Ledger | Inspection overdue on high-risk field | T1 | Daily | LIVE | PRO |
| RF-OPS-21 | Safety Incidents | "Will an injury or near-miss blow up on me?" | Incident log, trend, open corrective actions | EHS/HR incident feed, app reports | LLM | Safety-Ledger, Alert-Engine | New recordable incident / repeat hazard | T1 | Real-time | EXT-DATA | BUSINESS |
| RF-OPS-22 | Compliance Status | "Will an audit or Walmart spec fail us?" | Compliance scorecard by field/cert, gaps | Records, MRV, contract specs, EO evidence | LLM, Bayesian | Compliance-Ledger, Carbon-Engine, Confidence-Scoring | Requirement lapses / evidence gap before audit | T1/T2 | Daily | EXT-DATA | BUSINESS |
| RF-OPS-23 | Operations Bottlenecks | "What single constraint is choking the whole farm?" | Ranked bottleneck (asset/crew/field/input) + throughput loss | Fused: EO readiness, equipment, labor, inventory | GNN, LLM | Bottleneck-Analyzer, Sensor-Fusion(GNN), Financial-Model | Constraint throttles >X ha/day of plan | T2/T3 | Daily | EXT-DATA | BUSINESS |
| RF-OPS-24 | Resource Allocation | "Am I putting crews/machines where they matter most?" | Optimized assignment of crews/equipment to fields | Field priority, equipment roster, crew roster | XGBoost, LLM | Task-Orchestrator, Labor-Model, Equipment-Telemetry, Financial-Model | Allocation leaves a P1 field unserved | T3 | Daily | EXT-DATA | BUSINESS |
| RF-OPS-25 | Maintenance Queue | "Which machine fails next and when do I service it?" | Predictive maint queue, RUL, service windows | Equipment telemetry, CMMS history | Chronos, XGBoost | Equipment-Telemetry, Forecast-Engine, Task-Orchestrator | Predicted failure inside planned use window | T3 | Daily | EXT-DATA | BUSINESS |
| RF-OPS-26 | Emergency Response | "Is a storm/flood/fire about to hit and are we ready?" | Threat map, exposed assets/fields, action playbook | Weather NOAA/ECMWF, lband_sar, whitebox_terrain, roster | Temporal Transformer, GNN | Emergency-Playbook, Weather-Fusion, Water-Model, Alert-Engine | Severe-weather / flood / fire threat to assets | T2/T3 | Hourly (event) | EXT-DATA | BUSINESS |
| RF-OPS-27 | Shift Handover Brief | "What does the next shift need so nothing drops?" | Handover pack: open WOs, live alerts, in-progress ops, watch-items | App WO/alert state, in-flight ops, field signals | LLM | Executive-AI-Summarizer, Work-Order-Engine, Alert-Engine | Unclosed P1 item at shift boundary | T2 | Per-shift | LIVE | PRO |

## NEW primitives this family introduces

Field-Readiness-Index, Equipment-Telemetry, Inventory-Ledger, Work-Order-Engine, Task-Orchestrator, Labor-Model, Bottleneck-Analyzer, Compliance-Ledger, Safety-Ledger, Emergency-Playbook, Drone-Ops
