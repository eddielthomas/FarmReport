# Grocery Chain Compliance (Walmart-as-customer) — Intelligence Recipe Matrix

## Persona & the fear it answers
The reader is the **grocery-chain supply buyer** (Walmart, Kroger, Costco, Sysco tier) who owns a *portfolio of contracted growers* and personally signs off on whether the produce hits the DC on time, at spec, with the shelf life the planogram assumes. Their fear is not agronomy — it is **the empty shelf, the rejected truck, and the CEO asking why the promotion ran out of stock.** They get fired when a contracted farm silently slips its quota, when a load of berries arrives three days short on shelf life, when a disease or heat event wipes a sourcing region they never had visibility into, or when an ESG/traceability audit surfaces a supplier they can't document. This family turns Report.Farm's per-farm intelligence into a **buyer-side portfolio watchtower**: it rolls every contracted grower into fulfillment forecasts, quality/shelf-life predictions, disruption risk, replacement-supplier options, and audit-grade compliance evidence — so the buyer walks into the Monday category review already knowing which contracts are safe, which are at risk, and what the mitigation is.

## Shared pipeline (family)
```
                 GROCERY-CHAIN COMPLIANCE — SHARED PIPELINE (buyer portfolio view)
  INPUTS                          PRIMITIVES                     MODELS
  ┌────────────────────┐          ┌───────────────────┐          ┌─────────────────────┐
  │ /api/eo/scan       │          │ Vegetation-Indices│          │ XGBoost+Transformer │
  │  s2_ndvi           │──parcel─▶│ Phenology-Model   │──feat──▶ │  (Yield-Model)      │
  │  landsat_lst       │  stats   │ Yield-Model       │          │ Chronos/TiDE/PatchTST│
  │  lband_sar (aweather)│        │ Change-Detection  │          │  (Forecast-Engine)  │
  │  emit_minerals     │          │ Weather-Fusion    │          │ Temporal Transformer│
  │  stac_datacube     │          │ Disease-Engine    │          │  (Weather-Fusion)   │
  │  whitebox_terrain  │          │ Carbon-Engine     │          │ ViT (Disease screen)│
  ├────────────────────┤          │ Risk-Engine       │          │ GNN (Sensor-Fusion) │
  │ /api/gis/parcel    │          │ Fulfillment-Model │          │ Bayesian (Confidence)│
  │ /api/vision/*      │          │ ShelfLife-Model   │          │ LLM (Summarize+Rec) │
  │ /api/farm/signals  │          │ Compliance-Ledger │          └──────────┬──────────┘
  ├────────────────────┤          │ Financial-Model   │                     │
  │ EXT: weather NOAA/ │          │ Forecast-Engine   │                     │
  │  ECMWF, contracts/ │          │ Recommendation-LLM│                     │
  │  quota, ERP/inventory│        └─────────┬─────────┘                     │
  │  logistics/shipment │                   │            ┌──────────────────┘
  │  food-safety/audit  │                   └────────────┤
  │  supplier registry  │                                ▼
  └────────────────────┘                     ┌───────────────────────┐
                                             │ Portfolio-Rollup +     │
                                             │ Executive-AI-Summarizer│
                                             │ + Confidence-Scoring   │
                                             └──────────┬────────────┘
                                                        ▼
             OUTPUTS ───────────────▶ ALERT-ENGINE ───────────────▶ REPORT
   quota-fulfillment %, quality       quota-miss risk, reject risk,  Buyer portfolio PDF /
   grade, ship-date ETA, shelf-life   shelf-life short, disruption,  dashboard, scheduled
   days, risk register, replacement   compliance-gap, disease flag   brief + urgent alert
   supplier list, ESG/trace evidence
```

## The Recipe Matrix

