# Report.Farm — Hero Screens

> Four hero surfaces for the supply-chain wedge (`06_DECISIONS.md` D2). Each has:
> a Stitch reference render (in `docs/design/screens/`), a layout description, a
> component inventory mapped to the existing `app/src/crm/components/ui/` shell,
> responsive behavior, and light/dark notes. Stitch project:
> `3399293126047520138` (design system `assets/5180641574883135763`).
> Renders are **direction**, not pixel spec — the tokens + component map are the
> contract. All four use the app shell (left icon rail + top bar) except the
> Executive Report, which is a standalone document.

| # | Screen | Render | Stitch screen id |
|---|---|---|---|
| A | Buyer Portfolio Dashboard | `screens/01-buyer-portfolio-dashboard.png` | `e800f6f5406842788c845bcf516aeea5` |
| B | Supplier / Farm Detail | `screens/02-supplier-farm-detail.png` | `09d28c6bccd14813969c7f1158066e16` |
| C | Onboarding Map Copilot | `screens/03-onboarding-map-copilot.png` | `fc38f00ea2234b638c8b29cac63b054d` |
| D | Executive Report | `screens/04-executive-report.png` | `5864fc46b23849b0845465a2a3d119f2` |

---

## A. Buyer Portfolio Dashboard

**Job:** a buyer's home base — "where in my portfolio of suppliers is risk
concentrating right now, and what's the money at stake?" This is the wedge's
center of gravity.

### Layout (desktop 1440+)
- **Left icon rail** (persistent app nav) + **top bar**: Report.Farm mark,
  tenant switcher ("Global Foods Co."), global search, surface toggle, avatar.
- **KPI row** — four frosted stat tiles across the top: *Suppliers Monitored
  248* (+12), *Portfolio Risk Score 62/100* (−4), *Yield at Risk 14.2%* (▲2.1),
  *Revenue at Risk $2.4M*. Each: big Geist number, tabular, delta chip, cobalt
  sparkline.
- **Portfolio risk map** (~⅔ width, left): dark satellite map of the sourcing
  region; supplier farm boundaries shaded by the **semantic risk ramp**;
  clustered risk markers; a floating frosted **RiskLegend** (labeled). Selecting
  a supplier flies to it (spring) and cross-highlights the table row.
- **Right column** (~⅓): **Disruption Alerts** feed (stacked cards, severity
  pill + one-line cause, e.g. "38% of Rio Verde region sourcing at yield risk"),
  then below the fold a sortable **Suppliers at Risk** table (Supplier · Region ·
  Risk pill · Yield Δ · Last Signal).

### Component inventory
`KpiCard` + `KpiStrip` (KPI row) · MapLibre/deck.gl (risk map, boundary +
choropleth layers) · new `RiskLegend`, `DisruptionAlertCard`,
`SupplierRiskTable`, `RiskPill` · `Badge` risk variants · `pill-tabs` (map
period) · `status-dots` (data freshness).

### Responsive
- **1024:** KPI row 4→2×2; right column drops below the map; map full-width.
- **768:** KPI 2×2 stays; map ~55vh; alerts + table stack; table horizontal-
  scrolls inside its own container (never the page).
- **480:** KPI single-column scroll strip; map ~45vh with floating legend
  collapsed to a chip; alerts as a bottom-sheet.

### Light/dark
Dark is default (imagery pops). Light mode keeps the map canvas dark (glass
panels read over imagery in both), while KPI tiles/tables switch to the warm-
white surfaces.

---

## B. Supplier / Farm Detail

**Job:** drill into one farm — see the fields, the vegetation/moisture layers,
and the timeline of what changed and why.

### Layout (desktop 1440+)
- Top bar breadcrumb: *Portfolio / Rio Verde / North Valley Farms*; three KPI
  chips (*Farm Health 78/100 · Active Signals 3 · Yield Δ −2.4%*).
- **Left "Zones" panel:** rows for West Pivot Field, Barn Complex, South Pond,
  Trial Plot A — each an intent chip ("Expected irrigation") + a labeled risk
  pill.
- **Center field map:** dark satellite view of the one farm; field boundary
  polygons; **NDVI raster overlay** (brown→green scientific colormap) with a
  floating frosted **Map Layers** control (NDVI · Moisture · Thermal ·
  Boundaries toggles) and an NDVI legend.
- **Right "Signal Timeline" panel:** a 90-day **NDVI sparkline** with a baseline
  band at top, then a vertical feed of change-event cards (NDVI drop, Thermal
  anomaly, Pond level decline) — date, icon, severity pill, one-line
  explanation.

### Component inventory
MapLibre/deck.gl (raster + vector layers, layer toggle) · new `ZoneIntentRow`,
`SignalTimeline`, `NdviSparkline`, `MapLayerControl` · `GlassPanel` (over-map
controls) · `Badge` risk variants · KPI chips (compact `KpiCard`).

