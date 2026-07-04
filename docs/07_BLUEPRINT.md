# 07 — Report.Farm Product Blueprint

> Site map · feature map · personas · user stories · journeys. Reflects the **actual build** as of this
> session (not aspirational). Interactive version: `docs/07_BLUEPRINT.html` (open in a browser) and the
> published artifact link at the bottom.
>
> **Status legend** — every surface carries one:
> - 🟢 **BUILT** — farm-native and working now
> - 🟡 **THEMED** — new Report.Farm look over a shell still inherited from the RWR clone base (domain rewrite queued)
> - 🟣 **PLANNED** — designed (see `docs/design/`), not yet implemented

## Architecture at a glance

Report.Farm is a **thin vertical** on the AlphaGeo geospatial engine — three tiers:

```
Report.Farm (app tier)   digital twin · reports · alerts · copilot · this UI
      ↕  /api/farm/* relay + change events
AlphaGeo Gateway         auth · scan/EO/indicator pipeline · evidence
      ↕
AlphaGeoCore (engine)    Sentinel/Landsat · indices · change detection · embeddings
```

The app owns the *domain* (twin, rollups, alerts, reports, UI); all Earth-observation/ML is delegated to the engine. See `docs/02_ALPHAGEO_INTEGRATION.md` and `docs/06_DECISIONS.md`.

## 1. Site map — every route by zone

| Zone | Surface | Route | Status |
|---|---|---|---|
| **Marketing** | Home | `/index.html` | 🟡 |
| | Solutions · Industries · Platform · Company · Contact | `/*.html` | 🟣 (deferred) |
| **Auth** | Access gate (passcode) | `/access.html` | 🟢 (dev-bypassed) |
| | Sign in | `/login.html` | 🟢 |
| | Request access | `/register.html` | 🟡 |
| **Console** | **Portfolio Dashboard** | `/operations.html` | 🟢 |
| | **Onboarding Copilot** | `/operations.html?view=onboard` | 🟢 |
| | **Farm Detail** | `/operations.html?farm=<id>` | 🟢 |
| | Buyer Success (CRM) | `/sales.html` | 🟡 |
| | Programs | `/pm.html` | 🟡 |
| | Analytics | `/analytics.html` | 🟡 |
| | Grower Portal | `/customer.html` | 🟡 |
| | Supplier Portal | `/vendor.html` | 🟡 |
| | Tenant Admin · Staff & Teams | `/tenants.html` · `/staff.html` | 🟡 |
| **Field & Map** | Field Agronomist app | `/field.html` | 🟡 |
| | Operational / legacy map | `/dashboard-react.html` · `/dashboard.html` | 🟡 |
| **API** | Farm domain API | `/api/v1/farm/*` | 🟢 |
| **Planned screens** | Report Viewer · Alert Inbox | — | 🟣 |

Console surfaces share one React shell (top-nav tabs + status bar) and swap the active surface by role.

## 2. Feature map — sections & elements per surface

### 🟢 Portfolio Dashboard — `/operations.html` (roles: `ops:manage` · `farm:view` · `farm.portfolio.view`)
The buyer's supply-chain command surface; first fully farm-native screen. Summary-before-detail, live from `/api/farm/*`, honest empty-states until observations land.
- **Header + risk legend** — "[Buyer] — Global Portfolio" + ordered Healthy→Critical vegetation ramp
- **KPI row** — Suppliers Monitored · Portfolio Risk /100 · Yield at Risk % · Revenue at Risk $
- **Suppliers under monitoring** — table: supplier, region, farms, RiskPill severity, revenue-at-risk
- **Active disruptions feed** — alert cards (severity + confidence); empty until first pass
- **Monitored farms grid** — farm cards: crops, hectares, latest risk band, hover-to-open
- **Data-honesty footnote** — "Structure is live; signals begin with the first satellite pass"
- *APIs:* `GET /farm/portfolio/rollup`, `/portfolio/suppliers`, `/farms`, `/alerts`

