// =============================================================================
// loader.mjs — SolutionPack loader (Sprint A1).
// -----------------------------------------------------------------------------
// loadVertical(id) -> validated, frozen SolutionPack object.
//   * Reads packages/config/verticals/<id>.yaml (or <id>.example.yaml).
//   * Parses a constrained YAML SUBSET (zero deps — see parseYaml below).
//   * Validates against solution-pack.schema.json (zero-dep validator that
//     implements exactly the draft-2020-12 keywords this schema uses).
//   * Merges the pack roles with the platform-base roles.
//   * Caches by id. Defaults to 'rwr'. listVerticals() enumerates packs.
//
// PURE CONFIG — no DB, no network, no infra. Consumed by the mvp http API
// (.mjs) and the A1 QA script. Behaviour-preserving: the RWR pack reproduces
// the hardcoded values byte-for-byte, so RWR runs identically.
//
// Design choice (documented in ADR-0023): loadVertical of an UNKNOWN id is a
// soft fallback to the default pack ('rwr') WITH a console.warn, never a throw,
// so a typo'd env var degrades to RWR rather than crashing the platform. A
// pack that EXISTS but is INVALID throws — that is a programming/config error
// the author must fix.
// =============================================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const VERTICALS_DIR = HERE;
export const DEFAULT_VERTICAL_ID = 'rwr';

// Platform-base roles every vertical inherits. KNOWN_ROLES = base ∪ pack.roles.
// These are the original flat KNOWN_ROLES + the S9.1 ops/field hierarchy so the
// merged superset always contains today's set regardless of the active pack.
export const PLATFORM_BASE_ROLES = Object.freeze([
  'platform:admin',
  'sales:manage',
  'ops:manage',
  'analytics:view',
  'dashboard:view',
  'customer:view',
  'vendor:view',
  'vendor:manage',
  'vendor:billing',
]);

const _cache = new Map();

// -----------------------------------------------------------------------------
// Minimal YAML subset parser. Supports exactly what the packs use:
//   * 2-space-indented nested maps
//   * block sequences:  "- item" / "- key: val"
//   * inline flow maps:  "{ k: v, k2: [a, b] }"
//   * inline flow seqs:  "[a, b, c]"
//   * scalars: quoted ("x"/'x'), numbers, true/false/null, bare strings
//   * '#' line comments (outside quotes)
// Intentionally NOT a general YAML engine — packs are repo-controlled config.
// -----------------------------------------------------------------------------
function stripComment(line) {
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD) {
      // a '#' only starts a comment when preceded by start-of-line or a space
      if (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t') return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw) {
  const s = String(raw).trim();
  if (s === '' ) return null;
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s) || /^-?\d+\.\d*$/.test(s)) return parseFloat(s);
  return s;
}

// Split a flow body "a, b: c, [x, y]" on top-level commas (respecting quotes,
// [], {}).
function splitTop(body) {
  const out = [];
  let depth = 0, inS = false, inD = false, cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    if (!inS && !inD) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function parseFlow(value) {
  const s = value.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTop(inner).map((e) => parseFlow(e));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (inner === '') return obj;
    for (const pair of splitTop(inner)) {
      const idx = splitKeyIdx(pair);
      if (idx < 0) continue;
      const k = unquoteKey(pair.slice(0, idx).trim());
      obj[k] = parseFlow(pair.slice(idx + 1));
    }
    return obj;
  }
  return parseScalar(s);
}

// Index of the ':' that separates a map key from its value (respecting quotes).
function splitKeyIdx(line) {
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === ':' && !inS && !inD) {
      const next = line[i + 1];
      if (next === undefined || next === ' ' || next === '\t') return i;
    }
  }
  return -1;
}

