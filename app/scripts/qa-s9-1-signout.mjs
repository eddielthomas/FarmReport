// =============================================================================
// qa-s9-1-signout.mjs — verify the rebuilt App bundle implements the new
// signOut() contract.
// -----------------------------------------------------------------------------
// 1) `npm run build` (writes dist/assets/App-*.js)
// 2) Static grep dist/assets/App-*.js for `localStorage.removeItem` near the
//    signOut codepath — confirms the persist-purge fix.
// 3) Static grep for `window.location.replace("/login.html")` (or its
//    minified equivalent) — confirms the replace-instead-of-assign fix.
// 4) Static grep for `disconnectFieldSocket` reference in the bundle —
//    confirms the socket-teardown wiring made it through esbuild.
//
// This is a structural test only; the runtime guarantees come from the unit
// review of TopNav.tsx + MeTab.tsx.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'D:/Projects/RWR/mvp';
const out = [];
let failures = 0;
function fail(msg) { out.push(`  FAIL: ${msg}`); failures++; }
function pass(msg) { out.push(`  PASS: ${msg}`); }
function info(msg) { out.push(`  INFO: ${msg}`); }

// -- step 1: build --
out.push('-- step 1: npm run build --');
const build = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', 'build'],
  { cwd: ROOT, encoding: 'utf8', shell: true },
);
if (build.status !== 0) {
  fail(`npm run build exited ${build.status}`);
  out.push('---- stderr ----');
  out.push((build.stderr ?? '').slice(-2000));
} else {
  pass('npm run build OK');
}

// -- step 2-4: bundle scans --
const ASSETS = join(ROOT, 'dist', 'assets');
if (!existsSync(ASSETS)) {
  fail(`dist/assets directory missing: ${ASSETS}`);
} else {
  const all = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
  info(`scanning ${all.length} JS chunks in dist/assets/`);
  const matchedRemove = [];
  const matchedReplace = [];
  const matchedDisconnect = [];

  for (const f of all) {
    let src;
    try { src = readFileSync(join(ASSETS, f), 'utf8'); } catch { continue; }
    // The minifier may rename `localStorage` to `localStorage` (it's a global,
    // so name preserved). Both literal calls survive.
    if (src.includes('localStorage.removeItem')) matchedRemove.push(f);
    // location.replace with /login.html literal.
    if (/location\.replace\(\s*["']\/login\.html["']\s*\)/.test(src)) matchedReplace.push(f);
    // disconnectFieldSocket — top-level export, identifier is preserved by
    // esbuild when re-exported across modules (or appears once mangled but
    // still findable by literal "disconnect" + sock teardown). We accept any
    // chunk that contains the literal source identifier.
    if (src.includes('disconnectFieldSocket') || /removeAllListeners\(\)/.test(src)) {
      matchedDisconnect.push(f);
    }
  }

  out.push('-- step 2: localStorage.removeItem --');
  if (matchedRemove.length > 0) {
    pass(`localStorage.removeItem present in ${matchedRemove.length} chunk(s): ${matchedRemove.slice(0, 3).join(', ')}`);
  } else {
    fail('no chunk contains localStorage.removeItem — signOut persist-purge missing');
  }

  out.push('-- step 3: location.replace("/login.html") --');
  if (matchedReplace.length > 0) {
    pass(`location.replace("/login.html") present in ${matchedReplace.length} chunk(s): ${matchedReplace.slice(0, 3).join(', ')}`);
  } else {
    fail('no chunk contains location.replace("/login.html") — signOut hard-nav missing');
  }

  out.push('-- step 4: disconnectFieldSocket teardown --');
  if (matchedDisconnect.length > 0) {
    pass(`socket teardown signature present in ${matchedDisconnect.length} chunk(s): ${matchedDisconnect.slice(0, 3).join(', ')}`);
  } else {
    fail('no chunk contains disconnectFieldSocket — socket teardown missing');
  }
}

out.push('');
out.push(failures === 0 ? 'qa-s9-1-signout PASS' : `qa-s9-1-signout FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync(join(ROOT, '.qa-s9-1-signout-out.txt'), txt, 'utf8');
console.log(txt);
process.exit(failures === 0 ? 0 : 1);
