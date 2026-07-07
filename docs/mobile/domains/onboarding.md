# Report.Farm Mobile — Onboarding & Find-my-farm

**Domain owner:** Mobile Design Lead
**Platforms:** iOS + Android (single Expo / React Native + TypeScript codebase)
**Stack:** Expo, expo-router, expo-sqlite + Drizzle (offline drafts), `@maplibre/maplibre-react-native` (satellite globe + boundary preview) with `react-native-maps` fallback, expo-document-picker + expo-file-system (file import), expo-location (device geocode/GPS), expo-notifications (scan-complete push), react-native-reanimated + gesture-handler (vertex drag, step transitions), expo-gl / Skia not required here.
**Design language:** Cobalt accent `#4C7EFF`, warm near-black surfaces, dark-mode-first, tabular-nums for all areas/counts, frosted over-map controls, spring transitions. Mirrors the web `OnboardingCopilot` + `FindMyFarm` + `BoundaryImport` + `ZoneIntentEditor`.

> **Scope:** 100% coverage of the web **Onboarding & Find-my-farm** feature inventory (15 features). This document is the authoritative mobile spec for this domain. The web wizard lives at `operations.html?view=onboard`; on mobile it is a first-class native flow reachable from the Portfolio tab.

---

## 0. Honesty tiers (non-negotiable, carried from web)

Every degraded path collapses to an **honest note** and NEVER blocks the manual boundary path. Nothing is fabricated.

| Tier | Meaning | Mobile treatment |
|---|---|---|
| **T2 (exact)** | Cadastral parcel from gateway (`source=cadastral`) | Green "Found your parcel" banner, no "approximate" flag, boundary treated as authoritative |
| **T3 (approximate/screening)** | OSM geocode fallback OR SAM2 AI auto-trace | Amber "Located your farm — approximate" chip, always paired with "drag corners to trace your exact boundary"; AI trace carries a persistent **T3 screening** label and is never presented as authoritative |
| **Degraded/unconfigured** | Gateway 503 `gateway_unconfigured`, vision 404 `vision_not_available`, WebGL/native-map failure, OSM miss, **offline** | Subtle Info note ("Automatic lookup isn't connected yet — import or draw your boundary below"); the manual import/draw path always remains fully usable |

**Rule:** onboarding must be *completable* end-to-end with a hand-drawn or imported boundary even fully offline — only the final Create POST requires connectivity.

---

## 1. EPICS & USER STORIES

Roles: **Buyer Admin** and **Farm Operations** hold `farm:onboard` (can register farms). **Portfolio Lead** and **Grower** are watch-only (`farm:view` but NOT `farm:onboard`).

### EPIC A — Enter & navigate the Onboarding Copilot

**A1 — As a Farm Operations user, I want to launch onboarding from the Portfolio tab, so that I can add a new farm to the portfolio.**
- AC: An "Onboard farm" CTA (＋ icon) appears on the Portfolio screen **only** when the signed-in role has `farm:onboard`.
- AC: Tapping it opens the native wizard at step 0 (Farm basics) with an empty draft (or resumes an autosaved draft — see A6).
- AC: Watch-only roles never see the CTA.

**A2 — As an operator, I want a step rail I can see and jump around in, so that I always know where I am and can revisit earlier steps.**
- AC: A horizontally-scrollable step rail shows 5 numbered/icon pills: Farm basics, Boundary, Parcels, Zones, Review.
- AC: The active pill is cobalt; a completed+valid past step shows a green check; locked/future steps are muted.
- AC: Tapping a *reachable* step jumps to it; locked steps are non-interactive (with a subtle haptic "denied" tap).
- AC: Header reads "Onboarding Copilot" / "Add a farm to your portfolio".

**A3 — As an operator, I want Back/Next controls with per-step gating, so that I cannot advance past a step that is missing required data.**
- AC: A sticky bottom bar has **Back** (disabled/hidden on step 0) and **Next** (disabled until `canProceed`).
- AC: `canProceed`: step 0 requires name + ≥1 farm type; step 1 requires a boundary; steps 2 & 3 always allow Next.
- AC: On the last step, Next is replaced by the **Create farm** action.
- AC: Swipe-left/right between steps is allowed only where gating permits (blocked forward swipe bounces with haptic).