### 🟡 Marketing Home — `/index.html`
Farm-native: nav/brand, hero ("See the disruption before it reaches your supply"), problem stats (FAO/Sentinel figures), audience router (Growers · Buyers · Landowners), outcome lines, footer, SEO/OG. Rewrite queued: modules grid, pilots, FAQ, JSON-LD.

### 🟢 Access Gate — `/access.html`
Passcode wall; sets signed `access_pass` cookie site-wide; auto-bypassed in local dev. Elements: brand spark + heading, passcode field, trust strip.

### 🟢 Sign In — `/login.html`
Mints tenant-scoped session. Elements: Report.Farm / Mission Control header, demo-perspective picker (admin/buyer/ops/grower), credential sign-in → JWT + role-route, create-account hand-off.

### 🟡 Buyer Success (CRM) — `/sales.html` (`sales:manage`)
Pipeline board (stages, deal cards), account panel (contacts/notes/meetings/files/activity), insights hero + charts. Inherited CRM; reshape to supplier/grower relationships queued.

### 🟡 Grower Portal — `/customer.html` (`customer:view`)
Full-bleed map console scoped to the grower's identity: farm switcher, saved scene strip, map + findings.

### 🟡 Analytics — `/analytics.html` (`analytics:view`)
Dashboard KPIs, rollup/drilldown (region → supplier → farm), trends. Farm KPIs to be wired to rollup views.

### 🟡 Field Agronomist App — `/field.html` (`field.technician`)
Assigned work list, geofenced check-in (GPS vs boundary), evidence upload, ops chat (websocket).

### 🟡 Tenant & Staff Admin — `/tenants.html` · `/staff.html` (`platform:admin`)
Tenant lifecycle/flags, users & roles, teams & invites, token revocation. Domain-neutral, reused as-is.

### 🟢 Farm Detail (screen B) — `/operations.html?farm=<id>`
Breadcrumb, farm header (crops/area/supplier + RiskPill + Farm Health/Active Signals KPIs), satellite field map (boundary + parcels + intent-styled zones), zone list (intent chips, icon+label paired), honest signal timeline (empty-state + ghost 90-day axis until P2), alerts panel (acknowledge → `POST /alerts/:id/ack`), field-report action (`POST /reports/generate`). Browser-verified, 0 console errors.

### 🟢 Onboarding Copilot (screen C) — `/operations.html?view=onboard`
Stepper: farm basics → import/paste boundary (GeoJSON/KML/Shapefile) with satellite preview → parcels → zone-intent editor → review & create. Server-side geometry validation surfaces `422 invalid_geometry` inline. Verified: valid polygon → 201, self-intersecting → 422.

### 🟣 Report Viewer (screen D, planned)
Print-grade sections: executive summary, changes-since-previous, evidence panels (P2), confidence + ranked recommendations, JSON companion. *API:* `GET /farm/reports/:id`.

## 3. API & data model

**Live endpoints** (`/api/v1/farm/*`, tenant-scoped, RLS-enforced):

| Method & path | Does |
|---|---|
| `GET/POST /farm/farms` · `GET/PUT/DELETE /:id` | Farm profile CRUD |
| `GET/POST /:id/parcels` | Parcels — polygon, area auto-computed via PostGIS |
| `GET/POST /:id/zones` | Zones with intent JSON |
| `GET /farm/portfolio/rollup` · `/suppliers` · `/regions` | Buyer / supplier / region rollups |
| `GET /farm/alerts` · `POST /:id/ack` | Alerts + acknowledge |
| `POST /farm/reports/generate` · `GET /farm/reports` · `/:id` | Report generation & read (from live twin data) |
| `GET /farm/observations` | Signals — empty until P2 ingest (honest) |

Geometry validated on write (`ST_IsValid`); self-intersections → `422 invalid_geometry`. Every query inside `withTenantConn`.

**Digital-twin entities** (18 tables) — core spec entities: FarmProfile, Parcel, Zone, Asset, Observation, DerivedSignal, Alert, Recommendation, Report, SensorConnector, ImageryScene, ActionFeedback, Scan. Supply-chain overlay: Supplier, SourcingRegion, RiskScore, YieldAtRisk, DisruptionAlert.

