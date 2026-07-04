#!/usr/bin/env node
// =============================================================================
// audit-mutation-coverage.mjs — CRM Sprint 0 audit-emit coverage gate.
// -----------------------------------------------------------------------------
// Walks mvp/api/v1/**/*.mjs, parses each exported function body, and asserts
// that every function containing a DML statement (INSERT INTO / UPDATE /
// DELETE FROM) also contains a sibling recordAudit() call in the same body.
//
// Exceptions live in mvp/scripts/audit-exceptions.json — keyed by { file,
// function } where `function` may be '*' to whitelist an entire file.
//
// Exit codes:
//   0  — every mutator has a recordAudit() call (or is whitelisted)
//   1  — at least one mutator is missing a recordAudit() call
//
// Style mirrors the sibling audit-tenant-id.mjs (zero deps, pure ESM).
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, '..');
const API_DIR    = resolve(REPO_ROOT, 'api', 'v1');
const EXC_PATH   = resolve(__dirname, 'audit-exceptions.json');

// ANSI helpers (no deps).
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c('32', s);
const red   = (s) => c('31', s);
const dim   = (s) => c('2',  s);
const bold  = (s) => c('1',  s);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st  = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs));
    else if (name.endsWith('.mjs')) out.push(abs);
  }
  return out;
}

// Find every `export ... function name(` (handles `export async function`,
// `export function`). Returns array of { name, startIdx } where startIdx is
// the position of the opening '{' of the function body.
function findExportedFunctions(src) {
  const fns = [];
  const re = /export\s+(?:async\s+)?function\s+([A-Za-z_][\w]*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    // Find the opening '{' AFTER the parameter list. Track paren depth.
    let i = re.lastIndex - 1; // position of '('
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) { i++; break; }
      }
      i++;
    }
    // Skip whitespace
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') continue;
    fns.push({ name, bodyStart: i });
  }
  return fns;
}

// Extract function body starting at bodyStart (position of '{'). Tracks brace
// depth respecting string literals and template literals (no escape handling
// is needed for our codebase pattern).
function extractBody(src, bodyStart) {
  let depth = 0;
  let i = bodyStart;
  let inS = null; // 'sq' | 'dq' | 'tq' | null
  while (i < src.length) {
    const ch = src[i];
    const prev = i > 0 ? src[i - 1] : '';
    if (inS) {
      if (
        (inS === 'sq' && ch === "'"  && prev !== '\\') ||
        (inS === 'dq' && ch === '"'  && prev !== '\\') ||
        (inS === 'tq' && ch === '`'  && prev !== '\\')
      ) inS = null;
    } else {
      if (ch === "'") inS = 'sq';
      else if (ch === '"') inS = 'dq';
      else if (ch === '`') inS = 'tq';
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return src.slice(bodyStart, i + 1); }
    }
    i++;
  }
  return src.slice(bodyStart);
}

const DML_RE      = /\b(INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM)\b/i;
const AUDIT_RE    = /\brecordAudit\s*\(/;

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

function loadExceptions() {
  try {
    const raw = readFileSync(EXC_PATH, 'utf8');
    const j = JSON.parse(raw);
    const map = new Map();
    for (const e of j.exceptions || []) {
      const key = `${(e.file || '').replace(/\\/g, '/')}::${e.function || ''}`;
      map.set(key, e.reason || '');
    }
    return map;
  } catch (err) {
    console.error(red('FAIL'), 'cannot read audit-exceptions.json:', err.message);
    process.exit(2);
  }
}

function isExempt(map, relFile, fnName) {
  const norm = relFile.replace(/\\/g, '/');
  if (map.has(`${norm}::${fnName}`)) return true;
  if (map.has(`${norm}::*`)) return true;
  return false;
}

function main() {
  const exceptions = loadExceptions();
  const files = walk(API_DIR).sort();

  let scanned = 0;
  let mutators = 0;
  let exempted = 0;
  const misses = []; // { file, fn, line }

  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs).replace(/\\/g, '/');
    const src = readFileSync(abs, 'utf8');
    scanned++;

    for (const fn of findExportedFunctions(src)) {
      const body = extractBody(src, fn.bodyStart);
      if (!DML_RE.test(body)) continue;
      mutators++;
      const exempt = isExempt(exceptions, rel, fn.name);
      const hasAudit = AUDIT_RE.test(body);
      if (hasAudit) continue;
      if (exempt) { exempted++; continue; }
      misses.push({ file: rel, fn: fn.name, line: lineOf(src, fn.bodyStart) });
    }
  }

  // Report
  for (const m of misses) {
    console.log(`${red('MISS')} ${m.file}:${m.line} ${bold(m.fn)} — DML without recordAudit()`);
  }
  const ok = misses.length === 0;
  console.log('');
  console.log(`scanned ${scanned} files · ${mutators} mutator functions · ${exempted} exempted · ${misses.length} missing`);
  console.log(bold(ok ? green('audit:coverage PASS') : red('audit:coverage FAIL')));
  process.exit(ok ? 0 : 1);
}

main();
