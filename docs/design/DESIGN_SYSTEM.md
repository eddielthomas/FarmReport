# Report.Farm — Design System

> **Lane C · wave-1.** The design language for Report.Farm. Companion files:
> `tokens.css` (drop-in CSS variables), `SCREENS.md` (the four hero surfaces),
> `BRAND.md` (logo + imagery), `IMPLEMENTATION_PLAN.md` (wave-2 punch list).
> Grounded on the *actual* cloned shell: RWR CRM, Radix + Tailwind v4,
> `data-surface` light/dark tokens, MapLibre/deck.gl map stack.

---

## 1. Positioning

**Report.Farm is mission-control for the food supply chain.** A buyer (a major
food company, trader, lender, or insurer) watches a *portfolio of supplier
farms* through satellite intelligence, and the product explains what changed,
scores the risk, and estimates the money at stake.

The design expresses four adjectives, in order:

1. **Premium** — it should feel like a Bloomberg terminal or a satellite
   operations console, not an ag-tech starter kit. Restraint, precision,
   density done gracefully.
2. **Data-dense** — analysts live here all day; the layout earns its pixels.
   Information hierarchy, not decoration, creates the calm.
3. **Trustworthy** — money and sourcing decisions ride on this. Legible
   contrast, honest color, confidence indicators, no gratuitous motion.
4. **Satellite-native** — the map/imagery is the substrate. Chrome floats over
   a dark canvas as frosted glass so the imagery always reads.

**Explicitly NOT:** rustic farmhouse, wood textures, hand-drawn wheat, kraft
paper, "earthy" browns as chrome, tractor-green buttons, emoji. Agriculture is
present as *data* (vegetation indices, field grids, sourcing regions), never as
folk decoration.

### The one non-obvious rule that shapes everything

**Green is a data signal, not a brand color.** In a farm product green means
"healthy vegetation." If the UI accent were also green, a green button and a
green field would fight. So the **brand/interactive accent is cobalt-indigo**
(a "satellite instrument" blue), and the entire green→amber→red range is
**reserved as a semantic risk scale**. This is the single decision that makes
the product read as *intelligence* rather than *farming*.

---

## 2. Color system

Two surfaces — **Dark ("Mission Control")** is the product's default posture;
**Light ("Field Ops daylight")** is a first-class peer and the print/report
mode. Both are built on a **warm** neutral (a faint soil undertone) rather than
cold gray — the warm-neutral canvas against the cool cobalt accent is the
premium tension that keeps it from looking like generic fintech.

All values live in `tokens.css` under `.crm[data-surface='…']`. Hexes here are
the canonical source; every one was validated (see §2.6).

### 2.1 Neutrals (UI palette)

| Role | Token | Light | Dark |
|---|---|---|---|
| Page canvas | `--bg` | `#F2F0EB` | `#0B0A08` |
| Elevated band | `--bg-elevated` | `#FBFAF7` | `#141311` |
| Card / surface | `--surface` | `#FFFFFF` | `#1A1815` |
| Overlay / dialog | `--surface-elevated` | `#FFFFFF` | `#221F1B` |
| Inset / track | `--surface-sunken` | `#E9E6DE` | `#100E0C` |
| Primary text | `--fg` | `#171512` (17.5:1) | `#F5F3EE` (16.7:1) |
| Secondary text | `--fg-muted` | `#5C574F` (6.9:1) | `#A8A39A` (7.4:1) |
| Subtle / axis | `--fg-subtle` | `#8A857B` | `#756F65` |

### 2.2 Brand accent — "Orbital" cobalt-indigo

| Role | Token | Light | Dark |
|---|---|---|---|
| Accent (fill/brand) | `--accent` | `#2B5FE3` | `#4C7EFF` |
| Hover / active / link | `--accent-strong` | `#1E49C4` | `#6E97FF` |
| Text ON accent | `--fg-on-accent` | `#FFFFFF` | `#FFFFFF` |
| Secondary "telemetry" | `--cyan` | `#0E9BB5` | `#35C6DC` |

