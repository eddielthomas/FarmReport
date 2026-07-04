#!/usr/bin/env node
// =============================================================================
// gen-role-pack.mjs — Sprint A2 build-time pack injection.
// -----------------------------------------------------------------------------
// Reads the ACTIVE SolutionPack (env RWR_VERTICAL / OPERATIONSOS_VERTICAL,
// default 'rwr') via the A1 loader and emits TWO generated artifacts that are
// the SINGLE SOURCE OF TRUTH for client-side role -> surface routing:
//
//   1. mvp/public/role-gate-pack.js
//        A tiny synchronous script that sets `window.__RWR_ROLE_PACK = {...}`.
//        It is loaded with a SYNCHRONOUS <script src="/role-gate-pack.js">
//        placed immediately BEFORE <script src="/role-gate.js">. Because both
//        are synchronous and run before paint, the pre-paint gate keeps its
//        first-paint behaviour — NO async fetch is introduced.
//
//   2. mvp/src/crm/lib/solution-pack.generated.ts
//        A typed `GENERATED_CLIENT_PACK: SolutionPackClient` that auth-store.ts
//        imports and installs as the active client pack. Same data as (1) so
//        role-gate.js and auth-store.ts never drift.
//
// Determinism / preservation: for the RWR (default) pack the emitted maps equal
// the hardcoded S12 maps byte-for-byte (asserted by qa-a2-vertical-routing.mjs
// and independently by qa-s12-roles.mjs). For a different active vertical the
// generated maps reflect THAT pack's roleSurfaceAllowList / primarySurfaceByRole
// with zero code edits — proving the switch.
//
// Run automatically by `npm run build` (the "prebuild" lifecycle hook) and on
// demand via `node scripts/gen-role-pack.mjs`.
// =============================================================================

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The SolutionPack loader lives at the repo root (`packages/config/verticals`),
// OUTSIDE the `mvp/` subtree. Deploy targets that ship only `mvp/` won't have
// it — so we import it LAZILY in main() and degrade gracefully: if it's absent
// we keep the already-committed role-gate-pack.js + solution-pack.generated.ts
// (which are shipped under mvp/ and are correct for the default RWR vertical).

const HERE = dirname(fileURLToPath(import.meta.url));
const MVP_ROOT = resolve(HERE, '..');
const GATE_PACK_PATH = join(MVP_ROOT, 'public', 'role-gate-pack.js');
const TS_PACK_PATH   = join(MVP_ROOT, 'src', 'crm', 'lib', 'solution-pack.generated.ts');

// The full authenticated surface universe. '*admin' expands to ALL of these.
// (Kept fixed and platform-wide so a pack that lists a leaner surface set still
// lets the super-user reach every surface that physically exists in the app.)
const ALL_AUTHED_SURFACES = [
  'tenants.html', 'staff.html', 'sales.html', 'pm.html', 'analytics.html',
  'operations.html', 'customer.html', 'vendor.html', 'field.html',
  'dashboard.html', 'login.html',
];

