# Report.Farm Mobile — Information Architecture, Navigation & Design System

> **Scope:** Cross-cutting foundation for the Report.Farm iOS/Android app (Expo + React Native + TypeScript, expo-router, offline-first). This document is the single source of truth for (1) the tab/stack structure covering every surface, (2) the screen map / sitemap, and (3) the design system (tokens, typography, spacing, component library, mobile-native interaction patterns).
>
> **Grounding:** Tokens are ported verbatim from `app/src/crm/theme/tokens.css` + `theme.css` (the live web token stack). Surfaces, permissions, and honesty rules are drawn from the verified feature inventory across all six domains (Auth/Roles/Multi-tenancy, Onboarding, Studio, Gateway EO, Mission Control, Data Model). Nothing here invents a surface the web app does not have; it re-homes each web surface onto a mobile-native shell.
>
> **Status:** P0 design spec. Companion domain docs (auth, onboarding, studio, portfolio, offline-db) live alongside this file under `docs/mobile/`.

---

## 0. Design principles (the non-negotiables)

1. **Mission-control, dark-first.** The product's native posture is dark ("Mission Control"). Light ("Field Ops daylight") is fully supported and respects the OS theme, but the brand identity — warm near-black canvas, cobalt-indigo "Orbital" accent (`#4C7EFF` dark / `#2B5FE3` light), cyan live-telemetry secondary — is calibrated for dark.
2. **Honesty tiers are load-bearing UI, not decoration.** Every EO-derived value carries a tier (T1 regulatory / T2 evidence / T3 screening) and a detectability/approximate flag. The app **never fabricates**. Empty is honest-empty ("No signals yet — run a scan", "Awaiting first satellite pass", "Gateway not connected"). `RiskPill` with `band=null` renders **Unmonitored** (dashed ring) — never a fake green. These rules are encoded into the component library below (`Tier badge`, `RiskPill`, `EmptyState`).
3. **Color never carries meaning alone.** The risk ramp is colorblind-floor-adjacent between stops, so every risk color always ships with an icon + text label (WCAG AA, ≥4.5:1 for text pairs).
4. **Offline-first, server-authoritative.** Reads cache to SQLite for glanceable offline use with a **stale badge**; writes queue in an outbound mutation log and replay with the JWT + `X-Tenant-Id` at flush time. Geometry area/AOI are computed **client-side for preview only** — the server (`ST_Area`/`ST_IsValid`) is the source of truth.
5. **Two token gates, header-based.** No cookies on native. The 1h **access pass** rides the `X-Access-Pass` header; the 8h **session JWT** rides `Authorization: Bearer` + `X-Tenant-Id` on every business call. Both persist in `expo-secure-store`.
6. **Role-routing is UX-only; the server is the boundary.** The router mirrors the web `role-gate.js`: primary-surface routing + allow-list + `sanitizeNextUrl` for deep links. The server `requirePermission`/`farmGate` remains authoritative — client gating only hides/disables what the user can't do.

---

## 1. Navigation architecture (expo-router)

### 1.1 Router topology

The app uses **expo-router (file-based)** with four nested layers:

```
Root Stack  (app/_layout.tsx)                — theme provider, auth/gate boot, deep-link + push routing
├─ (gate)   group — pre-auth, no chrome      — access pass + login (modal-less full screens)
├─ (app)    group — authed shell             — Bottom Tabs + per-tab native stacks
├─ (studio) group — authed, chrome-less      — full-bleed map authoring (its own stack, hides tab bar)
└─ (modals) group — presentation:'modal'/'formSheet' — global sheets (scan dock, twin quick-add, tenant switch…)
```

Rationale for four layers:
- **`(gate)` is a separate group** because the access-pass + login screens have no tab bar, no tenant, and must be reachable/forced from any 401/403 reconnect.
- **`(app)` is the tabbed home** — the everyday surface set.
- **`(studio)` is deliberately NOT a tab.** Studio is a full-bleed map authoring environment (tool rail, object library, drawing gestures) that needs the entire viewport; a bottom tab bar would steal 56px and intercept map drags. It launches from a FAB / portfolio link and pushes as its own chrome-less stack, restoring the tab bar on exit. This mirrors the web (`studio.html` is a separate HTML entry, not an operations tab).
- **`(modals)`** hosts globally-invokable sheets so the scan-progress dock, tenant switcher, and quick-add can surface over any screen.

### 1.2 Bottom tab bar (the primary IA)

Five tabs — chosen to cover every everyday surface while honoring role-based visibility. The bar is **role-filtered**: tabs the cached role can't visit are hidden (reproducing `allowedSurfacesForRoles`). A grower (customer:view) sees a reduced 3-tab bar; a vendor (vendor:view) is isolated to a single-surface layout.

| # | Tab | Route (group) | Icon (lucide-rn) | Web analog | Min permission |
|---|-----|---------------|------------------|------------|----------------|
| 1 | **Portfolio** | `(app)/portfolio` | `layout-grid` | operations.html PortfolioDashboard | `farm.portfolio.view` OR `farm:view` |
| 2 | **Farms** | `(app)/farms` | `sprout` | operations.html Monitored-Farms grid → FarmDetail | `farm.profile.read` OR `farm:view` |
| 3 | **Alerts** | `(app)/alerts` | `bell` (badge = open count) | Active Disruptions feed + FarmDetail alerts | `farm.alert.read` OR `farm:view` |
| 4 | **Reports** | `(app)/reports` | `file-text` | report.html ReportView | `farm.report.read` OR `farm:view` |
| 5 | **More** | `(app)/more` | `menu` (or avatar) | TopNav right cluster + cross-surface links | any authed |

