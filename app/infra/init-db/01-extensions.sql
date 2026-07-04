-- Run once on first container start (when postgis_data volume is empty).
-- To re-run: `docker compose down -v` (DESTROYS DB).

\echo '==> Enabling PostGIS extensions'
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS postgis_raster;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