// -----------------------------------------------------------------------------
// Project the YAML pack maps into ordered client-pack arrays. Insertion order of
// the YAML object literal is preserved by the loader (JS object key order), and
// `*admin` is normalised to `platform:admin` for the client which keys on the
// real role name. The first matching clause wins downstream.
// -----------------------------------------------------------------------------
function buildClientPack(pack) {
  const allowEntries = Object.entries(pack.roleSurfaceAllowList || {});
  const primaryEntries = Object.entries(pack.primarySurfaceByRole || {});

  const roleSurfaceAllowList = allowEntries.map(([key, surfaces]) => {
    // '*admin' is handled specially by the engine (super-user sees ALL); keep
    // the universe list explicit so the generated file is self-documenting.
    if (key === '*admin') return ['*admin', ALL_AUTHED_SURFACES.slice()];
    return [key, (Array.isArray(surfaces) ? surfaces.slice() : [])];
  });

  const primarySurfaceByRole = primaryEntries.map(([key, surface]) => {
    // Normalise '*admin' -> 'platform:admin' so the client keys on the real
    // role string (the engine treats both, but the RWR byte-for-byte pack used
    // 'platform:admin').
    const k = key === '*admin' ? 'platform:admin' : key;
    return [k, surface];
  });

  // --- Sprint A3 levers: vocabulary, basemaps, seed scenes -------------------
  // These are pure data projections of the active pack so the client surfaces
  // (dashboard.html basemap picker, vocab accessors, scene seeders) read the
  // active vertical instead of hardcoded water-specific values. For the RWR
  // reference pack the emitted values equal today's literals byte-for-byte.

  // Vocabulary — flatten { entities, kpis } into a single lookup map so a
  // caller can `t('detection')` or `t('detections')` without knowing the
  // namespace. entities keys win on collision (none today). Shape preserved as
  // a flat string->string map for the vanilla window.rwrVocab() accessor.
  const vocab = pack.vocabulary || {};
  const vocabulary = {
    ...(vocab.entities && typeof vocab.entities === 'object' ? vocab.entities : {}),
    ...(vocab.kpis && typeof vocab.kpis === 'object' ? vocab.kpis : {}),
  };

  // Basemaps — pass through id/name/use exactly as declared (the dashboard
  // engine owns the tile/filter rendering details; the pack only governs WHICH
  // basemaps appear and in what order, plus the default selection).
  const basemaps = (Array.isArray(pack.basemaps) ? pack.basemaps : []).map((b) => ({
    id: b.id,
    name: b.name,
    use: b.use,
  }));
  const defaultBasemap = pack.defaultBasemap || (basemaps[0] && basemaps[0].id) || 'satellite';

  // Seed scenes — the default saved-scene set (crm.project_scene shape). Passed
  // through with the pack's field names so the scene seeder can map them onto
  // the DB columns.
  const seedScenes = (Array.isArray(pack.seedScenes) ? pack.seedScenes : []).map((s) => ({
    title: s.title,
    description: s.description ?? null,
    isDefault: s.isDefault ?? false,
    ordinal: s.ordinal ?? 0,
    centerLat: s.centerLat,
    centerLon: s.centerLon,
    zoom: s.zoom ?? 12,
    pitch: s.pitch ?? 0,
    bearing: s.bearing ?? 0,
    basemapId: s.basemapId,
    sarOverlay: s.sarOverlay ?? false,
    sarOpacity: s.sarOpacity ?? 60,
    activeLayers: Array.isArray(s.activeLayers) ? s.activeLayers.slice() : [],
  }));

  return {
    id: pack.id,
    displayName: pack.displayName,
    version: pack.version,
    primarySurfaceByRole,
    roleSurfaceAllowList,
    vocabulary,
    basemaps,
    defaultBasemap,
    seedScenes,
  };
}

// -----------------------------------------------------------------------------
// Emit role-gate-pack.js — synchronous global for the pre-paint gate.
// -----------------------------------------------------------------------------
function emitGatePack(client, vid) {
  const banner =
`/* AUTO-GENERATED by mvp/scripts/gen-role-pack.mjs — DO NOT EDIT BY HAND.
 * Active vertical: ${vid} (pack id=${client.id} v${client.version}).
 * Loaded SYNCHRONOUSLY (before role-gate.js) so the pre-paint gate reads the
 * active pack's routing maps with NO async fetch. role-gate.js falls back to a
 * hardcoded RWR map if this global is missing (defensive — never ungated).
 */`;
  const body =
`window.__RWR_ROLE_PACK = ${JSON.stringify({
    id: client.id,
    displayName: client.displayName,
    version: client.version,
    primarySurfaceByRole: client.primarySurfaceByRole,
    roleSurfaceAllowList: client.roleSurfaceAllowList,
    // Sprint A3 — pack-driven vocabulary / basemaps / seed scenes. Vanilla
    // surfaces (dashboard.html) read these off the global; React surfaces read
    // the typed solution-pack.generated.ts twin. window.rwrVocab() looks up
    // `vocabulary` below.
    vocabulary: client.vocabulary,
    basemaps: client.basemaps,
    defaultBasemap: client.defaultBasemap,
    seedScenes: client.seedScenes,
  }, null, 2)};

/* window.rwrVocab(key, fallback) — synchronous vocab accessor for non-React
 * surfaces (dashboard.html etc.). Returns the active pack's noun/KPI label for
 * the given key, or fallback (then the key itself) when absent. For the RWR
 * pack the resolved strings equal today's literals. */
window.rwrVocab = function rwrVocab(key, fallback) {
  try {
    var v = (window.__RWR_ROLE_PACK && window.__RWR_ROLE_PACK.vocabulary) || {};
    if (Object.prototype.hasOwnProperty.call(v, key) && v[key] != null) return v[key];
  } catch (_) {}
  return fallback != null ? fallback : key;
};`;
  writeFileSync(GATE_PACK_PATH, `${banner}\n${body}\n`, 'utf8');
}