**Center action:** a raised **FAB** floats above the tab bar on Portfolio & Farms tabs (see §5.10). Its action is context-driven: **Onboard farm** (needs `farm:onboard`) on Portfolio, **Open Studio** on a farm detail. When neither applies (viewer role), the FAB is absent — never a dead button.

**Studio** and **Onboarding** are intentionally not tabs — they are task-flows launched from the FAB / links, running full-screen. This keeps the tab bar to 5 (the platform ceiling for legibility) and keeps immersive map work chrome-free.

### 1.3 Role → tab-set matrix

Derived from the auth inventory (`primarySurfaceForRoles` / `allowedSurfacesForRoles`, dual dot-perm + colon-role). The router computes this from the **cached** JWT roles at boot so it works offline.

| Persona (demo email) | Roles | Landing tab | Visible tabs | FAB |
|---|---|---|---|---|
| Buyer Admin (`admin@…`) | platform:admin + ops:manage + farm:* | Portfolio | all 5 | Onboard / Studio |
| Portfolio Lead (`buyer@…`) | farm:view + farm.portfolio.view + report:generate | Portfolio | Portfolio, Farms, Alerts, Reports, More | — (watch-only) |
| Farm Operations (`ops@…`) | ops:manage + farm:view + farm:onboard + alert:manage | Farms | all 5 | Onboard / Studio |
| Grower (`grower@…`) | customer:view + farm:view | Farms | Farms, Alerts, More (own farms only) | — |
| Vendor (`vendor:*`) | vendor:view (isolated) | Supplier | Supplier (single surface), More | — |

> **Enforcement note:** tab visibility is defense-in-depth only. Every screen still gates its actions (`useHasPerm`) and the server re-checks each API call. On a `403 tenant_suspended`, the whole `(app)` group renders a **Locked** state; on `401 token_revoked`, the root layout hard-routes to `(gate)/login` and purges the tenant-scoped SQLite partition.

### 1.4 The "More" tab (overflow surface)

Rather than cram admin/CRM surfaces into tabs, the **More** tab is a native settings-style list that houses everything the web TopNav right-cluster + low-frequency cross-surface links did:

```
More
├─ Account chip (name, roles, tenant)        → Profile / session
├─ ── Switchers ──
│   ├─ Tenant switcher      (platform:admin only — online-only re-mint)
│   └─ District switcher    (only if org claim present — online-only)
├─ ── Cross-surface ──  (role-filtered, hard-nav analogs)
│   ├─ Buyers      → (app)/crm/buyers      (sales:manage)   [relabeled sales]
│   ├─ Suppliers   → (app)/crm/suppliers   (vendor scope)   [relabeled vendor]
│   ├─ Growers     → (app)/crm/growers     (customer:view)  [relabeled customer]
│   ├─ Programs    → (app)/crm/programs    (ops:manage)
│   ├─ Analytics   → (app)/analytics       (analytics:view)
│   ├─ Staff       → (app)/admin/staff     (platform:admin)
│   └─ Tenants     → (app)/admin/tenants   (platform:admin)
├─ ── Preferences ──
│   ├─ Appearance (System / Light / Dark)  → persists rf.surface-mode
│   ├─ Notifications (push categories)
│   └─ Offline & sync (queue status, cache size, force sync)
└─ Sign out   (teardown: clear secure-store, cancel push, purge SQLite, → gate)
```

The CRM re-skins (Buyers/Suppliers/Growers/Programs) are separate domains; on mobile they are P2 stubs that route to a WebView-or-native placeholder — inventoried here only for nav completeness so the IA is exhaustive.

### 1.5 Full file tree (expo-router)

```
app/
  _layout.tsx                      # Root Stack: SafeAreaProvider, ThemeProvider, QueryClient,
                                   #   auth/gate boot, deep-link + notification routing, offline banner
  index.tsx                        # boot redirect → (gate) or (app)/<primary surface>

  (gate)/
    _layout.tsx                    # Stack, no header, no tenant
    access.tsx                     # Access-code gate  (POST /access/verify → X-Access-Pass)
    login.tsx                      # Demo perspectives + manual sign-in + OIDC button
    register.tsx                   # Invite / request-access (deep-link target)

  (app)/
    _layout.tsx                    # Tabs (role-filtered) + FAB host + global toast host
    portfolio/
      _layout.tsx                  # Stack
      index.tsx                    # Portfolio Dashboard (KPIs, suppliers, disruptions, farms)
      suppliers.tsx                # Suppliers-under-monitoring (full table, drill)
      regions.tsx                  # Sourcing regions rollup
    farms/
      _layout.tsx                  # Stack
      index.tsx                    # Monitored-farms list (search/filter)
      [farmId]/
        index.tsx                  # Farm Detail (hero, zones, map, timeline, alerts, report)
        map.tsx                    # Full-screen farm map
        zones.tsx                  # Zone list + intent detail
        observations.tsx           # Signal timeline (honest-empty until ingest)
    alerts/
      _layout.tsx
      index.tsx                    # Portfolio alert feed (filter by severity/status)
      [alertId].tsx                # Alert detail (evidence chain, impact, actions, ack)
    reports/
      _layout.tsx
      index.tsx                    # Reports list (by farm)
      [reportId].tsx               # Report viewer (sections JSONB + artifact download)
    more/
      _layout.tsx
      index.tsx                    # Settings-style overflow list (see §1.4)
      appearance.tsx
      notifications.tsx
      offline.tsx                  # Sync queue + cache mgmt
      account.tsx
    onboarding/                    # task-flow (pushes over tabs, hides tab bar per-screen)
      _layout.tsx                  # Stack, headerShown per-step; presentation:'card'
      index.tsx                    # step router (autosaves draft to SQLite)
      basics.tsx  boundary.tsx  parcels.tsx  zones.tsx  review.tsx  success.tsx
    crm/                           # P2 relabeled surfaces (buyers/suppliers/growers/programs)
    analytics/  admin/             # P2

  (studio)/
    _layout.tsx                    # Stack, headerShown:false, tabBarStyle hidden — full bleed
    index.tsx                      # StudioMap (tool rail, object library, drawing)
    explorer.tsx                   # Twin Explorer grid
    twin/[twinId].tsx              # Twin Detail workspace (tabbed dossier)

  (modals)/
    _layout.tsx                    # Stack presentation:'modal'
    scan-dock.tsx                  # Background scan jobs dock (formSheet, detents)
    twin-quick-add.tsx             # Object-library create sheet
    tenant-switch.tsx              # Tenant/district switcher sheet
    layer-picker.tsx  filters.tsx  alert-ack.tsx  ...
```