**A6 — As an operator, I want my in-progress farm draft to survive app backgrounding and reload, so that I never lose a half-entered farm.**
- AC: All draft state (name, farmTypes, crops, supplierId, boundary, parcels[], zones[], timezone, current step) autosaves to expo-sqlite/Drizzle on every change (debounced).
- AC: Relaunching the app or reopening onboarding offers "Resume draft" vs "Start over".
- AC: Timezone is auto-derived from the device (`Intl…timeZone` / expo-localization).
- AC: Draft is cleared on successful Create or explicit discard.

### EPIC B — Permission gate

**B1 — As a Portfolio Lead or Grower (watch-only), I want an honest explanation when I reach onboarding, so that I understand why I can't register a farm instead of hitting a dead-end 403.**
- AC: If role lacks `farm:onboard`, the entire wizard is replaced by a gate card: Tractor icon, "Onboarding needs an operator role", copy that Buyer Admin / Farm Operations can register farms while the current role can only view, and a "Back to portfolio" button.
- AC: The decoded role is cached locally (from the 8h JWT) so the gate renders correctly **offline** — a viewer never sees the wizard.
- AC: Even if a viewer somehow submits, the server independently returns 403 on `POST /farm/farms` (belt-and-suspenders).

### EPIC C — Farm basics (Step 0)

**C1 — As an operator, I want to name my farm and pick its types and crops, so that the portfolio classifies it correctly.**
- AC: Farm name text field (required, placeholder "e.g. North Valley Farms").
- AC: Farm types multi-select chips (≥1 required) with presets: cropland/orchard/vineyard/pasture/livestock/aquaculture/greenhouse/mixed, plus a free-text "add" affordance (lowercased, deduped).
- AC: Crops multi-select chips (optional) with 14 presets + free-text add.
- AC: Selected chips show a check icon and cobalt fill; tapping toggles.
- AC: Supplier picker (optional native action-sheet/select) defaulting to "No supplier — direct", populated from cached portfolio suppliers; shows a loading note while fetching.
- AC: Preset type/crop lists ship in the mobile bundle (work offline).

### EPIC D — Boundary acquisition (Step 1, keystone)

**D1 — As an operator, I want automatic and manual boundary paths that feed one boundary, so that however I resolve my land, the wizard treats it identically.**
- AC: Step 1 shows **Find my farm** (auto) above **Import / Draw** (manual); any resolved Polygon/MultiPolygon sets the single `boundary` and clears the boundary error.
- AC: A boundary is required to advance.
- AC: Server 422 `invalid_geometry` on Create bounces back to step 1 with inline error "not a valid polygon (self-intersecting or unclosed)".

**D2 — As an operator, I want to find my farm by typing its address, so that I don't have to hunt on a map.**
- AC: Address field + "Find" button (cobalt, spinner while busy, disabled when empty/busy); keyboard "Search"/return submits.
- AC: Cadastral gateway parcel wins outright (exact, T2); otherwise OSM geocode fallback (approximate, T3).
- AC: On success, the map flies to the parcel centroid at ~zoom 14 and the boundary loads.

**D3 — As an operator, I want to drop a pin on a satellite globe to locate my farm, so that I can find land I can't address precisely.**
- AC: A satellite map (Esri World Imagery) opens zoomed-out; on capable devices a globe with a brief bounded intro spin (≤7s) that stops on first touch.
- AC: Tapping the map drops/moves a cobalt marker and runs a point lookup (`/farm/gw/parcel?lat&lon`, OSM reverse-geocode fallback).
- AC: Overlay chip: "Tap the map to drop a pin on your farm" / "Locating…".
- AC: Zoom controls present; on located result the map flies to the centroid.
- AC: If the native map / GL fails, a static fallback card directs to address search or manual import — never a crash.
- AC: A "Use my current location" affordance (expo-location) drops a pin at the device GPS fix (mobile-native enhancement).

**D4 — As an operator, I want honest result states, so that I always know whether a boundary is exact or approximate.**
- AC: States: idle / searching / found / notfound / error / unconfigured.
- AC: Found (exact): green "Found your parcel" + address + area (ha) + "Not right? Adjust below or import manually."
- AC: Found (approximate/T3): amber "Located your farm — approximate" + "drag its corners below to trace your exact boundary."
- AC: Not-found: neutral note to try a more specific address / drop pin on the field / import below.
- AC: Error: neutral note + the error message + directs to manual import.
- AC: Unconfigured (503) or **offline**: whole Find-my-farm block collapses to a single Info note; manual path carries on.