### Responsive
- **1024:** Zones collapses to a top strip of chips; map + timeline share width.
- **768:** map hero ~55vh; Zones and Timeline become bottom-sheets reachable
  from a segmented control; layer control stays floating on the map.
- **480:** single-column; map first; sparkline + timeline below; zones behind a
  "Zones" sheet.

### Light/dark
Map canvas always dark. NDVI/moisture legends are the one place the vegetation
colormap appears — kept distinct from UI risk colors.

---

## C. Onboarding Map Copilot

**Job:** get a farm (or many, for a buyer) into the system — draw/import a
boundary, accept AI-detected zones, set each zone's monitoring intent, then bulk-
import a whole supplier network.

### Layout (desktop 1440+)
- **Full-bleed dark satellite map** hero: the farm boundary drawn in cobalt;
  faded neighbor parcels; AI-suggested features (fields, barn, pond, pivot)
  outlined.
- **Floating map toolbar** (frosted): Draw boundary · Import (KML/Shapefile/CSV)
  · Split · Merge · Draw zone.
- **Left step rail:** 1 Define farm (active) · 2 Confirm zones · 3 Set intents ·
  4 Bulk import suppliers.
- **Right Copilot panel** (frosted): conversational message ("I detected a barn,
  a pond, 6 crop fields, and 2 irrigation zones. Create monitoring zones?") with
  Accept / Adjust; then the **Zone Intent Editor** — each zone with editable
  intents (expected irrigation, standing water, monitor level, alert
  sensitivity); at the bottom a **Bulk supplier import** dropzone
  (shapefile/KML/CSV → many boundaries) with a preview count.

### Component inventory
MapLibre/deck.gl + draw tools (the shell's `shpjs`/`@tmcw/togeojson` for import)
· `ai-assistant-rail` (Copilot) · `GlassPanel` (toolbar/panel) · new
`ZoneIntentRow` (editable), `BoundaryImportDropzone`, `OnboardingStepRail` ·
`Input`/`Button`/toggle/select primitives.

### Responsive
- **1024:** step rail → horizontal stepper on top; Copilot panel narrows.
- **768:** map hero; Copilot + intent editor as a tall bottom-sheet; toolbar
  wraps to two rows; drawing still on the map.
- **480:** wizard mode — one step per screen, map + a single sheet; bulk import
  is its own step.

### Light/dark
Default dark for the map-first flow; the Copilot panel is dark-glass over
imagery. Bulk-import confirmation screens (tables of imported farms) use normal
surfaces.

---

## D. Executive Report

**Job:** the print-grade artifact a buyer forwards to their leadership — the
monthly (or alert-triggered) summary of portfolio health, what changed, actions,
and evidence.

### Layout (document, not app)
- **Light-mode**, warm off-white, A4-width centered container, generous margins.
  No app rail — this is a document.
- **Header:** Report.Farm logo · "Monthly Executive Report" · "Global Foods Co.
  — Rio Verde Sourcing Region" · period.
- **KPI summary band:** Portfolio Health · Active Alerts · Yield Δ · Revenue at
  Risk.
- **"What changed"** (3 insight bullets) · **"Top actions"** (numbered).
- **Evidence row:** three chart cards — NDVI trend line (baseline band), regional
  risk heatmap, portfolio risk **treemap** (suppliers colored by risk ramp,
  direct-labeled).
- **Supplier risk table.**
- **Footer:** confidence note ("high — one cloudy revisit excluded") + page number.

### Component inventory
Report layout is its own print stylesheet (not the app shell) · reuses
`NdviSparkline`/line, `PortfolioTreemap`, heatmap, `SupplierRiskTable`, `RiskPill`
· KPI band via compact `KpiCard`. Rendered server-side or via print CSS from the
same React components.

### Responsive / print
- **Screen preview** scales the A4 container to viewport with a max-width.
- **Print/PDF:** `@media print` — fixed A4, chrome off, charts at print-safe
  contrast (light surfaces, ink-safe risk fills with labels), page breaks
  between sections, no background-color loss (print `color-adjust: exact` on
  risk fills so the ramp survives).
- **Mobile:** single column; evidence charts stack; table scrolls in-container.

### Light/dark
**Always light** — it's a document. This is the one surface that never inverts;
it validates the light palette as a first-class peer.

---

## Cross-screen consistency checklist
- Risk color always with a **label/icon** (every pill, legend, cell).
- Every data number is **tabular**; every table is **sortable** with `aria-sort`.
- Map glass panels read on the dark canvas in **both** surface modes.
- One primary CTA (cobalt) per view; secondary actions are ghost/subtle.
- Empty / loading (skeleton) / error states specified for every data region.
- Keyboard: focus rings visible (brand ring), map controls reachable, tooltips
  keyboard-accessible, charts have table fallbacks.
