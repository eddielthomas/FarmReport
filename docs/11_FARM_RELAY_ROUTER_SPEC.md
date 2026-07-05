# 11 — `/api/farm/*` Gateway Relay Router: SPEC + DRAFT SKELETON

> **Author:** Gateway agent. **Status:** ✅ **DEPLOYED + VERIFIED** on the live gateway (`alphageo-api-gateway`, image committed). Additive + backward-compatible (all pre-existing surfaces intact). Grounded in doc 10 (empirical survey) + the real `harvest_routes.py` idiom it clones.
> **Code:** `D:\Projects\AlphaGeoCore\infra\hetzner\farm\gateway\farm_routes.py` (+ mount patch `patch_gateway_farm.py`). `py_compile`-clean; live at `/app/alphageocore/dashboard/farm_routes.py`.
> **Premise (from doc 10):** the gateway holds **no twin state**. This router only **composes + relays** the gateway's stateless primitives; twin state/config/scheduling/sim/provenance stay in `farm.*` (doc 08 D1).
>
> **Verified live (Puerto Plata AOI `c05f7b1f…`):** auth 401 without token; `POST /api/farm/scan {signals:[sar,ndvi]}` → 202 fast; background EO producer launched a **real** `SAR_MONITOR` orbiter + run (`sar`→`launched`, `ndvi`→honest `no_producer`); `signals-by-bbox` → normalized FC (`measurement/value/acquiredAt`, `sceneId=null`); `twins/{aoi}` → composed twin (AOI + orbiters incl. the new SAR monitor + 10 rasters + 500 signals). Backward-compat regression: elements/crystal/orbiters/reasoning/geoagent/super-res all still 200/202.

---

## 0. What this is and where it lives

A gateway-side, **additive, import-guarded** router — a sibling of `/api/harvest/*` (`alphageocore/dashboard/harvest_routes.py`) and the crystal surface. It gives Report.Farm a **twin-shaped surface** so the app makes one call per intent instead of orchestrating 6 gateway families. Deploy idiom is identical to the crystal/super-res features already shipped:

- Router file → `/app/alphageocore/dashboard/farm_routes.py`.
- Mount → `patch_gateway_farm.py` inserts an import-guarded `include_router` block before `_start_metrics_server()` in `phase41_api_gateway.py` (byte-for-byte the harvest/crystal pattern).
- `py_compile` all routers → restart gateway → healthz-gate (`/api/elements`=200, `/api/reasoning` preserved) → `docker commit` to the running tag. Rollback = per-file `.bak` + snapshot image.

**It is NOT the RWR `server.mjs` forwarder.** `server.mjs` is the farm *client* that byte-forwards to this gateway router. Doc 08 §4.2 says "clone `server.mjs` harvest section → `/api/farm/refresh`, jobs SSE, signals-by-bbox" — that's the *client*; this spec is the **gateway endpoint** it forwards to.

---

## 1. Endpoints (implemented in the skeleton)

| Method + path | Purpose | Real today? | Composes |
|---|---|---|---|
| `POST /api/farm/scan` | Enqueue a twin scan for an AOI/bbox → `202 {jobId,…}` | **REAL** (GIS baseline + real EO orbiter producers for sar/moisture/thermal/superres; ndvi honest no_producer) | `run_harvest` RQ + `/api/orbiters` launch (doc 10 Q2/Q5) |
| `GET /api/farm/jobs/{jobId}/events` | SSE live progress `farm.progress\|farm.complete\|farm.error` | **REAL** (wraps `agc:gis-cache:{jobId}` pub/sub) | harvest SSE clone (doc 10 Q3) |
| `GET /api/farm/jobs/{jobId}` | Poll-style status snapshot | **REAL** | redis job state |
| `GET /api/farm/signals-by-bbox` | Indicator instances → **normalized** farm GeoJSON FC | **REAL** (empty until producers run) | `/api/indicators/instances` + mapping layer (doc 10 Q4) |
| `GET /api/farm/twins/{aoi_id}` | Composed twin read (AOI+orbiters+rasters+signals) | **REAL** (composition, no twin table) | `app_meta.aoi/orbiter/evidence_raster` + signals (doc 10 §0) |

