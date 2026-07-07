# Report.Farm Mobile — Domain Design: Programs, Staff, Tenants Admin & Settings

**Platform:** Expo + React Native + TypeScript · expo-router · offline-first (expo-sqlite + Drizzle) · expo-notifications · expo-secure-store (JWT) · react-native-maps (tenant pivot only)
**Design language:** Report.Farm cobalt-accent, dark-mode-first, sleek native (bottom-sheet modals, segmented pills, swipe rows, haptics).
**Scope derived from repo** (not the stub inventory): `Login.tsx`, `App.tsx` role routing, `TopNav`, `StaffAdmin.tsx`, `TenantAdmin.tsx`/`TenantsConsole.tsx`, `BillingPanel.tsx`, `ProjectManager.tsx` (the **Programs** surface = `pm.html`), `RegistrationPanel.tsx`, `OperationsDashboard.tsx` (team workload), `TenantSwitcher`, `DistrictSwitcher`, `auth-store.ts`, `tenant-store.ts`, `orgs.ts`, `api.ts`.

---

## 0. Re-derived Feature Inventory (authoritative)

The stub inventory was empty; this is derived from the code. Every item below is proven in the Coverage Map (§5).

**A. Auth & Access**
- A1 Access-code gate (`/access.html`, `rwr.access_pass` cookie/token, 1h; API 401 `access_gate_required` re-bounce)
- A2 Login — demo perspectives: Buyer Admin (`admin`), Portfolio Lead (`buyer`), Farm Operations (`ops`), Grower (`grower`) → `{role}@{tenant}.demo`
- A3 Login — manual sign-in (tenant slug + email → `/auth/dev-login`)
- A4 Register — Create account (invite type: Employee / Customer / Vendor → `/auth/register`)
- A5 Self-service registration link (server flag `ALLOW_SELF_REGISTRATION`, `/auth/registration-config`) → access-code request
- A6 JWT session (8h), persisted; bearer + `X-Tenant-Id` on every call
- A7 Role-based routing: `primarySurfaceForRoles`, `allowedSurfacesForRoles`, `sanitizeNextUrl`, vendor isolation
- A8 Sign out (socket teardown + store clear + purge)

**B. Settings & Shell**
- B1 Surface-mode toggle (light/dark, preserved across logout — `rwr.surface-mode`)
- B2 Tenant switcher (platform:admin; `/tenants` → dev-login re-mint)
- B3 District switcher (org claim; `/iam/my-orgs` + `/auth/switch-tenant`)
- B4 User chip (name, roles, avatar initial)
- B5 Cross-surface navigation (Portfolio, Buyers, Programs, Analytics, Staff, Tenants, Growers, Suppliers — gated by allow-list)

**C. Staff & Teams** (`staff.html`, platform:admin)
- C1 Users list (count, roles, status)
- C2 Invite user (email, display_name, roles multi-select from `ALL_ROLES`)
- C3 Edit user roles inline
- C4 Deactivate user
- C5 Teams list
- C6 New team (name, description)
- C7 Team members (name, email, role, joined_at)
- C8 Add member (from `/tenants/me/users`)
- C9 Remove member
- C10 Delete team
- C11 Coachmark tour (staff)

**D. Tenants Admin** (`tenants.html`, platform:admin)
- D1 Tenant directory grid (status + plan badges, created)
- D2 New tenant (slug, display_name, plan mvp/pro/enterprise)
- D3 Tenant detail (users, audit log, metadata, ID)
- D4 Suspend / Reactivate
- D5 Switch to this tenant (pivot → operations)
- D6 Platform-admin gate + honest denial state
- D7 Coachmark tour (tenants)

**E. Billing & Subscription** (`tenants.html?view=billing`)
- E1 Current plan / subscription status (renews/cancels)
- E2 Plan catalog → Stripe Checkout
- E3 Manage billing → Stripe Customer Portal
- E4 Invoice history (view hosted invoice / PDF)
- E5 Not-configured honest empty state
- E6 Contact sales plan
- E7 Billing-admin gate (`canManage`)

