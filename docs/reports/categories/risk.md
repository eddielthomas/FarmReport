# Risk Management Reports (Exec / Insurer / Lender) — Intelligence Recipe Matrix

## Persona & the fear it answers
The reader is the **Operations Director, insurer, or lender** whose job is to *quantify and hedge every threat before it becomes a loss*. They are the person who gets fired when the farm misses quota, when Walmart rejects a shipment, when a disease or drought or hail event torches a quarter's margin, or when a covenant breaks. They do not want a pretty map — they want every peril expressed as **probability × dollar exposure**, ranked, with a hedge attached. This family converts the whole platform's signal into a defensible risk register: composite risk index, per-peril scores (weather, disease, pest, water, flood, frost, hail), counterparty and market risk, compliance and food-safety exposure, liquidity headroom, and the ROI of every mitigation. It sells **job security to the risk-owner**: they walk into the underwriting call, the board meeting, or the bank review already knowing what could blow up, what it's worth, and what they've done about it. Every peril claim here is a **screening/estimate corroborator (T2/T3), never a regulatory or diagnostic verdict.**

## Shared pipeline (family)
```
                          RISK MANAGEMENT REPORTS — SHARED PIPELINE
  INPUTS                         PRIMITIVES                    MODELS
  ┌───────────────────┐          ┌──────────────────┐          ┌────────────────────┐
  │ /api/eo/scan      │          │ Vegetation-Indices│         │ Temporal Transformer│
  │  s2_ndvi          │──parcel─▶│ Water-Model       │──feat──▶│  (Weather-Fusion)   │
  │  landsat_lst      │  stats   │ Change-Detection  │         │ Chronos/TiDE/PatchTST│
  │  lband_sar (SAR)  │          │ Weather-Fusion    │         │  (Forecast-Engine)  │
  │  emit_minerals    │          │ Disease/Pest-Eng  │         │ XGBoost+Transformer │
  │  stac_datacube    │          │ Peril-Model       │         │  (Yield-Model)      │
  │  whitebox_terrain │          │ Terrain-Drainage  │         │ ViT (Disease) / GNN │
  ├───────────────────┤          │ Financial-Model   │         │  (Sensor-Fusion)    │
  │ /api/gis/parcel   │          │ Risk-Engine       │         │ Bayesian network    │
  │ /api/vision/*     │          │ Market/Liquidity  │         │  (Confidence)       │
  ├───────────────────┤          │ Supply-Chain-Graph│         │ LLM (Exec-Summary + │
  │ EXT: NOAA/ECMWF   │          └────────┬─────────┘         │  Recommendation)    │
  │  market/commodity │                    │                   └─────────┬──────────┘
  │  contracts/quota  │                    └──────────────┬──────────────┘
  │  labor/HR, equip  │                                   ▼
  │  ERP/AR-AP/debt   │                         ┌───────────────────┐
  │  regulatory/audit │                         │ Risk-Engine +      │
  │  geopolitical/news│                         │ Confidence-Scoring │
  └───────────────────┘                         └─────────┬─────────┘
                                                          ▼
             OUTPUTS ─────────────▶ ALERT-ENGINE ─────────────▶ REPORT
   Risk register (prob × $),        peril threshold breach,      Underwriting/board-grade
   per-peril scores, VaR,           covenant/quota-miss risk,    PDF + risk dashboard,
   exposure vs coverage, ROI        rejection/exposure spike     scheduled + urgent alert
```

## The Recipe Matrix

