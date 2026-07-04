# Report.Farm — Brand Assets

Generated with `nano-banana-2` (Gemini image), placed in
`app/public/brand/`. These are **concept** assets — production should redraw the
logo as SVG for crispness/theming (see below). Prompts are recorded so they can
be re-run or handed to a designer.

## Files produced (`app/public/brand/`)

| File | What | Dims | Notes |
|---|---|---|---|
| `logo-concept.png` | Wordmark "Report.Farm" + satellite field-grid mark | 2752×1536 | On warm-white; one cobalt cell in a curved grid. Redraw as SVG for prod. |
| `og-home.png` | Home OG / social hero | 1200×630 | Resized from the 2K master; use for `og:image`. |
| `og-home@2x.jpg` | Full-res hero master | 2752×1536 | Source for hero sections / retina crops. |

## The mark

A square parcel viewed from directly overhead, subdivided into a clean grid of
field cells and **gently curved to imply the earth's surface** (satellite +
cartography in one shape), with a **single cell filled cobalt-indigo**
(`#2B5FE3`) — "one field under watch." It's geometric, engineered, and reads at
favicon size. It deliberately avoids wheat/barn/tractor/leaf cliché.

**Production notes for wave-2:**
- Rebuild as **SVG** (two-color: `--fg` outline + `--accent` cell) so it themes
  with light/dark and stays crisp. The raster is the visual target.
- Favicon: the mark alone (drop the wordmark) — the single cobalt cell stays
  legible at 16px.
- Clear space = height of one grid cell on all sides. Don't recolor the wordmark;
  don't stretch.

## The hero / OG image

Top-down satellite farmland (rectangular + center-pivot circular fields) in
muted natural greens/tans, rendered dark and cinematic, overlaid with a cobalt
vector grid, a supply-chain node network, and a small green→amber→red **risk
heatmap** patch, with a frosted HUD panel. This *is* the product's aesthetic in
one frame — use it for the marketing home hero and `og:image`.

## Regeneration prompts

**Logo** (`nano-banana-2`, 16:9, 2K, thinking high):
> Minimal premium app logo mark plus wordmark for a SaaS brand named
> "Report.Farm". Layout: a compact geometric icon on the left, the wordmark
> "Report.Farm" to its right in a clean geometric grotesk sans-serif, near-black
> (#171512) on warm off-white (#FBFAF7), tight tracking. The icon fuses a
> satellite and a field-grid: a square tile viewed from directly overhead,
> subdivided into a neat 3×3 grid of farm-field cells, gently curved to imply
> the earth's surface, one single cell filled cobalt-indigo (#2B5FE3), the rest
> thin near-black outlines. Engineered, cartographic, mission-control precision.
> No wheat, no barn, no leaf, no tractor, no gradient, flat vector, crisp,
> generous whitespace.

**Hero / OG** (`nano-banana-2`, 16:9, 2K, thinking high; then resize to 1200×630):
> Premium hero for a farm supply-chain satellite intelligence platform. Top-down
> satellite view of a large agricultural region: patchwork of rectangular and
> center-pivot circular fields in muted natural greens, tans and soil browns,
> dark and cinematic. Overlaid with a translucent data layer: a thin
> cobalt-indigo (#2B5FE3) vector grid, glowing node markers connected by fine
> lines (a supply-chain network), and one small green→amber→red risk heatmap
> patch over a cluster of fields. Subtle frosted-glass HUD panel with abstract
> KPI bars (no readable text). Mission-control, trustworthy, enterprise. Dark
> warm-black vignette. No logos, no readable text, no people.

## Asset backlog (not yet generated)
- SVG logo (light + dark lockups, mark-only, favicon set).
- App icon / PWA maskable.
- Empty-state / onboarding spot illustrations in the same satellite-data idiom.
- A dark-canvas variant of the hero for in-app splash.