Reserved for: primary buttons, active nav, focus rings, selected map features,
links, the brand mark, live-data pulses. **White text on the accent** (5.46:1),
*not* black — a deliberate departure from RWR's black-on-lime. The `--cyan`
secondary is for "live / streaming / real-time" moments only (SSE scan in
progress, Redis push arriving) — used sparingly.

### 2.3 Semantic risk ramp — the star scale

Vegetation-index-inspired, **ordered low→high risk**. Each stop ships two
variants: a **text/stroke-safe** color (AA on the surface) and a **saturated
fill** for map polygons, chips, and heat cells.

| Level | Token | Light text / fill | Dark |
|---|---|---|---|
| Healthy (low) | `--risk-healthy` | `#0E7A3F` / `#1F9D55` | `#2FBE6B` |
| Watch | `--risk-watch` | `#6E7A16` / `#8DB63C` | `#A9D24A` |
| Stress (elevated) | `--risk-stress` | `#B26A00` / `#F5A623` | `#FFB93E` |
| High | `--risk-high` | `#C25A12` / `#EA7B1B` | `#FF8A3D` |
| Critical | `--risk-critical` | `#C42B22` / `#D6382F` | `#F0524A` |

> **Iron rule: a risk color NEVER carries meaning alone.** It is always paired
> with a text label ("Critical"), an icon, or a position on an axis. This
> satisfies WCAG `color-not-only` *and* colorblind safety — the validator
> confirmed adjacent risk stops (amber↔chartreuse) fall into the CVD "floor"
> band, which is legal **only** with this secondary encoding. Legends,
> risk pills, and table cells all include the word.

The ramp doubles as the product's status palette (success = healthy, warning =
stress, danger = critical), so `--green/--yellow/--orange/--red` in `tokens.css`
point at the same validated values — one honest scale, not two.

### 2.4 Data-viz palettes (per the `dataviz` skill)

**Categorical** (entity identity — supplier, region, crop). Assign in **fixed
order, never cycled**; a 9th series folds into "Other" or small multiples.
Validated worst-adjacent CVD ΔE **24.2** (light) — comfortably clear.

`--viz-1…8` light: `#2B5FE3 #1BAF7A #EDA100 #008300 #4A3AA7 #E34948 #E87BA4 #EB6834`
(dark steps in `tokens.css`, validated as their own set).

**Sequential** (continuous magnitude — risk heatmap, choropleth): single-hue
brand-blue ramp `--seq-100…700`, light→dark = low→high.

**NDVI raster** (the vegetation overlay itself) is the one place a brown→green
map is correct — it's the scientific convention, applied to the *imagery layer*,
never to UI chrome. Low `#7A5230` → mid `#C9B84E` → high `#1F7A34` (continuous;
render in the deck.gl layer, not a token).

**Diverging** (anomaly vs baseline — below/above 5-yr mean): `--viz-diverge-*`,
blue ↔ gray-midpoint ↔ red. Gray midpoint = "nothing"; never a hue at the middle.

**Never** a dual-axis chart. Two measures of different scale → two charts, small
multiples, or index to a common base.

### 2.5 Structural

Hairline borders `--border` (10% ink) with `--border-strong` (20%) for emphasis;
focus `--ring` = brand; modal scrim `--overlay` at 34% (light) / 64% (dark).
Over-map glass panels use `--panel-glass` (a dark-glass formula in both modes,
because they float over the dark imagery canvas regardless of surface).

### 2.6 Accessibility & validation (this is computed, not eyeballed)

- Categorical palettes pass all six `validate_palette.js` checks against the
  warm surfaces in both modes (light ΔE 24.2, dark 21.9; all dark slots ≥3:1).
- Load-bearing text pairs verified ≥ WCAG **AA 4.5:1**: white-on-accent 5.46,
  brand link on canvas 5.23, `--fg` body 17.5, `--fg-muted` 6.9, risk-critical
  text 5.41, risk-healthy text 5.19; dark: brand 7.4, body 16.7, muted 7.4.
- The three mid-tone categorical hues that sit sub-3:1 on light (aqua, yellow,
  magenta) invoke the **relief rule** — visible direct labels or the table view,
  never color-alone. Already required by our "label every series" rule.
