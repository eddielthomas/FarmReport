# Supply Chain Reports (Distribution Center / Processor) — Intelligence Recipe Matrix

## Persona & the fear it answers
The reader runs a **distribution center or processing plant** — a DC lead, a plant operations manager, or a supply buyer at Dole / Del Monte / Chiquita / Cargill / Tyson / a Walmart sourcing desk. Their whole job is **inbound volume × timing**: how many tons land at the dock, in what grade, on which day, and whether it fills the trucks and contracts already promised downstream. They get fired when the line runs half-empty, when cold storage overflows, when a Walmart PO ships short, or when a container of Grade-A becomes Grade-C in transit. This family turns the field-level intelligence of the platform into a forward-looking **supply plan**: what's coming, when it ripens, how good it'll be, how long it lasts, and where the pipe clogs — so the operator walks into the morning stand-up already knowing *"Will the volume arrive full, on-grade, and on time — and if not, what do I re-route today?"* It sells **job security** for the person accountable for a promise made to a buyer they cannot afford to miss.

## Shared pipeline (family)
```
                    SUPPLY CHAIN REPORTS — SHARED PIPELINE
  INPUTS                        PRIMITIVES                   MODELS
  ┌───────────────────┐         ┌───────────────────┐        ┌─────────────────────┐
  │ /api/eo/scan      │         │ Vegetation-Indices│        │ XGBoost+Transformer │
  │  s2_ndvi          │─parcel─▶│ Phenology-Model   │─feat──▶│  (Yield-Model)      │
  │  landsat_lst      │  stats  │ Ripeness-Model    │        │ Chronos/TiDE/Patch- │
  │  lband_sar        │         │ Grade-Model       │        │  TST (Forecast)     │
  │  stac_datacube    │         │ Shelf-Life-Model  │        │ Temporal Transformer│
  │  whitebox_terrain │         │ Weather-Fusion    │        │  (Weather-Fusion)   │
  ├───────────────────┤         │ Inventory-Model   │        │ ViT/RT-DETR (grade, │
  │ /api/vision/*     │         │ Logistics-Engine  │        │  count corroborate) │
  │ /api/gis/parcel   │         │ Financial-Model   │        │ GNN (Sensor-Fusion) │
  ├───────────────────┤         │ Confidence-Scoring│        │ Bayesian (Confidence)│
  │ EXT: weather NOAA │         │ Forecast-Engine   │        │ LLM (Exec-Summarizer│
  │  ERP/inventory    │         └─────────┬─────────┘        │  + Recommendation)  │
  │  logistics/TMS    │                   │                  └──────────┬──────────┘
  │  contracts/PO     │                   └──────────┬──────────────────┘
  │  cold-chain specs │                              ▼
  └───────────────────┘                   ┌────────────────────┐
                                          │ Inventory-Model +  │
                                          │ Logistics-Engine + │
                                          │ Confidence-Scoring │
                                          └─────────┬──────────┘
                                                    ▼
           OUTPUTS ─────────────────▶ ALERT-ENGINE ─────────────▶ REPORT
   tons-by-week, ripen date, grade    short-ship risk, capacity   Ops PDF / dashboard,
   mix, storage/truck demand, PO      overflow, PO-miss, spoilage  weekly supply plan +
   fill %, spoilage/waste $           spike                        urgent re-route alert
```

## The Recipe Matrix

