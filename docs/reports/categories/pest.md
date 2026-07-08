# Pest Intelligence Reports (Agronomist / IPM Lead) — Intelligence Recipe Matrix

## Persona & the fear it answers
The reader is the **Agronomist / IPM Lead** (and the regional farm manager who signs the spray invoice) whose job ends the day an infestation crosses a field line unnoticed. They do not want a bug map — they want to know *"Is something building I can't see yet, where is it, how fast is it spreading, is it worth treating, what do I spray, and will it come back?"* — early enough to act before defoliation, quota-miss, or a rejected shipment. This family fuses satellite canopy-stress screening, degree-day phenology, trap counts, and weather into a decision loop: detect → localize → predict spread → time the spray → prove it was worth the money. It sells **job security**: the agronomist who reads it catches the outbreak at the core, defends every spray decision with an economic threshold, and never explains to the Ops Director why 200 acres were lost to something that showed up in the traps three weeks ago. **Discipline: pest signals here are SCREENING corroborators, never a diagnosis — they point scouts and calibrate risk, they do not identify a species from orbit.**

## Shared pipeline (family)
```
                          PEST INTELLIGENCE — SHARED PIPELINE
  INPUTS                         PRIMITIVES                    MODELS
  ┌───────────────────┐          ┌──────────────────┐          ┌────────────────────┐
  │ /api/eo/scan      │          │ Vegetation-Indices│         │ YOLO12 / RT-DETR   │
  │  s2_ndvi (NDRE*)  │──parcel─▶│ Change-Detection  │──feat──▶│  (damage detect)   │
  │  landsat_lst      │  stats   │ Pest-Engine       │         │ SAM2 (patch seg)   │
  │  lband_sar        │          │ Degree-Day-Model  │         │ ViT (damage class) │
  │  stac_datacube    │          │ Trap-Fusion       │         │ XGBoost (risk/econ)│
  ├───────────────────┤          │ Weather-Fusion    │         │ Chronos/PatchTST   │
  │ /api/vision/segment│         │ Migration-Model   │         │  (Forecast-Engine) │
  │ /api/farm/        │          │ Economic-Threshold│         │ GNN (Sensor-Fusion)│
  │  signals-by-bbox  │          │ Beneficial-Balance│         │ Temporal Transformer│
  ├───────────────────┤          │ Resistance-Model  │         │ LLM (Recommend)    │
  │ EXT: weather NOAA │          │ Financial-Model   │         │ Bayesian (Confidence)│
  │  traps (pheromone/│          │ Risk-Engine       │         └─────────┬──────────┘
  │  sticky), spray Hx│          └────────┬─────────┘                   │
  │  market prices    │                   └──────────────┬──────────────┘
  └───────────────────┘                                  ▼
                                                ┌───────────────────┐
                                                │ Recommendation-LLM │
                                                │ + Confidence-Scoring│
                                                └─────────┬─────────┘
                                                          ▼
             OUTPUTS ─────────────▶ ALERT-ENGINE ─────────────▶ REPORT
   risk score, heatmap, spread     threshold crossed, hotspot   Scouting brief / spray
   vector, spray window, Rx,       forming, spray window open,   Rx PDF, dashboard,
   yield-loss $, confidence        reinfestation risk rising     scheduled + urgent alert
   * NDRE via index_calc (GW-LIFTING); s2_ndvi live today
```

## The Recipe Matrix