---

## 2. Screen map / sitemap (every surface)

Legend: **[P0/P1/P2]** priority · **(gate)** = permission · **↕offline** = offline behavior.

```
BOOT
 └─ Root boot  [P0]
     ├─ no access pass  → (gate)/access
     ├─ pass, no JWT    → (gate)/login
     └─ pass + JWT      → (app)/<primarySurfaceForRoles>   ↕offline: cached roles route offline

(gate)  PRE-AUTH  ───────────────────────────────────────────────
 ├─ Access gate [P0]  passcode → X-Access-Pass (1h)          ↕ online-only; block gated surfaces till valid
 ├─ Login [P0]  demo perspectives · manual tenant+email · OIDC (P2) · invite (P1)
 └─ Register [P1]  request-access / register-with-invite     ↕ deep-link (universal link) target

(app) › PORTFOLIO  ──────────────────────────────────────────────
 ├─ Dashboard [P0]  (gate: farm.portfolio.view)
 │   ├─ KPI row: Suppliers · Portfolio Risk · Yield-at-Risk(maxRisk*0.18) · Revenue-at-Risk
 │   │            ↕ cache rollup, stale badge; honest '—' + footnote until ingest
 │   ├─ Suppliers table → Portfolio/Suppliers                ↕ cacheable, tappable rows
 │   ├─ Active Disruptions feed → Alert detail               ↕ push-notification source
 │   └─ Monitored Farms grid → Farm Detail                   ↕ cache list + boundaries
 ├─ Suppliers [P0]  full v_supplier_rollup, sorted maxRisk DESC NULLS LAST
 └─ Regions   [P1]  v_region_rollup

(app) › FARMS  ──────────────────────────────────────────────────
 ├─ Farm list [P0]  search/filter, risk chips                ↕ cache
 └─ Farm Detail [P0]  (gate: farm.profile.read)              ↕ strong offline-first candidate
     ├─ Hero: name, supplier, area, crops, RiskPill, health, active-signals
     ├─ Zones → Zone list (intent JSON)                      ↕ cache; onboarding-created zones queue
     ├─ Map (boundary + parcels + zones)                     ↕ cached boundary offline; tiles need net
     ├─ Signal timeline (observations)                       ↕ honest-empty until P2 ingest
     ├─ Alerts panel → Alert detail (ack)                    ↕ ack queues, reconcile 409
     └─ Field report → generate (report:generate)            ↕ online-only; disable w/ message
         └─ Open Studio (FAB) → (studio)

(app) › ALERTS  ─────────────────────────────────────────────────
 ├─ Alert feed [P0]  filter severity/status                  ↕ cache recent; push target
 └─ Alert detail [P0]  evidence chain · estimated_impact · recommended_actions · Ack
     └─ (gate ack: farm.alert.manage) ↕ queue offline; 409 invalid_status_transition on replay

(app) › REPORTS  ────────────────────────────────────────────────
 ├─ Reports list [P0]  by farm                               ↕ cache metadata
 └─ Report viewer [P0]  sections JSONB + artifact_urls(pdf/html)  ↕ download for offline; honesty notes

(app) › MORE  ───────────────────────────────────────────────────
 ├─ Account / session [P0]
 ├─ Tenant switcher [P1]  (platform:admin, online-only re-mint) ↕ purge cache on switch
 ├─ District switcher [P1] (org claim only, online-only)
 ├─ Appearance [P2] · Notifications [P1] · Offline & Sync [P0]
 ├─ Cross-surface links [P2]  Buyers/Suppliers/Growers/Programs/Analytics/Staff/Tenants
 └─ Sign out [P0]

ONBOARDING  (task-flow, gate: farm:onboard else honest gate card) [P0]
 └─ 0 Basics → 1 Boundary → 2 Parcels → 3 Zones → 4 Review → Success
     ├─ Boundary: Find-my-farm (address + drop-pin globe) · AI auto-trace (T3) · import · draw
     │            ↕ draft autosaves to SQLite; lookups online-only, honest-degrade to manual
     └─ Create: sequential farm→parcels→zones POST; partial-success resumable

STUDIO  (chrome-less, gate: ops:manage / ops.coordinator / platform:admin) [P0]
 ├─ StudioMap [P0]  tool rail · object library (62) · layers · draw/edit · signals · scan
 │   ├─ Scan dock (modal) [P0]  from-geom→scan→SSE→twin materialize  ↕ persist jobs, resume on relaunch
 │   └─ Layer picker (sheet) · Isolate · Labels · Season timeline
 ├─ Twin Explorer [P0]  grid, filter, search, create
 └─ Twin Detail [P0]  Overview · Telemetry · Maintenance · Calendar · Docs · 3D cutaway
     ↕ twins/scan-jobs stores → expo-sqlite (today localStorage, per-device); add server sync
```

---

## 3. Design system — foundations

The design system is delivered as a typed token module (`src/design/tokens.ts`) plus a `ThemeProvider` that resolves light/dark from OS + override. **Values are ported verbatim from the web token stack** so web and mobile stay pixel-coherent.

