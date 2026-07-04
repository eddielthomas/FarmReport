# 02 — Report.Farm → AlphaGeo Integration (the new request pipeline)

> **Goal.** Add a **new request pipeline** from Report.Farm into AlphaGeo and its gateway, mirroring RWR's proven harvest relay. Report.Farm sends a farm AOI to AlphaGeo, AlphaGeo runs its existing scan/EO/indicator pipelines, and results return as farm **Observations / DerivedSignals / Alerts**. **Additive-only** on the AlphaGeo side.

> **Owners:** AlphaGeo-Integration Engineer (A2, the Node relay side) + Gateway Engineer (A3, the FastAPI side). Agree the contract in §3 before either builds.

---

## 1. The two proven patterns we are copying

### 1a. RWR's harvest relay (synchronous, SSE progress) — `api/server.mjs`

RWR's Node API runs in one of two modes (`api/server.mjs` ~lines 208–680):

- **`local`** (no `ALPHAGEO_HARVEST_BASE`): spawns an in-repo Python orchestrator, streams its NDJSON stdout as SSE.
- **`relay`** (`ALPHAGEO_HARVEST_BASE` set): `POST {base}/refresh` → `{job_id}`; opens the gateway's SSE `GET {base}/jobs/{job_id}/events`; **normalizes** each gateway `tick` into the browser envelope `event: harvest.progress | harvest.complete | harvest.error`.

The browser contract is identical in both modes. The relay proof test is `.qa-harvest-relay-test.mjs`: mock gateway → RWR API in relay mode → assert the browser receives normalized `harvest.*` events (discover→25%, native tick passthrough→50%, giscloud→75%, `_final`→`harvest.complete` with summary).

### 1b. RWR's background ingest (persist results) — `api/ingest-alphageo.mjs` + `api/v1/crm/ingest-core.mjs`

On boot + on an interval (`ALPHAGEO_AUTO_INGEST=1`), for every gateway-backed project AOI: pull current indicators via the internal leak relay (`GET /api/leaks/by-bbox`), open a **system scan row**, and **upsert** features into `crm.detection` in a **per-tenant transaction** with the tenant GUC bound (so RLS `WITH CHECK` is satisfied). Idempotent by `(project_id, external_id)`.

### 1c. The gateway add pattern — `phase41_api_gateway.py`

Every AlphaGeo surface is mounted with an **import-guarded** block. `harvest_routes`, `imagery`, `detection_routes`, `orbital_routes`, `opsglobe_routes` are all mounted this way. Adding `farm_routes` is one more identical block. The Indicator Matrix (`/api/indicators/*`) was added the same way — it is the direct precedent.

## 2. Farm-module → AlphaGeo-capability map (what EXISTS today to reuse)

Report.Farm does **not** build new EO analytics — it consumes AlphaGeo's. Map the research-doc modules onto capabilities the box already has:

| Farm module (research doc) | AlphaGeo capability reused | Returns as |
|---|---|---|
| **Crop health** (NDVI/EVI/canopy trend) | Sentinel-2 L2A indices via the scan/EO pipeline; `/api/imagery/timeline` for dated scenes; indicator instances | Observation (`measurement.name=ndvi/evi`) + DerivedSignal (trend/delta) |
| **Water intelligence** (soil-moisture proxy, waterlogging, standing water) | SAR (S1 C-band / L-band) backscatter + optical fusion; change detection; the leak-science water/dielectric stack | Observation (water_stress, standing_water) + Alert (zone-intent violation) |
| **Change detection** (unauthorized change, flooding expansion) | AlphaGeo multi-date change detection over zone masks | DerivedSignal + Alert |
| **Disease/pest risk** | Stress-cluster anomaly detection over the index time series + weather features | DerivedSignal (risk score) + Recommendation |
| **Yield/profit** | Historical zone signals + baseline regression (AlphaGeo analytics workers) | Report section + Recommendation (revenue-at-risk) |
| **Imagery/scene catalog** | STAC index + `/api/imagery/{scene_id}/tilejson` + `/api/evidence/object` proxy | ImageryScene + report evidence panels |
| **Revisit / next-pass** | `/api/opsglobe/*` (SGP4 pass prediction) or `predictPasses` client engine | onboarding "next pass" + report freshness |

