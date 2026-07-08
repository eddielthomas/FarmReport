# Crop Intelligence — Report Family Recipe Matrix

**Family code:** `CRP` · **Reports:** 38 · **Persona:** Agronomist + regional farm manager — the heart of the platform.

## 1. Persona & the fear it answers

This family is written for the agronomist and the farm manager whose name is on the production number — the person who stands in front of the Operations Director at Dole, Del Monte, Driscoll's, Chiquita, or a Cargill/Tyson sourcing desk and says "the crop will make quota." They get fired when the block underperforms, when a stressed field silently loses 15% before anyone walks it, when a Walmart shipment gets rejected on quality, or when they tell the CEO "we're fine" on Monday and lose 400 acres to disease by Friday. Crop Intelligence answers one recurring dread: *"Is my crop actually on track — and if it isn't, do I find out while I can still do something about it, or after the loss is booked?"* Every report converts pixels into a defensible operational call: intervene here, this many acres, this much yield/dollars at risk, this is what I tell the boss.

## 2. Shared pipeline (family)

```
                          CROP INTELLIGENCE — SHARED PIPELINE
  INPUTS                     PRIMITIVES                MODELS               OUTPUTS            ALERT            REPORT
  ------                     ----------                ------               -------            -----            ------
  Sentinel-2 (s2_ndvi) ┐     Vegetation-Indices ┐      Chronos/TiDE ┐       zone map      ┐
  Landsat LST          ┼──►  Phenology-Model    ┼──►   PatchTST      ┼──►    KPI + trend   ┼─► Alert-Engine ─► Executive-AI
  EMIT minerals        │     Change-Detection   │      XGBoost+Txfmr │       acres-at-risk │   (threshold/    -Summarizer
  NISAR L-band SAR     ┤     Water-Model         ┼──►   ViT (screen)  ┼──►    $-impact      ┼─► anomaly/       + Recommendation
  Whitebox TWI         │     Yield-Model         │      YOLO12/RT-DETR│       confidence    │   forecast-      -LLM ─► PDF/API
  stac_datacube curves ┤     Terrain-Drainage    ┼──►   SAM2/FastSAM  ┼──►    ranked action │   breach)        + portfolio
  Weather (EXT)        │     Weather-Fusion      │      GNN fusion     │       forecast     │                  rollup
  Scouting/agronomy ───┘     Financial-Model ────┘      Bayesian conf ─┘       band          ┘                  (BUSINESS)
                             Confidence-Scoring ──────────────────────────────────────────────► every report carries a T1/T2/T3 tag
```

## 3. The recipe matrix