### 3.1 Theme model

```ts
// src/design/theme.ts
export type Surface = 'light' | 'dark';
export type ThemePref = 'system' | 'light' | 'dark';   // persisted in secure-store 'rf.surface-mode'

// Resolution: pref==='system' ? useColorScheme() : pref  → Surface
// Provider exposes: { surface, colors, space, radius, type, motion, shadow, z }
// Consumers: const { colors } = useTheme();  (never hardcode hex in components)
```

Persistence key `rf.surface-mode` mirrors the web `rwr.surface-mode` and **survives sign-out** (matching web behavior). Default is `system` but the brand is dark, so the launch splash and gate screens force dark for a consistent first impression.

### 3.2 Color tokens (ported 1:1 from `theme/tokens.css`)

```ts
// src/design/colors.ts
export const light = {
  // canvas / surface
  bg: '#F2F0EB', bgElevated: '#FBFAF7', surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF', surfaceSunken: '#E9E6DE', surfaceInverted: '#141311',
  // text
  fg: '#171512', fgMuted: '#5C574F', fgSubtle: '#8A857B',
  fgInverted: '#FBFAF7', fgOnAccent: '#FFFFFF',
  // accents (brand = cobalt-indigo "Orbital")
  accent: '#2B5FE3', accentStrong: '#1E49C4',
  accentSoft: '#DCE5FA',   // color-mix(#2B5FE3 14% white) precomputed for RN
  accentGlow: 'rgba(43,95,227,0.22)',
  cyan: '#0E9BB5', cyanSoft: '#D2ECF1',
  // status
  red: '#C42B22', orange: '#C25A12', yellow: '#B26A00', green: '#0E7A3F', blue: '#2B5FE3',
  // risk ramp (text-safe / fill) — ORDERED low→high
  risk: {
    healthy:  { text: '#0E7A3F', fill: '#1F9D55' },
    watch:    { text: '#6E7A16', fill: '#8DB63C' },
    stress:   { text: '#B26A00', fill: '#F5A623' },
    high:     { text: '#C25A12', fill: '#EA7B1B' },
    critical: { text: '#C42B22', fill: '#D6382F' },
  },
  // data-viz categorical
  viz: ['#2B5FE3','#1BAF7A','#EDA100','#008300','#4A3AA7','#E34948','#E87BA4','#EB6834'],
  seq: { 100:'#D6E3FB', 300:'#86B0EF', 500:'#2B5FE3', 700:'#16337C' },
  // structural
  border: 'rgba(20,19,17,0.10)', borderStrong: 'rgba(20,19,17,0.20)',
  ring: '#2B5FE3', overlay: 'rgba(20,19,17,0.34)',
  // map glass (glass always reads on a dark map canvas)
  mapCanvas: '#0B0C0F',
  panelGlass: 'rgba(255,255,255,0.74)', panelGlassStrong: 'rgba(255,255,255,0.90)',
} as const;

export const dark = {
  bg: '#0B0A08', bgElevated: '#141311', surface: '#1A1815',
  surfaceElevated: '#221F1B', surfaceSunken: '#100E0C', surfaceInverted: '#FBFAF7',
  fg: '#F5F3EE', fgMuted: '#A8A39A', fgSubtle: '#756F65',
  fgInverted: '#141311', fgOnAccent: '#FFFFFF',
  accent: '#4C7EFF', accentStrong: '#6E97FF',
  accentSoft: '#26365C', accentGlow: 'rgba(76,126,255,0.30)',
  cyan: '#35C6DC', cyanSoft: '#1E3A44',
  red: '#F0524A', orange: '#FF8A3D', yellow: '#FFB93E', green: '#2FBE6B', blue: '#4C7EFF',
  risk: {
    healthy:  { text: '#2FBE6B', fill: '#2FBE6B' },
    watch:    { text: '#A9D24A', fill: '#A9D24A' },
    stress:   { text: '#FFB93E', fill: '#FFB93E' },
    high:     { text: '#FF8A3D', fill: '#FF8A3D' },
    critical: { text: '#F0524A', fill: '#F0524A' },
  },
  viz: ['#4C7EFF','#199E70','#C98500','#0E9E4E','#9085E9','#E66767','#D55181','#D95926'],
  seq: { 100:'#16337C', 300:'#2456BF', 500:'#4C7EFF', 700:'#A9C2FF' },
  border: 'rgba(245,243,238,0.10)', borderStrong: 'rgba(245,243,238,0.20)',
  ring: '#4C7EFF', overlay: 'rgba(0,0,0,0.64)',
  mapCanvas: '#000000',
  panelGlass: 'rgba(20,19,17,0.66)', panelGlassStrong: 'rgba(20,19,17,0.90)',
} as const;
```

> **RN note:** `color-mix()` and `oklch` are not available in React Native StyleSheet, so `accentSoft`/`cyanSoft`/`accentGlow` are **precomputed** to concrete values above. Keep a `scripts/build-tokens.ts` that reads `theme/tokens.css` and emits these, so web remains the source and mobile can't drift.

### 3.3 Typography

Font families load via `expo-font` (`@expo-google-fonts/inter`, `@expo-google-fonts/geist`, `@expo-google-fonts/jetbrains-mono`). Display = Geist, body = Inter, mono = JetBrains Mono — matching web.