| Recipe ID | Report | Fear it answers | Output / KPI | Inputs (data sources) | AI Models | Primitives | Alert trigger | Confidence | Refresh | Buildability | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|
| RF-PST-01 | Pest Risk Score | "Is an infestation building before I can see it?" | Composite pest-risk index 0–100 per field/zone | eo/scan (s2_ndvi, landsat_lst), stac_datacube, weather NOAA, trap counts | XGBoost (risk), Bayesian (Confidence) | Pest-Engine, Vegetation-Indices, Weather-Fusion, Risk-Engine, Confidence-Scoring | Risk crosses action band | T3 (est.) | Weekly | GW-LIFTING | PRO |
| RF-PST-02 | Infestation Heatmap | "Where exactly is it and how bad?" | Per-zone infestation intensity surface | eo/scan (s2_ndvi), vision/segment (YOLO-seg patches), stac_datacube | YOLO12/RT-DETR (detect), SAM2 (seg) | Pest-Engine, Vegetation-Indices, Change-Detection, Object-Count | New high-intensity zone appears | T2 (screen) | Weekly | LIVE | PRO |
| RF-PST-03 | Pest Migration Prediction | "Will it spread into my clean fields?" | 7–14 day spread vector + probability surface | Infestation history, weather NOAA (wind), stac_datacube, farm/signals-by-bbox | GNN (Sensor-Fusion), Chronos, Temporal Transformer | Migration-Model, Pest-Engine, Weather-Fusion, Forecast-Engine, Sensor-Fusion(GNN) | Spread predicted into clean parcel | T3 (est.) | Daily | NEW-MODEL | BUSINESS |
| RF-PST-04 | Degree-Day Pest Model | "When will the next generation hatch?" | GDD accumulation vs lifecycle thresholds + emergence date | weather NOAA (temp), planting date, pest species profile | Degree-Day-Model (deterministic), Chronos (temp forecast) | Degree-Day-Model, Weather-Fusion, Phenology-Model, Forecast-Engine | GDD crosses emergence threshold | T1 (det.) | Daily | EXT-DATA | PRO |
| RF-PST-05 | Scouting Priority | "Where do I send scouts first with limited hours?" | Ranked zone scouting list + route | Pest-risk score, infestation heatmap, degree-day emergence, stac_datacube | XGBoost (priority), LLM (Recommendation) | Pest-Engine, Risk-Engine, Recommendation-LLM, Vegetation-Indices | New top-priority zone surfaces | T2 (screen) | Daily | GW-LIFTING | PRO |
| RF-PST-06 | Damage Estimate | "How much crop is already lost to pests?" | Damaged-area % + severity class per field | eo/scan (s2_ndvi), vision/segment (damage patches), stac_datacube (defoliation trend) | SAM2/YOLO-seg, ViT (damage class) | Pest-Engine, Vegetation-Indices, Change-Detection, Object-Count | Damage exceeds threshold % | T2 (screen) | Weekly | LIVE | PRO |
| RF-PST-07 | Beneficial-Insect Balance | "Am I about to nuke the predators controlling this?" | Pest:beneficial ratio + IPM balance status | Trap counts (pest + beneficial), scouting data, weather NOAA | XGBoost, Bayesian (Confidence) | Beneficial-Balance, Pest-Engine, Trap-Fusion, Confidence-Scoring | Ratio flips toward pest dominance | T3 (est.) | Weekly | EXT-DATA | PRO |
| RF-PST-08 | Trap-Catch Correlation | "Do trap counts confirm the satellite signal?" | Trap-vs-remote correlation + calibrated risk | Pheromone/sticky trap counts, eo/scan (s2_ndvi), weather NOAA | XGBoost, Bayesian, GNN (Sensor-Fusion) | Trap-Fusion, Pest-Engine, Vegetation-Indices, Sensor-Fusion(GNN), Confidence-Scoring | Trap-vs-remote divergence (blind spot) | T2 (screen) | Weekly | EXT-DATA | PRO |
| RF-PST-09 | Spray-Window | "When can I spray effectively and legally?" | Optimal window (efficacy × weather × REI/PHI) | Degree-day emergence, weather NOAA (wind/rain/temp), pest stage | Temporal Transformer (weather), LLM (Recommendation) | Weather-Fusion, Degree-Day-Model, Recommendation-LLM, Alert-Engine | Window opening/closing within 24–48h | T2 (screen) | Daily | EXT-DATA | PRO |
| RF-PST-10 | Resistance Risk | "Is this pest becoming resistant to my chemistry?" | Resistance-risk score by MOA/product + rotation flag | Spray history/ERP, trap-catch response trend, regional resistance DB | XGBoost, Bayesian (Confidence) | Resistance-Model, Pest-Engine, Risk-Engine, Confidence-Scoring | Repeated MOA / declining efficacy | T3 (est.) | Seasonal | EXT-DATA | BUSINESS |
| RF-PST-11 | Economic-Threshold | "Is it worth spraying yet, or wasting money?" | Pest density vs economic threshold + spray/no-spray call w/ $ | Infestation intensity, trap counts, market prices, treatment cost | XGBoost, LLM (Recommendation) | Economic-Threshold-Model, Pest-Engine, Financial-Model, Recommendation-LLM | Density crosses economic threshold | T3 (est.) | Weekly | EXT-DATA | PRO |
| RF-PST-12 | Yield-Loss Estimate | "What tonnage & revenue will this cost us?" | Projected yield + revenue loss $ from current pressure | Damage estimate, infestation, stac_datacube, market prices | XGBoost+Transformer (Yield-Model) | Yield-Model, Pest-Engine, Financial-Model, Vegetation-Indices | Projected loss exceeds $ threshold | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-PST-13 | Treatment Recommendation | "What exactly do I apply, where, at what rate?" | Product/rate/zone Rx + IPM alternatives | Pest stage, economic threshold, resistance risk, beneficial balance, weather | LLM (Recommendation), Bayesian (Confidence) | Recommendation-LLM, Pest-Engine, Economic-Threshold-Model, Resistance-Model, Confidence-Scoring | New Rx triggered by threshold crossing | T3 (est.) | On-demand | GW-LIFTING | PRO |
| RF-PST-14 | Reinfestation Risk | "Will it come back after I treat?" | Post-treatment reinfestation probability + monitoring cadence | Treatment history, degree-day (next gen), weather, migration surface | Chronos, Bayesian, Migration-Model | Pest-Engine, Degree-Day-Model, Migration-Model, Forecast-Engine, Confidence-Scoring | Reinfestation probability rises past floor | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-PST-15 | Hotspot Detection | "Show me outbreak cores before they explode." | Emerging hotspot clusters + growth rate | eo/scan (s2_ndvi, lband_sar change), stac_datacube, vision/segment | SAM2, RT-DETR, anomaly/change detection | Change-Detection, Pest-Engine, Vegetation-Indices, Object-Count, Alert-Engine | New hotspot cluster forms/grows | T2 (screen) | Weekly | LIVE | PRO |
| RF-PST-16 | Confidence | "How much can I trust this call before I spend?" | Per-report confidence score + evidence provenance + data-gap flags | All pest outputs, trap coverage, scene/cloud quality, weather completeness | Bayesian network | Confidence-Scoring, Sensor-Fusion(GNN), Pest-Engine | Confidence below decision floor | T1 (det.) | Per-report | LIVE | BASIC |

## NEW primitives this family introduces
- Degree-Day-Model
- Trap-Fusion
- Migration-Model
- Beneficial-Balance
- Economic-Threshold-Model
- Resistance-Model
