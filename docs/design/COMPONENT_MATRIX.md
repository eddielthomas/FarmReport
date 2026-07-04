# Component Matrix — React Bits + VengeanceUI × Report.Farm

**Purpose.** A decisive, buildable map from *our* surfaces/elements to specific external components that make Report.Farm sleeker, more unique, and more modern **without breaking the Radix + Tailwind v4 + token system**. Every recommendation below is grounded in the two supplied catalogs; no components are invented. Where a component's dependency tag was inferred (not verified) in the source catalog, it is flagged.

> Ground rules baked into every pick:
> - **Own the source.** Both libraries are copy-paste / registry-CLI — no runtime npm lock-in. We paste a file, then re-point its colors/durations to our tokens.
> - **Token-first.** Replace any hard-coded hex/duration with our vars: accent `--accent` / `--accent-strong` / `--accent-glow`; risk ramp `--risk-{healthy,watch,stress,high,critical}(-fill)`; motion `--duration-{instant,fast,normal,slow,slower}` + `--easing-{standard,emphasis,enter,exit,spring}`. Reduced-motion already collapses all `--duration-*` to 0 and neuters `--easing-spring`, so token-wired motion is automatically accessible.
> - **One WebGL budget.** At most ONE WebGL background, on marketing/login only, never behind a live dashboard/map. Prefer `ogl`/2D-canvas over `three`.
> - **Dark-mode default.** We render `data-surface='dark'` ("Mission Control") by default; every pick must be verified in dark first, light second.

---

## 1. The two libraries

### React Bits (reactbits.dev) — **VERIFIED, primary source**
- **What:** ~134 animated/interactive React components across Text Animations (23), Animations (30), Components (36), Backgrounds (45). Category names, component names, and counts are authoritative; a few CSS-vs-WebGL dep tags are inferred.
- **Stack:** React 19 source, framework-agnostic, shipped in 4 variants (JS/TS × CSS/Tailwind v4). Engines vary per component: `motion` (Framer Motion v12), `gsap` (+ScrollTrigger/SplitText), `three`/R3F, `ogl` (lightweight WebGL ~15–25KB), `matter-js`, `lenis`.
- **Consumption:** (1) copy-paste off the site with a stack toggle, (2) `npx jsrepo add https://reactbits.dev/<Category>/<Component>`, (3) `npx shadcn@latest add "https://reactbits.dev/r/<Component>-<VARIANT>"` (variant tokens `TS-TW` etc.). No runtime package; peer deps install only per component.
- **License:** MIT + Commons Clause — building Report.Farm on it is fine; reselling the components is not.
- **Fit for us:** Excellent. We're a Vite + Tailwind v4 + Radix shop. **Pick the `TS-Tailwind` variant** for every component so it lands in our existing utility/token workflow. CSS-only and `motion`-based picks slot in with zero architectural change; `motion` becomes our first (and, if we're disciplined, only) animation dependency.