**F. Programs** (`pm.html` = ProjectManager)
- F1 Case board (open/assigned/in_progress/blocked/closed) + KPI strip
- F2 New case (title, description, detection_id, priority)
- F3 Case detail — status transition
- F4 Case detail — assignee picker (`/tenants/me/users`)
- F5 Case detail — activity log + add activity
- F6 Stale strip (blocked >7d, assigned >14d)
- F7 Status filter pills
- F8 Projects & Scans panel
- F9 Portal registrations — approve/reject requests (email_verified gate, temp-password relay)
- F10 Access codes — create / deactivate
- F11 Coachmark tour (pm)

**G. Team Workload** (OperationsDashboard) — active assignments by team member; escalations.

**Honesty tiers** carried throughout: T1 regulatory / T2 evidence / T3 screening; approvals gated on real email verification; billing/audit degrade to honest-empty; never fabricate counts, roles, or statuses.

---

## 1. Epics & User Stories

Roles map to seeded personas: **Buyer Admin** = `platform:admin`/`admin`; **Portfolio Lead** = `buyer`/`analytics:view`; **Farm Operations** = `ops`/`ops:manage`; **Grower** = `grower`/`customer:view`.

### EPIC 1 — Access & Session (A1–A8, A6)

**US-1.1** — *As a Buyer Admin, I want to clear the access-code gate once on my device so that I reach the sign-in screen.*
- AC: Passcode entry screen precedes login; a valid pass is stored in secure-store with its 1h TTL; an API `401 access_gate_required` mid-session routes me back to the gate **without** dropping my JWT; on dev builds the gate is bypassed.

**US-1.2** — *As any role, I want one-tap demo perspectives so that I can enter as Buyer Admin, Portfolio Lead, Farm Operations, or Grower.*
- AC: Four persona cards (icon + label + description + `{role}@{tenant}.demo`); tapping signs in via `/auth/dev-login` and lands me on my role's primary surface; a busy state disables all four during the call; failure shows the raw error code and re-enables.

**US-1.3** — *As a returning user, I want to sign in manually with tenant + email so that I use my real credentials.*
- AC: Tenant field defaults to `demo-buyer`; Sign-in disabled until email non-empty; success persists JWT (8h) + tenant and routes via `primarySurfaceForRoles`; a `?next=` deep link is honored only if `sanitizeNextUrl` passes AND the surface is in my allow-list, else I fall back to my primary surface.

**US-1.4** — *As a new invitee, I want to create an account by invite type so that my access scope is set correctly.*
- AC: Segmented Employee / Customer / Vendor; Create requires tenant + email; a Vendor account is isolated to the Suppliers surface after landing; display name defaults to the email local-part when blank.

**US-1.5** — *As a prospect with an access code, I want a "Request access" path so that I can self-register when the org allows it.*
- AC: The link renders **only** when `/auth/registration-config` reports enabled; otherwise it is absent (no dead link).

**US-1.6** — *As any signed-in user, I want a reliable sign-out so that my session cannot be resumed.*
- AC: Sign-out tears down live sockets, clears auth + tenant stores, purges persisted keys, preserves my light/dark preference, and hard-replaces to Login so back-nav cannot return.

**US-1.7** — *As a Grower/Portfolio Lead, I want to be blocked from admin surfaces so that I only see what my role permits.*
- AC: Staff, Tenants, and Billing tabs are hidden when my roles don't include them; deep-linking to a forbidden surface redirects to my primary surface; server 403 is the true boundary (client gate is UX only).

### EPIC 2 — Settings & Context Switching (B1–B5)

**US-2.1** — *As any user, I want a light/dark toggle so that the app matches my environment and survives logout.*
- AC: Toggle in Settings and on the Login header; choice persisted to `rwr.surface-mode`; survives sign-out; respects system default on first run.

**US-2.2** — *As a Buyer Admin, I want to switch the active tenant so that I can administer another buyer org.*
- AC: Tenant switcher lists `/tenants` (fallback seed list before auth); selecting re-mints the session for that tenant and invalidates all cached queries; the current tenant shows a check; only visible to `platform:admin`.