**D5 — As an operator, I want AI to auto-trace my field, so that I get a first-cut boundary from a single pin without drawing.**
- AC: "Auto-trace field with AI" button (wand icon), enabled only once a point is known (pin or resolved address).
- AC: On tap, calls `POST /farm/gw/vision/segment` with a bbox around the pin; handles sync 200 and async 202 `{jobId}` (awaits `farm.complete` via SSE/push).
- AC: Picks the pin-containing polygon (else highest confidence, else first), drops it into the editor, flies to ~zoom 15.
- AC: States: idle / tracing ("Tracing your field…") / unavailable / empty / error, each with an honest sub-note.
- AC: 404/503 → "AI auto-trace isn't live yet"; empty → "No clear field detected here."
- AC: Traced boundary carries a persistent **T3 screening** badge and never blocks the manual path.
- AC: Button is disabled offline with tooltip "needs connection".

**D6 — As an operator, I want to import a boundary file, so that I can use GeoJSON/KML/shapefile I already have.**
- AC: Mode toggle: **Import file** | **Paste GeoJSON** | **Draw**.
- AC: File mode: a tap-to-browse zone (expo-document-picker) accepting .geojson/.json, .kml, .zip (shapefile) — plus share-sheet "Open in Report.Farm".
- AC: Parses shapefile/KML/GeoJSON client-side (RN-compatible parsers; DOMParser polyfilled), reduces any FeatureCollection/Feature/GeometryCollection to one Polygon/MultiPolygon (rings ≥4 pts).
- AC: `polygonOnly` mode (parcels/zones) keeps the largest polygon and notes how many were dropped; non-polygonOnly notes when N polygons loaded.
- AC: Busy "Reading…" state; inline errors ("not valid JSON/GeoJSON", "No polygon geometry found", KML parse error).
- AC: Works fully offline.

**D7 — As an operator, I want to paste raw GeoJSON, so that I can quickly drop in a shape from another tool.**
- AC: Paste mode: monospace multi-line text area + "Parse GeoJSON" button.
- AC: Inline errors: "Paste some GeoJSON first" / "That is not valid JSON" / "No polygon geometry found. Expected a Polygon, MultiPolygon, Feature, or FeatureCollection."
- AC: Offline-capable; treated as an advanced/fallback affordance on mobile.

**D8 — As an operator, I want a satellite preview with a geometry readout, so that I can confirm the boundary is right before continuing.**
- AC: Once geometry exists, a satellite preview renders it as cobalt fill + line, fit to bounds.
- AC: Below it, a summary row: source label (filename / "Pasted GeoJSON" / "Drawn" / "Boundary set"), area (ha), vertex count ("{n} pts"), and a Clear button.
- AC: If the native map fails, a static card shows area + type: "boundary is valid and will be saved."
- AC: Area (geodesic WGS84) and vertex math are pure client (ship them) and run offline.

**D9 — As an operator, I want to draw and drag boundary vertices on the map, so that I can trace or refine my exact boundary as the copy promises.**
- AC: **Draw** mode: tap to add vertices, drag a vertex handle to move, long-press a vertex to delete, tap the closing vertex to complete the ring. (This fulfills the web "drag corners" copy that web onboarding only *promises* — mobile delivers on-map editing here.)
- AC: Editing an approximate (T3) or AI-traced boundary is the primary "trace your exact boundary" path.
- AC: Undo/redo of vertex edits.
- AC: Fully offline (geometry math + native map with cached/last tiles or a plain draw canvas fallback).

### EPIC E — Parcels (Step 2)

**E1 — As an operator, I want to add optional named sub-boundaries, so that I can split the farm into legal/management parcels.**
- AC: "Add parcel" appends a row (name field "e.g. North 40", Remove button, compact `polygonOnly` boundary editor).
- AC: Empty state: dashed "No parcels yet. Add one, or continue to zones."
- AC: Largest-polygon-kept behavior with a drop note.
- AC: Parcel drafts persist offline; they POST **after** the farm on Create and expose a draft-key→server-id map for zones.

### EPIC F — Monitoring zones (Step 3)