### VengeanceUI (vengenceui.com) — **PARTIALLY VERIFIED, secondary source**
- **What:** ~50 bold animated React/**Next.js** components for landing/marketing surfaces (buttons, kinetic text, carousels, bento/cards, navbars, loaders, WebGL backgrounds).
- **Verification status (important):** Only the docs sidebar, install page, and two component pages (Glass Dock, Liquid Ocean) were actually fetched. The full list is high-confidence, but **per-component dep tags are mostly INFERRED** — treat every `framer-motion/gsap/three` attribution except Glass Dock and Liquid Ocean as unconfirmed. It is a small solo/community project (GitHub `Ashutoshx7/VengenceUI`); API stability and maintenance are unproven.
- **Stack / consumption:** shadcn registry, but **Next.js App Router + TS + Tailwind**, assumes `@/*` alias, Radix under the hood for overlays. `npx shadcn@latest add https://www.vengenceui.com/r/<component>.json` copies editable TS into your project.
- **Fit caveat #1 — Next.js coupling:** Components are authored against Next.js (`"use client"`, `next/image`, app-router assumptions). We are **Vite + React 18.3**, not Next. Anything adopted must be de-Next'd on paste (strip `next/image`, `next/link`, server-component assumptions). This is real friction on every component.
- **Fit caveat #2 — not a primitive kit:** No data table, no form/input/select/checkbox, no dialog/drawer/toast/pagination. It is *shell polish only*. Our Radix + our own `input.tsx`/`button.tsx`/`card.tsx` remain the substrate; VengeanceUI can only decorate.
- **Fit caveat #3 — React 18 vs React 19:** React Bits targets React 19 but its motion/CSS components are 18-safe. VengeanceUI is also 18-compatible in principle, but combined with the Next coupling the porting cost is higher.
- **Net:** Use VengeanceUI **sparingly, for marketing/login/shell chrome only**, and prefer the React Bits equivalent whenever one exists (it usually does, and it's verified + Vite-native). Treat VengeanceUI as inspiration + occasional port, not a dependency.

**Overall doctrine:** React Bits is the workhorse; VengeanceUI is a garnish for the marketing edge. Adding `motion` (Framer Motion) is the single foundational enabler — our tokens already define `--easing-spring` and the full `--duration-*` scale with reduced-motion collapse, so a `motion` layer slots cleanly. Avoid pulling in `gsap`+`ScrollTrigger`+`lenis` unless a specific high-ROI surface truly needs it; that trio fights native scroll/accessibility and adds ~40–70KB.

---

## 2. THE MATRIX

Legend — **Bundle:** 🟢 CSS/canvas/motion-only, cheap · 🟡 gsap/ScrollTrigger, medium · 🔴 three/ogl WebGL, heavy. **Src:** RB = React Bits (verified), VUI = VengeanceUI (dep inferred unless noted).

### 2A. Onboarding / forms (highest-ROI cluster)

| Our surface / element | File | Recommended component(s) | Src | Why it fits | Integration note (deps · tokens · dark · perf) |
|---|---|---|---|---|---|
| **Onboarding stepper** (5-step wizard, instant transitions today — the #1 upgrade lever) | `pages/farm/OnboardingCopilot.tsx` | **Stepper** (animated step indicator + sliding panel transitions) as the reference pattern; keep OUR step-rail markup, borrow its enter/exit choreography | RB | Directly targets the "zero step transitions" gap; gives slide+fade panel swap and an animated progress rail between completed steps | `motion` 🟢. Wire panel slide to `--duration-normal`/`--easing-enter` on enter, `--easing-exit` on leave; progress fill to `--accent`. **Don't** replace our `canProceed()` gating or step state — only animate. Reduced-motion → instant (already handled). |
| **Success reveal** (PartyPopper screen) | `OnboardingCopilot.tsx` | **CountUp** (for any summary metric) + a restrained one-shot; optionally **ClickSpark** on the CTA | RB | Celebratory but not gaudy; CountUp reinforces "here's what we'll monitor" | `motion` 🟢 / Canvas 🟢. Keep it to a single fire; spark color `--accent-glow`. Avoid physics confetti (matter-js) — off-budget for B2B. |
| **Boundary import** dropzone + parse feedback | `components/farm/BoundaryImport.tsx` | **FadeContent** (reveal map preview when geometry parses) + **GradualBlur** (soften map-preview edges) | RB | Makes the live satellite preview *arrive* instead of popping; edge blur frames the MapLibre canvas premium-ly | IntersectionObserver 🟢 / CSS 🟢. No deps. Keep parse-error banners on `--risk-critical`. `GradualBlur` is pure CSS gradient — safe over MapLibre. |
| **Zone-intent editor** (repeatable row, toggles + segmented) | `components/farm/ZoneIntentEditor.tsx` | **AnimatedContent** (row enter on add) + **ElasticSlider** *pattern* for priority (optional) | RB | New zone/parcel rows should slide in, not jump; elastic feel differentiates the intent controls | `motion` 🟢 (AnimatedContent uses gsap/ScrollTrigger 🟡 — prefer swapping to `motion` on paste, or use `FadeContent` instead to stay motion-only). Keep our Radix `role=switch` Toggles; only animate mount. |
| **Login mode toggle** (PillTabs sign-in/register, static today) | `pages/Login.tsx` | Keep OUR `PillTabs`; add **BlurText**/**GradientText** for the brand headline; optionally one WebGL bg (see 2F) | RB | Animate the mode-switch via our existing PillTabs + a premium heading; no new nav component needed | CSS 🟢 (GradientText) / `motion` 🟢 (BlurText). GradientText flows through `--accent`→`--accent-strong`. This is the *one* place a WebGL hero background is allowed. |
| **Contact form** (standalone static `contact.html`, outside React) | `app root /contact.html` | **StarBorder** or **GlowBorder**/**Glow Border Card** on the submit CTA + **ShinyText** heading — hand-portable CSS | RB (VUI alt) | It's plain HTML with a separate stack; only CSS-only effects port cleanly (no React runtime there) | CSS-only 🟢. **Must** copy the raw CSS (not the React wrapper). Hardcode the token hexes (`#2B5FE3` / `#4C7EFF`) since it can't read our CSS vars unless we link tokens.css. Verify it doesn't inherit the farm token layer. |

### 2B. Portfolio dashboard (KPI + tables + feeds)

| Our surface / element | File | Recommended component(s) | Src | Why it fits | Integration note |
|---|---|---|---|---|---|
| **KPI row** (4 hero numbers, static render — #2 upgrade lever) | `pages/farm/PortfolioDashboard.tsx` (+ `components/ui/kpi-card.tsx`) | **CountUp** (RB) or **Animated Number** (VUI) for the 44–56px hero values; **AnimatedContent/FadeContent** for staggered card entrance | RB (VUI alt) | Live count-up on Suppliers/Risk/Yield/Revenue makes the console feel instrumented; stagger adds polish | `motion` 🟢. Prefer **RB CountUp** (verified, Vite-native) over VUI Animated Number (Next-coupled). Respect honest empty-state: when value is `—`/awaiting-pass, **skip the count-up** and keep the footnote. Colors already per-tile (accent/watch/stress/critical). |
| **KPI tiles → live gauge feel** | `kpi-card.tsx`, `metric-arc.tsx` (built, UNUSED on farm) | Wire OUR **MetricArc** + **KpiStrip** into risk/yield tiles; animate the stroke to value with **CountUp**-synced timing | — (internal) | The catalog's best move here is to *activate what we already own*; no external dep needed | Pure internal. MetricArc already animates `stroke-dashoffset`. Map arc tint to `--risk-*` by score band. Zero bundle cost — do this before reaching for anything external. |
| **Supplier risk table** (HTML table, bg-tint hover only) | `PortfolioDashboard.tsx` | **AnimatedList** (per-row enter + selection) *pattern*; keep it a real `<table>` | RB | Adds row lift/accent-edge + micro-interaction without a data-grid rewrite | `motion` 🟢. **Do NOT** replace the semantic `<table>` (a11y/sort). Borrow only the per-row enter + hover-lift; hover edge → `--accent`, transition `--duration-fast`/`--easing-standard`. RiskPill stays authoritative for color. |
| **Alerts / Active Disruptions feed** | `PortfolioDashboard.tsx`, `FarmDetail.tsx` | **AnimatedList** (scrollable feed, per-item enter, fade edges) | RB | Purpose-built for alert/activity feeds — exactly our urgent-farm-alert use case | `motion` 🟢. Severity color must come from OUR RiskPill / `--risk-*`, not the component's defaults. Acknowledge→ack'd: animate with a simple `motion` layout transition; keep Loader2 spinner. Fade-edge mask reads well on dark. |
| **Monitored Farms cards grid** (spring border-hover exists; no entrance stagger) | `PortfolioDashboard.tsx` | **SpotlightCard** (cursor spotlight) or **TiltedCard**; + **AnimatedContent** on-scroll stagger | RB | Cursor-follow spotlight on supplier/farm cards is premium and cheap; stagger fixes flat entrance | SpotlightCard = CSS pointer 🟢 (best); TiltedCard = `motion` 🟢. Spotlight glow → `--accent-glow`. Keep existing `--easing-spring` border-hover. Don't tilt if it fights map thumbnails. |

### 2C. Farm detail + map

| Our surface / element | File | Recommended component(s) | Src | Why it fits | Integration note |
|---|---|---|---|---|---|
| **FarmMap satellite panel** (zones/parcels pop in instantly — #3 upgrade lever) | `components/farm/FarmMap.tsx` | Hand-rolled, catalog-*inspired*: boundary line-dash "trace" on load, zone-fill draw-in. Reference **ScrollFloat/ScrollReveal** timing only | RB (pattern) | The map is the visual centerpiece; a boundary trace + staged zone-fill is high-impact | **No external component renders inside MapLibre.** Do this with MapLibre paint-property transitions + our `--duration-slow`/`--easing-enter`, keyed off `map.on('load')`. Keep the 900ms spring `fitBounds`. Zone fills stay `--risk-*-fill` / intent colors. |
| **Frosted zone-intent legend / toolbar over map** | `FarmMap.tsx` (+ `components/ui/glass-panel.tsx`, currently unused) | **GlassSurface** (RB) or activate OUR `GlassPanel`; **GlassIcons** for toolbar buttons | RB (internal alt) | Real glassmorphism over satellite raster is the exact premium cue for a map HUD | CSS `backdrop-filter` 🟢. Prefer activating our **GlassPanel** first (zero new dep). If using RB GlassSurface, verify blur perf over a moving map and that border-light reads on dark. |
| **Signal Timeline** (honest ghost-axis empty-state is the *default* pre-data) | `components/farm/SignalTimeline.tsx` | **AnimatedList** for populated events; a subtle **scan-line / shimmer** for the empty ghost axis (see 2E) | RB | When data lands, events should stream in; until then the empty state must feel alive | `motion` 🟢 for events. Keep trend up/down + per-event `--risk-*` tint. Empty-state shimmer must be CSS-only (see Empty-States row) — never WebGL behind a data panel. |

### 2D. App shell / navigation (optional, lower priority)

| Our surface / element | File | Recommended component(s) | Src | Why it fits | Integration note |
|---|---|---|---|---|---|
| **Primary nav / console shell** | (shell TBD) | **PillNav** (RB) or **Notch/Spotlight Navbar** (VUI); **Dock** (RB) or **Glass Dock** (VUI) for a tool dock | RB (VUI alt) | Polished nav indicator / macOS-style dock for a command console | RB PillNav uses gsap 🟡; RB Dock uses `motion` 🟢 (prefer Dock). VUI **Glass Dock** is verified but needs **GSAP morphSVG** (historically a **paid GSAP Club plugin — verify license before shipping**) + de-Next'ing → high friction. **Default to RB Dock.** Active indicator → `--accent`. |
| **Fullscreen / mobile menu** | (shell TBD) | **StaggeredMenu** (RB) | RB | Stagger-reveal overlay menu | gsap 🟡. Fine for a one-off overlay; respect reduced-motion. Low priority for a data console. |

### 2E. Empty-states (this product is empty until AlphaGeo lands — empty-states ARE the default experience)

| Our surface / element | File | Recommended component(s) | Src | Why it fits | Integration note |
|---|---|---|---|---|---|
| **"Awaiting first satellite pass" states** (SignalTimeline ghost axis, Active Disruptions, KPI `—`, Monitored Farms) | `SignalTimeline.tsx`, `PortfolioDashboard.tsx` | **ShinyText** sweep on the "awaiting pass" label; **GradualBlur** framing; a token-driven CSS **scan-line** (Radar-*inspired*, hand-rolled) | RB | A gentle sweep/scan-line makes pre-data screens feel like they're *listening*, not broken | **CSS-only 🟢 mandatory here** — these sit inside/behind live panels. ShinyText sheen tinted `--accent`. Do NOT use RB **Radar** (Canvas/CSS, but a full animated bg) or any WebGL behind data. Keep the honest copy. |

### 2F. Marketing / login hero (the ONLY place WebGL is allowed)

| Our surface / element | File | Recommended component(s) | Src | Why it fits | Integration note |
|---|---|---|---|---|---|
| **Login / marketing hero background** | `pages/Login.tsx`, marketing pages | **ONE of:** **Aurora**, **Silk**, **Threads**, **Iridescence**, or **Particles** (all `ogl`); or **DotGrid** (2D canvas, cheapest) | RB | A single restrained aurora/particle field signals "premium platform" on the entry surface only | 🔴 `ogl` (~15–25KB) or 🟢 canvas (DotGrid). **Prefer DotGrid or Aurora.** Lazy-load, mount only on login/marketing, gate behind `prefers-reduced-motion` (pause loop). **Never** behind the dashboard/map. Tint to cobalt via component props. |
| **Marketing headings / social proof** | marketing pages | **GradientText** + **ShinyText** (headings); **LogoLoop** (RB) or **Logo Slider** (VUI) for a buyer/logo wall; **ScrollReveal** for section copy | RB (VUI alt) | CSS-only premium type + infinite logo marquee = classic SaaS marketing polish at ~zero cost | GradientText/ShinyText CSS 🟢; LogoLoop CSS/JS 🟢; ScrollReveal gsap+ScrollTrigger 🟡 (use sparingly / prefer FadeContent). VUI **Glow Border Card** works for pricing tiles but is Next-coupled — prefer RB **SpotlightCard**/**StarBorder**. |
| **Marketing CTA buttons** | marketing pages | **StarBorder** (RB, CSS) — keep our `Button` as the base | RB (VUI alt) | Animated glow border on the primary CTA without abandoning our cva Button | CSS 🟢. VUI **Animated/Generate/Radial Glow Button** are alternatives but Next-coupled + dep-inferred — RB StarBorder is the safe, verified pick. Glow → `--accent-glow`. |