**US-2.3** — *As an org-tier user, I want a district switcher so that I can act inside another district under my org.*
- AC: Renders only when my user carries an `org` claim with ≥1 district; lists districts from `/iam/my-orgs`; switching calls `/auth/switch-tenant` (re-mints JWT with new tenant_id) then refreshes; a 403 (not a member) surfaces an error and closes; standalone tenants never see it.

**US-2.4** — *As any user, I want a persistent identity chip so that I always know who and what role I am.*
- AC: Shows display name (or email), first two roles, avatar initial; tapping opens Settings/Account.

### EPIC 3 — Staff & Teams (C1–C11, G)

**US-3.1** — *As a Buyer Admin, I want to see all users with roles and status so that I can audit access.*
- AC: List shows user, role chips, active/inactive badge, and a live count; empty state "No users yet"; loading skeleton.

**US-3.2** — *As a Buyer Admin, I want to invite a user with a role set so that they get scoped access.*
- AC: Bottom-sheet form (email, display name, multi-select role chips defaulting to `dashboard:view`); Invite disabled until email + name present; on success the list refreshes and the sheet closes.

**US-3.3** — *As a Buyer Admin, I want to edit a user's roles inline so that I can adjust permissions quickly.*
- AC: Roles enter an editable chip toggle; Save persists via `PUT /iam/users/:id`; Cancel restores original roles; optimistic pending indicator.

**US-3.4** — *As a Buyer Admin, I want to deactivate a user so that they lose access without deletion.*
- AC: Deactivate available only on active users; confirm; row flips to inactive; reversible server-side.

**US-3.5** — *As a Buyer Admin, I want to create teams and manage membership so that workload can be grouped.*
- AC: New team (name required, optional description); team card lists members with role + joined-relative; Add member picks from tenant users not already in the team; Remove member and Delete team both confirm; empty states for zero teams / zero members.

**US-3.6** — *As a Farm Operations lead, I want to see team workload so that I can balance active assignments.*
- AC: Per-team member rows show active (non-released, non-closed) assignment counts; >3 tints as overloaded; zero shows muted.

### EPIC 4 — Tenants Admin (D1–D7)

**US-4.1** — *As a Buyer Admin (platform), I want a tenant directory so that I can see every buyer org's status and plan.*
- AC: Cards show display name, slug, status badge (`statusVariant`), plan badge, created-relative; grid virtualizes on long lists; non-admins get an honest "Platform admin only" panel, never a blank or fabricated list.

**US-4.2** — *As a platform admin, I want to create a tenant so that I can onboard a new buyer.*
- AC: Form (slug pattern-hinted, display name, plan mvp/pro/enterprise); server validation errors render inline; success refreshes the grid.

**US-4.3** — *As a platform admin, I want a tenant detail view so that I can inspect its users, activity, and metadata.*
- AC: Detail shows users (role, email), recent audit events (action, resource, actor, relative time — honest-empty when none), and metadata (created, ID); audit capped at 30.

**US-4.4** — *As a platform admin, I want to suspend or reactivate a tenant so that I can control access.*
- AC: Suspend on active, Reactivate on suspended; state updates in place via `PUT /tenants/:id`.

**US-4.5** — *As a platform admin, I want to pivot into a tenant so that I can administer it in context.*
- AC: "Switch to this tenant" sets the active tenant and routes to the Portfolio/Operations home for that tenant.

### EPIC 5 — Billing & Subscription (E1–E7)

**US-5.1** — *As a Buyer Admin, I want to see the current plan and status so that I know our subscription state.*
- AC: Shows plan key, renews/cancels date, status pill tinted by state; honest "No active subscription" when none.

**US-5.2** — *As a billing admin, I want to subscribe or change plan so that I can start/adjust service.*
- AC: Plan cards (features, Popular flag); Subscribe launches Stripe Checkout in an in-app browser; disabled with reason when not purchasable or I lack `canManage`; Contact-sales plans deep-link instead.

