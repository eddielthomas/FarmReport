# Disease Intelligence Reports (Agronomist / Exec) — Intelligence Recipe Matrix

## Persona & the fear it answers
The reader is the **Head Agronomist** and the **Operations Director** at a Dole / Del Monte / Driscoll's / Cargill-scale grower who lies awake asking *"Will disease quietly wipe out a section before I see it, and will I find out in time to spray, quarantine, and still fill the Walmart order?"* A missed blight front or a rust outbreak that jumps a block isn't a map problem — it's a blown quota, a rejected shipment, and a firing. This family turns canopy-stress screening, weather-coupled spread modeling, and per-disease detection into a **decide-and-act layer**: it flags where infection is likely, predicts how fast and which way it moves, prices the yield and dollar loss, recommends the fungicide and the spray window, and draws the quarantine line — every output an honest **screening corroborator**, never a diagnosis. It sells job security to the person who has to tell the CEO Monday whether Section 7 is still worth harvesting.

## Shared pipeline (family)
```
                       DISEASE INTELLIGENCE — SHARED PIPELINE
  INPUTS                         PRIMITIVES                    MODELS
  ┌───────────────────┐          ┌──────────────────┐          ┌────────────────────┐
  │ /api/eo/scan      │          │ Vegetation-Indices│         │ ViT (Symptom-      │
  │  s2_ndvi          │──parcel─▶│ (NDVI/NDRE stress)│──feat──▶│  Detector / disease)│
  │  landsat_lst      │  stats   │ Change-Detection  │         │ Chronos/PatchTST   │
  │  lband_sar (change)│         │ Weather-Fusion    │         │  (Forecast-Engine) │
  │  stac_datacube    │          │ Terrain-Drainage  │         │ Temporal Transformer│
  │  whitebox_terrain │          │ Disease-Engine    │         │  (Weather-Fusion)  │
  ├───────────────────┤          │ Spore-Dispersal   │         │ XGBoost+Transformer│
  │ /api/gis/parcel   │          │ Yield-Model       │         │  (Yield-Model)     │
  │  delineate        │          │ Financial-Model   │         │ GNN (Sensor-Fusion)│
  │ /api/vision/*     │          │ Risk-Engine       │         │ Bayesian (Confidence│
  ├───────────────────┤          │ Scouting-Prioritizer        │ LLM (Recommendation │
  │ EXT: weather NOAA/ │         │ Treatment-Optimizer         │  + Exec-Summarizer) │
  │  ECMWF (humidity,  │         └────────┬─────────┘          └─────────┬──────────┘
  │  leaf-wetness,wind)│                  │                              │
  │  market prices     │                  └──────────────┬───────────────┘
  │  scout/agronomist  │                                 ▼
  │  spray/label data  │                       ┌───────────────────┐
  └───────────────────┘                        │ Disease-Engine +   │
                                                │ Confidence-Scoring │
                                                └─────────┬─────────┘
                                                          ▼
             OUTPUTS ─────────────▶ ALERT-ENGINE ─────────────▶ REPORT
   risk score, prob, spread map,   risk crosses band, new       Agronomist work-order
   infection heatmap, $ loss,      infection focus, spread      + exec section brief;
   fungicide + spray window        toward high-value block      scheduled + urgent alert
```

## The Recipe Matrix

