# Executive Reports (CEO / Farm Owner) — Intelligence Recipe Matrix

## Persona & the fear it answers
The reader is the **Farm Owner / CEO / Operations Director** who stands in front of a board, a bank, and a quarterly number. They do not want a map — they want to walk into Monday's meeting already knowing the answer to *"Will we hit the target, what threatens it, and what is it worth in dollars?"* This family rolls every field, sensor, forecast, and risk in the platform up into one board-grade narrative: production vs. quota, revenue/profit trajectory, portfolio health, operational readiness, risk & insurance exposure, and the sustainability/ESG numbers the bank and buyers now demand. It sells **job security**: the CEO who reads it never gets blindsided, and always has a defensible story for the shipment that slipped, the yield that dropped, or the covenant they might miss.

## Shared pipeline (family)
```
                          EXECUTIVE REPORTS — SHARED PIPELINE
  INPUTS                         PRIMITIVES                    MODELS
  ┌───────────────────┐          ┌──────────────────┐          ┌────────────────────┐
  │ /api/eo/scan      │          │ Vegetation-Indices│         │ Chronos / TiDE /   │
  │  s2_ndvi          │──parcel─▶│ Water-Model       │──feat──▶│  PatchTST (forecast)│
  │  landsat_lst      │  stats   │ Change-Detection  │         │ XGBoost+Transformer │
  │  lband_sar        │          │ Phenology-Model   │         │  (Yield-Model)      │
  │  emit_minerals    │          │ Terrain-Drainage  │         │ Temporal Transformer│
  │  stac_datacube    │          │ Carbon-Engine     │         │  (Weather-Fusion)   │
  │  whitebox_terrain │          │ Risk-Engine       │         │ GNN (Sensor-Fusion) │
  ├───────────────────┤          │ Financial-Model   │         │ Bayesian (Confidence)│
  │ /api/gis/parcel   │          │ Object-Count      │         │ LLM (Exec-Summarizer│
  │ /api/vision/*     │          │ Forecast-Engine   │         │  + Recommendation)  │
  ├───────────────────┤          └────────┬─────────┘         └─────────┬──────────┘
  │ EXT: weather NOAA │                    │                             │
  │  market/commodity │                    └──────────────┬──────────────┘
  │  ERP/inventory    │                                   ▼
  │  labor/HR, equip  │                         ┌───────────────────┐
  │  contracts/quota  │                         │ Executive-AI-      │
  └───────────────────┘                         │ Summarizer +       │
                                                │ Confidence-Scoring │
                                                └─────────┬─────────┘
                                                          ▼
             OUTPUTS ─────────────▶ ALERT-ENGINE ─────────────▶ REPORT
   KPI tiles, target-vs-actual,    covenant breach, quota-miss   Board-grade PDF /
   $ impact, portfolio rollup,     risk, buyer-reject risk,      dashboard, scheduled
   risk register, ESG score        exposure spike                brief + urgent alert
```

## The Recipe Matrix