**Free-EO-first:** every routine signal above runs on Sentinel-2/Landsat. Commercial tasking is a separate, user-authorized escalation path (out of MVP scope; the pipeline just needs to not preclude it).

## 3. The `/api/farm/*` contract (agree BEFORE building — A2 ⇄ A3)

Modeled on the harvest relay + the time-scrubber/imagery gateway specs (fail-soft, lights up endpoint-by-endpoint, additive, no fabrication).

### 3.1 Kick a farm scan — `POST /api/farm/scan`

Request (from the Report.Farm Node API, server-to-server, `Authorization: Bearer $ALPHAGEO_HARVEST_TOKEN`):
```json
{
  "farm_id": "farm_01J0…",
  "tenant_id": "tenant_8f2d",
  "aoi": { "type": "Polygon", "crs": "EPSG:4326", "coordinates": [[...]] },
  "bbox": [W, S, E, N],
  "signals": ["ndvi", "evi", "water_stress", "change"],
  "context": "optical",
  "max_cloud": 30
}
```
Response `202`:
```json
{ "job_id": "farm-job-abc123" }
```
Rules: always send `bbox` (so the gateway never falls back to an AOI table it doesn't have — the exact `no_bbox` guard RWR uses). `signals` selects which AlphaGeo analyses to run.

### 3.2 Stream progress — `GET /api/farm/jobs/{job_id}/events` (SSE)

Server-Sent Events; each frame is `event: tick` with a JSON `data` payload in AlphaGeo's native shape (`{stage, state, done, total, message}` or `{type:'progress', pct, stage, message}`), terminating with a `_final` tick carrying a `summary`. The Report.Farm Node relay **normalizes** these to `farm.progress` / `farm.complete` / `farm.error` for the browser — reuse RWR's `normalizeHarvestTick` verbatim, renamed.

### 3.3 Fetch current farm signals — `GET /api/farm/signals-by-bbox?west=&south=&east=&north=&signals=ndvi,water&limit=5000`

Returns a **GeoJSON FeatureCollection** of the AOI's current derived signals (the farm analogue of RWR's `GET /api/leaks/by-bbox`). Each feature:
```json
{
  "type": "Feature",
  "id": "sig_…",
  "geometry": { "type": "Polygon", "coordinates": [[...]] },
  "properties": {
    "measurement": "ndvi", "value": 0.73, "unit": "ratio",
    "confidence": 0.94, "cloud_pct": 2.3,
    "scene_id": "S2A_MSIL2A_…", "acquired_at": "2026-06-30T14:25:00Z",
    "zone_hint": "field", "flags": ["surface-reflectance","clear-sky"]
  }
}
```
**No fabrication:** if no scenes cover the AOI, return `{ "features": [] }` and the FE shows an honest empty-state.

### 3.4 Evidence + tiles (reuse existing, no new work)

- Scene thumbnails / rasters: the existing `/api/evidence/object?bucket=…&key=…` proxy and `/api/imagery/{scene_id}/tiles/{z}/{x}/{y}.png` + `tilejson.json` (from the imagery router already in `phase41_api_gateway.py`).
- Dated ticks for the farm timeline: existing `GET /api/imagery/timeline?bbox=…&context=optical|sar`.

### 3.5 Cross-cutting rules (from the imagery/time-scrubber specs)

- Auth: `Authorization: Bearer $ALPHAGEO_HARVEST_TOKEN` server-to-server; nginx IP-gate in front (same as harvest).
- Dates: ISO 8601 UTC. Versioning: additive; unknown field ⇒ omit (consumer treats missing as null).
- No fabrication; real scenes + real values only; missing ⇒ null/empty-state.