| Recipe ID | Report | Fear it answers | Output / KPI | Inputs (data sources) | AI Models | Primitives | Alert trigger | Confidence | Refresh | Buildability | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|
| RF-GRO-01 | Which Farms May Miss Quota | "Which contracted grower silently blows my fulfillment?" | Per-grower projected volume vs. contracted quota + gap % | stac_datacube (season NDVI), eo/scan (s2_ndvi, landsat_lst), weather NOAA/ECMWF, contracts/quota | XGBoost+Transformer (Yield-Model), Chronos (Forecast) | Fulfillment-Model, Yield-Model, Phenology-Model, Forecast-Engine, Risk-Engine | Projected volume below quota band | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-GRO-02 | Which Growers Are Ahead | "Who can absorb extra demand or cover a shortfall?" | Growers ranked by surplus-vs-quota headroom | stac_datacube, eo/scan (s2_ndvi), contracts/quota, ERP | XGBoost (Yield-Model), Chronos (Forecast) | Fulfillment-Model, Yield-Model, Vegetation-Indices, Forecast-Engine | Grower surplus exceeds reallocation threshold | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-GRO-03 | Which Growers Are Behind | "Who is trending short so I can intervene early?" | Growers ranked by fulfillment deficit + trend slope | stac_datacube (season curve), eo/scan (s2_ndvi, lband_sar change), weather | XGBoost (Yield-Model), PatchTST (Forecast) | Fulfillment-Model, Change-Detection, Phenology-Model, Forecast-Engine | Deficit trend crosses intervention line | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-GRO-04 | Produce Quality Forecast | "Will the crop arrive at the grade I promised the planogram?" | Projected quality grade distribution per grower | eo/scan (s2_ndvi, landsat_lst, emit_minerals), stac_datacube, weather | XGBoost+Transformer (Yield/quality), ViT (screen) | Vegetation-Indices, Phenology-Model, Yield-Model, Confidence-Scoring | Projected grade below contract spec | T3 (est.) | Weekly | NEW-MODEL | PRO |
| RF-GRO-05 | Expected Shipment Dates | "When does each load actually hit my DC?" | Predicted harvest→ship ETA window per grower | stac_datacube (phenology), eo/scan (s2_ndvi, landsat_lst), weather, logistics/shipment | Chronos/TiDE (Forecast), Temporal Transformer | Phenology-Model, Fulfillment-Model, Forecast-Engine, Weather-Fusion | ETA slips past delivery window | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-GRO-06 | Supply Shortages | "Where is my portfolio going to run short vs. demand?" | Aggregate supply-vs-demand gap by SKU/region | stac_datacube, eo/scan (s2_ndvi), contracts/quota, ERP/inventory | XGBoost (Yield-Model), Chronos (Forecast) | Fulfillment-Model, Yield-Model, Forecast-Engine, Risk-Engine | Portfolio gap exceeds buffer stock | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-GRO-07 | Weather Disruption Risk | "Will heat/frost/flood hit a sourcing region I depend on?" | Per-region weather-peril risk score + exposed volume | weather NOAA/ECMWF, eo/scan (landsat_lst, lband_sar), whitebox_terrain, gis/parcel | Temporal Transformer (Weather-Fusion), Bayesian | Weather-Fusion, Risk-Engine, Terrain-Drainage, Confidence-Scoring | Peril probability × exposed volume high | T3 (est.) | Daily | GW-LIFTING | BUSINESS |
| RF-GRO-08 | Disease Outbreak Risk | "Could a disease wipe a supplier before I can re-source?" | Per-grower disease-pressure screening score (corroborator) | eo/scan (s2_ndvi, landsat_lst), stac_datacube, weather (humidity/temp) | ViT (Disease screen), Temporal Transformer | Disease-Engine, Vegetation-Indices, Weather-Fusion, Confidence-Scoring | Screening pressure crosses alert band (screening, not diagnosis) | T2 (screen) | Weekly | NEW-MODEL | BUSINESS |
| RF-GRO-09 | Shelf-Life Forecast | "Will this load arrive with the shelf-life my shelves need?" | Predicted post-harvest shelf-life days per grower/load | eo/scan (landsat_lst heat stress, s2_ndvi), stac_datacube, weather, logistics/shipment | XGBoost+Transformer (ShelfLife), Chronos | ShelfLife-Model, Vegetation-Indices, Phenology-Model, Weather-Fusion | Predicted shelf-life below planogram floor | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-GRO-10 | Replacement Supplier Recommendations | "If a grower fails, who covers me and by when?" | Ranked backup suppliers with volume/quality/ETA match | supplier registry, stac_datacube, eo/scan, contracts, logistics | LLM (Recommendation), XGBoost (Yield-Model) | Recommendation-LLM, Fulfillment-Model, Yield-Model, Risk-Engine | Primary grower flagged at-risk triggers backup list | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-GRO-11 | Carbon Footprint | "Can I document Scope-3 farm carbon for the sustainability report?" | Per-grower & portfolio carbon-intensity estimate + trend | emit_minerals, eo/scan (s2_ndvi, landsat_lst), stac_datacube, whitebox_terrain | GNN (Sensor-Fusion), XGBoost (biomass est.) | Carbon-Engine, Vegetation-Indices, Compliance-Ledger, Confidence-Scoring | Carbon intensity above buyer target | T3 (est.) | Monthly | GW-LIFTING | BUSINESS |
| RF-GRO-12 | Food Safety Risk | "Which supplier is the contamination/recall risk I can't see?" | Per-grower food-safety risk score (water/flood/proximity screen) | whitebox_terrain (flood/pooling), lband_sar (change), eo/scan, food-safety/audit feed | Bayesian (Confidence), GNN (Sensor-Fusion) | Risk-Engine, Terrain-Drainage, Water-Model, Compliance-Ledger | Flood/runoff proximity or audit gap flagged (screening) | T2 (screen) | Weekly | EXT-DATA | BUSINESS |
| RF-GRO-13 | ESG Compliance | "Can I defend every supplier's ESG to the auditor and the CEO?" | Portfolio ESG scorecard + per-grower compliance status | emit_minerals, eo/scan (s2_ndvi, landsat_lst), whitebox_terrain, audit feed, supplier registry | GNN (Sensor-Fusion), LLM (Summarizer) | Carbon-Engine, Water-Model, Compliance-Ledger, Executive-AI-Summarizer, Confidence-Scoring | Any supplier drops below compliance floor | T2 (screen) | Monthly | EXT-DATA | BUSINESS |
| RF-GRO-14 | Traceability Confidence | "Can I prove where every lot came from if audited today?" | Per-lot traceability confidence % + evidence-chain gaps | gis/parcel, eo/scan (scan provenance), stac_datacube, contracts, supplier registry | Bayesian (Confidence), LLM (Summarizer) | Compliance-Ledger, Confidence-Scoring, Change-Detection, Executive-AI-Summarizer | Trace confidence below audit threshold | T2 (screen) | Weekly | EXT-DATA | BUSINESS |
| RF-GRO-15 | Contract Risk | "Which contracts are most likely to breach and cost me?" | Ranked contract-breach risk × penalty $ exposure | contracts/quota, Fulfillment-Model output, eo/scan, weather | Bayesian (Confidence), LLM (Summarizer) | Risk-Engine, Fulfillment-Model, Financial-Model, Confidence-Scoring | Breach probability × $ penalty crosses high band | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-GRO-16 | Delivery Confidence | "How sure am I this week's committed loads actually land?" | Portfolio delivery-confidence % by SKU + at-risk loads | Fulfillment-Model, logistics/shipment, weather, eo/scan (lband_sar all-weather) | Chronos (Forecast), Bayesian (Confidence) | Fulfillment-Model, Weather-Fusion, Forecast-Engine, Confidence-Scoring | Delivery confidence below service-level floor | T3 (est.) | Daily | EXT-DATA | BUSINESS |
| RF-GRO-17 | Weekly Executive Briefing | "What do I tell the category VP Monday about my suppliers?" | One-page portfolio digest: fulfillment, risks, actions | all above outputs, contracts, weather, ERP | LLM (Exec-Summarizer), Bayesian (Confidence) | Executive-AI-Summarizer, Portfolio-Rollup, Risk-Engine, Recommendation-LLM, Confidence-Scoring | Portfolio health drops a band vs prior week | T3 (est.) | Weekly | GW-LIFTING | BUSINESS |
| RF-GRO-18 | Seasonal Outlook | "What does the whole season look like across my supply base?" | Season-long supply/quality/risk projection by region | stac_datacube (full season), eo/scan (all), weather ECMWF seasonal, contracts | Chronos/TiDE (Forecast), XGBoost (Yield-Model), LLM | Forecast-Engine, Yield-Model, Fulfillment-Model, Weather-Fusion, Executive-AI-Summarizer | Seasonal projection below plan for any region | T3 (est.) | Monthly | GW-LIFTING | BUSINESS |

## NEW primitives this family introduces
- Fulfillment-Model
- ShelfLife-Model
- Compliance-Ledger
- Portfolio-Rollup
