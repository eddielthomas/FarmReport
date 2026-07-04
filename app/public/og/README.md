# OG Images

This directory holds Open Graph / Twitter card images for the marketing pages.

## Files

| Page                    | Source SVG       | Target PNG        |
| ----------------------- | ---------------- | ----------------- |
| `/` (home)              | `home.svg`       | `home.png`        |
| `/solutions.html`       | `solutions.svg`  | `solutions.png`   |
| `/industries.html`      | `industries.svg` | `industries.png`  |
| `/platform.html`        | `platform.svg`   | `platform.png`    |
| `/company.html`         | `company.svg`    | `company.png`     |
| `/contact.html`         | `contact.svg`    | `contact.png`     |

All sources are 1200x630 SVG (the OG image canonical aspect) with the brand
gradient (cyan -> indigo -> magenta) plus the wordmark and page title.

## Why both SVG and PNG?

- SVG is the editable source of truth and is accepted by most modern crawlers
  and Facebook.
- Twitter (and a handful of legacy scrapers) still prefer PNG/JPG. The
  conversion is generated from the SVG via the `make-og.mjs` script.

## Generating the PNG variants

`sharp` is not installed yet (the foundation agent did not add new
dependencies). To produce the PNGs:

```bash
npm i -D sharp
node scripts/make-og.mjs
```

The script reads every `.svg` in this directory and writes a sibling
`.png` (1200x630, compressed).

## TODO

- [ ] Install `sharp` (`npm i -D sharp`) once the dependency lock review passes.
- [ ] Run `node scripts/make-og.mjs` and commit the generated PNGs.
- [ ] (Optional) Replace the placeholder copy with art-directed hero imagery
      per page once branding has a final iteration of the wordmark.
