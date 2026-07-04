#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// seo-check.mjs — Marketing-page SEO validator for RWR Sentinel.
//
// Usage:   node scripts/seo-check.mjs
// Exit:    0 if all pages PASS, 1 if any FAIL.
// Deps:    none (Node stdlib only).
//
// Validates every public marketing page for:
//   • <title>, <meta name=description>, <link rel=canonical>
//   • Full Open Graph block (og:type, site_name, title, description, url,
//     image, image:width, image:height, image:alt, locale)
//   • Twitter card block (twitter:card, title, description, image)
//   • At least one valid JSON-LD block (and each block parses cleanly)
//   • Meta-description length within 120–170 chars (warning outside)
//
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, '..');

const PAGES = [
  'index.html',
  'solutions.html',
  'industries.html',
  'platform.html',
  'company.html',
  'contact.html',
];

const REQUIRED_OG = [
  'og:type',
  'og:site_name',
  'og:title',
  'og:description',
  'og:url',
  'og:image',
  'og:image:width',
  'og:image:height',
  'og:image:alt',
  'og:locale',
];

const REQUIRED_TWITTER = [
  'twitter:card',
  'twitter:title',
  'twitter:description',
  'twitter:image',
];

// ──────────────────────────────────────────────────────────────────────────────
// Tiny regex-based head extractor. Good enough for static, well-formed HTML.
// ──────────────────────────────────────────────────────────────────────────────
function extractHead(html) {
  const m = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  return m ? m[1] : html.slice(0, 8000);
}

function getTitle(head) {
  const m = head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : null;
}

function getMetaName(head, name) {
  const re = new RegExp(
    `<meta\\s+[^>]*name=["']${escapeRegExp(name)}["'][^>]*content=["']([^"']*)["']`,
    'i',
  );
  const re2 = new RegExp(
    `<meta\\s+[^>]*content=["']([^"']*)["'][^>]*name=["']${escapeRegExp(name)}["']`,
    'i',
  );
  return (head.match(re)?.[1] ?? head.match(re2)?.[1]) ?? null;
}

function getMetaProperty(head, prop) {
  const re = new RegExp(
    `<meta\\s+[^>]*property=["']${escapeRegExp(prop)}["'][^>]*content=["']([^"']*)["']`,
    'i',
  );
  const re2 = new RegExp(
    `<meta\\s+[^>]*content=["']([^"']*)["'][^>]*property=["']${escapeRegExp(prop)}["']`,
    'i',
  );
  return (head.match(re)?.[1] ?? head.match(re2)?.[1]) ?? null;
}

function getCanonical(head) {
  const m =
    head.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
    head.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  return m ? m[1] : null;
}

function extractJsonLdBlocks(head) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks = [];
  let m;
  while ((m = re.exec(head)) !== null) {
    blocks.push(m[1].trim());
  }
  return blocks;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ──────────────────────────────────────────────────────────────────────────────
// Page check
// ──────────────────────────────────────────────────────────────────────────────
function checkPage(page) {
  const filePath = resolve(ROOT, page);
  if (!existsSync(filePath)) {
    return {
      page,
      pass: false,
      missing: ['file-not-found'],
      warnings: [],
      descLen: 0,
      jsonLd: { count: 0, types: [] },
    };
  }

  const html = readFileSync(filePath, 'utf8');
  const head = extractHead(html);

  const missing = [];
  const warnings = [];

  // Title
  const title = getTitle(head);
  if (!title) missing.push('<title>');

  // Meta description
  const desc = getMetaName(head, 'description');
  if (!desc) missing.push('meta[name=description]');

  // Canonical
  const canonical = getCanonical(head);
  if (!canonical) missing.push('link[rel=canonical]');

  // Robots
  if (!getMetaName(head, 'robots')) missing.push('meta[name=robots]');

  // OG block
  for (const key of REQUIRED_OG) {
    if (!getMetaProperty(head, key)) missing.push(key);
  }

  // Twitter block
  for (const key of REQUIRED_TWITTER) {
    if (!getMetaName(head, key)) missing.push(key);
  }

  // JSON-LD parsing
  const blocks = extractJsonLdBlocks(head);
  const types = [];
  if (blocks.length === 0) {
    missing.push('application/ld+json');
  }
  for (let i = 0; i < blocks.length; i++) {
    try {
      const parsed = JSON.parse(blocks[i]);
      if (Array.isArray(parsed['@graph'])) {
        for (const node of parsed['@graph']) {
          if (node && node['@type']) types.push(node['@type']);
        }
      } else if (parsed && parsed['@type']) {
        types.push(parsed['@type']);
      }
    } catch (err) {
      missing.push(`json-ld-block-${i + 1}-invalid`);
    }
  }

  // Description length warning
  const descLen = (desc || '').length;
  if (desc && (descLen < 120 || descLen > 170)) {
    warnings.push(`description-length=${descLen} (target 120–170)`);
  }

  return {
    page,
    pass: missing.length === 0,
    missing,
    warnings,
    descLen,
    jsonLd: { count: blocks.length, types },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Run
// ──────────────────────────────────────────────────────────────────────────────
const results = PAGES.map(checkPage);

let anyFail = false;
let totalWarn = 0;

console.log('\n┌─ RWR Sentinel · SEO sweep validator ────────────────────────');
console.log('│ root: ' + ROOT);
console.log('│ pages: ' + PAGES.length);
console.log('└──────────────────────────────────────────────────────────────\n');

for (const r of results) {
  const tag = r.pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${r.page}`);
  console.log(`       description: ${r.descLen} chars`);
  console.log(
    `       json-ld    : ${r.jsonLd.count} block(s) · @types: [${r.jsonLd.types.join(', ')}]`,
  );
  if (r.missing.length) {
    anyFail = true;
    console.log(`       missing    : ${r.missing.join(', ')}`);
  }
  if (r.warnings.length) {
    totalWarn += r.warnings.length;
    for (const w of r.warnings) console.log(`       warn       : ${w}`);
  }
  console.log('');
}

const passed = results.filter((r) => r.pass).length;
console.log(
  `── summary: ${passed}/${results.length} pages PASS · ${totalWarn} warning(s)`,
);

process.exit(anyFail ? 1 : 0);
