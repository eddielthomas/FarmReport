# RWR MVP â€” concept dashboard wired to real satellite harvest data

A minimum-viable wire-up of the **SpectraCore concept dashboard** (`concepts/SpectraCoreConceptDemo2`) onto the **real satellite harvest** captured during integration discovery. Every panel that previously rendered simulated military-recon data now shows actual numbers from sub-project **676251 / Demoville A / Data Release 2 (April 2026)**:

| Panel                    | Was (concept)                       | Now (this MVP)                                                                |
|--------------------------|-------------------------------------|-------------------------------------------------------------------------------|
| Mission brief            | "OPERATION OVERWATCH"               | `OPERATION RECOVER Â· DEMOVILLE A` â€” sub-project 676251, 75 POIs / 68.1 km     |
| Detection feed (left)    | 14 hardcoded global detections      | 2 verified leaks + **all 75** prioritised POIs (ERA â†’ Active â†’ Investigated â†’ Overlapping) |
| Risk counts (right)      | Static high/med/low                 | Live severity counts + satellite `header-counts` hero strip (active/repaired/suspected) |
| Findings                 | Fake corrosion text                 | Derived from `recover-overall.json` + leak detail rows                        |
| Asset context            | Sentinel-2B / ECOSTRESS             | Sub-project ID, Data Release name, POI count, leak count, pipe-km, WMS URL   |
| AI recommendations       | Fake oil-spill priorities           | Repair priority, coverage gap, ROI trajectory â€” from real KPIs                |
| System intelligence      | Fake AI confidence                  | Water/$ /kWh / COâ‚‚ / leaks-per-crew-day **plus** per-asset-class km totals (pipe / hydrant / valve / service / meter / customer-fitting) from `dashboard.metricsValues` |
| Event log                | Fake satellite passes               | Actual leak verification timestamps + DR2 publication                         |
| Perspectives (saved views) | Houston / Gulf / HK               | Real leak coordinates + Demoville A overview centroid                         |
| Timeline chart           | Random stacked bars                 | Derived from `charts.json` waterSaveData (12-month series)                    |
| Globe markers            | 14 static                           | 77 real WGS-84 points (2 leaks + 75 POI centroids) parented to the rotating earth mesh |
| Globe overlay            | none                                | **POI MultiPolygon outlines** rendered as line strips on the sphere (gated by the AOI Boundaries layer toggle) |
| Initial camera           | Greenwich, then auto-rotate         | Auto-flies to `dashboard.initialViewport.center` (the same camera the satellite EO source viewer opens with) |

## Layout

```
mvp/
â”œâ”€â”€ index.html                   # concept dashboard, DS swapped for live import
â”œâ”€â”€ vite.config.js               # dev server on :5175, preview on :5174
â”œâ”€â”€ package.json                 # vite + pg + minio
â”œâ”€â”€ src/
â”‚   â””â”€â”€ data/
â”‚       â”œâ”€â”€ detections.js           # entry adapter (bundled JSON or live API)
â”‚       â”œâ”€â”€ build-ds.js          # pure shaping logic (harvest -> DS object)
â”‚       â””â”€â”€ harvest/             # local copies of harvest JSON for vite import
â”œâ”€â”€ api/
â”‚   â””â”€â”€ server.mjs               # read-only Node http server in front of PostGIS
â”œâ”€â”€ scripts/
â”‚   â”œâ”€â”€ seed-postgis.mjs         # loads harvest into rwr.* tables
â”‚   â”œâ”€â”€ seed-minio.mjs           # uploads SharePoint binaries to s3://rwr-harvest/
â”‚   â”œâ”€â”€ api-parity-check.mjs     # asserts API responses == bundled JSON shapes
â”‚   â””â”€â”€ build-ds-parity-check.mjs # asserts bundled-fed DS == api-fed DS
â””â”€â”€ infra/
    â”œâ”€â”€ docker-compose.yml       # postgis + geoserver + minio + minio-init
    â”œâ”€â”€ init-db/
    â”‚   â”œâ”€â”€ 01-extensions.sql    # postgis, postgis_topology, postgis_raster, fuzzystrmatch, pgcrypto
    â”‚   â””â”€â”€ 02-rwr-schema.sql    # rwr.sub_projects, rwr.pois, rwr.field_results, view rwr.poi_with_leak
    â””â”€â”€ shared_data/             # bind-mount for shapefiles/GeoTIFFs surfaced inside GeoServer container
```

## Quick start

### 1. Frontend (just the dashboard, harvest data only)

```powershell
cd D:\Projects\RWR\mvp
npm install
npm run dev      # vite serves http://localhost:5175
```

