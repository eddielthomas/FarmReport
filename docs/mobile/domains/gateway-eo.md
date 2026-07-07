# Report.Farm Mobile — Domain Design: Gateway EO (scan / HD-twin / signals / vision)

> **Scope.** The AlphaGeo gateway relay surface only: the `from-geom → scan → SSE → twins` loop, live EO signals over a property AOI, find-my-farm parcel lookup (address + drop-pin, cadastral → OSM fallback), AI vision auto-trace, composite twin materialization, the background scan-job runner + progress dock, and the cross-cutting honesty/tier/graceful-degradation discipline. Adjacent Studio surfaces (full tool rail, 3D cutaway workspace, reports, mission control) are referenced only where the EO pipeline feeds them.
>
> **Target stack.** Expo + React Native + TypeScript, expo-router, offline-first via expo-sqlite + Drizzle, maps via `@maplibre/maplibre-react-native` (globe/pin) and `react-native-maps` fallback, SSE via `react-native-sse` / XHR-streaming (must inject `Authorization: Bearer` + `x-tenant-id`), push via expo-notifications, camera via expo-camera (future vision capture). iOS + Android, one codebase, dark-mode-first, cobalt-accent design language matching web Report.Farm.
>
> **Design north star.** The gateway is a *dumb byte-forwarder* to AlphaGeo. It degrades **honestly**: `503 → configured:false` ("not connected"), `404 → available:false` ("coming soon"), `422 → validation preserved`, `502 → unreachable`. Never fabricate. Every EO surface must render its unconfigured / unavailable / empty / error / offline states *without throwing*. Tier labels (T1 regulatory / T2 evidence / T3 screening) and the `approximate` flag are load-bearing trust signals, not decoration.

---

## 0. Design language & shared foundations

### 0.1 Visual system
- **Palette.** Ink/near-black canvas (`#0A0E14` base, `#111823` surface, `#1A2333` raised); cobalt accent (`#3B6EF6` primary, `#5B8CFF` hover); **signals teal** (`#2DD4BF` glow + dot, matching web `signals-glow`/`signals-dot`). Tier colors: T1 = amber `#F5A524`, T2 = emerald `#22C55E`, T3 = slate-blue `#7C8DB5` (screening/approximate). Status: running = cobalt pulse, complete = emerald check, error = rose `#F43F5E`.
- **Type.** Inter / SF Pro (iOS) / Roboto (Android) via `expo-font`; tabular-nums for percentages, hectares, elapsed timers.
- **Surfaces.** Frosted cards (`expo-blur` `BlurView` intensity 40–60) for the progress dock and signal cards, matching web's "frosted progress cards". Elevation via subtle cobalt-tinted shadow, not heavy borders.
- **Motion.** Reanimated 3 for the scan-progress bar, the signal-dot glow pulse (opacity 0.12↔0.24, 2.4s loop = the web `opacity-0.18` glow), the globe intro spin, and job-card enter/exit (slide-up from bottom-left dock).

### 0.2 Navigation shell (expo-router)
```
app/
  (tabs)/
    portfolio/          # Mission Control (other domain)
    studio/             # Digital Twin Studio  ← primary EO home
      index.tsx         # Property map + tool sheet
      signals.tsx       # Signals sheet (modal / bottom-sheet)
      jobs.tsx          # Scan jobs dock (full-screen list)
      twin/[id].tsx     # Twin detail (materialized HD twin)
    onboard/            # Onboarding Copilot (other domain owns steps)
      boundary.tsx      # Boundary step  ← Find-my-farm + Auto-trace live here
  _layout.tsx           # tab bar + global gateway-status banner
```
- **Global gateway-status chip** in the header: `Live` (green dot) when `configured:true`, `Not connected` (grey) on 503, `Offline` (amber) when `NetInfo` reports no connectivity, `Unreachable` (rose) on 502. Tapping it opens a sheet explaining current state + last successful sync time.

### 0.3 Data / persistence (offline-first)
- **Drizzle + expo-sqlite** tables mirror the two web localStorage stores plus caches:
  - `scan_jobs` ← `rf.studio.scanjobs.v1` (`ScanJob[]`) — **must survive app kill**.
  - `twins` ← `rf.studio.twins.v1` (`Twin[]`).
  - `signal_cache` (keyed by AOI bbox hash → last `SignalCollection` + `fetchedAt`).
  - `parcel_cache` (resolved `Parcel` by point/address → offline reuse).
  - `outbox` (queued write-intents: scan launches, `aoi/from-geom` registrations).