function unquoteKey(k) {
  const s = k.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function indentOf(line) {
  let n = 0;
  while (line[n] === ' ') n++;
  return n;
}

// Recursive-descent over a list of {indent, text} lines starting at `start`,
// parsing the block whose indent === `indent`. Returns [value, nextIndex].
function parseBlock(lines, start, indent) {
  // Determine if this block is a sequence or a map by its first line.
  let i = start;
  // skip blanks
  while (i < lines.length && lines[i].text.trim() === '') i++;
  if (i >= lines.length || lines[i].indent < indent) return [null, i];

  const isSeq = lines[i].text.trim().startsWith('- ') || lines[i].text.trim() === '-';

  if (isSeq) {
    const arr = [];
    while (i < lines.length) {
      if (lines[i].text.trim() === '') { i++; continue; }
      if (lines[i].indent < indent) break;
      if (lines[i].indent > indent) break; // belongs to a nested parse
      const t = lines[i].text.trim();
      if (!t.startsWith('-')) break;
      const rest = t.slice(1).trim(); // after the dash
      if (rest === '') {
        // nested block item
        const [val, ni] = parseBlock(lines, i + 1, indent + 2);
        arr.push(val);
        i = ni;
      } else if (rest.startsWith('{') || rest.startsWith('[')) {
        arr.push(parseFlow(rest));
        i++;
      } else {
        const idx = splitKeyIdx(rest);
        if (idx >= 0) {
          // "- key: val" → first line of an inline map; subsequent deeper lines
          // (indent = dash-indent + 2) extend the same map.
          const itemIndent = lines[i].indent + 2;
          const k = unquoteKey(rest.slice(0, idx));
          const vraw = rest.slice(idx + 1).trim();
          const obj = {};
          if (vraw === '') {
            const [val, ni] = parseBlock(lines, i + 1, itemIndent);
            obj[k] = val; i = ni;
          } else if (vraw.startsWith('{') || vraw.startsWith('[')) {
            obj[k] = parseFlow(vraw); i++;
          } else {
            obj[k] = parseScalar(vraw); i++;
          }
          // consume continuation lines at itemIndent that are map keys
          while (i < lines.length && lines[i].indent === itemIndent &&
                 lines[i].text.trim() !== '' && !lines[i].text.trim().startsWith('-')) {
            const ln = lines[i].text.trim();
            const ci = splitKeyIdx(ln);
            if (ci < 0) break;
            const ck = unquoteKey(ln.slice(0, ci));
            const cv = ln.slice(ci + 1).trim();
            if (cv === '') {
              const [val, ni] = parseBlock(lines, i + 1, itemIndent + 2);
              obj[ck] = val; i = ni;
            } else if (cv.startsWith('{') || cv.startsWith('[')) {
              obj[ck] = parseFlow(cv); i++;
            } else {
              obj[ck] = parseScalar(cv); i++;
            }
          }
          arr.push(obj);
        } else {
          arr.push(parseScalar(rest));
          i++;
        }
      }
    }
    return [arr, i];
  }

  // map
  const obj = {};
  while (i < lines.length) {
    if (lines[i].text.trim() === '') { i++; continue; }
    if (lines[i].indent < indent) break;
    if (lines[i].indent > indent) break;
    const t = lines[i].text.trim();
    if (t.startsWith('- ')) break;
    const idx = splitKeyIdx(t);
    if (idx < 0) { i++; continue; }
    const k = unquoteKey(t.slice(0, idx));
    const vraw = t.slice(idx + 1).trim();
    if (vraw === '') {
      const [val, ni] = parseBlock(lines, i + 1, indent + 2);
      obj[k] = val; i = ni;
    } else if (vraw.startsWith('{') || vraw.startsWith('[')) {
      obj[k] = parseFlow(vraw); i++;
    } else {
      obj[k] = parseScalar(vraw); i++;
    }
  }
  return [obj, i];
}

export function parseYaml(text) {
  const raw = String(text).replace(/\r\n/g, '\n').split('\n');
  const lines = [];
  for (const ln of raw) {
    const noComment = stripComment(ln);
    if (noComment.trim() === '') continue;
    if (noComment.trim() === '---') continue;
    lines.push({ indent: indentOf(noComment), text: noComment });
  }
  const [val] = parseBlock(lines, 0, 0);
  return val ?? {};
}

// -----------------------------------------------------------------------------
// Minimal JSON-Schema (draft 2020-12 subset) validator. Implements only the
// keywords this schema uses: type, required, properties, additionalProperties,
// items, $ref (#/$defs/*), enum, pattern, minLength, minItems, minimum,
// maximum. Returns an array of error strings ([] === valid).
// -----------------------------------------------------------------------------
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v === 'number' ? 'number' : typeof v;
}