**Rollup views:** `v_farm_latest_risk → v_supplier_rollup → v_region_rollup → v_buyer_rollup` (dashboard reads the top).

## 4. Personas

| Persona | Demo login | Key permissions | Primary need |
|---|---|---|---|
| **Buyer Admin** | `admin@demo-buyer.demo` | `platform:admin`, `farm:onboard`, `alert:manage` | Run the account, see everything |
| **Buyer / Portfolio Lead** | `buyer@demo-buyer.demo` | `farm:view`, `farm.portfolio.view`, `report:generate` | Watch supplier portfolio for sourcing risk |
| **Farm Operations** | `ops@demo-buyer.demo` | `ops:manage`, `farm:onboard`, `alert:manage` | Onboard farms, set zone intent, triage alerts |
| **Grower** | `grower@demo-buyer.demo` | `customer:view`, `farm:view` | See only their own farms & findings |
| **Field Agronomist** | `field.technician` role | `field.job.read`, `field.upload` | Verify findings on the ground |

## 5. User stories (by persona)

**Buyer / Portfolio Lead**
- As a buyer, I want one portfolio view of every supplier's risk, so I see sourcing exposure without chasing individual farms. *(✓ dashboard rollup)*
- As a buyer, I want suppliers ranked by risk, so I act on the worst exposure first. *(✓ sortable table + severity pills)*
- As a buyer, I want urgent disruption alerts, so I re-source before a bad season breaks a contract. *(✓ disruptions feed; honest empty-state)*
- As a buyer, I want to generate a period report, so I can brief my team with evidence. *(✓ generated from live twin, no fabrication)*

**Farm Operations**
- As ops, I want to onboard a farm by drawing/importing its boundary, so monitoring starts in minutes. *(✓ area auto-computed; bad geometry rejected inline)*
- As ops, I want to bulk-import many supplier farms, so a large portfolio onboards without manual drawing. *(✓ Shapefile/KML/CSV)*
- As ops, I want to tag zones with intent, so alerts respect what each zone is for. *(✓ intent JSON; standing-water-in-barn → critical)*
- As ops, I want to acknowledge/triage alerts, so the team isn't re-alerted on known issues. *(✓ open→ack + dedup)*

**Buyer Admin**
- As an admin, I want tenant-isolated data, so no buyer sees another's suppliers. *(✓ RLS, verified zero leak)*
- As an admin, I want to manage users, roles and invites, so each teammate gets the right surfaces. *(✓ role→permission bundles)*

**Grower & Field**
- As a grower, I want to see only my own farms and findings, so my data stays private in the network. *(✓ identity-scoped portal)*
- As a field agronomist, I want to check in at a farm and log what I find, so ground truth sharpens the signal. *(✓ geofenced check-in + evidence)*

## 6. End-to-end journeys

**A. Onboard a supplier's farm** — *Farm Operations*
Sign in → create farm (`POST /farm/farms`) → draw/import boundary (validated, 422 on bad shape) → add zones + intent (`POST /zones`) → farm goes live on the portfolio.

**B. The autonomous monitoring loop** — *System → Buyer*
Satellite revisit `[ENGINE]` → analyze indices/change `[ENGINE]` → change event pushed (Redis Streams) → normalize to Observation → DerivedSignal → alert fires (zone-intent + threshold, dedup + confidence) → buyer notified (dashboard + email/webhook).

**C. Review portfolio risk & act** — *Buyer / Portfolio Lead*
Open dashboard (rollup) → scan ranked risk table → drill into flagged supplier → confirm with evidence (signal timeline) → generate report (`POST /reports/generate`) → re-source decision.

**D. Ground-truth a finding** — *Field Agronomist*
Get assigned (field/jobs) → check in on site (geofence vs boundary) → capture evidence (photos + notes) → feed back (ActionFeedback sharpens the model).

**E. Grower self-service** — *Grower*
Sign in (identity-scoped) → open their farms → see findings (crop health/water/alerts) → prioritize the acre that needs attention.

---

*Interactive version:* `docs/07_BLUEPRINT.html` · published artifact:
**https://claude.ai/code/artifact/84b929f1-275b-46b3-be8c-22ceb8adf590**
