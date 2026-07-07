# Report.Farm Mobile — Mission Control Domain Design

**Domain:** Mission Control — Portfolio / Buyers / Suppliers / Growers / Analytics
**Platform:** Expo + React Native + TypeScript (iOS + Android, one codebase)
**Navigation:** expo-router (bottom tabs + stack + drawer)
**Data:** react-query over `/api/v1/farm/*`, offline cache via expo-sqlite + Drizzle, secrets in expo-secure-store, prefs in AsyncStorage
**Maps:** @maplibre/maplibre-react-native · **Push:** expo-notifications · **Design:** cobalt-accent, dark-mode-first, matches web `--risk-*` / `--accent` token cascade

---

## 0. Design foundations (carry from web, do not re-derive)

### 0.1 The honesty contract (P0, non-negotiable)
Report.Farm's risk/revenue store is **empty until the AlphaGeo P2 ingest+rollup worker runs**. The mobile app must reproduce the web's honesty tiers *exactly* and **never fabricate a signal**:

- **`RiskPill` with `band=null` → "Unmonitored"** chip: dashed circle (`CircleDashed`), sunken surface, subtle text. **Never a fake green healthy pill.**
- Risk band ramp (0–100 via `scoreToBand`): `healthy` (≥0, `Sprout`), `watch` (≥20, `Leaf`), `stress` (≥40, `TriangleAlert`), `high` (≥60, `Flame`), `critical` (≥80, `OctagonAlert`).
- **Color never carries meaning alone** — every pill ships color **+ icon + text label** (colorblind-safe). Enforced at the RN component boundary so callers cannot render color-only.
- KPI honest footnotes are literal strings: `"Awaiting first satellite pass"`, `"Modelled once observations land"`, `"Estimated vs. baseline"`, `"No exposure computed yet"`, `"Across flagged suppliers"`.
- Yield-at-Risk is a **client-derived display estimate** = `round(maxRisk * 0.18)`%, shown only when a real `max_risk_score` exists; otherwise `—`.
- Revenue formatting `usd()`: `>= 1M → $X.XM`, `>= 1K → $XK`, else `$X`.
- Every list/table/panel degrades to an explicit **honest-empty state** with guidance, never a spinner-forever or a fabricated row.
- Honesty tiers T1 regulatory / T2 evidence / T3 screening and detectability labels flow through from observation/alert payloads — mobile renders the tier badge it is given; it never upgrades a tier.

### 0.2 Auth & tenancy model (carry exactly)
- **Dual permission scheme.** Modern dot-perms (`farm.portfolio.view`, `farm.profile.read/write`, `farm.zone.read/write`, `farm.observation.read`, `farm.alert.read/manage`, `farm.report.generate`, `platform.admin.all`) **and** legacy colon-roles (`farm:view`, `farm:onboard`, `alert:manage`, `report:generate`, `ops:manage`, `sales:manage`, `analytics:view`, `customer:view`, `vendor:*`, `platform:admin`).
- Client role gating is **UX-only defense-in-depth**. The server `farmGate()`/`requirePermission` is the real boundary (403 + `authz.denied` audit). Mobile mirrors the web allow-list to decide tab/CTA visibility from **cached roles**, but assumes the server can still 403.
- Every read runs inside `withTenantConn` Postgres RLS — strict multi-tenant isolation. Tenant scope is server-enforced; switching tenant purges the entire query cache.
- **Vendor isolation:** any `vendor:*` role is forced to the Suppliers surface and cannot resolve others. Mobile routing must honor this.
- Session: JWT (~8h expiry) in expo-secure-store. Access-code pass gate precedes login (skippable in dev).

### 0.3 Design language
Cobalt `--accent`; `--surface` / `--surface-sunken` / `--bg`; `--fg` / `--fg-muted` / `--fg-subtle`; `--border` / `--border-strong`; radii `lg`/`2xl`/`full`; card shadow + accent glow; display font for headers, tabular-nums for metrics. Light + dark both fully tokenized; RN theme provider driven by `rwr.surface-mode` (AsyncStorage) with system-default fallback. Spring easing on card/press transitions.

