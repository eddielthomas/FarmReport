# Financial Intelligence — Report Family Recipe Matrix

## Persona & the fear it answers

The reader is the **CFO or owner-operator** — the person whose job is to translate dirt, water, and weather into a P&L the board will accept Monday morning. They do not care about NDVI; they care whether the number they promised the bank, the buyer, and the shareholders will hold. Every science metric in this family is converted to **dollars** — revenue at risk, cost per acre, margin erosion, cash runway, covenant headroom. The fear: *"Will we miss the number, blow the budget, breach the loan covenant, or get caught flat-footed when the commodity market moves — and will I be the one who has to explain it?"* Financial Intelligence exists so the CFO walks into every review already knowing the answer, the driver, and the dollar impact.

## Shared pipeline (family)

```
                                 FINANCIAL INTELLIGENCE PIPELINE
  INPUTS                         PRIMITIVES                 MODELS                 OUTPUTS            ALERT            REPORT
  ------------------------       --------------------       ------------------     --------------     -----------      ------------------
  EO scans (NDVI/LST/SAR) ─┐     Vegetation-Indices ─┐      Yield-Model ───┐       $ Revenue         threshold        Exec $ PDF /
  Yield-Model output ──────┤     Water-Model         │      (XGBoost+Txfmr) │      $ Cost/acre       breach on:       dashboard tile /
  Weather (NOAA/ECMWF) ────┼──►  Yield-Model         ├──►   Forecast-Engine ├──►   $ Margin      ──►  • margin    ──►  scheduled digest /
  Market/commodity feed ───┤     Risk-Engine         │      (Chronos/TiDE)  │      $ Cash flow        • variance       CSV to ERP /
  ERP / cost ledger ───────┤     Carbon-Engine       │      Bayesian-Conf ──┘      $ Risk exposure     • covenant       Board one-pager
  Contracts / buyer PO ────┤     Financial-Model ────┘      Recommendation-LLM     Confidence band     • cash gap
  Insurance / loan terms ──┘     Confidence-Scoring         Executive-AI-Summarizer  Recommendations
                                 Forecast-Engine
```

Every report in the family funnels its science/cost inputs through **Financial-Model** (unit-economics + $ conversion) and **Confidence-Scoring**, then is narrated by **Executive-AI-Summarizer** and gated by **Alert-Engine**.

## THE RECIPE MATRIX

