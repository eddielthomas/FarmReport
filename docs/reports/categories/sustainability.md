# Sustainability / ESG — Intelligence Recipe Matrix

## Persona & the fear it answers

The buyer is the **Sustainability / ESG lead** at a grower-shipper or the **responsible-sourcing / ESG-compliance buyer** at the retail or CPG end (Walmart Project Gigaton, Nestlé, Unilever, Danone regen-ag programs). Their fear is not "how green are we" in the abstract — it is **"a buyer or auditor will reject our supply, our certification will lapse, or the EU will block our shipment, and I will be the one who signed off."** They live under EUDR deforestation cutoffs, CSRD/Scope-3 disclosure, GlobalGAP / Rainforest Alliance / SAI FSA audits, and buyer scorecards that gate contracts. This family turns Report.Farm's EO substrate into **defensible, audit-ready ESG evidence** — a carbon number they can put in a filing, a deforestation-free proof they can hand to a customs broker, an ESG grade they can show the board Monday — with honest tiering so no one signs a claim the data can't back.

## Shared pipeline (family)

```
INPUTS                          PRIMITIVES                 MODELS                    OUTPUTS            ALERT             REPORT
-------------------------------------------------------------------------------------------------------------------------------
parcel boundary (delineate) --> Vegetation-Indices ----+                                              +--> ESG scorecard
s2_ndvi / stac season curve --> Phenology-Model -------+--> Carbon-Engine --------> XGBoost (C stock)  |   +--> cert dossier
landsat_lst / lst_splitwin ---> Water-Model -----------+--> Carbon-MRV -----------> Chronos (C trend)  |   +--> EUDR proof
lband_sar change / tillage ---> Change-Detection ------+--> ESG-Scoring ----------> Bayesian (conf.)   |   +--> audit pack
GEDI biomass / SMAP / GPM ----> Terrain-Drainage ------+--> Emissions-Factor-DB    LLM (exec summary) -+--> board memo
emit_minerals (soil) ---------> Sensor-Fusion (GNN) ---+--> Biodiversity-Model -----------+            |
EXT: ERP fertilizer/fuel,      Deforestation-Ledger ---+--> Regen-Practice-Tracker -------+--> Executive-AI-Summarizer
     carbon price, WRI water,   Financial-Model -------+--> Compliance-Pack-Builder ------+--> Alert-Engine --> buyer/audit alert
     GlobalGAP/RA criteria      Confidence-Scoring -----------------------------------------+--> Recommendation-LLM
```

## THE RECIPE MATRIX