**US-5.3** — *As a billing admin, I want to manage billing so that I can update payment or cancel.*
- AC: "Manage billing" opens the Stripe Customer Portal (only when configured + has customer + canManage).

**US-5.4** — *As a Buyer Admin, I want invoice history so that I can retrieve receipts.*
- AC: Table of invoices (number, date, status tint, amount, View link to hosted invoice); honest-empty before first cycle.

**US-5.5** — *As any admin in an unconfigured environment, I want an honest billing state so that I'm not misled.*
- AC: When Stripe unconfigured, a dashed banner explains setup and plans render read-only for reference; no fake subscription is shown.

### EPIC 6 — Programs (Case & Access management) (F1–F11)

**US-6.1** — *As Farm Operations, I want a case board with per-status counts so that I can triage work.*
- AC: KPI tiles per status (blocked tinted red, closed green); tapping a KPI filters the board; board columns collapse to a single column when filtered; stale strip surfaces blocked >7d / assigned >14d.

**US-6.2** — *As Farm Operations, I want to create a case so that detected issues become trackable.*
- AC: Form (title required, description, detection_id e.g. DET-1234, priority low/med/high/critical); on create the board refreshes.

**US-6.3** — *As Farm Operations, I want a case detail so that I can transition status, assign, and log activity.*
- AC: Detail shows status + priority badges, description, detection link, assignee picker (tenant users), activity log, and an add-activity composer; status change persists via `PUT /ops/cases/:id`; assignment via `/ops/cases/:id/assign`.

**US-6.4** — *As a Buyer Admin, I want to review portal registration requests so that I can provision or reject access.*
- AC: Pending requests show verified/unverified badge; Approve is **disabled until email_verified** (honesty — no provisioning of unverified emails); Approve returns a login URL and, when email delivery is off, a temp password to relay manually; Reject captures an optional reason; the panel self-hides when I lack `crm.registration.read`.

**US-6.5** — *As a Buyer Admin, I want to manage access codes so that prospects can self-register.*
- AC: List shows code, active/inactive, role, label, used/max; Create (optional custom code, label, max uses; defaults to customer role + this tenant) returns the new code to share; Deactivate flips it inactive.

**US-6.6** — *As Farm Operations, I want the Projects & Scans panel so that I can manage client/project/scan records alongside cases.*
- AC: Panel lists projects and their scans; create/select flows mirror the web ProjectsPanel; honest-empty when none.

---

## 2. User Journeys

### J1 — First launch → demo perspective (happy path)
1. App opens → **Access Gate** (if no valid pass on device).
2. Enter passcode → pass stored (1h) → **Login**.
3. Tap **Buyer Admin** card → `/auth/dev-login` → JWT + tenant persisted → land on **Portfolio** (role primary surface).
4. Bottom tab bar appears; admin tabs (Staff, Tenants, Programs, Settings) visible.

### J2 — Invite a user (Buyer Admin)
1. Tabs → **Staff** → Users segment.
2. Tap **Invite** (FAB) → bottom sheet.
3. Type email + name, toggle role chips → **Invite**.
4. Sheet closes, list refreshes, new user shows `active`. Offline → see J-offline.

### J3 — Edit roles + deactivate
1. Staff → Users → tap a row → row expands with **Roles** editor.
2. Toggle chips → **Save** (pending → done) or **Cancel**.
3. Swipe row left → **Deactivate** → confirm → badge flips `inactive`.

### J4 — Create + manage a team
1. Staff → Teams segment → **New team** → name/description → Create.
2. Open team card → **Add member** picker (tenant users) → Add.
3. Swipe a member → **Remove**; card overflow → **Delete team** (confirm).

### J5 — Tenant admin pivot (platform admin)
1. Tabs → **Tenants** → grid of tenant cards.
2. Tap a card → **Tenant Detail** sheet (users / audit / metadata).
3. **Suspend** or **Switch to this tenant** → on switch, all queries invalidate and I land on that tenant's Portfolio.