| Recipe ID | Report | Fear it answers | Output / KPI | Inputs (data sources) | AI Models | Primitives | Alert trigger | Confidence | Refresh | Buildability | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|
| RF-EXE-01 | Executive Summary | "What's the one-page truth I tell the board?" | Single-page health index + top 3 risks + $ impact | eo/scan (s2_ndvi, lband_sar), gis/parcel, ERP, market prices | LLM (Exec-Summarizer), Bayesian (Confidence) | Executive-AI-Summarizer, Risk-Engine, Financial-Model, Confidence-Scoring | Composite health drops >1 band vs prior period | T3 (est.) | Weekly | GW-LIFTING | BUSINESS |
| RF-EXE-02 | Weekly Executive Brief | "What changed this week I must know before Monday?" | Δ-since-last-week digest, movers, action items | eo/scan (s2_ndvi, lband_sar change), stac_datacube, weather NOAA | LLM (Exec-Summarizer), Temporal Transformer | Change-Detection, Weather-Fusion, Executive-AI-Summarizer, Alert-Engine | Any field crosses stress/change threshold | T2 (screen) | Weekly | LIVE | PRO |
| RF-EXE-03 | Monthly Business Review | "Are we on plan vs. board commitments?" | MoM plan-vs-actual across prod/rev/cost | ERP, market prices, eo/scan, contracts/quota | Chronos (Forecast), LLM (Summarizer) | Financial-Model, Forecast-Engine, Executive-AI-Summarizer | Any pillar >10% off plan | T3 (est.) | Monthly | EXT-DATA | BUSINESS |
| RF-EXE-04 | Farm Scorecard | "How healthy is the whole operation at a glance?" | Weighted A–F score across 6 domains | eo/scan (all), gis/parcel, whitebox_terrain, ERP | GNN (Sensor-Fusion), Bayesian (Confidence) | Sensor-Fusion(GNN), Vegetation-Indices, Water-Model, Financial-Model, Confidence-Scoring | Overall grade drops a letter | T2 (screen) | Weekly | GW-LIFTING | PRO |
| RF-EXE-05 | Production Forecast | "Will we hit the tonnage quota?" | Projected yield vs. contracted volume + gap | stac_datacube (season NDVI), eo/scan (s2_ndvi, landsat_lst), weather, contracts | XGBoost+Transformer (Yield-Model), Chronos | Yield-Model, Phenology-Model, Forecast-Engine, Vegetation-Indices | Projection falls below quota band | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-EXE-06 | Revenue Forecast | "What's the top-line I can promise the bank?" | Projected revenue range by crop + confidence band | Yield-Model output, market/commodity prices, contracts | Chronos/TiDE (Forecast), XGBoost (Yield) | Forecast-Engine, Yield-Model, Financial-Model, Confidence-Scoring | Revenue P50 drops >X% vs plan | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-EXE-07 | Profit Forecast | "Will margin survive input & labor costs?" | Projected net margin, cost-to-revenue bridge | Revenue-Forecast, input/ERP costs, labor/HR, equipment telemetry | Chronos (Forecast), LLM (Summarizer) | Financial-Model, Forecast-Engine, Executive-AI-Summarizer | Projected margin below covenant/target | T3 (est.) | Monthly | EXT-DATA | BUSINESS |
| RF-EXE-08 | Crop Portfolio Report | "Which crops carry us and which bleed cash?" | Per-crop yield/margin/risk matrix, rank | eo/scan per parcel, stac_datacube, market prices, ERP | XGBoost (Yield), LLM (Summarizer) | Yield-Model, Financial-Model, Vegetation-Indices, Risk-Engine | A crop flips to negative contribution | T3 (est.) | Monthly | EXT-DATA | BUSINESS |
| RF-EXE-09 | Operational Readiness | "Are we ready for planting/harvest window?" | Readiness index (soil, machinery, labor, water) | whitebox_terrain, eo/scan (landsat_lst, s2_ndvi), equipment telemetry, labor/HR | GNN (Sensor-Fusion), LLM (Summarizer) | Terrain-Drainage, Water-Model, Sensor-Fusion(GNN), Object-Count | Readiness index below go-threshold near window | T2 (screen) | Weekly | GW-LIFTING | PRO |
| RF-EXE-10 | Asset Utilization | "Are machines & land earning or idling?" | Utilization % per asset, idle-cost $ | equipment telemetry, gis/parcel, vision/segment (machinery count) | RT-DETR (Object-Count), XGBoost | Object-Count, Financial-Model, Sensor-Fusion(GNN) | Utilization drops below cost-efficiency line | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-EXE-11 | Executive Risk Report | "What's most likely to blow up the quarter?" | Ranked risk register + probability × $ impact | eo/scan (all), weather NOAA, market prices, contracts | Bayesian (Confidence), LLM (Summarizer) | Risk-Engine, Change-Detection, Weather-Fusion, Financial-Model, Confidence-Scoring | Any risk crosses high probability × high $ | T3 (est.) | Weekly | GW-LIFTING | BUSINESS |
| RF-EXE-12 | Insurance Exposure | "Are we under/over-insured if a peril hits?" | Exposure $ by peril vs. coverage gap | eo/scan (lband_sar, landsat_lst), weather NOAA, gis/parcel, policy data | Bayesian (Confidence), Chronos | Risk-Engine, Weather-Fusion, Financial-Model, Change-Detection | Modeled exposure exceeds coverage | T3 (est.) | Monthly | EXT-DATA | BUSINESS |
| RF-EXE-13 | Sustainability Score | "Can I defend our ESG number to bank & buyers?" | Composite ESG score (carbon, water, soil) + trend | emit_minerals, eo/scan (s2_ndvi, landsat_lst), whitebox_terrain, stac_datacube | GNN (Sensor-Fusion), Bayesian (Confidence) | Carbon-Engine, Water-Model, Vegetation-Indices, Confidence-Scoring | Score drops below buyer/compliance floor | T2 (screen) | Monthly | GW-LIFTING | BUSINESS |
| RF-EXE-14 | Carbon Opportunity | "Where's the carbon-credit revenue upside?" | Estimated sequestration + credit $ potential | stac_datacube (biomass proxy), emit_minerals, s2_ndvi, whitebox_terrain | XGBoost (biomass est.), LLM (Summarizer) | Carbon-Engine, Vegetation-Indices, Financial-Model, Recommendation-LLM | Credit-eligible acreage/practice detected | T3 (est.) | Monthly | GW-LIFTING | BUSINESS |
| RF-EXE-15 | Water Consumption | "Is water use blowing budget or compliance?" | Water-use estimate vs. allocation/budget | landsat_lst (ET proxy), s2_ndvi, whitebox_terrain, weather NOAA | Temporal Transformer, Chronos | Water-Model, Terrain-Drainage, Weather-Fusion, Forecast-Engine | Usage projection exceeds allocation | T2 (screen) | Weekly | GW-LIFTING | PRO |
| RF-EXE-16 | Labor Efficiency | "Is labor cost per unit killing margin?" | Labor $/acre & $/ton, productivity trend | labor/HR, ERP, gis/parcel, equipment telemetry | XGBoost, LLM (Summarizer) | Financial-Model, Sensor-Fusion(GNN), Executive-AI-Summarizer | Labor cost/unit exceeds benchmark | T3 (est.) | Monthly | EXT-DATA | BUSINESS |
| RF-EXE-17 | Infrastructure Status | "Are roads/buildings/irrigation failing on us?" | Asset condition index + change flags | vision/segment, lband_sar (change), eo/scan, whitebox_terrain | SAM2 (segmentation), RT-DETR (Object-Count) | Object-Count, Change-Detection, Terrain-Drainage, Alert-Engine | Structural/asset change detected | T2 (screen) | Monthly | LIVE | PRO |
| RF-EXE-18 | Strategic Recommendations | "What 3 moves should I make this quarter?" | Prioritized action list + expected $ ROI | All above outputs, market prices, contracts | LLM (Recommendation), Bayesian (Confidence) | Recommendation-LLM, Financial-Model, Risk-Engine, Executive-AI-Summarizer, Confidence-Scoring | New high-ROI action surfaces | T3 (est.) | Monthly | GW-LIFTING | BUSINESS |

## NEW primitives this family introduces
- Executive-AI-Summarizer
- Financial-Model
- Forecast-Engine(time-series)
- Risk-Engine
- Confidence-Scoring
- Recommendation-LLM
- Carbon-Engine