| Recipe ID | Report | Fear it answers | Output / KPI | Inputs (data sources) | AI Models | Primitives | Alert trigger | Confidence | Refresh | Buildability | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|
| RF-FIN-01 | Revenue Forecast | "Will we hit the top-line I promised?" | Forecast $ revenue by crop/field + band | s2_ndvi, stac_datacube season curves, commodity feed, contracts | Yield-Model (XGBoost+Txfmr), Forecast-Engine (Chronos) | Yield-Model, Vegetation-Indices, Financial-Model, Forecast-Engine, Confidence-Scoring | Forecast ↓ >8% vs plan | T3 | Weekly | EXT-DATA | PRO |
| RF-FIN-02 | Profit Forecast | "Will margin survive after costs?" | Forecast $ gross/net margin + drivers | Revenue forecast, ERP cost ledger, input prices | Forecast-Engine (TiDE), Recommendation-LLM | Financial-Model, Yield-Model, Forecast-Engine, Confidence-Scoring | Net margin < target % | T3 | Weekly | EXT-DATA | BUSINESS |
| RF-FIN-03 | Cash Flow Forecast | "Will we run out of cash before harvest?" | 13-week cash runway + gap dates | ERP AP/AR, payroll, loan schedule, revenue timing | Forecast-Engine (PatchTST) | Financial-Model, Forecast-Engine, Risk-Engine, Confidence-Scoring | Projected balance < min cash | T3 | Weekly | EXT-DATA | BUSINESS |
| RF-FIN-04 | Yield Value | "What is the crop in the field worth today?" | $ standing-crop value by field | s2_ndvi, stac_datacube, commodity feed, acreage | Yield-Model (XGBoost+Txfmr) | Yield-Model, Vegetation-Indices, Financial-Model, Confidence-Scoring | Value ↓ >10% since last scan | T3 | Weekly | EXT-DATA | PRO |
| RF-FIN-05 | Insurance Exposure | "Are we under/over-insured for a loss event?" | $ insured vs at-risk gap by peril | Policy terms, yield value, weather risk, hazard layers | Risk-Engine, Bayesian-Conf | Risk-Engine, Financial-Model, Weather-Fusion, Confidence-Scoring | Uninsured exposure > threshold | T3 | Monthly | EXT-DATA | BUSINESS |
| RF-FIN-06 | Cost Per Acre | "Is any block bleeding money per acre?" | $/acre by input category, ranked | ERP cost ledger, field boundaries (delineate), acreage | Recommendation-LLM | Financial-Model, Confidence-Scoring | $/acre > peer/plan band | T1 | Monthly | EXT-DATA | PRO |
| RF-FIN-07 | Water Cost | "Is irrigation spend justified by the crop?" | $ water/irrigation cost vs yield return | whitebox_terrain (TWI), landsat_lst, meter/ERP water use | Recommendation-LLM | Water-Model, Terrain-Drainage, Financial-Model | Water $ / yield $ > band | T2 | Weekly | EXT-DATA | PRO |
| RF-FIN-08 | Fertilizer Cost | "Are we over-applying nutrients for the return?" | $ fertilizer cost + waste estimate | s2_ndvi (proxy stress), input price feed, ERP application log | Recommendation-LLM | Vegetation-Indices, Financial-Model, Confidence-Scoring | Spend > agronomic-need band | T2 | Monthly | GW-LIFTING | PRO |
| RF-FIN-09 | Labor Cost | "Is labor eating the margin?" | $ labor cost/acre + overtime trend | HR/payroll feed, task hours, acreage | Forecast-Engine | Financial-Model, Forecast-Engine, Confidence-Scoring | Labor $ > budget line | T1 | Weekly | EXT-DATA | BUSINESS |
| RF-FIN-10 | Fuel Cost | "Is fuel/energy spend out of control?" | $ fuel/energy cost + $ per operation | Equipment telemetry, fuel purchases, ops log | Forecast-Engine | Financial-Model, Sensor-Fusion(GNN), Forecast-Engine | Fuel $ trend > +X% | T1 | Weekly | EXT-DATA | BUSINESS |
| RF-FIN-11 | Equipment Cost | "What is machinery really costing us?" | $ owning+operating cost/hr + downtime $ | Equipment telemetry, maint log, depreciation schedule | Forecast-Engine | Financial-Model, Sensor-Fusion(GNN), Confidence-Scoring | Cost/hr > fleet benchmark | T2 | Monthly | EXT-DATA | BUSINESS |
| RF-FIN-12 | Carbon Revenue | "How much new revenue can carbon/MRV unlock?" | $ carbon credit potential + MRV readiness | s2_ndvi, lband_sar change, practice records | Carbon-Engine, Recommendation-LLM | Carbon-Engine, Change-Detection, Financial-Model, Confidence-Scoring | Eligible credits > threshold | T3 | Quarterly | GW-LIFTING | BUSINESS |
| RF-FIN-13 | Government Incentives | "Are we leaving subsidy/grant money on the table?" | $ eligible programs + capture gap | Program registry feed, practice/field records, boundaries | Recommendation-LLM | Financial-Model, Confidence-Scoring | Unclaimed eligible $ found | T2 | Quarterly | EXT-DATA | BUSINESS |
| RF-FIN-14 | Commodity Price Impact | "What does the market move do to our P&L?" | $ P&L delta per price scenario | Commodity/futures feed, yield value, contract mix | Forecast-Engine (Chronos), Recommendation-LLM | Financial-Model, Forecast-Engine, Risk-Engine | Price move > X% vs hedge | T3 | Daily | EXT-DATA | BUSINESS |
| RF-FIN-15 | Risk Cost | "What is our total quantified downside?" | $ expected loss across peril portfolio | Weather-Fusion, disease/pest screens, hazard layers | Risk-Engine, Bayesian-Conf | Risk-Engine, Weather-Fusion, Financial-Model, Confidence-Scoring | Expected loss > tolerance | T3 | Weekly | EXT-DATA | BUSINESS |
| RF-FIN-16 | Weather Cost | "What did/will weather cost us in dollars?" | $ weather-driven yield/cost impact | Weather feed (NOAA/ECMWF), landsat_lst, yield model | Temporal Transformer, Yield-Model | Weather-Fusion, Yield-Model, Financial-Model | Adverse event $ > threshold | T3 | Daily | EXT-DATA | PRO |
| RF-FIN-17 | Disease Cost | "What could a disease outbreak cost us?" | $ at-risk from disease screening | s2_ndvi/NDRE stress screen, weather conducive-ness | ViT (disease screen), Yield-Model | Disease-Engine, Vegetation-Indices, Financial-Model, Confidence-Scoring | Screened risk $ > threshold | T3 (screening) | Weekly | NEW-MODEL | PRO |
| RF-FIN-18 | Pest Cost | "What could a pest pressure event cost us?" | $ at-risk from pest pressure screen | s2_ndvi anomaly, weather, migration corridors | Pest-Engine (migration), Yield-Model | Pest-Engine, Vegetation-Indices, Financial-Model, Confidence-Scoring | Screened risk $ > threshold | T3 (screening) | Weekly | NEW-MODEL | PRO |
| RF-FIN-19 | Infrastructure Cost | "Is drainage/roads/storage costing us silently?" | $ infra maintenance + failure-risk cost | whitebox_terrain (TWI), lband_sar change, asset register | Change-Detection | Terrain-Drainage, Change-Detection, Financial-Model | Detected asset change + $ | T2 | Monthly | GW-LIFTING | BUSINESS |
| RF-FIN-20 | ROI Opportunities | "Where should the next dollar go?" | Ranked $ ROI of interventions | Cost ledger, yield model, intervention library | Recommendation-LLM, Forecast-Engine | Financial-Model, Yield-Model, Recommendation-LLM, Confidence-Scoring | ROI opp > hurdle rate | T3 | Monthly | EXT-DATA | BUSINESS |
| RF-FIN-21 | Savings Opportunities | "Where are we wasting money right now?" | Ranked $ savings + payback | Cost ledger, input efficiency, water/fuel/fert models | Recommendation-LLM | Financial-Model, Water-Model, Vegetation-Indices, Recommendation-LLM | Savings opp > $ threshold | T2 | Monthly | EXT-DATA | PRO |
| RF-FIN-22 | Budget Variance | "Are we off budget and why?" | $ actual vs budget + driver attribution | ERP budget, actuals ledger, ops log | Recommendation-LLM | Financial-Model, Confidence-Scoring | Line variance > tolerance | T1 | Weekly | EXT-DATA | BUSINESS |
| RF-FIN-23 | Production Variance | "Are we off the production plan in dollars?" | $ value of yield vs plan variance | Yield-Model, plan targets, contract volumes | Yield-Model, Forecast-Engine | Yield-Model, Financial-Model, Forecast-Engine, Confidence-Scoring | Volume/value gap > X% | T3 | Weekly | EXT-DATA | PRO |
| RF-FIN-24 | Financial Confidence | "How much should I trust these numbers?" | Confidence score + data-quality drivers | All family outputs, data freshness, model spread | Bayesian network | Confidence-Scoring, Financial-Model | Confidence < acceptable band | T1 | Weekly | LIVE | PRO |
| RF-FIN-25 | Break-Even Analysis | "At what yield/price do we stop making money?" | Break-even yield & price + headroom | Cost ledger, yield value, commodity feed | Forecast-Engine, Recommendation-LLM | Financial-Model, Yield-Model, Forecast-Engine, Confidence-Scoring | Margin headroom < buffer | T3 | Monthly | EXT-DATA | PRO |
| RF-FIN-26 | Executive Financial Summary | "What do I tell the CEO/board Monday?" | One-page $ narrative + top 3 actions | All RF-FIN outputs, alerts, confidence | Executive-AI-Summarizer, Recommendation-LLM | Executive-AI-Summarizer, Financial-Model, Confidence-Scoring, Alert-Engine | Any red-flag alert fires | T3 | Weekly | EXT-DATA | BUSINESS |

## NEW primitives this family introduces

Financial-Model, Forecast-Engine(time-series), Executive-AI-Summarizer, Confidence-Scoring, Carbon-Engine
