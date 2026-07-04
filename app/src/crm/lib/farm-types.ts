// =============================================================================
// farm-types.ts — Report.Farm domain types (Wave-2 frontend).
// Mirrors the /api/v1/farm/* envelope shapes served by api/v1/farm/*.mjs.
// =============================================================================

/** Ordered risk bands (low → high). Matches the semantic --risk-* token ramp. */
export type RiskBand = 'healthy' | 'watch' | 'stress' | 'high' | 'critical';

export interface BuyerRollup {
  tenant_id: string;
  buyer_slug: string | null;
  buyer_name: string | null;
  supplier_count: number | string;
  region_count: number | string;
  farm_count: number | string;
  avg_risk_score: number | string | null;
  max_risk_score: number | string | null;
  revenue_at_risk_usd: number | string;
}

export interface SupplierRollup {
  supplier_id: string;
  supplier_name: string;
  sourcing_region_id: string | null;
  region_name: string | null;
  farm_count: number | string;
  avg_risk_score: number | string | null;
  max_risk_score: number | string | null;
  revenue_at_risk_usd: number | string | null;
}

export interface RegionRollup {
  sourcing_region_id: string;
  region_name: string;
  supplier_count: number | string;
  farm_count: number | string;
  avg_risk_score: number | string | null;
  max_risk_score: number | string | null;
  revenue_at_risk_usd: number | string | null;
}

export interface FarmProfile {
  id: string;
  tenant_id: string;
  name: string;
  timezone: string;
  farm_types: string[];
  crops: string[];
  total_area_ha: number | string | null;
  status: string;
  supplier_id: string | null;
  supplier_name: string | null;
  aoi_west: number | string | null;
  aoi_south: number | string | null;
  aoi_east: number | string | null;
  aoi_north: number | string | null;
  boundaries: GeoJSON.MultiPolygon | null;
  latest_risk_score: number | string | null;
  latest_risk_band: RiskBand | null;
  latest_risk_date: string | null;
  created_at: string;
}

export interface FarmAlert {
  id: string;
  farm_id: string;
  zone_id: string | null;
  severity: string;
  category: string;
  title: string;
  summary: string | null;
  confidence: number | string | null;
  status: string;
  created_at: string;
}

/** Map a 0–100 risk score to a band when the API hasn't labelled one. */
export function scoreToBand(score: number | string | null | undefined): RiskBand | null {
  if (score == null) return null;
  const n = typeof score === 'string' ? parseFloat(score) : score;
  if (Number.isNaN(n)) return null;
  if (n >= 80) return 'critical';
  if (n >= 60) return 'high';
  if (n >= 40) return 'stress';
  if (n >= 20) return 'watch';
  return 'healthy';
}

export const num = (v: number | string | null | undefined, fallback = 0): number => {
  if (v == null) return fallback;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isNaN(n) ? fallback : n;
};