## 4. AlphaGeo side — the additive gateway router (A3)

Create `src/alphageocore/api/routers/farm.py` (repo) → deployed to `/app/alphageocore/api/routers/farm.py`. It exposes §3's endpoints, delegating to the **existing** scan/EO/indicator pipeline (the same code paths `harvest_routes` and the scan workers use). Then mount it in `phase41_api_gateway.py` with one more import-guarded block:

```python
    # Report.Farm request pipeline (/api/farm/*) — farm AOI scans + derived
    # signals for the Report.Farm vertical. Reuses the scan/EO/indicator
    # pipeline + evidence proxy. ADDITIVE-ONLY (new /api/farm/* prefix),
    # import-guarded like every surface above so a missing dep never breaks boot.
    try:
        from alphageocore.api.routers import farm as _farm_router
        gateway_app.include_router(_farm_router.router)
        log.info("farm_surfaces_mounted", routes=len(_farm_router.router.routes))
    except Exception as e:  # noqa: BLE001
        log.warning("farm_surfaces_mount_failed", error=str(e))
```

Skeleton of `farm.py` (delegates to existing pipeline; no reimplementation of EO):

```python
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
# reuse the SAME internals harvest_routes/scan workers already call:
from alphageocore.pipeline import scan as scan_pipeline          # existing
from alphageocore.indicators import instances as indicator_svc   # existing (Indicator Matrix)

router = APIRouter(prefix="/api/farm", tags=["farm"])

@router.post("/scan")
async def start_farm_scan(req: Request):
    body = await req.json()
    bbox = body["bbox"]                       # [W,S,E,N] — always present
    signals = body.get("signals", ["ndvi"])
    job = scan_pipeline.enqueue(bbox=bbox, analyses=signals,   # existing enqueue
                                tenant=body.get("tenant_id"),
                                aoi=body.get("aoi"))
    return JSONResponse({"job_id": job.id}, status_code=202)

@router.get("/jobs/{job_id}/events")
async def farm_job_events(job_id: str):
    async def gen():
        async for tick in scan_pipeline.stream(job_id):    # existing per-step pub/sub
            yield f"event: tick\ndata: {tick.json()}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream")

@router.get("/signals-by-bbox")
async def signals_by_bbox(west: float, south: float, east: float, north: float,
                          signals: str = "ndvi", limit: int = 5000):
    fc = indicator_svc.query_bbox(bbox=[west, south, east, north],   # existing
                                  kinds=signals.split(","), limit=limit)
    return JSONResponse(fc)   # GeoJSON FeatureCollection; [] if no coverage
```

**Deploy (additive, box-ahead-of-repo — INSERT never overwrite):**
```
docker cp farm.py alphageo-api-gateway:/app/alphageocore/api/routers/farm.py
# add the import-guarded block to the running phase41_api_gateway.py the SAME way
docker commit alphageo-api-gateway alphageo-api-gateway:farm
docker compose up -d --force-recreate alphageo-api-gateway
# verify: log line "farm_surfaces_mounted routes=N"; GET /api/farm/signals-by-bbox 200
```

## 5. Report.Farm (Node) side — the farm relay (A2)

Clone the three RWR relay files (per `01_CLONE_PLAN.md` §6) and re-point:

