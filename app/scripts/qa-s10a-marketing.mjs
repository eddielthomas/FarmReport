#!/usr/bin/env node
// =============================================================================
// QA · S10A — marketing re-skin onto S7A design kit
// -----------------------------------------------------------------------------
// Validates the 7 marketing surfaces (index, solutions, industries, platform,
// company, contact, access) in `dist/` against the S10A acceptance gates:
//
//   1. Each page exists in dist/.
//   2. Each loads the Urbanist Google Fonts stylesheet.
//   3. Each links the marketing-tokens.css bridge.
//   4. Each sets `data-surface="light"` on the <html> element.
//   5. None contain the cinematic-dark `#04060e` (or `#030609`) hex.
//   6. Each has a viewport meta + lang attribute (SEO basics).
//   7. None pull React via `<script type="module">` (these stay static).
//
// Run after `npm run build`. Exits 0 on success, 1 on any failure.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist');

const PAGES = [
  'index.html',
  'access.html',
  'solutions.html',
  'industries.html',
  'platform.html',
  'company.html',
  'contact.html',
];

let failures = 0;
const ok   = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };

console.log('\nQA · S10A — marketing re-skin');
console.log('────────────────────────────────────────────');
console.log(`dist root: ${DIST}\n`);

if (!existsSync(DIST)) {
  console.error('FATAL: dist/ does not exist. Run `npm run build` first.');
  process.exit(1);
}

for (const page of PAGES) {
  const path = resolve(DIST, page);
  console.log(`\n[${page}]`);

  if (!existsSync(path)) {
    fail(`file missing: ${path}`);
    continue;
  }
  ok('file exists');

  const html = readFileSync(path, 'utf8');

  // 2 · Urbanist font link
  if (/fonts\.googleapis\.com\/css2\?family=Urbanist/.test(html)) {
    ok('Urbanist Google Fonts link present');
  } else {
    fail('missing Urbanist Google Fonts link');
  }

  // 3 · marketing-tokens.css bridge
  if (/marketing-tokens([-.][A-Za-z0-9_-]+)?\.css/.test(html)) {
    ok('marketing-tokens.css linked');
  } else {
    fail('missing /src/marketing-tokens.css link');
  }

  // 4 · data-surface="light" on <html>
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? '';
  if (/data-surface\s*=\s*["']light["']/.test(htmlTag)) {
    ok('html data-surface="light"');
  } else {
    fail('missing data-surface="light" on <html>');
  }

  // 5 · no cinematic-dark hex
  if (/#04060e/i.test(html) || /#030609/i.test(html)) {
    const which = /#030609/i.test(html) ? '#030609' : '#04060e';
    fail(`cinematic-dark hex ${which} still present in dist`);
  } else {
    ok('no cinematic-dark hex (#04060e / #030609)');
  }

  // 6 · viewport + lang
  if (/<meta\s+name=["']viewport["']/i.test(html)) {
    ok('viewport meta present');
  } else {
    fail('missing viewport meta');
  }
  if (/lang\s*=\s*["'][a-zA-Z-]+["']/.test(htmlTag)) {
    ok('html lang attribute present');
  } else {
    fail('missing lang attribute on <html>');
  }

  // 7 · no React module imports
  const modScripts = [...html.matchAll(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/gi)]
    .map((m) => m[1]);
  const reactish = modScripts.filter((src) => /react|crm|jsx|tsx/i.test(src));
  if (reactish.length === 0) {
    ok('no React module imports (static page preserved)');
  } else {
    fail(`React-style module imports found: ${reactish.join(', ')}`);
  }
}

console.log('\n────────────────────────────────────────────');
if (failures > 0) {
  console.log(`FAIL · ${failures} assertion${failures === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log('PASS · all S10A marketing assertions green');
process.exit(0);
