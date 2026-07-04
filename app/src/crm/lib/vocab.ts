// =============================================================================
// vocab.ts — Sprint A3 vocabulary accessor (React surfaces).
// -----------------------------------------------------------------------------
// Resolves entity-noun / KPI labels from the ACTIVE SolutionPack's vocabulary
// map, which is build-time generated into `solution-pack.generated.ts`
// (GENERATED_CLIENT_PACK.vocabulary) by scripts/gen-role-pack.mjs. The vanilla
// twin for non-React surfaces (dashboard.html) is `window.rwrVocab(key)`, set
// by public/role-gate-pack.js — same data, same resolution rules.
//
// For the farm reference pack every resolved string equals today's hardcoded
// literal (detection→"signal", areaOfInterest→"field", asset→"zone", …), so
// this is a behaviour-preserving refactor: the UI now reads the pack instead
// of embedding vertical-specific nouns inline.
// =============================================================================
import { GENERATED_CLIENT_PACK } from './solution-pack.generated';

/** Active vocabulary map (entities ∪ kpis), flattened to key → label. */
const VOCAB: Readonly<Record<string, string>> =
  (GENERATED_CLIENT_PACK.vocabulary as Record<string, string> | undefined) ?? {};

/**
 * Resolve a vocabulary label for `key` from the active pack.
 * Falls back to `fallback` (when provided) and finally to `key` itself, so a
 * missing key never renders blank.
 *
 *   t('detection', 'signal')        // 'signal' for farm, 'observation' for crops
 *   t('detectionPlural', 'signals') // 'signals' / 'observations'
 *   t('areaOfInterest', 'field')    // 'field' / 'AOI'
 *   t('asset', 'zone')              // 'zone' / 'field'
 */
export function t(key: string, fallback?: string): string {
  const v = VOCAB[key];
  if (typeof v === 'string' && v.length > 0) return v;
  return fallback != null ? fallback : key;
}

/** Capitalised first letter — convenience for sentence-leading labels. */
export function tCap(key: string, fallback?: string): string {
  const s = t(key, fallback);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** The whole resolved vocabulary map (read-only). */
export function vocabulary(): Readonly<Record<string, string>> {
  return VOCAB;
}
