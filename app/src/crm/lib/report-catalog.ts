// =============================================================================
// report-catalog.ts — Report.Farm intelligence report registry.
// -----------------------------------------------------------------------------
// The reports layer is the product: an AI Executive Operations Center that sells
// JOB SECURITY, not imagery. The full plan is ~358 reports across 16 families
// (see docs/reports/00_REPORTS_CATALOG.md + the per-family recipe matrices).
//
// This registry is the machine-readable slice the APP renders + gates. Each entry
// carries its Buildability (what we can actually generate today vs roadmap) and
// its subscription Tier / entitlement feature key, so the Reports surface shows
// the whole vision while only letting a tenant RUN what its plan + our gateway
// support right now. Expand `REPORTS` from the family recipe docs as capabilities
// land (GW-LIFTING → LIVE, NEW-MODEL shipped, EXT-DATA wired).
// =============================================================================

export type Buildability = 'LIVE' | 'GW-LIFTING' | 'NEW-MODEL' | 'EXT-DATA';
export type Tier = 'Basic' | 'Pro' | 'Business';

export interface ReportFamily { slug: string; name: string; count: number }

export interface ReportDef {
  id: string;              // RF-<FAM>-nn
  family: string;          // family slug
  name: string;
  fear: string;            // the "will I get fired" question it answers
  kpi: string;             // headline output
  tier: Tier;
  feature: string;         // entitlements.mjs feature key that unlocks generation
  buildability: Buildability;
  /** LIVE reports compose these gateway capabilities (for the generate wiring). */
  via?: string;
}

// The 16 families + planned report counts (~358). Drives the catalog index +
// roadmap; per-report recipes live in docs/reports/categories/<slug>.md.
export const REPORT_FAMILIES: ReportFamily[] = [
  { slug: 'executive', name: 'Executive Reports', count: 18 },
  { slug: 'operations', name: 'Operations', count: 27 },
  { slug: 'crop-intelligence', name: 'Crop Intelligence', count: 38 },
  { slug: 'water', name: 'Water Management', count: 22 },
  { slug: 'soil', name: 'Soil Intelligence', count: 24 },
  { slug: 'weather', name: 'Weather Intelligence', count: 19 },
  { slug: 'disease', name: 'Disease Intelligence', count: 21 },
  { slug: 'pest', name: 'Pest Intelligence', count: 16 },
  { slug: 'equipment', name: 'Equipment Intelligence', count: 23 },
  { slug: 'labor', name: 'Labor Intelligence', count: 14 },
  { slug: 'supply-chain', name: 'Supply Chain', count: 20 },
  { slug: 'grocery-compliance', name: 'Grocery Chain Compliance', count: 18 },
  { slug: 'sustainability', name: 'Sustainability / ESG', count: 18 },
  { slug: 'financial', name: 'Financial Intelligence', count: 26 },
  { slug: 'risk', name: 'Risk Management', count: 25 },
  { slug: 'predictive-ai', name: 'Predictive AI', count: 29 },
];

export const TOTAL_PLANNED = REPORT_FAMILIES.reduce((a, f) => a + f.count, 0);

