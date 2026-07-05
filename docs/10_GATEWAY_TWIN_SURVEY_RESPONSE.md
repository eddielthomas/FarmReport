# 10 — Gateway Digital-Twin Survey: RESPONSE (empirical)

> **Author:** Gateway agent (owns AlphaGeo Gateway / AlphaGeoCore).
> **Method:** Read-only survey of the **running** deployment `root@46.4.241.172` — container `alphageo-api-gateway` (`uvicorn phase41_api_gateway:app` on `:7777`, image `alphageo/api-gateway:v1-fehandoff2-scanlog`), DB `postgis` (`alphageo`), Redis, nginx public-api proxy. Every claim below is grounded in live source, live OpenAPI, live endpoint responses, or live `psql`. Where a thing is not there, it says **NO / NOT available today**.
> **Snapshot:** 311 OpenAPI paths. DB row counts at survey time: `app_meta.aoi`=**70**, `app_meta.orbiter`=**20**, `app_meta.orbiter_run`=**38**, `alphageo.scene`=**1845**, `app_meta.evidence_raster`=**34**.

---

## 0. TL;DR — the load-bearing premise, resolved

**The task-brief premise ("the AlphaGeo GATEWAY already supports digital-twin logic") is FALSE. Your canonical docs (`08`/`07`/`02`) are CORRECT.**

- There is **no `twin` table, no `/api/*twin*` endpoint, no digital-twin object** anywhere on the box. `grep`/OpenAPI confirm zero twin surfaces.
- There is also **no `/api/farm/*` router deployed today.** The plan's relay targets (`/api/farm/scan`, `/api/farm/signals-by-bbox`, `/api/farm/jobs/{id}/events`) **do not exist**. They are to be *built* by the farm side, cloning the RWR harvest-relay idiom. The **real** surfaces that idiom points at are `/api/harvest/*` and `/api/rwr/harvest-scans` (harvest bridge) plus the read families below.
- The gateway is a **stateless EO / scan / indicator / imagery / evidence** surface, exactly as `08` §Premise-correction states. Twin state is **100% app-tier** — build it in `farm.*` as planned.

**Closest real primitives to compose a "twin" from (no new gateway object needed):**

| Twin facet | Real gateway/DB primitive | Persist? | Scope |
|---|---|---|---|
| Parcel geometry / identity | `app_meta.aoi` (`POST/GET /api/aois`) | **Yes, persistent** | tenant (`X-Tenant-Id`) |
| Persistent stateful monitor | `app_meta.orbiter` (`/api/orbiters/*`) — named, AOI-bound, `state∈{IDLE,ACTIVE,PAUSED,STANDBY}`, `cadence∈{ONCE,HOURLY,DAILY,WEEKLY,ON_DEMAND}`, `sensor_mode`, `config` JSONB | **Yes, persistent** | `project_id` |
| Analysis history | `app_meta.orbiter_run` + `/api/orbiters/{id}/runs`, `/api/orbiters/{id}/report` | Yes | project |
| Findings / detections | `app_meta.orbiter_finding` + `/api/orbiters/{id}/findings`, `/api/detections` | Yes | project |
| Derived signals (map values) | `GET /api/indicators/instances` (federated GeoJSON) | Yes (producer tables) | `project_id` |
| Rasters (map/cutaway) | `app_meta.evidence_raster` + `/api/evidence/rasters/*/tiles` | Yes | project |
| Scenes / imagery tiles | `alphageo.scene` + `/api/imagery/{scene}/tiles` | Yes | project |
| Copilot brain | `/api/geoagent/*` (real Anthropic tool-loop + tool registry) | session | context-passed |

**An orbiter bound to an AOI is functionally "a persistent twin monitor."** Your `/api/farm/*` relay should treat `AOI + orbiter (+ runs/findings/rasters/indicator-instances)` as the composable twin substrate and keep the twin *object* in `farm.*` — which is exactly what `08` proposes.

---

## 1. Capability table (survey §3, 8 areas)

Columns: **Exists** = YES / PARTIAL / NO / COULD-EXPOSE.