function matchesType(v, t) {
  if (Array.isArray(t)) return t.some((x) => matchesType(v, x));
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  if (t === 'integer') return actual === 'integer';
  return actual === t;
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  let node = root;
  for (const seg of ref.slice(2).split('/')) {
    node = node[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error(`bad $ref ${ref}`);
  }
  return node;
}

function validateNode(value, schema, root, path, errors) {
  if (schema.$ref) {
    return validateNode(value, resolveRef(root, schema.$ref), root, path, errors);
  }
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path || '<root>'}: expected type ${JSON.stringify(schema.type)}, got ${typeOf(value)}`);
    return; // type mismatch — downstream checks would be noise
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  const t = typeOf(value);
  if (t === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: "${value}" does not match pattern ${schema.pattern}`);
    }
  }
  if (t === 'number' || t === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: > maximum ${schema.maximum}`);
  }
  if (t === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.items) {
      value.forEach((el, i) => validateNode(el, schema.items, root, `${path}[${i}]`, errors));
    }
  }
  if (t === 'object') {
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${path || '<root>'}: missing required property "${req}"`);
    }
    const props = schema.properties || {};
    const ap = schema.additionalProperties;
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (props[k]) {
        validateNode(v, props[k], root, p, errors);
      } else if (ap === false) {
        errors.push(`${p}: additional property not allowed`);
      } else if (ap && typeof ap === 'object') {
        validateNode(v, ap, root, p, errors);
      }
    }
  }
}

export function validatePack(pack, schema) {
  const errors = [];
  validateNode(pack, schema, schema, '', errors);
  // Cross-field: defaultBasemap must be one of basemaps[].id
  if (Array.isArray(pack.basemaps) && pack.defaultBasemap) {
    const ids = pack.basemaps.map((b) => b && b.id);
    if (!ids.includes(pack.defaultBasemap)) {
      errors.push(`defaultBasemap "${pack.defaultBasemap}" is not present in basemaps[]`);
    }
  }
  return errors;
}

let _schemaCache = null;
function loadSchema() {
  if (_schemaCache) return _schemaCache;
  const p = join(VERTICALS_DIR, 'solution-pack.schema.json');
  _schemaCache = JSON.parse(readFileSync(p, 'utf8'));
  return _schemaCache;
}

function packPath(id) {
  const plain = join(VERTICALS_DIR, `${id}.yaml`);
  if (existsSync(plain)) return plain;
  const example = join(VERTICALS_DIR, `${id}.example.yaml`);
  if (existsSync(example)) return example;
  return null;
}

// Public API ------------------------------------------------------------------

/** Enumerate available pack ids (strips .yaml / .example.yaml). */
export function listVerticals() {
  return readdirSync(VERTICALS_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.example\.yaml$/, '').replace(/\.yaml$/, ''))
    .filter((id, i, a) => a.indexOf(id) === i)
    .sort();
}

/**
 * Load + validate a SolutionPack by id. Unknown id -> warn + fall back to the
 * default pack. Existing-but-invalid pack -> throw. Result is frozen + cached.
 */
export function loadVertical(id = DEFAULT_VERTICAL_ID) {
  const wanted = String(id || DEFAULT_VERTICAL_ID).trim().toLowerCase() || DEFAULT_VERTICAL_ID;
  if (_cache.has(wanted)) return _cache.get(wanted);

  let resolvedId = wanted;
  let path = packPath(wanted);
  if (!path) {
    if (wanted !== DEFAULT_VERTICAL_ID) {
      console.warn(`[solution-pack] vertical "${wanted}" not found — falling back to "${DEFAULT_VERTICAL_ID}"`);
    }
    resolvedId = DEFAULT_VERTICAL_ID;
    if (_cache.has(resolvedId)) {
      const cached = _cache.get(resolvedId);
      _cache.set(wanted, cached);
      return cached;
    }
    path = packPath(DEFAULT_VERTICAL_ID);
    if (!path) throw new Error(`default vertical pack "${DEFAULT_VERTICAL_ID}" missing`);
  }

  const pack = parseYaml(readFileSync(path, 'utf8'));
  const errors = validatePack(pack, loadSchema());
  if (errors.length) {
    throw new Error(`SolutionPack "${resolvedId}" failed schema validation:\n  - ${errors.join('\n  - ')}`);
  }

  // Merge roles: platform base ∪ pack.roles[].key → KNOWN_ROLES superset.
  const packRoleKeys = (pack.roles || []).map((r) => r.key);
  const knownRoles = Array.from(new Set([...PLATFORM_BASE_ROLES, ...packRoleKeys]));

  const resolved = Object.freeze({
    ...pack,
    id: resolvedId,
    knownRoles: Object.freeze(knownRoles),
    platformBaseRoles: PLATFORM_BASE_ROLES,
  });

  _cache.set(resolvedId, resolved);
  _cache.set(wanted, resolved);
  return resolved;
}

/** Clear the cache (tests). */
export function _resetCache() { _cache.clear(); _schemaCache = null; }