| Recipe ID | Report | Fear it answers | Output / KPI | Inputs (data sources) | AI Models | Primitives | Alert trigger | Confidence | Refresh | Buildability | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|
| RF-SUP-01 | Harvest Forecast | "How many tons are actually coming?" | Projected harvest tonnage per field + range | stac_datacube (season NDVI), eo/scan (s2_ndvi, landsat_lst), weather NOAA | XGBoost+Transformer (Yield-Model), Chronos | Yield-Model, Phenology-Model, Vegetation-Indices, Forecast-Engine, Confidence-Scoring | Forecast tonnage falls below commit band | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-SUP-02 | Harvest Calendar | "Which day does each field hit the dock?" | Per-field harvest-window dates on a calendar | stac_datacube (NDVI curve), s2_ndvi, weather NOAA (GDD) | Temporal Transformer, Chronos | Phenology-Model, Ripeness-Model, Weather-Fusion, Forecast-Engine | Window shifts >X days vs plan | T2 (screen) | Weekly | EXT-DATA | PRO |
| RF-SUP-03 | Expected Weekly Production | "What lands at the plant next week?" | Tons/week by crop, next 4–8 weeks | Yield-Model output, stac_datacube, weather NOAA, ERP | Chronos/TiDE (Forecast), XGBoost (Yield) | Forecast-Engine, Yield-Model, Inventory-Model, Phenology-Model | Weekly volume outside ±X% of throughput plan | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-SUP-04 | Shipment Forecast | "How many loads leave the dock, and when?" | Projected shipments (loads/pallets) by day | Production forecast, ERP, logistics/TMS, contracts/PO | Chronos (Forecast), LLM (Summarizer) | Forecast-Engine, Logistics-Engine, Inventory-Model, Financial-Model | Projected shipments below PO cadence | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-SUP-05 | Packaging Forecast | "Will we run out of boxes/clamshells?" | Packaging units needed by SKU + reorder point | Production forecast, ERP, contracts/PO (pack spec) | Chronos (Forecast), XGBoost | Forecast-Engine, Inventory-Model, Financial-Model | Projected packaging demand exceeds on-hand + lead time | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-SUP-06 | Cold Storage Requirements | "Will the coolers overflow or sit empty?" | Required cold volume (pallet-slots) vs capacity | Production forecast, landsat_lst (field heat load), ERP, cold-chain specs | Chronos (Forecast), LLM (Summarizer) | Forecast-Engine, Inventory-Model, Shelf-Life-Model, Financial-Model | Projected storage need exceeds capacity band | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-SUP-07 | Truck Scheduling | "Do I have enough trucks on the right days?" | Truck/day plan vs available fleet + gaps | Shipment forecast, logistics/TMS, ERP, gis/parcel (distance) | LLM (Recommendation), Chronos | Logistics-Engine, Forecast-Engine, Inventory-Model, Recommendation-LLM | Truck demand exceeds booked capacity | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-SUP-08 | Export Forecast | "Will export containers fill on schedule?" | Export-eligible tonnage + container plan by port | Yield-Model output, Grade-Model, contracts/PO, market prices | XGBoost (Yield), Chronos (Forecast) | Yield-Model, Grade-Model, Logistics-Engine, Financial-Model, Forecast-Engine | Export-grade volume below container commit | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-SUP-09 | Quality Forecast | "Will the crop arrive good enough to sell?" | Projected quality index + defect-risk band | eo/scan (s2_ndvi, landsat_lst, NDRE via index_calc), weather NOAA | XGBoost+Transformer, ViT (defect corroborate) | Grade-Model, Vegetation-Indices, Weather-Fusion, Confidence-Scoring | Quality index projected below buyer spec | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-SUP-10 | Produce Grade Prediction | "What's the Grade A/B/C mix Walmart sees?" | Predicted grade distribution % per lot | eo/scan (s2_ndvi, landsat_lst), stac_datacube, vision/segment | XGBoost (Grade), ViT / RT-DETR (corroborate) | Grade-Model, Vegetation-Indices, Phenology-Model, Confidence-Scoring | Grade-A share drops below contract floor | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-SUP-11 | Retail Readiness | "Is this lot store-shelf ready on arrival?" | Readiness score (ripeness+grade+shelf-life) | Ripeness/Grade/Shelf-Life outputs, landsat_lst, weather NOAA | LLM (Summarizer), Bayesian (Confidence) | Ripeness-Model, Grade-Model, Shelf-Life-Model, Confidence-Scoring | Readiness score below retail-accept threshold | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |
| RF-SUP-12 | Inventory Forecast | "Will supply cover demand, or do we short?" | Projected on-hand vs demand, stock-out date | Production forecast, ERP/inventory, contracts/PO | Chronos/TiDE (Forecast), LLM (Summarizer) | Inventory-Model, Forecast-Engine, Financial-Model | Projected on-hand crosses safety-stock floor | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-SUP-13 | Processing Capacity | "Can the line handle the inbound peak?" | Inbound tons vs plant throughput + overflow | Production forecast, ERP (line rates), harvest calendar | Chronos (Forecast), LLM (Summarizer) | Forecast-Engine, Inventory-Model, Logistics-Engine, Financial-Model | Inbound projected to exceed line capacity | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-SUP-14 | Distribution Bottlenecks | "Where does the pipe clog before it clogs?" | Ranked bottleneck nodes (dock/cooler/truck/line) | Shipment+capacity forecasts, logistics/TMS, ERP | GNN (Sensor-Fusion), LLM (Recommendation) | Logistics-Engine, Inventory-Model, Sensor-Fusion(GNN), Recommendation-LLM | Any node utilization projected >95% | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-SUP-15 | Customer Commitments | "Can I cover every promise on the book?" | Commit vs projected supply per customer, gap $ | Production/Grade forecasts, contracts/PO, ERP | Chronos (Forecast), LLM (Summarizer) | Inventory-Model, Forecast-Engine, Financial-Model, Confidence-Scoring | Any commitment projected under-covered | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-SUP-16 | Contract Fulfillment | "Are we tracking to hit every contract?" | Fulfillment % + penalty-exposure $ per contract | Production/Grade/Ship forecasts, contracts/PO, market prices | Chronos (Forecast), Bayesian (Confidence) | Financial-Model, Inventory-Model, Forecast-Engine, Confidence-Scoring | Fulfillment projected below contract + penalty trip | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-SUP-17 | Delivery Confidence | "How sure are we the load lands on time?" | On-time-in-full (OTIF) probability per PO | Shipment forecast, logistics/TMS, weather NOAA, contracts/PO | Bayesian (Confidence), Chronos | Logistics-Engine, Confidence-Scoring, Weather-Fusion, Forecast-Engine | OTIF probability drops below SLA threshold | T3 (est.) | Weekly | EXT-DATA | BUSINESS |
| RF-SUP-18 | Shelf-Life Estimate | "How many days of life before spoilage?" | Est. remaining shelf-life days per lot + drivers | landsat_lst (field heat), eo/scan (stress indices), weather NOAA, cold-chain specs | XGBoost+Transformer, LLM (Summarizer) | Shelf-Life-Model, Weather-Fusion, Grade-Model, Confidence-Scoring | Est. shelf-life below transit+retail window | T3 (est.) | Weekly | NEW-MODEL | PRO |
| RF-SUP-19 | Ripeness Forecast | "When exactly is it ready to pick/ship?" | Predicted ripeness date + maturity curve | stac_datacube (NDVI curve), s2_ndvi, landsat_lst, weather NOAA (GDD) | Temporal Transformer, XGBoost | Ripeness-Model, Phenology-Model, Weather-Fusion, Vegetation-Indices | Ripeness date shifts vs harvest/ship plan | T2 (screen) | Weekly | NEW-MODEL | PRO |
| RF-SUP-20 | Food Waste Prediction | "How much do we lose to spoilage/reject?" | Projected loss tons + $ by cause (spoil/grade/oversupply) | Shelf-Life/Grade/Inventory outputs, weather NOAA, ERP, contracts/PO | XGBoost, LLM (Recommendation) | Shelf-Life-Model, Grade-Model, Inventory-Model, Financial-Model, Recommendation-LLM | Projected waste $ exceeds tolerance band | T3 (est.) | Weekly | NEW-MODEL | BUSINESS |

## NEW primitives this family introduces
- Ripeness-Model
- Grade-Model
- Shelf-Life-Model
- Inventory-Model
- Logistics-Engine