```ts
// src/design/type.ts
export const font = {
  sans: 'Inter_400Regular', sansMed: 'Inter_500Medium', sansSemi: 'Inter_600SemiBold', sansBold: 'Inter_700Bold',
  display: 'Geist_600SemiBold', displayBold: 'Geist_700Bold',
  mono: 'JetBrainsMono_400Regular', monoMed: 'JetBrainsMono_500Medium',
};

// Type scale (px) — subset of the web scale tuned for mobile density
export const type = {
  micro:  { size: 11, line: 14, family: font.mono,     tracking: 0.5, upper: true },  // T-tier badges, kickers
  label:  { size: 12, line: 16, family: font.sansMed },                               // captions, chips
  sm:     { size: 13, line: 18, family: font.sans },                                  // secondary body
  base:   { size: 15, line: 22, family: font.sans },                                  // body (default)
  md:     { size: 16, line: 24, family: font.sansMed },                               // list-row title
  lg:     { size: 18, line: 24, family: font.sansSemi },                              // section head
  xl:     { size: 20, line: 26, family: font.display },                               // screen sub-title
  '2xl':  { size: 24, line: 30, family: font.display },                               // screen title
  '3xl':  { size: 28, line: 34, family: font.displayBold },                           // hero
  '4xl':  { size: 34, line: 38, family: font.displayBold, tracking: -0.5 },           // KPI value
  numeric:{ fontVariant: ['tabular-nums'] as const },                                 // apply to all numbers
};
```

Rules: **all numerics use `tabular-nums`** (KPIs, areas, coordinates, dates). Mono uppercase `micro` is the tier-badge / kicker voice (`T2 · EVIDENCE`, `LIVE`, `UNMONITORED`). Never letter-space body copy.

### 3.4 Spacing, radii, motion, elevation, z-index

```ts
export const space = { 0:0, 1:4, 2:8, 3:12, 4:16, 5:20, 6:24, 7:28, 8:32, 10:40, 12:48, 16:64, 20:80 };
export const radius = { none:0, sm:6, md:10, lg:14, xl:18, '2xl':24, '3xl':34, full:9999 };

export const motion = {
  instant:80, fast:160, normal:220, slow:360, slower:560,
  // reanimated easings (map to Bezier)
  standard: Easing.bezier(0.2,0,0,1),  emphasis: Easing.bezier(0.2,0,0,1.2),
  enter: Easing.bezier(0,0,0.2,1),     exit: Easing.bezier(0.4,0,1,1),
  spring: { damping: 18, stiffness: 220, mass: 1 },   // reserved for map camera / sheet
};
// prefers-reduced-motion → collapse durations to 0, spring→standard (honor AccessibilityInfo.isReduceMotionEnabled)

// Elevation — RN can't use CSS box-shadow multi-layer; use these presets (iOS shadow / Android elevation)
export const shadow = {
  soft:    { ios: {shadowColor:'#000', shadowOpacity: s(0.05,0.55), shadowRadius:2,  shadowOffset:{width:0,height:1}}, android:{elevation:1} },
  card:    { ios: {shadowColor:'#000', shadowOpacity: s(0.10,0.70), shadowRadius:12, shadowOffset:{width:0,height:6}}, android:{elevation:3} },
  popover: { ios: {shadowColor:'#000', shadowOpacity: s(0.18,0.78), shadowRadius:24, shadowOffset:{width:0,height:12}},android:{elevation:8} },
  overlay: { ios: {shadowColor:'#000', shadowOpacity: s(0.28,0.85), shadowRadius:40, shadowOffset:{width:0,height:20}},android:{elevation:16} },
  accent:  { ios: {shadowColor: accent, shadowOpacity: 0.42, shadowRadius:24, shadowOffset:{width:0,height:12}},       android:{elevation:6} },
};
// s(lightOpacity, darkOpacity) picks per active surface — dark needs deeper shadows.

export const z = { base:0, raised:1, sticky:100, dropdown:1000, overlay:1100, modal:1200, toast:1300, tooltip:1400 };
```

---

## 4. Library choices (locked)