| # | Capability | Exists | Concrete interface | Request shape | Response shape | Auth | Sync/Async/Stream | Flags/config | Hard limits | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 3.1 | **Twin as persistent object** | **NO** (twin) / **PARTIAL** (registry) | AOI: `POST /api/aois`, `GET /api/aois`. Orbiter: `GET/POST /api/orbiters`, `GET/PATCH/DELETE /api/orbiters/{id}`, `/launch /pause /resume` | AOI: `{name, boundary_geojson, h3_parent_res, manifest}`. Orbiter: `{name, sensor_mode, cadence, aoi_id, analyzer_id, config}` | AOI: `{aoi_id, tenant_id, name, h3_parent_res, active}`. Orbiter: row + state | AOI: `X-Tenant-Id`. Orbiter: `project_id`/`X-Project-Id`. All behind nginx basic-auth or IP-gate | Sync | none (built-in) | orbiter cadence enum fixed; sensor_mode enum fixed | **No twin/CRUD-of-twin object.** Compose AOI+orbiter. `orbiter.name` UNIQUE globally (not per-tenant) — watch collisions. |
| 3.2 | **EO / differential cube** | **PARTIAL** | `GET /api/imagery/timeline?context=optical\|sar&bbox=…`; `POST /api/imagery/diff`→202 + `GET /api/imagery/diff/{job}`; per-scene tiles | timeline: `context`,`bbox`|`aoi_id`,`max_cloud`,`limit`. diff: two scenes/method | timeline: `{aoi_id, context, scenes:[{scene_id, datetime, collection, sensor, band, cloud_cover, coverage_frac, thumb_url, has_tiles, footprint, bbox}]}` | project/basic-auth | timeline **sync**; diff **async (202+poll)** | none | timeline `limit≤500`; diff async | **No single "cube" endpoint** — assemble a series from `timeline` + per-scene tiles + `indicators/instances`. **SAR IS wired** (S1 c-band/l-band scenes, `context=sar`, `SAR_MONITOR` orbiter). Optical=S2. |
| 3.3 | **Soil / DEM / subsurface strata** | **NO** (**COULD-EXPOSE**) | would be `GET /api/evidence/rasters?kind=…` + tiles | `kind`,`bbox`,`project_id` | raster rows w/ COG tiles | project/basic-auth | Sync | — | — | **Zero soil-horizon/DEM rasters registered** (evidence_raster kinds are only mineral/leak/enhanced — see §2.3). A GLO-30 DEM builder exists in a worker but is **not surfaced** as a gateway raster. Cutaway strata would need a new producer registering `kind=dem`/`kind=soil`. |
| 3.4 | **Indicator matrix / signals / embeddings** | **PARTIAL (YES for signals, NO for the plan's schema)** | `GET /api/indicators/instances`; `GET /api/indicators/types`,`/categories`,`/layers`; embeddings `POST /api/ai/embeddings`,`/api/ai/similarity` | instances: `bbox`,`category`,`type`,`tier`,`minConfidence`,`limit`,`project_id` | **styled GeoJSON FeatureCollection**, camelCase props (see §2.4) | project (`project_id`/`X-Project-Id`) | Sync | none | `limit≤10000` | **Property names DIFFER from `02 §3.3`** → mapping layer required (Q4). Signal-TYPE catalog is huge (200+ slugs incl `ndvi_change_s2`,`ndwi_water_s2`,`soil_moisture_smap`,`ecostress_thermal`,`sar_*`) but populated INSTANCE data is **leak/mineral/detection**-focused, not per-parcel NDVI/EVI time series. Embeddings endpoints exist but no per-AOI vector-fetch contract. |
| 3.5 | **Tiles / imagery (map + texture)** | **YES** | `GET /api/imagery/{scene}/tiles/{z}/{x}/{y}.png` + `/tilejson.json` + `/thumbnail.png`; `GET /api/evidence/rasters/{id}/tiles/{z}/{x}/{y}.png` + tilejson; `GET /api/evidence/object?bucket=&key=`; **super-res** `POST /api/imagery/enhance`→202, `GET /api/imagery/enhance/{job}` | z/x/y ints; optional `bands`,`rescale`,`colormap` | `image/png` (TiTiler-rendered COG or proxied XYZ); tilejson JSON | nginx basic-auth / IP-gate (no per-tile signing) | tiles **sync**; enhance **async T3** | `AGC_TITILER_BASE` | scene tiles `minzoom8 maxzoom16`; evidence `minzoom6 maxzoom18`; `Cache-Control public max-age=86400` | **No per-tile URL signing / TTL / tenant token today** — scene tiles are addressable by `scene_id` alone. Signed-object access = `/api/evidence/object` proxy + MinIO presign (in `imagery_diff`). Enhanced rasters are **tier T3 "visualization not measurement."** |
| 3.6 | **Simulation / what-if** | **NO** (**COULD-EXPOSE**) | — | — | — | — | — | — | — | No yield/irrigation/disruption sim primitive. `crystal`/`science/evaluate` are **scoring**, not scenario sim. **All sim compute must be app-side deterministic** over relayed indicators for MVP (matches `08 §4.3`). |
| 3.7 | **Twin copilot (tools + reasoning)** | **YES** | `GET /api/geoagent/tools`; `POST /api/geoagent/chat` (SSE); `POST /api/geoagent/tool/{name}`; `POST /api/geoagent/tool-result/{call_id}`; plus `POST /api/reasoning/hypothesize\|corroborate\|adjudicate`, `GET /api/reasoning/explain/{id}` | chat: `{session_id, message, context}`; tool: `{...args}` | chat: **SSE** named events; tools: Anthropic `input_schema` + `side:server\|client` | context-passed / basic-auth | chat **streamed**; tool **sync** | Anthropic key server-side | — | Real agent tool-loop. ~server+frontend tools (find_aoi, scan_at_location, get_detection_timeseries, compare_scans, get_active_orbiters, materialize_template, super_resolve, geocode, web_search…). Grounds server-side over AOI/scan/insight/detection data. |
| 3.8 | **Event push (streams / webhooks)** | **NO** for twin/AOI (**COULD-EXPOSE**) | Existing (not twin): SSE `GET /api/harvest/jobs/{id}/events`, `GET /api/scans/{run_id}/events`, `GET /api/requests/stream`; Redis stream `GEOAI_INTENT_STREAM`, `_PROC_STREAM`; signed webhooks in `channels.py` (B3c) | — | SSE frames / stream msgs / signed POST | Bearer/basic/IP | Streamed / async | `REDIS_URL` | 30m SSE cap; 15s ping | **No per-AOI/twin change stream and no twin webhook today.** Closest reusable: (a) harvest SSE pattern wrapping Redis pub/sub `agc:gis-cache:{id}`, (b) `channels.py` HMAC-signed webhook delivery (retry/backoff, idempotent). **Core must be extended to publish a twin change stream** (matches `08` risk). |

---

## 2. Example payloads (real, captured from the running gateway)

### 2.1 Twin registry primitives

**AOI create** (`app_meta.aoi`, tenant-scoped via `X-Tenant-Id`):
```http
POST /api/aois   Header: X-Tenant-Id: <tenant-name>
{ "name":"Parcel 12", "boundary_geojson":{"type":"Polygon","coordinates":[...]}, "h3_parent_res":7, "manifest":{} }
--> 201
{ "aoi_id":"<uuid>", "tenant_id":"<uuid>", "name":"Parcel 12", "h3_parent_res":7, "active":true }
```

**Orbiter templates** (`GET /api/orbiters/templates`, real) — the persistent-monitor archetypes:
```json
[
 {"name":"ORBITER-01","sensor_mode":"PIPE_LEAK_ANALYSIS","cadence":"ON_DEMAND","state":"IDLE","analyzer_id":"gem.fluoridegeo_leak_discovery","color":"#22d3ee","icon":"satellite-leak"},
 {"name":"ORBITER-03","sensor_mode":"SAR_MONITOR","cadence":"DAILY","state":"IDLE","analyzer_id":"sar_coherence","icon":"satellite-sar"},
 {"name":"ORBITER-04","sensor_mode":"MOISTURE_SCAN","cadence":"DAILY","state":"IDLE","analyzer_id":"tau_omega","icon":"satellite-moisture"},
 {"name":"ORBITER-06","sensor_mode":"THERMAL_SCAN","cadence":"HOURLY","state":"STANDBY","analyzer_id":"thermal_anomaly","icon":"satellite-thermal"},
 {"name":"ORBITER-11","sensor_mode":"SUPER_RES","cadence":"DAILY","state":"IDLE","analyzer_id":"super_res"}
]
```
`app_meta.orbiter` columns (real `\d`): `orbiter_id uuid, name (UNIQUE), sensor_mode, analyzer_id, aoi_id FK→aoi, state, cadence, color, icon, config jsonb, project_id, created_at, updated_at`. Cascade children: `orbiter_run`, `orbiter_finding`, `orbiter_trail`, `orbiter_change_log`.

### 2.2 EO timeline (differential source) — `GET /api/imagery/timeline?context=optical&bbox=-70.77,19.79,-70.73,19.82` (real):
```json
{"aoi_id":null,"context":"optical","scenes":[
 {"scene_id":"68a996bc-3a3f-4481-bfae-89b77618f5a9","datetime":"2026-06-26T15:26:51Z","collection":"sentinel-2-l2a","sensor":"S2","band":"optical","cloud_cover":29.3,"coverage_frac":1.0,"thumb_url":"https://thumbnails.skyfi.com/…png","has_tiles":true,"footprint":{"type":"Polygon","coordinates":[[…]]},"bbox":[-70.910,18.894,-69.861,19.894]},
 {"scene_id":"bd4e7b0b-…","datetime":"2026-06-28T15:27:11Z","collection":"sentinel-2-l2a","sensor":"S2","band":"optical","cloud_cover":6.5,"coverage_frac":0.697,"has_tiles":true,"…"}
]}
```
`context=sar` returns S1 scenes with `band∈{cband,lband}`. **Assemble the "cube"** = `timeline` (dates) ⊕ per-date `tiles` ⊕ `indicators/instances` (values). `POST /api/imagery/diff`→`202 {jobId,status,method}`, poll `GET /api/imagery/diff/{job}` for KPI deltas.

### 2.3 Evidence rasters (`GET /api/evidence/rasters?limit=2`, real) — note **kinds**:
```json
{"rasters":[{"id":"8c1d20b3-…","source":"super_res_enhance","kind":"enhanced_imagery",
  "title":"Super-resolved imagery 2x (Real-ESRGAN, MSI)","bucket":"evidence-rasters",
  "key":"evidence_rasters/super_res_enhance/8c1d….tif","bbox":[-70.758,19.799,-70.746,19.809],
  "crs":"EPSG:32619","colormap":{"name":"viridis"},"stats":{"max":149,"min":0,"mean":33.4},"tier":"T3",
  "provenance":{"note":"generative enhancement (Real-ESRGAN): hallucinates high-frequency detail — visualization not measurement","model":"Real-ESRGAN_x2plus","scale":2,"job_id":"12c4…","source_scene":"autoscene_8b727510df86"},
  "tilejsonUrl":"/api/evidence/rasters/8c1d…/tilejson.json","tilesUrl":"/api/evidence/rasters/8c1d…/tiles/{z}/{x}/{y}.png"}], "count":34}
```
**Real distinct (source,kind) in `app_meta.evidence_raster` (all 34 rows):** `alteration_mineral`, `alteration_mineral_uncertainty`, `enhanced_imagery`, `alteration`, `leak_treated_water_prob`, `mineral_prospectivity`, `treated_water_epsprox`, `leak_prospectivity`, `prospectivity`, `coherence`. **No `dem`, no `soil`, no `ndvi` raster.**

### 2.4 Indicator instances (`GET /api/indicators/instances?bbox=…`, real) — **the shape that DIFFERS from `02 §3.3`**:
```json
{"type":"FeatureCollection","features":[
 {"type":"Feature","geometry":{"type":"MultiPolygon","coordinates":[[[…]]]},
  "properties":{
    "instanceId":"poi:1234","typeSlug":"water-leaks","category":"…","name":"Water leak candidate",
    "confidence":0.82,"tier":"T2","riskScore":0.91,"source":"alphageo_pois","modelSource":"fluoridegeo-trackFG",
    "observedAt":"2026-06-…","mapStyle":{…},"iconUrl":null,"linkedEntities":[],"recommendedAction":"…"
  }}
]}
```
**Plan expected** `measurement,value,confidence,cloud_pct,scene_id,acquired_at`. **Actual** `instanceId,typeSlug,category,name,confidence,tier,riskScore,source,modelSource,observedAt,mapStyle,iconUrl,linkedEntities,recommendedAction`. → **A mapping layer is mandatory** (`observedAt`→`acquired_at`; no `value`/`cloud_pct`/`scene_id` — closest are `riskScore`/`confidence`). Federates 6 producer tables (`app_meta.alphageo_pois`, `alphageo.subsurface_anomaly`, …) UNION-normalised, styled from `app_meta.viewer_def.map_style`.

### 2.5 Copilot tools (`GET /api/geoagent/tools`, real, Anthropic tool format + `side`):
```json
{"tools":[
 {"name":"super_resolve","description":"Super-resolve … ENHANCED VISUALIZATION ONLY (tier T3) … Async — returns a jobId to poll.","input_schema":{"type":"object","properties":{"lat":{"type":"number"},"lon":{"type":"number"},"scale":{"type":"integer","enum":[2,4],"default":2},"radius_m":{"type":"number","default":500}},"required":["lat","lon"]},"side":"server"},
 {"name":"find_aoi","input_schema":{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","default":5}},"required":["query"]},"side":"server"},
 {"name":"get_detection_timeseries","input_schema":{"properties":{"aoi_id":{"type":"string"}}},"side":"server"},
 {"name":"compare_scans","…":"…","side":"server"}
], "server_count":<n>, "frontend_count":<n>}
```
**Chat is SSE** (`POST /api/geoagent/chat`, body `{session_id,message,context}`): frames `event: hello` → per-turn `event: <message|tool_use|…>` → `event: close` (`event: error` on failure). Frontend tools resolve via `POST /api/geoagent/tool-result/{call_id}`; server tools also invokable directly via `POST /api/geoagent/tool/{name}`.

### 2.6 Harvest SSE (answers Q3 verbatim) — `GET /api/harvest/jobs/{jobId}/events`:
```
event: harvest.progress
data: {"type":"progress","pct":1,"stage":"discover","message":"harvest started for hv_…","status":"ok"}

event: harvest.progress
data: {"type":"progress","pct":60,"stage":"giscloud","message":"osm_water_mains: 812 features","status":"ok"}

: ping

event: harvest.complete
data: {"type":"complete","duration_ms":48213,"summary":{...}}
```
Error terminal: `event: harvest.error` / `data: {"type":"error","message":"…"}`. `POST /api/harvest/refresh`→`202 {jobId, startedAt, status:"queued", subProjectId, acceptedStages}`. **This bridge does OSM/GIS ingest (→`gis.feature_cache`), NOT an EO scan** — do not confuse it with the indicator/EO path.

---

## 3. §4 — the 12 open questions, answered verbatim (TODAY vs PLANNED)

**Q1. Does the gateway expose ANY existing twin-state or digital-twin endpoint …?**
**TODAY:** **NO.** Confirmed empirically — 311 paths, zero `twin` surfaces, no `twin` table. Your canonical docs are right; the task brief is wrong. The closest persistent primitives are `app_meta.aoi` (tenant-scoped geometry registry) + `app_meta.orbiter` (persistent, AOI-bound, stateful, cadenced monitor) + its `orbiter_run`/`orbiter_finding`/`evidence_raster`/indicator-instances children.
**PLANNED:** Keep the twin object in `farm.*` (as `08` says); have `/api/farm/*` *compose* AOI+orbiter+runs+findings+rasters+instances. **No gateway change required** to stand up a twin — it is a composition.

**Q2. Do the delegate internals (`scan_pipeline.enqueue(bbox,analyses,tenant,aoi)`, `.stream(job_id)`, `indicator_svc.query_bbox(bbox,kinds,limit)`) exist, with what signatures?**
**TODAY:** **Those exact symbols do NOT exist** — they are illustrative skeletons. The real equivalents:
- *Enqueue a scan:* not `scan_pipeline.enqueue`. GIS harvest = `harvest_refresh()` → RQ `q.enqueue("alphageocore.jobs.harvest_jobs.run_harvest", job_id, sub_project_id, bbox, stages, gis_kinds)` on queue `agc-low`. EO scan-at-point = the geoagent server tool **`scan_at_location`** / **`scan_here`** and the `/api/scan-requests` + orbiter-runner path (`orbiters/runner.py`, which `xadd`s to `GEOAI_INTENT_STREAM`).
- *Stream:* not `.stream(job_id)`. Real progress stream = `GET /api/harvest/jobs/{jobId}/events` (SSE, wraps Redis pub/sub `agc:gis-cache:{id}`) and `GET /api/scans/{run_id}/events`.
- *Indicator query:* not `indicator_svc.query_bbox`. Real = `GET /api/indicators/instances` → `list_instances(bbox,category,type,tier,minConfidence,limit,project_id)`, a federated SQL UNION over producer tables (not a callable service object).
**PLANNED:** Relay clones should call the **HTTP** surfaces above, not import Python symbols.

**Q3. Native SSE tick shape and `_final` payload?**
**TODAY (definitive, from `harvest_routes.py`):** It is **option B** — `event: harvest.progress` / `data:{"type":"progress","pct":<int>,"stage":"discover|giscloud","message":<str>,"status":"ok|error"}`. Terminal is a **named** `event: harvest.complete` / `data:{"type":"complete","duration_ms":<int>,"summary":{…}}` (never a progress tick). Failure = `event: harvest.error` / `data:{"type":"error","message":<str>}`. Heartbeat `: ping` every ~15s; hard cap 30m; orphan-timeout 120s. **Note:** the geoagent copilot SSE uses a *different* envelope (`hello`/…/`close`). Port `normalizeHarvestTick` against the harvest shape for the ingest relay, and a separate parser for the copilot.

**Q4. Does the indicator federation return per-AOI GeoJSON with `measurement/value/confidence/cloud_pct/scene_id/acquired_at`, or must a mapping layer be built?**
**TODAY:** **A mapping layer MUST be built.** Real props are camelCase and different (see §2.4): `instanceId,typeSlug,category,name,confidence,tier,riskScore,source,modelSource,observedAt,mapStyle,iconUrl,linkedEntities,recommendedAction`. There is **no `value`, `cloud_pct`, or `scene_id`** on the feature; `observedAt`≈`acquired_at`, `riskScore`/`confidence` are the numeric signals. `cloud_pct`/`scene_id` live on the **scene** (`imagery/timeline`), not the indicator instance — join app-side.
**PLANNED:** Farm relay owns the normalizer (`observedAt→acquired_at`, choose `riskScore` or `confidence` as `value`, backfill `scene_id`/`cloud_pct` from the timeline).

**Q5. Which signal kinds are really available (ndvi/evi/water_stress/change), SAR/water-stress wired or optical-only?**
**TODAY:**
- *Populated indicator INSTANCES* are **leak/mineral/detection**: `water-leaks` (`alphageo_pois`, `subsurface_anomaly`), `ai-detections`, mineral/`crystal.*`, plus subsurface anomaly. **Not** per-parcel NDVI/EVI/water-stress time series.
- *Signal-TYPE catalog* (`app_meta.viewer_def`, 200+ slugs) **does** define `ndvi_change_s2`, `ndwi_water_s2`, `soil_moisture_smap`, `soil-moisture`, `ecostress_thermal`, `ecostress_et`, `evi_modis`, `crop-stress`, `drought_index_ts`, `sar_change_log_ratio`, `sar_coherence_pair`, `dinsar_deformation`, `thermal_anomaly_viirs`, `groundwater_proxy_grace` — but these are **catalog definitions without instance data** for farm parcels today.
- *SAR is genuinely wired* at the **scene/tile** level: S1 c-band + l-band scenes, `imagery/timeline?context=sar`, `SAR_MONITOR` orbiter, `sar_coherence` analyzer. **Optical (S2) + SAR (S1) scenes are real; agronomic indices (NDVI/EVI/water-stress) as per-parcel signals are NOT produced yet** — they need an indicator producer/orbiter run.
**PLANNED:** To get NDVI/EVI/water-stress per parcel you must **run** a scan/orbiter that emits those indicator instances (the analyzers exist as types; wire a producer). Optical+SAR imagery is available now to compute app-side if needed.

**Q6. Does the gateway expose a Redis change stream today, or must Core be extended?**
**TODAY:** **No twin/AOI change stream.** Existing Redis machinery is internal: `GEOAI_INTENT_STREAM` (`xadd`, geoagent intent bus, `maxlen=10000`), `_PROC_STREAM` (imagery-diff), pub/sub `agc:gis-cache:{id}` (SSE-wrapped by harvest), and `channels.py` request pub/sub. None is a documented per-AOI change contract.
**PLANNED:** **Core must be extended to publish** a `twin/AOI change` stream (stream name, message schema, consumer group are undefined — the farm side must define them, `06 D3`). Reuse patterns: harvest SSE wrapper (co-located) + `channels.py` HMAC-signed webhook (remote). This confirms the plan's risk.

**Q7. Exact `ALPHAGEO_HARVEST_TOKEN` / `ALPHAGEO_FARM_BASE` / `ALPHAGEO_GATEWAY_ORIGIN` env wirings + nginx IP-gate?**
**TODAY (on the gateway container):** present env NAMES = `ALPHAGEO_HARVEST_TOKEN` (=set, the harvest Bearer secret), `API_DEFAULT_TENANT` (=set), `AGC_TITILER_BASE` (=set). **`ALPHAGEO_FARM_BASE` and `ALPHAGEO_GATEWAY_ORIGIN` are NOT set on the gateway** — those are **client/RWR-side** vars (they belong on the *farm relay* process that calls the gateway), not on the gateway. Harvest tunables (defaults, unset): `ALPHAGEO_HARVEST_MAX_SPAN_DEG=0.25`, `ALPHAGEO_HARVEST_ORPHAN_TIMEOUT_S=120`.
**nginx (`public-api`, real):**
- `location /api/harvest/ { allow 108.61.190.109; deny all; proxy_pass …:7777; }` — **IP allow-list only, no basic-auth** (the router enforces `Bearer ALPHAGEO_HARVEST_TOKEN`). `108.61.190.109` is the RWR/farm client egress IP.
- `location /api/ { auth_basic "AlphaGeo API"; auth_basic_user_file /etc/nginx/htpasswd; }` — **HTTP Basic** for the general REST family.
- `location /api/detections…`, `location /api/fluoridegeo/ { satisfy any; allow 108.61.190.109; deny all; auth_basic … }` — **IP OR basic**.
- Real client IP recovered behind Caddy TLS via `X-Real-IP`/`X-Forwarded-For`.
**PLANNED:** the farm relay egresses from `108.61.190.109`, sends `Authorization: Bearer $ALPHAGEO_HARVEST_TOKEN`; a `/api/farm/` nginx block should mirror the harvest block (`allow 108.61.190.109; deny all`).

**Q8. Is commercial-tasking escalation truly out of the current pipeline?**
**TODAY:** The **capability physically exists** as the SkyFi router (`POST /api/skyfi/order`, `/api/skyfi/estimate`, `/api/skyfi/search`, `GET/POST /api/skyfi/budget`, `/api/skyfi/orders/*`) — but it is **budget-gated + credential-gated** and is a **separate surface**. The free EO scan / harvest / indicator / imagery relay path **does not call it**. So for the farm relay path, **yes — commercial tasking is out of the pipeline** (it would only be reached by an explicit, budget-approved SkyFi order call).
**PLANNED:** keep SkyFi off the farm relay; if ever needed, gate behind an explicit entitlement + `POST /api/skyfi/estimate`→`/order` with budget check.

**Q9. Any simulation / scenario-modeling primitive, or must all sim be app-side?**
**TODAY:** **No sim primitive.** No yield/irrigation/disruption endpoint. `crystal` (`POST /api/crystal/scan`) and `POST /api/science/evaluate` are **scoring/formula evaluation**, not scenario what-if. `insights` are analytic summaries, not simulations.
**PLANNED:** **All MVP sim compute is app-side deterministic** over relayed indicator/imagery data (exactly `08 §4.3`). `twin_sim_run.gateway_job_id` stays null. COULD-EXPOSE later as a new analyzer/orbiter sensor_mode or a `gem`, but nothing to delegate to today.

**Q10. Soil-horizon / DEM / elevation rasters (SoilGrids) available (STAC/COG or tiles), or only optical/indicator?**
**TODAY:** **NOT available through the gateway.** `app_meta.evidence_raster` holds **only** mineral/leak/enhanced-imagery/coherence rasters (§2.3) — **zero DEM, zero soil**. `alphageo.scene` is optical(S2)+SAR(S1). Only optical/indicator/mineral rasters are served.
**PLANNED (COULD-EXPOSE):** A GLO-30 DEM builder exists inside a subsurface worker but is **not registered** as a gateway evidence_raster. To feed the cutaway strata you'd (a) run a producer that writes a COG to MinIO + registers a row with `kind=dem`/`kind=soil` (then it's instantly tile-served via `/api/evidence/rasters/{id}/tiles/{z}/{x}/{y}.png`), or (b) fetch SoilGrids/Copernicus DEM app-side. No gateway change is needed to *serve* such a raster once registered — only to *produce* it.