| Recipe ID | Report | Fear it answers | Output / KPI | Inputs (data sources) | AI Models | Primitives | Alert trigger | Confidence | Refresh | Buildability | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|
| RF-DIS-01 | Disease Risk Score | "How likely is disease to hit this block right now?" | 0–100 risk score per field, banded (low/med/high) | eo/scan (s2_ndvi, NDRE stress), whitebox_terrain (TWI wetness), weather NOAA (humidity/leaf-wetness) | Temporal Transformer (Weather-Fusion), Bayesian (Confidence) | Disease-Engine, Vegetation-Indices, Weather-Fusion, Terrain-Drainage, Confidence-Scoring | Score crosses high band or jumps ≥1 band | T2 (screen) | Daily | EXT-DATA | PRO |
| RF-DIS-02 | Disease Probability | "What's the calibrated odds of an outbreak this week?" | Probability % + confidence interval per field | eo/scan (s2_ndvi, landsat_lst), weather NOAA (humidity/temp), stac_datacube history | Bayesian (Confidence), Temporal Transformer | Disease-Engine, Weather-Fusion, Vegetation-Indices, Confidence-Scoring | Probability exceeds action threshold | T3 (est.) | Daily | NEW-MODEL | PRO |
| RF-DIS-03 | Disease Spread Prediction | "Which way and how fast does it move — will it reach Section 7?" | Directional spread front + arrival ETA per adjacent block | current infection foci, weather NOAA/ECMWF (wind/humidity forecast), gis/parcel | Chronos/PatchTST (Forecast), Temporal Transformer | Spore-Dispersal-Model, Disease-Engine, Weather-Fusion, Forecast-Engine | Predicted front reaches high-value block | T3 (est.) | Daily | NEW-MODEL | BUSINESS |
| RF-DIS-04 | Infection Heatmap | "Where inside the field is stress clustering?" | Per-pixel infection-likelihood heatmap + hotspot polygons | eo/scan (s2_ndvi, NDRE), lband_sar (change), gis/parcel/delineate | SAM2 (segmentation), Change-Detection model | Vegetation-Indices, Change-Detection, Disease-Engine, Infection-Heatmap | New hotspot cluster emerges vs prior scan | T2 (screen) | Daily | GW-LIFTING | PRO |
| RF-DIS-05 | Early Symptoms | "Can I catch it before it's visible from the truck?" | Early-symptom flags (chlorosis/lesion) w/ location + tile crops | eo/scan (NDRE, s2_ndvi), vision/segment (high-res/drone), stac_datacube | ViT (Symptom-Detector), YOLO12 (lesion detect) | Symptom-Detector(ViT), Vegetation-Indices, Disease-Engine, Alert-Engine | Symptom signature detected pre-visual | T3 (est.) | Daily | NEW-MODEL | PRO |
| RF-DIS-06 | Historical Disease Patterns | "Where does disease recur every season?" | Recurrence map + seasonal timing per block | stac_datacube (multi-season NDVI curves), eo/scan history, scout logs | Chronos (seasonality), Bayesian (Confidence) | Phenology-Model, Change-Detection, Disease-Engine, Vegetation-Indices | Field enters historical high-risk window | T1 (determ.) | Weekly | LIVE | PRO |
| RF-DIS-07 | Fungicide Recommendation | "What do I spray, at what rate, and is it label-legal?" | Ranked product + rate + mode-of-action rotation | Disease-Risk/Probability output, spray/label data, weather (rain/wind window) | LLM (Recommendation), Bayesian (Confidence) | Recommendation-LLM, Disease-Engine, Weather-Fusion, Confidence-Scoring | High risk + open spray window converge | T3 (est.) | On-event | GW-LIFTING | PRO |
| RF-DIS-08 | Disease Cost Estimate | "What does this cost us in dollars if we do nothing?" | $ loss estimate (yield×price) + treatment cost tradeoff | Yield-Loss output, market/commodity prices, gis/parcel acreage | XGBoost (Yield-Model), LLM (Summarizer) | Financial-Model, Yield-Model, Disease-Engine, Risk-Engine | Projected loss exceeds treatment cost threshold | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-DIS-09 | Yield Loss Estimate | "How much tonnage does this disease take off the quota?" | Projected yield delta (with vs without disease), tons | eo/scan (s2_ndvi season), stac_datacube, infection extent, weather | XGBoost+Transformer (Yield-Model), Chronos | Yield-Model, Disease-Engine, Phenology-Model, Vegetation-Indices | Loss projection breaches quota margin | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-DIS-10 | Confidence Score | "How much do I trust these disease calls before I act?" | Per-report confidence + drivers/uncertainty flags | all disease outputs, scan cloud/quality, weather data quality | Bayesian network (Confidence) | Confidence-Scoring, Disease-Engine, Sensor-Fusion(GNN) | Confidence drops below act-threshold | T2 (screen) | Per-report | GW-LIFTING | PRO |
| RF-DIS-11 | Blight Screening | "Is late/early blight setting up in the canopy?" | Blight-likelihood map + affected-acre estimate | eo/scan (NDRE, s2_ndvi), weather (humidity/leaf-wetness), whitebox_terrain | ViT (Symptom-Detector, blight), Temporal Transformer | Symptom-Detector(ViT), Disease-Engine, Weather-Fusion, Vegetation-Indices | Blight signature + conducive weather | T3 (est.) | Daily | NEW-MODEL | PRO |
| RF-DIS-12 | Rust Screening | "Is rust building on the leaves?" | Rust-likelihood map + severity band | eo/scan (NDRE, s2_ndvi), vision/segment, weather (dew/temp) | ViT (Symptom-Detector, rust), YOLO12 | Symptom-Detector(ViT), Disease-Engine, Vegetation-Indices, Weather-Fusion | Rust signature crosses severity band | T3 (est.) | Daily | NEW-MODEL | PRO |
| RF-DIS-13 | Mildew Screening | "Is powdery/downy mildew starting under the canopy?" | Mildew-likelihood map + humidity-risk overlay | eo/scan (NDRE), whitebox_terrain (TWI), weather (humidity), vision/segment | ViT (Symptom-Detector, mildew), Temporal Transformer | Symptom-Detector(ViT), Disease-Engine, Terrain-Drainage, Weather-Fusion | Mildew signature + high-humidity microzone | T3 (est.) | Daily | NEW-MODEL | PRO |
| RF-DIS-14 | Rot Screening | "Is root/fruit rot forming in wet low spots?" | Rot-risk zones tied to drainage + saturation | whitebox_terrain (TWI/pooling), lband_sar (moisture change), eo/scan (s2_ndvi) | ViT (Symptom-Detector, rot), GNN (Sensor-Fusion) | Symptom-Detector(ViT), Terrain-Drainage, Disease-Engine, Water-Model | Rot risk in saturated low-lying cells | T3 (est.) | Daily | NEW-MODEL | PRO |
| RF-DIS-15 | Wilt Screening | "Is vascular wilt collapsing plants in a patch?" | Wilt-likelihood map + patch-progression flag | eo/scan (s2_ndvi drop, landsat_lst thermal), lband_sar, stac_datacube | ViT (Symptom-Detector, wilt), Change-Detection | Symptom-Detector(ViT), Disease-Engine, Change-Detection, Vegetation-Indices | Rapid localized canopy collapse detected | T3 (est.) | Daily | NEW-MODEL | PRO |
| RF-DIS-16 | Bacterial-Spot Screening | "Is bacterial spot spreading across the block?" | Spot-likelihood map + spread-rate flag | eo/scan (NDRE, s2_ndvi), vision/segment, weather (rain-splash/wind) | ViT (Symptom-Detector, bacterial), YOLO12 | Symptom-Detector(ViT), Disease-Engine, Weather-Fusion, Change-Detection | Spot signature + rain-splash conditions | T3 (est.) | Daily | NEW-MODEL | PRO |
| RF-DIS-17 | Treatment Window | "When exactly can I spray for max effect and no wash-off?" | Optimal spray window(s) w/ dry/low-wind slots | weather NOAA/ECMWF (rain/wind/temp forecast), growth stage, risk score | Chronos (Forecast), LLM (Recommendation) | Treatment-Optimizer, Weather-Fusion, Disease-Engine, Forecast-Engine | Optimal window opening/closing soon | T2 (screen) | Daily | EXT-DATA | PRO |
| RF-DIS-18 | Reinfection Risk | "After we sprayed, will it come back?" | Post-treatment reinfection probability + residual-protection decay | prior treatment date, weather forecast, residual infection extent | Chronos (Forecast), Bayesian (Confidence) | Reinfection-Model, Disease-Engine, Weather-Fusion, Confidence-Scoring | Reinfection probability rebounds past threshold | T3 (est.) | Daily | EXT-DATA | PRO |
| RF-DIS-19 | Quarantine Zone | "Where do I draw the containment line to save the rest?" | Recommended quarantine polygon + buffer + access rules | spread-prediction front, gis/parcel/delineate, infection foci | Chronos (Forecast), SAM2 (boundary) | Quarantine-Zone-Model, Spore-Dispersal-Model, Disease-Engine, Change-Detection | Spread front warrants containment boundary | T3 (est.) | Daily | NEW-MODEL | BUSINESS |
| RF-DIS-20 | Scouting Priority | "Which cells do I send scouts to first this morning?" | Ranked scout-cell list w/ why-flagged + nav pins | eo/scan (NDRE/s2_ndvi anomaly), change-detection, risk score, scout logs | Bayesian (Confidence), LLM (Summarizer) | Scouting-Prioritizer, Vegetation-Indices, Change-Detection, Disease-Engine | New high-priority scout cell surfaces | T2 (screen) | Daily | GW-LIFTING | PRO |
| RF-DIS-21 | Spread-vs-Weather | "Is the outbreak actually tracking the weather drivers?" | Correlation of observed spread vs humidity/wind/temp + driver ranking | observed infection change, weather NOAA/ECMWF history, stac_datacube | Temporal Transformer (Weather-Fusion), Chronos | Weather-Fusion, Spore-Dispersal-Model, Change-Detection, Disease-Engine | Weather turns strongly conducive to spread | T3 (est.) | Daily | EXT-DATA | BUSINESS |

## NEW primitives this family introduces
- Symptom-Detector(ViT)
- Spore-Dispersal-Model
- Infection-Heatmap
- Treatment-Optimizer
- Reinfection-Model
- Quarantine-Zone-Model
- Scouting-Prioritizer
