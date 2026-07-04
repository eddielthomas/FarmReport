// =============================================================================
// build-ds.js — pure satellite-data-to-DS shaping logic.
// -----------------------------------------------------------------------------
// Extracted from detections.js so both the bundled-JSON path and the live-API
// path produce byte-identical DS objects from byte-identical inputs. The
// shaping rules are unchanged from the original sync adapter:
//   * Field results (verified leaks)      -> high-severity detections
//   * POIs (areas of interest)            -> medium/low monitoring detections
//   * recover-overall.json                -> mission, sysIntel, KPIs
//   * charts.json (waterSaveData)         -> timelineData
//   * links.json                          -> assets / external links
//   * leak detail json (per ogc_fid)      -> evidence + findings
//   * sharepoint-index.json               -> deliverable assets list
// =============================================================================

const SUB_PROJECT      = '676251';
const SUB_PROJECT_NAME = 'Demoville A';

// ----------- helpers --------------------------------------------------------
const fmtNum   = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: d });
const fmtL     = (n) => `${fmtNum(n, 0)} L`;
const fmtUSD   = (n) => `$${fmtNum(n, 2)}`;
const fmtKWh   = (n) => `${fmtNum(n, 0)} kWh`;
const fmtKgCO2 = (n) => `${fmtNum(n, 0)} kg CO₂`;
const trimKey  = (s) => (typeof s === 'string' ? s.trim() : s);

const fmtTime = (iso) => {
  if (!iso) return '2026-04-30 00:00Z';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
};

const insightToSev = (lvl) => {
  if (!lvl) return 'low';
  const k = String(lvl).toLowerCase();
  if (k.includes('era'))           return 'high';
  if (k.includes('active'))        return 'medium';
  if (k.includes('investigated'))  return 'medium';
  if (k.includes('overlapping'))   return 'low';
  return 'low';
};
const insightToType = (lvl) => {
  const k = String(lvl ?? '').toLowerCase();
  if (k.includes('era'))          return 'POI · ERA';
  if (k.includes('active'))       return 'POI · ACTIVE';
  if (k.includes('investigated')) return 'POI · INVESTIGATED';
  if (k.includes('overlapping'))  return 'POI · OVERLAPPING';
  return 'POI';
};
const insightToScore = (lvl) => {
  const k = String(lvl ?? '').toLowerCase();
  if (k.includes('era'))          return 78;
  if (k.includes('active'))       return 64;
  if (k.includes('investigated')) return 58;
  if (k.includes('overlapping'))  return 42;
  return 35;
};

const bucketBy = (arr, key) => arr.reduce((acc, x) => {
  const k = String(x[key] ?? 'Unknown').toLowerCase();
  (acc[k] ||= []).push(x);
  return acc;
}, {});

/**
 * Build the DS object the SpectraCore concept dashboard renders.
 * @param {{
 *   pois:            any[],
 *   fieldResults:    any[],
 *   recoverOverall:  any[],
 *   links:           { web_application?: string, wms?: string, gis_files?: string },
 *   charts:          any,
 *   dashboard:       any,
 *   leakDetails:     any[],
 *   manifest:        { finishedAt?: string },
 *   spIndex:         any,
 *   source?:         'bundled' | 'api',
 *   poiGeometry?:    { type: 'FeatureCollection', features: any[] },
 *   headerCounts?:   { activeLeaks?: string|number, repairedLeaks?: string|number, suspectedLocations?: string|number },
 *   headerFilters?:  { dataReleases?: any[] },
 *   metricsValues?:  any[]|object,
 *   homeProjectIndex?: any,
 *   region?:         string,
 *   pipes?:          { type: 'FeatureCollection', features: any[] },
 *   poiAttrs?:       Record<string, { utilisId:string, insideX:number, insideY:number, eraScore:number, pipeLength:number, address:string }>,
 * }} input
 */
