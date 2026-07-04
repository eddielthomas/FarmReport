// =============================================================================
// index.mjs — SolutionPack barrel + resolved active vertical (Sprint A1).
// -----------------------------------------------------------------------------
// The active vertical is selected by env:
//   RWR_VERTICAL  or  OPERATIONSOS_VERTICAL  (first set wins) — default 'rwr'.
// `activeVertical` is the loaded + validated pack for that id. RWR is the
// reference pack; with no env override the platform behaves exactly as today.
// =============================================================================

export {
  loadVertical,
  listVerticals,
  parseYaml,
  validatePack,
  PLATFORM_BASE_ROLES,
  DEFAULT_VERTICAL_ID,
  VERTICALS_DIR,
  _resetCache,
} from './loader.mjs';

import { loadVertical, DEFAULT_VERTICAL_ID } from './loader.mjs';

/** The id selected by env (RWR_VERTICAL / OPERATIONSOS_VERTICAL), default rwr. */
export function activeVerticalId() {
  return (
    process.env.RWR_VERTICAL ||
    process.env.OPERATIONSOS_VERTICAL ||
    DEFAULT_VERTICAL_ID
  );
}

/** Resolve the active SolutionPack for the current process. */
export function getActiveVertical() {
  return loadVertical(activeVerticalId());
}

// Eagerly-resolved active pack for convenient default import.
export const activeVertical = getActiveVertical();