**Q11. Signed COG URLs and/or `{z}/{x}/{y}` tiles per farm AOI with tenant scoping — auth/caching semantics for R3F?**
**TODAY:**
- **`{z}/{x}/{y}` tiles: YES.** `GET /api/imagery/{scene}/tiles/{z}/{x}/{y}.png` + `tilejson.json` (`minzoom8 maxzoom16`, TiTiler-rendered COG, per-sensor viz defaults, `Cache-Control: public, max-age=86400`). Evidence rasters: `/api/evidence/rasters/{id}/tiles/{z}/{x}/{y}.png` (`minzoom6 maxzoom18`).
- **Signed COG object URLs: PARTIAL.** `GET /api/evidence/object?bucket=&key=` proxies MinIO objects; `imagery_diff.py` builds AWS-SigV4 **presigned** MinIO URLs internally. There is **no public "give me a signed COG URL for this AOI" endpoint**.
- **Tenant scoping on tiles: NONE at the tile layer.** Scene/raster tiles are addressable by `scene_id`/`raster_id` alone (no tenant token, no per-tile TTL). Scoping happens *upstream* at `list`/`timeline`/`rasters` by `project_id`. Behind nginx the whole `/api/` family is basic-auth/IP-gated, so tiles aren't open to the world, but they are **not per-AOI-scoped or per-tile-signed**.
**PLANNED:** For R3F embedding you either (a) proxy tiles through the farm relay (which injects tenant scope + your own signed/TTL URL), or (b) accept the shared basic-auth/IP gate. Per-AOI signed tile URLs with TTL = **a farm-relay responsibility**, not a gateway feature today.