### 1.1 `POST /api/farm/scan`
Request (camelCase or snake accepted):
```json
{ "aoi_id":"<uuid>",            // or "sub_project_id", or "bbox":[W,S,E,N]
  "signals":["ndvi","moisture","thermal","sar"],
  "tenant_id":"<uuid>" }
```
`202` (farm-native envelope, cloned from harvest):
```json
{ "jobId":"farm_ab12…", "startedAt":"2026-07-…Z", "status":"queued",
  "aoiId":"<uuid>", "subProjectId":null, "acceptedSignals":["ndvi","moisture","thermal","sar"] }
```
- Resolves bbox from explicit `bbox` else `app_meta.aoi` (by `aoi_id`/`project_id`/name). **No silent-empty**: unresolved → `422 unknown_aoi_or_no_bbox`. Span > `0.25°` → `422 bbox_too_large`.
- Idempotent per scope (active job reused).
- **REAL work today:** enqueues `alphageocore.jobs.harvest_jobs.run_harvest` (GIS ingest, streams on `agc:gis-cache:{jobId}`).
- **Extension point (marked TODO in code):** for each requested EO/agronomic `signal`, enqueue the real indicator producer / orbiter run (doc 10 Q5 — the analyzer *types* exist; instances need a producer). **Do not fabricate** signal instances.

