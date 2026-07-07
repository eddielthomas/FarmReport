# Report.Farm Mobile — Bolt.new Mega-Prompt

> **What this is.** A single, copy-paste-ready prompt for [Bolt.new](https://bolt.new) that scaffolds the **Report.Farm** iOS+Android app as a *clean, buildable shell*: full navigation, every screen stubbed with correct layout + realistic placeholder content, a complete design system, the offline data layer (Drizzle schema), stubbed map/3D/API/sync, auth + role-gated nav, and seed data so it runs on first boot. The team then fills in real feature logic screen-by-screen.
>
> **How to use.** Copy everything inside the fenced block below (from `You are scaffolding…` to the end) into a fresh Bolt.new prompt. Do **not** edit the fences. After Bolt finishes, download the project and read the "After you download" note at the bottom of this file.

---

```text
You are scaffolding a production-quality MOBILE APP SHELL. Build a clean, buildable, runnable skeleton — NOT a finished product. Every screen must exist, render, navigate, and use the shared design system, but feature internals (real maps, real 3D, real network, real sync) are STUBBED with clearly-marked `// TODO(feature):` comments and mock data. Prioritize: it compiles, it runs in Expo, navigation works, the design system is coherent, and nothing is half-wired. Do not attempt to implement real EO/AI/map/3D/SSE logic — stub it behind typed interfaces. If you run low on room, prefer completing the shell (all screens + design system + data layer + seed) over deep feature detail.

═══════════════════════════════════════════════════════════════════
PROJECT: Report.Farm — farm + supply-chain intelligence, mobile companion
═══════════════════════════════════════════════════════════════════
Report.Farm watches farmland/assets/crops/water/weather/machinery, explains change, estimates financial impact, and ships reports + urgent alerts. It is multi-tenant B2B SaaS. This is the field/portfolio mobile app (a companion to an existing web app). Design posture: "Mission Control" — dark-first, cobalt-indigo accent, cyan live-telemetry secondary, sleek and modern, honest and never fabricated.

STACK (use exactly this — do not substitute):
- Expo SDK 52+ (React Native 0.76, New Architecture), TypeScript (strict).
- expo-router v3+ (file-based, typed routes) for ALL navigation.
- State/data: @tanstack/react-query v5 for server-state; a thin SQLite layer beneath it.
- Offline DB: expo-sqlite + drizzle-orm (drizzle-orm/expo-sqlite) + drizzle-kit.
- Secure storage: expo-secure-store (tokens). Prefs: expo-sqlite kv table.
- Bottom sheets: @gorhom/bottom-sheet v5. Gestures/anim: react-native-gesture-handler + react-native-reanimated v3.
- Icons: lucide-react-native. Fonts: @expo-google-fonts/inter + @expo-google-fonts/geist + @expo-google-fonts/jetbrains-mono via expo-font.
- Maps: @maplibre/maplibre-react-native — but DO NOT wire a live map. Provide a `<MapContainer>` STUB component (styled dark canvas + centered "Map — MapLibre (stub)" + optional overlay children slots) with a clearly-typed props interface so it can be swapped for the real MapLibre view later. Keep the dependency in package.json but guard usage so the app runs in Expo Go / web preview without a native map.
- 3D cutaway: expo-gl + three — STUB only. Provide a `<CutawayStub>` component (a styled card with layered soil-strata color bands drawn in plain Views + a "3D land slice (stub)" badge). Keep deps listed; do not initialize a GL context in the shell.
- Charts: provide lightweight STUB chart components (Sparkline, HealthRing, MiniBar, SeasonTimeline) drawn with plain Views/SVG-free primitives or react-native-svg if trivial — deterministic mock data, no real charting lib required.
- Notifications/camera/location: list expo-notifications, expo-camera, expo-location as deps; do NOT request permissions or wire them in the shell (leave typed stub hooks).

HARD RULES (carry into the UI — these are load-bearing, not decoration):
1. NEVER fabricate data. Empty states are HONEST: "No signals yet — run a scan", "Awaiting first satellite pass", "Gateway not connected", "No twins yet 🌱". Never render a fake-green healthy state for missing data.
2. Honesty tiers are UI: T1 = regulatory, T2 = evidence, T3 = screening. Build a `<TierBadge tier="T1|T2|T3" approximate?>` as an OUTLINE mono pill (never a filled block). Seed data must carry tiers.
3. Risk color never carries meaning alone. `<RiskPill band>` always renders icon + text label + color together. `band=null` → "Unmonitored" with a DASHED ring and muted color — never fake green.
4. Offline-first: cached reads show a `<StaleBadge>` ("Updated 12m ago · offline"); writes queue in an outbox. (In the shell these are visual + local-only; no real server.)
5. Role-routing is UX-only. Gate tab/screen visibility by cached role, but treat it as cosmetic (the real server is the boundary; there is no server in the shell).

═══════════════════════════════════════════════════════════════════
STEP 1 — DESIGN SYSTEM  (build this FIRST, everything consumes it)
═══════════════════════════════════════════════════════════════════
Create `src/design/`:

`colors.ts` — export `light` and `dark` objects with EXACTLY these tokens (RN-safe concrete values, no color-mix/oklch):

dark = {
  bg:'#0B0A08', bgElevated:'#141311', surface:'#1A1815', surfaceElevated:'#221F1B', surfaceSunken:'#100E0C', surfaceInverted:'#FBFAF7',
  fg:'#F5F3EE', fgMuted:'#A8A39A', fgSubtle:'#756F65', fgInverted:'#141311', fgOnAccent:'#FFFFFF',
  accent:'#4C7EFF', accentStrong:'#6E97FF', accentSoft:'#26365C', accentGlow:'rgba(76,126,255,0.30)',
  cyan:'#35C6DC', cyanSoft:'#1E3A44',
  red:'#F0524A', orange:'#FF8A3D', yellow:'#FFB93E', green:'#2FBE6B', blue:'#4C7EFF',
  risk:{ healthy:{text:'#2FBE6B',fill:'#2FBE6B'}, watch:{text:'#A9D24A',fill:'#A9D24A'}, stress:{text:'#FFB93E',fill:'#FFB93E'}, high:{text:'#FF8A3D',fill:'#FF8A3D'}, critical:{text:'#F0524A',fill:'#F0524A'} },
  viz:['#4C7EFF','#199E70','#C98500','#0E9E4E','#9085E9','#E66767','#D55181','#D95926'],
  seq:{100:'#16337C',300:'#2456BF',500:'#4C7EFF',700:'#A9C2FF'},
  border:'rgba(245,243,238,0.10)', borderStrong:'rgba(245,243,238,0.20)', ring:'#4C7EFF', overlay:'rgba(0,0,0,0.64)',
  mapCanvas:'#000000', panelGlass:'rgba(20,19,17,0.66)', panelGlassStrong:'rgba(20,19,17,0.90)'
}
light = {
  bg:'#F2F0EB', bgElevated:'#FBFAF7', surface:'#FFFFFF', surfaceElevated:'#FFFFFF', surfaceSunken:'#E9E6DE', surfaceInverted:'#141311',
  fg:'#171512', fgMuted:'#5C574F', fgSubtle:'#8A857B', fgInverted:'#FBFAF7', fgOnAccent:'#FFFFFF',
  accent:'#2B5FE3', accentStrong:'#1E49C4', accentSoft:'#DCE5FA', accentGlow:'rgba(43,95,227,0.22)',
  cyan:'#0E9BB5', cyanSoft:'#D2ECF1',
  red:'#C42B22', orange:'#C25A12', yellow:'#B26A00', green:'#0E7A3F', blue:'#2B5FE3',
  risk:{ healthy:{text:'#0E7A3F',fill:'#1F9D55'}, watch:{text:'#6E7A16',fill:'#8DB63C'}, stress:{text:'#B26A00',fill:'#F5A623'}, high:{text:'#C25A12',fill:'#EA7B1B'}, critical:{text:'#C42B22',fill:'#D6382F'} },
  viz:['#2B5FE3','#1BAF7A','#EDA100','#008300','#4A3AA7','#E34948','#E87BA4','#EB6834'],
  seq:{100:'#D6E3FB',300:'#86B0EF',500:'#2B5FE3',700:'#16337C'},
  border:'rgba(20,19,17,0.10)', borderStrong:'rgba(20,19,17,0.20)', ring:'#2B5FE3', overlay:'rgba(20,19,17,0.34)',
  mapCanvas:'#0B0C0F', panelGlass:'rgba(255,255,255,0.74)', panelGlassStrong:'rgba(255,255,255,0.90)'
}

`type.ts` — font families (Inter body, Geist display, JetBrains Mono mono) + a type scale: micro(11,mono,upper,tracking .5), label(12), sm(13), base(15), md(16), lg(18), xl(20 display), 2xl(24 display), 3xl(28 displayBold), 4xl(34 displayBold, -0.5). ALL numbers use `fontVariant:['tabular-nums']`. Mono uppercase `micro` is the tier-badge/kicker voice.

`space.ts` — space {0:0,1:4,2:8,3:12,4:16,5:20,6:24,7:28,8:32,10:40,12:48,16:64,20:80}; radius {none:0,sm:6,md:10,lg:14,xl:18,'2xl':24,'3xl':34,full:9999}; motion durations {instant:80,fast:160,normal:220,slow:360}; shadow presets (soft/card/popover/overlay/accent as {ios:{...}, android:{elevation}}); z {base:0,sticky:100,dropdown:1000,overlay:1100,modal:1200,toast:1300}.

`theme.tsx` — `ThemeProvider` + `useTheme()` returning `{ surface:'light'|'dark', colors, space, radius, type, motion, shadow, z }`. Resolve from `useColorScheme()` unless overridden by a persisted pref (`rf.surface-mode` in the kv table; default 'system'; NEVER cleared on sign-out). Components must consume `useTheme()` — never hardcode hex.

`components/` — build ALL of these as reusable, themed, typed components with realistic default rendering and empty/loading states:
- `Button` (variants: primary [accent bg, WHITE text, accent shadow], secondary, ghost, destructive, accent-soft; sizes sm/md/lg; loading spinner keeps width; min 44×44 tap target; reanimated press-scale 0.97).
- `Card`, `KpiCard` (eyebrow micro-mono, big 4xl tabular value, delta chip, footnote; HONEST-EMPTY: null value → "—" + amber footnote, never zero-as-green; optional sparkline), `StatCard`.
- `ListRow` + specializations `FarmRow`, `SupplierRow`, `AlertRow` (leading chip/RiskPill, title+subtitle, trailing RiskPill/chevron/timestamp, right-aligned tabular meta, optional swipe actions, optional tier dot). Heights 64 single / 76 two-line, hairline separators.
- `Sheet` (wraps @gorhom/bottom-sheet: detents ['30%','60%','92%'], grabber, overlay backdrop, panelGlass bg over map contexts).
- `Chip`, `FilterChip` (active = accentSoft bg + accent text + check), `ChipMultiSelect` (preset chips + free-text add).
- `TierBadge` (T1 green-outline "T1 · REGULATORY", T2 cobalt-outline "T2 · EVIDENCE", T3 amber-outline "T3 · SCREENING"; `approximate` adds dashed underline + "approx.").
- `RiskPill` (bands healthy/watch/stress/high/critical + null; icons sprout/leaf/triangle-alert/flame/octagon-alert; null → dashed "Unmonitored"; `scoreToBand(0..100)`: ≥80 critical, ≥60 high, ≥40 stress, ≥20 watch, else healthy). Plus `RiskLegend`.
- Charts (STUB, deterministic): `Sparkline`, `HealthRing`, `SeasonTimeline` (12-mo draggable scrubber), `MiniBar`, `TrendChart`. Theme-aware, tabular labels, use `colors.viz`/`colors.seq`.
- `FloatingAction` (FAB, 56px, accent, accent shadow, floats above tab bar; icon morphs by context; absent when no action).
- State components: `EmptyState` (icon + honest headline + guidance + optional CTA; presets: no-signals, awaiting-pass, gateway-unconfigured, no-farms, no-twins, vision-coming-soon, honest-degraded), `LoadingState` (skeleton rows/cards shimmer, never a bare spinner for lists), `ErrorState` (status→copy map: 503 gateway_unconfigured, 502 unreachable, 422 invalid_geometry, 404 vision_not_available, 409 invalid_status_transition — never generic "Something went wrong"), `StaleBadge`, `OfflineBanner` (root thin banner + queued-mutation count).
- Inputs: `Input` (44px min, focus ring, mono variant for GeoJSON), `Toggle` (iOS switch, accent on), `Segmented`, `Stepper` (numeric geometry editors).
- Nav chrome: `Header` (large-title-on-scroll, back chevron, right action slot), `Breadcrumb`.
- Map/studio stubs: `MapContainer` (styled dark canvas + label + children overlay slots), `ToolRail` (vertical floating rail of grouped icon buttons, active=accent), `LayerPill` (segmented Satellite/NDVI/Moisture/Thermal), `OpacitySlider`, `CutawayStub` (soil-strata color bands + badge).

═══════════════════════════════════════════════════════════════════
STEP 2 — NAVIGATION SHELL  (expo-router file tree — create EVERY file)
═══════════════════════════════════════════════════════════════════
Four route groups. Build every listed screen as a working stub (correct header, layout, realistic placeholder content from seed data, working navigation to children). Tab bar is a custom themed bar (bgElevated + top hairline, active=accent, badge on Alerts).

app/
  _layout.tsx                 — Root Stack: SafeAreaProvider, GestureHandlerRootView, ThemeProvider, QueryClientProvider, BottomSheetModalProvider, OfflineBanner host, auth-boot redirect, toast host.
  index.tsx                   — boot redirect: no session → (gate)/access ; session → (app)/<primary tab for role>.

  (gate)/                     — pre-auth, no tab bar, force dark
    _layout.tsx               — Stack, headerShown:false.
    access.tsx                — Access-code gate: masked passcode field, Enter button (loading/shake-on-error/offline-retry states), meta chips (v0.9/SOC2/24-7), "Leave preview". (Stub: any 6+ char code succeeds and stamps a fake pass.)
    login.tsx                 — Segmented "Sign in"/"Create account". Sign-in: 2×2 DEMO PERSPECTIVE cards [Buyer Admin, Portfolio Lead, Farm Operations, Grower] each showing role pill + label + description + computed `${role}@demo-buyer.demo`; tapping sets the mock session + role and routes to that role's primary tab. Below: manual sign-in (tenant slug default "demo-buyer" + email), disabled "Sign in with SSO", "Request portal access" link. Surface-mode toggle top-right.
    register.tsx              — invite-type cards (Employee/Customer/Vendor) + token field + display-name; "Reconnect to finish" offline note. (Stub.)

  (app)/
    _layout.tsx               — Tabs, ROLE-FILTERED (see role matrix). Custom TabBar. FAB host. 5 tabs max.
    portfolio/
      _layout.tsx  (Stack)
      index.tsx               — Portfolio Dashboard: KPI row (Suppliers count, Portfolio Risk RiskPill, Yield-at-Risk, Revenue-at-Risk — honest "—" until data), Active Disruptions feed (AlertRows → alert detail), Monitored Farms grid (FarmRows → farm detail), Suppliers table preview. Pull-to-refresh.
      suppliers.tsx           — Suppliers under monitoring (SupplierRows, sort maxRisk desc nulls-last).
      regions.tsx             — Sourcing regions rollup list.
    farms/
      _layout.tsx  (Stack)
      index.tsx               — Monitored-farms list: search + filter chips + FarmRows with risk chips.
      [farmId]/
        index.tsx             — Farm Detail: hero (name, supplier or "Direct", area, crop chips, RiskPill, HealthRing, active-signals count), section cards → Zones, Map, Signal timeline (honest-empty), Alerts panel, "Generate field report", "Open Studio" FAB.
        map.tsx               — Full-screen farm map (MapContainer stub + boundary/parcels/zones overlay placeholders + NavCluster + LayerPill).
        zones.tsx             — Zone list + intent detail rows.
        observations.tsx      — Signal timeline (honest-empty "Awaiting first satellite pass" until seeded; if seeded, show observation rows with TierBadge + honest-null cloud/scene as "—").
    alerts/
      _layout.tsx  (Stack)
      index.tsx               — Alert feed: filter chips (severity/status), AlertRows, swipe-left → Acknowledge (queues locally), pull-to-refresh.
      [alertId].tsx           — Alert detail: RiskPill(severity), category chip, confidence %, evidence chain list, estimated_impact (yield loss %, revenue at risk), recommended actions, Acknowledge button (gated farm.alert.manage).
    reports/
      _layout.tsx  (Stack)
      index.tsx               — Reports list grouped by farm (metadata rows).
      [reportId].tsx          — Report viewer: renders ordered JSON sections offline + artifact download buttons (pdf/html stub) + honesty/data-quality notes.
    more/
      _layout.tsx  (Stack)
      index.tsx               — Settings-style list: Account chip (name/roles/tenant); Switchers (Tenant [admin only], District [org only]); Cross-surface links (Buyers/Suppliers/Growers/Programs/Analytics/Staff/Tenants — role-filtered, route to P2 placeholder); Preferences (Appearance, Notifications, Offline & Sync); Sign out.
      appearance.tsx          — System/Light/Dark radio → persists rf.surface-mode.
      notifications.tsx       — push category toggles (stub).
      offline.tsx             — Sync queue status (outbox count, cache size, "Force sync" button — local stub), StaleBadge examples.
      account.tsx             — profile/session detail; tenant badge; Sign out.
    onboarding/               — task-flow, pushes over tabs, hides tab bar per-screen
      _layout.tsx  (Stack, headerShown per-step)
      index.tsx               — step router (autosaves a farm_draft to SQLite).
      basics.tsx              — name + farm-type ChipMultiSelect + crops ChipMultiSelect + supplier picker.
      boundary.tsx            — Find-my-farm: address field + "drop pin" + MapContainer stub; buttons for "AI Auto-trace (T3, coming soon)" [disabled honest], "Import GeoJSON/shapefile", "Draw manually". Honest-degraded note when lookup "not connected".
      parcels.tsx             — parcel list (add/draw stubs) with preview area (client-side, labeled preview).
      zones.tsx               — zone list with intent toggles (expects-irrigation, standing-water-ok) + sensitivity segmented.
      review.tsx              — summary of farm+parcels+zones, "Create" button (sequential-create stub → success).
      success.tsx             — success card → View farm.
    crm/                      — P2 placeholder screens (buyers.tsx, suppliers.tsx, growers.tsx, programs.tsx) each a titled "Coming in a later phase" placeholder.
    analytics/index.tsx       — P2 analytics placeholder with TrendChart/MiniBar stubs.
    admin/
      tenants.tsx             — P2 tenant list placeholder (admin-only).
      staff.tsx               — P2 IAM console placeholder (admin-only).

  (studio)/                   — chrome-less full-bleed authoring (NOT a tab); hides tab bar
    _layout.tsx               — Stack, headerShown:false, role guard (ops:manage/ops.coordinator/platform:admin else "Studio requires operations access" screen with Mission Control link). Read-only mode for viewer roles (hide tool rail + FAB, show "Viewing as <role>" chip).
    index.tsx                 — StudioMap: full-bleed MapContainer stub + floating property chip + LayerPill + ToolRail (Select · Edit · Note/Issue/Task · Measure · Zone · Parcel · Library · Rect · Circle · Row · Duplicate · Delete · Undo · Redo · Isolate · Labels · Analytics/History/Reports) + contextual hint banner + bottom twin strip carousel + SeasonTimeline scrubber + Signals/Build-HD-twin FAB + scan-jobs mini dock.
    explorer.tsx              — Twin Explorer grid: search + category filter pills (All + Structures/Equipment/Crops&Beds/Fields&Zones/Livestock/Water/Access&Utility with counts) + 2-col twin cards (icon chip, name, category·kind, online dot, ≤4 reading tiles, updated date) + "New twin" FAB.
    twin/[twinId]/
      _layout.tsx             — Twin detail: hero (icon, category·kind·ID, inline-editable name w/ "Saving/Saved", online toggle, HealthRing, Readings/Logs/Docs stats, Duplicate, Delete) + material top-tabs.
      overview.tsx            — specs card, telemetry preview sparklines, recent maintenance (last 3), CutawayStub + geometry facts.
      telemetry.tsx           — readings grid (label/value/unit + sparkline + remove) + add-channel form.
      maintenance.tsx         — log form (date/type/notes) + timeline.
      calendar.tsx            — month grid + schedule form + upcoming list (done-toggle/delete).
      docs.tsx                — attach form (name+url) + file/photo picker stub + attachment grid.

  (modals)/                   — presentation:'modal' / formSheet
    _layout.tsx               — Stack presentation:'modal'.
    scan-dock.tsx             — Background scan jobs dock (job cards: label, running/complete/error, progress %/stage/elapsed, View HD twin / Retry / dismiss, "Clear N finished").
    object-library.tsx        — catalog picker sheet (7 category tabs, ~62 emoji-icon items from ref_catalog seed, search).
    property-picker.tsx       — farm switcher sheet (FarmRows + check on active + "cached" tag + empty→Onboarding).
    signals.tsx               — live signals + Build HD twin sheet (idle/loading/unconfigured/error/ready states; signal chips w/ measurement/value/confidence/TierBadge/honest-null; producer toggles SAR/Moisture/Thermal/Superres; Build HD twin button).
    layers.tsx                — layer segmented + opacity slider + Isolate toggle + Labels toggle.
    tenant-switch.tsx         — tenant switcher sheet (admin only; online-only disabled-offline note).
    annotate.tsx              — note/issue/task input + camera stub + GPS auto (stub).
    alert-ack.tsx             — alert acknowledge confirm sheet.

ROLE → TAB MATRIX (compute from cached role at boot so it works offline; tab visibility is cosmetic):
- Buyer Admin (platform:admin): landing Portfolio; tabs all 5; FAB = Onboard/Studio.
- Portfolio Lead (farm.portfolio.view): landing Portfolio; tabs Portfolio, Farms, Alerts, Reports, More; FAB none (watch-only).
- Farm Operations (ops:manage + farm:onboard): landing Farms; tabs all 5; FAB = Onboard/Studio.
- Grower (customer:view + farm:view): landing Farms; tabs Farms, Alerts, More; FAB none.
- Vendor (vendor:view): isolated single "Supplier" surface + More.
Center FAB floats above tab bar on Portfolio & Farms: "Onboard farm" (needs farm:onboard) on Portfolio, "Open Studio" on a farm detail; absent for viewer roles.

═══════════════════════════════════════════════════════════════════
STEP 3 — OFFLINE DATA LAYER  (expo-sqlite + Drizzle)
═══════════════════════════════════════════════════════════════════
Create `src/db/`:
- `client.ts` — open `reportfarm.db` with WAL/foreign_keys/synchronous=NORMAL/busy_timeout PRAGMAs; export a drizzle instance.
- `schema.ts` — Drizzle SQLite table definitions for EXACTLY these tables (types/columns below). Every server-mirror (non-draft, non-ref) table carries a "sync trailer": `tenant_id TEXT NOT NULL`, `synced_at INTEGER`, `dirty INTEGER DEFAULT 0`, `deleted INTEGER DEFAULT 0`. Store all geometry as GeoJSON TEXT (columns `*_geojson`/`geom`) plus denormalized `bbox_w/s/e/n REAL`. Enums as TEXT with CHECK constraints.

Identity/session: `kv`(key PK, value JSON TEXT, updated_ms) ; `tenant_cache`(id PK, slug, display_name, status[active|trial|suspended], plan, org_id, org_slug, flags, is_active, synced_at).

Domain read-cache (tenant-scoped mirror):
- `farm`(id PK, tenant_id, name, timezone, language, currency, farm_types JSON, crops JSON, total_area_ha, boundaries_geojson, profiles JSON, custom_context JSON, signal_source[gateway|local], aoi_w/s/e/n, status, supplier_id, supplier_name, latest_risk_score, latest_risk_band[healthy|watch|stress|high|critical|null], latest_risk_date, created_at, updated_at, +trailer).
- `parcel`(id PK, local_id, tenant_id, farm_id FK→farm cascade, name, geom_geojson, area_ha, bbox_*, tags JSON, created_at, +trailer).
- `zone`(id PK, local_id, tenant_id, farm_id FK cascade, parcel_id, name, type[crop-field|irrigation-zone|barn|wetland|test-plot|...], intent JSON{expectedWaterFlow,standingWaterAllowed,vegetationPriority,alertSensitivity}, geom_geojson, bbox_*, tags, created_by, created_at, +trailer).
- `observation`(id PK, tenant_id, farm_id, zone_id, scan_id, external_id, measurement[ndvi|evi|water_stress|standing_water|lst], value, unit, confidence, cloud_pct, source_type[satellite|sar|sensor|null], provider, collection, scene_id, tier[T1|T2|T3|null], acquired_at, geom_geojson, props JSON, detected_at, synced_at, UNIQUE(farm_id,external_id)). READ-ONLY mirror.
- `derived_signal`(id PK, tenant_id, farm_id, zone_id, kind, value, baseline, delta_pct, confidence, window_start, window_end, evidence JSON, geom_geojson, created_at, synced_at).
- `alert`(id PK, tenant_id, farm_id, zone_id, derived_signal_id, severity[critical|high|medium|low|null], category, title, summary, evidence JSON, confidence, estimated_impact JSON{yieldLossPctIfIgnored,revenueAtRiskUsd}, recommended_actions JSON, channels JSON[email|sms|push|webhook|slack], status[open|ack|resolved|suppressed] default open, status_local, dedup_key, created_at, updated_at, synced_at, dirty).
- `report`(id PK, tenant_id, farm_id, type[scheduled|urgent|on-demand|null], title, period_start, period_end, status[draft|final|delivered|null], summary, sections JSON, artifact_urls JSON, local_pdf_blob, channels, generated_by, created_at, synced_at).
- `supplier`(id PK, tenant_id, sourcing_region_id, name, external_ref, status[active|inactive|prospective|null], tier[strategic|preferred|spot|null], contact JSON, metadata JSON, synced_at).
- `sourcing_region`(id PK, tenant_id, name, country, admin_area, geom_geojson, centroid_geojson, metadata, synced_at).
- `rollup_buyer`(tenant_id PK, buyer_slug, buyer_name, supplier_count, region_count, farm_count, avg_risk_score, max_risk_score, revenue_at_risk_usd, synced_at).
- `rollup_supplier`(supplier_id PK, tenant_id, supplier_name, sourcing_region_id, region_name, farm_count, avg_risk_score, max_risk_score, revenue_at_risk_usd, synced_at).
- `rollup_region`(sourcing_region_id PK, tenant_id, region_name, supplier_count, farm_count, avg_risk_score, max_risk_score, revenue_at_risk_usd, synced_at).

Studio local-of-record (ported from web localStorage stores):
- `twin`(id PK, server_id, tenant_id, parcel_id, property_id, name, category[structure|equipment|crop|field|livestock|water|infra], kind, icon, color, geom_type[point|rect|circle|polyline|polygon], geom JSON, center_lng, center_lat, specs JSON{sizeLabel,installDate,costUsd,vendor,notes}, online default 1, linked_twin_ids JSON, health_score, created_ms, updated_ms, dirty, deleted).
- `twin_reading`(id PK, twin_id FK cascade, label, value, unit, ord).
- `twin_maintenance`(id PK, twin_id FK cascade, date, type, notes, created_ms).
- `twin_doc`(id PK, twin_id FK cascade, name, url, note, blob_hash).
- `twin_event`(id PK, twin_id FK cascade, date, time, title, kind[task|scan|treatment|harvest|maintenance|note], notes, done, notif_id).
- `twin_routine`(id PK, twin_id FK cascade, name, cadence[daily|weekly|biweekly|monthly|seasonal], day_of_week, time_of_day, action, active, last_run).
- `twin_yield`(id PK, twin_id FK cascade, season, crop, quantity, unit, quality, harvest_date, notes).
- `twin_treatment`(id PK, twin_id FK cascade, date, category[fertilizer|pesticide|herbicide|fungicide|irrigation|other], product, rate, area, applicator, reentry_hours, notes).
- `twin_undo`(id PK autoincrement, tenant_id, stack[undo|redo], snapshot JSON, created_ms).
- `scan_job`(id PK, tenant_id, job_id, aoi_id, property_id, twin_id, label, signals JSON[sar|moisture|thermal|superres], boundary JSON, status[queued|running|complete|error] default queued, pct default 0, stage, message, started_ms, updated_ms, result_twin_id).
- `map_annotation`(id PK, tenant_id, property_id, lng, lat, label, kind[note|issue|task], blob_hash, created_ms, dirty).

Onboarding drafts (autosave): `farm_draft`(id PK, tenant_id, name, farm_types JSON, crops JSON, supplier_id, boundary_geojson, timezone, step default 0, created_ms, updated_ms, partial_farm_id) ; `parcel_draft`(id PK, farm_draft_id FK cascade, name, geom_geojson, server_id, ord) ; `zone_draft`(id PK, farm_draft_id FK cascade, parcel_draft_id, name, type, intent JSON, geom_geojson, server_id, ord).

Sync machinery: `outbox`(id PK autoincrement, tenant_id, entity, entity_local_id, op[create|update|delete|ack|generate|scan_launch], method, path, payload JSON, idem_key, depends_on, status[pending|inflight|failed|done|conflict] default pending, attempts default 0, last_error, http_status, next_attempt_ms default 0, created_ms, updated_ms) ; `tombstone`(id PK autoincrement, tenant_id, entity, server_id, local_id, reason, propagated default 0, created_ms) ; `sync_state`(key PK, tenant_id, collection, scope_id, last_pull_ms, etag, cursor, row_count, last_error).

Gateway EO cache: `gw_signal_cache`(bbox_key PK, tenant_id, farm_id, feature_collection JSON, count, fetched_ms, configured default 1) ; `gw_parcel_cache`(query_key PK, tenant_id, parcel_geojson, address, area_ha, approximate, source[gateway|osm], tier[T2|T3|null], fetched_ms) ; `gw_composite_cache`(aoi_id PK, tenant_id, composite JSON, fetched_ms).

Media/tiles: `blob_asset`(hash PK, tenant_id, kind[report_pdf|report_html|doc|photo|soil_texture|other], mime, file_uri, bytes, source_url, ref_count default 1, pinned default 0, last_access_ms, created_ms) ; `tile_pack`(farm_id PK, tenant_id, name, bounds, min_z, max_z, bytes, downloaded_at).

Reference (seeded from bundle): `ref_catalog`(kind PK, category, name, icon, color, default_geom_type, default_size JSON, sample_readings JSON) ; `ref_farm_type`(key PK, label) ; `ref_crop`(key PK, label) ; `ref_zone_type`(key PK, label, default_intent JSON) ; `ref_permission`(key PK, form[dot|colon], label).

- `migrate.ts` — apply drizzle-kit generated migrations on boot; record `kv('schema_version')`.
- `repositories/` — thin typed repos (`farmRepo`, `alertRepo`, `twinRepo`, `outboxRepo`, `draftRepo`, …). EVERY read filters `WHERE tenant_id = <active>` via a `withTenant()` helper. Twin repo reassembles a `Twin` object from `twin` + child tables. Provide pure geo helpers `ringAreaM2`, `circlePolygon`, `rectPolygon`, `metersToLngLat`, `geomCenter` (ported TS, preview-only area).
- `sync/outbox.ts` — a STUB sync engine: `enqueue(envelope)`, `writeLocalAndEnqueue(applyOptimistic, envelope)` (single transaction), and a `drain()` that (in the shell) just marks rows done after a fake delay. Include the error-taxonomy branch map as commented TODO (422 invalid_geometry no-retry, 409 invalid_status_transition converge, 401 token_revoked hard sign-out, 503 gateway_unconfigured backoff). No real HTTP.

═══════════════════════════════════════════════════════════════════
STEP 4 — API CLIENT STUB  (typed, points at the real endpoints, returns mock)
═══════════════════════════════════════════════════════════════════
Create `src/api/client.ts` — a typed `api()` fetch wrapper that DECLARES the real base + endpoints and header contract but, in the shell, resolves from SEED/mock (no live network). It must:
- Base: `EXPO_PUBLIC_API_BASE` (default e.g. https://app.report.farm). Stamp `Authorization: Bearer <jwt>`, `X-Tenant-Id: <id|slug>`, and `X-Access-Pass` on gated calls (read from secure-store).
- Export typed functions matching these routes (all returning mock in the shell, each with a `// TODO(api): wire real fetch` note):
  farms: GET /api/v1/farm/farms, /farms/:id, /farms/:id/parcels, /farms/:id/zones ; POST create farm/parcels/zones.
  observations: GET /api/v1/farm/observations ; alerts: GET /alerts, POST /alerts/:id/ack ; reports: GET /reports, /reports/:id, POST /reports/generate.
  portfolio: GET /api/v1/farm/portfolio/rollup, /portfolio/suppliers, /portfolio/regions.
  gateway relay (all may 503 gateway_unconfigured honestly): POST /api/v1/farm/gw/aoi/from-geom, /gw/scan ; GET /gw/jobs/:id, /gw/jobs/:id/events (SSE — stub as a fake progress emitter), /gw/twins/:aoi, /gw/signals-by-bbox ; GET /gw/parcel, /gw/parcel-by-address ; POST /gw/vision/segment, /gw/vision/segment/refine (return 404 vision_not_available honest stub).
  auth: POST /api/v1/access/verify, /auth/dev-login, /auth/whoami.
- Define `ApiError{status,code}` and the honest-degradation detectors `isUnconfigured` (503 gateway_unconfigured) and `isVisionUnavailable` (404 vision_not_available). Central 401 handler: token_revoked → hard sign-out (clear secure-store + purge tenant SQLite), 403 tenant_suspended → locked state.
- `src/api/sse.ts` — a `streamJobEvents(jobId,onEvent)` STUB that fakes farm.progress ticks then farm.complete (no real react-native-sse in the shell; leave the real impl as a commented TODO with the header-injection note).

Create `src/auth/` — `useAuth()` context reading/writing the mock session in secure-store (`rf.auth`, `rf.tenant`, `rf.perms`, `rf.access_pass`), `useHasPerm(perm)` (honors dot-perm + colon-role + platform.admin super-bypass), and `primarySurfaceForRoles`/`allowedSurfacesForRoles`/`sanitizeNextUrl` ports. Demo perspectives set a fully-formed mock JWT-shaped session offline.

═══════════════════════════════════════════════════════════════════
STEP 5 — SEED / MOCK DATA  (so the app runs immediately, honestly)
═══════════════════════════════════════════════════════════════════
Create `src/seed/`:
- `ref.ts` — seed `ref_catalog` with ~62 items across 7 categories (Structures ~14, Equipment ~13, Crops&Beds ~8, Fields&Zones ~8, Livestock ~8, Water ~8, Access&Utility ~8) each {kind, category, name, emoji icon, color, defaultGeomType, defaultSize, sampleReadings}. Seed `ref_farm_type` (cropland/orchard/vineyard/pasture/livestock/aquaculture/greenhouse/mixed), `ref_crop` (corn/soybean/wheat/rice/coffee/cocoa/sugarcane/cotton/palm-oil/citrus/grapes/almonds/barley/sorghum), `ref_zone_type` (crop-field/irrigation-zone/barn/wetland/test-plot with default_intent presets), `ref_permission` (dot + colon taxonomy). Seed on first boot; re-seed on CATALOG_VERSION bump.
- `demo.ts` — a MODEST, HONEST demo tenant "demo-buyer" so lists aren't empty: ~5 farms (with boundaries_geojson + aoi bbox + crops + supplier links + some with latest_risk_band, SOME with band=null to show "Unmonitored"), ~4 suppliers, ~3 sourcing regions, rollup rows, a handful of twins (with readings/maintenance/events), and a couple of scan_jobs. IMPORTANT: seed observations/alerts SPARINGLY and clearly as demo — many farms should be honest-empty ("Awaiting first satellite pass") to demonstrate honest states. Do NOT seed fake NDVI/EVI where the model says no_producer. Every seeded observation/signal carries a tier (mix of T1/T2/T3) and honest-null cloud_pct/scene_id on some. Provide 2-3 seeded alerts with full evidence chains + estimated_impact so alert detail renders.
- Wire seed into boot (Step 6). React Query hooks read from repos which read seeded SQLite.

═══════════════════════════════════════════════════════════════════
STEP 6 — BOOT SEQUENCE & APP CONFIG
═══════════════════════════════════════════════════════════════════
Root `_layout.tsx` boot: open db + PRAGMAs → migrate() → seed ref_* + demo if empty → load fonts (expo-font) → read kv(active_tenant, active_user, surface_mode) + secure-store session → hydrate React Query from repos → route: no pass → (gate)/access, pass+no session → (gate)/login, session → (app)/<primary tab>. Render OfflineBanner host + toast host. Force dark on splash/gate.

app.json / app.config.ts: name "Report.Farm", scheme "reportfarm", newArchEnabled true, deep-link prefixes, plugins list [@maplibre/maplibre-react-native, expo-location, expo-camera, expo-notifications] with usage strings (do not trigger them in the shell), notif icon color #4C7EFF. iOS 15+, Android 8+ (API 26+). Add EXPO_PUBLIC_API_BASE + EXPO_PUBLIC_SKIP_ACCESS_GATE env vars.

package.json: include all deps named above. Scripts: start, ios, android, web, db:generate (drizzle-kit), lint, typecheck. Ensure `expo start` runs and the web preview renders the gate → login → tabs flow WITHOUT a native map/GL (stubs only).

═══════════════════════════════════════════════════════════════════
ACCEPTANCE — the shell is "done" when:
═══════════════════════════════════════════════════════════════════
- `expo start` compiles with zero TypeScript errors; web preview boots to the Access gate.
- Enter any code → Login → tap a demo perspective → land on that role's primary tab; the tab bar shows only that role's tabs.
- Every screen listed in Step 2 exists, renders with seed/placeholder content, and navigates (tabs, stacks, modals, sheets) without dead ends.
- Design system is coherent in BOTH light and dark; toggling Appearance re-themes everything; no hardcoded hex outside colors.ts.
- TierBadge, RiskPill (incl. null→Unmonitored), and honest EmptyStates appear on the relevant screens; no fabricated healthy-green for missing data.
- SQLite opens, migrations apply, ref + demo seed load, repos return tenant-filtered rows; the outbox stub enqueues + fake-drains.
- MapContainer + CutawayStub + chart stubs render as styled placeholders (no native crash).
- Studio is reachable (not a tab) from a farm-detail FAB; role guard + read-only mode work.

BUILD ORDER: Design system (Step 1) → data layer + seed (Steps 3,5) → navigation shell + screens (Step 2) → api/auth stubs (Step 4) → boot wiring (Step 6). Keep every feature internal STUBBED behind a typed interface. Ship a clean skeleton, not a half-built feature.
```

---

## After you download

This shell is a **skeleton, deliberately**. Bolt produces the navigation, design system, data layer, and honest-empty screens; the team then fills in real features against the design docs in `docs/mobile/`. Recommended fill-in order (mirrors the domain/cross-cutting docs):

1. **Real MapLibre** — swap `<MapContainer>` for `@maplibre/maplibre-react-native` using the `LAYER_PAINT` raster-paint constants and the twin/signal/draft/edit vector layers (see `cross-cutting/platform-native.md` §2). Requires an EAS dev client (not Expo Go).
2. **Real API + sync** — wire `src/api/client.ts` to `/api/v1/farm/*` + the `/gw/*` relay, and turn the outbox stub into the real drain loop with the error-taxonomy branch, idempotency keys, and dependency chains (`cross-cutting/sync-realtime.md`).
3. **Scan SSE + dock** — replace `src/api/sse.ts` with `react-native-sse` (header-injecting) + `expo-task-manager` + push-driven completion (`platform-native.md` §5, `sync-realtime.md` §7).
4. **3D cutaway** — replace `<CutawayStub>` with the `expo-gl` + `three` port of `ParcelCutaway` (bundle `soil-strata.jpg`; server-composite the satellite top-face) (`platform-native.md` §3).
5. **Push, camera→vision, offline tile packs, OIDC, CRM/admin P2 surfaces** — per `auth-roles.md`, `onboarding.md`, `portfolio-buyers.md`, `programs-staff-admin.md`, `gateway-eo.md`.

Keep the honesty tiers (T1/T2/T3), `RiskPill` null→Unmonitored, and honest-empty copy intact through every fill-in — they are load-bearing for product trust, not styling.
```