- **Reactive reads** via a `useSyncExternalStore`-equivalent hook over SQLite change subscriptions (mirrors web's `rf:scanjobs:change` / `rf:twins:change` custom events).
- **Tier / source / approximate** columns are first-class and never dropped on serialization.

### 0.4 Gateway client (`lib/gateway/*` — RN port)
Ports the web client libs, preserving contracts verbatim:
- `gatewaySignals.fetchSignals(bbox, {category,type,tier,minConfidence,limit})`
- `gatewayParcel.findParcelByPoint(lat,lon)` / `findParcelByAddress(q)` + Nominatim/OSM fallback + `normalizeParcel`
- `gatewayVision.segmentFieldAtPoint(point)` / `pickFieldForPin` / `pointInPolygon`
- `scanJobs.launchScanJob(...)` → `aoiFromGeom` → `runScan` → local `ScanJob`
- `scanJobsRunner.driveJob(...)` + `streamJobEvents(jobId, onEvent)` (SSE, Bearer+tenant, `\n\n` reframing, heartbeat skip, backoff reconnect)
- `twins.materializeParcelTwin(job, composite)` + defensive `extractPolygonal` + `upsertTwinExternal`
- `GatewayResult<T>` (`configured:true|false`) + `SegmentResult` (`available` union) + `isUnconfigured(err)` 503 detector are preserved exactly.

---

## 1. EPICS + USER STORIES

Roles: **Buyer Admin**, **Portfolio Lead**, **Farm Operations**, **Grower**. Permission model (from `farmGate`): reads → `farm.profile.read` OR legacy `farm:view`; writes (scan, aoi/from-geom) → `farm.profile.write` OR legacy `farm:onboard`; `platform.admin.all` / `platform:admin` always bypass.

---

### EPIC A — Live EO Signals over a property AOI
*(Feature: "Live EO Signals over property AOI"; "EO layer overlays & signal styling")*

**A1 — As Farm Operations, I want to open a property and automatically see live EO signals plotted on the map, so that I can spot change without running anything.**
- AC1: Selecting a property with an AOI bbox auto-triggers `fetchSignals(bbox)` (unfiltered, matching Studio) on mount and on bbox change / `refetchTick`.
- AC2: Signals render as teal glow (radius-9, opacity ~0.18, blurred) + dot (radius-4) overlays, geometry-only; a count badge shows the number of features.
- AC3: The right/bottom **Live signals** card lists signals with `measurement`, `value`, `confidence`, `acquiredAt`, tier badge, `source`, and honestly shows `sceneId`/`cloudPct` as "—" when null (never fabricated).
- AC4: State machine renders exactly one of `idle → loading → ready | unconfigured | error`.
- AC5: Zero features → "No signals yet — run a scan" (honest-empty). Gateway env unset (503) → "Connect the AlphaGeo gateway for live signals". Failure → "Error: &lt;msg&gt;".

**A2 — As a Grower, I want the signals card to make sense even when the gateway isn't wired, so that I trust the app and know my next step.**
- AC1: In stub mode (current deploy: env unset) the card shows the `configured:false` "not connected" note, not a spinner-forever or a crash.
- AC2: No red error styling for unconfigured — it's an informational state with a "Learn more / connect" affordance (admins) or a plain note (non-admins).

**A3 — As a Portfolio Lead, I want to filter signals by category/type/tier/min-confidence/limit, so that I can focus (e.g. only T2 evidence, confidence ≥ 0.7).**
- AC1: A filter sheet exposes `category`, `type`, `tier`, `minConfidence` (slider), `limit`; passes them through to `fetchSignals`.
- AC2: Active filters show as removable chips above the map; clearing returns to the unfiltered Studio default.
- AC3: Filtering is client-driven over the same endpoint; results respect the same honest-empty copy ("No signals match these filters").

**A4 — As Farm Operations offline, I want to still see the last signals I loaded, so that field work isn't blocked by no signal.**
- AC1: Last-fetched `FeatureCollection` per AOI renders from `signal_cache` with a "Stale · as of &lt;time&gt;" badge.
- AC2: Unconfigured and honest-empty states render offline without throwing.
- AC3: A "Refresh when online" affordance queues a refetch for reconnect.

**A5 — As any EO user, I want a layer switcher (satellite / ndvi / moisture / thermal) with opacity, so that I can read the land under the signal dots.**
- AC1: Switching layer applies the raster paint transform (saturation/contrast/hue-rotate/brightness) client-side over Esri satellite tiles; opacity slider controls raster opacity.
- AC2: A small note clarifies ndvi/moisture/thermal are *visual raster filters*, not true EO rasters (those arrive as `rasters[]` in the composite twin) — honesty preserved.
- AC3: Signal dots re-render reactively on top regardless of chosen base layer.

---

### EPIC B — Run Scan → HD-twin build (the keystone loop)
*(Features: "Run Scan → HD-twin build"; "Composite twin materialization")*

**B1 — As Farm Operations, I want to build an HD twin of a field by picking signals and tapping "Build HD twin", so that AlphaGeo produces a rich parcel twin.**
- AC1: From the Signals card, "Build HD twin" opens a signal picker with SAR / Moisture / Thermal chips (all selected by default; ndvi/evi deliberately absent — honest `no_producer`).
- AC2: On confirm, `launchScanJob` runs the exact 3-step order: (1) `aoi/from-geom` with the ring (or property bbox rectangle) → `aoi_id`; (2) `scan {aoi_id, signals}` → `202 {jobId}` ack; (3) record a local `ScanJob` and return immediately.
- AC3: If a polygon twin is selected, its refined ring is scanned; otherwise the property bbox `bboxRing` is scanned. Ring is normalized (`closeRing`) before AOI registration.
- AC4: The scan message line reads "Queued — runs in the background ~5 min"; the UI does **not** block on the 5-min build (awaits only from-geom + 202).
- AC5: Requires `farm.profile.write`/`farm:onboard` (or admin bypass). Users without write see a disabled "Build HD twin" with a permission tooltip.

**B2 — As Farm Operations, I want honest errors on scan launch, so that I know whether to shrink the AOI or reconnect.**
- AC1: `422 bbox_too_large` → "Area too large — draw a smaller field" (preserved through relay).
- AC2: `422 unknown_aoi` → "AOI expired, re-registering…" with auto-retry of step 1.
- AC3: Unconfigured (503) → `launchScanJob` returns null → "Gateway not connected — can't start a scan".

**B3 — As Farm Operations offline, I want to queue a scan and have it fire on reconnect, so that I don't lose the intent standing in a dead-zone field.**
- AC1: Offline "Build HD twin" writes a queued intent to `outbox` (with ring + signals) and shows a "Queued — will start when online" job card.
- AC2: On reconnect the client replays the 3-step order (from-geom → scan → job); `tenant_id` is injected server-side.
- AC3: If the queued AOI later 422s (too large), the queued job surfaces the honest error rather than silently dropping.

**B4 — As a Grower, I want the finished twin to appear with real readings, so that I can inspect my field's HD twin.**
- AC1: On completion the runner GETs `twins/:aoi` and `materializeParcelTwin` builds a studio `Twin`: ring via `extractPolygonal` (geometry/boundary/aoi.geometry/aoi.boundary), falling back to the submitted boundary ring if the composite lacks geometry.
- AC2: Readings synthesized from indicators (≤6) plus Signals/Orbiters/Rasters counts; `specs.notes` stamped "HD twin composed by AlphaGeo · AOI &lt;id&gt; · &lt;date&gt;".
- AC3: Rebuilding an existing twin (by `twinId`) preserves `id`/`name`/`createdAt`; else it seeds from the "field" catalog item.
- AC4: Defensive extraction never throws on an unexpected composite schema (schema unconfirmed).

---

### EPIC C — Background scan-job runner + progress dock
*(Features: "Background scan job runner + non-blocking progress dock"; "SSE job-events progress stream")*

**C1 — As Farm Operations, I want scan builds to keep running when I navigate away or close a screen, so that a 5-minute build survives my normal app use.**
- AC1: A single `ScanJobsRunner` mounts in the Studio and drives every `running` job via `driveJob`; jobs persist to `scan_jobs` (SQLite).
- AC2: Navigating away aborts the local drive (AbortController) but the job stays `running`; returning restarts the drive loop for any un-driven running job.
- AC3: **App relaunch**: on cold start the runner resumes all `running` jobs (the "resume on remount" pattern → app relaunch), and re-checks `twins/{aoi}` as source of truth (a build that finished while the app was killed still lands).

**C2 — As Farm Operations, I want a non-blocking progress dock, so that I can watch builds without losing my place.**
- AC1: Frosted progress cards dock bottom-left (up to last 4), each with spinner/check/alert icon, `%`, stage text, elapsed-minutes, a progress bar, and per-job dismiss (X).
- AC2: On complete a "View HD twin" CTA opens the twin detail and flies the map to it.
- AC3: A "Clear N finished" pill clears completed/errored jobs; a persistent note reads "Builds keep running if you navigate away".
- AC4: The dock renders queued/running state **offline** (from SQLite), showing "Waiting for connection" instead of a stalled spinner.

**C3 — As any EO user, I want live progress driven by the SSE stream, so that the percentage and stage are real, not faked.**
- AC1: `streamJobEvents` opens `jobs/:jobId/events` with `Authorization: Bearer` + `x-tenant-id` headers via an SSE lib / XHR streaming (RN has no fetch-ReadableStream reader).
- AC2: Frames reassembled on `\n\n`; heartbeat/comment (`:` ) frames skipped; `event:`+`data:` parsed into `JobEvent`; named events `farm.progress` / `farm.complete` / `farm.error` handled (pct/progress/percent + stage/status fields).
- AC3: `503` → `ApiError(gateway_unconfigured)`; non-ok → `ApiError(job_events_<status>)`; abort on navigation resolves silently (resume later).

**C4 — As Farm Operations on a flaky network, I want the stream to recover, so that a dropped connection doesn't strand a build.**
- AC1: On stream drop, poll `jobs/:jobId` (JobSnapshot fallback) and `twins/:aoi`; if `twinLooksReady` → complete; else reconnect after 5s backoff (`POLL_MS`).
- AC2: A hard 12-min ceiling times the job out to `status=error` with a message.
- AC3: Errors/timeouts show the alert icon + message on the job card; the job can be retried (re-launch with same ring+signals).

**C5 — As Farm Operations, I want a push notification when a build finishes while the app is backgrounded, so that I don't have to babysit it.**
- AC1: On `farm.complete` (or twins-as-source-of-truth completion detected on relaunch), fire an expo-notification "HD twin ready — &lt;field name&gt;".
- AC2: Tapping the notification deep-links to the twin detail (`studio/twin/[id]`).
- AC3: On `farm.error`/timeout, a "Build failed — tap to retry" notification.

---

### EPIC D — Find-my-farm parcel lookup
*(Feature: "Find-my-farm parcel lookup (address + drop-pin, cadastral → OSM fallback)")*

**D1 — As a Grower onboarding, I want to type my address and get my parcel boundary automatically, so that I don't have to draw it.**
- AC1: Address input + "Find" (submit on Enter) calls `findParcelByAddress(q)`; result consumed via `GatewayResult` → `onParcel` sink (same as manual BoundaryImport) and the globe flies to the located farm.
- AC2: A cadastral hit (source=`cadastral`, T2) wins outright and shows "Found parcel" with address + hectares and a **T2 exact** badge.
- AC3: An `osm_landuse` suggestion (T3) shows "Located (approximate)" with a **T3 approximate** badge and the prompt "drag corners to trace the exact boundary".

**D2 — As a Grower, I want to drop a pin on a satellite globe at my farm, so that I can locate it visually without knowing the address.**
- AC1: A spinning MapLibre satellite globe (globe projection, Esri World_Imagery, atmosphere/sky, ~7s bounded intro spin) lets me tap to drop a marker.
- AC2: Dropping the pin calls `findParcelByPoint(lat,lon)` through the same consume path; the resolved boundary populates the boundary editor.
- AC3: The last dropped point is retained as `lastPoint` (anchor for Auto-trace).

**D3 — As a Grower with no cadastral coverage, I want an OSM fallback so I always get *something* editable, so that onboarding never dead-ends.**
- AC1: If the gateway misses/is unconfigured/errors, fall back to Nominatim (reverse for pin, search for address, `polygon_geojson=1`): real polygon → bbox rectangle (if ≤0.05°) → default ~380m field square — **always flagged approximate (T3)**.
- AC2: Gateway miss logs a warn and silently proceeds to OSM; OSM network failure → `configured:false` honest note "Automatic lookup isn't connected yet — import or draw below".
- AC3: `notfound` → "No parcel found at this location — drop a pin closer or draw manually".

**D4 — As any onboarding user, I want find-my-farm to never hard-fail, so that I can always fall through to manual import/draw.**
- AC1: Every degraded state (unconfigured / notfound / error) still exposes "Import GeoJSON/Shapefile" and "Draw manually" affordances.
- AC2: WebGL-failure on the globe shows a non-blocking fallback note and a static map / address-only mode.
- AC3: The resolved boundary is always editable (drag corners) regardless of tier.

**D5 — As Farm Operations offline, I want previously resolved boundaries available, so that revisiting a farm doesn't require reconnecting.**
- AC1: Resolved parcels cache to `parcel_cache`; offline reopen shows the cached boundary with its original tier/source/approximate flags and a "cached" note.
- AC2: New lookups offline queue a "Find when online" action; the globe still renders cached Esri tiles where available.

---

### EPIC E — AI vision auto-trace (SAM2/YOLO)
*(Features: "AI vision auto-trace"; "Vision refine — object-to-twin [latent]")*

**E1 — As a Grower, I want to tap "Auto-trace field with AI" at my dropped pin, so that a field polygon is drawn for me to nudge.**
- AC1: Enabled only when a located point is known (dropped pin or resolved address); disabled otherwise with a tooltip "Locate your farm first".
- AC2: Calls `segmentFieldAtPoint` over a small ~0.012° (`PIN_BOX_DEG`) AOI box, classes=`['field']`, T3 screening, georeferenced lat/lon.
- AC3: `normObjects` → `pickFieldForPin` picks the pin-containing field (ray-cast `pointInPolygon`), else highest-confidence, else first; drops that polygon into the boundary editor and flies to zoom 15.
- AC4: The traced polygon carries a **T3 approximate** badge and "AI screening — verify the boundary".

**E2 — As a Grower, I want the async path to work, so that a fresh-imagery trace still returns.**
- AC1: A `202 {jobId}` response reuses `streamJobEvents` (`farm.progress`/`farm.complete`) and reads objects from the completion payload.
- AC2: Progress shows an inline "Tracing field…" state (not the bottom-left dock — this is inline to the boundary step).

**E3 — As a Grower, I want honest states when AI isn't available, so that I'm not misled by a missing feature.**
- AC1: `404 vision_not_available` → `{available:false}` → "AI auto-trace isn't live yet — coming soon" (current deploy state: vision built but not yet deployed).
- AC2: `503` → unconfigured note; empty objects → "No clear field detected — drop a pin on the field center or draw manually".
- AC3: States rendered: `idle / tracing / unavailable / empty / error` — never a hard fail; manual import/draw always remain.

**E4 — As a future Studio user, I want object-to-twin refine to exist in the contract (latent), so mobile is ready when it ships.**
- AC1: The `vision/segment/refine` contract (SAM2 cached `embedding_session`, same `404 → vision_not_available` preservation) is documented in the client layer but **not wired to UI** (matches web: relay + handler exist, no client fn yet).
- AC2: `pointInPolygon`/`pickFieldForPin` are pure and reused offline when the flow ships.

---

### EPIC F — Honesty tiers, honest-empty & graceful degradation (cross-cutting)
*(Feature: "Honesty tiers, honest-empty & graceful-degradation")*

**F1 — As any user, I want tier badges everywhere, so that I know how much to trust each boundary/signal.**
- AC1: T1 regulatory / T2 evidence / T3 screening badges render on signals, parcels, and seg-objects; cadastral = T2 (exact), osm_landuse + vision = T3 (approximate/screening).
- AC2: `approximate:true` always pairs with a "refine the boundary" prompt.
- AC3: Producer honesty preserved: ndvi/evi never appear as scan signals (honest `no_producer`); `sceneId`/`cloudPct` render as "—" when null.

**F2 — As any user, I want distinct, honest states for each failure mode, so that I never see a generic "something went wrong".**
- AC1: `503 gateway_unconfigured` → "not connected"; `404 vision_not_available` → "coming soon"; `422` → validation (bbox_too_large / unknown_aoi); `502` → "gateway unreachable". Each maps to a *distinct* mobile UI state, not a generic error.
- AC2: Honest-empty copy used verbatim: "No signals yet — run a scan", "No parcel found", "No clear field detected".
- AC3: Onboarding **never** hard-fails: find-my-farm and auto-trace always fall back to manual import/draw.

**F3 — As a Portfolio/Buyer Admin, I want the honesty semantics preserved in exported/rolled-up views, so that supply-chain decisions aren't built on fabricated data.**
- AC1: Any signal or twin surfaced upward carries its tier/source/approximate labels intact.
- AC2: Approximate (T3) boundaries are visibly distinguished from evidence-grade (T2) in list/summary views.

---

## 2. USER JOURNEYS

### Journey 1 — Grower onboards a new farm (find-my-farm → auto-trace → refine) [happy path]
1. Grower opens **Onboard → Boundary**. The spinning satellite globe animates a bounded 7s intro spin, then settles.
2. Grower types "Rua das Palmeiras 200, …" → taps **Find**. Loading spinner on the Find button.
3. Gateway returns a cadastral parcel (T2). Card flips to **"Found parcel"** with address + "12.4 ha" and a green **T2 exact** badge. Globe flies to the parcel; the editable polygon appears.
4. Grower taps **Auto-trace field with AI** (enabled because a point is known) to refine interior field extent. Inline "Tracing field…" → returns a T3 field polygon; `pickFieldForPin` selects the pin-containing one; map flies to zoom 15. Badge shows **T3 approximate — verify**.
5. Grower drags two corners to correct the boundary (always editable), then **Continue** to Parcels step. Boundary handed to the same `onParcel` sink as manual import.

### Journey 2 — Farm Operations runs a scan and gets an HD twin [happy path]
1. Ops opens **Studio**, selects a property (AOI bbox present). Signals auto-fetch; teal dots appear with a count badge; **Live signals** card lists T2 signals.
2. Ops taps **Build HD twin** on the Signals card. Picker shows SAR / Moisture / Thermal (all pre-selected). Ops keeps all three → **Confirm**.
3. Client runs `aoi/from-geom` (ring normalized) → `aoi_id`, then `scan` → `202 {jobId}`. A frosted job card slides into the bottom-left dock: "0% · queued · 0 min · Builds keep running if you navigate away".
4. Ops navigates to Portfolio to do other work. The local drive aborts; job stays `running`. Returning to Studio restarts the drive; SSE resumes; card shows "48% · fusing rasters · 3 min".
5. Ops backgrounds the app entirely. `farm.complete` arrives; expo-notification "HD twin ready — North Field". 
6. Ops taps the notification → `studio/twin/[id]` opens; the materialized twin shows readings from indicators, Signals/Orbiters/Rasters counts, and `specs.notes` "HD twin composed by AlphaGeo · AOI … · 2026-07-06". Map flies to the twin.

### Journey 3 — Scan launched offline, fires on reconnect [offline path]
1. Ops in a dead-zone field selects a property (cached signals show "Stale · as of 09:12"). Draws/selects a field ring.
2. Ops taps **Build HD twin** → offline. Job card shows "Queued — will start when online"; intent written to `outbox` with ring+signals.
3. Ops drives back into coverage. `NetInfo` flips online. Runner replays: `from-geom` → `scan` → `202`; job card transitions "Queued" → "0% running". Notification fires on completion.
4. Edge: the queued AOI is too large → `422 bbox_too_large` → job card shows "Area too large — draw a smaller field", offering "Edit & retry".

### Journey 4 — Signals when gateway is stub / unconfigured [degradation path]
1. Grower opens Studio in the current deploy (env unset). Signals fetch → `503` → `configured:false`.
2. **Live signals** card shows the informational note "Connect the AlphaGeo gateway for live signals" (grey, not red). Header chip reads "Not connected".
3. "Build HD twin" is present but tapping it returns null → toast "Gateway not connected — can't start a scan". No crash; the rest of Studio (twins from cache, tool rail) still works.

### Journey 5 — Auto-trace when vision not yet deployed [coming-soon path]
1. Grower locates farm via pin. Taps **Auto-trace field with AI**.
2. Endpoint returns `404 vision_not_available` → `{available:false}`. Inline note: "AI auto-trace isn't live yet — coming soon." Manual draw/import remain fully available. No error styling.

### Journey 6 — App killed mid-build, relaunch recovers [resilience path]
1. Ops starts a scan; iOS kills the app under memory pressure at 60%.
2. Ops relaunches. Cold-start runner reads `scan_jobs`, finds a `running` job, and re-checks `twins/{aoi}` (source of truth). The build finished while away → `twinLooksReady` → job marked complete, twin materialized, completion notification (if not already sent). Job card shows the check + "View HD twin".

### Journey 7 — Portfolio Lead reviews signal tiers across suppliers [read path]
1. Portfolio Lead opens a supplier's property in Studio. Filters signals to **tier = T2, minConfidence ≥ 0.7** via the filter sheet.
2. Only evidence-grade signals remain; chips show active filters. Lead notes an anomaly, taps **Build HD twin** (has write via role) to commission a fresh scan. Honesty labels carry into any upward rollup.

---

## 3. SCREENS

### S1 — Studio Property Map (`studio/index.tsx`)
- **Purpose.** Primary EO home: property map canvas with signal overlays, layer switcher, and entry to signals/scan/jobs.
- **Layout.** Full-bleed MapLibre/`react-native-maps` canvas. Top: header with gateway-status chip + property switcher. Bottom-left: **scan progress dock** (frosted job cards). Bottom-right: layer/opacity FAB. Bottom sheet (collapsed peek): **Live signals** summary → expands to S2.
- **Elements.**
  - Map with `signals-glow` + `signals-dot` layers (teal, geometry-only), count badge.
  - Layer switcher FAB → satellite / ndvi / moisture / thermal + opacity slider (raster paint transforms).
  - Property switcher (AOI bbox source).
  - Progress dock (see S4) — up to 4 cards.
  - Signals peek → "Build HD twin" quick action.
- **States.** Loading (skeleton dots + shimmer card); ready (dots + count); unconfigured ("Connect the AlphaGeo gateway for live signals"); empty ("No signals yet — run a scan"); error ("Error: …"); offline (cached dots + "Stale · as of …").
- **Nav.** In: from tab bar / twin detail back / notification deep-link. Out: → S2 (signals sheet), S3 (scan picker), S4 (jobs), S6 (twin detail).
- **Gestures.** Pan/pinch map; long-press to drop a scan AOI anchor; tap a dot → mini signal popover; swipe up on peek → S2; swipe job card left → dismiss.

### S2 — Live Signals Sheet (`studio/signals.tsx`, bottom-sheet modal)
- **Purpose.** Full signal list + filters + scan launch.
- **Layout.** Bottom-sheet (snap points 30/70/100%). Header: "Live signals" + count + filter icon. Scrollable list of `SignalFeature` rows. Sticky footer: **Build HD twin** button + scan message line.
- **Elements.**
  - Signal row: measurement, value+unit, confidence meter, tier badge (T1/T2/T3), source, `acquiredAt` relative time, `sceneId`/`cloudPct` = "—" when null.
  - Filter sheet: category, type, tier, minConfidence slider, limit. Active-filter chips.
  - **Build HD twin** (write-gated; disabled + tooltip if no write perm).
  - Scan message line (queued/error/unconfigured).
- **States.** loading / ready / unconfigured / empty / error / offline (stale) / filtered-empty ("No signals match these filters").
- **Nav.** In: from S1 peek. Out: → S3 (Build HD twin), back to S1.
- **Gestures.** Drag sheet; pull-to-refresh (refetch / `refetchTick`); swipe row → quick-filter by that measurement.

### S3 — Scan Signal Picker (`studio/scan-picker`, modal)
- **Purpose.** Choose signals and launch the from-geom→scan loop.
- **Layout.** Compact modal. Chips: SAR / Moisture / Thermal (all selected default; ndvi/evi absent by design). Target indicator: "Scanning: selected polygon ring" or "Scanning: property AOI rectangle". Primary: **Start build**. Secondary: cancel.
- **Elements.** Multi-select chips; target line; note "Runs in the background ~5 min"; superres appears only if backend exposes it.
- **States.** ready; launching (spinner on Start); success (dock card appears + auto-dismiss); error 422 bbox_too_large / unknown_aoi; unconfigured ("Gateway not connected"); offline ("Will start when online — queued").
- **Nav.** In: from S2 / S1 quick action. Out: dismiss → S1 with new dock card.
- **Gestures.** Tap chips; confirm.

### S4 — Scan Jobs Dock + Jobs List (`studio/jobs.tsx` + dock overlay on S1)
- **Purpose.** Non-blocking background progress; survives navigation/relaunch.
- **Layout (dock).** Bottom-left, absolute, ≤4 frosted `JobCard`s stacked; "Clear N finished" pill; note "Builds keep running if you navigate away". **Layout (full list).** Scrollable list of all jobs (running/complete/error) with the same card anatomy.
- **Elements — JobCard.** Icon (spinner/check/alert), field label, `%`, stage text, elapsed minutes, progress bar, dismiss X; on complete: **View HD twin** CTA. Retry on error.
- **States.** running (pulse); queued/offline ("Waiting for connection"); complete (check + CTA); error/timeout (alert + message + Retry).
- **Nav.** In: dock on S1 / tab. Out: **View HD twin** → S6; Retry → S3 relaunch.
- **Gestures.** Swipe card → dismiss; tap → expand to full job detail; pull-to-refresh (re-check `twins/:aoi`).

### S5 — Find-my-farm Globe + Boundary (`onboard/boundary.tsx`)
- **Purpose.** Locate the farm parcel automatically; hand an editable boundary to the boundary editor.
- **Layout.** Top ~55%: spinning satellite globe (MapLibre globe projection, Esri imagery, atmosphere). Below: address input + **Find**; result/status line; **Auto-trace field with AI**; **Import GeoJSON/Shapefile** + **Draw manually** fallbacks.
- **Elements.**
  - Globe with drop-pin marker; 7s bounded intro spin; WebGL-failure fallback note → static/address-only mode.
  - Address input (submit on Enter) + Find button.
  - Result card: "Found parcel" (T2) or "Located (approximate)" (T3) with address + hectares + tier badge + "drag corners to trace exact boundary".
  - Status lines: found / approximate / notfound / error / unconfigured.
  - Editable boundary polygon (corner handles).
- **States.** idle; searching; found (T2); approximate (T3/OSM); notfound; unconfigured ("Automatic lookup isn't connected yet — import or draw below"); error; offline (cached parcel + "cached" / "Find when online").
- **Nav.** In: Onboard flow. Out: → Parcels step (boundary committed); → Import / Draw sub-screens; **Auto-trace** → E-flow inline.
- **Gestures.** Tap globe → drop pin → lookup; drag corners; pinch globe.

### S6 — HD Twin Detail (`studio/twin/[id].tsx`)
- **Purpose.** The materialized composite twin (EO's output surface).
- **Layout.** Header (twin name, category, T-badge on approximate). Readings grid (indicators ≤6 + Signals/Orbiters/Rasters counts). Map inset flown to the twin ring. `specs.notes` provenance stamp. (3D cutaway and full workspace tabs belong to the twin-detail domain — referenced, not owned here.)
- **Elements.** Reading tiles (label/value/unit); provenance note; "rebuilt from AOI" indicator; source-of-truth freshness ("composed &lt;date&gt;").
- **States.** materialized; rebuilding (if a new scan targets same twinId — preserves id/name/createdAt); fallback-geometry (ring came from submitted boundary, flagged); offline (from SQLite twins).
- **Nav.** In: from JobCard "View HD twin" / notification / twin grid. Out: back to S1 (map flies to twin).
- **Gestures.** Pan/zoom map inset; scroll readings.

### S7 — Gateway Status Sheet (global)
- **Purpose.** Explain connection state and last sync; the single place mapping 503/502/404/offline to plain language.
- **Layout.** Sheet from the header chip. State icon + title (Live / Not connected / Unreachable / Offline) + explanation + last successful sync time + (admins) a "connect gateway" hint.
- **States.** live / unconfigured(503) / unreachable(502) / offline. 
- **Nav.** In: tap header chip anywhere. Out: dismiss.

---

## 4. OFFLINE BEHAVIOR

| Capability | Offline behavior |
|---|---|
| **Live signals** | **Read-only from cache.** Last `FeatureCollection` per AOI renders with "Stale · as of &lt;time&gt;" badge. Refetch queued for reconnect. Honest-empty/unconfigured render without throwing. |
| **Signal filters** | Work client-side over cached collection (category/type/tier/minConfidence/limit applied locally). |
| **Layer switcher / raster paint** | **Works offline** over cached Esri tiles (client-side paint transforms). Signal dots render from cache. |
| **Build HD twin (scan launch)** | **Queues.** Intent (ring+signals) written to `outbox`; job card shows "Queued — will start when online". Replays 3-step order (from-geom→scan→job) on reconnect, preserving order; `tenant_id` injected server-side. |
| **Scan-job runner / progress dock** | **Renders queued/running from SQLite.** SSE consumption pauses offline (shows "Waiting for connection"), resumes on reconnect with backoff. Jobs survive app kill; cold-start resumes and re-checks `twins/:aoi`. |
| **SSE progress stream** | Online-only. On drop → poll fallback + backoff; offline → paused, not errored. |
| **Twin materialization** | Completion needs the gateway (`twins/:aoi`). Already-materialized twins are **fully readable offline** from `twins` table. Defensive extraction + fallback-to-submitted-boundary keep twins usable. |
| **Find-my-farm (address/pin)** | Online-only lookup. **Cached resolved parcels are readable offline** (with original tier/source/approximate). New lookups queue "Find when online". Globe renders cached tiles; WebGL fallback if unavailable. |
| **Auto-trace (vision)** | Online-only **and** currently not-deployed (404). Offline → "AI auto-trace isn't live yet / offline" note; manual draw/import always available. `pointInPolygon`/`pickFieldForPin` are pure/offline-safe. |
| **Vision refine (latent)** | Not wired; online-only when built. Deferred. |
| **Honesty states** | **All render offline** — tier badges, approximate flags, honest-empty copy, unconfigured/unavailable notes never throw. |
| **Push on completion** | expo-notifications fire when the build completes (foreground SSE, or detected on relaunch via twins-source-of-truth). |

**Never available offline:** launching a real scan build *execution* (only the launch queues), live signal freshness, cadastral/OSM lookups, vision segmentation, composite twin fetch. **Always available offline:** reading cached signals/twins/parcels, filtering, layer paint, viewing queued/running jobs, manual boundary draw/import.

---

## 5. COVERAGE MAP (100% of inventory)

| # | Inventory feature (priority) | Covered by (Epic/Stories) | Screen(s) |
|---|---|---|---|
| 1 | Live EO Signals over property AOI (P0) | A1, A2, A3, A4 | S1, S2, S7 |
| 2 | Run Scan → HD-twin build (from-geom→scan→SSE→twins) (P0) | B1, B2, B3 | S1, S2, S3, S4 |
| 3 | Background scan job runner + progress dock (P0) | C1, C2, C4, C5 | S1 (dock), S4, S6 |
| 4 | SSE job-events progress stream (Bearer+tenant) (P0) | C3, C4 | (powers S4 JobCard + E2 async) |
| 5 | Composite twin materialization (twins/:aoi → Twin) (P0) | B4, C1(twins-source-of-truth) | S6, S4 (View HD twin) |
| 6 | Find-my-farm parcel lookup (address + drop-pin, cadastral→OSM) (P0) | D1, D2, D3, D4, D5 | S5, S7 |
| 7 | AI vision auto-trace (SAM2/YOLO) (P1) | E1, E2, E3 | S5 (inline Auto-trace), S4 (async path) |
| 8 | Vision refine — object-to-twin [latent] (P2) | E4 (contract documented, not UI-wired) | (latent — S6 future overlay) |
| 9 | Honesty tiers, honest-empty & graceful-degradation (P0) | F1, F2, F3 (+ every story's honest-state ACs) | ALL screens (S1–S7) |
| 10 | EO layer overlays & signal styling (satellite/ndvi/moisture/thermal) (P1) | A5 | S1 (layer switcher), S2 |

**Role coverage.** Buyer Admin → A3/F3 (tier-aware review, rollup honesty); Portfolio Lead → A3, C, F3 (filter, commission scans, tier discipline); Farm Operations → A1/A4, B, C (run scans, offline queue, dock/relaunch); Grower → A2, D, E (onboard, find-my-farm, auto-trace). Write-gated actions (scan, aoi/from-geom) respect `farm.profile.write`/`farm:onboard`/admin bypass across B/C; reads respect `farm.profile.read`/`farm:view`.

**Explicitly-deferred but documented (not a coverage gap):** Feature 8 (Vision refine object-to-twin) is intentionally latent — the web app itself has no client function wired (relay + gateway handler only). Mobile documents the contract (SAM2 `embedding_session`, `404 → vision_not_available`) and reuses the pure `pointInPolygon`/`pickFieldForPin` helpers, deferring UI until the object-to-twin flow ships, exactly matching the web posture.

---

## 6. Engineering notes carried from web (must-preserve on mobile)

- **SSE header injection.** RN lacks fetch-ReadableStream reader; use `react-native-sse` or XHR streaming that still attaches `Authorization: Bearer` + `x-tenant-id`. Reimplement `\n\n` reframing, heartbeat/comment-frame skipping, and reconnect-with-backoff.
- **Job persistence & resume.** `scan_jobs` in expo-sqlite is the offline-resilience blueprint: "gateway job outlives the page, resume on remount, `twins/{aoi}` as source of truth" ⇒ app relaunch recovery. 12-min ceiling + 5s (`POLL_MS`) backoff preserved.
- **3-step scan order is load-bearing:** from-geom → scan(202) → local job. Never reorder; `tenant_id` injected server-side.
- **Defensive twin extraction.** Gateway twin schema unconfirmed → `extractPolygonal` tolerance + fallback-to-submitted-boundary must carry over.
- **Tier discipline.** cadastral=T2 authoritative vs osm_landuse/vision=T3 approximate is a trust label, not styling. ndvi/evi excluded from scan signals (honest `no_producer`); null `sceneId`/`cloudPct` shown as "—".
- **Status-code → distinct UI state:** 503 unconfigured / 404 vision-coming-soon / 422 validation (bbox_too_large, unknown_aoi) / 502 unreachable — never collapse to a generic error.