The dashboard boots and populates from `src/data/detections.js`, which imports the harvest JSON copies under `src/data/harvest/`. **No backend is required for the UI.**

### 2. Local infra (PostGIS + GeoServer + MinIO)

Requires **Rancher Desktop** or **Docker Desktop** with `docker compose` available.

```powershell
cd D:\Projects\RWR\mvp
npm run infra:up           # bring up all three services + minio init
# wait ~60-90s for GeoServer first boot (it downloads extension JARs)
docker compose -f infra/docker-compose.yml ps
```

Endpoints:

| Service     | URL                                                | Credentials                              |
|-------------|----------------------------------------------------|------------------------------------------|
| PostGIS     | `postgresql://rwr:rwr@localhost:5432/rwr`           | user `rwr`, pass `rwr`, db `rwr` â€” local demo stack only; see note below |
| GeoServer   | http://localhost:8080/geoserver                    | `admin` / `geoserver` (default)          |
| MinIO API   | http://localhost:9000                              | `rwr-admin` / `rwr-admin-secret`         |
| MinIO UI    | http://localhost:9001                              | same                                     |

### 3. Seed real harvest into local services

```powershell
npm run seed              # loads PostGIS + uploads MinIO objects
# or individually:
npm run seed:postgis      # rwr.sub_projects, rwr.pois (75), rwr.field_results (2)
npm run seed:minio        # uploads sharepoint binaries to s3://rwr-harvest/sub-projects/676251/sharepoint/
```

After seed, you should see:

```
 sub_projects | pois | field_results | pois_joined_to_leaks
--------------+------+---------------+----------------------
            1 |   75 |             2 |                    2
```

### 4. Wire PostGIS into GeoServer (one-time, manual via web UI)

1. **Workspaces** â†’ Add new â†’ name `rwr`, namespace `http://rwr.local/satellite`, set as default.
2. **Stores** â†’ Add new â†’ **PostGIS**:
   - Workspace: `rwr`
   - Data Source Name: `rwr_postgis`
   - host: `postgis`  *(docker network DNS, **not** localhost)*
   - port: `5432`
   - database: `rwr`
   - schema: `rwr`
   - user: `rwr`
   - passwd: `rwr`
3. Save â†’ publish layers `pois` (multipolygons), `field_results` (points), `poi_with_leak` (view).
4. **Layer Preview** â†’ click `OpenLayers` next to any to verify rendering at lon `-95.7`, lat `30.0`.

### 5. Run the read-only API + verify parity with bundled JSON

After PostGIS is seeded, the lightweight `mvp/api` server serves the same JSON
shapes the dashboard currently `import`s from `src/data/harvest/`. This is the
hand-off point for swapping the bundled JSON for live `fetch()` calls.

```powershell
cd D:\Projects\RWR\mvp
npm run api:dev          # http://localhost:5180
# in another shell:
npm run api:parity       # GETs each endpoint, deep-equals against bundled JSON
```

Endpoints (all read-only):

| Path                                                | Bundled-JSON parity                       |
|-----------------------------------------------------|-------------------------------------------|
| `GET /healthz`                                      | liveness                                  |
| `GET /readyz`                                       | DB ping                                   |
| `GET /api/sub-projects`                             | catalog (no bundled equivalent)           |
| `GET /api/sub-projects/676251/overall`              | `harvest/recover-overall.json`            |
| `GET /api/sub-projects/676251/links`                | `harvest/links.json`                      |
| `GET /api/sub-projects/676251/pois`                 | `harvest/pois.json`                       |
| `GET /api/sub-projects/676251/field-results`        | `harvest/field-results.json`              |
| `GET /api/sub-projects/676251/geometry`             | `harvest/poi-geometry.geojson` (POI MultiPolygons) |
| `GET /api/sub-projects/676251/counts`               | `harvest/header-counts.json` (active / repaired / suspected) |
| `GET /api/sub-projects/676251/header-filters`       | `harvest/header-filters.json` (data releases)   |
| `GET /api/sub-projects/676251/metrics`              | `harvest/metrics-values.json` (per-asset-class km) |
| `GET /api/sub-projects/676251/dashboard`            | `harvest/dashboard.json[676251]` subtree (viewport / bounds / baseValues / benchmark / projectDetails) |

Env overrides: `PGHOST` `PGPORT` (default `5433`, matches compose mapping)
`PGUSER` `PGPASSWORD` `PGDATABASE` `PORT` `CORS_ORIGIN`.