- Every risk/status color is icon+label paired. Re-run the validator before
  changing any value: `node scripts/validate_palette.js "<hexes>" --mode <m>
  --surface <#bg>`.

---

## 3. Typography

A precise grotesk for display, a workhorse for text, a mono for data.

| Role | Token | Family | Use |
|---|---|---|---|
| Display / headings / KPI numbers | `--font-display` | **Geist** (→ Urbanist fallback) | H1–H3, hero KPI values, section labels |
| Body / UI | `--font-sans` | **Inter** | paragraphs, controls, table body |
| Data / telemetry | `--font-mono` | **JetBrains Mono** | coords, timestamps, IDs, code |

- **Geist** replaces RWR's Urbanist for a tighter, more instrument-grade feel;
  Urbanist stays as the fallback so nothing breaks before fonts are self-hosted.
- **Tabular numerals everywhere data aligns** — every table column, KPI value,
  axis tick, delta, and timer gets `font-variant-numeric: tabular-nums`
  (`--numeric-tabular`). This is non-negotiable for a data product: it stops
  numbers from jittering as they update.
- Type scale unchanged from the shell (`--font-size-*`, base 15px, hero KPI up
  to `9xl`/112px). Body line-height 1.45; headings 1.05–1.2; tracking tight
  (`-0.02em`) on large display, wider (`0.08em`) on all-caps micro-labels.
- Minimum body text 15px (desktop) / never below 13px for secondary; all-caps
  section kickers at 11px `2xs` with wide tracking.

---

## 4. Spacing, radius, elevation

- **Spacing:** 4px base scale (`--space-1…24`), unchanged from the shell. Dense
  data regions use 8/12px rhythm; section separation 24/32/48px.
- **Radius:** tightened slightly vs RWR for a more engineered read — `sm 6 ·
  md 10 · lg 14 · xl 18 · 2xl 24 · 3xl 34 · full`. Cards/panels = `2xl`; inputs
  and chips = `md`/`full`; KPI tiles = `2xl`.
- **Elevation:** four warm-tinted, low-spread shadows (`--shadow-soft/card/
  popover/overlay`) plus `--shadow-accent` for the primary-CTA glow. One
  consistent scale — never ad-hoc shadow values. On dark, elevation reads via
  surface-lightness steps (`bg → surface → surface-elevated`) more than shadow.
- **Glass:** frosted panels = `backdrop-filter: blur(20–24px) saturate(140%)`
  over `--panel-glass`, hairline border, used **only** for chrome floating over
  the map (purpose = "this dismisses/floats above imagery"), never as decoration
  on flat pages.

---

## 5. Motion

Restrained. Motion conveys cause-and-effect, never decoration.

- **Durations:** micro-interactions `--duration-fast` **160ms**; state
  transitions `--duration-normal` **220ms**; exits ~60–70% of enter. Nothing in
  the UI exceeds ~360ms except deliberate map camera moves.
- **Easing:** `--easing-standard` for most; `--easing-enter/exit` for
  appear/dismiss. **`--easing-spring`** (a gentle overshoot) is reserved for the
  **map** — deck.gl/MapLibre fly-to, panel slide-over, zone select — where a
  spatial spring gives the "camera" physicality. UI controls do not bounce.
- **Patterns:** press = subtle scale/opacity, no layout shift; list/timeline
  entrance staggered 30–50ms/item; modals/sheets animate from their trigger;
  live-data arrival = a single 220ms cobalt/`--cyan` pulse on the affected tile,
  then rest.
- **`prefers-reduced-motion`** collapses all `--duration-*` to 0 and the spring
  to standard (already wired in `tokens.css`).

---

## 6. Charting rules (per the `dataviz` skill)

Procedure order: **form → color-by-job → validate → marks → hover → a11y →
look at it.** Color is chosen last.

- **KPI stat tiles** (Farm Health, Yield at Risk, Revenue at Risk): the headline
  number is *not a chart* — big Geist figure, tabular, with a delta chip
  (↑ good uses `--risk-healthy` text + arrow, never color-alone) and an optional
  sparkline strip. Reuse the shell's `KpiCard`/`KpiStrip`.