| Recipe ID | Report | Fear it answers | Output / KPI | Inputs (data sources) | AI Models | Primitives | Alert trigger | Confidence | Refresh | Buildability | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|
| RF-ESG-01 | ESG Score | "Our buyer scorecard drops and we lose the contract" | 0–100 composite ESG index + E/S/G sub-scores | s2_ndvi, lband_sar change, ERP records, WRI water risk, cert status | Bayesian (confidence), LLM (summary) | ESG-Scoring, Sensor-Fusion(GNN), Confidence-Scoring, Executive-AI-Summarizer | Score crosses buyer minimum threshold | T3 composite estimate | Monthly | GW-LIFTING | BUSINESS |
| RF-ESG-02 | Sustainability Grade | "The board wants one letter, is it a B or a D?" | A–F grade + peer percentile band | ESG-01 sub-scores, portfolio baseline | LLM (summary), Bayesian | ESG-Scoring, Confidence-Scoring, Executive-AI-Summarizer | Grade downgrade vs prior period | T3 composite estimate | Monthly | GW-LIFTING | PRO |
| RF-ESG-03 | Certification Readiness | "We'll fail the GlobalGAP / Rainforest Alliance audit" | % criteria met + gap checklist per standard | cover-crop signal, deforestation ledger, water/fertilizer records, cert criteria (EXT) | LLM (gap reasoning) | Certification-Rules-Engine, Compliance-Pack-Builder, Recommendation-LLM | Any must-pass criterion failing < audit date | T2 screening vs criteria | Quarterly | EXT-DATA | BUSINESS |
| RF-ESG-04 | Carbon Stored | "Our carbon claim won't survive verification" | tCO2e stock (soil + biomass) ± CI, per ha | emit_minerals soil, s2_ndvi, GEDI biomass, terrain | XGBoost (C stock), Bayesian (CI) | Carbon-Engine, Vegetation-Indices, Terrain-Drainage, Confidence-Scoring | Stock estimate below program floor | T3 model estimate | Seasonal | NEW-MODEL | PRO |
| RF-ESG-05 | Carbon Credits | "We over-issued credits and get clawed back" | Creditable tCO2e (additionality-adjusted) + issuance-ready qty | Carbon-04 stock, baseline, registry methodology | XGBoost, Bayesian | Carbon-Engine, Carbon-MRV, Confidence-Scoring | Additionality/permanence risk flag | T3 model estimate | Seasonal | NEW-MODEL | BUSINESS |
| RF-ESG-06 | Carbon Trend | "Are we actually sequestering or losing carbon?" | ΔtCO2e/yr trajectory + season curve | stac_datacube NDVI series, lband_sar change, GEDI | Chronos/TiDE (trend), Change-Detection | Carbon-Engine, Change-Detection, Forecast-Engine, Phenology-Model | Trend flips negative over N periods | T2/T3 relative trend | Seasonal | GW-LIFTING | PRO |
| RF-ESG-07 | Carbon Revenue | "How much is this worth and what do I tell finance?" | $ value of credits + sensitivity to price | Carbon-05 credits, carbon price feed (EXT) | LLM (summary) | Financial-Model, Carbon-Engine, Executive-AI-Summarizer | Price move swings revenue > X% | T3 estimate (price-linked) | Monthly | EXT-DATA | BUSINESS |
| RF-ESG-08 | Water-Use Efficiency | "Buyer says our water footprint is too high" | Biomass per unit water (kg/m3) + WUE trend | landsat_lst / lst_splitwindow ET, SMAP/GPM, s2_ndvi | Chronos (trend) | Water-Model, Vegetation-Indices, Forecast-Engine | WUE drops below benchmark | T2 screening | Monthly | GW-LIFTING | PRO |
| RF-ESG-09 | Energy Use | "Scope-1/2 energy line won't reconcile for CSRD" | kWh + fuel + energy intensity per ha/ton | equipment telemetry, fuel/utility records (EXT) | LLM (summary) | Energy-Model, Financial-Model, Executive-AI-Summarizer | Energy intensity exceeds target | T1 from records | Monthly | EXT-DATA | BUSINESS |
| RF-ESG-10 | Fertilizer Intensity | "N over-application fails the nutrient-mgmt audit" | kg N/ha + intensity vs benchmark, NDRE proxy | ERP fertilizer records (EXT), NDRE (index_calc) | XGBoost (proxy calibration) | Nutrient-Budget, Vegetation-Indices, Recommendation-LLM | Applied N over regulatory/agronomic cap | T2 (record + proxy) | Seasonal | EXT-DATA | PRO |
| RF-ESG-11 | Biodiversity Index | "Our habitat/biodiversity claim is unsupported" | Habitat-diversity index + hedgerow/margin area | vision/segment land cover, s2_ndvi heterogeneity, change | SAM2/FastSAM, YOLO12, GNN | Biodiversity-Model, Object-Count, Change-Detection, Sensor-Fusion(GNN) | Habitat area loss detected | T3 model estimate | Quarterly | NEW-MODEL | PRO |
| RF-ESG-12 | Cover-Crop Adoption | "We claimed cover crop but can't prove coverage" | % fields + % area with off-season green cover | stac_datacube season curve, s2_ndvi off-season | Chronos (phenology fit) | Phenology-Model, Vegetation-Indices, Change-Detection | Off-season bare-soil where cover required | T2 screening | Seasonal | LIVE | PRO |
| RF-ESG-13 | Soil-Carbon MRV | "The registry rejects our MRV package" | MRV-grade SOC stock + uncertainty + sampling plan | emit_minerals, soil samples (EXT), s2_ndvi, terrain | XGBoost (SOC), Bayesian (uncertainty) | Carbon-MRV, Carbon-Engine, Confidence-Scoring, Compliance-Pack-Builder | Uncertainty exceeds registry tolerance | T3 model estimate | Annual | NEW-MODEL | BUSINESS |
| RF-ESG-14 | Regenerative-Practice Score | "Buyer regen-ag program says we don't qualify" | Regen score (cover, low-till, rotation, diversity) | tillage SAR-change, cover-crop signal, rotation history | GNN (fusion), LLM | Regen-Practice-Tracker, Change-Detection, Phenology-Model, Sensor-Fusion(GNN) | Practice reversal (e.g. tillage resumes) | T2 screening | Seasonal | GW-LIFTING | PRO |
| RF-ESG-15 | Emissions per Ton | "Our product carbon intensity blows the buyer cap" | kgCO2e per ton harvested + hotspot breakdown | activity data (EXT), emission factors, yield model | XGBoost+Transformer (yield) | Emissions-Factor-DB, Yield-Model, Financial-Model, Executive-AI-Summarizer | Intensity above buyer/label cap | T3 estimate | Seasonal | EXT-DATA | BUSINESS |
| RF-ESG-16 | Deforestation-Free Proof | "EU blocks the shipment under EUDR" | Pass/fail vs 2020 cutoff + geolocated change ledger | lband_sar change, s2_ndvi baseline, parcel delineate | Change-Detection (deterministic) | Deforestation-Ledger, Change-Detection, Compliance-Pack-Builder | Any forest-loss event post-cutoff in polygon | T1 deterministic | Continuous | LIVE | BUSINESS |
| RF-ESG-17 | Water-Stewardship | "We fail AWS / buyer water-risk screening" | Watershed risk tier + stewardship checklist | Water-Model ET/moisture, WRI Aqueduct (EXT), rainfall | LLM (context reasoning) | Water-Stewardship-Context, Water-Model, Risk-Engine, Recommendation-LLM | Basin enters high water-stress tier | T2 screening | Monthly | EXT-DATA | PRO |
| RF-ESG-18 | ESG Audit Pack | "The auditor walks in and we have no evidence file" | Bundled, timestamped, citation-linked ESG dossier | outputs of RF-ESG-01..17 | LLM (assembly + narrative) | Compliance-Pack-Builder, Executive-AI-Summarizer, Confidence-Scoring | Missing/expired evidence before audit date | Inherits per-section T-level | On-demand / Quarterly | LIVE | BUSINESS |

## NEW primitives this family introduces

ESG-Scoring, Certification-Rules-Engine, Carbon-MRV, Biodiversity-Model, Deforestation-Ledger, Emissions-Factor-DB, Regen-Practice-Tracker, Compliance-Pack-Builder, Energy-Model, Nutrient-Budget, Water-Stewardship-Context