> **Note on DB roles.** The local `mvp/infra/docker-compose.yml` stack
> bootstraps a self-contained PostGIS with the legacy `rwr/rwr`
> superuser creds and does **not** run the platform migrations. The
> production / platform-wide stack (rooted at
> `infra/docker/docker-compose.yml`) applies migration `0020_app_roles.sql`,
> which reserves the owner role `rwr` for the migration runner and
> introduces non-owner roles `rwr_app`, `rwr_outbox_relay`, `rwr_jobs`
> (and `rwr_martin` per migration `0021`). When pointing this MVP
> dashboard at the platform Postgres, set
> `PGUSER=rwr_app` / `PGPASSWORD=rwr-app-dev-secret`. See
> `docs/operations/db-roles.md`.

### 6. Stop / reset

```powershell
npm run infra:down        # stop containers, keep volumes
npm run infra:nuke        # also delete all volume data (forces re-seed on next up)
```

## Data sources

All data in `src/data/harvest/` was captured from the satellite data provider's two API surfaces during the integration spike. Origins:

| File                         | Origin                                                                      |
|------------------------------|-----------------------------------------------------------------------------|
| `manifest.json`              | Harvester run summary (root)                                                |
| `pois.json`                  | `GET /api/utilis-poi?projectId=676251&offset=0&limit=500` (Recover API)     |
| `field-results.json`         | EO-Discover dashboard `/api/field-results?subProject=676251`                |
| `recover-overall.json`       | EO-Discover dashboard `/api/recover-overall?subProject=676251`              |
| `charts.json`                | EO-Discover dashboard charts endpoint                                       |
| `dashboard.json`             | EO-Discover initial dashboard payload                                       |
| `links.json`                 | EO-Discover sub-project links payload                                       |
| `leaks/489654.json`          | Per-row leak detail â€” verified leak at 20310 Misty River Way, Cypress TX   |
| `leaks/489656.json`          | Per-row leak detail â€” verified leak at 20318 Lakeland Falls Dr, Cypress TX |
| `sharepoint-index.json`      | Manifest of GIS deliverable files harvested via puppeteer + SP REST API    |
| `poi-geometry.geojson`       | EO-Discover `mdcPilot` MultiPolygon geometry â€” joined to `pois.json` on `utilis_id`/`poiNumber`; drives the POI footprint overlay on the globe |
| `header-counts.json`         | EO-Discover `header-counts` â€” live `activeLeaks`/`repairedLeaks`/`suspectedLocations` |
| `header-filters.json`        | EO-Discover `header-filters` â€” `dataReleases` for time-scrubber UI         |
| `metrics-values.json`        | Root-level metrics-values surface (per-asset-class km totals)              |
| `home-project-index.json`    | Sub-project list (multi-tenant scaffolding)                                |
| `region.json`                | Tenant region code                                                         |
| `epochs.json`                | MVT tile epoch index                                                       |
| `dataset.json`               | Compact `{fieldResults, mdcPilot}` projection (full-payload backup)         |
| `filter-request.json`        | Filtered projection example for time-window queries                        |

See the satellite data dictionary under `docs/integrations/` (repo root) for full field documentation.

## Known limitations of this MVP

- **UI now opt-in to the live API; defaults still bundled** â€” set `VITE_DATA_SOURCE=api` (provider env key, unchanged) (and optionally `VITE_API_BASE`, `VITE_SUB_PROJECT_ID`) before `npm run dev` to drive the dashboard from PostGIS via `mvp/api`. On any fetch failure the adapter logs a warning and silently falls back to bundled JSON, so the demo never breaks. `npm run build-ds:parity` proves the extracted pure builder produces byte-identical DS objects from either source. GeoServer WMS tiles are still unwired.
- **Single sub-project only** â€” adapter is hard-pinned to 676251. Multi-tenant comes when we add a sub-project picker.
- **Globe is global** â€” concept dashboard renders a full Earth with markers; the data is pinned to Cypress, TX. We keep the global view for the "command-center feel" but auto-fly to the leak centroid on first load.
- **Weather panel** â€” concept's weather module has no real-time source in the harvest. Values are static climatology placeholders for Cypress, TX (24Â°C / 8 kts / 35% cloud / 72% RH / 1015 mb / 16 km).
- **Timeline chart** â€” concept expects 4 stacked series Ã— 12 buckets. We project the single waterSaveData series across 12 months; non-zero only April-May 2026.

## Authorisation

This integration runs against the satellite data provider's **`Demoville1` demo tenant** (their published demonstration sub-project), under explicit authorisation from the project owner. Credentials live in the provider's API-tester tool `.env` and are **not** redistributed in this MVP. The MVP itself does not call the provider â€” it reads the already-captured harvest snapshot.
