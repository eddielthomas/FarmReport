#!/usr/bin/env node
// scripts/make-og.mjs
// -----------------------------------------------------------------------------
// Rasterise every public/og/*.svg into a matching public/og/*.png at 1200x630
// for use as <meta property="og:image"> / Twitter card image.
//
// USAGE:
//   npm i -D sharp        # one-time, see TODO below
//   node scripts/make-og.mjs
//
// TODO(foundation-wave): `sharp` is NOT currently in package.json. The
// foundation agent intentionally did not install it. Run `npm i -D sharp`
// before invoking this script. Until then the .svg files in public/og/ serve
// as the OG image source (most modern crawlers + Facebook accept SVG; Twitter
// historically wants PNG/JPG — hence the conversion).
// -----------------------------------------------------------------------------

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OG_DIR    = join(__dirname, '..', 'public', 'og');

async function main() {
  let sharp;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch {
    console.error('[make-og] sharp is not installed. Run: npm i -D sharp');
    process.exit(1);
  }

  const entries = await readdir(OG_DIR);
  const svgs    = entries.filter((f) => extname(f).toLowerCase() === '.svg');

  if (svgs.length === 0) {
    console.error(`[make-og] no .svg files found in ${OG_DIR}`);
    process.exit(1);
  }

  for (const svg of svgs) {
    const inPath  = join(OG_DIR, svg);
    const outPath = join(OG_DIR, `${basename(svg, '.svg')}.png`);
    const buf     = await readFile(inPath);
    await sharp(buf, { density: 144 })
      .resize(1200, 630, { fit: 'cover' })
      .png({ compressionLevel: 9 })
      .toFile(outPath);
    console.log(`[make-og] wrote ${outPath}`);
  }
}

main().catch((err) => {
  console.error('[make-og] failed:', err);
  process.exit(1);
});