| Recipe ID | Report | Fear it answers | Output / KPI | Inputs (data sources) | AI Models | Primitives | Alert trigger | Confidence | Refresh | Buildability | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|
| RF-RSK-01 | Composite Farm Risk Index | "What's my single overall risk number?" | Composite risk score 0–100 + top drivers | eo/scan (all), weather NOAA, market px, ERP, contracts | GNN (Sensor-Fusion), Bayesian (Confidence), LLM | Risk-Engine, Sensor-Fusion(GNN), Confidence-Scoring, Executive-AI-Summarizer | Index crosses red band vs prior period | T3 (est.) | Weekly | GW-LIFTING | BUSINESS |
| RF-RSK-02 | Production Risk | "Will something stop us hitting output?" | Production-at-risk score + tonnage exposure | stac_datacube, s2_ndvi, landsat_lst, weather, contracts | XGBoost+Transformer (Yield-Model), Bayesian | Yield-Model, Risk-Engine, Phenology-Model, Confidence-Scoring | Production-at-risk > quota buffer | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-RSK-03 | Weather Risk | "Is the forecast about to wreck the crop?" | Weather-hazard risk score + hazard timeline | weather NOAA/ECMWF, GPM, landsat_lst | Temporal Transformer (Weather-Fusion), Chronos | Weather-Fusion, Forecast-Engine, Risk-Engine, Alert-Engine | Hazard index crosses threshold in window | T3 (est.) | Daily | EXT-DATA | PRO |
| RF-RSK-04 | Disease Risk | "Is a disease outbreak about to hit us?" | Disease-pressure *screening* score by block | s2_ndvi, NDRE (index_calc), landsat_lst, weather humidity | ViT (Disease-Engine), Temporal Transformer | Disease-Engine, Weather-Fusion, Vegetation-Indices, Confidence-Scoring | Pressure score crosses screening band | T2 (screen) | Weekly | NEW-MODEL | PRO |
| RF-RSK-05 | Pest Risk | "Are pests going to swarm this block?" | Pest-pressure / migration risk score | s2_ndvi change, landsat_lst, weather, degree-days | Pest-Engine model, Temporal Transformer | Pest-Engine, Weather-Fusion, Change-Detection, Confidence-Scoring | Migration/GDD threshold crossed | T3 (est.) | Weekly | NEW-MODEL | PRO |
| RF-RSK-06 | Water / Drought Risk | "Will drought starve the crop?" | Drought risk index + water-deficit exposure | SMAP, GPM, landsat_lst (ET proxy), s2_ndvi, tau_omega | Chronos/TiDE (Forecast), Bayesian | Water-Model, Forecast-Engine, Risk-Engine, Weather-Fusion | Drought index crosses severity band | T3 (est.) | Weekly | GW-LIFTING | PRO |
| RF-RSK-07 | Flood Risk | "Could a flood drown a field?" | Flood-exposure score + pooling extent | whitebox_terrain (TWI), lband_sar, GPM rainfall, DEM | Peril-Model, Bayesian | Terrain-Drainage, Water-Model, Peril-Model, Weather-Fusion | Rainfall + saturation crosses flood threshold | T2 (screen) | Per event | GW-LIFTING | PRO |
| RF-RSK-08 | Frost Risk | "Will a frost kill the bloom overnight?" | Frost probability + $ crop-at-risk | weather NOAA/ECMWF temp, landsat_lst, phenology stage | Temporal Transformer (Weather-Fusion), Peril-Model | Weather-Fusion, Peril-Model, Phenology-Model, Alert-Engine | Forecast temp < frost threshold at sensitive stage | T2 (screen) | Daily | EXT-DATA | PRO |
| RF-RSK-09 | Market / Price Risk | "Could a price crash gut revenue?" | Price VaR + revenue-at-risk band | market/commodity prices, contracts, yield est | Chronos/TiDE (Forecast), Bayesian | Market-Risk-Model, Financial-Model, Forecast-Engine, Confidence-Scoring | Price VaR breaches tolerance | T3 (est.) | Daily | EXT-DATA | BUSINESS |
| RF-RSK-10 | Contract-Default Risk | "Will a buyer/supplier default on us?" | Counterparty default probability + $ exposure | contracts, buyer/supplier data, payment history | XGBoost, Bayesian | Financial-Model, Risk-Engine, Confidence-Scoring | Default probability crosses band | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-RSK-11 | Insurance Exposure | "Are we under/over-insured if a peril hits?" | Peril exposure $ vs coverage gap | eo/scan (lband_sar, landsat_lst), weather, gis/parcel, policy data | Bayesian (Confidence), Peril-Model | Insurance-Exposure-Model, Peril-Model, Risk-Engine, Financial-Model | Modeled exposure exceeds coverage | T3 (est.) | Monthly | EXT-DATA | BUSINESS |
| RF-RSK-12 | Labor Risk | "Will we lack the crew to harvest?" | Labor-shortfall risk + harvest-window impact | labor/HR, harvest window (phenology), scheduling | XGBoost, LLM (Recommendation) | Risk-Engine, Phenology-Model, Financial-Model, Recommendation-LLM | Projected crew < demand in window | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-RSK-13 | Equipment-Failure Risk | "Will a machine fail mid-harvest?" | Failure-risk score per asset + downtime $ | equipment telemetry, maintenance log | XGBoost/Chronos (anomaly forecast) | Sensor-Fusion(GNN), Forecast-Engine, Financial-Model, Alert-Engine | Fault-risk spike or maintenance overdue | T3 (est.) | Real-time | EXT-DATA | BUSINESS |
| RF-RSK-14 | Supply-Disruption Risk | "Will inputs/logistics stall production?" | Supply-chain disruption risk map + node exposure | supplier/ERP, logistics feeds, geopolitical | GNN, LLM (Summarizer) | Supply-Chain-Graph, Risk-Engine, Confidence-Scoring, Executive-AI-Summarizer | Critical node risk crosses band | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-RSK-15 | Food-Safety Risk | "Could contamination trigger a recall/rejection?" | Food-safety *screening* score + hotspot flags | irrigation water source, landsat_lst, flood proximity, audit log | Bayesian, LLM | Food-Safety-Engine, Water-Model, Risk-Engine, Confidence-Scoring | Contamination-risk indicator crosses band | T2 (screen) | Weekly | EXT-DATA | BUSINESS |
| RF-RSK-16 | Compliance Risk | "Are we about to fail an audit/reg?" | Compliance-gap risk register + deadline exposure | regulatory feeds, MRV/ERP, certification records | LLM, Bayesian | Compliance-Engine, Regulatory-Feed, Risk-Engine, Alert-Engine | Gap or deadline crosses threshold | T1 (determ.) | Weekly | EXT-DATA | BUSINESS |
| RF-RSK-17 | Financial / Liquidity Risk | "Can we make payroll & covenants?" | Liquidity risk score + cash-runway/covenant headroom | ERP cash, AR/AP, debt covenants, revenue forecast | Chronos (Forecast), Bayesian | Liquidity-Model, Financial-Model, Forecast-Engine, Confidence-Scoring | Runway/covenant headroom < buffer | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-RSK-18 | Catastrophe / Hail Risk | "Could a hailstorm total the crop?" | Cat-peril probability + $ crop-at-risk | weather NOAA (hail/storm), lband_sar, landsat_lst, gis/parcel | Peril-Model, Temporal Transformer | Peril-Model, Weather-Fusion, Financial-Model, Alert-Engine | Storm/hail probability crosses threshold | T2 (screen) | Daily | EXT-DATA | PRO |
| RF-RSK-19 | Yield-Shortfall Probability | "How likely is yield to miss target?" | P(yield < target) + shortfall distribution | stac_datacube, s2_ndvi, landsat_lst, weather | XGBoost+Transformer (Yield-Model), Bayesian | Yield-Model, Phenology-Model, Confidence-Scoring, Forecast-Engine | Shortfall probability crosses band | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-RSK-20 | Quota-Miss Probability | "How likely are we to miss the contract quota?" | P(volume < contracted) + gap band | Yield-Model output, contracts/quota, phenology | XGBoost+Transformer (Yield), Chronos | Yield-Model, Forecast-Engine, Risk-Engine, Confidence-Scoring | Miss probability > tolerance | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-RSK-21 | Quality-Rejection Risk | "Will Walmart reject this shipment?" | Rejection-risk score by lot + spec gap | s2_ndvi / NDRE, landsat_lst, phenology maturity, buyer spec sheet | ViT / XGBoost, Bayesian | Vegetation-Indices, Phenology-Model, Risk-Engine, Confidence-Scoring | Quality proxy below buyer spec band | T2 (screen) | Weekly | NEW-MODEL | BUSINESS |
| RF-RSK-22 | ESG / Reputational Risk | "Could an ESG lapse cost us the buyer?" | ESG/reputational risk score + exposure drivers | emit_minerals, s2_ndvi, whitebox_terrain, MRV, news feed | GNN (Sensor-Fusion), LLM | Carbon-Engine, Risk-Engine, Confidence-Scoring, Executive-AI-Summarizer | Score below buyer/compliance floor or adverse event | T3 (est.) | Monthly | EXT-DATA | BUSINESS |
| RF-RSK-23 | Geopolitical / Export Risk | "Could a border/tariff shock block exports?" | Export-risk score by market/route + revenue exposure | geopolitical feeds, trade/tariff data, contracts | LLM, Bayesian | Geopolitical-Feed, Supply-Chain-Graph, Financial-Model, Risk-Engine | Route/market risk crosses band | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-RSK-24 | Biosecurity Risk | "Is an incursion about to breach our farm?" | Biosecurity threat score + proximity/spread map | pest/disease outbreak feeds, lband_sar, s2_ndvi, movement data | Pest-Engine/GNN, Temporal Transformer | Biosecurity-Engine, Pest-Engine, Disease-Engine, Change-Detection | Nearby incursion or spread-risk threshold | T3 (est.) | Daily | NEW-MODEL | BUSINESS |
| RF-RSK-25 | Risk-Mitigation ROI | "Which risk fixes are worth paying for?" | Ranked mitigation actions + $ risk-reduction / ROI | All RF-RSK outputs, cost ledger, intervention library | LLM (Recommendation), Bayesian | Recommendation-LLM, Risk-Engine, Financial-Model, Confidence-Scoring | New high-ROI mitigation surfaces | T3 (est.) | Monthly | GW-LIFTING | BUSINESS |

## NEW primitives this family introduces
Peril-Model, Market-Risk-Model, Insurance-Exposure-Model, Supply-Chain-Graph, Food-Safety-Engine, Compliance-Engine, Liquidity-Model, Geopolitical-Feed, Biosecurity-Engine