### 5.1 `api/server.mjs` farm control-plane (from harvest control-plane)
- Env: `ALPHAGEO_FARM_BASE` (→ `{gateway}/api/farm`), `ALPHAGEO_HARVEST_TOKEN` (shared bearer), `ALPHAGEO_GATEWAY_ORIGIN` (for `signals-by-bbox`/evidence).
- Routes: `POST /api/farm/refresh` → relay to `{FARM_BASE}/scan`; `GET /api/farm/jobs/:jobId/events` → open `{FARM_BASE}/jobs/{remote}/events`, normalize ticks to `farm.progress/complete/error`. Keep the local job registry + reaper.
- Add `GET /api/farm/signals-by-bbox` server-to-server relay to `{GATEWAY_ORIGIN}/api/farm/signals-by-bbox` (the farm analogue of RWR's `/api/leaks/by-bbox` relay), reusing the gateway auth/egress helper.

### 5.2 `api/ingest-farm.mjs` (from `ingest-alphageo.mjs`)
- `ALPHAGEO_FARM_AUTO_INGEST=1` + interval. For each gateway-backed **farm** AOI: open a farm scan row, `fetchFarmSignals(farm)`, upsert into the farm observation table in a per-tenant tx with the tenant GUC bound. Idempotent by `(farm_id, external_id)`.

### 5.3 `api/v1/farm/ingest-core.mjs` (from `crm/ingest-core.mjs`)
- Keep `centroidOf`, `numOrNull`, the upsert shape, the tenant-GUC-in-tx contract.
- `fetchFarmSignals({aoi_west,…})` → internal `GET /api/farm/signals-by-bbox`.
- `upsertObservations(client, {tenantId, scanId, farmId, features})`: map each feature's `properties.measurement/value/unit/confidence/scene_id/acquired_at` into the `farm.observation` row (see `03_DATA_MODEL.md`). Replace `severityOf`/`verification_result` with measurement + confidence + zone-intent evaluation.

## 6. From signals to Alerts (A2 → A6 handoff)

The ingest core persists **Observations**; a downstream evaluator turns them into **DerivedSignals** (deltas vs baseline) and **Alerts** (zone-intent + threshold rules from the research doc). This is a farm-side, tenant-scoped job — it does **not** live in AlphaGeo core. Example: an NDVI drop >10% in a zone whose intent is `expectedWaterFlow:true` + a `standing_water` observation in a `standingWaterAllowed:false` barn zone → critical Alert (research doc §Alerting). Detail in `04_WORKSTREAMS.md` P3.

## 7. Farm AOI ↔ AlphaGeo scan mapping (summary)

```
Report.Farm                          AlphaGeo (additive gateway + existing pipeline)
───────────                          ─────────────────────────────────────────────
farm.parcel/zone (PostGIS geog)  ──► bbox+aoi in POST /api/farm/scan
   └ tenant_id (RLS)                    └ scan_pipeline.enqueue (Sentinel-2/SAR/indices)
POST /api/farm/refresh (relay)   ──► POST /api/farm/scan → {job_id}
SSE farm.progress/complete       ◄── SSE tick / _final (normalized)
GET /api/farm/signals-by-bbox    ──► GET /api/farm/signals-by-bbox → GeoJSON FC
   └ upsertObservations (tenant tx) ◄── real NDVI/water features (or [] empty-state)
farm.observation → derived → alert   evidence via /api/evidence/object, tiles via /api/imagery/*
```

## 8. Acceptance (the go/no-go for the whole thesis)

- [ ] `farm_surfaces_mounted` appears in the gateway log after deploy; `GET /api/farm/signals-by-bbox` returns 200 (FC or `[]`).
- [ ] The ported relay integration test (RWR's `.qa-harvest-relay-test.mjs`, renamed) passes against a mock farm gateway: `POST /api/farm/refresh` → 202 `{jobId, mode:'relay'}`; SSE yields `farm.progress` ticks and a `farm.complete` with summary.
- [ ] One real farm AOI round-trips: `POST /api/farm/refresh` → real Sentinel-2 scene → `farm.observation` row with a real `ndvi` value + `confidence` + `scene_id`, tenant-scoped, visible on the map. **No fabricated data.**
- [ ] AlphaGeo core `/api/*` frozen surface is byte-unchanged (diff the router list; only `farm_surfaces_mounted` is new).