// The LIVE + near-LIVE core — reports we can generate today by composing existing
// AlphaGeo gateway endpoints. This is the "ship the Never-Get-Fired core first"
// slice; the rest of the ~358 render as roadmap until their capability lands.
export const REPORTS: ReportDef[] = [
  // --- Executive / Operations flagships (composite over the live layers) ---
  { id: 'RF-OPS-01', family: 'operations', name: 'Fields Requiring Attention', fear: 'Which fields need action before crews arrive?', kpi: 'Priority list', tier: 'Pro', feature: 'reports.season', buildability: 'LIVE', via: 'signals + s2_ndvi + lband_sar change' },
  { id: 'RF-EXE-01', family: 'executive', name: 'Executive Summary', fear: 'What do I tell the CEO Monday?', kpi: 'Farm Health Score', tier: 'Pro', feature: 'reports.season', buildability: 'LIVE', via: 'LLM over NDVI + stress + drainage + change' },
  { id: 'RF-EXE-02', family: 'executive', name: 'Never Get Fired Dashboard', fear: 'Will today be a good day or a very bad one?', kpi: 'Executive Priority Score', tier: 'Business', feature: 'portfolio.rollups', buildability: 'LIVE', via: 'portfolio composite' },
  // --- Crop Intelligence (LIVE via s2_ndvi / stac_datacube / vision) ---
  { id: 'RF-CRP-01', family: 'crop-intelligence', name: 'Crop Health / NDVI', fear: 'Is any field failing right now?', kpi: 'NDVI + Health Score', tier: 'Basic', feature: 'agriscan.readout', buildability: 'LIVE', via: 's2_ndvi' },
  { id: 'RF-CRP-02', family: 'crop-intelligence', name: 'AgriScan Field Readout', fear: 'Is this field healthy / stressed / waterlogged?', kpi: 'Plain-language status', tier: 'Basic', feature: 'agriscan.readout', buildability: 'LIVE', via: 's2_ndvi + whitebox_terrain' },
  { id: 'RF-CRP-03', family: 'crop-intelligence', name: 'Season NDVI / Phenology Curve', fear: 'Is the crop tracking to a normal season?', kpi: 'Growth curve', tier: 'Pro', feature: 'analysis.season_curves', buildability: 'LIVE', via: 'stac_datacube' },
  { id: 'RF-CRP-04', family: 'crop-intelligence', name: 'Vegetation Change', fear: 'What changed since last week?', kpi: 'Change map', tier: 'Pro', feature: 'analysis.season_curves', buildability: 'LIVE', via: 'change-detection over s2_ndvi' },
  { id: 'RF-CRP-05', family: 'crop-intelligence', name: 'Crop / Heat Stress Screen', fear: 'Which zones are stressed before RGB shows it?', kpi: 'Stress polygons', tier: 'Pro', feature: 'analysis.stress', buildability: 'LIVE', via: 'landsat_lst + NDVI anomaly' },
  { id: 'RF-CRP-06', family: 'crop-intelligence', name: 'Yield Estimate', fear: 'Will we hit production targets?', kpi: 'Tons + confidence', tier: 'Pro', feature: 'analysis.yield', buildability: 'GW-LIFTING', via: 'yield model' },
  // --- Water (LIVE via whitebox_terrain TWI) ---
  { id: 'RF-WTR-01', family: 'water', name: 'Water Pooling / Drainage (TWI)', fear: 'Will water pool / waterlog after this rain?', kpi: 'Drainage + waterlog risk', tier: 'Pro', feature: 'analysis.drainage', buildability: 'LIVE', via: 'whitebox_terrain' },
  { id: 'RF-WTR-02', family: 'water', name: 'Flood / Standing Water', fear: 'Is a section flooded right now?', kpi: 'Flood extent', tier: 'Pro', feature: 'analysis.drainage', buildability: 'LIVE', via: 'lband_sar + TWI' },
  // --- Risk / all-weather (Business, LIVE via lband_sar) ---
  { id: 'RF-RSK-01', family: 'risk', name: 'All-Weather Change Watch (SAR)', fear: 'What changed while it was cloudy?', kpi: 'Change alerts', tier: 'Business', feature: 'analysis.sar_change', buildability: 'LIVE', via: 'lband_sar' },
  { id: 'RF-GRC-01', family: 'grocery-compliance', name: 'Contract Fulfillment / Quota Risk', fear: 'Will Walmart reject this shipment / will we miss quota?', kpi: 'Delivery confidence', tier: 'Business', feature: 'reports.compliance', buildability: 'GW-LIFTING', via: 'yield + phenology rollup' },
];

export function reportsForFamily(slug: string): ReportDef[] {
  return REPORTS.filter((r) => r.family === slug);
}