---

## 3. Adopt now / Adopt later / Avoid

### ✅ Adopt now — high-ROI, low-bundle, on-brand (CSS-only or `motion`)
- **RB CountUp** — KPI hero numbers + onboarding success. `motion`. 🟢
- **RB Stepper (choreography)** — onboarding step transitions. `motion`. 🟢
- **RB AnimatedList** — alerts feed + populated signal timeline. `motion`. 🟢
- **RB FadeContent / AnimatedContent** — staggered card/row/panel entrances (prefer FadeContent = IntersectionObserver, no dep). 🟢
- **RB SpotlightCard** — supplier/farm cards. CSS pointer. 🟢
- **RB GradientText + ShinyText** — premium headings, "awaiting pass" sheen. CSS. 🟢
- **RB GlassSurface / GlassIcons** — map HUD + toolbar (or activate our own `GlassPanel`). CSS. 🟢
- **RB StarBorder + GradualBlur** — CTA borders, map/preview edge framing, contact.html. CSS. 🟢
- **Internal (do first):** wire the already-built **MetricArc** + **KpiStrip** + **GlassPanel** into the farm surface — zero external dep, immediate lift.

### 🕒 Adopt later — good, but medium bundle / needs gsap / lower priority
- **RB TiltedCard / ChromaGrid** — richer card interactions once SpotlightCard is proven. `motion`/gsap.
- **RB Dock / PillNav / StaggeredMenu** — when the console shell nav is designed. gsap/`motion` 🟡.
- **RB ScrollReveal / ScrollFloat / ScrollStack** — long report pages; gsap+ScrollTrigger(+lenis) 🟡 — only if a report page truly needs scroll storytelling; can fight native scroll.
- **ONE RB WebGL background** (Aurora/Silk/Particles/DotGrid) — login/marketing only, lazy-loaded. 🔴/🟢.
- **VUI Logo Slider / Glow Border Card / Animated Number** — only if a marketing page wants the VUI look; **must de-Next and verify deps first**; RB equivalents preferred.