### 1.2 `GET /api/farm/jobs/{jobId}/events` (SSE)
Named events, farm envelope (exactly the harvest tick shape with `farm.*` names so the client's `normalizeTick` keys on it):
```
event: farm.progress
data: {"type":"progress","pct":25,"stage":"signals","message":"osm_water_mains: 812 features","status":"ok"}

: ping

event: farm.complete
data: {"type":"complete","duration_ms":48213,"summary":{…}}
```
Failure terminal `event: farm.error`. `: ping` ~15 s; orphan-timeout 120 s (dead worker → honest `farm.error`, never hangs); hard cap 30 m. Never fabricates completion.

### 1.3 `GET /api/farm/signals-by-bbox?bbox=W,S,E,N&category=&type=&tier=&minConfidence=&limit=&project_id=`
Delegates to the gateway's own `/api/indicators/instances`, then applies **the mapping layer doc 10 Q4 mandates** (see §2). Returns `{type:"FeatureCollection", features:[…], count, schema:"farm.signal.v1"}`. Honest empty FC when no producers have run.

### 1.4 `GET /api/farm/twins/{aoi_id}`
Composes the closest real "twin": AOI (geometry/bbox/active/project) + its **orbiters** (persistent stateful monitors) + **evidence rasters** intersecting the bbox (with tilejson URLs) + normalized **signals**. `schema:"farm.twin.v1"`. This is the composition doc 10 §0 recommends — there is no twin table to read.

---

## 2. The indicator mapping layer (doc 10 Q4 — mandatory)

Gateway instances are camelCase and **differ from doc 02 §3.3**. The skeleton's `_map_feature` normalizes each Feature:

| Gateway property (real) | → Farm/plan property | Note |
|---|---|---|
| `observedAt` | `acquiredAt` | direct rename |
| `riskScore` ?? `confidence` | `value` | no raw `value` exists; pick riskScore, fall back to confidence |
| `confidence` | `confidence` | kept |
| `typeSlug` | `measurement` | the signal kind |
| `tier`,`category`,`name`,`source`,`modelSource`,`recommendedAction`,`mapStyle` | same | passthrough |
| — | `sceneId` = `null` | **not on the instance** — join from `/api/imagery/timeline` app-side |
| — | `cloudPct` = `null` | same (scene-level, not instance-level) |
| (whole original) | `_raw` | kept for debugging |

`sceneId`/`cloudPct` are honestly `null` (they live on the scene, not the indicator) — the farm side joins them from the imagery timeline if needed.

---

## 3. Auth, nginx, env

- **Auth:** `Authorization: Bearer $ALPHAGEO_FARM_TOKEN`, constant-time compare; **falls back to `ALPHAGEO_HARVEST_TOKEN`** so the existing RWR egress secret works with zero new env. `503` if unconfigured, `401` if wrong.
- **nginx (add, mirroring the harvest block):**
  ```nginx
  location /api/farm/ { allow 108.61.190.109; deny all; proxy_pass http://…:7777; }
  ```
  IP-gate the RWR/farm egress `108.61.190.109` (doc 10 Q7); the router still enforces the Bearer token (defence in depth). SSE needs `proxy_buffering off;` + long read timeout.
- **Env (gateway):** `ALPHAGEO_HARVEST_TOKEN` already set. Optional new: `ALPHAGEO_FARM_TOKEN`, `ALPHAGEO_SELF_ORIGIN` (default `http://127.0.0.1:7777`), `ALPHAGEO_FARM_MAX_SPAN_DEG` (0.25). `ALPHAGEO_FARM_BASE`/`ALPHAGEO_GATEWAY_ORIGIN` stay **client-side** (on the farm relay), not the gateway.

---

## 4. What is REAL vs STUBBED (deployed)

- **REAL now:** bbox resolution from `app_meta.aoi`; GIS scan enqueue (`run_harvest`) + its SSE stream; job status; `signals-by-bbox` federation + normalizer; twin composition (AOI+orbiter+raster+signals). **EO producers ARE wired** — recognized `signals` launch a real per-AOI orbiter run via the existing `/api/orbiters` create+launch endpoints, mapped:
  - `sar`/`coherence`/`radar` → `SAR_MONITOR` (`sar_coherence`)
  - `moisture`/`soil_moisture`/`water_stress` → `MOISTURE_SCAN` (`tau_omega`)
  - `thermal`/`heat` → `THERMAL_SCAN` (`thermal_anomaly`)
  - `superres`/`enhance`/`imagery` → `SUPER_RES` (Real-ESRGAN)
  Producers run as a `BackgroundTasks` step (the 202 never blocks); a per-AOI orbiter is created-or-reused by name `farm-{aoi8}-{sensor_mode}` (fast DB lookup) and launched ON_DEMAND. Results land on `GET /api/farm/jobs/{jobId}.producers`.
- **HONEST GAP (not stubbed — genuinely absent):** `ndvi`/`evi`/`vegetation` have **no orbiter producer today** → recorded as `no_producer` (never fabricated). Add an NDVI producer (an S2 analyzer that writes indicator instances) to close it. Signals only appear in `signals-by-bbox` once a real producer has written instances (leak/mineral/detection + whatever the launched orbiters emit).

---

## 5. Deploy + verify (when approved — NOT done yet)

1. `docker cp farm_routes.py alphageo-api-gateway:/app/alphageocore/dashboard/farm_routes.py`
2. `docker cp patch_gateway_farm.py …:/tmp/ && docker exec … python3 /tmp/patch_gateway_farm.py`
3. `py_compile` all routers → `docker restart` → healthz-gate (`/api/elements`=200, `/api/reasoning/healthz` present) → on pass `docker commit` to the running tag; on fail restore `.bak` + restart.
4. Add the nginx `/api/farm/` block on the public-api proxy + reload.
5. Smoke (Bearer token, from the `108.61.190.109` egress): `POST /api/farm/scan {aoi_id}` → 202; open `…/events` → `farm.progress`→`farm.complete`; `GET /api/farm/signals-by-bbox?bbox=…` → normalized FC; `GET /api/farm/twins/{aoi_id}` → composed object.

---

## 6. Open decisions for the farm side

1. **EO signal producers** — which orbiter sensor_modes / analyzers back `ndvi/moisture/thermal/sar` per parcel, and do they run on-demand (per `farm/scan`) or on a cadence (orbiter)? (doc 10 Q5.)
2. **Twin change stream** — the per-AOI Redis change stream is a **Core extension** (doc 10 Q6): define stream name + message schema + consumer group; the farm outbox consumes it. Not in this skeleton.
3. **Per-tenant tile signing** — tiles have no per-tenant TTL today (doc 10 Q11). Either proxy tiles through the farm relay (inject tenant + signed URL) or accept the shared basic-auth/IP gate.
4. **Scan billing hook** — meter `POST /api/farm/scan` per `tenant_id` at enqueue (doc 08 §Billing).