### J6 — Switch district (org-tier user)
1. Settings → **Active district** row (only if org claim) → district list.
2. Tap another district → `/auth/switch-tenant` re-mints JWT → app reloads context. 403 → inline "Not a member of this district".

### J7 — Subscribe (billing admin)
1. Settings → **Billing** → Current plan shows "No active subscription".
2. Tap a plan → **Subscribe** → in-app browser opens Stripe Checkout.
3. On return (`?billing=success`), Billing re-fetches and shows the active plan + first invoice pending.
4. Unconfigured env → honest banner, plans read-only.

### J8 — Triage a case (Farm Operations)
1. Tabs → **Programs** → KPI strip; tap **Blocked** KPI → board filters to blocked.
2. Tap stale chip → **Case Detail** sheet.
3. Change status via segmented control; pick assignee; type an activity note → **Add**.

### J9 — Approve a registration request
1. Programs → **Registrations** section → pending request.
2. If **unverified**, Approve is disabled (tooltip "Waiting on email confirmation").
3. Verified → **Approve** → success card shows login URL + (if email off) temp password → copy + relay. Or **Reject** with reason.

### J-offline — queued mutation
1. Offline (no network). Staff/Programs lists render from SQLite cache (read-only banner).
2. Attempt Invite/Add-member/Status-change → action is **queued** with a "Will sync" chip.
3. On reconnect, the outbox flushes in order; conflicts (e.g., user already deactivated) surface a per-item toast and open the item for manual reconcile.

### J-edge — access pass lapses mid-session
1. Any API call returns `401 access_gate_required`.
2. App routes to **Access Gate** keeping JWT; re-enter passcode → return to the exact screen (`?next`). Session is never dropped for a pass lapse.

### J-edge — non-admin opens an admin deep link
1. Grower taps a shared Tenants link → role gate resolves → redirected to Growers/Portfolio primary surface (no 403 flash).

---

## 3. Screens

Global chrome: **bottom tab bar** (role-filtered: Portfolio · Programs · Staff · Tenants · Settings; Growers/Suppliers/Buyers as role dictates). Modals are **bottom sheets** (snap points), destructive actions use native confirm + haptic. All lists: pull-to-refresh, skeleton loaders, honest empty states, offline banner.

### S1 — Access Gate
- **Purpose:** Passcode wall before auth (A1).
- **Layout:** Centered BrandMark, single OTP-style code field, Continue button, subtle "pilot access" caption.
- **Elements:** Code input (numeric/secure), Continue, error line, light/dark toggle (top-right).
- **States:** idle · verifying · invalid-code (shake + message) · dev-bypass (auto-skip). Offline: cannot verify → "Connect to continue".
- **Nav:** in = cold start / `401 access_gate_required`; out = Login (or original `?next`).
- **Gestures:** paste-fill code; submit on complete.

### S2 — Login
- **Purpose:** Sign in / register (A2–A5).
- **Layout:** BrandMark header + light/dark toggle; segmented **Sign in / Create account**; card body.
- **Sign in:** 2×2 **Demo perspective** cards (Buyer Admin, Portfolio Lead, Farm Operations, Grower) each showing icon/label/description/`role@tenant.demo`; divider; **manual** tenant + email + Sign in.
- **Register:** segmented Employee/Customer/Vendor; tenant + full name + email; Create.
- **Elements:** persona buttons (disabled while busy), inputs, submit, error mono line, "Request portal access" link (conditional), demo-tenant caption.
- **States:** idle · busy (all disabled) · error(code). Offline: submit disabled with "Offline — connect to sign in".
- **Nav:** out = role primary surface / sanitized `?next`.

### S3 — Home Shell / Tab Bar
- **Purpose:** Role-filtered navigation (B5).
- **Layout:** Bottom tabs; header shows tenant name + identity chip.
- **Elements:** Tabs computed from `allowedSurfacesForRoles`; header tenant switcher affordance (admin) / district switcher (org).
- **States:** verifying-session splash before ready; vendor-isolation redirect.

