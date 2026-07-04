# Report.Farm — Wave-2 Implementation Plan

> Ordered punch list to apply this design language to the cloned RWR shell.
> **Wave-1 (this lane) produced no app code.** Everything here is wave-2, to run
> *after* the `app/` clone lands (`01_CLONE_PLAN`). Guardrail respected: nothing
> under `app/src` was touched in wave-1.
>
> Machine is memory-constrained — **do not** run docker/Vite casually; the one
> place Vite is genuinely needed to verify is flagged per step.

## 0. Prerequisite
The `app/` directory must contain the cloned RWR CRM (`src/crm/**`,
`styles/tailwind.css`, `theme/tokens.css`, `components/ui/*`). Confirm the token
files from §2.1 in `DESIGN_SYSTEM.md` exist before starting.

## Step 1 — Land the tokens (highest leverage, lowest risk)
**Files:** `app/src/crm/theme/tokens.css`, `app/src/dashboard-tokens.css`
- Replace the body of `theme/tokens.css` with `docs/design/tokens.css` (same
  variable names, new values + new `--risk-*`, `--viz-*`, `--seq-*`,
  `--font-display`, `--easing-spring`). Because names are identical, every
  existing component re-skins with **zero component edits**.
- Mirror the light/dark **canvas + accent** blocks into `dashboard-tokens.css`
  (it keeps a parallel `:root[data-surface]` copy — see its header comment).
- **Verify:** grep that no component hardcodes the old lime `#B9FF66` /
  black-on-lime `--fg-on-accent`; our accent is cobalt with **white** on-accent.

## Step 2 — Expose new tokens to Tailwind
**File:** `app/src/crm/styles/tailwind.css` (`@theme` block)
- Add `--color-risk-healthy … --color-risk-critical` (+ `-fill`),
  `--color-viz-1…8`, `--color-seq-*`, `--color-cyan` already present, and map
  `--font-display` so `font-display`, `bg-risk-stress`, `text-risk-critical`,
  `bg-viz-3` utilities emit.
- Add `--ease-spring: var(--easing-spring)` for `ease-spring`.
- **Verify (Vite needed, brief):** one `npm run build` of the CRM entry to
  confirm the `@theme` additions compile and utilities resolve. Single build,
  then stop the process.

## Step 3 — Fonts
**Files:** `app/index.html` / CRM entry, `public/fonts/`
- Self-host **Geist** (display), keep **Inter** (body) and **JetBrains Mono**
  (data); `font-display: swap`; preload only the two critical weights (Geist 600,
  Inter 400). Urbanist stays as fallback so nothing breaks mid-migration.
- Apply `font-variant-numeric: tabular-nums` to table cells, KPI values, axis
  ticks (a `.tabular`/`--numeric-tabular` utility).

## Step 4 — Badge → risk pills (smallest component change, unblocks everything)
**File:** `app/src/crm/components/ui/badge.tsx`
- Add five cva variants `risk-healthy | risk-watch | risk-stress | risk-high |
  risk-critical` (bordered + soft-fill, text = `--risk-*`), and extend
  `statusVariant()` to map risk strings. Ship each with an icon slot so a risk
  color is never color-alone. Export a thin `RiskPill` wrapper.

## Step 5 — New farm components (composed from primitives + tokens)
**New dir:** `app/src/crm/components/farm/`
Build in this order (each reuses shell primitives, no new deps):
1. `RiskLegend`, `RiskPill` (from Step 4) — needed by every screen.
2. `SupplierRiskTable` (sortable, `aria-sort`, tabular, risk-pill cells).
3. `DisruptionAlertCard` + feed.
4. `SignalTimeline` + `NdviSparkline` (line + baseline band; table fallback).
5. `ZoneIntentRow` (editable intents), `MapLayerControl` (over `GlassPanel`).
6. `PortfolioTreemap` (sized by exposure, risk-ramp fill, direct labels).
7. `OnboardingStepRail`, `BoundaryImportDropzone` (wire `shpjs`/`togeojson`).

## Step 6 — Screen assembly (per `SCREENS.md`, dashboard order)
Build A → B → C → D. Each lands the layout, wires the `/api/farm/*` data, and
uses only Step-5 components + the shell.
1. **A. Buyer Portfolio Dashboard** — KPI row + risk map + alerts + table.
2. **B. Supplier/Farm Detail** — field map + NDVI/moisture layers + timeline.
3. **C. Onboarding Map Copilot** — draw/import + zone-intent + bulk import.
4. **D. Executive Report** — print CSS from the same components; `@media print`.

## Step 7 — Map layers (deck.gl/MapLibre)
**Files:** `app/src/engines/*` (or the cloned map module)
- Boundary vector layer (cobalt select/hover), risk **choropleth** (semantic
  ramp fill), **NDVI raster** (brown→green colormap — imagery only, not chrome),
  moisture/thermal toggles, cluster markers. Camera fly-to on `--easing-spring`.
- Keep over-map glass panels on the dark-canvas glass formula in both surfaces.

## Step 8 — Brand assets
- Drop `app/public/brand/*` (already produced) into the shell; set `og:image` to
  `/brand/og-home.png`. Redraw the logo as **SVG** (light/dark + favicon) per
  `BRAND.md` before public launch.

## Step 9 — Accessibility & viz verification pass
- Re-run `validate_palette.js` if any color changed; confirm AA on new text
  pairs; every risk/status color icon+label paired; charts have table fallbacks,
  legends, empty/loading/error states; `prefers-reduced-motion` honored.
- **Verify (Vite needed):** load each of the four screens in light **and** dark,
  check contrast + reflow at 1440/1024/768/480, then stop Vite.

---

## Top 5 wave-2 steps (start here)
1. **Land `tokens.css`** into `theme/tokens.css` + mirror canvas into
   `dashboard-tokens.css` — re-skins the whole shell with zero component edits.
2. **Wire the `@theme` block** so `risk-*`/`viz-*`/`font-display` utilities emit
   (one Vite build to verify).
3. **Add `risk-*` variants to `Badge`** + `RiskPill`/`RiskLegend` — the atoms
   every farm screen needs.
4. **Build `SupplierRiskTable` + `DisruptionAlertCard` + KPI row**, then assemble
   **Screen A (Buyer Portfolio Dashboard)** against `/api/farm/*`.
5. **Self-host Geist + tabular-nums**, then verify Screen A in light+dark and at
   all four breakpoints.
