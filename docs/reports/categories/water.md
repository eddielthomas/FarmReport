# Water Management — Intelligence Recipe Matrix

## Persona & the fear it answers
The buyer is the **Irrigation Lead / Water Operations Director** at a large grower or processor (Dole, Del Monte, Driscoll's, a regional farm manager, or a distribution-center water steward). Their nightmare is walking in Monday to a wilted block, a dry pivot, a flooded low corner that drowned the crop, or a regulator's letter about an over-allocation — any of which costs the season's quota and their job. This family answers one blunt question: **"Will irrigation fail this weekend, and what do I fix before it does?"** Every report converts pixels and telemetry into a go/no-go operational call: where the water is short, where it's pooling, whether the pumps and canals are holding, whether we're inside our legal allocation, and what a dry (or flooded) week does to yield and cash.

## Shared pipeline (family)
```
                                 WATER MANAGEMENT PIPELINE
 INPUTS                        PRIMITIVES                MODELS                  OUTPUTS
 ─────────────────────         ──────────────────        ─────────────────       ──────────────────────
 Sentinel-2 (NDVI/NDWI) ─┐     Vegetation-Indices        Chronos/TiDE/PatchTST   Moisture / deficit maps
 Landsat LST (thermal) ──┤     Water-Model / ET-Model    (Forecast-Engine)       Water-balance & ET KPIs
 NISAR L-band SAR ───────┼──►  Change-Detection      ──► Temporal Transformer ─► Flood / standing-water zones
 whitebox TWI (terrain) ─┤     Terrain-Drainage          (Weather-Fusion)        Pump/canal/leak status
 SMAP/GPM/GRACE (feeds) ─┤     Hydro-Extent-Model        GNN (Sensor-Fusion)     Allocation / restriction
 NOAA/ECMWF weather ─────┤     Irrigation-Scheduler      Bayesian (Confidence)   Irrigation ROI $ impact
 Pump/flow telemetry ────┤     Leak-Anomaly-Detector     LLM (Exec-Summarizer)          │
 Water-authority feeds ──┘     Financial-Model / Risk-Engine                             ▼
                                        │                                        ┌──────────────┐
                                        └──────────► Alert-Engine ──────────────►│ ALERT (SMS/  │
                                                     Confidence-Scoring          │ push/email)  │
                                                                                 └──────┬───────┘
                                                                                        ▼
                                                                          Scheduled PDF / dashboard report
                                                                          + "what to tell the CEO Monday"
```

## THE RECIPE MATRIX

| Recipe ID | Report | Fear it answers | Output / KPI | Inputs (data sources) | AI Models | Primitives | Alert trigger | Confidence | Refresh | Buildability | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|
| RF-WTR-01 | Soil Moisture | "Is the root zone drying out before I can water it?" | Field/zone soil-moisture % + dry-spot map | tau_omega SM, lband_sar backscatter, s2_ndvi | GNN (Sensor-Fusion), Bayesian | Water-Model, Sensor-Fusion(GNN), Confidence-Scoring | Zone SM < wilting threshold | T2 | Daily | GW-LIFTING | PRO |
| RF-WTR-02 | Water Consumption | "Are we burning more water than budget for this yield?" | ET-derived water use (mm & m³) vs plan | landsat_lst, s2_ndvi, NOAA/ECMWF | Temporal Transformer (Weather-Fusion) | ET-Model, Water-Model, Weather-Fusion | Cumulative use > budget +10% | T3 | Daily | GW-LIFTING | PRO |
| RF-WTR-03 | Irrigation Effectiveness | "Did last week's watering actually reach the crop?" | Post-irrigation NDVI/LST recovery score by block | s2_ndvi, landsat_lst, stac_datacube | Chronos (Forecast-Engine) | Vegetation-Indices, Water-Model, Change-Detection | Block shows no recovery after event | T2 | Per scan | LIVE | PRO |
| RF-WTR-04 | Irrigation Timing | "When exactly do I run the pivots this weekend?" | Optimal irrigation window + priority queue | tau_omega SM, NOAA/ECMWF, stac_datacube | Chronos/TiDE (Forecast-Engine), LLM | Irrigation-Scheduler, Forecast-Engine, Weather-Fusion, Recommendation-LLM | SM forecast crosses trigger pre-weekend | T3 | Daily | EXT-DATA | PRO |
| RF-WTR-05 | Water Deficit | "How far behind is each block, and which fails first?" | Crop water deficit (mm) ranked by block | landsat_lst, s2_ndvi, NOAA/ECMWF | Temporal Transformer, Bayesian | ET-Model, Water-Model, Risk-Engine, Confidence-Scoring | Deficit > crop-stress threshold | T3 | Daily | GW-LIFTING | PRO |
| RF-WTR-06 | Flood Detection | "Did water inundate a block overnight, even under cloud?" | All-weather flood extent + affected acres | lband_sar (change), whitebox_terrain | Temporal Transformer (Change-Detection) | Change-Detection, Hydro-Extent-Model, Terrain-Drainage, Alert-Engine | New inundation > X acres | T1 | Per SAR pass | LIVE | PRO |
| RF-WTR-07 | Standing Water | "Where is water pooling long enough to drown roots?" | Persistent standing-water zones + duration | lband_sar, whitebox_terrain, s2_ndvi | GNN (Sensor-Fusion) | Terrain-Drainage, Hydro-Extent-Model, Change-Detection | Water persists > N days in a zone | T1 | Per scan | LIVE | PRO |
| RF-WTR-08 | Pond Volume | "How much water is left in the storage pond?" | Estimated pond surface area & volume (m³) | lband_sar/s2 extent, DEM/terrain | RT-DETR/SAM2 (extent), regression | Hydro-Extent-Model, Terrain-Drainage, Water-Model | Volume below reserve threshold | T3 | Weekly | GW-LIFTING | BUSINESS |
| RF-WTR-09 | Reservoir Health | "Is our reservoir trending toward empty this season?" | Water-extent trend + fill % vs seasonal norm | lband_sar, s2_ndwi, stac_datacube | Chronos (Forecast-Engine) | Hydro-Extent-Model, Change-Detection, Forecast-Engine | Projected empty before season end | T2 | Weekly | LIVE | BUSINESS |
| RF-WTR-10 | Water Quality | "Is the source water safe to put on a Walmart crop?" | Turbidity/algae screening index (relative) | s2 water-quality bands, landsat_lst | ViT/index (screening), Bayesian | Water-Model, Confidence-Scoring, Alert-Engine | Turbidity/algae index spikes | T2 | Weekly | GW-LIFTING | BUSINESS |
| RF-WTR-11 | Drainage Health | "Which low spots won't drain after the next rain?" | TWI drainage map + poor-drainage acres | whitebox_terrain, s2_ndvi, lband_sar | — (deterministic + screen) | Terrain-Drainage, Water-Model, Change-Detection | High-TWI zone stays wet post-rain | T1 | Monthly | LIVE | PRO |
| RF-WTR-12 | Waterlogging | "Are saturated soils about to stress or rot the crop?" | Waterlogged-zone map + crop-stress overlay | whitebox_terrain, lband_sar, s2_ndvi | GNN (Sensor-Fusion) | Terrain-Drainage, Water-Model, Vegetation-Indices, Risk-Engine | Saturation + NDVI decline coincide | T2 | Per scan | LIVE | PRO |
| RF-WTR-13 | Canal Monitoring | "Is the supply canal flowing and unbreached?" | Canal water-presence + breach/blockage flags | lband_sar (change), s2_ndwi | Temporal Transformer (Change-Detection) | Change-Detection, Hydro-Extent-Model, Alert-Engine | Segment dry or breach detected | T2 | Per SAR pass | LIVE | BUSINESS |
| RF-WTR-14 | Water Loss | "Where are we losing water between source and field?" | Seepage/loss estimate along delivery path | lband_sar, tau_omega SM, flow telemetry | GNN (Sensor-Fusion), Bayesian | Water-Model, Leak-Anomaly-Detector, Sensor-Fusion(GNN) | Delivered vs applied gap > threshold | T3 | Weekly | EXT-DATA | BUSINESS |
| RF-WTR-15 | Leak Detection | "Is a buried line or valve leaking right now?" | Anomalous wet/thermal hotspot map | landsat_lst, lband_sar, tau_omega SM | Temporal Transformer (anomaly), Bayesian | Leak-Anomaly-Detector, Change-Detection, Confidence-Scoring | Unexpected persistent wet/thermal anomaly | T2 | Per scan | GW-LIFTING | PRO |
| RF-WTR-16 | Water Restrictions | "Are we about to violate an allocation or curtailment?" | Restriction status + headroom vs cap | Water-authority feeds, ET use (RF-WTR-02) | LLM (Recommendation) | Regulatory-Feed, Water-Model, Alert-Engine | New curtailment or cap breach risk | T1 | Daily | EXT-DATA | BUSINESS |
| RF-WTR-17 | Water Availability | "Will there be enough water to finish the season?" | Available-supply forecast (surface+ground+rain) | SMAP/GPM/GRACE, reservoir extent, feeds | Chronos/TiDE (Forecast-Engine) | Water-Model, Hydro-Extent-Model, Groundwater-Proxy, Forecast-Engine | Projected supply < crop demand | T3 | Weekly | EXT-DATA | BUSINESS |
| RF-WTR-18 | Pump Performance | "Is a pump about to fail and strand a block?" | Pump efficiency/health + fault risk score | Pump telemetry (flow/pressure/energy) | XGBoost/Chronos (anomaly forecast) | Sensor-Fusion(GNN), Forecast-Engine, Alert-Engine | Efficiency drop or fault-risk spike | T3 | Real-time | EXT-DATA | BUSINESS |
| RF-WTR-19 | Irrigation ROI | "Is this water spend actually paying for itself?" | $ yield return per m³ water applied | ET use, yield est, water cost, market px | XGBoost+Transformer (Yield), LLM | Financial-Model, Yield-Model, Water-Model, Executive-AI-Summarizer | ROI below break-even by block | T3 | Weekly | EXT-DATA | BUSINESS |
| RF-WTR-20 | Groundwater Indicators | "Is the aquifer we pump from dropping?" | Groundwater-storage proxy trend + subsidence | GRACE, lband_sar (InSAR), SMAP | Temporal Transformer, Bayesian | Groundwater-Proxy, Change-Detection, Confidence-Scoring | Storage proxy declining past threshold | T3 | Monthly | GW-LIFTING | BUSINESS |
| RF-WTR-21 | Rainfall Efficiency | "How much of the rain actually helped the crop?" | Effective-rainfall % (rain → NDVI/SM uptake) | GPM rainfall, tau_omega SM, s2_ndvi | Temporal Transformer (Weather-Fusion) | Weather-Fusion, Water-Model, Vegetation-Indices | Low uptake after major rain event | T2 | Per event | GW-LIFTING | PRO |
| RF-WTR-22 | Drought Trend | "Are we sliding into a drought that blows the quota?" | Multi-index drought trajectory + severity | SMAP, GPM, landsat_lst, s2_ndvi | Chronos/TiDE (Forecast-Engine), Bayesian | Water-Model, Forecast-Engine, Risk-Engine, Executive-AI-Summarizer | Drought index crosses severity band | T3 | Weekly | GW-LIFTING | PRO |

## NEW primitives this family introduces
ET-Model, Hydro-Extent-Model, Irrigation-Scheduler, Leak-Anomaly-Detector, Groundwater-Proxy, Regulatory-Feed