### S4 — Staff · Users
- **Purpose:** User directory + lifecycle (C1–C4).
- **Layout:** Header "Staff & Teams" + segmented **Users / Teams**; count line; user list; FAB **Invite**.
- **Elements per row:** name, mono email, role chips, status badge, swipe actions (Roles / Deactivate).
- **Inline editor:** role chip toggles + Save/Cancel.
- **States:** loading (skeleton rows) · empty ("No users yet") · error · offline (read-only, queued edits chip).
- **Nav:** in = Staff tab; out = Invite sheet / row editor.
- **Gestures:** pull-refresh; swipe-left row actions; tap to expand.

### S5 — Invite User (bottom sheet)
- **Purpose:** Create user (C2).
- **Elements:** email, display name, role chip multiselect (default `dashboard:view`), Cancel/Invite.
- **States:** invalid (Invite disabled) · submitting · error. Offline: **Queue invite** (chip "will sync").

### S6 — Staff · Teams
- **Purpose:** Teams + membership (C5–C10).
- **Layout:** count line; team cards (2-col on tablet); FAB **New team**.
- **Card:** name, description/slug, members list (name, email, role badge, joined-relative), Add-member select, Delete (confirm).
- **States:** loading · empty ("No teams yet") · member-empty ("No members") · offline.
- **Gestures:** swipe member → Remove; card menu → Delete team.

### S7 — New Team (sheet) — name (required) + description; Create/Cancel; submitting/error states.

### S8 — Team Workload (section within Programs/Ops or Staff detail)
- **Purpose:** Active assignments by member (G).
- **Elements:** per-team member rows with `N active`; overload tint >3; muted 0; empty "No teams configured".

### S9 — Tenants Directory
- **Purpose:** Platform tenant grid (D1, D6).
- **Layout:** Header "Tenants" + **New tenant** action; card grid.
- **Card:** display name, slug (mono), status badge, plan badge, created-relative, Suspend/Reactivate, "Manage ›".
- **States:** loading · **non-admin honest gate** (ShieldAlert "Platform admin only" + which demo emails) · 403 banner · empty · offline (read-only).
- **Nav:** tap card → Tenant Detail sheet.

### S10 — Tenant Detail (full-height sheet)
- **Purpose:** Inspect + act (D3–D5).
- **Layout:** header (name, slug, status, plan, close); two sections **Users** / **Recent activity**; metadata block; footer **Switch to this tenant** + Close.
- **Elements:** user rows (name, first role, email); audit rows (action badge, resource, actor, relative) capped 30; metadata (created, ID mono).
- **States:** users loading/empty ("No users in this tenant") · audit empty ("No audit events yet") · offline (read-only, switch disabled).

### S11 — New Tenant (sheet) — slug (pattern hint), display name, plan select (mvp/pro/enterprise); inline server error; Create.

### S12 — Billing & Subscription
- **Purpose:** Plan + invoices (E1–E7).
- **Layout:** header (CreditCard "Billing & Subscription") + **Manage billing** (conditional); Current-plan card; plan catalog (3-up → stacked); Invoices card.
- **Elements:** status pill (tinted), plan cards (features, Popular, Subscribe/Contact-sales/Current), invoice table (number, date, status, amount, View→in-app browser).
- **States:** **not-configured** dashed banner (read-only plans) · no-subscription honest line · checkout pending · checkout error · invoices empty · offline (read-only; Subscribe disabled).
- **Nav:** Subscribe/Manage → in-app browser (Stripe); return via `?billing=success|cancel` re-fetch.

### S13 — Programs · Case Board
- **Purpose:** Case triage (F1, F6, F7).
- **Layout:** header count + **New case**; **Projects & Scans** panel; **Registrations** panel; KPI strip (5); Stale strip; filter pills; board (5 columns → 1 when filtered).
- **Card:** title (2-line), priority badge, opened-relative, detection link, inline status select.
- **States:** loading · empty column ("Empty") · offline (queued transitions). 
- **Gestures:** tap KPI → filter; tap card → Case Detail; tap stale chip → detail.

