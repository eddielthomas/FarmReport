# Report.Farm Mobile — Digital Twin Studio (Map + Authoring)

**Platform:** Expo + React Native + TypeScript · expo-router · offline-first (expo-sqlite + Drizzle) · maps via `@maplibre/maplibre-react-native` · 3D cutaway via `expo-gl` + `three` · background jobs via `expo-task-manager` + `expo-notifications` · camera via `expo-camera`.
**Design language:** Report.Farm cobalt accent (`#4C7EFF`), teal signal accent (`#2DD4BF`), amber annotations (`#F59E0B`), near-black field surfaces (`#0b0a08` / `#05060a`), dark-first with light support. Native feel: bottom sheets over side panels, tab bars over top rails, gesture-first authoring, haptics on commit.

> **Source of truth:** this doc maps the web Digital Twin Studio (`studio.html` → `StudioMap` / `TwinStudio` / `TwinDetail`) to a native app with **100% feature parity** plus the offline-first + background-task upgrades the web app cannot do. Every inventory feature is proven covered in the [Coverage Map](#coverage-map).

---

## 0. Guiding principles carried from the web app

1. **Honesty tiers are load-bearing.** Every signal carries `tier` (T1 regulatory / T2 evidence / T3 screening), `measurement`, `confidence`, and honest-null `cloudPct` / `sceneId`. The gateway records NDVI/EVI as `no_producer` and **never fabricates**. Mobile renders honest-empty states verbatim: *"No signals yet — run a scan"*, *"Gateway not connected"*. Never invent a value to fill a card.
2. **Offline-first is a real upgrade, not a fallback.** Web twins live only in `localStorage` (per-browser, no sync). Mobile replaces that with a **SQLite store + a sync queue**, so twins survive reinstalls, sync across the operator's devices, and author fully offline. Undo/redo persist (web loses them on reload).
3. **Long builds run in the background.** An HD-twin build takes 5+ minutes. Mobile drives it via a background task + a completion push notification, so the operator can lock the phone and get pinged when the twin lands.
4. **Gestures replace keyboard + mouse.** Right-click → long-press; double-click-finish → an explicit **Finish** pill; `Cmd+Z/D/Del` → on-screen buttons + a floating action cluster; drag-vertex → large touch handles with a magnifier loupe.
5. **Degrade gracefully.** WebGL/GL unavailable → static fallback cards for both the map and the 3D cutaway, exactly like the web `failed` and `Cutaway unavailable` states.

---

## 1. Roles & permissions

The web surface is gated by `role-gate.js` with `data-surface="operations.html"` → requires `ops:manage` / `ops.coordinator` / `platform:admin`. Mobile keeps that as the **authoring** gate but adds a **read-only viewer** tier so buyers/leads can inspect twins without editing.

| Role | Studio access | Author (place/edit/delete) | Run scans | Notes |
|---|---|---|---|---|
| **Farm Operations** (`ops:manage`) | Full | ✅ | ✅ | Primary author. Owns the twin library for their farms. |
| **Grower** (`farm:onboard`/`ops.coordinator`) | Full for own farms | ✅ (own farms) | ✅ | Authors their own property; property picker scoped to owned farms. |
| **Portfolio Lead** (`farm:view` + ops) | Full if ops role present; else read-only | ✅ if ops | ✅ if ops | Typically monitors; can drill into any portfolio farm's twins. |
| **Buyer Admin** (`farm:view`) | **Read-only viewer** | ❌ | ❌ | Sees twins/signals for supplier farms in scope; tool rail hidden, inspector read-only, scan button replaced by "View only". |

- Read-only mode: hide the tool rail, drawing FAB, and all mutate CTAs; show a "Viewing as <role>" chip; taps still select + open the read-only inspector.
- The gate is enforced at the expo-router layout level (`(studio)/_layout.tsx` guard) reading the decoded JWT roles from `auth-store`; a denied user sees a "Studio requires operations access" screen with a link back to Mission Control.

---

## 2. Navigation architecture (expo-router)

The three web surfaces (query-string routed in `main-studio.tsx`) become native routes. A **bottom tab bar** anchors the domain; deep screens push modally.

```
app/(studio)/
  _layout.tsx                 → role guard + StudioHeader context (property, surface-mode)
  map.tsx                     → StudioMap  (default tab: "Map")        ← studio.html
  explorer.tsx                → TwinStudio grid (tab: "Twins")         ← ?view=explorer
  twin/[id]/_layout.tsx       → TwinDetail hero + material top-tabs    ← ?twin=<id>
  twin/[id]/overview.tsx
  twin/[id]/telemetry.tsx
  twin/[id]/maintenance.tsx
  twin/[id]/calendar.tsx
  twin/[id]/docs.tsx
  jobs.tsx                    → Scan Jobs dock (tab: "Jobs", badge = running count)
  (modals)/
    object-library.tsx        → catalog picker sheet
    property-picker.tsx        → farm switcher sheet
    signals.tsx               → live signals + Build HD twin sheet
    annotate.tsx              → note/issue/task input + camera
    layers.tsx                → layer + opacity sheet
    season.tsx                → season timeline / history scrubber sheet
```

- **Bottom tabs:** Map · Twins · Jobs · (Menu). The Twin detail stack replaces the tab bar with its own top material-tab bar (Overview/Telemetry/Maintenance/Calendar/Docs).
- **Surface mode** (dark/light) read from persisted `rwr.surface-mode` (SQLite/AsyncStorage) — mirrors web `localStorage`.
- **Header (shared `StudioHeader`):** left = Report.Farm home (→ Mission Control tab / `operations` app), center = breadcrumb ("Studio / Property Map" ‧ "Studio / Explorer" ‧ "Twin name"), right = property chip + layer chip.
- **Back semantics:** hardware back on Twin detail → Explorer or Map (whichever launched it); on modals → dismiss sheet, keeping map state.

---

## 3. Epics & user stories

Acceptance criteria are written as testable Given/When/Then. Roles in each story are drawn from the matrix above.

### EPIC A — Studio shell, navigation & access

**A1. Enter the studio by role.**
*As a Farm Operations user, I want to open the Studio and land on my property map, so that I can start authoring immediately.*
- Given I have `ops:manage`, when I open the Studio tab, then the Map screen renders with my first/last-used property fitted to view.
- Given I am a Buyer Admin (`farm:view` only), when I open the Studio, then I see a read-only map (no tool rail, no drawing FAB, "Viewing as Buyer" chip).
- Given I lack any studio role, when I try to open it, then I see a "requires operations access" gate screen with a Mission Control link.

**A2. Move between the three surfaces.**
*As a Grower, I want to jump between the map, the twin grid, and a twin's workspace, so that I can work the way that suits the task.*
- Given I'm on the Map, when I tap the Twins tab, then the Explorer grid opens filtered to the active property.
- Given I tap a twin (card or map object), when it opens, then the Twin detail stack pushes with that twin's `id` and the breadcrumb shows its name.
- Given I'm deep in a Twin detail tab, when I press hardware back, then I return to the surface I came from with map camera + selection preserved.

**A3. Persist surface mode.**
*As any user, I want my dark/light choice remembered, so that the app matches my preference across sessions.*
- Given I set light mode, when I relaunch, then the Studio renders in light mode (persisted).

### EPIC B — Property authoring map

**B1. See my property on satellite.**
*As a Farm Operations user, I want a full-bleed satellite map fitted to my property, so that I can place assets accurately.*
- Given a property with an AOI bbox, when the map loads, then it fits `[west,south]→[east,north]` with padding and draws the boundary fill + dashed line.
- Given a property with no AOI, then the map flies to its centroid at a sensible zoom.
- Given GL cannot start, then a "Map needs WebGL/GL" fallback card shows with a retry.
- Given I'm offline with cached tiles, then the last-viewed area still renders; uncached areas show a subtle "offline — cached tiles only" watermark.

**B2. Switch visual layers & opacity.**
*As a Grower, I want to tint the basemap as NDVI/moisture/thermal and dim it, so that I can read field conditions at a glance.*
- Given the layer sheet, when I pick NDVI/moisture/thermal/satellite, then the basemap re-paints with that layer's saturation/hue/contrast transform.
- Given the opacity slider (0.2–1), when I drag it, then raster opacity updates live.
- Acceptance: these are **simulated colorizations**, labeled "visual approximation — not measured EO" so no one mistakes them for real rasters (honesty).

**B3. Isolate my property.**
*As a Portfolio Lead reviewing one farm, I want everything outside the boundary dimmed, so that I can focus on it.*
- Given a property with a boundary, when I toggle Isolate, then a 60% dark mask covers the world with the property polygon punched out (handles MultiPolygon; latitude clamped).
- Given no boundary, then Isolate is disabled with a tooltip "needs a drawn boundary".

**B4. Toggle labels.**
*As an operator, I want to hide twin name labels, so that a dense map stays readable.*
- Given labels on (default), when I toggle Tag, then twin text labels hide/show.

### EPIC C — Authoring tools & object placement

**C1. Place an asset from the object library.**
*As a Farm Operations user, I want to pick a barn/tractor/field from a catalog and drop it on the map, so that I can build my farm's digital twin.*
- Given the Object Library sheet (7 categories, ~62 items), when I pick an item, then the app arms the matching placement tool (point→tap, rect/circle→drag, polygon→tap-corners, polyline→tap-vertices) and a hint banner shows the item icon + instructions.
- Given I place the geometry, then a twin is created from the catalog defaults, selected, and its inspector opens; a haptic tick fires on commit.
- Given no property is selected, then placement is blocked with "Select your property to begin".

**C2. Draw precise geometry with touch.**
*As a Grower, I want to draw fields, rows, rectangles, and circles by touch, so that shapes match reality.*
- Point: tap once → dropped.
- Rectangle/Circle: press-drag → live preview → release commits (meters via haversine; <1 m ignored).
- Polyline/Row: tap vertices, tap **Finish** (or double-tap) to commit (min 2 pts).
- Polygon/Parcel: tap corners, tap **Finish** to save (min 3 pts).
- Given a draft in progress, when I tap **Undo last point** (or long-press map), then the last vertex is removed; **Cancel** discards.

**C3. Select, move, and transform a twin.**
*As an operator, I want to tap to select and drag to reposition a twin, so that I can correct placement.*
- Given Select tool, when I tap a twin, then it's selected and the inspector opens; tapping empty deselects.
- Given a selected twin, when I drag it, then its whole geometry translates by the lng/lat delta; a grab cursor/haptic indicates drag.
- Given the inspector numeric editors, when I change rect width/height/rotation, circle radius, or point scale/rotation, then the map updates live.

**C4. Edit a boundary vertex-by-vertex.**
*As a Farm Operations user, I want to fine-tune a field's boundary, so that acreage is accurate for reports and scans.*
- Given the Edit tool + a selected polygon/polyline twin, then draggable vertex handles + add-vertex midpoint handles render.
- Drag a vertex → moves it; tap a midpoint → inserts a vertex; **long-press a vertex → delete** (min 3 for polygons; touch equivalent of right-click).
- Given a non-poly twin selected, then a hint says "select a field/parcel twin first".

**C5. Duplicate / delete / undo / redo.**
*As an operator, I want quick edit actions without a keyboard, so that authoring is fast on a phone.*
- Given a selected twin, the action cluster exposes Duplicate, Delete, Undo, Redo.
- Undo/redo drive a **persisted** 50-entry stack (improvement over web's in-memory stack); redo clears on a new edit.

### EPIC D — Annotations, measurement & field notes

**D1. Drop a note / issue / task.**
*As a Grower walking a field, I want to drop a labeled marker with a photo, so that I capture what I see where I see it.*
- Given the Note/Issue/Task tool, when I tap the map, then a native input sheet asks for a label (defaults "Note"/"Issue observed"/"Field task") and optionally a **camera photo** (expo-camera) + auto GPS.
- Given I confirm, then a colored marker drops (white=note, red=issue, amber=task) and appears in the History list with a count.
- **Upgrade:** annotations persist to SQLite (web keeps them in memory only and loses them on reload).
- Given I tap a marker, then a popup shows the label + thumbnail.

**D2. Measure distance.**
*As an operator, I want to tap points and read distance, so that I can size a run or spacing.*
- Given the Measure tool, when I tap points, then a dashed line + dots render and the running total (haversine meters/feet) shows in a chip; double-tap or **Reset** clears.

### EPIC E — Property selection & scoping

**E1. Switch the active property.**
*As a Portfolio Lead, I want to pick which farm I'm viewing, so that I can work across the portfolio.*
- Given the property sheet, then farms load from `GET /farm/farms` with a check on the active one; picking one clears selection, fits the map to its AOI, filters twins to `parcelId === propertyId`, and rebinds signals.
- Given no farms, then the sheet shows an empty state linking to Onboarding.
- Given no property selected, then orphan twins (no `parcelId`) show and a "Select your property to begin" prompt appears.
- **Offline:** farm list is cached to SQLite; picker reads the cache and marks it "cached" if stale.

### EPIC F — Live intelligence: signals & HD-twin scans

**F1. See honest live signals.**
*As a Farm Operations user, I want to see real EO signals over my property with their honesty tier, so that I trust what I act on.*
- Given a property AOI, when I open the Signals sheet, then it fetches `signals-by-bbox` and shows a count + teal dots on the map.
- States rendered verbatim: **idle** (no AOI), **loading**, **unconfigured** ("Connect the AlphaGeo gateway"), **error**, **ready** (count).
- Each signal chip shows `measurement`, `value`, `confidence`, `tier` badge (T1/T2/T3), and honest nulls for `cloudPct`/`sceneId` ("—", never faked).
- Honest-empty: "No signals yet — run a scan." No fabricated NDVI/EVI (gateway returns `no_producer`).
- **Offline:** last-fetched signals render from cache with a "cached · last synced <time>" banner; no live refetch.

**F2. Build an HD twin in the background.**
*As a Grower, I want to launch a high-def twin build and keep working, so that a 5-minute job never blocks me.*
- Given the Signals sheet, when I choose producers (SAR/Moisture/Thermal; superres supported) and tap **Build HD twin**, then the app registers the polygon (`aoi/from-geom`) → `scan` → gets a 202 jobId → shows "queued (~5 min)" and adds a Jobs card.
- Given a polygon twin is selected, then its refined ring is scanned; else the property AOI bbox.
- Given the gateway is unconfigured, then it surfaces "Gateway not connected" (not an error toast).
- Given the build runs, then a **background task** drives the SSE stream (`jobs/:id/events`: `farm.progress`→`farm.complete/error`) with %/stage/elapsed; on complete it pulls `twins/:aoiId`, materializes the field twin (polygon + indicators/signals/orbiters/rasters as readings), and fires a **push notification** "HD twin ready".
- Given I navigate away or lock the phone, then the job survives; on return the Jobs dock resumes it (reconnect on stream drop, poll twins as source-of-truth, 12-min timeout).
- Given a job finishes, then **View HD twin** selects it and flies the map to it; I can dismiss a card or "Clear N finished".

### EPIC G — Twin inspector & right-panel intelligence (map context)

**G1. Inspect and edit the selected twin.**
*As an operator, I want a quick inspector for the twin I tapped, so that I can rename, re-status, resize, and jump to full detail.*
- Given a selection, the inspector sheet shows: editable name, icon chip, category/kind + acreage, Duplicate/Delete/Online toggle, health bar, geometry numeric editors, live readings grid, "Edit specs/maintenance/docs" CTA, and a **Full detail** link (→ Twin workspace).
- Given no selection, the sheet shows +Add twin, the SignalsCard, and the full twin list for the property (icon, name, category/kind, online dot).

**G2. Read analytics, history & reports in context.**
*As a Portfolio Lead, I want NDVI/moisture/yield trends, a season timeline, and available reports beside the map, so that I get context without leaving.*
- Analytics: three 12-month sparkline cards (NDVI 0.66 +0.03, Moisture 22% stable, Yield 184 +3.2%) — **labeled "demo data"** until real cached indicator series exist (honesty).
- History: a season scrubber (0–11 months) synced with the bottom timeline, demo season events (Planting/Fertigation/NDVI peak/Harvest) lit up to the scrub point, and the annotations list.
- Reports: static list (Season-to-date, Crop insurance MRV, Water balance, Lender covenant) with **Open** routing to the Reports domain (stub today; disabled with "generate from farm detail" note).

**G3. Scrub the season & jump between twins from the bottom strip.**
*As a Grower, I want a carousel of my twins and a month scrubber, so that I can hop around the property and see the season.*
- Given the bottom strip, when I tap a twin chip (icon, name, kind + acreage), then it selects + flies to it.
- Given the season slider (Jan–Dec), when I scrub, then the current month + NDVI value update (shared `timeIndex` with History).

### EPIC H — Twin Explorer (grid)

**H1. Browse, search & filter twins.**
*As a Farm Operations user, I want a searchable grid of all my twins, so that I can find and open any asset.*
- Given the Explorer, then twins render as cards (icon chip, name, category·kind, online dot, up to 4 reading tiles, updated date), sorted by `updatedAt`.
- Category filter pills (All + Structures/Equipment/Crops&Beds/Livestock/Water…) show counts; search matches name+kind.
- Given a card, tap → workspace; swipe/long-press → Delete (confirm).
- Given no twins, then an empty state ("No twins yet 🌱") with a New twin CTA.

**H2. Create a twin from the catalog.**
*As a Grower, I want to create a twin without drawing on the map, so that I can register an asset quickly.*
- Given +New twin, then a Create sheet (category tabs + catalog grid) opens; picking an item creates the twin (default AOI + jitter) and navigates to its workspace.

### EPIC I — Twin workspace (per-twin dossier)

**I1. Twin hero & lifecycle.**
*As an operator, I want a dossier header with health, status, and lifecycle actions, so that I manage the asset over time.*
- Hero: large icon, category·kind·ID, inline-editable name (autosave "Saving/Saved"), status pill (online toggle), placed/updated dates, health metric ring, Readings/Logs/Docs stat counts, Duplicate, Delete (confirm → back).
- Given a bad/missing id, then a "Twin not found" screen (SQLite is device-local until synced) with Back to Studio.

**I2. Overview.** Summary/specs (Vendor/Installed/Size/Cost), telemetry preview sparklines, recent maintenance (last 3), the **3D parcel cutaway** + geometry facts, quick-jumps to Telemetry/Maintenance.

**I3. Telemetry.** Online toggle, live readings grid with per-reading sparkline + remove, add-channel form (Label/Value/Unit), channel count. Manual entry offline; ready to ingest live IoT later.

**I4. Maintenance.** Log form (Date/Type/Notes) prepending a timeline; per-entry delete; count in title. Native date picker.

**I5. Calendar.** Month grid (prev/Today/next), events colored by kind (task/scan/treatment/harvest/maintenance/note), today highlighted, +N overflow; schedule form (Title/Date/Time/Kind); upcoming list (next 6) with done-toggle + delete. **Upgrade:** optional device-calendar sync + `expo-notifications` reminders.

**I6. Docs.** Attach form (Name + URL) **or native file/photo picker** (expo-document-picker/camera → local file), attachment grid with open/delete, count in title.

**I7. 3D geological cutaway.**
*As a Grower, I want a rotating 3D land-slice of my parcel, so that I can visualize soil under the field.*
- Given GL is available, then a slowly-rotating block renders: top = composited Esri satellite tiles over the twin center (zoom 18), sides = soil strata (procedural → bundled `soil-strata` texture, horizons topsoil→bedrock), overlay = parcel id + acreage + "Geological cutaway" badge.
- Given GL missing or tiles unreachable offline, then a static "Cutaway unavailable" fallback card.

### EPIC J — Data, offline & sync (platform)

**J1. Offline-first twin store.**
*As a field operator with no signal, I want to author twins offline, so that connectivity never blocks my work.*
- Given no network, then create/edit/delete/duplicate twins and log maintenance/events/docs all persist to SQLite; a sync badge shows "N pending".
- Given connectivity returns, then queued mutations flush to the server (a capability the web app lacks) and cross-device sync reconciles by `updatedAt` (last-writer-wins with conflict surfacing).
- Given the same twin edited on two devices, then the later `updatedAt` wins and a "resolved conflict" toast notes it.

**J2. Persistent undo/redo & cross-device.**
- Undo/redo stacks persist per device (50-entry limit) and survive relaunch.

---

## 4. User journeys

### Journey 1 — Author a farm from scratch (happy path, Farm Operations)
1. Open Studio → Map tab; property auto-selected, map fits AOI, boundary drawn.
2. Tap the **＋ (Object Library)** FAB → Structures → Barn.
3. Press-drag a rectangle over the barnyard → release → haptic → barn twin created + inspector sheet slides up.
4. Rename "Barn" → "North Barn"; toggle online; close sheet.
5. Pick **Crop Field** (polygon) → tap 5 corners → tap **Finish** → field twin created.
6. Switch to **Edit** tool → drag two vertices to match the tree line → long-press a stray vertex → delete.
7. Open **Signals** sheet → see T2/T3 signals over the AOI → select SAR+Moisture → **Build HD twin** → "queued (~5 min)" → Jobs badge = 1.
8. Keep placing a pivot + soil sensor while the job runs.
9. Phone buzzes: "HD twin ready" push → tap → Jobs dock → **View HD twin** → map flies to the composed field polygon with indicator readings.

### Journey 2 — Field walk with issues (Grower, mostly offline)
1. In a dead-zone field, open Studio (cached tiles render, "offline" watermark).
2. Tap **Issue** tool → tap the wet spot → sheet: label "Standing water NE", snap a **photo**, GPS auto-filled → save → red marker + History count +1 (persisted to SQLite).
3. **Measure** the wet patch: tap 4 points → chip reads "~38 m perimeter".
4. Everything is queued; sync badge "3 pending".
5. Back at the truck (signal returns) → queue flushes → "Synced".

### Journey 3 — Buyer reviews a supplier farm (Buyer Admin, read-only)
1. Open Studio → "Viewing as Buyer" chip; no tool rail/FAB.
2. Property picker → choose supplier farm → map fits AOI, twins render.
3. Tap a field twin → **read-only** inspector: name, acreage, health, live readings, signals with T1/T2/T3 tiers and honest nulls.
4. Open Analytics → NDVI/moisture/yield sparklines (labeled demo).
5. Cannot Build HD twin (button shows "View only").

### Journey 4 — Resume a long build across app restart (edge)
1. Launch a scan → background task begins driving SSE.
2. Force-quit the app.
3. Reopen hours later → Jobs dock reads the persisted job → re-checks `twins/:aoiId` as source-of-truth → build had finished → materializes the twin + marks the card complete → "HD twin ready".

### Journey 5 — Twin dossier lifecycle (Farm Operations)
1. Explorer → search "pivot" → open Center Pivot workspace.
2. Overview → read specs, watch the 3D cutaway rotate.
3. Telemetry → add channel "Flow / 820 / gpm".
4. Maintenance → log "Service · greased gearboxes".
5. Calendar → schedule "Nozzle check" next Tue → toggle a reminder.
6. Docs → attach a manual PDF via file picker.
7. Hero autosaves throughout ("Saved").

### Edge / error paths
- **GL unavailable:** map + cutaway show static fallback cards; authoring still possible via Explorer/Create sheet + numeric editors.
- **Gateway unconfigured:** Signals sheet shows "Connect the AlphaGeo gateway"; Build HD twin returns "Gateway not connected"; nothing throws.
- **Scan timeout (>12 min):** Job card → error "Timed out waiting for the backend" with Retry.
- **Twin not found:** deep link to a deleted/other-device twin → "Twin not found" + Back to Studio.
- **No property / no farms:** "Select your property to begin"; picker links to Onboarding.

---

## 5. Screens

### 5.1 Map (StudioMap) — primary authoring surface
- **Purpose:** full-bleed satellite map for placing/editing twins, viewing signals, launching scans.
- **Layout:**
  - Full-screen `MapView` (MapLibre RN, Esri World Imagery raster, 2D/`maxPitch 0`, zoom-only nav control bottom-right).
  - **Header:** home ‧ breadcrumb "Studio / Property Map" ‧ property chip (Sprout icon + name) ‧ layer chip.
  - **Left tool rail** → collapses on phones into a **vertical floating tool dock** (scrollable) OR a **radial/segmented tool sheet** invoked by a **Tools FAB** bottom-left. Grouped: Select · Edit · Note/Issue/Task · Measure · Zone · Parcel · Library · Rect · Circle · Row · Duplicate · Delete · Undo · Redo · Isolate · Labels · Analytics/History/Reports jumps. Active tool highlighted; each has a label on long-press.
  - **Opacity slider:** vertical slider surfaced in the Layers sheet (0.2–1).
  - **Contextual hint banner** (top, below header): current tool instructions + **Cancel** and, for multi-vertex tools, **Undo point** + **Finish**.
  - **Bottom parcel strip:** horizontal FlatList of up to 12 property twins (icon, name, kind + acreage) → tap selects + flies.
  - **Season timeline card** (collapsible, above tab bar): 12-month NDVI slider (Jan–Dec) with current month + value.
  - **Right-panel intelligence** → a **bottom sheet with segmented tabs** (Twin · Reports · Analytics · History), snap points [peek/half/full]. Auto-opens to Twin on selection.
  - **Signals dots** (teal glow+dot) + **annotation markers** + **draft/edit handle** layers overlaid.
- **Elements:** MapView, NavControl, property boundary layers, twin poly/line/point/label layers, signal glow/dot layers, draft/zone/measure/edit-vert/edit-mid layers, mask-fill (isolate), tool dock, hint banner, FABs (Tools, Object Library ＋, Signals ⚡), property chip, layer chip, bottom strip, season slider, intelligence sheet.
- **States:** loading (skeleton map + shimmer), ready, **failed** (GL) → fallback card, offline (cached-tiles watermark), no-property ("Select your property to begin"), read-only (rail/FAB hidden).
- **Gestures:** pan/pinch-zoom (map); tap (select/place/vertex); press-drag (rect/circle/move/vertex-drag); double-tap or Finish (polyline/polygon/zone); long-press (delete vertex / undo last point / tool label); swipe-up (intelligence sheet).
- **Nav in:** Studio tab, deep link, "View HD twin", bottom-strip/annotation taps. **Nav out:** Twins tab, Twin detail (Full detail / tap object), modals (Library/Property/Signals/Layers/Season/Annotate), Jobs.

### 5.2 Object Library (modal sheet)
- **Purpose:** pick a catalog item (~62 across 7 categories) to place.
- **Layout:** category tab bar (Structures/Equipment/Crops&Beds/Fields&Zones/Livestock/Water/Access&Utility) with counts; grid of emoji-icon buttons (name + geom-type hint). Search field.
- **States:** default, search-empty. **Gestures:** tap category, tap item → arms tool + dismisses; swipe-down to close.
- **Nav:** from Map ＋ FAB / inspector +Add / Explorer +New (as Create sheet).

### 5.3 Property Picker (modal sheet)
- **Purpose:** switch the active farm.
- **Layout:** list of farms (MapPinned icon, name, check on active); empty state → Onboarding link; "cached" tag when offline.
- **States:** loading ("Loading…"), ready, empty, offline-cached, error.
- **Nav:** from header property chip.

### 5.4 Signals & Build HD Twin (modal sheet)
- **Purpose:** live signal readout + launch background scan.
- **Layout:**
  - Status header per state: idle / loading spinner / **unconfigured** ("Connect the AlphaGeo gateway") / error / ready (count).
  - Signal list: per-signal chip with `measurement`, `value`, `confidence`, **tier badge (T1/T2/T3)**, honest-null `cloudPct`/`sceneId` shown as "—".
  - Honest-empty banner: "No signals yet — run a scan."
  - Producer toggles: SAR · Moisture · Thermal (Superres supported).
  - Scope note: "Scanning: <selected polygon twin> / <property AOI>".
  - **Build HD twin** button (disabled if no producers / read-only).
  - Result line: "HD twin build queued — runs in the background (~5 min)" or "Gateway not connected."
- **States:** idle/loading/unconfigured/error/ready, busy (launching), offline (cached + "last synced").
- **Nav:** from Signals FAB / inspector SignalsCard; success → Jobs badge increments.

### 5.5 Scan Jobs dock (tab)
- **Purpose:** track background HD-twin builds.
- **Layout:** list of Job cards: label, status (running/complete/error), progress bar (%/stage/elapsed min), **View HD twin** (complete), Retry (error), dismiss (✕); footer "Clear N finished".
- **States:** empty ("No scans running"), running, complete, error/timeout, unconfigured.
- **Behavior:** driven by background task; each running card resumes on mount; push notification on completion. Tab badge = running count.
- **Gestures:** tap View → Map flies to twin; swipe card → dismiss.

### 5.6 Annotate (modal sheet)
- **Purpose:** capture note/issue/task with photo + GPS.
- **Layout:** kind selector (Note/Issue/Task), label input (kind-default), **camera/photo** attach, auto GPS + editable pin, Save/Cancel.
- **States:** default, camera-permission-needed, saving. **Nav:** from Note/Issue/Task tool tap on map. Persists to SQLite; marker + History count update.

### 5.7 Layers & Opacity (modal sheet)
- **Purpose:** choose visual layer + dim basemap.
- **Layout:** segmented Satellite/NDVI/Moisture/Thermal (each with the "visual approximation" honesty note), vertical opacity slider (0.2–1), Isolate toggle, Labels toggle.
- **Nav:** from layer chip / tool-rail jumps.

### 5.8 Season / History scrubber (modal sheet, mirrors History tab)
- **Purpose:** scrub the 12-month timeline + review season events + annotations.
- **Layout:** month range slider (0–11) with current month + NDVI value; timeline of demo events (dots lit to scrub point, labeled "demo"); annotations list (kind + count).
- **Shared `timeIndex`** with the bottom season slider.

### 5.9 Explorer (TwinStudio grid) — tab
- **Purpose:** browse/search/filter/create twins.
- **Layout:** search bar; category filter pills (All + categories, counts); 2-col FlatList of twin cards (icon chip, name, category·kind, online dot, ≤4 reading tiles, updated date); **＋ New twin** FAB.
- **States:** loading skeletons, ready, search-empty, **empty** ("No twins yet 🌱" + CTA).
- **Gestures:** tap card → workspace; long-press/swipe → Delete (confirm); pull-to-refresh (re-read store).
- **Nav in:** Twins tab, Map breadcrumb. **Nav out:** Twin detail; Create sheet.

### 5.10 Twin detail shell (TwinDetail) — stack with material top-tabs
- **Purpose:** per-twin dossier.
- **Layout:** Hero (large icon; category·kind·ID; inline-editable name with autosave "Saving/Saved"; status pill online toggle; placed/updated; health ring; Readings/Logs/Docs stats; Duplicate; Delete). Top tab bar: Overview · Telemetry · Maintenance · Calendar · Docs.
- **States:** ready, **not-found** ("Twin not found" + Back to Studio), saving, read-only.
- **Nav in:** Explorer card, map "Full detail", "View HD twin". **Nav out:** back to origin; Duplicate stays; Delete → Studio.

### 5.11 Overview tab
- Summary/specs card (Vendor/Installed/Size/Cost or empty prompt); telemetry preview sparklines (→ Telemetry); recent maintenance (last 3 or empty → Maintenance); **3D cutaway** + geometry facts (type, radius/size, parcelId); quick-jump buttons.
- States: populated / empty prompts / cutaway fallback.

### 5.12 Telemetry tab
- Connection card (online toggle); readings grid (label/value/unit + deterministic sparkline + remove ✕); add-channel form (Label/Value/Unit → Add); channel count badge. States: has-readings / empty.

### 5.13 Maintenance tab
- Log form (native Date picker, Type select [Inspection/Repair/Service/Calibration/Replacement], Notes → Log); timeline list (date, type pill, notes, delete); count in title. States: has-entries / empty.

### 5.14 Calendar tab
- Month grid (prev/Today/next; events colored by kind; today highlighted; +N overflow); schedule form (Title/Date/Time/Kind); upcoming list (next 6) with done-toggle + delete. Optional reminder notifications. States: month view / empty upcoming.

### 5.15 Docs tab
- Attach form (Name + URL) **and** file/photo picker; attachment grid (file icon, name→open, truncated URL/path, delete); count in title. States: has-docs / empty.

### 5.16 Access-denied gate
- Shown when role lacks studio access: message "Studio requires operations access" + Mission Control link.

### 5.17 GL fallback cards
- Map fallback ("Map needs GL — retry"); Cutaway fallback ("Cutaway unavailable") — static, no crash.

---

## 6. Offline behavior

| Capability | Offline behavior |
|---|---|
| **Twin CRUD** (create/edit/delete/duplicate) | ✅ Fully offline (SQLite). Mutations queue; flush + reconcile on reconnect (`updatedAt` LWW). |
| **Undo/redo** | ✅ Offline; **persisted** 50-entry stack per device. |
| **All authoring tools** (draw/place/select/move/edit-vertex/measure/zone/parcel) | ✅ Fully offline — pure client geometry math. |
| **Object library / catalog** | ✅ Bundled static const; emoji icons render natively. |
| **Annotations (note/issue/task) + photos** | ✅ Offline; **persisted to SQLite** (web is memory-only); photos stored locally, queued for upload. |
| **Property picker / farm list** | ⚠️ Read-only offline from SQLite cache ("cached · last synced"). New farms need network. |
| **Map basemap tiles** | ⚠️ Only cached tiles render; uncached areas show "offline" watermark. Boundary + twins render from local data. |
| **Layers/opacity/isolate/labels** | ✅ Client-side paint over cached tiles. |
| **Live signals** | ❌ Needs gateway. Shows last-fetched cache + "offline / not connected"; honest tiers/nulls preserved. |
| **Build HD twin / scans** | ❌ Needs gateway. Build button shows "not connected"; queued jobs resume when back online + gateway configured. |
| **3D cutaway** | ⚠️ Strata texture bundled (renders); satellite top-face needs cached/proxy tiles → else procedural-only or fallback card. |
| **Telemetry / Maintenance / Calendar / Docs** | ✅ Fully offline (manual entry to SQLite). Doc/photo files local; URLs need network to open. |
| **Analytics / History / Reports panels** | ✅ Demo/static data offline (labeled). Real cached indicator series render if present; else honest-empty. Report "Open" needs backend. |

**Sync engine:** a `ChangeQueue` in SQLite records mutations; on connectivity (`expo-network`) it flushes to the server (twin-sync is net-new vs. web). Scan jobs persist in SQLite and are driven by a background task; completion fires a push even if the app is closed.

---

## 7. Coverage map (proves 100%)

| # | Inventory feature | Priority | Covered by screen(s) | Covered by story/epic |
|---|---|---|---|---|
| 1 | Studio routing shell (3 surfaces) | P0 | Nav architecture §2; Map 5.1, Explorer 5.9, Twin detail 5.10; Access gate 5.16 | A1, A2, A3 |
| 2 | Property authoring map (MapLibre) | P0 | Map 5.1; GL fallback 5.17 | B1 |
| 3 | Left tool rail | P0 | Map 5.1 (tool dock/Tools FAB) | C1–C5, D1–D2, B3, B4, G2 |
| 4 | Object library (catalog) | P0 | Object Library 5.2; Create sheet in 5.9 | C1, H2 |
| 5 | Geometry drawing & placement engines | P0 | Map 5.1 (draft layers, hint banner) | C2 |
| 6 | Boundary vertex editor | P0 | Map 5.1 (Edit tool, edit-vert/mid handles) | C4 |
| 7 | Select / move / drag twin | P0 | Map 5.1; Inspector sheet | C3 |
| 8 | Annotations (note/issue/task) | P1 | Annotate 5.6; Map markers; History 5.8 | D1 |
| 9 | Measure tool | P1 | Map 5.1 (measure layers + chip) | D2 |
| 10 | Layer switcher & opacity | P1 | Layers 5.7; header layer chip | B2 |
| 11 | Isolate property spotlight | P2 | Map 5.1 (mask-fill); Layers 5.7 | B3 |
| 12 | Labels toggle | P2 | Map 5.1; Layers 5.7 | B4 |
| 13 | Property picker | P0 | Property Picker 5.3; header chip | E1 |
| 14 | Live gateway signals (SignalsCard) | P0 | Signals 5.4; inspector SignalsCard | F1 |
| 15 | Run scan / Build HD twin (bg runner) | P0 | Signals 5.4; Scan Jobs dock 5.5 | F2 |
| 16 | Right panel — Twin inspector | P0 | Map intelligence sheet (Twin tab); inspector | G1 |
| 17 | Right panel — Reports | P2 | Map intelligence sheet (Reports tab) | G2 |
| 18 | Right panel — Analytics | P2 | Map intelligence sheet (Analytics tab) | G2 |
| 19 | Right panel — History + season scrubber | P2 | History tab; Season/History 5.8 | G2, G3 |
| 20 | Bottom parcel strip + season timeline | P1 | Map 5.1 (bottom strip + season slider) | G3 |
| 21 | Twin Explorer (grid) | P0 | Explorer 5.9; Create sheet | H1, H2 |
| 22 | Twin workspace (hero + tabs shell) | P0 | Twin detail 5.10 | I1 |
| 23 | Twin workspace — Overview | P0 | Overview 5.11 | I2 |
| 24 | Twin workspace — Telemetry | P1 | Telemetry 5.12 | I3 |
| 25 | Twin workspace — Maintenance | P1 | Maintenance 5.13 | I4 |
| 26 | Twin workspace — Calendar | P1 | Calendar 5.14 | I5 |
| 27 | Twin workspace — Docs | P2 | Docs 5.15 | I6 |
| 28 | 3D geological parcel cutaway | P1 | Overview 5.11; GL fallback 5.17 | I7 |
| 29 | Twin data model & client store | P0 | Platform §2/§6 (SQLite + sync); all workspace tabs | J1, J2 |
| 30 | Keyboard shortcuts & interaction states | P2 | Map 5.1 (action cluster, hint banner, FABs, gestures) | C5, C2, A-gates |

**All 30 inventory features covered.** Latent model fields (`routines`, `yields`, `treatments`) exist in the store with no web UI; mobile is scoped to parity, so they are **noted as future tabs** (not built here) — see the return summary.

---

## 8. Honesty-tier UI rules (must-follow)

- **Signals** always show `tier` (T1 regulatory / T2 evidence / T3 screening) as a colored badge; `measurement`, `value`, `confidence` shown as provided; `cloudPct`/`sceneId` shown as **"—"** when null — never fabricated.
- **NDVI/EVI** are never invented; the gateway's `no_producer` maps to an honest "not produced" chip.
- **Analytics/History/season timeline** are **demo data** on the web; mobile labels them "demo" until real cached indicator series exist, then swaps in live values or shows honest-empty.
- **Unconfigured gateway** = "not connected" state, never an error/crash.
- **Reports** Open buttons are stubs → routed to the Reports domain or disabled with guidance; nothing pretends to generate.