| Recipe ID | Report | Fear it answers | Output / KPI | Inputs (data sources) | AI Models | Primitives | Alert trigger | Confidence | Refresh | Buildability | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|
| RF-CRP-01 | NDVI | "Is the crop green and growing where it should be?" | NDVI zone map + field mean/percentiles | s2_ndvi (Sentinel-2) | — | Vegetation-Indices | Mean NDVI drops >X vs prior pass | T1 | Per S2 pass (~5d) | LIVE | BASIC |
| RF-CRP-02 | EVI | "Is dense canopy hiding a vigor drop NDVI saturates on?" | EVI zone map, canopy-corrected vigor | Sentinel-2 bands | — | Vegetation-Indices | EVI zone below block baseline | T1 | Per S2 pass | GW-LIFTING (index_calc) | PRO |
| RF-CRP-03 | GNDVI | "Is chlorophyll/N declining before it shows visually?" | GNDVI map, greenness index | Sentinel-2 (green/NIR) | — | Vegetation-Indices | GNDVI decline in N-sensitive zones | T2 | Per S2 pass | GW-LIFTING (index_calc) | PRO |
| RF-CRP-04 | SAVI | "Is bare-soil noise faking crop stress early season?" | Soil-adjusted vigor map | Sentinel-2, soil-line L factor | — | Vegetation-Indices | SAVI zone < emergence baseline | T1 | Per S2 pass | GW-LIFTING (index_calc) | PRO |
| RF-CRP-05 | Chlorophyll | "Is leaf chlorophyll/N status falling below target?" | Chlorophyll (CIred-edge) index map | Sentinel-2 red-edge | — | Vegetation-Indices | Rel. chlorophyll drop in zone | T2 | Per S2 pass | GW-LIFTING (index_calc) | PRO |
| RF-CRP-06 | Biomass | "Is there enough standing biomass to hit tonnage?" | Est. biomass t/ha map + block total | s2_ndvi, lband_sar, phenology | XGBoost+Transformer | Vegetation-Indices, Yield-Model | Biomass zone < seasonal target | T3 | Per S2 pass | GW-LIFTING (SAR-change) | PRO |
| RF-CRP-07 | LAI | "Is canopy leaf area on the curve for full production?" | LAI map + season-stage vs expected | Sentinel-2, phenology stage | — | Vegetation-Indices, Phenology-Model | LAI below stage-expected band | T3 | Per S2 pass | GW-LIFTING (index_calc) | PRO |
| RF-CRP-08 | Canopy Density | "Are there thin patches that cap this field's ceiling?" | Canopy cover % map, thin-patch acres | s2_ndvi, vision/segment | SAM2/FastSAM | Vegetation-Indices, Object-Count | Thin-canopy acres > threshold | T2 | Per S2 pass | LIVE | BASIC |
| RF-CRP-09 | Growth Rate | "Is the crop bulking fast enough to make the window?" | ΔNDVI/day velocity map + lagging zones | stac_datacube (per-date curves) | Chronos/TiDE | Vegetation-Indices, Change-Detection, Phenology-Model | Growth velocity below cohort | T2 | Per S2 pass | LIVE | PRO |
| RF-CRP-10 | Emergence | "Did the stand come up evenly — or do I replant now?" | Emergence % + gap map | early-season s2_ndvi/SAVI, datacube | — | Vegetation-Indices, Phenology-Model, Change-Detection | Emergence < target % by GDD | T2 | Per S2 pass (early) | LIVE | PRO |
| RF-CRP-11 | Flowering | "Is bloom timing on schedule for the contract harvest?" | Flowering onset/peak map + timing vs plan | stac_datacube curves, Weather (EXT) | Chronos/TiDE | Phenology-Model, Weather-Fusion | Bloom stage off plan by >X days | T3 | Per S2 pass | GW-LIFTING (adapters)+EXT-DATA | PRO |
| RF-CRP-12 | Fruit Development | "Will fruit size/load meet pack-out spec?" | Fruit-stage index + sizing trend | stac_datacube, Weather (EXT), scouting | XGBoost+Transformer | Phenology-Model, Weather-Fusion | Sizing trend lags spec curve | T3 | Weekly | NEW-MODEL (crop-stage model)+EXT-DATA | PRO |
| RF-CRP-13 | Harvest Readiness | "When exactly do I send crews — and to which block first?" | Ready-date per zone + harvest sequence | stac_datacube senescence, LST, Weather | Chronos/TiDE, LLM | Phenology-Model, Weather-Fusion, Recommendation-LLM | Zone crosses maturity threshold | T3 | Per S2 pass | GW-LIFTING+EXT-DATA | PRO |
| RF-CRP-14 | Yield Estimate | "What tonnage do I promise the buyer — and can I defend it?" | Yield t/ha map + block total + range | s2_ndvi, lband_sar, phenology, Weather | XGBoost+Transformer | Yield-Model, Vegetation-Indices, Weather-Fusion | Estimate deviates >X% from contract | T3 | Per S2 pass | NEW-MODEL (yield)+EXT-DATA | BUSINESS |
| RF-CRP-15 | Yield Variability | "How much of my field is dragging the average down?" | Yield CV%, low/high zone acres + $ delta | Yield-Model output, datacube history | XGBoost+Transformer | Yield-Model, Vegetation-Indices | Variability CV > block norm | T3 | Per S2 pass | NEW-MODEL (yield) | BUSINESS |
| RF-CRP-16 | Crop Uniformity | "Will this block pass buyer uniformity/quality specs?" | Uniformity score + heterogeneity map | s2_ndvi, EVI, canopy density | SAM2/FastSAM | Vegetation-Indices, Confidence-Scoring | Uniformity below buyer spec | T2 | Per S2 pass | GW-LIFTING (index_calc) | PRO |
| RF-CRP-17 | Crop Stress | "Is something wrong somewhere I haven't walked yet?" | Composite stress index + hotspot map | s2_ndvi, LST, TWI, datacube | GNN fusion | Vegetation-Indices, Water-Model, Sensor-Fusion(GNN), Risk-Engine | Stress index spikes in any zone | T2 | Per S2 pass | LIVE | PRO |
| RF-CRP-18 | Heat Stress | "Is heat cooking yield during a critical stage?" | Heat-stress zones + canopy temp anomaly | landsat_lst, Weather (EXT), phenology | Temporal Transformer | Water-Model, Weather-Fusion, Risk-Engine | Canopy LST anomaly + GDD spike | T2 | Per LST pass | LIVE (LST) / +EXT-DATA | PRO |
| RF-CRP-19 | Cold Stress | "Did frost hit — how many acres, how bad, do I document it?" | Frost-event map + damage-severity zones | landsat_lst, Weather (EXT), change-detect | Temporal Transformer | Weather-Fusion, Change-Detection, Risk-Engine | Sub-threshold temp + NDVI drop | T2 | Event-driven | GW-LIFTING (lst_splitwindow)+EXT-DATA | PRO |
| RF-CRP-20 | Nutrient Stress | "Is a hidden N/nutrient deficiency capping yield?" | Deficiency-screen map (red-edge chlorophyll) | Sentinel-2 red-edge, EMIT, scouting | — | Vegetation-Indices, Risk-Engine | Chlorophyll-N zone below target | T2 (screen) | Per S2 pass | GW-LIFTING (index_calc) | PRO |
| RF-CRP-21 | Water Stress | "Is the crop drought-stressed before wilting shows?" | Water-stress index (CWSI-style) map | landsat_lst, s2_ndvi, TWI, tau_omega SM | GNN fusion | Water-Model, Terrain-Drainage, Sensor-Fusion(GNN) | Water-stress zone > threshold | T2 | Per S2/LST pass | GW-LIFTING (tau_omega SM) | PRO |
| RF-CRP-22 | Pest Stress | "Is a pest outbreak starting where I can still stop it?" | Pest-risk screening map + hotspots | s2_ndvi anomaly, Weather, scouting | ViT (screen), Pest-Engine | Pest-Engine, Change-Detection, Weather-Fusion | Anomaly cluster + pest-favorable wx | T3 (screen) | Per S2 pass | NEW-MODEL (pest)+EXT-DATA | PRO |
| RF-CRP-23 | Disease Stress | "Is disease spreading toward my healthy blocks?" | Disease-risk screening map + spread vector | s2_ndvi/red-edge anomaly, Weather | ViT (screen), Disease-Engine | Disease-Engine, Change-Detection, Weather-Fusion | Anomaly + disease-favorable wx window | T3 (screen) | Per S2 pass | NEW-MODEL (disease ViT)+EXT-DATA | PRO |
| RF-CRP-24 | Lodging | "Did wind/rain flatten the crop — how many acres lost?" | Lodging-detection map + affected acres | lband_sar (all-weather), s2_ndvi, Weather | NEW lodging model, SAR-change | Change-Detection, Risk-Engine | SAR backscatter change post-storm | T3 | Event-driven | NEW-MODEL (lodging)+GW-LIFTING (SAR) | BUSINESS |
| RF-CRP-25 | Weed Pressure | "Are weeds stealing yield and skewing my vigor maps?" | Weed-pressure zones + infestation acres | vision/segment, s2_ndvi off-row anomaly | YOLO12/RT-DETR, SAM2 | Object-Count, Change-Detection | Weed cluster acres > threshold | T2 | Per S2 pass / drone | GW-LIFTING (DroneOps) | PRO |
| RF-CRP-26 | Plant Population | "Is stand density enough to hit target yield?" | Plants/acre estimate map vs target | vision/segment (drone/hi-res), datacube | YOLO12/RT-DETR | Object-Count, Yield-Model | Population zone < agronomic target | T3 | Per drone/emergence | NEW-MODEL (stand-count)+GW-LIFTING (DroneOps) | PRO |
| RF-CRP-27 | Stand Count | "Do I have the plants I paid to plant?" | Absolute stand count + row-level tally | drone/hi-res imagery via vision/segment | YOLO12/RT-DETR | Object-Count | Count deviates >X% from seeding rate | T3 | On-demand (drone) | NEW-MODEL (stand-count)+GW-LIFTING (DroneOps) | PRO |
| RF-CRP-28 | Missing Plants | "Where are the gaps — is replant worth the cost?" | Gap/skip map + missing-plant acres + $ | vision/segment, early s2_ndvi/SAVI | YOLO12/RT-DETR, SAM2 | Object-Count, Financial-Model | Gap acres exceed replant threshold | T3 | Early season | NEW-MODEL (stand-count)+GW-LIFTING (DroneOps) | PRO |
| RF-CRP-29 | Maturity | "Which blocks are ripe first so I schedule crews right?" | Maturity-stage map + ripening sequence | stac_datacube senescence curve, LST | Chronos/TiDE | Phenology-Model, Vegetation-Indices | Zone reaches maturity threshold | T3 | Per S2 pass | LIVE | PRO |
| RF-CRP-30 | Crop Height | "Is canopy structure/height on track (lodging/harvest set-up)?" | Rel. canopy-height/structure proxy map | lband_sar structure, GEDI (EXT), datacube | GNN fusion | Change-Detection, Sensor-Fusion(GNN) | Height proxy below stage band | T3 | Per SAR pass | GW-LIFTING (GEDI adapter)+EXT-DATA | BUSINESS |
| RF-CRP-31 | Leaf Color | "Is a color shift signaling stress/senescence early?" | Leaf-color / hue-shift anomaly map | Sentinel-2 visible+red-edge | — | Vegetation-Indices, Change-Detection | Color-shift anomaly in zone | T2 | Per S2 pass | GW-LIFTING (index_calc) | BASIC |
| RF-CRP-32 | Crop Density | "Is planting density limiting or crowding this block?" | Density index map + over/under zones | s2_ndvi, canopy cover, vision/segment | SAM2/FastSAM | Vegetation-Indices, Object-Count | Density outside optimal band | T2 | Per S2 pass | LIVE | BASIC |
| RF-CRP-33 | Vegetation Change | "What changed since last pass — and does it threaten quota?" | Change map (gain/loss) + flagged acres | stac_datacube multi-date, s2_ndvi | — | Change-Detection, Vegetation-Indices, Alert-Engine | Significant loss cluster detected | T1 | Per S2 pass | LIVE | BASIC |
| RF-CRP-34 | Growth Forecast | "Where will this crop be at harvest — on the curve or not?" | Forecast NDVI/biomass trajectory + band | stac_datacube history, Weather (EXT) | Chronos/TiDE, PatchTST | Forecast-Engine(time-series), Phenology-Model, Weather-Fusion | Forecast trajectory below target | T3 | Per S2 pass | GW-LIFTING+EXT-DATA | BUSINESS |
| RF-CRP-35 | Yield Confidence | "How sure am I of the number I'm giving the CEO/buyer?" | Confidence band + driver breakdown | Yield-Model outputs, data completeness | Bayesian network | Yield-Model, Confidence-Scoring | Confidence drops below decision floor | T3 | Per S2 pass | NEW-MODEL (yield)+Bayesian | BUSINESS |
| RF-CRP-36 | ROI Forecast | "Is this block worth the inputs — cut losses or double down?" | Projected ROI $/ac + margin-at-risk | Yield-Model, input costs/prices (EXT) | XGBoost+Transformer, LLM | Yield-Model, Financial-Model, Recommendation-LLM | Projected ROI below breakeven | T3 | Weekly | NEW-MODEL (yield)+EXT-DATA | BUSINESS |
| RF-CRP-37 | Replant Decision | "Replant now or ride it — which one won't get me fired?" | Replant recommend + cost vs recovered-yield $ | emergence/gap maps, Yield-Model, costs (EXT) | XGBoost+Transformer, LLM | Financial-Model, Yield-Model, Recommendation-LLM, Object-Count | Net replant benefit > cost | T3 | Early season | NEW-MODEL+EXT-DATA | PRO |
| RF-CRP-38 | Crop Loss Documentation | "Can I prove this loss to insurance/the buyer and get paid?" | Time-stamped loss map + acres + evidence pack | change-detect, LST/SAR, Weather, phenology | Executive-AI-Summarizer | Change-Detection, Risk-Engine, Financial-Model, Executive-AI-Summarizer | Verified loss event exceeds claim floor | T2 | Event-driven | GW-LIFTING+EXT-DATA | BUSINESS |

## 4. NEW primitives this family introduces

- Phenology-Model
- Object-Count
- Yield-Model
- Disease-Engine
- Pest-Engine
- Forecast-Engine(time-series)
- Confidence-Scoring

(Vegetation-Indices, Water-Model, Change-Detection, Weather-Fusion, Terrain-Drainage, Financial-Model, Risk-Engine, Sensor-Fusion(GNN), Executive-AI-Summarizer, Alert-Engine, Recommendation-LLM are reused from the shared library.)