### S14 — Case Detail (sheet)
- **Purpose:** Transition/assign/log (F3–F5).
- **Elements:** title, status+priority badges, description block, detection link, **Assignee** picker, **Add activity** composer, activity log (kind badge + body + relative).
- **States:** loading · activity-empty ("No activity yet") · saving · offline (queued).

### S15 — New Case (sheet) — title (required), description, detection_id, priority select; Create.

### S16 — Registrations (section + sheets)
- **Purpose:** Approve/reject + codes (F9, F10).
- **Elements:** pending request rows (name, verified/unverified badge, email/company, role, requested-relative, **Approve** [disabled unless verified], **Reject** [reason field]); approve-result card (login URL + temp password relay); Access-codes list (code mono, active badge, role, label, used/max, Deactivate) + **New code** form (code/label/max-uses).
- **States:** self-hidden when unauthorized (queries 403) · no-requests / no-pending / no-codes honest lines · created-code confirmation. Offline: read-only (approve/reject/create disabled with "Requires connection").

### S17 — Settings / Account
- **Purpose:** Preferences + context (B1–B4, A8).
- **Layout:** Account header (avatar, name, email, role chips); rows: **Appearance** (light/dark/system), **Active tenant** (admin → Tenant Switcher sheet), **Active district** (org → District Switcher sheet), **Billing** (→ S12), **About/version**, **Sign out**.
- **States:** switchers hidden when not applicable; sign-out confirm.
- **Gestures:** row tap; toggle.

### S18 — Tenant Switcher (sheet, admin) — listbox of `/tenants` (seed fallback), current check, tap → re-mint + invalidate.
### S19 — District Switcher (sheet, org) — "My districts under {org}", current check, tap → `/auth/switch-tenant` + reload; 403 inline; busy lock.

---

## 4. Offline Behavior

**Store:** expo-sqlite + Drizzle mirrors read models; a durable **outbox** table holds queued mutations with ordering + idempotency keys. JWT + tenant in expo-secure-store; surface-mode + last-tenant cached for cold offline boot.

| Capability | Offline behavior |
|---|---|
| View Staff users/teams, Tenants grid, Case board, Team workload | **Read-only** from SQLite cache; "Offline — showing last synced" banner + last-sync timestamp |
| Invite user, edit roles, deactivate, add/remove member, new/delete team | **Queued** in outbox → flush in order on reconnect; item shows "Will sync" chip |
| Case create / status transition / assign / add activity | **Queued**; board reflects optimistic state locally, reconciles on flush |
| New tenant, suspend/reactivate, switch tenant, switch district | **Blocked offline** (require fresh server auth/re-mint) — buttons disabled with "Requires connection" |
| Billing subscribe / manage / invoices | **Blocked offline** (Stripe hosted flows require network); last-known plan shown read-only |
| Approve/reject registration, create/deactivate code | **Blocked offline** (provisioning is server-authoritative + honesty-gated) |
| Login / dev-login / register / access gate | **Requires network**; cached session lets an already-authed user open cached read screens offline |
| Surface-mode toggle | **Fully offline** (local pref) |
| Push notifications (new pending registration, case escalation, invoice failed) | Delivered via expo-notifications; tapping deep-links to the item once online |

**Conflict rules:** outbox flush is per-item; a rejected mutation (409/403/stale) does not block the queue — it surfaces a toast + badges the item for manual reconcile. Honesty tiers are preserved offline: nothing is shown as "approved/subscribed/switched" until the server confirms.

---

## 5. Coverage Map (100%)