// -----------------------------------------------------------------------------
// Emit solution-pack.generated.ts — typed client pack for auth-store.ts.
// -----------------------------------------------------------------------------
function emitTsPack(client, vid) {
  const banner =
`// AUTO-GENERATED by mvp/scripts/gen-role-pack.mjs — DO NOT EDIT BY HAND.
// Active vertical: ${vid} (pack id=${client.id} v${client.version}).
// Single source of truth for client routing maps, shared with
// public/role-gate-pack.js. auth-store.ts installs this as the active client
// pack. For the RWR default this equals the S12 maps byte-for-byte.
import type { SolutionPackClient } from './auth-store';
`;
  const primary = client.primarySurfaceByRole
    .map(([k, v]) => `    [${JSON.stringify(k)}, ${JSON.stringify(v)}],`)
    .join('\n');
  const allow = client.roleSurfaceAllowList
    .map(([k, arr]) => `    [${JSON.stringify(k)}, [${arr.map((s) => JSON.stringify(s)).join(', ')}]],`)
    .join('\n');
  // Sprint A3 levers serialised as plain JSON literals (indented 2 for the
  // object body). vocabulary/basemaps/defaultBasemap/seedScenes are typed on
  // SolutionPackClient in auth-store.ts.
  const vocabulary = JSON.stringify(client.vocabulary, null, 2)
    .split('\n').map((l, i) => (i === 0 ? l : '  ' + l)).join('\n');
  const basemaps = JSON.stringify(client.basemaps, null, 2)
    .split('\n').map((l, i) => (i === 0 ? l : '  ' + l)).join('\n');
  const seedScenes = JSON.stringify(client.seedScenes, null, 2)
    .split('\n').map((l, i) => (i === 0 ? l : '  ' + l)).join('\n');
  const body =
`export const GENERATED_CLIENT_PACK: SolutionPackClient = {
  id: ${JSON.stringify(client.id)},
  primarySurfaceByRole: [
${primary}
  ],
  roleSurfaceAllowList: [
${allow}
  ],
  vocabulary: ${vocabulary},
  basemaps: ${basemaps},
  defaultBasemap: ${JSON.stringify(client.defaultBasemap)},
  seedScenes: ${seedScenes},
};
`;
  writeFileSync(TS_PACK_PATH, `${banner}\n${body}`, 'utf8');
}

// -----------------------------------------------------------------------------
async function main() {
  let getActiveVertical, activeVerticalId;
  try {
    ({ getActiveVertical, activeVerticalId } = await import('../../packages/config/verticals/index.mjs'));
  } catch (err) {
    console.warn(
      `[gen-role-pack] SolutionPack loader not present (${err?.code ?? err?.message}); ` +
      'keeping the committed role-gate-pack.js + solution-pack.generated.ts. ' +
      'Expected on deploy targets that ship only mvp/.',
    );
    return;
  }
  const vid = activeVerticalId();
  const pack = getActiveVertical();
  const client = buildClientPack(pack);
  emitGatePack(client, vid);
  emitTsPack(client, vid);
  console.log(
    `[gen-role-pack] active vertical=${vid} pack=${pack.id} v${pack.version}\n` +
    `  -> ${GATE_PACK_PATH}\n` +
    `  -> ${TS_PACK_PATH}`,
  );
}

main();

export { buildClientPack, ALL_AUTHED_SURFACES };