export function buildDS(input) {
  const {
    pois: poisRaw,
    fieldResults: fieldResultsRaw,
    recoverOverall,
    links,
    charts,
    dashboard,
    leakDetails,
    manifest,
    spIndex,
    source = 'bundled',
    poiGeometry,
    headerCounts,
    headerFilters,
    metricsValues,
    homeProjectIndex,
    region,
    pipes,
    poiAttrs,
  } = input;

  const overall = recoverOverall[0];

  // Index poi-geometry by utilis_id (string) so we can attach MultiPolygon
  // geometry to POI detections. mdc-pilot.geojson uses snake_case + utilis_id;
  // pois.json uses camelCase + poiNumber. The link field is `utilis_id`
  // (string) which on the POI row maps to `poiNumber` (number).
  // Property key on poi-geometry.geojson varies by source: shapefile_adapter
  // emits `Utilis_ID` (UpperCamel), older bundled fixtures used `utilis_id`
  // (snake_case). Accept either so the AOI / DMA layers render against any
  // valid harvest output.
  const geomByUtilisId = {};
  for (const f of (poiGeometry?.features ?? [])) {
    const props = f?.properties ?? {};
    const raw = props.Utilis_ID ?? props.utilis_id ?? props.UTILIS_ID
             ?? props.poiNumber ?? props.id ?? '';
    const k = String(raw).trim();
    if (k) geomByUtilisId[k] = f.geometry;
  }

  // Index leak detail JSON by trimmed utilis_finding key
  const leakDetailByFinding = {};
  for (const ld of leakDetails ?? []) {
    if (ld?.row?.utilis_finding) {
      leakDetailByFinding[trimKey(ld.row.utilis_finding)] = ld;
    }
  }

  // ===== MISSION =====
  const mission = {
    id:        `RWR-${SUB_PROJECT}`,
    name:      'OPERATION RECOVER · DEMOVILLE A',
    sub:       'Water-loss reconnaissance · Cypress, TX · Data Release 2',
    status:    'ACTIVE',
    priority:  'PRIORITY-1',
    commander: `LIC. ${(overall.leaks_per_poi_per_license?.[0]?.id) ?? '—'}`,
    start:     '2026-04-30 00:00Z',
    coverage:  `${SUB_PROJECT_NAME} — ${overall.total_poi_with_wo} POIs / ${overall.total_pipe_km_without_wo} km`,
    quality:   Number((100 - overall.poiTypes?.[1]?.percent ?? 97).toFixed?.(1) ?? 100),
    objective: `Detect non-surfacing leaks across ${overall.total_poi_with_wo} polygons of interest covering ${overall.total_pipe_km_without_wo} km of pipeline. SAR + multispectral fusion locates suspected losses; field crews verify and report.`,
  };

  // ===== LAYERS =====
  // Core satellite layers (live data) + premium layer scaffolds (Task #91).
  // Source columns:
  //   live   = backed by harvested DS data, renders today
  //   stub   = registered + toggle-wired, awaiting backend (Martin/TiTiler/Neo4j)
  const layers = [
    // --- core (live) ---
    { id: 'sat',       name: 'Satellite Imagery',    color: '#4d9fff', on: false, source: 'live' },
    { id: 'leaks',     name: 'Verified Leaks',       color: '#ff4060', on: true,  source: 'live' },
    { id: 'pois',      name: 'Points of Interest',   color: '#ffb020', on: true,  source: 'live' },
    { id: 'aoi',       name: 'AOI Boundaries',       color: '#00d4ff', on: true,  source: 'live' },
    { id: 'heatmap',   name: 'Risk Heatmap',         color: '#f472b6', on: false, source: 'live' },
    { id: 'pipes',     name: 'Pipe Network',         color: '#00e68a', on: false, source: pipes?.features?.length ? 'live' : 'stub' },
    { id: 'dma',       name: 'DMA Boundaries',       color: '#a855f7', on: false, source: 'stub' },
    { id: 'grid',      name: 'Coordinate Grid',      color: '#4a6080', on: false, source: 'live' },
    // --- premium scaffolds (will hydrate when backend lands) ---
    { id: 'parcels',   name: 'Parcels (MVT/Martin)', color: '#94a3b8', on: false, source: 'stub' },
    { id: 'buildings', name: 'Buildings (3D extrude)', color: '#cbd5e1', on: false, source: 'stub' },
    { id: 'roof',      name: 'Roof Opportunity',     color: '#facc15', on: false, source: 'stub' },
    { id: 'storm',     name: 'Storm / Flood / Risk', color: '#06b6d4', on: false, source: 'stub' },
    { id: 'graph',     name: 'Graph Correlation (Neo4j)', color: '#a78bfa', on: false, source: 'stub' },
    { id: 'cog',       name: 'COG Imagery (TiTiler)', color: '#f97316', on: false, source: 'stub' },
    // --- street-level imagery (Mapillary, optional) ---
    // Off by default; the engine no-ops if no Mapillary client token is
    // configured (VITE_MAPILLARY_KEY at build time, or window.__RWR_CONFIG__
    // .mapillaryKey at runtime). When enabled the layer fetches camera
    // capture points within the current viewport via the Mapillary Graph API
    // and renders them as a coverage scatter; clicking a point opens the
    // panorama in an embedded slide-panel viewer.
    { id: 'mapillary', name: 'Street View (Mapillary)', color: '#22d3ee', on: false, source: 'live' },
  ];

  // ===== DETECTIONS =====
  const leakDetections = fieldResultsRaw.map((fr) => {
    const finding = trimKey(fr.utilis_finding);
    const detail  = leakDetailByFinding[finding];
    const cls     = fr.verification_result || 'Suspected';
    const sub     = fr.main_sub_type || fr.service_sub_type || fr.cust_sub_type || '—';
    const pipeMat = fr.pipe_type || '—';
    const score   = cls === 'Leak' ? 96 : 72;
    const conf    = cls === 'Leak' ? 99 : 84;
    return {
      id:         `LEAK-${fr.ogc_fid}`,
      name:       `${cls} · ${fr.leak_type} · ${sub}`,
      type:       'WATER-LOSS',
      severity:   'high',
      score,
      confidence: conf,
      lat:        fr.actual_y,
      lon:        fr.actual_x,
      location:   fr.address || `${SUB_PROJECT_NAME}`,
      time:       fmtTime(fr.timestamp_corrected),
      evidence: {
        spectral: `${pipeMat}`,
        thermal:  fr.visible === 'Yes' ? 'Surface · visible' : 'Sub-surface · non-visible',
        ndvi:     `Crew ${fr.__owner ?? '—'}`,
        sar:      `OGC ${fr.ogc_fid}`,
      },
      status:    cls === 'Leak' ? 'CONFIRMED' : 'INVESTIGATING',
      _comments: fr.comments,
      _finding:  finding,
      _detail:   detail,
    };
  });

  // ALL 75 POIs become detections, ordered by insight severity (era -> active ->
  // investigated -> overlapping -> other) so the most actionable items lead the
  // feed. The globe and detection feed paginate naturally.
  const poiBuckets = bucketBy(poisRaw, 'recoverInsightsLevel');
  const poiOrder = ['era', 'active segment', 'investigated segment', 'investigated', 'overlapping'];
  const poiSorted = [
    ...poiOrder.flatMap((k) => poiBuckets[k] ?? []),
    ...Object.entries(poiBuckets)
      .filter(([k]) => !poiOrder.includes(k))
      .flatMap(([, v]) => v),
  ];
  // KMZ-derived per-POI attribute table, keyed by Utilis_ID (string). Provides
  // INSIDE_X/Y inspection point, ERA_SCORE risk band, PIPE_LENGT and street
  // Address — none of which are exposed by the recover API JSON.
  const attrsById = poiAttrs ?? {};

  const poiDetections = poiSorted.map((p) => {
    const attr = attrsById[String(p.poiNumber)] ?? null;
    const insideXY = attr && Number.isFinite(attr.insideX) && Number.isFinite(attr.insideY)
      ? { lon: attr.insideX, lat: attr.insideY }
      : null;
    return {
      id:         `POI-${p.poiNumber}`,
      name:       `${insightToType(p.recoverInsightsLevel)} · ${p.poiNumber}`,
      type:       insightToType(p.recoverInsightsLevel),
      severity:   insightToSev(p.recoverInsightsLevel),
      score:      insightToScore(p.recoverInsightsLevel),
      confidence: 85,
      lat:        p.yCentroidWGS84,
      lon:        p.xCentroidWGS84,
      location:   (attr?.address || p.address || `${SUB_PROJECT_NAME}`),
      time:       fmtTime(p.dataReleaseDate),
      evidence: {
        spectral: p.recoverInsightsLevel || 'Standard',
        thermal:  `Pipe ${fmtNum(attr?.pipeLength ?? p.pipeLength, 0)} m`,
        ndvi:     p.dmaName || '—',
        sar:      p.deliveryName || '—',
      },
      status:    p.investigationResult ? 'INVESTIGATED' : 'MONITORING',
      // MultiPolygon GeoJSON geometry from mdc-pilot.geojson, joined on
      // utilis_id (string). Used by the globe overlay to draw POI footprints.
      geom:      geomByUtilisId[String(p.poiNumber)] ?? null,
      // KMZ-enrichment fields (joined on Utilis_ID). Null when poi-attrs.json
      // wasn't provided.
      eraScore:   attr?.eraScore ?? null,
      pipeLength: attr?.pipeLength ?? p.pipeLength ?? null,
      address:    attr?.address ?? p.address ?? null,
      insideXY,
    };
  });

  const detections = [...leakDetections, ...poiDetections];

  // ===== WEATHER (static climatology placeholders) =====
  const weather = {
    temp:       { val: '24°C',    icon: 'ðŸŒ¡ï¸' },
    wind:       { val: '8 kts',   icon: 'ðŸ’¨' },
    cloud:      { val: '35%',     icon: 'â˜ï¸' },
    humidity:   { val: '72%',     icon: 'ðŸ’§' },
    pressure:   { val: '1015mb',  icon: 'ðŸ“Š' },
    visibility: { val: '16 km',   icon: 'ðŸ‘ï¸' },
  };

  // ===== FINDINGS =====
  // Pull leak-type breakdowns from charts.leakTypeGraphData (preferred shape)
  // with fallback to overall.leak_type_total_with_wo.
  const leakTypeAll = charts.chartsData?.leakTypeGraphData?.graphData?.All
    ?? Object.entries(overall.leak_type_total_with_wo ?? {}).map(([name, value]) => ({ name, value }));
  const leakTypeMain = charts.chartsData?.leakTypeGraphData?.graphData?.Main ?? [];
  const leakTypeNonZero = (arr) => arr.filter((x) => Number(x.value) > 0);
  const leakTypeSummary = leakTypeNonZero(leakTypeAll)
    .map((x) => `${x.name}: ${x.value}`).join(' · ') || 'none';
  const leakSubtypeSummary = leakTypeNonZero(leakTypeMain)
    .map((x) => `${x.name}: ${x.value}`).join(' · ') || 'none';

  // Per-license performance (charts.performanceByLicenseGraph) → human row
  const perLicense = charts.chartsData?.performanceByLicenseGraph?.graphData ?? [];
  const licenseSummary = perLicense
    .map((l) => `${l.name}: ${l.investigatedKm} km · ${l.investigatedLeaks} leaks · ${l.leaksFoundPerKm} leaks/km`)
    .join(' | ') || '—';

  const findings = [
    {
      text: `${overall.total_leaks_with_wo} confirmed leaks across ${overall.poi_investigated_with_wo} investigated POIs (${overall.total_poi_with_wo} total) — ${fmtL(overall.water_save_with_wo)} projected annual save`,
      color: 'var(--red)',
    },
    {
      text: `${fmtUSD(overall.water_cost_savings_with_wo)} water cost savings · ${fmtKWh(overall.energy_saved_with_wo)} energy avoided · ${fmtKgCO2(overall.greenhouse_gas_reduction_with_wo)} CO₂ reduction`,
      color: 'var(--amber)',
    },
    {
      text: `Leak type breakdown — ${leakTypeSummary}  (Main subtypes: ${leakSubtypeSummary})`,
      color: 'var(--purple)',
    },
    {
      text: `Surface visibility — ${overall.surface ?? 0} surface · ${overall.not_surface ?? 0} sub-surface (non-visible to crews without SAR)`,
      color: 'var(--blue)',
    },
    {
      text: `Per-license performance — ${licenseSummary}`,
      color: 'var(--cyan)',
    },
    ...leakDetections.map((d) => ({
      text: `${d.id} ${d.name} @ ${d.location.split(',')[0]} — ${d._comments ?? 'no operator notes'}`,
      color: 'var(--red)',
    })),
    {
      text: `${overall.poiTypes?.[1]?.percent ?? 97}% non-surfacing — sub-surface anomalies require SAR + multispectral fusion to detect`,
      color: 'var(--blue)',
    },
    {
      text: `Pipe-km investigated ${overall.pipe_km_investigated_with_wo} of ${overall.total_pipe_km_without_wo} (${((overall.pipe_km_investigated_with_wo / overall.total_pipe_km_without_wo) * 100).toFixed(1)}% coverage)`,
      color: 'var(--green)',
    },
  ];

  // ===== ACTIONS =====
  const actions = [
    { name: 'Dispatch Leak Crew',     icon: 'dispatch', key: 'F1', emoji: 'ðŸ› ï¸' },
    { name: 'Open Leak Sheet',        icon: 'review',   key: 'F2', emoji: 'ðŸ“‹' },
    { name: 'Open in GIS Cloud',      icon: 'review',   key: 'F3', emoji: 'ðŸ—ºï¸' },
    { name: 'Generate DR Report',     icon: 'report',   key: 'F4', emoji: 'ðŸ“„' },
  ];

  // ===== ASSETS =====
  // dashboard.json licenseNames + projectDetails enrich the asset card
  const dashSub      = dashboard?.[SUB_PROJECT] ?? {};
  const projectName  = dashSub.projectDetails?.project_name ?? SUB_PROJECT_NAME;
  const licenseNames = (dashSub.licenseNames ?? []).map((l) => l?.name ?? l?.id).filter(Boolean).join(', ');
  const deliverables = spIndex?.files ?? [];
  const captured     = manifest?.finishedAt ?? '—';
  const safeUrl      = (u) => (u && typeof u === 'string' ? u.replace(/^https?:\/\//, '') : '—');

  const assets = [
    { label: 'Data Source',     value: `satellite harvest (${source === 'api' ? 'live API → PostGIS' : 'bundled JSON'})`, status: source === 'api' ? 'LIVE' : 'BUNDLED' },
    { label: 'Captured',        value: captured,                                  status: null },
    { label: 'Sub-Project',     value: `${SUB_PROJECT} (${projectName})`,         status: 'ACTIVE' },
    { label: 'Data Release',    value: (poisRaw[0])?.deliveryName ?? 'DR2',       status: 'PUBLISHED' },
    { label: 'License(s)',      value: licenseNames || `Demoville1 · ${overall.leaks_per_poi_per_license?.[0]?.id ?? '—'}`, status: null },
    { label: 'POIs',            value: `${overall.total_poi_with_wo}`,            status: null },
    { label: 'Verified Leaks',  value: `${overall.total_leaks_with_wo}`,          status: 'CONFIRMED' },
    { label: 'Pipe-km',         value: `${overall.total_pipe_km_without_wo} km`,  status: null },
    { label: 'WMS',             value: safeUrl(links?.wms),                       status: 'ACTIVE' },
    { label: 'Web Map',         value: safeUrl(links?.web_application),           status: 'ACTIVE' },
    { label: 'GIS Files',       value: links?.gis_files ? 'SharePoint share' : '—', status: links?.gis_files ? 'AVAILABLE' : null },
    { label: 'Leak Sheets',     value: links?.leaksheets_dataform || '— (vendor 524)', status: links?.leaksheets_dataform ? 'AVAILABLE' : null },
    { label: 'Deliverables',    value: `${deliverables.length} files (${fmtNum(deliverables.reduce((s, f) => s + (f?.bytes ?? 0), 0))} B)`, status: deliverables.length > 0 ? 'STAGED' : null },
  ];

  // ===== AI RECS =====
  const repaired = leakDetections.filter((d) => d._detail?.row?.repaired).length;
  const aiRecs = [
    {
      title: 'Repair Priority',
      text:  `${overall.total_leaks_with_wo - repaired} of ${overall.total_leaks_with_wo} verified leaks remain unrepaired. Estimated daily loss: ${fmtL(overall.water_save_with_wo / 365)}/day if left active.`,
    },
    {
      title: 'Coverage Gap',
      text:  `${overall.total_pipe_km_without_wo - overall.pipe_km_investigated_with_wo} km of pipe network un-investigated. Schedule next satellite tasking for remaining DMA tiles.`,
    },
    {
      title: 'ROI Trajectory',
      text:  `${fmtUSD(overall.water_cost_savings_with_wo + overall.energy_cost_savings_with_wo)} year-1 cost recovery from this Data Release. Payback metric: ${fmtNum(((overall.water_cost_savings_with_wo + overall.energy_cost_savings_with_wo) / 365) * 1, 2)} USD/day avoided loss.`,
    },
  ];

  // ===== EVENTS =====
  // Mix harvest provenance events (manifest.surfaces + sharepoint deliverables)
  // with the existing leak/release events so the timeline shows real lineage.
  const drDate = (poisRaw[0])?.dataReleaseDate?.slice(0, 10) ?? '2026-04-30';
  const harvestTime = (manifest?.finishedAt ?? '').slice(11, 16) + 'Z' || '18:42Z';
  const surfaces = manifest?.surfaces ?? {};
  const surfaceEvents = Object.entries(surfaces).map(([name, info]) => ({
    title: `Harvested ${name} — ${info?.ok ? 'OK' : 'FAIL'}${typeof info?.pois === 'number' ? ` · ${info.pois} POIs / ${info.fieldResults} FRs` : ''}`,
    time:  harvestTime,
    color: info?.ok ? 'var(--green)' : 'var(--red)',
  }));
  const deliverableEvents = (spIndex?.files ?? []).map((f) => ({
    title: `Deliverable: ${f.name} (${fmtNum(f.bytes ?? 0)} B · ${f.kind})`,
    time:  (spIndex?.capturedAt ?? '').slice(11, 16) + 'Z' || '18:55Z',
    color: 'var(--magenta)',
  }));

  const events = [
    ...leakDetections.map((d) => ({
      title: `${d.id} verified — ${d.name.split('·')[0].trim()}`,
      time:  ((d.time || '').split(' ')[1] || '00:00Z'),
      color: 'var(--red)',
    })),
    ...surfaceEvents,
    ...deliverableEvents,
    { title: `Data Release 2 published`,                time: '11:36Z', color: 'var(--cyan)' },
    { title: `${overall.total_poi_with_wo} POIs ingested into recover catalog`, time: '11:36Z', color: 'var(--blue)' },
    { title: `${overall.total_leaks_with_wo}/${overall.total_poi_with_wo} POIs flagged ERA/Active`, time: '11:36Z', color: 'var(--amber)' },
    { title: `Pipe network ingested — ${overall.total_pipe_km_without_wo} km`, time: '11:30Z', color: 'var(--green)' },
    { title: `Crew Demoville1 dispatched`,              time: '08:00Z', color: 'var(--blue)' },
    { title: `Sentinel-1 SAR pass acquired`,            time: '06:42Z', color: 'var(--cyan)' },
  ];

  // ===== PERSPECTIVES =====
  const leakCentroid = (() => {
    if (leakDetections.length === 0) return { lat: 30.0, lon: -95.7 };
    const sLat = leakDetections.reduce((s, d) => s + (d.lat || 0), 0);
    const sLon = leakDetections.reduce((s, d) => s + (d.lon || 0), 0);
    return { lat: sLat / leakDetections.length, lon: sLon / leakDetections.length };
  })();

  const perspectives = [
    { name: `${SUB_PROJECT_NAME} — Overview`,
      lat: leakCentroid.lat, lon: leakCentroid.lon, zoom: 12, created: drDate.slice(5) },
    ...leakDetections.map((d) => ({
      name: `${d.id} · ${d._finding}`,
      lat:  d.lat, lon: d.lon, zoom: 14, created: drDate.slice(5),
    })),
    { name: `Cypress, TX — Region`, lat: 29.97, lon: -95.69, zoom: 10, created: drDate.slice(5) },
  ];

  // ===== TIMELINE =====
  const monthsResult = charts.chartsData?.roiVsActualGraphs?.waterSaveDataNonAcc?.graphResult ?? [];
  const maxWS = Math.max(1, ...monthsResult.map((m) => m.waterSave));
  const timelineData = [
    monthsResult.map((m) => (m.waterSave > 0 ? overall.total_leaks_with_wo : 0)),
    monthsResult.map(() => 0),
    monthsResult.map((m) => (m.waterSave > 0 ? Math.min(8, Math.round(overall.poi_investigated_with_wo * 4)) : 0)),
    monthsResult.map((m) => Math.round((m.waterSave / maxWS) * 9)),
  ];
  while (timelineData[0].length < 12) timelineData.forEach((row) => row.unshift(0));

  // ===== SYS INTEL =====
  // Includes dashboard.json benchmarkData when present (e.g. industry NRW%
  // baselines). Right-panel KPI rail.
  const benchmark = dashSub.benchmarkData ?? {};
  const baseValues = dashSub.baseValues ?? {};
  const surfacePct = (Number(overall.surface ?? 0) + Number(overall.not_surface ?? 0)) > 0
    ? ((Number(overall.surface ?? 0) / (Number(overall.surface ?? 0) + Number(overall.not_surface ?? 0))) * 100).toFixed(0)
    : '0';

  const sysIntel = [
    { title: 'Water Saved (yr)',     val: fmtL(overall.water_save_with_wo),                color: 'var(--green)' },
    { title: 'Cost Recovery',         val: fmtUSD(overall.water_cost_savings_with_wo),       color: 'var(--green)' },
    { title: 'Energy Avoided',        val: fmtKWh(overall.energy_saved_with_wo),             color: 'var(--cyan)'  },
    { title: 'CO₂ Reduction',         val: fmtKgCO2(overall.greenhouse_gas_reduction_with_wo), color: 'var(--green)' },
    { title: 'Leaks per Crew-Day',    val: `${charts.chartsData?.leaksPerCrewDay ?? '—'}`,    color: 'var(--amber)' },
    { title: 'Leaks per km',          val: `${charts.chartsData?.leaksFoundPerUnit ?? '—'}`,  color: 'var(--cyan)'  },
    { title: 'Surface Visible %',     val: `${surfacePct}%`,                                 color: 'var(--blue)'  },
    { title: 'Non-Surfacing %',        val: `${overall.poiTypes?.[1]?.percent ?? 97}%`,        color: 'var(--blue)'  },
    { title: 'Investigated POIs',     val: `${overall.poi_investigated_with_wo}/${overall.total_poi_with_wo}`, color: 'var(--purple)' },
    { title: 'Pipe-km Investigated',  val: `${overall.pipe_km_investigated_with_wo}/${overall.total_pipe_km_without_wo}`, color: 'var(--cyan)' },
    ...(perLicense.length > 0
      ? [{ title: `Crew ${perLicense[0].name}`, val: `${perLicense[0].leaksFoundPerKm} L/km`, color: 'var(--amber)' }]
      : []),
    ...(benchmark?.nrwPercentage
      ? [{ title: 'Industry NRW%', val: `${benchmark.nrwPercentage}%`, color: 'var(--magenta)' }]
      : []),
    ...(baseValues?.waterPriceUsdPerL
      ? [{ title: 'Water $/L', val: fmtUSD(baseValues.waterPriceUsdPerL), color: 'var(--cyan)' }]
      : []),
  ];

  // ===== VIEWPORT (initial fly-to from dashboard.json) =====
  // Replaces the centroid-of-detections math the UI was doing, so the camera
  // lands exactly where the satellite EO source viewer opens.
  const iv = dashSub?.initialViewport ?? {};
  const mb = dashSub?.mapBoundaries ?? iv?.bounds ?? null;
  const viewport = {
    lat:    Number(iv?.center?.lat ?? leakCentroid.lat),
    lon:    Number(iv?.center?.lng ?? leakCentroid.lon),
    zoom:   Number(iv?.zoom ?? 12),
    bounds: mb
      ? { minX: Number(mb.minX), minY: Number(mb.minY), maxX: Number(mb.maxX), maxY: Number(mb.maxY) }
      : null,
  };

  // ===== HERO COUNTS (header-counts.json) =====
  // Live active/repaired/suspected from EO-Discover header endpoint, with
  // safe fallbacks to recover-overall.json when the file isn't present.
  const heroCounts = {
    active:    Number(headerCounts?.activeLeaks         ?? overall.total_leaks_with_wo ?? 0),
    repaired:  Number(headerCounts?.repairedLeaks       ?? 0),
    suspected: Number(headerCounts?.suspectedLocations  ?? overall.total_poi_with_wo ?? 0),
  };

  // ===== ASSET-CLASS BREAKDOWN (metricsValues from dashboard.json or root) =====
  // metrics-values.json (root harvest) is `[{pipe,hydrant,valve,...,unit_type}]`;
  // dashboard.metricsValues exposes the same shape per sub-project. Either
  // is acceptable.
  const mvRow = Array.isArray(metricsValues) ? metricsValues[0] : (metricsValues ?? dashSub?.metricsValues ?? null);
  const assetMetrics = mvRow
    ? {
        unit:           mvRow.unit_type ?? 'km',
        pipe:           Number(mvRow.pipe ?? 0),
        hydrant:        Number(mvRow.hydrant ?? 0),
        valve:          Number(mvRow.valve ?? 0),
        service:        Number(mvRow.service ?? 0),
        meter:          Number(mvRow.meter ?? 0),
        customerFitting: Number(mvRow.customer_fitting ?? 0),
        curbstop:       Number(mvRow.curbstop ?? 0),
        customerSide:   Number(mvRow.customer_side ?? 0),
      }
    : null;

  // ===== DATA RELEASES (header-filters.json) =====
  const dataReleases = headerFilters?.dataReleases ?? [];

  return {
    mission, layers, detections, weather, findings, actions, assets, aiRecs,
    events, perspectives, timelineData, sysIntel,
    _viewport:    viewport,
    _heroCounts:  heroCounts,
    _assetMetrics: assetMetrics,
    _dataReleases: dataReleases,
    _meta: {
      subProject:  SUB_PROJECT,
      name:        SUB_PROJECT_NAME,
      capturedAt:  manifest?.finishedAt,
      source:      source === 'api'
        ? 'AlphaGeo Harvest via live API (PostGIS-backed)'
        : 'AlphaGeo Harvest (satellite leak detection)',
      dataSource:  source,
      links,
      sharepoint:  spIndex,
      poisCount:   poisRaw.length,
      leakCount:   fieldResultsRaw.length,
      poiGeomCount: Object.keys(geomByUtilisId).length,
      region:      region ?? null,
      homeIndex:   homeProjectIndex ?? null,
    },
    _allPois:  poisRaw,
    _allLeaks: fieldResultsRaw,
    // GIS Cloud layer 7691554 ("Pipes") — populated by Track A's harvest CLI
    // (`scripts/dump-demoville-pipes.sh`). Empty FeatureCollection until that
    // lands; the deck.gl PathLayer renders nothing in that state.
    pipes: pipes && Array.isArray(pipes.features)
      ? pipes
      : { type: 'FeatureCollection', features: [] },
    _poiAttrs: attrsById,
  };
}
