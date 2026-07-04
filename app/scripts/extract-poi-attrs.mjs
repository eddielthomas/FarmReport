#!/usr/bin/env node
// =============================================================================
// extract-poi-attrs.mjs — one-shot KMZ → JSON adapter
// -----------------------------------------------------------------------------
// Reads `harvest/eo-discover/sub-projects/676251/binaries/sharepoint/
// Demoville_A_KML_Apr26_DataRelease2.kmz`, unzips the embedded `doc.kml`
// (PKZIP/store + deflate), walks every <Placemark>'s description-table
// HTML and extracts the per-POI attributes that aren't otherwise harvested:
//
//   - Utilis_ID    (string)   — join key against pois.json#poiNumber
//   - INSIDE_X/Y   (number)   — snap-to-pipe inspection point (lon/lat)
//   - ERA_SCORE    (number)   — risk score
//   - PIPE_LENGT   (number)   — pipe length (m) inside the AOI polygon
//   - Address      (string)   — street address of the inspection point
//
// Output is written to `mvp/src/data/harvest/poi-attrs.json` keyed by
// Utilis_ID. The dashboard's build-ds.js joins this onto each POI detection.
//
// Implementation notes:
//   * No npm deps — uses node:fs, node:path, node:zlib (inflateRaw).
//   * KMZ is a regular zip; we parse the End-Of-Central-Directory record,
//     walk the central-directory headers, and inflate just the entries we
//     need. Stored (method 0) and Deflate (method 8) are supported.
//   * KML description tables in this dataset are HTML <table> with rows
//     `<td>FIELD</td><td>VALUE</td>`; a tiny regex pull is sufficient.
// =============================================================================

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { inflateRawSync }             from 'node:zlib';
import { fileURLToPath }              from 'node:url';
import path                           from 'node:path';

const HERE       = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(HERE, '..', '..');
const KMZ_PATH   = path.join(
  REPO_ROOT,
  'harvest', 'eo-discover', 'sub-projects', '676251',
  'binaries', 'sharepoint', 'Demoville_A_KML_Apr26_DataRelease2.kmz',
);
const OUT_PATH   = path.join(REPO_ROOT, 'mvp', 'src', 'data', 'harvest', 'poi-attrs.json');

// -----------------------------------------------------------------------------
// Minimal zip reader (PKZIP local + central directory, methods 0 and 8).
// -----------------------------------------------------------------------------
const SIG_EOCD = 0x06054b50;
const SIG_CDH  = 0x02014b50;
const SIG_LFH  = 0x04034b50;

function findEOCD(buf) {
  // EOCD is at most 22 + 0xFFFF bytes from the end; scan back.
  const min = Math.max(0, buf.length - (22 + 0xFFFF));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('zip: EOCD signature not found');
}

function readCentralDir(buf) {
  const eocdOff = findEOCD(buf);
  const total   = buf.readUInt16LE(eocdOff + 10);
  const cdSize  = buf.readUInt32LE(eocdOff + 12);
  const cdOff   = buf.readUInt32LE(eocdOff + 16);
  const entries = [];

  let p = cdOff;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== SIG_CDH) {
      throw new Error(`zip: bad central-dir header at ${p}`);
    }
    const method   = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncSize  = buf.readUInt32LE(p + 24);
    const nameLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen   = buf.readUInt16LE(p + 32);
    const lfhOff   = buf.readUInt32LE(p + 42);
    const name     = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, uncSize, lfhOff });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  if (p - cdOff !== cdSize) {
    // Non-fatal — some zippers pad; we trust `total` to be authoritative.
  }
  return entries;
}

function extractEntry(buf, entry) {
  const lfhOff = entry.lfhOff;
  if (buf.readUInt32LE(lfhOff) !== SIG_LFH) {
    throw new Error(`zip: bad local-file header for ${entry.name}`);
  }
  const nameLen  = buf.readUInt16LE(lfhOff + 26);
  const extraLen = buf.readUInt16LE(lfhOff + 28);
  const dataOff  = lfhOff + 30 + nameLen + extraLen;
  const comp     = buf.slice(dataOff, dataOff + entry.compSize);

  if (entry.method === 0)   return comp;                  // stored
  if (entry.method === 8)   return inflateRawSync(comp);  // deflate
  throw new Error(`zip: unsupported method ${entry.method} for ${entry.name}`);
}

