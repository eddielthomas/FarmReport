# Labor Intelligence — Report Family Recipe Matrix

## Persona & the fear it answers

The buyer is the **Ops Director + HR/Workforce lead** at a large grower-packer or a regional farm operation (Dole, Del Monte, Driscoll's, Taylor Farms, a Cargill/Tyson contract-grower network). Harvest is a labor war fought against a clock: crops ripen on a biological schedule that does not care whether your crew showed up. This family answers one visceral fear — **"Will we have enough hands, in the right place, at the right skill, at the right cost, to get the crop off the field before it rots or misses the truck?"** A missed harvest window is unrecoverable revenue; an H-2A miscalculation is a federal and financial catastrophe; a wage-cost overrun blows the quarter; a safety incident stops the line and invites OSHA. Report.Farm turns fragmented HR/timekeeping/phenology signals into a forward-looking labor operations center so the person who owns the number can walk into Monday's meeting already knowing the gap — and the fix — instead of discovering it in the field.

> **Honesty note:** Labor Intelligence is overwhelmingly an **EXT-DATA** family. The EO gateway contributes *demand timing* (phenology / NDVI ripeness → when and how much labor is needed) and *acreage-normalization* (per-acre denominators, field readiness). Everything about crews, hours, wages, headcount, absenteeism, and compliance requires integrating an **HR / timekeeping / payroll / farm-labor-contractor (FLC)** feed. We are honest that most of these light up only once that feed lands. The EO layer is what makes our labor forecasting *better than a spreadsheet* — it ties demand to the biological calendar of the actual fields.

## Shared pipeline (family-wide)

```
                          LABOR INTELLIGENCE — SHARED PIPELINE
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ INPUTS                                                                         │
  │   EO/GW:  s2_ndvi + stac_datacube (ripeness/phenology) · parcel/delineate      │
  │           (acreage denominator) · landsat_lst (heat → OSHA/productivity)       │
  │   EXT:    HR/HRIS · timekeeping/punch · payroll/wages · FLC/crew rosters ·      │
  │           H-2A filings · training/cert records · safety/incident log ·         │
  │           production quota/plan · weather (NOAA/ECMWF)                          │
  └───────────────┬────────────────────────────────────────────────────────────────┘
                  ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ PRIMITIVES                                                                     │
  │   Phenology-Model ─ Vegetation-Indices ─ Labor-Demand-Model* ─ Workforce-      │
  │   Supply-Model* ─ Crew-Productivity-Model* ─ Financial-Model ─ Weather-Fusion  │
  │   ─ Compliance-Engine* ─ Risk-Engine ─ Forecast-Engine(time-series) ─          │
  │   Confidence-Scoring ─ Alert-Engine ─ Executive-AI-Summarizer ─                │
  │   Recommendation-LLM                                                           │
  └───────────────┬────────────────────────────────────────────────────────────────┘
                  ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ MODELS                                                                         │
  │   Chronos/TiDE/PatchTST (demand & supply forecast) · Temporal Transformer      │
  │   (weather→availability) · XGBoost (productivity, absenteeism, overtime risk)  │
  │   · Bayesian network (confidence) · LLM (exec summary + recommendations)       │
  └───────────────┬────────────────────────────────────────────────────────────────┘
                  ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ OUTPUTS → ALERT → REPORT                                                       │
  │   KPI cards (crew-days needed vs available, $/acre, gap%) · gap-over-time curve │
  │   · crew heatmap by field/task · Alert-Engine fires on shortfall/overtime/     │
  │   safety/compliance breach · Executive-AI-Summarizer → "labor readiness"       │
  │   one-pager + scheduled digest + urgent SMS/email                              │
  └──────────────────────────────────────────────────────────────────────────────┘
```

## THE RECIPE MATRIX

| Recipe ID | Report | Fear it answers | Output / KPI | Inputs (data sources) | AI Models | Primitives | Alert trigger | Confidence | Refresh | Buildability | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|
| RF-LAB-01 | Labor Demand Forecast | "How many crew-days will each field need, and when?" | Crew-days demanded by field/week; peak-week curve | s2_ndvi + stac_datacube (ripeness), parcel acreage, crop calendar, historical yield | Chronos/PatchTST, XGBoost | Phenology-Model, Labor-Demand-Model*, Vegetation-Indices, Forecast-Engine | Peak-week demand > planned capacity | T3 | Weekly | GW-LIFTING (EO live; demand model new) | PRO |
| RF-LAB-02 | Labor Shortage Prediction | "Will we be short-handed at harvest peak?" | Projected gap = demand − supply, by week/region; shortfall days | RF-LAB-01 demand, HR/roster availability, FLC pipeline, seasonal in/out-flow | Chronos/TiDE, Bayesian net | Labor-Demand-Model*, Workforce-Supply-Model*, Risk-Engine, Forecast-Engine, Confidence-Scoring | Projected gap > 10% in any peak week | T3 | Daily (in-season) | EXT-DATA (needs HR/FLC feed) | BUSINESS |
| RF-LAB-03 | Crew Productivity | "Which crews are hitting the pick-rate we're paying for?" | Units/hr & acres/crew-day by crew, vs benchmark | Timekeeping punches, production/pack counts, field acreage, task type | XGBoost, LLM | Crew-Productivity-Model*, Financial-Model, Executive-AI-Summarizer | Crew productivity < 80% of benchmark | T2 | Daily | EXT-DATA (timekeeping + production) | PRO |
| RF-LAB-04 | Cost-Per-Acre Labor | "Is labor blowing the per-acre budget?" | $/acre labor, actual vs budget, by field/crop | Payroll/wages, timekeeping hours, parcel acreage, budget | XGBoost, LLM | Financial-Model, Crew-Productivity-Model*, Vegetation-Indices, Executive-AI-Summarizer | $/acre > budget by >15% | T2 | Weekly | EXT-DATA (payroll + acreage) | PRO |
| RF-LAB-05 | Harvest-Crew Readiness | "Are the right crews staged for the fields ripening this week?" | Readiness score per field: crew assigned vs ripeness ETA | stac_datacube ripeness ETA, roster/assignments, crew skill/cert, weather | Chronos, LLM, Bayesian net | Phenology-Model, Workforce-Supply-Model*, Weather-Fusion, Risk-Engine, Recommendation-LLM | Ripe field with no staged crew ≤72h | T3 | Daily (in-season) | EXT-DATA (roster) + GW (EO live) | BUSINESS |
| RF-LAB-06 | Overtime Risk | "Are we about to run into an overtime cost blowout?" | Projected OT hours & $ by crew/week; OT-driver flags | Timekeeping running hours, schedule, demand curve, labor law thresholds | XGBoost, Chronos | Financial-Model, Forecast-Engine, Risk-Engine, Alert-Engine | Projected weekly hours cross OT threshold | T2 | Daily | EXT-DATA (timekeeping) | PRO |
| RF-LAB-07 | Safety Incidents | "Are we heading toward an OSHA recordable or heat casualty?" | TRIR/incident trend; heat-stress exposure index by field | Safety/incident log, landsat_lst heat, timekeeping exposure hours, weather | XGBoost, Temporal Transformer, LLM | Risk-Engine, Weather-Fusion, Financial-Model, Executive-AI-Summarizer, Alert-Engine | Heat index high + long shifts, or incident-rate spike | T2 | Daily | EXT-DATA (incident log) + GW (LST live) | BUSINESS |
| RF-LAB-08 | Headcount vs Plan | "Are we staffed to the plan the CEO signed off on?" | Actual vs planned headcount by role/region; variance % | HR headcount, staffing plan, req/hiring pipeline | XGBoost, LLM | Workforce-Supply-Model*, Financial-Model, Executive-AI-Summarizer | Headcount variance > 8% vs plan | T2 | Weekly | EXT-DATA (HR/HRIS) | BUSINESS |
| RF-LAB-09 | Task Allocation | "Are we putting hands where the crop actually needs them?" | Optimized crew→field/task assignment; reallocation moves | Ripeness by field, roster/skills, demand curve, distances | LLM, XGBoost | Labor-Demand-Model*, Workforce-Supply-Model*, Phenology-Model, Recommendation-LLM | Misallocation: idle crew while ripe field unserved | T3 | Daily (in-season) | EXT-DATA (roster) + GW (EO live) | PRO |
| RF-LAB-10 | Absenteeism | "Will no-shows leave us short tomorrow?" | Predicted no-show rate & at-risk crews; net available heads | Timekeeping attendance history, weather, day-of-week, wage/turnover signals | XGBoost, Temporal Transformer | Workforce-Supply-Model*, Weather-Fusion, Risk-Engine, Forecast-Engine | Predicted no-show rate > threshold for peak day | T2 | Daily | EXT-DATA (attendance) | PRO |
| RF-LAB-11 | Training / Compliance | "Are our crews certified for the tasks we're assigning?" | % crew with valid certs (pesticide/food-safety/equip); expiries | Training/cert records, task assignments, regulatory ruleset | LLM (rules), Bayesian net | Compliance-Engine*, Workforce-Supply-Model*, Alert-Engine | Uncertified crew assigned to restricted task; cert expiring | T1 | Weekly | EXT-DATA (training records) | BUSINESS |
| RF-LAB-12 | H-2A / Seasonal Planning | "Did we file enough seasonal workers for the harvest window?" | H-2A need vs filed; timeline-to-file; gap risk | RF-LAB-01 demand, H-2A filings/petitions, DOL calendar, historical seasonal flow | Chronos, LLM | Labor-Demand-Model*, Workforce-Supply-Model*, Compliance-Engine*, Phenology-Model, Forecast-Engine | Filed workers < projected peak need, or filing deadline near | T3 | Weekly (seasonal) | EXT-DATA (H-2A/DOL feed) | BUSINESS |
| RF-LAB-13 | Wage-Cost Variance | "Why is the wage bill off plan and by how much?" | Wage $ actual vs budget; variance decomposition (rate/hrs/mix) | Payroll/wages, budget, timekeeping hours, crew mix | XGBoost, LLM | Financial-Model, Crew-Productivity-Model*, Executive-AI-Summarizer | Wage variance > 10% or adverse trend | T2 | Weekly | EXT-DATA (payroll) | BUSINESS |
| RF-LAB-14 | Labor Efficiency Score | "Overall, how efficient is our labor operation right now?" | Composite 0–100 efficiency index; driver breakdown; peer/self trend | Productivity, $/acre, OT, absenteeism, readiness sub-scores | XGBoost, LLM, Bayesian net | Crew-Productivity-Model*, Financial-Model, Workforce-Supply-Model*, Confidence-Scoring, Executive-AI-Summarizer | Efficiency score drops > 10 pts period-over-period | T3 | Weekly | EXT-DATA (composite of above) | PRO |

## NEW primitives this family introduces

- Labor-Demand-Model
- Workforce-Supply-Model
- Crew-Productivity-Model
- Compliance-Engine
