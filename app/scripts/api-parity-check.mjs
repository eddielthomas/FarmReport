#!/usr/bin/env node
// =============================================================================
// MVP API parity check â€” proves the live API serves byte-equivalent JSON to the
// bundled harvest tree, so swapping `import './harvest/*.json'` for `fetch()`
// in detections.js cannot drift the dashboard.
// -----------------------------------------------------------------------------
// Usage:
//   node mvp/scripts/api-parity-check.mjs                # default localhost:5180
//   API_BASE=http://host:5180 node mvp/scripts/api-parity-check.mjs
// Exit codes:
//   0  all checks pass
//   1  one or more checks failed
// =============================================================================

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HARVEST = join(here, '..', 'src', 'data', 'harvest');
const API = process.env.API_BASE ?? 'http://localhost:5180';
const SUB = process.env.SUB_PROJECT_ID ?? '676251';

// Order-insensitive deep equality (arrays of objects compared by sorted key).
const sortBy = (rows, key) =>
  [...rows].sort((a, b) => {
    const av = String(a?.[key] ?? '');
    const bv = String(b?.[key] ?? '');
    return av < bv ? -1 : av > bv ? 1 : 0;
  });

const stable = (v) => JSON.parse(JSON.stringify(v));

function diff(label, expected, actual) {
  const a = JSON.stringify(stable(expected));
  const b = JSON.stringify(stable(actual));
  if (a === b) return null;
  // Find first diff byte for a useful hint
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `${label}: differs at byte ${i}\n  expected â€¦${a.slice(Math.max(0, i - 40), i + 40)}â€¦\n  actual   â€¦${b.slice(Math.max(0, i - 40), i + 40)}â€¦`;
}

async function loadJson(name) {
  return JSON.parse(await readFile(join(HARVEST, name), 'utf8'));
}

async function fetchJson(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`GET ${path} â†’ ${res.status}`);
  return res.json();
}

const checks = [
  {
    label: 'recover-overall.json',
    bundled: () => loadJson('recover-overall.json'),
    api:     () => fetchJson(`/api/sub-projects/${SUB}/overall`),
    cmp:     (a, b) => diff('recover-overall', a, b),
  },
  {
    label: 'links.json',
    bundled: () => loadJson('links.json'),
    api:     () => fetchJson(`/api/sub-projects/${SUB}/links`),
    cmp:     (a, b) => diff('links', a, b),
  },
  {
    label: 'pois.json (count + sample)',
    bundled: () => loadJson('pois.json'),
    api:     () => fetchJson(`/api/sub-projects/${SUB}/pois`),
    cmp:     (a, b) => {
      if (!Array.isArray(a) || !Array.isArray(b)) return 'pois: not arrays';
      if (a.length !== b.length) return `pois: length ${a.length} vs ${b.length}`;
      const aS = sortBy(a, 'id');
      const bS = sortBy(b, 'id');
      // Compare canonical keys for first 5 + last
      for (const i of [0, 1, 2, aS.length - 1]) {
        const d = diff(`pois[${i}]`, aS[i], bS[i]);
        if (d) return d;
      }
      return null;
    },
  },
  {
    label: 'field-results.json',
    bundled: () => loadJson('field-results.json'),
    api:     () => fetchJson(`/api/sub-projects/${SUB}/field-results`),
    cmp:     (a, b) => {
      if (!Array.isArray(a) || !Array.isArray(b)) return 'field-results: not arrays';
      if (a.length !== b.length) return `field-results: length ${a.length} vs ${b.length}`;
      const aS = sortBy(a, 'ogc_fid');
      const bS = sortBy(b, 'ogc_fid');
      for (let i = 0; i < aS.length; i += 1) {
        const d = diff(`field-results[${i}]`, aS[i], bS[i]);
        if (d) return d;
      }
      return null;
    },
  },
];

async function main() {
  console.log(`api-parity-check  api=${API}  sub=${SUB}`);
  let failed = 0;
  for (const c of checks) {
    try {
      const [a, b] = await Promise.all([c.bundled(), c.api()]);
      const err = c.cmp(a, b);
      if (err) {
        console.log(`  âœ— ${c.label}`);
        console.log(`    ${err}`);
        failed += 1;
      } else {
        console.log(`  âœ“ ${c.label}`);
      }
    } catch (e) {
      console.log(`  âœ— ${c.label}  (${e.message})`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.log(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main();