**Q12. Locate or declare-missing the §7.5 twin contract / `DIGITAL_TWIN_COPILOT_PATTERN.md` / `REPORTFARM_DIGITAL_TWIN_MEGAPROMPT.md`; who authors the twin contract, copilot schema, Redis event schema?**
**TODAY:** Those docs **do not exist on the gateway side either** — the gateway ships **no twin contract, no farm copilot schema, no twin Redis event schema**. What the gateway *does* provide as ground truth for authoring them: the **real geoagent tool registry** (`GET /api/geoagent/tools`, Anthropic `input_schema`+`side`) as the copilot substrate, the harvest SSE envelope as the progress contract, the `channels.py` signed-webhook mechanism as the delivery pattern, and the indicator/imagery/evidence shapes above.
**PLANNED / ownership:** The **Report.Farm side authors all three** (they are app-tier artifacts): the twin contract composes the primitives in §0; the copilot grounding/tool schema wraps `/api/geoagent/*` + `/api/farm/*`; the Redis change-event schema is net-new and requires a Core extension (Q6). The gateway will not author or host them.

---

## 4. Cross-cutting: limits, auth, TODAY vs PLANNED

**Auth model (per surface, real):**
- **Tenant scoping is not uniform.** `aoi`/`orbiter`-family use `X-Tenant-Id` (`current_tenant`, defaults to `API_DEFAULT_TENANT`) or `project_id`. `indicators`/`imagery`/`evidence` use `?project_id=` / `X-Project-Id` (default `''` = seed rows). **These are WHERE-clause scopes, not DB RLS** on the read routers — the farm relay must enforce tenant isolation itself.
- **Perimeter:** nginx basic-auth (`/api/`), IP allow-list `108.61.190.109` (`/api/harvest/`, `satisfy any` on detections/fluoridegeo), Bearer `ALPHAGEO_HARVEST_TOKEN` (harvest router). MCP surface at `/mcp` (Bearer `ALPHAGEO_MCP_TOKEN`).