**F1 — As an operator, I want to define per-area monitoring intent, so that alerts stay meaningful (a barn shouldn't green up; a wetland should hold water).**
- AC: "Add zone" appends a ZoneIntentEditor card: numbered badge + Remove, zone name, zone **type** select (Crop field / Irrigation zone / Barn-structure / Wetland-pond / Test plot).
- AC: Changing type re-seeds intent defaults (`defaultIntentFor`) but keeps name/geom.
- AC: Intent controls: two toggles (Expects irrigation | No irrigation expected; Standing water OK | Standing water flags) + two segmented pickers (Vegetation priority low/med/high; Alert sensitivity low/med/high).
- AC: Optional parcel-attachment chips (None + each parcel with geometry).
- AC: Compact `polygonOnly` boundary editor per zone, with per-zone geometry-error support.
- AC: Empty state card; presets are pure client logic (offline).
- AC: Zones POST **after** parcels; parcel_id resolved via the key→id map.

### EPIC G — Review, create & outcomes (Step 4)

**G1 — As an operator, I want a read-only review summary, so that I can verify everything before committing.**
- AC: Summary list: Farm name (or "Missing · required"), Farm types (chips or Missing), Crops (chips or "none"), Supplier (resolved name or "Direct"), Boundary (area ha + type with Sprout icon, or "Missing — go to Boundary step"), Parcels ("N with geometry / M added"), Zones (name + type + area list, or "none").
- AC: `readyToCreate` = name + ≥1 type + boundary; the Create button is disabled with helper text listing what's missing until ready.

**G2 — As an operator, I want a reliable Create that handles partial success, so that a child failure doesn't leave me confused or duplicate a farm.**
- AC: Create runs sequential POSTs: farm → each parcel (with geometry) → each zone.
- AC: While creating, the button reads "Creating…" and is disabled.
- AC: If the farm POSTs but a child fails, the error banner names the `partialFarmId` and warns re-running won't duplicate — remove created children first.
- AC: **Offline at Create:** the create is **queued** ("Will register when back online") and syncs on reconnect with idempotency awareness; the user is not blocked from queuing.

**G3 — As an operator, I want honest, actionable error messages, so that I know exactly how to recover.**
- AC: 422 invalid_geometry (no farm yet) → boundaryError + jump to step 1.
- AC: 422 invalid_geometry (farm already created) → message about a parcel/zone shape + jump to step 3.
- AC: 403/401/permission → "your account isn't an operator, or your sign-in predates a permission change — sign out/in or use Buyer Admin / Farm Operations."
- AC: Other ApiError → "Couldn't create the farm: {message}{detail}"; non-ApiError → generic.
- AC: Explicit **offline/queued** state added on top of the web taxonomy.

**G4 — As an operator, I want a celebratory confirmation, so that I know the farm is registered and what happens next.**
- AC: Success screen: PartyPopper icon, "{name} is now under monitoring", copy that the boundary is registered and risk/yield signals populate as AlphaGeo ingests the first AOI pass.
- AC: Stats row: Farm ID (mono), parcel count, zone count (singular/plural).
- AC: "View on portfolio" button returns to the Portfolio tab; a local "new farm (pending ingest)" entry appears immediately.
- AC: Optional "Run first scan now" affordance (see H1).

### EPIC H — Onboarding → scan handoff (P2)

**H1 — As an operator, I want to trigger the first satellite scan from the success screen, so that monitoring starts immediately.**
- AC: The refined boundary can register as a gateway AOI (`POST /farm/gw/aoi/from-geom` → `{aoi_id}`) and launch a scan (`POST /farm/gw/scan`, gated `farm:onboard`).
- AC: Both return 503 in stub mode → honest "scan not connected yet" note.
- AC: Scan is queued when offline; user subscribes to `farm.complete` via expo-notifications rather than blocking the UI. (Primary scan UX lives in Studio; here it's a one-tap handoff.)

---

## 2. USER JOURNEYS

### J1 — Happy path: Farm Operations onboards a farm by address (online)
1. Portfolio tab → taps **＋ Onboard farm**.
2. Step 0: types "North Valley Farms", taps `cropland` + `orchard` chips, adds crop `almonds`, leaves supplier "Direct". Next enables → taps Next.
3. Step 1: types address in **Find my farm**, hits Search. Spinner → green "Found your parcel · 128.4 ha" (cadastral, T2). Map flies to centroid; boundary preview renders with 42 pts. Reviews, taps Next.
4. Step 2: taps **Add parcel**, names "North 40", imports a GeoJSON file → largest polygon kept. Next.
5. Step 3: **Add zone** → "Main orchard", type *Crop field*, sets Vegetation priority *high*, attaches to "North 40" parcel, draws the zone polygon. Next.
6. Step 4: reviews summary (all green), taps **Create farm** → "Creating…" → farm + 1 parcel + 1 zone POST sequentially.
7. Success screen: "North Valley Farms is now under monitoring", Farm ID shown. Taps **Run first scan now** → scan queued, push subscription armed. Taps **View on portfolio**.

### J2 — Drop-a-pin + AI auto-trace (T3)
1. Step 1, taps the globe (intro spin stops), drops a pin on a field. "Locating…" → OSM reverse geocode returns approximate → amber "Located your farm — approximate — drag its corners below to trace your exact boundary."
2. Taps **Auto-trace field with AI** → "Tracing your field…" (202 async; awaits SSE/push farm.complete) → SAM2 returns the pin-containing polygon, dropped into the editor with a **T3 screening** badge, map flies to zoom 15.
3. Switches editor to **Draw** mode, drags 3 corners to tighten the trace, long-presses one stray vertex to delete it. Undo once. Next.

### J3 — Fully offline onboarding (manual boundary)
1. Airplane mode. Portfolio (cached) → **Onboard farm** (role cached from JWT, CTA shown).
2. Step 0 completes (presets are bundled). Supplier list shows cached suppliers or "offline — Direct only".
3. Step 1: Find-my-farm block auto-collapses to the Info note ("Automatic lookup isn't connected — import or draw below"). User taps **Draw**, traces the boundary on the last-cached satellite tiles (or plain canvas fallback). Area/pts computed locally. Next.
4. Steps 2–3 as needed (all local). Step 4 review is fine.
5. Taps **Create farm** → "You're offline — this farm will register automatically when you reconnect." Draft moves to a **queued** state. Banner in-app shows "1 farm pending sync."
6. Reconnect → queued create runs (farm → parcels → zones), push confirms; success entry updates from "pending" to "under monitoring."

### J4 — Watch-only viewer (Portfolio Lead)
1. Opens a deep link to onboarding. Role cached → gate card renders instantly (even offline): "Onboarding needs an operator role." Taps **Back to portfolio**.

### J5 — Invalid geometry bounce
1. Draws a self-intersecting boundary offline; Create (online) returns 422 invalid_geometry, no farm created yet → wizard jumps to step 1 with inline red error "not a valid polygon (self-intersecting or unclosed)." User fixes vertices, re-creates.

### J6 — Partial-success recovery
1. Create: farm POST succeeds, a zone POST 422s (bad zone shape). Error banner: "A parcel or zone boundary is not a valid polygon… The farm itself was created (ID f_123); re-running will not duplicate it — remove already-created children first." Wizard jumps to step 3; user fixes the zone; re-run creates only the remaining children.

### J7 — Resume draft
1. User backgrounds the app mid-step-3; hours later reopens onboarding → "Resume 'North Valley Farms' draft?" → taps Resume → lands exactly where they left, boundary + parcels + zones intact.

---

## 3. SCREENS

### S1 — Portfolio entry (host surface, this domain's CTA only)
- **Purpose:** launch point for onboarding.
- **Layout:** Portfolio list/rollups (owned by another domain) + a floating/section **＋ Onboard farm** CTA.
- **Elements:** CTA button (cobalt, ＋ icon, label "Onboard farm"), "N farms pending sync" banner when queued creates exist.
- **States:** CTA hidden when role lacks `farm:onboard` (from cached JWT); pending-sync banner when applicable.
- **Nav:** CTA → S3 (or S2 gate if role invalid) / resume prompt.
- **Gestures:** tap.

### S2 — Permission gate card
- **Purpose:** honest block for watch-only roles.
- **Layout:** centered card, Tractor icon in a circle, title "Onboarding needs an operator role", explanatory paragraph, "Back to portfolio" button.
- **States:** static; renders offline from cached role.
- **Nav in:** any onboarding entry when `!canOnboard`. **Out:** Back to portfolio → S1.
- **Gestures:** tap; swipe-back.

### S3 — Wizard shell (container for steps)
- **Purpose:** frame the 5 steps with rail + footer nav.
- **Layout:** top header ("Onboarding Copilot" / "Add a farm to your portfolio"); horizontally-scrollable **step rail** (5 pills); scrollable **step body**; sticky **footer nav** (Back | Next/Create).
- **Elements:** step pills (icon/number, active cobalt / done green-check / locked muted); Back button; Next button (or Create on step 4); autosave indicator ("Saved" tick).
- **States:**
  - *Resume:* on entry with an existing draft → "Resume draft / Start over" sheet.
  - *Gated:* Next disabled per `canProceed`.
  - *Offline:* small "Offline" chip in header; behavior per step.
- **Nav in:** S1 CTA. **Out:** Back-to-portfolio (Android back / swipe from step 0 asks "Discard draft?"), or Success (S12).
- **Gestures:** horizontal swipe between reachable steps (blocked forward swipe → haptic bounce); rail pill tap-to-jump; pull-to-dismiss keyboard.

### S4 — Step 0: Farm basics
- **Purpose:** capture name, types, crops, supplier.
- **Layout:** section "Farm basics"; Farm name input; Farm types chip group (+ add-custom row); Crops chip group (+ add-custom row); Supplier selector.
- **Elements:** text input (name); **ChipMultiSelect** (types) with check-on-select + inline "Add a type…" input + Add button; ChipMultiSelect (crops); native Supplier picker (action sheet) with "No supplier — direct" default.
- **States:** supplier loading note; supplier "offline — Direct only"; validation hint under Next when name/types missing.
- **Nav:** Next → S5. **Gestures:** tap chips; keyboard "return" commits a custom chip.

### S5 — Step 1: Boundary (keystone, composite)
- **Purpose:** resolve exactly one boundary via auto or manual paths.
- **Layout:** intro copy; **Find-my-farm block** (S6/S7/S8 embedded); divider; **Import/Draw block** (S9/S10/S11 embedded).
- **Elements:** everything from the sub-screens below, feeding one `boundary`.
- **States:** boundary set (preview visible) vs empty (Next disabled); inline `boundaryError` (red) after a 422 bounce; offline → Find-my-farm collapses to Info note.
- **Nav:** Back → S4, Next → S12 (Parcels). **Gestures:** vertical scroll; map gestures within embedded map.

### S6 — Find-my-farm: address lookup (within S5)
- **Purpose:** resolve boundary by address.
- **Layout:** "Find my farm" header + explainer; address input + **Find** button (row).
- **Elements:** text input (keyboard type: default, returnKey "search"); Find button (cobalt, spinner when busy, disabled empty/busy).
- **States:** idle / searching (spinner) / result line (S8). Offline/unconfigured → replaced by Info note.
- **Nav:** result flies map (S7). **Gestures:** tap; keyboard submit.

### S7 — Find-my-farm: satellite globe / PinMap (within S5)
- **Purpose:** drop a pin to locate the farm.
- **Layout:** 440-tall map card; frosted overlay chip top-left; zoom control top-right; "Use my location" button.
- **Elements:** MapLibre satellite globe (Esri imagery; globe + atmosphere on capable GPUs, flat map otherwise); cobalt pin marker; overlay chip ("Tap the map to drop a pin on your farm" / "Locating…"); zoom controls; GPS button.
- **States:**
  - *Intro:* bounded ≤7s auto-spin, stops on first touch.
  - *Busy:* "Locating…".
  - *Located:* flyTo centroid, marker settles.
  - *Map failure:* static fallback card ("Pin-drop map unavailable — use address search or import below").
  - *Offline:* map shows last-cached tiles; pin lookup shows "Pin lookup needs a connection — draw or import instead."
- **Nav:** pin → point lookup → S8. **Gestures:** tap (drop/move pin), pinch-zoom, pan, rotate (globe).

### S8 — Find-my-farm: result & status line (within S5)
- **Purpose:** honest result feedback.
- **Layout:** a single banner/note below the map.
- **Elements/States:**
  - *found (exact, T2):* green banner "Found your parcel — {address} · {area} ha. Not right? Adjust below or import manually."
  - *found (approximate, T3):* amber banner "Located your farm — {address} · {area} ha. This is an approximate outline — drag its corners below to trace your exact boundary."
  - *notfound:* neutral note.
  - *error:* neutral note + message.
  - *unconfigured/offline:* Info note (collapses the whole block).
- **Nav:** none (feeds boundary + editor). **Gestures:** none.

### S9 — AI Auto-trace (within S5)
- **Purpose:** SAM2 field segmentation from a known point.
- **Layout:** full-width wand button + sub-note area.
- **Elements:** "Auto-trace field with AI" button (wand; spinner + "Tracing your field…" when busy); disabled until a point exists or when offline (with reason).
- **States:** idle / tracing / unavailable ("AI auto-trace isn't live yet") / empty ("No clear field detected here") / error. Result drops a **T3 screening**-badged polygon into the editor and flies to zoom 15.
- **Nav:** feeds S11 editor. **Gestures:** tap.

### S10 — Boundary import: mode toggle + file/paste (within S5, also compact in parcels/zones)
- **Purpose:** manual boundary via file, paste, or draw.
- **Layout:** segmented toggle (Import file | Paste GeoJSON | Draw); mode body.
- **Elements:**
  - *Import file:* tap-to-browse drop zone (expo-document-picker; accepts .geojson/.json/.kml/.zip); share-sheet intake; "Reading…" busy; inline error banner.
  - *Paste GeoJSON:* monospace text area + "Parse GeoJSON" button; inline errors.
  - *Draw:* see S11.
- **States:** busy; parse error (specific messages); notice line ("kept largest of N polygons" / "N polygons loaded"). All offline-capable.
- **Nav:** parsed geometry → S11 preview. **Gestures:** tap; long-press paste; text selection.

### S11 — Boundary preview + geometry readout + on-map draw/edit (within S5)
- **Purpose:** confirm and refine the boundary; deliver the "drag corners" promise.
- **Layout:** satellite preview map (renders once geometry exists); summary row; (Draw mode) vertex-edit toolbar.
- **Elements:** cobalt fill+line rendering fit-to-bounds; summary row (source label, area ha, "{n} pts", Clear button); **vertex handles** (draggable) with add/delete affordances; undo/redo.
- **States:** geometry set → preview; map failure → static card ("area {ha} · {type} — boundary is valid and will be saved"); T3 badge persists on approximate/AI shapes until user edits/confirms; offline → last-cached tiles or plain draw canvas.
- **Nav:** Clear resets; edits update `boundary`. **Gestures:** drag vertex, tap-to-add, long-press-to-delete, tap-close-ring, pinch/pan, undo swipe.

### S12 — Step 2: Parcels
- **Purpose:** optional named sub-boundaries.
- **Layout:** section "Parcels" + **Add parcel** button; list of parcel cards or empty state.
- **Elements:** per card: "Parcel N name" input, Remove (trash), compact `polygonOnly` boundary editor (S10/S11 at 180-tall). Empty state: dashed "No parcels yet."
- **States:** empty; per-parcel geometry set/cleared; "kept largest polygon" note.
- **Nav:** Back → S5, Next → S13. **Gestures:** tap Add/Remove; map gestures in each editor; list scroll.

### S13 — Step 3: Monitoring zones (ZoneIntentEditor)
- **Purpose:** per-area monitoring intent.
- **Layout:** section "Monitoring zones" + **Add zone**; list of zone cards or empty state.
- **Elements:** per card: numbered badge + Remove; Zone name input; Zone **type** picker (5 types); two intent toggles; two segmented pickers (Vegetation priority / Alert sensitivity); parcel-attach chips (None + parcels-with-geometry); compact zone boundary editor; per-zone geomError inline.
- **States:** empty; type-change re-seeds intent defaults; per-zone geometry error (from 422 bounce).
- **Nav:** Back → S12, Next → S14. **Gestures:** tap toggles/segments/chips; map gestures; scroll.

### S14 — Step 4: Review & create
- **Purpose:** final verify + commit.
- **Layout:** read-only summary list; error banner (conditional); Create action row.
- **Elements:** summary rows (name/types/crops/supplier/boundary/parcels/zones with Missing markers); **Create farm** button (cobalt, "Creating…" busy, disabled until ready); helper text listing missing requirements; create-error banner (with partialFarmId note when applicable).
- **States:** not-ready (button disabled + helper); creating; error (taxonomy per G3); **offline → "Queue create"** variant ("You're offline — this farm will register when you reconnect").
- **Nav:** Back → S13; success → S15; error → jumps to owning step (S5 or S13). **Gestures:** tap; scroll.

### S15 — Success screen
- **Purpose:** terminal confirmation + next actions.
- **Layout:** centered celebration card.
- **Elements:** PartyPopper icon; "{name} is now under monitoring"; copy about AOI ingest; stats row (Farm ID mono, parcels, zones); **View on portfolio** button; optional **Run first scan now** button (H1).
- **States:** normal; queued variant ("Pending sync — will register when back online") when created offline; scan-unavailable note (503).
- **Nav:** View on portfolio → S1 (draft cleared). **Gestures:** tap.

---

## 4. OFFLINE BEHAVIOR

| Capability | Offline behavior |
|---|---|
| Enter wizard / permission gate | **Works.** Role decoded from cached 8h JWT; gate (S2) or wizard renders correctly offline. |
| Draft persistence (all steps) | **Works & is the offline foundation.** Every field/boundary/parcel/zone + current step autosaves to expo-sqlite/Drizzle (debounced); survives background/reload; "Resume draft". |
| Step 0 basics (name/types/crops) | **Works.** Preset type/crop lists bundled. Free-text add works. |
| Supplier picker | **Read-only from cache.** Falls back to "Direct only" if never cached. |
| Find-my-farm address lookup | **Blocked → honest note.** Whole Find block collapses to the Info note; may offer device geocoder (expo-location) opportunistically. |
| Pin-drop globe | **Degraded.** Map shows last-cached tiles / flat fallback; pin *lookup* shows "needs a connection"; user can still drop a pin to seed a draw. |
| AI auto-trace | **Blocked.** Button disabled with "needs connection"; T3 honesty preserved. |
| File import / paste GeoJSON | **Works.** Fully client-side parsing. |
| Satellite preview | **Degraded.** Last-cached tiles or static area/pts card ("boundary valid, will be saved"). Area/vertex math is local. |
| Draw / drag-vertex editing | **Works.** Pure geometry + native map (cached tiles) or plain draw canvas. |
| Parcels & zones editing | **Works.** All local; intent presets bundled. |
| Review summary | **Works.** All computed locally. |
| **Create farm (POST)** | **Queued.** Cannot POST offline; the create is enqueued with idempotency awareness, syncs on reconnect (farm → parcels → zones order preserved), and surfaces a "pending sync" farm entry. |
| Scan handoff | **Queued.** aoi/from-geom + scan enqueued; push (expo-notifications) delivers farm.complete later. |

**Sync rules:** queued creates run sequentially on reconnect; a client-generated idempotency key guards against duplicate farms if a retry races a slow server ack. Partial-success (farm created, child failed) resumes from the failed child, never re-POSTing the farm.

---

## 5. COVERAGE MAP (inventory feature → screens/stories)

| # | Inventory feature | Priority | Screens | Stories |
|---|---|---|---|---|
| 1 | Onboarding Copilot wizard shell (5-step, rail, footer, entry CTA, draft state) | P0 | S1, S3, S4–S14 | A1, A2, A3, A6 |
| 2 | Permission gate (operator-only) | P0 | S2 | B1 |
| 3 | Step 0 — Farm basics (name/types/crops/supplier) | P0 | S4 | C1 |
| 4 | Step 1 — Boundary acquisition (composite) | P0 | S5 (+S6–S11) | D1 |
| 5 | Find-my-farm — address lookup | P0 | S6, S8 | D2, D4 |
| 6 | Find-my-farm — drop-a-pin satellite globe (PinMap) | P0 | S7 | D3 |
| 7 | Find-my-farm — result & status states | P1 | S8 | D4 |
| 8 | AI Auto-trace field (SAM2, T3) | P1 | S9 | D5 |
| 9 | BoundaryImport — file import | P0 | S10 | D6 |
| 10 | BoundaryImport — paste GeoJSON | P1 | S10 | D7 |
| 11 | BoundaryImport — satellite preview + geometry readout | P1 | S11 | D8, **D9** (mobile-added on-map vertex editing) |
| 12 | Step 2 — Parcels (optional, repeatable) | P1 | S12 | E1 |
| 13 | Step 3 — Monitoring zones (ZoneIntentEditor) | P1 | S13 | F1 |
| 14 | Step 4 — Review & create | P0 | S14 | G1, G2 |
| 15 | Create error handling & taxonomy | P1 | S14 (+ jumps to S5/S13) | G3, J5, J6 |
| 16 | Success screen | P1 | S15 | G4 |
| 17 | Onboarding → AOI-from-geom → scan handoff | P2 | S15 (+ push) | H1 |

**Coverage: 17/17 inventory features (all 15 listed + the 2 relay/handoff surfaces) mapped. No gaps.**

### Mobile enhancements beyond web parity (noted, not required for parity)
- **On-map vertex drag/add/delete (D9/S11):** delivers the "drag corners to trace your exact boundary" copy that web onboarding only *promises* (web defers editing to Studio).
- **Offline-first draft autosave (A6):** web draft is in-memory only; mobile persists it.
- **"Use my location" GPS pin (D3):** native-only convenience.
- **Queued offline create + push-driven scan (G2/H1):** resumable, idempotent sync.

### Honesty-tier compliance checklist
- T2 cadastral shown exact; T3 (OSM + AI trace) always flagged "approximate" with a "trace exact" nudge and a persistent screening badge on AI shapes — carried into S8/S9/S11.
- Every degraded path (503 unconfigured, vision 404, map/GL failure, OSM miss, offline) collapses to an honest note and never blocks the manual boundary path — S5/S7/S8/S9/S11.
- Nothing fabricated; boundary always user-confirmed before Create.