- **NDVI trend sparkline / line:** one series, 2px line, a shaded baseline band
  (5-yr mean ± σ) behind it; crosshair + tooltip on hover; no legend box (title
  names it); direct-label the last point. Recessive hairline grid.
- **Risk heatmap:** sequential single-hue for magnitude *or* the semantic risk
  ramp when cells mean risk-level — with a labeled legend; 2px surface gap
  between cells; hover tooltip with exact value; table view available.
- **Portfolio risk treemap:** rectangles sized by exposure (hectares or
  revenue), colored by the **semantic risk ramp**, each tile **direct-labeled**
  with supplier name + risk word (never color-alone); 2px surface gaps.
- **Disruption timeline:** vertical event list, each row a severity pill (icon +
  word) + one-line cause; not a chart, a feed.
- **Universal:** thin marks; 4px rounded data-ends on bars anchored to baseline;
  a legend for ≥2 series (none for one); text wears text tokens (never the
  series color); status colors never reused as "series N"; every chart has a
  table fallback and an empty/loading/error state (skeleton, not a bare axis).

---

## 7. Component language (mapped to the existing shell)

The cloned RWR shell already ships the primitives; Report.Farm **re-skins via
tokens** and adds a thin farm layer. No primitive is rebuilt.

| Need | Existing component (`app/src/crm/components/ui/`) | Report.Farm use |
|---|---|---|
| Big-number KPI | `kpi-card.tsx` (`KpiCard`, `KpiStrip`) | portfolio KPI row, farm-health tiles |
| Frosted hero panel | `glass-panel.tsx` (`GlassPanel`) | over-map insight panels, Copilot card |
| Status pill | `badge.tsx` (cva variants + `statusVariant()`) | **add** `risk` variants → risk pills |
| Buttons / inputs | `button.tsx`, `input.tsx` | cobalt primary, ghost secondary |
| Metric arc / gauge | `MetricArc` (via `KpiCard aside`) | Farm Health / Portfolio Risk score |
| Tabs | `pill-tabs.tsx` | detail-view layer/period switches |
| Assistant rail | `ai-assistant-rail.tsx` | Onboarding Copilot panel |
| Status dots | `status-dots.tsx` | live/stale data freshness |
| Map | MapLibre + deck.gl stack | all four surfaces' substrate |

**New farm components (wave-2, thin):** `RiskPill`, `RiskLegend`,
`DisruptionAlertCard`, `SupplierRiskTable`, `SignalTimeline`, `ZoneIntentRow`,
`PortfolioTreemap`, `NdviSparkline` — all composed from the primitives above +
tokens. The `Badge` gets five `risk-*` variants added to its cva map.

---

## 8. Layout & responsive

Desktop-first (analysts on wide monitors), but every surface reflows — never
`display:none` on chrome except `@media print` (the shell's S8.1 policy).

- **Breakpoints:** 1440 (default) · 1024 (tablet) · 768 (small tablet/large
  phone) · 480 (phone). Systematic, matches the shell.
- **App shell:** left icon rail + top bar (tenant switcher, search, surface
  toggle, avatar) persist. The map is the hero; data panels are rails/columns
  that become bottom-sheets on tablet/phone (the shell already does this).
- **Density:** comfortable touch targets (≥44px on coarse pointers) even in
  dense tables; 8px minimum between targets.
- **Print:** the Executive Report is a real light-mode document — A4 width,
  generous margins, chrome hidden, print-safe contrast, page breaks respected.

See `SCREENS.md` for per-surface layout, component inventory, and responsive
behavior for each of the four hero screens.

---

## 9. Content & tone

Confident, precise, quantified. "38% of Rio Verde sourcing at yield risk," not
"some farms may have issues." Always attach **confidence** and **evidence**
(the imagery/chart that supports a claim) — this is the trust contract. Dates
absolute, numbers with units, money rounded sensibly ($2.4M). Never alarm
without an action.