// -----------------------------------------------------------------------------
// KML walker — pull <Placemark> blocks, then per-block scrape the description
// HTML for the attribute keys we care about.
// -----------------------------------------------------------------------------
const KEYS = ['Utilis_ID', 'INSIDE_X', 'INSIDE_Y', 'ERA_SCORE', 'PIPE_LENGT', 'Address'];

const decodeHtmlEntities = (s) =>
  s.replace(/&lt;/g, '<')
   .replace(/&gt;/g, '>')
   .replace(/&amp;/g, '&')
   .replace(/&quot;/g, '"')
   .replace(/&#39;/g, "'")
   .replace(/&nbsp;/g, ' ');

const stripTags = (s) => s.replace(/<[^>]+>/g, '').trim();

/** Pull a value out of either an HTML row `<td>KEY</td><td>VAL</td>` or
 *  an ExtendedData simple-field `<SimpleData name="KEY">VAL</SimpleData>`. */
function pickField(block, key) {
  // 1. ExtendedData / SimpleData (most reliable for SHP-derived KMLs).
  const sd = new RegExp(
    `<SimpleData[^>]*name=["']${key}["'][^>]*>([\\s\\S]*?)</SimpleData>`, 'i',
  ).exec(block);
  if (sd) return stripTags(decodeHtmlEntities(sd[1]));

  // 2. ExtendedData/Data tag form: <Data name="KEY"><value>VAL</value></Data>
  const dt = new RegExp(
    `<Data[^>]*name=["']${key}["'][^>]*>[\\s\\S]*?<value>([\\s\\S]*?)</value>[\\s\\S]*?</Data>`, 'i',
  ).exec(block);
  if (dt) return stripTags(decodeHtmlEntities(dt[1]));

  // 3. Description-table form (HTML inside CDATA).
  const tr = new RegExp(
    `<td[^>]*>\\s*${key}\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'i',
  ).exec(block);
  if (tr) return stripTags(decodeHtmlEntities(tr[1]));

  return null;
}

const num = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function walkPlacemarks(kml) {
  // Greedy split on <Placemark> ... </Placemark>.
  const out = {};
  const re = /<Placemark\b[\s\S]*?<\/Placemark>/g;
  let m, count = 0;
  while ((m = re.exec(kml))) {
    count++;
    const block = m[0];
    const row = {};
    for (const k of KEYS) row[k] = pickField(block, k);
    const id = row.Utilis_ID;
    if (!id) continue;
    out[String(id).trim()] = {
      utilisId:   String(id).trim(),
      insideX:    num(row.INSIDE_X),
      insideY:    num(row.INSIDE_Y),
      eraScore:   num(row.ERA_SCORE),
      pipeLength: num(row.PIPE_LENGT),
      address:    row.Address ? String(row.Address).trim() : null,
    };
  }
  return { byId: out, placemarks: count };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
async function main() {
  const buf = await readFile(KMZ_PATH);
  const entries = readCentralDir(buf);

  // KMZ root is usually `doc.kml`; tolerate other names by picking the first
  // entry whose name ends in `.kml` (case-insensitive).
  const kmlEntry = entries.find((e) => /\.kml$/i.test(e.name));
  if (!kmlEntry) {
    throw new Error(`KMZ contains no .kml entry. Members: ${entries.map((e) => e.name).join(', ')}`);
  }

  const kmlBytes = extractEntry(buf, kmlEntry);
  const kml = kmlBytes.toString('utf8');

  const { byId, placemarks } = walkPlacemarks(kml);
  const ids = Object.keys(byId);

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(byId, null, 2) + '\n', 'utf8');

  // Stdout summary.
  const sample = ids.slice(0, 3).map((k) => `  ${k} -> ${JSON.stringify(byId[k])}`).join('\n');
  process.stdout.write(
    `[extract-poi-attrs] KMZ entry: ${kmlEntry.name} (${kmlBytes.length} B uncompressed)\n` +
    `[extract-poi-attrs] Placemarks scanned: ${placemarks}\n` +
    `[extract-poi-attrs] Unique Utilis_IDs:  ${ids.length}\n` +
    `[extract-poi-attrs] Wrote ${OUT_PATH}\n` +
    (sample ? `[extract-poi-attrs] Sample:\n${sample}\n` : ''),
  );
}

main().catch((err) => {
  process.stderr.write(`[extract-poi-attrs] FAILED: ${err.stack || err.message}\n`);
  process.exit(1);
});
