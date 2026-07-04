// =============================================================================
// lib/geo.mjs — geofence math helpers shared by field handlers.
// -----------------------------------------------------------------------------
// distanceMeters(lat1, lon1, lat2, lon2) — pure JS great-circle (Haversine) in
//   metres. Used for client-side hints + handler-side pre-DB short-circuits
//   when we already have a known position pair (e.g. cross-referencing the
//   tech's last-known position against an incoming upload's capture point).
//
// distanceMetersSql(aLatExpr, aLonExpr, bLatExpr, bLonExpr) — emits a
//   `ST_DistanceSphere` expression (metres) for use inside a parameterised
//   SELECT. The geography variant in Postgres (`ST_Distance(a::geography,
//   b::geography)`) is more accurate but slower and harder to compose into
//   parameter-driven queries — for the field workflow Haversine on a sphere
//   is plenty accurate (<0.5% error) and matches the JS helper.
//
// validCoord(lat, lon) — common bounds guard the handlers use to fail-fast.
// =============================================================================

const EARTH_RADIUS_M = 6371008.8; // mean radius per IUGG

function toRad(deg) { return (deg * Math.PI) / 180; }

export function validCoord(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  return Number.isFinite(la) && Number.isFinite(lo)
      && la >= -90 && la <= 90 && lo >= -180 && lo <= 180;
}

export function distanceMeters(lat1, lon1, lat2, lon2) {
  if (!validCoord(lat1, lon1) || !validCoord(lat2, lon2)) return null;
  const phi1 = toRad(Number(lat1));
  const phi2 = toRad(Number(lat2));
  const dPhi = toRad(Number(lat2) - Number(lat1));
  const dLam = toRad(Number(lon2) - Number(lon1));
  const a = Math.sin(dPhi / 2) ** 2
          + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

// Build a SQL fragment that returns metres between two geography points.
// Pass placeholders or column refs — the caller is responsible for parameter
// binding.
export function distanceMetersSql(aPoint, bPoint) {
  return `ST_Distance((${aPoint})::geography, (${bPoint})::geography)`;
}

// Helper to build a parameterised point from lat/lon — keeps callers terse.
export function pointFromLatLon(lonParam, latParam) {
  return `ST_SetSRID(ST_MakePoint(${lonParam}, ${latParam}), 4326)::geography`;
}