| # | Inventory feature | Screen(s) | Story |
|---|---|---|---|
| A1 | Access-code gate + `access_gate_required` re-bounce | S1 | US-1.1 / J-edge |
| A2 | Demo perspectives (4 personas) | S2 | US-1.2 / J1 |
| A3 | Manual sign-in (tenant+email) | S2 | US-1.3 |
| A4 | Register (Employee/Customer/Vendor) | S2 | US-1.4 |
| A5 | Self-service registration link (flag) | S2 | US-1.5 |
| A6 | JWT session persist (bearer + X-Tenant-Id) | S1–S3 | US-1.3 |
| A7 | Role routing / allow-list / next-sanitize / vendor isolation | S3 | US-1.7 / J-edge |
| A8 | Sign out (teardown) | S17 | US-1.6 |
| B1 | Light/dark toggle (persist across logout) | S2,S17 | US-2.1 |
| B2 | Tenant switcher (admin) | S18 | US-2.2 / J5 |
| B3 | District switcher (org) | S19 | US-2.3 / J6 |
| B4 | Identity chip | S3,S17 | US-2.4 |
| B5 | Cross-surface nav (gated) | S3 | US-1.7 |
| C1 | Users list | S4 | US-3.1 |
| C2 | Invite user (roles) | S5 | US-3.2 / J2 |
| C3 | Edit roles inline | S4 | US-3.3 / J3 |
| C4 | Deactivate user | S4 | US-3.4 / J3 |
| C5 | Teams list | S6 | US-3.5 |
| C6 | New team | S7 | US-3.5 / J4 |
| C7 | Team members view | S6 | US-3.5 |
| C8 | Add member | S6 | US-3.5 / J4 |
| C9 | Remove member | S6 | US-3.5 / J4 |
| C10 | Delete team | S6 | US-3.5 / J4 |
| C11 | Coachmark tour (staff) | S4 (onboarding overlay) | US-3.1 |
| D1 | Tenant directory grid | S9 | US-4.1 |
| D2 | New tenant | S11 | US-4.2 |
| D3 | Tenant detail (users/audit/meta) | S10 | US-4.3 |
| D4 | Suspend/Reactivate | S9,S10 | US-4.4 |
| D5 | Switch to this tenant | S10 | US-4.5 / J5 |
| D6 | Admin gate + honest denial | S9 | US-4.1 |
| D7 | Coachmark tour (tenants) | S9 overlay | US-4.1 |
| E1 | Current plan/status | S12 | US-5.1 |
| E2 | Plan catalog → Checkout | S12 | US-5.2 / J7 |
| E3 | Manage billing → Portal | S12 | US-5.3 |
| E4 | Invoice history | S12 | US-5.4 |
| E5 | Not-configured honest state | S12 | US-5.5 |
| E6 | Contact-sales plan | S12 | US-5.2 |
| E7 | Billing-admin gate (canManage) | S12 | US-5.2 |
| F1 | Case board + KPI strip | S13 | US-6.1 / J8 |
| F2 | New case | S15 | US-6.2 |
| F3 | Status transition | S14 | US-6.3 / J8 |
| F4 | Assignee picker | S14 | US-6.3 |
| F5 | Activity log + add | S14 | US-6.3 |
| F6 | Stale strip | S13 | US-6.1 |
| F7 | Status filter pills | S13 | US-6.1 |
| F8 | Projects & Scans panel | S13 | US-6.6 |
| F9 | Registration approve/reject (verified gate, temp pw) | S16 | US-6.4 / J9 |
| F10 | Access codes create/deactivate | S16 | US-6.5 |
| F11 | Coachmark tour (pm) | S13 overlay | US-6.1 |
| G | Team workload | S8 | US-3.6 |

**Honesty-tier coverage:** approvals blocked until real email verification (F9); billing/audit/registrations degrade to honest-empty, never fabricated (E5, D3, F9); offline never shows unconfirmed approved/subscribed/switched states (§4). All 60 inventory items map to a screen + story.

---

## 6. Native Interaction Notes
- Bottom sheets (`@gorhom/bottom-sheet`) for all create/detail/switcher flows; snap points + drag-to-dismiss.
- Swipe-to-action rows (react-native-gesture-handler) for Deactivate / Remove.
- Haptics on destructive confirm and successful mutation.
- In-app browser (`expo-web-browser`) for Stripe Checkout/Portal + hosted invoices; deep-link return handling on `?billing=*`.
- Coachmark tours ported as a spotlight overlay (first-run per surface, dismissible).
- Cobalt accent, tabular-nums for counts/amounts, mono for slugs/IDs/codes, status pills reuse the web `statusVariant` palette.
