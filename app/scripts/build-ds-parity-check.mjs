#!/usr/bin/env node
// =============================================================================
// build-ds parity check — proves that the extracted pure DS-builder produces
// the same DS object whether driven by bundled JSON or by API-shaped JSON.
// -----------------------------------------------------------------------------
// Since `mvp/scripts/api-parity-check.mjs` already proves API responses are
// byte-equivalent to bundled JSON, feeding both into `buildDS()` and checking
// equality covers the second leg: same inputs → same DS, no behavior change.
//
// Usage:
//   node mvp/scripts/build-ds-parity-check.mjs
// =============================================================================

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const HARVEST = join(ROOT, 'src', 'data', 'harvest');

const loadJson = async (name) => JSON.parse(await readFile(join(HARVEST, name), 'utf8'));

async function main() {
  const { buildDS } = await import(pathToFileURL(join(ROOT, 'src', 'data', 'build-ds.js')).href);

  const [
    pois, fieldResults, overall, links, charts, dashboard, l1, l2, sp, manifest,
    poiGeometry, headerCounts, headerFilters, metricsValues, homeProjectIndex, region,
  ] = await Promise.all([
    loadJson('pois.json'),
    loadJson('field-results.json'),
    loadJson('recover-overall.json'),
    loadJson('links.json'),
    loadJson('charts.json'),
    loadJson('dashboard.json'),
    loadJson('leaks/489654.json'),
    loadJson('leaks/489656.json'),
    loadJson('sharepoint-index.json'),
    loadJson('manifest.json'),
    loadJson('poi-geometry.geojson'),
    loadJson('header-counts.json'),
    loadJson('header-filters.json'),
    loadJson('metrics-values.json'),
    loadJson('home-project-index.json'),
    loadJson('region.json'),
  ]);

  const extras = {
    poiGeometry, headerCounts, headerFilters, metricsValues, homeProjectIndex, region,
  };

  // Identical inputs, two builds, two source-tags
  const bundled = buildDS({
    pois, fieldResults, recoverOverall: overall, links,
    charts, dashboard, leakDetails: [l1, l2], manifest, spIndex: sp,
    source: 'bundled',
    ...extras,
  });
  const fromApi = buildDS({
    pois, fieldResults, recoverOverall: overall, links,
    charts, dashboard, leakDetails: [l1, l2], manifest, spIndex: sp,
    source: 'api',
    ...extras,
  });

  // Compare everything except the fields that intentionally encode `source`
  //   * _meta.source / _meta.dataSource (top-level provenance)
  //   * assets[0]                       ("Data Source" row — bundled vs live tag)
  const strip = (ds) => {
    const out = { ...ds, _meta: { ...ds._meta }, assets: ds.assets.slice(1) };
    delete out._meta.source;
    delete out._meta.dataSource;
    return out;
  };
  const a = JSON.stringify(strip(bundled));
  const b = JSON.stringify(strip(fromApi));

  if (a !== b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    console.error(`✗ DS objects differ at byte ${i}`);
    console.error(`  bundled …${a.slice(Math.max(0, i - 60), i + 60)}…`);
    console.error(`  api     …${b.slice(Math.max(0, i - 60), i + 60)}…`);
    process.exit(1);
  }

  // Sanity: must include the source tag we set
  if (bundled._meta.dataSource !== 'bundled' || fromApi._meta.dataSource !== 'api') {
    console.error('✗ _meta.dataSource not propagated correctly');
    process.exit(1);
  }

  // Spot-check shape invariants
  const expects = {
    'mission.id':     bundled.mission?.id === 'RWR-676251',
    'detections>0':   Array.isArray(bundled.detections) && bundled.detections.length > 0,
    'leakHigh':       bundled.detections.some((d) => d.severity === 'high'),
    'sysIntel.length>=7': Array.isArray(bundled.sysIntel) && bundled.sysIntel.length >= 7,
    'detections=allPois+leaks': bundled.detections.length === bundled._allPois.length + bundled._allLeaks.length,
    'assetsCoverProvenance': bundled.assets.some((a) => a.label === 'Data Source')
                              && bundled.assets.some((a) => a.label === 'WMS')
                              && bundled.assets.some((a) => a.label === 'Deliverables'),
    'timeline.4rows': Array.isArray(bundled.timelineData) && bundled.timelineData.length === 4,
    'viewport.center': Number.isFinite(bundled._viewport?.lat) && Number.isFinite(bundled._viewport?.lon),
    'viewport.bounds': bundled._viewport?.bounds && Number.isFinite(bundled._viewport.bounds.minX),
    'heroCounts.shape': bundled._heroCounts && ['active','repaired','suspected'].every((k) => k in bundled._heroCounts),
    'assetMetrics.unit': bundled._assetMetrics?.unit === 'km',
    'poiGeom.attached': bundled.detections.filter((d) => d.id?.startsWith('POI-')).some((d) => d.geom?.type === 'MultiPolygon'),
    'meta.region': bundled._meta.region != null,
  };
  const failed = Object.entries(expects).filter(([, ok]) => !ok).map(([k]) => k);
  if (failed.length > 0) {
    console.error('✗ shape invariants failed:', failed);
    process.exit(1);
  }

  console.log('✓ build-ds parity: bundled === api (modulo _meta.source)');
  console.log(`  detections=${bundled.detections.length}  pois=${bundled._allPois.length}  leaks=${bundled._allLeaks.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
