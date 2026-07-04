// =============================================================================
// ingest-core.mjs — shared AlphaGeo → crm.detection ingestion.
// -----------------------------------------------------------------------------
// One place that maps gateway pois-by-bbox features into persisted detections.
// Used by both the on-demand scan request (crm/scans.mjs) and the automatic
// background ingest (api/ingest-alphageo.mjs). Pure helpers + an upsert that
// runs inside a caller-provided pg client (so the caller owns the tx + the
// tenant GUC binding for RLS).
// =============================================================================

const SELF_PORT = Number(process.env.PORT ?? 5180);

export function centroidOf(geom) {
  if (!geom || !geom.coordinates) return null;
  let sx = 0, sy = 0, n = 0;
  const walk = (a) => {
    if (!Array.isArray(a)) return;
    if (typeof a[0] === 'number' && typeof a[1] === 'number') { sx += a[0]; sy += a[1]; n++; }
    else a.forEach(walk);
  };
  walk(geom.coordinates);
  return n ? { lon: sx / n, lat: sy / n } : null;
}

export function severityOf(p) {
  const vr = String(p.verification_result || '').toLowerCase();
  const rs = Number(p.risk_score);
  const ip = Number(p.investigation_priority);
  const s = Number.isFinite(rs) ? rs : (Number.isFinite(ip) ? ip / 100 : 0);
  if (vr.includes('confirm') || s >= 0.66) return 'high';
  if (s >= 0.33) return 'medium';
  return 'low';
}

export function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
export function intOrNull(v) {
  const n = numOrNull(v);
  return n == null ? null : Math.round(n);
}

// Fetch the AOI's current indicators via the internal leak relay (same process,
// reuses the gateway auth/egress). Returns a GeoJSON FeatureCollection.
export async function fetchGatewayLeaks({ aoi_west, aoi_south, aoi_east, aoi_north }) {
  const qs = `west=${aoi_west}&south=${aoi_south}&east=${aoi_east}&north=${aoi_north}&limit=5000`;
  const r = await fetch(`http://127.0.0.1:${SELF_PORT}/api/leaks/by-bbox?${qs}`, {
    headers: { accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`leak relay ${r.status}`);
  return r.json();
}

// Upsert a FeatureCollection's features into crm.detection for one project.
// `client` must already be in a tx with the tenant GUC bound. Returns counts.
export async function upsertDetections(client, { tenantId, scanId, projectId, features }) {
  const feats = Array.isArray(features) ? features : [];
  let confirmed = 0;
  for (const f of feats) {
    const p = f.properties || {};
    const c = centroidOf(f.geometry) || {};
    const isConfirmed = /confirm/i.test(String(p.verification_result || ''));
    if (isConfirmed) confirmed++;
    const geomJson = f.geometry ? JSON.stringify(f.geometry) : null;
    await client.query(
      `INSERT INTO crm.detection
         (tenant_id, scan_id, project_id, external_id,
          verification_result, leak_type, severity, status,
          score, era_score, risk_score, investigation_priority,
          lat, lon, geom, props, detected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
               CASE WHEN $15::text IS NULL THEN NULL
                    ELSE ST_SetSRID(ST_GeomFromGeoJSON($15), 4326)::geography END,
               $16, now())
       ON CONFLICT (project_id, external_id) DO UPDATE SET
          scan_id = EXCLUDED.scan_id,
          verification_result = EXCLUDED.verification_result,
          leak_type = EXCLUDED.leak_type, severity = EXCLUDED.severity,
          score = EXCLUDED.score, era_score = EXCLUDED.era_score,
          risk_score = EXCLUDED.risk_score,
          investigation_priority = EXCLUDED.investigation_priority,
          lat = EXCLUDED.lat, lon = EXCLUDED.lon, geom = EXCLUDED.geom,
          props = EXCLUDED.props, updated_at = now()`,
      [tenantId, scanId, projectId, String(f.id ?? p.utilis_id ?? ''),
       p.verification_result ?? null, p.leak_type ?? null, severityOf(p),
       isConfirmed ? 'confirmed' : 'suspected',
       numOrNull(p.investigation_priority) ?? numOrNull(p.risk_score),
       numOrNull(p.era_score), numOrNull(p.risk_score), intOrNull(p.investigation_priority),
       numOrNull(c.lat), numOrNull(c.lon), geomJson, JSON.stringify(p)]);
  }
  return { detections: feats.length, confirmed, suspected: feats.length - confirmed };
}