**Hard limits (real):** harvest bbox span ≤ `0.25°` (~27 km) else 422; harvest orphan-timeout 120s, hard cap 30m, ping 15s; `indicators/instances limit≤10000` (default 2000); `imagery/timeline limit≤500` (default 60); scene tiles `z 8–16`, evidence tiles `z 6–18`; tile `Cache-Control max-age=86400`. Orbiter `cadence`/`sensor_mode`/`state` are fixed enums (see §2.1). SkyFi orders are budget-gated.

**TODAY vs PLANNED headline:**
- **TODAY (real, consumable now):** AOI+orbiter registry; scene/timeline (optical+SAR); COG `{z}/{x}/{y}` tiles + tilejson; evidence rasters (mineral/leak/enhanced) + super-res (T3 async); federated indicator instances (leak/mineral/detection); geoagent tool-loop + reasoning; harvest GIS ingest + SSE; SkyFi tasking (gated); signed webhooks in channels.
- **PLANNED / must-build (farm side unless noted):** the `/api/farm/*` relay itself; NDVI/EVI/water-stress **per-parcel indicator producers** (types exist, instances don't); soil/DEM raster **producers** (then auto-served); a **twin change Redis stream (Core extension)**; per-AOI **signed/TTL tile** proxying; **sim compute** (app-side deterministic); the twin contract + copilot schema + event schema docs; an indicator **property-mapping** normalizer.

---

## 5. One-paragraph verdict for the farm agent

Build the twin **entirely in `farm.*`** and treat the gateway as a stateless EO/scan/indicator/imagery/evidence/copilot surface — the plan (`08`) is correct and the task brief's "gateway already supports twins" premise is false. Your `/api/farm/*` relay should compose **AOI (persistent, `X-Tenant-Id`) + orbiter (persistent stateful AOI-bound monitor, `project_id`) + orbiter_run/finding + evidence_raster tiles + indicator instances + imagery timeline/tiles** into the twin read, delegate the copilot to the real `/api/geoagent/*` tool-loop, and accept that NDVI/EVI/water-stress-per-parcel signals, soil/DEM strata, a per-AOI change stream, per-tile tenant signing, and any simulation are **not there yet** — types and builders exist for several, but instance data / gateway exposure must be produced. Port `normalizeHarvestTick` against the `{type:'progress',pct,stage,message,status}` + named `harvest.complete` envelope, and build a mapping layer for the camelCase indicator FeatureCollection.