---

## 1. Epics & User Stories

Roles referenced: **Buyer Admin** (admin, full portfolio + onboard + tenant), **Portfolio Lead** (buyer, portfolio view + reports), **Farm Operations** (ops, farm CRUD + onboard + alert manage), **Grower** (customer, own farms only, isolated).

### EPIC A — Access & Session
**A1.** *As a Buyer Admin, I want to sign in with a one-tap demo persona, so that I can enter the right surface without typing credentials.*
- AC: Login screen shows 4 persona buttons (Buyer Admin, Portfolio Lead, Farm Operations, Grower) mapping to `{role}@{tenant}.demo`, default tenant `demo-buyer`.
- AC: Tapping a persona calls `POST /api/v1/auth` (devLogin) and lands on the role's primary surface.
- AC: On failure a toast shows the auth error; no partial session is stored.

**A2.** *As any user, I want manual sign-in with tenant slug + email, so that I can access my real tenant.*
- AC: Manual form validates non-empty tenant + email; submit calls devLogin.
- AC: Successful login persists JWT to secure-store and role list to cache.

**A3.** *As a prospective user, I want to request portal access, so that I can self-register when it's allowed.*
- AC: App fetches `GET /api/v1/auth/registration-config`; the Register tab / "Request portal access" only appears when `ALLOW_SELF_REGISTRATION` is true.
- AC: Register form collects invite type (Employee/Customer/Vendor) + tenant + name + email → `POST /api/v1/auth` (devRegister) → lands on primary surface.

**A4.** *As a returning user, I want the app to remember my session, so that I re-enter without logging in each time.*
- AC: On cold start, if a non-expired JWT exists, skip login and route to primary surface; cached data renders immediately with a stale badge until refresh.
- AC: If token is expired/invalid, route to login preserving intended destination (sanitized).

**A5.** *As any user, I want the access-code gate honored, so that pre-auth entry matches web policy.*
- AC: If no access pass is present (and not dev), show the access-code screen before login; a valid code stores the pass and proceeds.

**A6.** *As any user, I want sign-out to fully tear down, so that no tenant data leaks.*
- AC: Sign out closes the realtime/push socket, clears secure-store token, purges query cache + SQLite tenant tables, and returns to login. Surface-mode preference survives.

### EPIC B — Portfolio Mission Control (home)
**B1.** *As a Portfolio Lead, I want a portfolio home showing my buyer name and global risk posture, so that I get an at-a-glance command view.*
- AC: Header shows `{buyer_name} — Global Portfolio` with "Supply-Chain Intelligence" eyebrow and a Risk Legend.
- AC: Screen composes KPI row, Suppliers list, Disruptions feed, Monitored Farms grid; all scrollable, pull-to-refresh.
- AC: With empty risk store, every section shows its honest-empty state; nothing is fabricated.

**B2.** *As a Portfolio Lead, I want the four KPIs (Suppliers Monitored, Portfolio Risk, Yield at Risk, Revenue at Risk), so that I see topline exposure.*
- AC: Values computed from `/farm/portfolio/rollup`; em-dash `—` + correct footnote when the underlying value is null/0.
- AC: Yield-at-Risk replicates `round(maxRisk*0.18)`% and only renders when `max_risk_score != null`.
- AC: Portfolio Risk shows `round(max)/100` with Peak + Average sub-metrics.

**B3.** *As a Farm Operations user with `farm:onboard`, I want an Onboard-farm CTA, so that I can start registering a farm.*
- AC: CTA visible only when cached roles include `farm:onboard`; hidden otherwise (no dead-end form that will 403).
- AC: Tap routes to the Onboarding flow entry (out-of-scope domain, handoff only). Disabled offline with a clear message.