| Concern | Library | Why |
|---|---|---|
| Navigation | `expo-router` v3+ | file-based, deep-link + typed routes; matches task stack |
| Bottom sheets | `@gorhom/bottom-sheet` v5 | detents, backdrop, gesture; hosts scan dock, filters, quick-add, layer picker |
| Gestures | `react-native-gesture-handler` + `react-native-reanimated` v3 | swipe rows, FAB, map drawing gestures, spring camera |
| Maps | `@maplibre/maplibre-react-native` | 1:1 with web MapLibre (Esri raster, vector draw, raster paint for NDVI/moisture/thermal, offline tile cache). react-native-maps is fallback only |
| 3D cutaway | `expo-gl` + `three` | ports web `ParcelCutaway` (raw three.js) directly; Skia is a fallback |
| Charts / sparklines | `react-native-skia` (`@shopify/react-native-skia`) | KPI sparklines, health rings, timeline; GPU, theme-aware, cheap |
| Offline DB | `expo-sqlite` + `drizzle-orm` | ports twins-store + scan-jobs + read caches; tenant-partitioned |
| Server cache | `@tanstack/react-query` + `drizzle` persister | staleTime 30s (web parity); offline reads from SQLite |
| Secure storage | `expo-secure-store` | JWT, access pass, tenant, theme |
| SSE (scan progress) | `react-native-sse` (or XHR-stream) | must inject `Authorization` + `X-Tenant-Id` (EventSource can't); `\n\n` reframe + heartbeat skip |
| Push | `expo-notifications` | alert push (channel includes `push`) + scan-complete |
| Background jobs | `expo-task-manager` + `expo-background-fetch` | resume scan SSE / poll on relaunch |
| Camera | `expo-camera` | annotation photos, future vision capture |
| File import | `expo-document-picker` + RN shapefile/KML/GeoJSON parsers | boundary import (shpjs/togeojson are DOM-bound → replace) |
| Icons | `lucide-react-native` | same icon set as web |
| Haptics | `expo-haptics` | swipe-ack, FAB, tab, destructive confirm |

---

## 5. Component library

Each component: purpose, props sketch, states, and the honesty/interaction rules it must encode. Components live in `src/design/components/` and consume `useTheme()` only.

### 5.1 Buttons — `<Button>`

```ts
type ButtonProps = {
  variant: 'primary'|'secondary'|'ghost'|'destructive'|'accent-soft';
  size: 'sm'|'md'|'lg';
  icon?: LucideIcon; iconRight?: LucideIcon;
  loading?: boolean; disabled?: boolean;
  fullWidth?: boolean; onPress: () => void;
};
```
- **primary**: `accent` bg, `fgOnAccent` text (WHITE — never black on cobalt), `shadow.accent`. Radius `md`. Min tap target **44×44** (hit-slop padded on `sm`).
- **secondary**: `surfaceSunken` bg, `fg` text, `border`.
- **ghost**: transparent, `fgMuted`; hover→`surfaceSunken`.
- **destructive**: `red` bg — always paired with a confirm sheet + `Haptics.notificationAsync(Warning)`.
- **loading**: swap label for `<ActivityIndicator>` + keep width (no layout jump); disable press. Used by "Find", "Build HD twin", "Create farm", "Generate report".
- Press feedback: reanimated scale 0.97 + opacity, `motion.instant`.

### 5.2 Cards — `<Card>` / `<StatCard>` / `<KpiCard>`

- **Card**: `surface` bg, `border` 1px, radius `lg`, `shadow.card`, padding `space.4`. Optional `onPress` → adds pressable ripple + chevron affordance.
- **KpiCard** (Portfolio row): eyebrow (`micro` mono), big value (`type.4xl` tabular), delta chip, footnote. **Honest-empty:** when the metric is null, render `—` value + amber footnote ("Awaiting first satellite pass" / "Modelled once observations land" / "No exposure computed yet"). Never zero-as-green. Optional Skia sparkline strip.
- **StatCard** (twin/farm mini-metrics): label + value + unit, optional sparkline.

### 5.3 List rows — `<ListRow>` / `<FarmRow>` / `<SupplierRow>` / `<AlertRow>`

The workhorse of Farms/Alerts/Suppliers/Reports.
```ts
type ListRowProps = {
  leading?: ReactNode;      // icon chip / avatar / RiskPill
  title: string; subtitle?: string;
  trailing?: ReactNode;     // RiskPill, chevron, timestamp, badge
  meta?: string;            // right-aligned tabular (area ha, revenue $K)
  onPress?: () => void;
  swipe?: SwipeAction[];    // see §6.3
  tier?: TierLevel;         // optional tier dot
};
```
- Height 64 (single-line) / 76 (two-line). `border` bottom hairline, inset by leading width.
- **FarmRow**: sprout chip, name + supplier ("Direct" if none), crop chips, `RiskPill`, area meta.
- **SupplierRow**: name + region, farm count, `RiskPill(maxRisk)`, revenue-at-risk meta (`—` if null).
- **AlertRow**: `RiskPill(severity)` leading, title + category chip, confidence %, relative time; **swipe → Acknowledge** (queues offline).

### 5.4 Bottom sheets — `<Sheet>` (gorhom)

Standard presentation for: scan dock, object-library quick-add, layer picker, filters, alert-ack detail, tenant switcher, zone-intent editor, annotation input.
- Detents: `['30%','60%','92%']` default; content-sized where possible. `panelGlass` background over map contexts, `surfaceElevated` otherwise. Grabber handle, `overlay` backdrop (tap-to-dismiss), radius `2xl` top corners.
- Keyboard-aware (forms). Springs on open with `motion.spring`.

### 5.5 Map controls — `<MapControlCluster>` / `<ToolRail>` / `<LayerPill>` / `<OpacitySlider>`

Ported from Studio + Farm map. All are `panelGlass` floating chips (glass reads on the always-dark map canvas).
- **NavCluster**: zoom ±, recenter, north-reset — bottom-right, `panelGlass`, radius `full`, 44px targets.
- **ToolRail** (Studio): vertical floating rail, grouped tools with dividers (see §7.2). Active tool = `accent` fill; tooltip becomes a **hint banner** at top on mobile ("Tap to drop a pin" + Cancel).
- **LayerPill**: segmented control Satellite / NDVI / Moisture / Thermal (raster paint transforms). Collapses to a single icon-button that opens a **layer sheet** on small screens.
- **OpacitySlider**: vertical slider 0.2–1.0 for the active raster layer.

### 5.6 Chips — `<Chip>` / `<FilterChip>` / `<ChipMultiSelect>`

- **Chip**: `surfaceSunken` bg, `fg` text, radius `full`, `micro`/`label`. Crop chips, category chips.
- **FilterChip**: toggle; active = `accentSoft` bg + `accent` text + check icon. Used in Farms/Alerts/Explorer filters.
- **ChipMultiSelect** (onboarding basics): preset chips + free-text add field (lowercased/deduped), Enter/Add commits. Native input + horizontal wrap.

### 5.7 Tier badge — `<TierBadge>` (honesty-critical)

```ts
type TierLevel = 'T1'|'T2'|'T3';   // regulatory | evidence | screening
type TierBadgeProps = { tier: TierLevel; label?: boolean; approximate?: boolean };
```
- Rendered as `micro` mono pill: `T1 · REGULATORY` (green outline), `T2 · EVIDENCE` (cobalt outline), `T3 · SCREENING` (amber outline). Outline+text, **never a filled block** (tier is metadata, not status).
- `approximate` adds a dashed underline + "approx." suffix (cadastral T2 = exact; OSM/vision T3 = approximate → "drag corners to trace exact").
- Appears on: signals, parcels, seg-objects, observations, report data-quality notes. **Any EO value without a resolvable tier renders no fabricated tier** — it shows the honest-null.

### 5.8 Risk pill — `<RiskPill>` (honesty-critical)

```ts
type RiskBand = 'healthy'|'watch'|'stress'|'high'|'critical'|null;
type RiskPillProps = { band: RiskBand; score?: number; size?: 'sm'|'md'; showLabel?: boolean };
```
- Icon + color + **text label always together** (colorblind rule). Icons: `sprout`(healthy) `leaf`(watch) `triangle-alert`(stress) `flame`(high) `octagon-alert`(critical).
- `band=null` → **Unmonitored**: dashed ring, `fgSubtle`, "Unmonitored" label. **Never a fake green.**
- `scoreToBand(0..100)`: ≥80 critical, ≥60 high, ≥40 stress, ≥20 watch, else healthy (ported).
- `<RiskLegend>` renders the ordered ramp for headers.

### 5.9 Charts — Skia primitives

- `<Sparkline data>` — KPI cards, telemetry readings (deterministic seed). Line + soft area gradient (`accentGlow`).
- `<HealthRing value>` — twin/farm health score (0–100), band-colored arc.
- `<SeasonTimeline months values>` — 12-mo NDVI scrubber (Studio). Draggable thumb, month label, tabular value.
- `<MiniBar>` / `<TrendChart>` — analytics. Categorical colors from `colors.viz`; sequential from `colors.seq`. Diverging for risk deltas. All theme-aware, all tabular axis labels.

### 5.10 FAB — `<FloatingAction>`

- 56px circle, `accent`, `shadow.accent`, floats above tab bar (bottom-right, `space.4` inset + tab-bar-height + safe-area). Icon morphs by context (`plus` onboard, `map` studio). Reanimated spring in/out on scroll (hide on scroll-down, reveal on scroll-up). Absent for roles without the action (no dead FAB).
- Long-press → speed-dial (Onboard farm / New twin / Run scan) when multiple actions available.

### 5.11 State components — `<EmptyState>` / `<LoadingState>` / `<ErrorState>` / `<StaleBadge>` / `<OfflineBanner>`

Encode the **honesty + degradation** discipline as first-class components:
- **EmptyState**: icon + honest headline + guidance + optional CTA. Presets: `no-signals` ("No signals yet — run a scan"), `awaiting-pass` ("Awaiting first satellite pass"), `gateway-unconfigured` ("Connect the AlphaGeo gateway for live signals"), `no-farms` (→ Onboard CTA), `no-twins` ("No twins yet 🌱"), `vision-coming-soon` ("AI auto-trace isn't live yet"), `honest-degraded` ("Automatic lookup isn't connected yet — import or draw below").
- **LoadingState**: skeleton rows/cards (shimmer via reanimated), never a bare spinner for lists. Spinner only for inline button/async actions.
- **ErrorState**: maps status → distinct copy: `503 gateway_unconfigured` (not-connected), `502` (unreachable), `422 invalid_geometry` (self-intersecting/unclosed → jump to Boundary), `404 vision_not_available` (coming-soon), `409 invalid_status_transition` (already resolved). **Never a generic "Something went wrong" for a known status.**
- **StaleBadge**: on cached reads offline — `micro` pill "Updated 12m ago · offline".
- **OfflineBanner**: root-level thin banner when `NetInfo` offline; shows queued-mutation count, tap → Offline & Sync.

### 5.12 Inputs, toggles, segmented — `<Input>` `<Toggle>` `<Segmented>` `<Stepper>`

- **Input**: `surface` bg, `border`, radius `md`, 44px min height, `fg` text, `fgSubtle` placeholder, focus ring `ring`. Mono variant for GeoJSON paste.
- **Toggle**: iOS-style switch, `accent` on. Zone intent (expects-irrigation / standing-water-ok).
- **Segmented**: priority pickers (low/med/high), report kind, layer switch.
- **Stepper**: geometry numeric editors (rect w/h/rotation, circle radius, point scale) — replaces web drag handles for precision.

### 5.13 Nav chrome — `<TabBar>` `<Header>` `<Breadcrumb>` `<StatusBar>`

- **TabBar**: custom `@react-navigation/bottom-tabs` bar, `bgElevated` + top hairline, safe-area padded, active = `accent` icon+label, badge on Alerts (open count). Blur (`expo-blur`) over map-adjacent screens.
- **Header**: large-title on scroll (native feel), left back-chevron, right action slot (filter, share, layer). Title = `type.2xl` display.
- **Breadcrumb**: Portfolio › Supplier › Farm (tap to pop) — compact, `fgMuted`.

---

## 6. Mobile-native interaction patterns

### 6.1 Pull-to-refresh
Every list/dashboard (Portfolio, Farms, Alerts, Reports, farm signals) uses `RefreshControl` → invalidates the React Query key + re-fetches. Offline: pull shows "Offline — showing cached" toast instead of spinning forever.

### 6.2 Bottom sheets over modals
Prefer `@gorhom/bottom-sheet` for anything contextual (filters, quick-add, layer picker, zone intent, ack detail, scan dock). Full modals reserved for blocking flows (onboarding create confirm, sign-out, destructive confirm).

### 6.3 Swipe actions
- **AlertRow** swipe-left → **Acknowledge** (green), swipe-right → **Snooze/dismiss**. Ack queues offline; haptic on commit.
- **Twin/Report rows** swipe-left → Delete (destructive, confirm on release).
- Implemented via `reanimated` + `gesture-handler` `Swipeable`; respects reduced-motion.

### 6.4 FAB + speed-dial
See §5.10. Context-aware, scroll-reactive, role-gated.

### 6.5 Map gestures (translating web mouse → touch)
| Web | Mobile |
|---|---|
| click select | tap |
| drag twin | long-press → drag (dragPan disabled during) |
| vertex drag | drag handle dot (enlarged 24px touch target) |
| midpoint click (add vertex) | tap midpoint dot |
| right-click (delete vertex) | long-press vertex → confirm |
| dbl-click finish poly | "Finish" button in hint banner (+ tap last vertex) |
| Esc cancel | "Cancel" in hint banner |
| Cmd+Z / Del / Cmd+D | on-screen Undo/Redo/Delete/Duplicate buttons in tool rail |
| scroll opacity | vertical slider |

Drawing shows a persistent **hint banner** (top) with the current instruction + primary action + Cancel — replacing hover tooltips and keyboard shortcuts.

### 6.6 Haptics
FAB press, tab switch, swipe-commit, toggle, destructive confirm, scan-complete. `expo-haptics` light/medium/notification per weight.

### 6.7 Background continuity
Scan jobs persist to SQLite and **resume on relaunch** (twins/{aoi} as source of truth). A build that completes while backgrounded fires an `expo-notifications` local push ("HD twin ready"). The scan dock modal shows live progress via `react-native-sse` with reconnect+backoff.

---

## 7. Studio — mobile shell detail (the densest surface)

### 7.1 Layout
Full-bleed MapLibre canvas. Floating overlays (all `panelGlass`):
- **Top:** property picker chip (left) + layer segmented/sheet + hint banner (when tool active).
- **Left:** collapsible **ToolRail** (tap chevron to collapse to a single toolbox button on small phones).
- **Right:** inspector opens as a **right bottom-sheet** (twin/signals/reports/analytics/history tabs) instead of a fixed sidebar.
- **Bottom:** twin strip carousel + season timeline scrubber (collapsible).
- **Bottom-left:** scan-jobs progress dock (mini, expandable to modal).

### 7.2 Tool rail groups (ported)
```
Select/move · Edit-boundary(vertex) │ Note · Issue · Task │ Measure │
Zone · Parcel · Object-library │ Rect · Circle · Row/line │
Duplicate · Delete │ Undo · Redo │ Isolate · Labels │ Analytics · History · Reports
```
Object-library opens a category-tabbed **sheet** (7 categories, 62 catalog items, emoji icons). Picking sets pending object + switches to placement tool.

### 7.3 Twin Detail dossier
Tabbed screen: **Overview** (specs, telemetry preview, maintenance, 3D cutaway + geometry) · **Telemetry** (readings grid + add channel) · **Maintenance** (log + timeline) · **Calendar** (month grid + schedule) · **Docs** (attach). Autosave to SQLite (Saving/Saved indicator). Latent tabs (Routines/Yields/Treatments) exist in the model — build as additional tabs on mobile.

### 7.4 3D cutaway
`expo-gl` + `three` port of `ParcelCutaway`: satellite-composited top face (Esri tiles, cached), soil-strata side faces (**bundle** `soil-strata.jpg` as an asset — no CSP-blocked remote fetch), auto-rotate 0.12 rad/s, WebGL-loss → static fallback card.

---

## 8. Offline & sync model (IA-relevant)

- **Read caches** (React Query + Drizzle persister → SQLite, **tenant-partitioned**): farms, parcels, zones, alerts, observations, reports, portfolio rollups, suppliers, regions. Every cached screen shows `<StaleBadge>` offline.
- **Client-of-record** (ports web localStorage): `twins` (`rf.studio.twins.v1`) + `scanjobs` (`rf.studio.scanjobs.v1`) → Drizzle tables. Full offline CRUD; sync to `farm.asset/zone/parcel` when endpoints land.
- **Outbound mutation queue** (SQLite): alert ack, farm/parcel/zone create, report generate request, feedback labels. Each carries method/url/body + captured tenant. Replay on reconnect with fresh JWT; handle `409` (ack transition) and `422` (geometry) on flush. Onboarding create is sequential (farm→parcels→zones) with partial-success resumability + idempotency awareness.
- **Tenant switch** purges/segregates the per-tenant partition and invalidates all queries (mirrors `rwr.tenant-changed`).
- **Hard events:** `401 token_revoked` → sign out + purge; `403 tenant_suspended` → Locked state.

---

## 9. Accessibility & platform

- All interactive targets ≥44×44; `accessibilityRole`/`accessibilityLabel` on every control; risk conveyed by icon+label+color (never color alone).
- Dynamic Type: type scale respects `PixelRatio.getFontScale()` (cap at 1.3× to protect map chrome).
- Reduced motion honored (durations→0, spring→standard). Reduced transparency → swap `panelGlass` for solid `surfaceElevated`.
- Dark/light both fully styled; theme-toggle in More stamps `rf.surface-mode`. Splash + gate force dark for brand consistency.
- Deep links / universal links: `sanitizeNextUrl` port (must resolve to a known route, no foreign host) for push-notification navigation and invite/verify links.

---

## 10. Build order (IA/design track)

1. **P0 foundation:** tokens.ts (from build-tokens script), ThemeProvider, type/space/motion, core components (Button, Card, ListRow, Sheet, RiskPill, TierBadge, Empty/Loading/Error), TabBar + role-filtered router, gate screens.
2. **P0 surfaces:** Portfolio, Farms + Farm Detail, Alerts + ack, Reports, Onboarding flow, Studio map + scan dock + twin detail.
3. **P1:** Suppliers/Regions, Analytics charts, tenant/district switchers, push categories, offline queue UI, 3D cutaway.
4. **P2:** CRM re-skin surfaces (Buyers/Suppliers/Growers/Programs), admin (Staff/Tenants), OIDC login, vision refine object-to-twin.

---

*Tokens are generated from `app/src/crm/theme/tokens.css` — keep `scripts/build-tokens.ts` as the single source so web and mobile never drift.*
