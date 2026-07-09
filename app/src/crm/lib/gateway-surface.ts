// =============================================================================
// gateway-surface.ts — consume the AlphaGeo gateway's self-describing capability
// menu (GET /api/surface/menu, via our /farm/gw/surface/menu relay).
// -----------------------------------------------------------------------------
// The menu is grouped, invokable, tier-chipped and AUTO-GROWS as the gateway
// surfaces more capabilities. We use it to AUTO-GROW which reports are LIVE: a
// report whose recipe references a capability now present on the menu flips from
// "roadmap" to generate-able (see report-catalog.ts reportIsLive()).
//
// Graceful by design: until the gateway makes the endpoint reachable through our
// harvest-token relay, this returns { available:false } and the UI falls back to
// the static LIVE set in the registry — a not-yet-reachable menu never breaks it.
// =============================================================================

import { apiGet, ApiError } from './api';

export interface SurfaceMenu {
  available: boolean;
  /** Flattened lowercase capability tokens (tool keys / names) present on the menu. */
  capabilities: Set<string>;
  raw?: unknown;
}

// Walk the (grouped) menu JSON and collect capability IDENTIFIERS. We prefer
// explicit id-ish fields, and also accept bare snake/kebab tokens (e.g.
// "stac_datacube", "index_calc") which is how tools are keyed — while skipping
// prose so labels/descriptions don't pollute the capability set.
const TOKEN_RE = /^[a-z][a-z0-9]*(?:[_./-][a-z0-9]+)+$/; // must contain a separator → a key, not a word
function collect(node: unknown, acc: Set<string>): void {
  if (node == null) return;
  if (typeof node === 'string') {
    const s = node.trim().toLowerCase();
    if (s.length <= 64 && TOKEN_RE.test(s)) acc.add(s);
    return;
  }
  if (Array.isArray(node)) { for (const x of node) collect(x, acc); return; }
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    for (const k of ['key', 'tool', 'id', 'slug', 'capability', 'name']) {
      const v = o[k];
      if (typeof v === 'string') { const s = v.trim().toLowerCase(); if (s.length <= 64 && TOKEN_RE.test(s)) acc.add(s); }
    }
    for (const v of Object.values(o)) collect(v, acc);
  }
}

export async function fetchSurfaceMenu(): Promise<SurfaceMenu> {
  try {
    const raw = await apiGet<unknown>('/farm/gw/surface/menu');
    const acc = new Set<string>();
    collect(raw, acc);
    return { available: true, capabilities: acc, raw };
  } catch (err) {
    // 404 = route not reachable yet · 502 = gateway unreachable · 503 = unconfigured.
    // Any of these → fall back to the static registry; never throw into the UI.
    if (err instanceof ApiError && [404, 502, 503].includes(err.status)) return { available: false, capabilities: new Set() };
    return { available: false, capabilities: new Set() };
  }
}