**B4.** *As a Portfolio Lead, I want a Twin Studio entry, so that I can jump to the digital-twin workspace.*
- AC: A "Twin Studio" affordance routes to the Studio domain entry (handoff only).

### EPIC C — Suppliers & Disruptions
**C1.** *As a Portfolio Lead, I want suppliers ranked by peak risk, so that I triage the worst exposure first.*
- AC: List from `/farm/portfolio/suppliers` sorted `max_risk_score DESC NULLS LAST`, then name.
- AC: Each row: supplier name, region (or `—`), farm count, RiskPill(band+score), revenue-at-risk (`usd` or `—`).
- AC: Empty → "No suppliers onboarded yet. Add suppliers and their farms to begin portfolio monitoring."

**C2.** *As a Portfolio Lead, I want to tap a supplier to drill in, so that I see its farms/region (mobile enhancement over web's static table).*
- AC: Tapping a supplier row opens a Supplier Detail sheet listing that supplier's farms (filtered from `/farm/farms`) and its sourcing region, each tappable into Farm Detail.

**C3.** *As a Portfolio Lead, I want an active-disruptions feed, so that I'm aware of threshold crossings.*
- AC: Feed from `/farm/alerts` (no farm filter); each item shows title, RiskPill (band from `confidence*100`), optional summary.
- AC: Empty → explains alerts appear automatically when a satellite pass detects a threshold crossing.
- AC: Alerts are push-notification candidates (see EPIC H).

### EPIC D — Monitored Farms
**D1.** *As a Portfolio Lead, I want a grid/list of all monitored farms, so that I can navigate to any farm.*
- AC: Cards from `/farm/farms`: farm name + Sprout icon, supplier ("Direct" if none), RiskPill (`latest_risk_band` or `scoreToBand(latest_risk_score)`), crop chips (capitalized), `total_area_ha` localized, Open affordance.
- AC: Header shows farm count; empty → onboarding guidance; loading → skeleton cards.
- AC: Tapping a card opens Farm Detail.

**D2.** *As a Grower, I want to see only my own farms, so that isolation is respected.*
- AC: Grower persona lands on a farms-scoped surface; server RLS returns only their farms; nav hides portfolio-wide surfaces.

### EPIC E — Farm Detail
**E1.** *As a Farm Operations user, I want a per-farm workspace, so that I can inspect a single farm end to end.*
- AC: Breadcrumb Portfolio › Supplier › Farm; header shows name, supplier, area (ha), crop chips.
- AC: KPI chips: Farm Health (`latest_risk_score`/100), Active Signals (open alert count), large RiskPill.
- AC: Body sections: Monitoring Zones, Farm Map, Signal Timeline, Alerts, Field Report.
- AC: Parallel queries for profile/parcels/zones/alerts/observations; each section has its own honest-empty state.
- AC: No farm selected / deep-link miss → "No farm selected" with Back to portfolio.
- AC: Lazy module missing → "coming online" fallback (parity with web).

**E2.** *As a Farm Operations user, I want a map of boundary + parcels + zones, so that I can orient in the field.*
- AC: MapLibre renders boundary MultiPolygon, parcel polygons, zone polygons with the risk-band legend.
- AC: Map + geometry are cached for offline field use.

**E3.** *As a Farm Operations user, I want a signal timeline of observations, so that I can review measurements over time.*
- AC: Observations from `/farm/observations?farm_id=`; each shows measurement/value/unit/confidence, cloud %, source/provider/collection, scene id, acquired_at, and its honesty tier badge.
- AC: Empty (pre-P2) → "No observations yet — signals begin with the first satellite pass."

### EPIC F — Alerts
**F1.** *As a Farm Operations user with `alert:manage`, I want to acknowledge an open alert, so that my team knows it's being handled.*
- AC: Open alert shows Acknowledge button (spinner while pending); `POST /farm/alerts/:id/ack` transitions open→ack.
- AC: Success → toast "Alert acknowledged." + query invalidation; acked shows "Ack'd".
- AC: Already-ack is idempotent; resolved/suppressed returns 409 `invalid_status_transition` → toast explains it can't be acked.
- AC: Ack button hidden for users without `farm.alert.manage`/`alert:manage`.

**F2.** *As a Farm Operations user, I want to queue an ack offline, so that field work isn't blocked.*
- AC: Offline ack is enqueued optimistically (pill shows "Pending sync"); on reconnect it replays; a 409 on replay resolves the item to "Already resolved" without error spam.

### EPIC G — Field Reports
**G1.** *As a Portfolio Lead with `report:generate`, I want to generate a field report, so that I can share a 30-day summary.*
- AC: Generate button posts `POST /farm/reports/generate {farm_id, type:'field', period:{start,end}}` for last 30 days.
- AC: Spinner while generating; success → toast + inline "View generated report" link to the Reports domain viewer.
- AC: Failure → toast retry.
- AC: Offline → button disabled with "Report generation needs a connection" (not queued — server-side generation).

### EPIC H — Alerts as Push
**H1.** *As any monitoring role, I want push notifications for new disruptions, so that I react without opening the app.*
- AC: On login the app registers an expo-notifications token (APNs/FCM) with the gateway.
- AC: A new tenant alert delivers a push with title + band; tapping deep-links to the alert in its Farm Detail (or portfolio feed if no farm context).
- AC: Notification honors band semantics (icon + label in body), never color-only.

### EPIC I — Cross-surface Navigation & Roles
**I1.** *As any user, I want role-filtered navigation, so that I only see surfaces I can visit.*
- AC: Nav is built from cached roles via the same allow-list as web `allowedSurfacesForRoles()`: Portfolio, Buyers, Programs, Analytics, Staff, Tenants, Growers, Suppliers.
- AC: `ops:manage` → Portfolio/Programs/Analytics; `sales:manage` → Buyers/Analytics; `customer:view` → Growers; `vendor:*` → Suppliers only (isolated); `platform:admin` → all.
- AC: Active surface highlighted; a status label names the current surface.

**I2.** *As a Buyer Admin, I want to route to Buyers/Suppliers/Growers/Analytics/Programs/Staff/Tenants, so that nav parity with web is complete.*
- AC: Each destination opens its surface (deep-read separate domains render their own screens or a "surface coming to mobile" placeholder with a web-fallback link). Buyers=sales, Suppliers=vendor, Growers=customer, Analytics, Programs=pm, Staff, Tenants.

**I3.** *As a Buyer Admin, I want a tenant switcher, so that I can operate across tenants.*
- AC: Tenant switcher visible only for `platform:admin`; selecting a tenant fires a tenant-changed event → purge + refetch all queries under new RLS.
- AC: District switcher visible only when a parent-org claim exists.

**I4.** *As any user, I want a light/dark toggle, so that the app matches my preference.*
- AC: Toggle persists to `rwr.surface-mode` (AsyncStorage); applied before first paint (no flash); survives sign-out.

### EPIC J — Analytics
**J1.** *As a Portfolio Lead, I want a portfolio analytics view, so that I can see aggregate risk/revenue trends.*
- AC: Mobile Analytics reuses the rollup + supplier + region views (there is **no** dedicated `/farm/analytics` endpoint — analytics today = rollup/KPI derivations). It renders KPI tiles + a supplier-risk bar list + region breakdown, all honest-empty when the store is empty.
- AC: Gated to `analytics:view` / `ops:manage` / `sales:manage`.

---

## 2. User Journeys

### J-1 Cold start → Portfolio (happy path)
1. App launches → splash → theme applied from cached `rwr.surface-mode`.
2. Access-pass check: pass present (or dev) → continue; else Access-code screen.
3. Secure-store JWT valid → skip login. Cached rollup/suppliers/farms/alerts render instantly with a **"Updated 3m ago · offline cache"** badge.
4. react-query revalidates in background; badge clears to live; KPIs animate to fresh values.
5. Portfolio Lead sees KPI row, suppliers ranked by peak risk, disruptions feed, farms grid.

### J-2 Login via demo persona
1. Login → tap "Portfolio Lead".
2. devLogin(`buyer@demo-buyer.demo`) → JWT stored, roles cached.
3. Route to primary surface (Portfolio). Nav tabs built from roles.

### J-3 Triage a supplier → farm → acknowledge alert
1. Portfolio home → tap top supplier row (highest peak risk).
2. Supplier Detail sheet lists that supplier's farms → tap a farm.
3. Farm Detail loads (parallel queries). Active Signals chip shows `3`.
4. Scroll to Alerts → tap Acknowledge on an open alert → spinner → toast "Alert acknowledged." → pill flips to "Ack'd".
5. Edge: alert already resolved → 409 → toast "This alert is already resolved and can't be acknowledged."

### J-4 Generate field report
1. Farm Detail → Field Report section → Generate field report.
2. POST reports/generate (30-day period) → spinner → toast "Report ready" + "View generated report".
3. Tap link → hand off to Reports domain viewer.
4. Edge (offline): button disabled with inline note; user taps it → tooltip "Needs a connection".

### J-5 Offline field visit (Farm Operations)
1. In coverage: open the farm, view map/zones/parcels — cached to SQLite.
2. Drive into no-signal field. App shows global **offline banner**; reads still render from cache with stale badge.
3. User acknowledges an alert → **queued** ("Pending sync") because writes require connectivity + server geometry validation.
4. Back in coverage → queue drains; ack replays; if 409, item resolves silently to "Already handled".

### J-6 Admin tenant switch
1. Buyer Admin → drawer → Tenant switcher → pick "acme-foods".
2. Tenant-changed event → cache purge + SQLite tenant tables cleared → all queries refetch under new RLS.
3. Portfolio re-renders for the new tenant; header buyer name updates.

### J-7 Vendor isolation
1. Vendor persona logs in → routing forces Suppliers (vendor) surface only.
2. Attempts to deep-link Portfolio → redirected back to Suppliers (client), and server would 403 regardless.

### J-8 Push-driven reaction
1. Backgrounded app; new critical alert → push "Critical · NDVI drop — Cerrado Farm 4".
2. Tap → app opens Farm Detail (that farm) scrolled to the alert → user acknowledges.

---

## 3. Screens

Each screen: purpose · layout · elements · states · nav · gestures.

### S-0 Access Code Gate
- **Purpose:** honor pre-auth access pass.
- **Layout:** centered logo, single code input, Continue button, theme toggle.
- **States:** default · invalid code (inline error) · verifying (spinner). Dev build auto-skips.
- **Nav:** → Login on success. **Gestures:** none special.

### S-1 Login / Register
- **Purpose:** authenticate; choose demo perspective.
- **Layout:** BrandMark, pill segmented control **Sign in / Create account**, SurfaceMode toggle top-right.
  - **Sign in:** 4 persona quick-buttons (Buyer Admin, Portfolio Lead, Farm Operations, Grower) in a 2×2 grid; divider "or"; manual fields tenant slug + email; Sign in button.
  - **Create account** (only if self-reg enabled): invite-type selector (Employee/Customer/Vendor), tenant, name, email, Request access button. If disabled, tab hidden and a subtle "Request portal access" link is absent.
- **States:** loading (registration-config fetch) · submitting (button spinner) · error toast · already-signed-in → auto-redirect.
- **Nav:** success → role primary surface. **Gestures:** swipe between Sign in/Register tabs.

### S-2 App Shell (Tab Navigator + Drawer)
- **Purpose:** role-filtered cross-surface navigation.
- **Layout:** **Bottom tab bar** with the primary surfaces the role may see (max 5; overflow → "More"). Typical Buyer Admin: Portfolio, Farms, Alerts, Analytics, More. **Drawer** (hamburger / avatar) holds the full role-filtered surface list (Portfolio, Buyers, Programs, Analytics, Staff, Tenants, Growers, Suppliers), Tenant switcher (admin), District switcher (org claim), user chip (name + roles + avatar), theme toggle, Sign out.
- **Elements:** active-tab accent indicator; header shows current surface title + buyer name; offline banner slot at top.
- **States:** nav derived from cached roles; vendor role → only Suppliers; unknown role → minimal safe set.
- **Nav:** tab/drawer item → surface stack. **Gestures:** edge-swipe opens drawer; long-press tab → quick actions (e.g., Portfolio long-press → jump to top-risk farm).

### S-3 Portfolio Mission Control (home) — **Screen A**
- **Purpose:** buyer supply-chain command view.
- **Layout (vertical scroll):**
  1. **Header:** eyebrow "Supply-Chain Intelligence"; title `{buyer_name} — Global Portfolio`; Risk Legend (horizontal, scrollable); action row with **Twin Studio** chip and **Onboard farm** CTA (role-gated).
  2. **KPI carousel/grid:** 4 KpiCards (2×2 on phone, horizontal snap-scroll option): Suppliers Monitored (regions/farms sub), Portfolio Risk (`/100`, peak/avg, footnote), Yield at Risk (`%`, footnote), Revenue at Risk (`usd`, footnote). Em-dash + footnote when empty.
  3. **Suppliers panel:** section head + ranked list (see S-4 embedded list).
  4. **Active Disruptions panel:** alert list (see feed).
  5. **Monitored Farms panel:** farm-count header + card list (see S-5 cards).
  6. Footer honesty note: "Risk and yield figures populate as the AlphaGeo satellite connection ingests observations…".
- **States:** loading skeletons per panel · honest-empty per panel · offline (stale badge + cached data) · error (retry chip).
- **Nav:** supplier row → S-4 sheet; farm card → S-6; Twin Studio → Studio domain; Onboard → Onboarding domain.
- **Gestures:** pull-to-refresh (revalidates all four queries); horizontal KPI snap; tap-and-hold farm card → context menu (Open, Generate report, View on map).

### S-4 Supplier Detail (bottom sheet / stack)
- **Purpose:** drill into one supplier (mobile enhancement).
- **Layout:** supplier name, region, RiskPill(peak), revenue-at-risk; farm-count; list of this supplier's farms (name + RiskPill + area) tappable to Farm Detail.
- **States:** empty (no farms) · offline (cached) · loading.
- **Nav:** farm → S-6; back → Portfolio. **Gestures:** swipe-down to dismiss sheet.

### S-5 Monitored Farms (embedded + full-screen "Farms" tab)
- **Purpose:** browse/navigate all tenant farms.
- **Layout:** search/filter bar (by crop, supplier, risk band); farm cards (name + Sprout, supplier/"Direct", RiskPill, crop chips, area ha, Open). Optional map-toggle to a clustered MapLibre view of all farm AOIs colored by band (with Unmonitored = neutral outline).
- **States:** loading skeletons · empty ("No farms onboarded…") · offline (cached list + boundaries) · error.
- **Nav:** card → S-6. **Gestures:** pull-to-refresh; list/map toggle; tap cluster → zoom.

### S-6 Farm Detail — **Screen B**
- **Purpose:** single-farm workspace.
- **Layout (scroll):**
  1. **Breadcrumb** Portfolio › Supplier › Farm (tappable).
  2. **Header:** farm name, supplier, area (ha), crop chips; KPI chips row (Farm Health `/100`, Active Signals count, large RiskPill).
  3. **Farm Map** (MapLibre): boundary MultiPolygon + parcels + zones; risk legend; fullscreen expand; recenter button.
  4. **Monitoring Zones** panel: zone list (name, type, intent tags); tap → zone focus on map.
  5. **Signal Timeline:** observation cards (measurement/value/unit, confidence, cloud %, source/provider/collection, scene id, acquired_at, honesty-tier badge). Empty pre-P2.
  6. **Alerts** panel: alert cards with RiskPill, title, category chip, summary, confidence %, status; Acknowledge button (role-gated).
  7. **Field Report** panel: Generate field report button + last-generated link.
- **States:** no `farm` id → "No farm selected" + Back to portfolio · module-missing → "coming online" fallback · per-section loading/empty/error · offline (map+zones+parcels+profile cached; observations/alerts show cached or empty; ack queues; report disabled).
- **Nav:** breadcrumb up; report link → Reports domain; back → previous. **Gestures:** pinch-zoom map; swipe between farms (prev/next in portfolio order); pull-to-refresh.

### S-7 Alerts (tab) + Alert Detail
- **Purpose:** tenant-wide disruptions inbox + manage.
- **Layout:** segmented filter (Open / Ack'd / Resolved); alert rows (RiskPill from confidence, title, farm name, time, status). Detail sheet: full summary, category, confidence, farm link, Acknowledge action.
- **States:** empty (honest note) · offline (cached; ack queues with "Pending sync") · ack pending (spinner) · 409 conflict (inline "Already resolved").
- **Nav:** row → detail; farm link → S-6. **Gestures:** swipe-left on row → Acknowledge (if permitted); pull-to-refresh.

### S-8 Analytics
- **Purpose:** portfolio analytics (rollup-derived; no dedicated endpoint).
- **Layout:** KPI tiles (reuse rollup), supplier-risk horizontal bar list (RiskPill-colored), region breakdown list, yield/revenue-at-risk summary. All honest-empty when store empty.
- **States:** loading · empty · offline (cached) · gated (hidden if role lacks `analytics:view`/`ops:manage`/`sales:manage`).
- **Nav:** bar/region → filtered Farms/Suppliers. **Gestures:** pull-to-refresh.

### S-9 Cross-surface placeholders (Buyers / Suppliers / Growers / Programs / Staff / Tenants)
- **Purpose:** nav parity for relabeled/separate-domain surfaces.
- **Layout:** each renders its own domain screens when built; until then a branded placeholder: surface title, one-line description, "Open in web app" fallback, and (Growers) note it is a bare full-screen map console. **Suppliers** honors vendor isolation. **Growers** is the grower persona's home (own farms only).
- **States:** placeholder · (when built) that domain's states. **Nav:** from drawer/tabs. **Gestures:** standard.

### S-10 Settings / Profile (in drawer)
- **Purpose:** theme, tenant/district switch, account, sign out.
- **Layout:** user chip (name/roles/avatar), Theme toggle (light/dark/system), Tenant switcher (admin), District switcher (org), Sign out (destructive).
- **States:** admin-only controls hidden per role. **Gestures:** tap.

---

## 4. Offline Behavior

| Capability | Offline behavior |
|---|---|
| Portfolio rollup / KPIs | **Read from cache**; stale badge; Yield-at-Risk re-derived client-side from cached `max_risk_score`. |
| Suppliers list + Supplier Detail | **Read from cache** (SQLite mirror of last fetch). |
| Disruptions / Alerts feed | **Read from cache**; new alerts arrive only via push (which needs connectivity) or on reconnect. |
| Monitored Farms grid + boundaries | **Read from cache**; boundaries/AOI stored for offline map preview. |
| Farm Detail (profile, parcels, zones, map) | **Read from cache**; strong offline-first field view. |
| Observations / Signal Timeline | **Read from cache** (usually empty pre-P2); no new data offline. |
| **Alert acknowledge** | **Queued** optimistic write; replays on reconnect; handles 409 on replay (server-authoritative). Pill shows "Pending sync". |
| **Field report generation** | **Disabled** offline (server-side generation); clear messaging, not queued. |
| **Onboard farm / farm/parcel/zone CRUD** | **Blocked** offline — requires connectivity + PostGIS `ST_IsValid` geometry validation that can't run client-side. |
| Auth (login/register/tenant switch) | **Requires connectivity**; existing JWT enables offline re-entry with cached data until ~8h expiry. |
| Theme toggle | **Fully offline** (AsyncStorage). |
| Nav visibility / role gating | **Offline** from cached roles; server remains the real gate on reconnect. |

Sync engine: a Drizzle/expo-sqlite outbox holds queued acks; NetInfo drives drain-on-reconnect; conflicts (409) resolve idempotently. Cache TTL mirrors web react-query `staleTime` (~30s) for "live vs stale" badging; SQLite persists across launches.

---

## 5. Coverage Map (inventory feature → screens/stories)

| # | Inventory feature | Priority | Screens | Stories |
|---|---|---|---|---|
| 1 | Portfolio Dashboard (Mission Control home) | P0 | S-3 (S-2 shell) | B1, B4 |
| 2 | Portfolio KPI rollup row | P0 | S-3 (KPI carousel) | B2 |
| 3 | Suppliers under active monitoring table | P0 | S-3 panel, S-4 | C1, C2 |
| 4 | Active disruptions feed | P1 | S-3 panel, S-7 | C3, H1 |
| 5 | Monitored farms grid | P0 | S-3 panel, S-5 | D1, D2 |
| 6 | Farm Detail drill-down (Screen B) | P0 | S-6 | E1, E2, E3 |
| 7 | Alert acknowledge | P1 | S-6 Alerts, S-7 | F1, F2 |
| 8 | Field report generation | P1 | S-6 Field Report | G1 |
| 9 | Cross-surface navigation (TopNav shell) | P0 | S-2, S-9 | I1, I2 |
| 10 | Buyers surface (sales re-skin) | P2 | S-9 (Buyers) | I2 |
| 11 | Suppliers surface (vendor re-skin, isolated) | P2 | S-9 (Suppliers) | I2, J-7 |
| 12 | Growers surface (customer, bare map) | P2 | S-9 (Growers) | D2, I2 |
| 13 | Analytics surface | P1 | S-8 | J1 |
| 14 | Programs / Staff / Tenants nav surfaces | P2 | S-9, S-10 (Tenants→switcher) | I2, I3 |
| 15 | Authentication & demo perspectives | P0 | S-1 | A1, A2, A3, A4 |
| 16 | Session, access-code gate & role routing | P0 | S-0, S-1, S-2 | A4, A5, A6, I1, J-7 |
| 17 | Tenant switcher & district switcher | P1 | S-2 drawer, S-10 | I3, J-6 |
| 18 | Surface mode (light/dark) toggle | P2 | S-1, S-2, S-10 | I4 |
| 19 | Risk semantics & honest-state (RiskPill/Legend) | P0 | **all** (§0.1) | cross-cutting AC on B1/B2/C1/C3/D1/E1 |

All 19 inventory features covered. The relabeled CRM surfaces (Buyers/Suppliers/Growers/Programs/Staff/Tenants, features 10–14) are covered **as navigation destinations with isolation/role rules honored**; their internal CRM/PM/admin content belongs to separate domain inventories and is represented here by S-9 placeholders + web fallback, exactly as scoped.

---

## 6. Honesty-tier enforcement checklist (mobile)
- [ ] `RiskPill` RN component refuses color-only render; always icon + label; `band=null` → Unmonitored dashed chip.
- [ ] KPI em-dash + literal footnotes reproduced verbatim.
- [ ] Yield-at-Risk only when real `max_risk_score`; formula `round(max*0.18)`.
- [ ] Observation/alert honesty tier badge (T1/T2/T3) rendered as received, never upgraded.
- [ ] Every list/panel has an explicit honest-empty state; no fabricated rows, no forever-spinners.
- [ ] Offline stale badge distinguishes cached vs live; queued writes labelled "Pending sync".