### ⛔ Avoid — heavy, off-brand, or high-friction for a B2B data console
- **Any `three`-based background** — Beams, Hyperspeed, Dither, LiquidEther, PixelBlast, Ballpit, Galaxy (RB); **Liquid Ocean, Twisting Ribbon, Ripple Displacement Slider** (VUI). ~150KB+ + continuous rAF; jank behind maps/charts. 🔴
- **Physics pieces** — RB FallingText, Antigravity (matter-js), Lanyard (rapier + ships `card.glb`+png); VUI physics carousels. Demo-flashy, low B2B utility.
- **Immersive 3D galleries/nav** — RB CircularGallery, DomeGallery, FlyingPosters, InfiniteMenu, FluidGlass, ModelViewer; VUI Interactive Book, Cylinder Carousel. Off-purpose for a monitoring console.
- **Cursor-FX gimmicks** — SplashCursor, BlobCursor, GhostCursor, Crosshair, ImageTrail, PixelTrail, MetaBalls, Ribbons, Strands. Distracting on a data surface; several are WebGL.
- **VUI Glass Dock as-is** — needs **GSAP morphSVG (verify paid-license)** + Next de-coupling. Use **RB Dock** instead.
- **Novelty text** — GlitchText/Fuzzy/Creepy Button/ASCIIText — clash with the "Mission Control" premium posture and the semantic risk palette.
- **Anything that hard-codes its own status colors** over our `--risk-*` ramp — must be re-pointed or it breaks the semantic contract.

