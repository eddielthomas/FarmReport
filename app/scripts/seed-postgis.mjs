#!/usr/bin/env node
// =============================================================================
// Seed PostGIS with the satellite harvest data for sub-project 676251 (Demoville A).
// Idempotent: uses ON CONFLICT DO UPDATE so re-running refreshes rows.
// -----------------------------------------------------------------------------
// Usage:
//   npm run seed:postgis
// Env (defaults shown):
//   PGHOST=localhost PGPORT=5432 PGUSER=rwr PGPASSWORD=rwr PGDATABASE=rwr
// =============================================================================

import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const HARVEST_LIVE = join(ROOT, '..', 'harvest');                // canonical harvest tree
const HARVEST_LOCAL = join(ROOT, 'src', 'data', 'harvest');      // copies inside mvp

const SUB_PROJECT_ID   = 676251;
const SUB_PROJECT_NAME = 'Demoville A';

const cfg = {
  host:     process.env.PGHOST     ?? 'localhost',
  port:     Number(process.env.PGPORT ?? 5432),
  user:     process.env.PGUSER     ?? 'rwr',
  password: process.env.PGPASSWORD ?? 'rwr',
  database: process.env.PGDATABASE ?? 'rwr',
};

async function loadJson(...candidates) {
  for (const p of candidates) {
    try {
      const txt = await readFile(p, 'utf8');
      return JSON.parse(txt);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  throw new Error(`None of these JSON files were readable: ${candidates.join(', ')}`);
}

const pickPath = (rel) => [
  join(HARVEST_LIVE, rel),
  join(HARVEST_LOCAL, rel.replace(/^eo-discover\/sub-projects\/676251\//, '').replace(/^recover-api\//, '')),
];

async function main() {
  const overall = (await loadJson(...pickPath('eo-discover/sub-projects/676251/recover-overall.json')))[0];
  const links   = await loadJson(...pickPath('eo-discover/sub-projects/676251/links.json'));
  const pois    = await loadJson(...pickPath('recover-api/pois.json'));
  const fres    = await loadJson(...pickPath('eo-discover/sub-projects/676251/field-results.json'));
  const manifest = await loadJson(join(HARVEST_LIVE, 'manifest.json'), join(HARVEST_LOCAL, 'manifest.json'));

  console.log(`harvest: ${pois.length} POIs, ${fres.length} field-results, captured ${manifest.finishedAt}`);

  const client = new pg.Client(cfg);
  await client.connect();
  console.log(`connected: postgres://${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

  try {
    await client.query('BEGIN');

    // -------- sub_projects --------
    await client.query(
      `INSERT INTO rwr.sub_projects (
         sub_project_id, name, status, captured_at,
         poi_count, leak_count, pipe_km_total, pipe_km_investigated,
         water_save_l, water_cost_save_usd, energy_save_kwh, co2_reduction_kg,
         web_application_url, wms_url, gis_files_url, raw_overall
       ) VALUES ($1,$2,'ACTIVE',$3, $4,$5,$6,$7, $8,$9,$10,$11, $12,$13,$14,$15)
       ON CONFLICT (sub_project_id) DO UPDATE SET
         name = EXCLUDED.name,
         captured_at = EXCLUDED.captured_at,
         poi_count = EXCLUDED.poi_count,
         leak_count = EXCLUDED.leak_count,
         pipe_km_total = EXCLUDED.pipe_km_total,
         pipe_km_investigated = EXCLUDED.pipe_km_investigated,
         water_save_l = EXCLUDED.water_save_l,
         water_cost_save_usd = EXCLUDED.water_cost_save_usd,
         energy_save_kwh = EXCLUDED.energy_save_kwh,
         co2_reduction_kg = EXCLUDED.co2_reduction_kg,
         web_application_url = EXCLUDED.web_application_url,
         wms_url = EXCLUDED.wms_url,
         gis_files_url = EXCLUDED.gis_files_url,
         raw_overall = EXCLUDED.raw_overall`,
      [
        SUB_PROJECT_ID, SUB_PROJECT_NAME, manifest.finishedAt,
        overall.total_poi_with_wo, overall.total_leaks_with_wo,
        overall.total_pipe_km_without_wo, overall.pipe_km_investigated_with_wo,
        overall.water_save_with_wo, overall.water_cost_savings_with_wo,
        overall.energy_saved_with_wo, overall.greenhouse_gas_reduction_with_wo,
        links.web_application, links.wms, links.gis_files,
        JSON.stringify(overall),
      ],
    );
    console.log(`  ✓ sub_projects (${SUB_PROJECT_ID})`);

    // -------- pois --------
    let poiOk = 0;
    for (const p of pois) {
      const geomGeoJson = p.geometry ? JSON.stringify(p.geometry) : null;
      await client.query(
        `INSERT INTO rwr.pois (
           id, sub_project_id, poi_number, investigation_result, leak_type, address,
           verified, investigation_date, pipe_length_m,
           centroid_lon, centroid_lat, data_release_date,
           recover_insights_level, delivery_name, dma_name,
           geom, raw
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                   CASE WHEN $16::text IS NULL THEN NULL ELSE ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($16), 4326)) END,
                   $17)
         ON CONFLICT (id) DO UPDATE SET
           investigation_result = EXCLUDED.investigation_result,
           leak_type = EXCLUDED.leak_type,
           verified = EXCLUDED.verified,
           investigation_date = EXCLUDED.investigation_date,
           recover_insights_level = EXCLUDED.recover_insights_level,
           geom = EXCLUDED.geom,
           raw = EXCLUDED.raw`,
        [
          p.id, p.projectId, p.poiNumber, p.investigationResult, p.leakType, p.address,
          p.verified, p.investigationDate, p.pipeLength,
          p.xCentroidWGS84, p.yCentroidWGS84, p.dataReleaseDate,
          p.recoverInsightsLevel, p.deliveryName, p.dmaName,
          geomGeoJson,
          JSON.stringify(p),
        ],
      );
      poiOk += 1;
    }
    console.log(`  ✓ pois            (${poiOk}/${pois.length})`);

    // -------- field_results --------
    let frOk = 0;
    for (const f of fres) {
      const geomWkt = (Number.isFinite(f.actual_x) && Number.isFinite(f.actual_y))
        ? `SRID=4326;POINT(${f.actual_x} ${f.actual_y})` : null;
      // timestamp_date is DD-MM-YYYY in the harvest; convert
      const tsDate = f.timestamp_date
        ? f.timestamp_date.split('-').reverse().join('-')   // DD-MM-YYYY -> YYYY-MM-DD
        : null;
      await client.query(
        `INSERT INTO rwr.field_results (
           ogc_fid, sub_project_id, utilis_finding, verification_result, leak_type, visible, address,
           timestamp_corrected, timestamp_date, repaired, repaired_timestamp, leak_size, customer_leak_unit,
           main_sub_type, service_sub_type, cust_sub_type, pipe_type, comments, crew_owner_id,
           actual_lon, actual_lat, geom, raw
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
                   CASE WHEN $22::text IS NULL THEN NULL ELSE ST_GeomFromEWKT($22) END,
                   $23)
         ON CONFLICT (ogc_fid) DO UPDATE SET
           verification_result = EXCLUDED.verification_result,
           leak_type = EXCLUDED.leak_type,
           visible = EXCLUDED.visible,
           comments = EXCLUDED.comments,
           geom = EXCLUDED.geom,
           raw = EXCLUDED.raw`,
        [
          f.ogc_fid, Number(f.sub_project) || SUB_PROJECT_ID, f.utilis_finding,
          f.verification_result, f.leak_type, f.visible, f.address,
          f.timestamp_corrected, tsDate, f.repaired, f.repaired_timestamp,
          f.leak_size, f.customer_leak_unit,
          f.main_sub_type, f.service_sub_type, f.cust_sub_type, f.pipe_type, f.comments, f.__owner,
          f.actual_x, f.actual_y, geomWkt,
          JSON.stringify(f),
        ],
      );
      frOk += 1;
    }
    console.log(`  ✓ field_results   (${frOk}/${fres.length})`);

    await client.query('COMMIT');
    console.log('\nseed complete.');

    // sanity check
    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM rwr.sub_projects) AS sub_projects,
        (SELECT COUNT(*) FROM rwr.pois)         AS pois,
        (SELECT COUNT(*) FROM rwr.field_results) AS field_results,
        (SELECT COUNT(*) FROM rwr.poi_with_leak WHERE ogc_fid IS NOT NULL) AS pois_joined_to_leaks
    `);
    console.table(counts.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('seed failed:', err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