---

## 4. First-wave picks (5–8 components → exact files)

Implement in this order. Foundational step 0 enables the rest.

0. **Install `motion` (Framer Motion v12)** — the one foundational dep. Add a thin `src/crm/motion/` wrapper that reads `--duration-*`/`--easing-*` so every component inherits tokens + reduced-motion for free. *(Touches: `package.json`, new `src/crm/motion/tokens.ts`.)*

1. **RB CountUp → KPI hero numbers** *(highest visible ROI #2).*
   - Files: `src/crm/pages/farm/PortfolioDashboard.tsx`, `src/crm/components/ui/kpi-card.tsx`.
   - Guard: skip count-up on honest `—`/awaiting-pass values.

2. **Activate MetricArc + KpiStrip in KPI tiles** *(internal, zero-dep, pairs with #1).*
   - Files: `src/crm/components/ui/kpi-card.tsx`, `src/crm/components/ui/metric-arc.tsx`, `PortfolioDashboard.tsx`.

3. **RB Stepper choreography → onboarding transitions** *(#1 upgrade lever).*
   - Files: `src/crm/pages/farm/OnboardingCopilot.tsx` (animate step enter/exit + progress rail; keep `canProceed()` and step-rail markup).

4. **RB AnimatedList → alerts feed + populated signal timeline.**
   - Files: `src/crm/pages/farm/PortfolioDashboard.tsx` (Active Disruptions), `src/crm/components/farm/SignalTimeline.tsx`, `src/crm/pages/farm/FarmDetail.tsx`. Severity color from RiskPill/`--risk-*`.

5. **RB SpotlightCard + FadeContent → Monitored Farms grid.**
   - Files: `src/crm/pages/farm/PortfolioDashboard.tsx` (cards), reuse existing `--easing-spring` border-hover; glow `--accent-glow`.

6. **RB GradientText + ShinyText → headings + "awaiting first pass" empty-state sheen** *(CSS-only, cheap, on-brand).*
   - Files: `src/crm/pages/Login.tsx`, `src/crm/components/farm/SignalTimeline.tsx` (ghost axis), `PortfolioDashboard.tsx` empty notes.

7. **Activate GlassPanel (or RB GlassSurface) → FarmMap legend/HUD.**
   - Files: `src/crm/components/farm/FarmMap.tsx`, `src/crm/components/ui/glass-panel.tsx`. Verify blur perf over the moving MapLibre raster.

8. **(Optional, later) ONE RB WebGL bg (Aurora or DotGrid) → Login only**, lazy-loaded + reduced-motion gated.
   - Files: `src/crm/pages/Login.tsx`.

**Deliberately deferred:** boundary line-dash "trace" + zone-fill draw-in on FarmMap is high-impact but is a **hand-rolled MapLibre paint-transition**, not an external component — schedule it as a bespoke task after the first wave.

---

## Executive summary

React Bits is the workhorse and VengeanceUI the garnish: React Bits is verified, Vite-native, MIT-licensed copy-paste source that maps cleanly onto our React 18 + Tailwind v4 + Radix + token stack (adopt the `TS-Tailwind` variant and re-point every color/duration to `--accent`/`--risk-*`/`--duration-*`/`--easing-*`), whereas VengeanceUI is a partially-verified, Next.js-coupled marketing kit with mostly *inferred* dependency tags and no data/form/dialog primitives — use it only for marketing/login chrome, and only after de-Next'ing and license-checking (its Glass Dock needs paid GSAP morphSVG). The single foundational move is adding `motion` (Framer Motion); our tokens already define `--easing-spring` and a reduced-motion collapse, so a token-wired motion layer is instantly accessible. The highest-ROI, lowest-risk picks are all CSS-only or `motion`-based — **CountUp** on the static KPI row, **Stepper** choreography on the transition-less onboarding wizard (the make-or-break first-run), **AnimatedList** for alerts and the signal timeline, **SpotlightCard + FadeContent** for the farm-card grid, and **GradientText/ShinyText** for headings and the "awaiting first satellite pass" empty-states that are currently the product's *default* experience. Two internal freebies (wiring the already-built but unused **MetricArc/KpiStrip/GlassPanel**) deliver premium lift at zero bundle cost and should ship first. Hold the line on WebGL: at most one `ogl`-based (or 2D DotGrid) background on login/marketing only — never `three`, physics, cursor-FX, or immersive 3D behind the live map/dashboard, and never a component that overrides our semantic risk ramp.
