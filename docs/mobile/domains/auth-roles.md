# Report.Farm Mobile — Domain Design: Auth, Roles & Multi-tenancy

> **Platform:** Expo + React Native + TypeScript · expo-router · expo-secure-store · expo-sqlite + Drizzle · expo-auth-session · expo-notifications · expo-local-authentication
> **Design language:** Cobalt-accent, dark-mode-first, native-feeling (iOS large titles + Android Material 3 back handling). Honesty tiers T1/T2/T3 carry through every surface that renders farm evidence.
> **Scope:** 100% coverage of the 14 features in the Auth/Roles/Multi-tenancy inventory. This domain owns the app's *entry, identity, session, authorization, tenant context, and admin* surfaces. Farm/ops feature screens are referenced only where their auth gates live.

---

## 0. Foundational Architecture (mobile translation of the web contract)

The web app relies on browser cookies + localStorage + a synchronous pre-paint `role-gate.js`. Mobile has **no cookies and no pre-paint DOM guard**, so the design re-implements each of these primitives natively. This section is the substrate every screen below builds on.

### 0.1 Two-token model (mirrors web exactly)

| Token | Purpose | Web transport | Mobile transport | TTL | Storage |
|---|---|---|---|---|---|
| **Access Pass** (`rwr.access_pass`) | Site-wide "human on the other side" pilot gate. **Conveys NO authz.** | `SameSite=Lax` cookie | `X-Access-Pass: <pass_token>` header (returned in verify body) | 1h | `expo-secure-store` key `rf.access_pass` |
| **Session JWT** | Real identity: `sub, email, tenant_id, roles[], org, jti, aud, exp, tenant_slug` | `Authorization: Bearer` | `Authorization: Bearer <jwt>` header | 8h (HS256 dev) / RS256 prod | `expo-secure-store` key `rf.auth` |

Every **business** API call carries **both** `Authorization: Bearer <jwt>` **and** `X-Tenant-Id: <uuid|slug>`. Every **gated surface fetch** additionally carries `X-Access-Pass`. A single `apiClient` interceptor stamps all three and is the only place they are read.

### 0.2 Native secure-storage map (replaces localStorage/sessionStorage)

| Web key | Mobile store | Contents | Cleared on |
|---|---|---|---|
| `rwr.access_pass` cookie / `rwr_gate_ok` | secure-store `rf.access_pass` | `{ pass_token, exp, code_id, tenant_id? }` | pass expiry / manual "leave preview" |
| `rwr.auth` | secure-store `rf.auth` | `{ token, user, exp }` | sign-out, 401 hard-fail, revoke |
| `rwr.tenant` | secure-store `rf.tenant` | `{ id, slug, name, myOrgs[] }` | sign-out, tenant switch |
| hydrated permission Set | secure-store `rf.perms` | `{ permissions[], roleKeys[], clearance }` | sign-out, re-hydrate on reconnect |
| `rwr.surface-mode` | `AsyncStorage` `rf.surface-mode` | `'light' \| 'dark' \| 'system'` | **never** (preserved across sign-out) |
| offline data | `expo-sqlite` DB **partitioned by `tenant_id`** | tenant-scoped cached rows | sign-out purge / tenant switch purge |

**Sensitive tokens live only in `expo-secure-store` (Keychain / Keystore), never in SQLite or AsyncStorage.**

### 0.3 The mobile "role-gate" (replaces synchronous `role-gate.js`)

A root `<AuthGate>` provider wrapping `expo-router` replicates the four web behaviors:
1. **No pass** → route to `/(gate)/access`.
2. **Pass but no session** → route to `/(auth)/login?next=<sanitized>`.
3. **Session but surface not in allow-list** → redirect to role **primary surface**.
4. **On login route while authed** → bounce to primary/`next`.

`primarySurfaceForRoles` and `allowedSurfacesForRoles` are ported verbatim from `auth-store.ts` / `role-gate.js`, **pack-driven** by the active SolutionPack (`__RWR_ROLE_PACK` fetched/cached as `rf.role_pack`). `sanitizeNextUrl`/`sanitizeNextPath` are ported for **deep links + push-notification navigation** (must end `.html`→mapped route, no traversal, no foreign host). Client gating is **UX-only**; the server `requirePermission` remains the boundary.

### 0.4 Role → primary surface map (mobile tab equivalents)

| Role (JWT `roles[]` / prefix) | Web primary | Mobile primary tab |
|---|---|---|
| `platform:admin` (Buyer Admin / demo `admin@`) | `tenants.html` | **Admin** (Tenants) |
| `buyer` / `farm.portfolio.view` (Portfolio Lead) | `dashboard.html` | **Portfolio** |
| `ops` / `ops:manage` (Farm Operations) | `operations.html` | **Mission Control** |
| `grower` / `customer:view` (Grower) | `customer.html` | **My Farm** |

### 0.5 Honesty tiers (global, non-negotiable)
Any auth surface that *displays* downstream farm evidence (e.g. a role's landing dashboard preview, a locked-tenant teaser) must carry tier chips: **T1 regulatory**, **T2 evidence**, **T3 screening**, plus detectability labels. Auth screens never fabricate identity/tenant/permission data — an unknown state renders **honest-empty**, not a guess.

---

## 1. Epics & User Stories

Roles referenced: **Buyer Admin** (`admin`/`platform:admin`), **Portfolio Lead** (`buyer`), **Farm Operations** (`ops`), **Grower** (`grower`). Acceptance criteria (AC) are testable.

### EPIC A — Private-Preview Access Gate
*Covers: Pilot Access-Code Gate.*

**A1 — As any invited pilot user, I want to enter my invite passcode once on first launch, so that I can reach the sign-in screen.**
- AC: First launch with no valid `rf.access_pass` opens the full-screen access card; all other routes are blocked.
- AC: Submitting a code calls `POST /api/v1/access/verify`; on 200 the `pass_token`+`exp` are stored in secure-store and I'm forwarded to sanitized `?next=` or `/(auth)/login`.
- AC: On 401 the field shakes, shows "Invalid access code", and clears the input; focus returns to the field.
- AC: Network failure shows a distinct retry state (not "invalid code").

**A2 — As a returning pilot user, I want the app to skip the gate while my pass is still valid, so that I'm not re-prompted every launch.**
- AC: If `rf.access_pass.exp > now`, the gate auto-forwards without a network call.
- AC: When the pass expires mid-session, the next gated fetch that 401s on missing pass silently re-routes to the gate with `next` = current route.

**A3 — As a developer/QA on a non-prod build, I want a dev escape hatch, so that I can bypass the gate during testing.**
- AC: When the build is `__DEV__` and `EXPO_PUBLIC_SKIP_ACCESS_GATE=1`, a synthetic pass is stamped and the gate is skipped. Never available in production/TestFlight release channels.

**A4 — As a pilot user, I want to leave the preview, so that my device stops holding a pass.**
- AC: A "Leave preview" affordance clears `rf.access_pass` and returns to the gate.

### EPIC B — Authentication (Sign-In, OIDC, Registration)
*Covers: Login — Demo Perspectives & Manual Sign-In; Keycloak OIDC Login; Invite-Based & Self-Service Registration.*

**B1 — As a pilot evaluator, I want to one-tap a demo perspective (Buyer Admin, Portfolio Lead, Farm Operations, Grower), so that I can explore the app as that role instantly.**
- AC: Four perspective cards show role, label, description, and the computed `${role}@${tenantSlug}.demo` email.
- AC: Tapping a card calls `POST /auth/dev-login`; on success the 8h JWT + user + tenant persist to secure-store and I land on the role's primary tab.
- AC: dev-login is only offered on builds where it's enabled; production hides demo cards.

**B2 — As Farm Operations, I want to sign in manually with a tenant slug + email, so that I reach my own tenant.**
- AC: Manual form defaults tenant slug to `demo-buyer`; submitting calls `dev-login`; role bundle is resolved by email prefix; I land on Mission Control.
- AC: Invalid tenant/email shows a mono-red error banner without clearing the tenant field.

**B3 — As any user, I want to keep my theme choice before signing in, so that the app respects light/dark from the first screen.**
- AC: A Surface-Mode toggle (light/dark/system) is available pre-auth and persists to `rf.surface-mode`, surviving sign-out.

**B4 — As an already-signed-in user, I want the app to skip login on relaunch, so that I go straight to my work.**
- AC: On mount with a valid unexpired JWT, login auto-redirects to sanitized `next` (if in allow-list) else role primary.

**B5 — As an enterprise user, I want to sign in with my company SSO (Keycloak OIDC), so that I use corporate credentials.**
- AC: When OIDC is configured (`registration-config`/build flag), a "Sign in with SSO" button launches `expo-auth-session` PKCE flow in the system browser.
- AC: On redirect back to the app-link, the app captures the handed-off app JWT + `tenant_id`/`tenant_slug` (equivalent to web `?oidc_token=`) and persists like dev-login.
- AC: State/PKCE mismatch or user cancel returns to login with a non-destructive message. When OIDC is unconfigured the button is hidden (server 404s).

**B6 — As an invited employee/customer/vendor, I want to redeem my invite to create an account, so that I can join the correct tenant with the right roles.**
- AC: "Create account" mode offers invite-type cards (Employee/Customer/Vendor) + display-name form.
- AC: Opening the app from an invite deep link pre-fills the token; `POST /auth/register-with-invite {token, display_name}` mints a JWT that persists like login. Tenant + roles come from the invite, not from my input.
- AC: A consumed/expired invite shows a clear terminal error with a "Request access" fallback (if enabled).

**B7 — As a prospective user, I want to request portal access when self-registration is enabled, so that staff can approve me.**
- AC: The "Request portal access" link is visible only when `GET /auth/registration-config` returns `{enabled:true}`.
- AC: Submitting `POST /auth/register-request` shows a "check your email" state; the email verify universal link (`/auth/register/verify?token`) deep-links back and shows ok/expired/invalid states.
- AC: Legacy self-register is not offered (server 410).

### EPIC C — Session, Token Lifecycle & Sign-Out
*Covers: JWT Session/Claims/Verification; Token Revocation (JTI Blocklist); Sign-Out/Session Teardown.*

**C1 — As any signed-in user, I want my session to attach automatically to every request, so that I never manually manage tokens.**
- AC: The `apiClient` stamps `Authorization: Bearer` + `X-Tenant-Id` (+ `X-Access-Pass` on gated surfaces) on every call.
- AC: `GET /auth/whoami` hydrates the current-user chip on cold start when a token exists.
- AC: JWT `exp` is decoded client-side; within a pre-expiry window the app prompts/forces re-auth rather than firing doomed calls.

**C2 — As any user, I want to be signed out cleanly the moment my token is revoked or invalid, so that a stale session can't linger.**
- AC: Any `401` (generic) clears `rf.auth` + `rf.tenant` and routes to login.
- AC: A `401 token_revoked` is treated as an **immediate hard sign-out** (also purges tenant SQLite scope) with a "Your session was ended by an administrator" message.
- AC: Because revocation can't be detected offline, the first reconnect that returns `token_revoked` triggers the hard sign-out.

**C3 — As Buyer Admin, I want to revoke another user's session, so that I can cut off a compromised or departed account.**
- AC: From the IAM/session view I can call `POST /iam/tokens/:jti/revoke`; the target's next call 401s within ≤30s.
- AC: After an RBAC migration I can call `POST /iam/admin/bust-policy-cache` to clear the policy cache. Both require `platform:admin`.

**C4 — As any user, I want a reliable sign-out, so that returning to the app requires fresh auth and the back gesture can't reveal my data.**
- AC: Sign-out (a) disconnects any live socket (field/chat/scan SSE), (b) clears `rf.auth` + `rf.tenant` + `rf.perms` from secure-store and purges tenant-scoped SQLite, (c) cancels push registrations, (d) navigates via `router.replace` to login so the Android back gesture / iOS swipe can't return to an authed screen.
- AC: `rf.surface-mode` (theme) is preserved.
- AC: If online, sign-out optionally calls token revoke for the current `jti`.

### EPIC D — Authorization, Roles & Surface Routing
*Covers: RBAC — Permission Hydration & Gates; Client-Side Surface Allow-List / Role Routing.*

**D1 — As any user, I want to only see actions I'm allowed to perform, so that the UI isn't cluttered with dead-ends.**
- AC: Effective permissions (from login `roles[]` + `whoami` + hydrated dot-perms) are cached in `rf.perms` and drive show/hide/disable of every gated control.
- AC: Gating honors **both** dot-perms (`farm.profile.read`) **and** legacy colon-roles (`farm:view`), plus the `platform.admin.all` super-bypass — exactly like `farmGate`.
- AC: A server `403 missing_permission` still surfaces a graceful "You don't have access to this" state (client gating is never trusted as the boundary).

**D2 — As any user, I want the app to open on the right home tab for my role, so that I start where my work is.**
- AC: Post-auth routing uses `primarySurfaceForRoles`: admin→Admin/Tenants, buyer→Portfolio, ops→Mission Control, grower→My Farm.
- AC: The tab bar shows only `allowedSurfacesForRoles`; admin sees all, others see first-match-wins per role.
- AC: Navigating (including via deep link / push) to a disallowed surface bounces to my primary tab.

**D3 — As Buyer Admin, I want the full surface set, so that I can administer the platform.**
- AC: `platform:admin` yields every tab plus Admin surfaces (Tenants, IAM); the super-bypass passes all `requireRole`/`requirePermission` client checks.

**D4 — As a user tapping a deep link or push notification, I want safe navigation, so that a malicious link can't redirect me off-app or to a forbidden surface.**
- AC: `sanitizeNextUrl` rejects foreign hosts, traversal, and non-mapped targets before navigation; unsafe links fall back to my primary tab.

**D5 — As Grower / Portfolio Lead / Farm Ops, I want my reduced permission set respected everywhere, so that I don't see admin/cross-tenant controls.**
- AC: Grower (`customer:view`,`farm:view`) sees no TenantSwitcher, no IAM admin, no tenant CRUD. Portfolio Lead (`farm.portfolio.view`,`report:generate`,`dashboard:view`) sees portfolio + reports but no ops/onboard/admin. Farm Ops (`ops:manage`,`farm:onboard`,`alert:manage`) sees onboarding + alerts but no tenant CRUD.

### EPIC E — Multi-Tenancy, Isolation & Context Switching
*Covers: Multi-Tenancy — Tenant Resolution & Isolation; Tenant Switching (Platform Admin); Org/District Switching.*

**E1 — As any user, I want all my data scoped to my active tenant, so that I never see another tenant's rows.**
- AC: `X-Tenant-Id` is sent on every business + replayed request.
- AC: Offline SQLite is partitioned by `tenant_id`; switching tenants never surfaces cached rows from another tenant.
- AC: A `403 tenant_suspended` renders a full-screen **locked** state; a `403 tenant_mismatch` forces re-resolution/sign-out.

**E2 — As Buyer Admin, I want to switch between tenants, so that I can support multiple customers.**
- AC: A TenantSwitcher (Building2 icon) appears **only** for `platform:admin`; it lists `GET /tenants` (falls back to seed `demo-buyer`/`acme-produce`) with a current-tenant check.
- AC: Selecting a tenant re-mints the token via `dev-login(slug, admin@<slug>.local)`, updates `rf.auth`+`rf.tenant`, emits an app-level `rf.tenant-changed` event that invalidates React Query + swaps the SQLite scope.
- AC: Tenant switch is **online-only**; when offline the control is disabled with an explanatory tooltip/sheet.

**E3 — As an org-tier user, I want to switch districts under my parent org, so that I can move between regions I administer.**
- AC: The DistrictSwitcher (Landmark icon) appears **only** when the JWT carries an `org` claim; standalone tenants (`org_id IS NULL`) never see it (byte-identical pre-org UX).
- AC: It loads `GET /iam/my-orgs` and lists "my districts under <org>"; selecting one calls `POST /auth/switch-tenant {tenant_slug}`, which validates membership and re-mints the JWT with the new `tenant_id` (+org claim).
- AC: On success the app emits `rf.tenant-changed` and hard-refreshes the data scope (equivalent to the web reload). `myOrgs` is cached for display; switching is online-only.

**E4 — As any member, I want to see which tenant I'm in, so that I always know my context.**
- AC: A tenant badge (name + slug) is visible in the app header / account sheet for every role.

### EPIC F — Administration (Tenant & IAM)
*Covers: Tenant Administration (Platform Admin); IAM Administration — Roles/Permissions/Users/Teams/Identities/Flags.*

**F1 — As Buyer Admin, I want to view, create, and update tenants on mobile, so that I can manage the platform on the go.**
- AC: `GET /tenants` lists tenants (cached read-only offline); `POST /tenants` creates (slug/display_name/plan); `PUT /tenants/:id` updates. All mutations require connectivity + `platform:admin`.
- AC: Suspending/resuming a tenant (with reason) opens/closes an `iam.tenant_suspension` row and is audited (`tenant.suspend`/`.resume`); a suspended tenant immediately locks affected users.

**F2 — As Farm Operations, I want a tenant user directory for assignment pickers, so that I can @-mention or assign teammates.**
- AC: `GET /tenants/me/users` is available to any authed member (no admin role) and powers assignment/mention pickers; works read-only from cache offline.

**F3 — As Buyer Admin, I want to manage roles, permissions, users, teams, identities, flags & aliases, so that I can run IAM.**
- AC: Read catalogs (`GET /iam/permissions`, `GET /iam/roles`) can be cached read-only to label client gating; mutations (create/edit roles, set permissions, grant/revoke user roles with expiry, user CRUD, team membership CRUD, cross-tenant identities + memberships, per-tenant flags/aliases/email-prefs, vendor apply-template) are **online-only** and gated by the appropriate perm (`platform:admin`, `ops:manage` for teams list, `platform.admin` OR `tenant.admin` for flags, dot-perms `iam.roles.manage` etc.).
- AC: Every mutation is optimistic-but-verified (rolls back on server error) and audited server-side.
- AC: On phones the IAM admin surface is presented as a focused, list-first console; complex bulk grids degrade gracefully (out-of-scope items are read-only, clearly labeled).

---

## 2. User Journeys

### J1 — First launch → access gate → demo perspective → land (happy path)
1. Cold start. `<AuthGate>` finds no `rf.access_pass` → routes to **Access Gate**.
2. User enters passcode → `POST /access/verify` → 200 → store `pass_token`+`exp` → forward to **Login**.
3. Login shows 4 demo cards. User taps **Farm Operations** → `POST /auth/dev-login` → JWT+user+tenant stored, `rf.perms` hydrated.
4. `primarySurfaceForRoles(['ops:manage',…])` → **Mission Control** tab. Tab bar renders ops-allowed tabs only.

### J2 — Returning user, valid session (fast path)
1. Cold start. Gate sees valid pass → skip. AuthGate sees valid JWT (`exp>now`) → skip login.
2. `whoami` hydrates the user chip in the background; `rf.perms` re-hydrated on first reconnect.
3. Lands directly on last route if allowed, else primary tab.

### J3 — Platform admin tenant switch
1. Buyer Admin taps tenant badge → **TenantSwitcher** sheet lists tenants.
2. Picks `acme-produce` → online re-mint via `dev-login` → stores swap → `rf.tenant-changed` emitted.
3. React Query cache invalidated; SQLite scope switches to `acme-produce`; header badge updates; surfaces re-render.
4. **Offline variant:** switcher control disabled; tapping shows "Reconnect to switch tenants."

### J4 — Org-tier district switch
1. Org user opens account sheet; **DistrictSwitcher** visible (org claim present).
2. `GET /iam/my-orgs` lists districts under org. Picks a district → `POST /auth/switch-tenant` → membership validated → JWT re-minted with new tenant.
3. `rf.tenant-changed` → hard data-scope refresh (spinner over shell), then lands on primary tab of new district.
4. **Edge:** membership missing → 403 → inline "You're not a member of that district."

### J5 — Token revoked while user is active
1. Admin revokes user's `jti`. Within ≤30s the user's next API call returns `401 token_revoked`.
2. `apiClient` detects the code → hard sign-out: sockets disconnected, secure-store cleared, tenant SQLite purged, push deregistered → route to login with "Your session was ended by an administrator."
3. **Offline variant:** revocation undetectable offline; app keeps working read-only; first reconnect surfaces the 401 and triggers the same hard sign-out.

### J6 — Invite redemption via deep link
1. User taps invite universal link → app opens **Create Account** with token pre-filled.
2. Enters display name → `register-with-invite` → JWT minted (tenant+roles from invite) → persisted → land on role primary.
3. **Edge:** consumed/expired invite → terminal error + "Request access" (if enabled) or "Contact your admin."

### J7 — SSO (Keycloak OIDC)
1. User taps **Sign in with SSO** → `expo-auth-session` opens system browser with PKCE + state.
2. Authenticates at Keycloak → redirects to app-link with the handoff → app captures app JWT + tenant → persists like dev-login → land on primary.
3. **Edge:** state/PKCE mismatch or cancel → return to login, non-destructive message. Unconfigured → button hidden.

### J8 — Suspended tenant lockout
1. User launches; a business call returns `403 tenant_suspended`.
2. App renders full-screen **Tenant Locked** state (icon, tenant name, "This workspace is suspended. Contact your administrator."), disables all nav except sign-out.
3. On resume (tenant reactivated) a retry succeeds and the app unlocks.

### J9 — Sign-out
1. User opens account sheet → **Sign out**.
2. Sockets disconnect → secure-store cleared → tenant SQLite purged → push deregistered → optional online revoke → `router.replace('/(auth)/login')`. Theme preserved.

### J10 — Offline mutation deferred then flushed
1. User (Farm Ops) offline edits a note; write is queued in the outbox with the current tenant + a marker to re-stamp the token at replay.
2. On reconnect the outbox flushes: if JWT expired, force re-auth first, then replay each queued mutation with a fresh `Authorization` + `X-Tenant-Id`. Any `401 token_revoked`/`403 tenant_suspended` during flush aborts to the corresponding locked/sign-out state.

---

## 3. Screens & Surfaces

Design notes apply globally: **cobalt (#2F6BFF-family) accent on near-black (dark) / off-white (light)**; SF Pro / Roboto system fonts; large-title headers on iOS; haptic feedback on primary actions; reduced-motion respected; all inputs use secure keyboards where relevant; error regions are `aria-live`/screen-reader announced.

### S1 — Access Gate (`/(gate)/access`)
- **Purpose:** Collect the pilot passcode; obtain + persist the access pass.
- **Layout:** Full-screen centered card on a subtle brand-spark gradient. Brand mark top. Single password field (masked, "one-time paste" friendly), primary "Enter" button, error region below field, meta chips row (`v0.9`, `SOC2`, `24/7`), a "Back" text link, and a small "Leave preview" affordance.
- **Elements:** masked TextInput (secureTextEntry, autoFocus, submit-on-return), Enter button (loading spinner state), error text, meta chips, brand spark, dev-only "Skip gate" hint (only in `__DEV__`).
- **States:** _loading_ (verifying, button spinner, field disabled); _empty/idle_ (field focused); _error_ (shake animation on card + red "Invalid access code" + input cleared + haptic error); _offline/network_ (distinct amber "Can't reach the server — retry" with Retry button, **not** the invalid-code style); _success_ (brief check, auto-forward).
- **Navigation in:** app cold start with no valid pass; any gated fetch that 401s on missing/expired pass (with `next`). **Out:** sanitized `next` or `/(auth)/login`.
- **Gestures:** return-key submits; pull-to-dismiss disabled (blocking gate). Shake is animation only.

### S2 — Login (`/(auth)/login`)
- **Purpose:** Demo-perspective quick-pick + manual sign-in + entry to SSO/register.
- **Layout:** BrandMark header, **PillTab** segmented control ("Sign in" / "Create account"), Surface-Mode toggle (sun/moon/system) top-right.
  - *Sign in tab:* 2×2 grid of **demo perspective cards** (Buyer Admin, Portfolio Lead, Farm Operations, Grower) — each card shows role pill, label, description, computed `${role}@${tenantSlug}.demo`. Below: **Manual sign-in** (Tenant slug field default `demo-buyer`, Email field, "Sign in" button). Optional **"Sign in with SSO"** button (shown only when OIDC configured). Optional **"Request portal access"** link (shown only when `registration-config.enabled`).
  - *Create account tab:* invite-type cards (Employee/Customer/Vendor) + tenant/name/email form (`devRegister` / invite path).
- **Elements:** PillTab, perspective cards (pressable, ripple/scale), tenant+email inputs, SSO button, request-access link, mono-red error banner, theme toggle.
- **States:** _loading_ (card/button spinner during dev-login/OIDC handoff); _empty_ (fresh); _error_ (mono-red banner "Sign-in failed" — tenant field preserved); _offline_ (dev-login/OIDC disabled with "Reconnect to sign in"); _already-authed_ (auto-redirect on mount to primary/`next`, brief splash).
- **Navigation in:** from gate, from sign-out, from expired session. **Out:** role primary tab (`landAfterAuth`), or SSO browser, or register verify flow.
- **Gestures:** tab swipe between Sign-in/Create; card tap = immediate dev-login.

### S3 — SSO Browser Handoff (system browser, not an in-app screen)
- **Purpose:** OIDC PKCE auth. **Layout:** system browser (expo-auth-session). App shows a thin "Completing sign-in…" interstitial on return.
- **States:** _pending_ (interstitial spinner); _success_ (persist + route to primary); _cancel/error_ (return to login with message). **Nav:** in from Login SSO button; out to primary tab or back to Login.

### S4 — Create Account / Invite Redemption (`/(auth)/register`)
- **Purpose:** Redeem invite or start self-service request.
- **Layout:** invite-type cards; token field (pre-filled from deep link, read-only when deep-linked); display-name field; submit. Secondary "Request portal access" panel (email/first/last/company/code) only when self-registration enabled.
- **States:** _loading_; _empty_; _invite-invalid/consumed_ (terminal error + fallback); _request-submitted_ ("Check your email" + resend); _verify-result_ deep-link states (ok/expired/invalid). _offline_ ("Registration needs a connection").
- **Nav in:** Login "Create account" tab; invite universal link; verify universal link. **Out:** primary tab (invite success) or back to Login.

### S5 — Auth Splash / Route Guard (invisible, `<AuthGate>`)
- **Purpose:** The mobile role-gate. **Layout:** branded splash while resolving pass/session/permissions/primary-surface. No user controls.
- **States:** _resolving_ (splash); _→gate_/_→login_/_→primary_/_→locked_. Decodes JWT `exp`, checks allow-list, sanitizes `next`. **Nav:** everywhere — it's the router interceptor.

### S6 — App Shell Header + Account Sheet (global, authed)
- **Purpose:** Show identity/tenant context and house switchers + sign-out.
- **Layout:** Top app bar with tenant badge (name + slug), user chip (avatar/initials), and a "…" that opens the **Account bottom sheet**: current user (email, role pills, clearance), **TenantSwitcher** (admin only), **DistrictSwitcher** (org claim only), theme toggle, "Sign out", "Leave preview".
- **Elements:** tenant badge, user chip, account sheet rows, switch controls, sign-out button (aria-label "Sign out").
- **States:** _default_; _offline_ (switchers disabled + banner); _revoked/expired_ (redirect out); _suspended_ (locked overlay). **Gestures:** swipe-down to dismiss sheet; long-press tenant badge = quick tenant info.

### S7 — Tenant Switcher (bottom sheet, admin only)
- **Purpose:** Platform-admin tenant switch. **Layout:** search field + listbox of tenants (name/slug, check on current). Building2 icon header.
- **States:** _loading_ (`GET /tenants`); _fallback_ (seed tenants when list empty); _switching_ (spinner + optimistic badge); _offline_ (disabled with "Reconnect to switch"); _error_ (toast, no state change).
- **Nav:** from Account sheet. On select → online re-mint → `rf.tenant-changed` → sheet closes, shell re-renders. **Gestures:** tap row to select; swipe-down close (mirrors Esc/click-away).

### S8 — District Switcher (bottom sheet, org-tier only)
- **Purpose:** Org-tier district switch. **Layout:** Landmark icon + org name header; rows "my districts under <org>" with check on current.
- **States:** _hidden_ (no org claim — control absent); _loading_ (`GET /iam/my-orgs`); _switching_ (`switch-tenant` + hard-refresh overlay); _offline_ (disabled); _error_ (membership 403 → inline message).
- **Nav:** from Account sheet. On select → re-mint → `rf.tenant-changed` → hard data-scope refresh → primary tab.

### S9 — Tenant Locked (full-screen, `/(locked)/suspended`)
- **Purpose:** Honest hard-stop for `403 tenant_suspended`. **Layout:** centered lock icon, tenant name, "This workspace is suspended. Contact your administrator.", Sign-out button, Retry button. All other nav disabled. **States:** _locked_; _retrying_; _unlocked_ (auto-route to primary on success).

### S10 — Session Ended (transient, `/(auth)/login?reason=revoked`)
- **Purpose:** Communicate hard sign-out from `401 token_revoked`/expiry. **Layout:** Login screen with a top info banner "Your session was ended by an administrator" / "Your session expired — please sign in again." **States:** shown once after teardown; dismiss on new sign-in.

### S11 — Admin: Tenant Administration (`/(admin)/tenants`, admin only)
- **Purpose:** Tenant CRUD + suspend/resume. **Layout:** searchable tenant list (name, slug, status chip active/trial/suspended, plan) → tenant detail (fields + status control + suspension reason field + audit note). FAB "New tenant".
- **Elements:** list rows, status filter, detail form, suspend/resume with reason modal, save button.
- **States:** _loading_; _empty_ (honest-empty "No tenants"); _read-only-offline_ (cached list, mutate disabled with banner); _saving_ (optimistic + verify); _error_ (rollback + toast); _403_ (not-admin → hidden entirely). **Nav:** Admin tab (admin primary) → detail. Maps to web `tenants.html` / operations Tenants tab.

### S12 — Admin: IAM Console (`/(admin)/iam`, gated)
- **Purpose:** Roles/permissions/users/teams/identities/flags/aliases/email-prefs/vendors — list-first, phone-optimized.
- **Layout:** section switcher (Roles · Permissions · Users · Teams · Identities · Flags · Vendors). Each is a list → detail:
  - *Roles:* list + create; detail edits name + permission set (`PUT /iam/roles/:id/permissions`); grant/revoke user roles with expiry.
  - *Permissions:* read-only catalog (cacheable — drives client gating labels).
  - *Users:* staff list (admin) + create/update/deactivate; per-user role grants + email-prefs.
  - *Teams:* list (`ops:manage`) + membership add/list/remove.
  - *Identities:* cross-tenant (no `X-Tenant-Id`) list + memberships CRUD (admin).
  - *Flags/Aliases/Email-prefs:* per-tenant toggles (admin or tenant.admin).
  - *Vendors:* list + apply-template.
- **Elements:** section tabs, list rows, detail forms, permission multi-select, expiry date pickers, member pickers (fed by `GET /tenants/me/users`), toggles.
- **States:** _loading_; _empty_; _read-only-offline_ (catalogs cached, mutations disabled); _saving_ (optimistic-but-verified); _403_ (section hidden per perm); _degraded_ (complex bulk grids marked read-only on small screens). **Nav:** Admin tab. Maps to web `staff.html`/IAM panels.

### S12b — Session/Token Management (within IAM Console, admin)
- **Purpose:** Revoke a session by `jti`; bust policy cache. **Layout:** active-sessions list (user, jti short, issued) with per-row "Revoke"; a "Bust policy cache" action after RBAC migrations. **States:** _revoking_ (confirm modal → `POST /iam/tokens/:jti/revoke`); _success_ (toast "Session revoked — effective ≤30s"); _403_ (hidden). Covers Token Revocation admin path.

### S13 — Tenant User Directory (embedded picker component)
- **Purpose:** `GET /tenants/me/users` for assignment/mention pickers, available to any authed member. **Layout:** searchable bottom-sheet list (name/email/role). **States:** _loading_; _empty_; _offline_ (cached read-only). **Nav:** invoked from assignment/mention affordances across farm/ops surfaces (auth-owned component).

---

## 4. Offline Behavior

| Capability | Offline behavior |
|---|---|
| **Access gate verify** | Online-only (server verify). If pass cached + unexpired → gated surfaces open offline; if no valid pass → block gated surfaces with "Connect to enter the preview." |
| **Sign-in (dev-login / OIDC / register)** | Online-only. Buttons disabled with "Reconnect to sign in." Already-cached session opens the app read-only. |
| **Session usage** | Cached JWT usable until `exp` decoded client-side. Reads served from tenant-partitioned SQLite. **Writes queue** in an outbox and carry/re-stamp the token at replay. |
| **Permission gating** | Fully offline from cached `rf.perms` (dot-perms + colon-roles + super-bypass). Re-hydrated on reconnect. Never a security boundary. |
| **Surface routing / role-gate** | Fully offline from cached roles (primary-surface + allow-list + sanitizeNextUrl). |
| **Tenant isolation** | Fully enforced offline — SQLite partitioned by `tenant_id`; `X-Tenant-Id` re-stamped on every replayed write. |
| **Tenant switch (admin)** | Online-only (re-mint). Disabled offline; on switch, cached scope segregated/purged. |
| **District switch (org)** | Online-only (`switch-tenant` re-mint). `myOrgs` cached for display only. |
| **Token revocation detection** | Impossible offline; first reconnect `401 token_revoked` → hard sign-out. |
| **Tenant suspension** | If cached as suspended or on reconnect `403` → full-screen locked state; blocks writes. |
| **Sign-out** | Works offline: clears secure-store + purges tenant SQLite + cancels push/sockets + routes to login. Optional revoke deferred until online. Theme preserved. |
| **Registration / invite / email-verify** | Inherently online (email + invite consumption). Deep links captured offline show "Reconnect to finish." |
| **Tenant admin CRUD** | Read-only cached list offline; all mutations require connectivity. |
| **IAM admin** | Permission/role **catalogs** cached read-only (label gating); all mutations online-only, optimistic-but-verified. |

---

## 5. Coverage Map (proves 100%)

| # | Inventory Feature | Priority | Covered by Epic/Stories | Covered by Screens | Journeys |
|---|---|---|---|---|---|
| 1 | Pilot Access-Code Gate | P0 | EPIC A (A1–A4) | S1 Access Gate; S5 AuthGate; S6 "Leave preview" | J1, (pass-expiry re-route in J2) |
| 2 | Login — Demo Perspectives & Manual Sign-In | P0 | EPIC B (B1–B4) | S2 Login; S5 AuthGate | J1, J2 |
| 3 | JWT Session, Token Claims & Verification | P0 | EPIC C (C1) | S5 AuthGate (exp decode); S6 user chip (`whoami`); apiClient interceptor | J2, J10 |
| 4 | Token Revocation (JTI Blocklist) | P1 | EPIC C (C2, C3) | S10 Session Ended; S12b Session/Token Mgmt | J5 |
| 5 | RBAC — Permission Hydration & Gates | P0 | EPIC D (D1, D3, D5) | S5 AuthGate; S6 role pills; every gated control; `rf.perms` | J1, J10 |
| 6 | Multi-Tenancy — Tenant Resolution & Isolation | P0 | EPIC E (E1, E4) | S6 tenant badge; S9 Tenant Locked; SQLite partition | J8, J10 |
| 7 | Tenant Switching (Platform Admin) | P1 | EPIC E (E2) | S7 Tenant Switcher | J3 |
| 8 | Org / District Switching (ADR-0024) | P1 | EPIC E (E3) | S8 District Switcher | J4 |
| 9 | Client-Side Surface Allow-List / Role Routing | P0 | EPIC D (D2, D4) | S5 AuthGate; tab bar; S6 | J1, (deep-link/push in D4) |
| 10 | Sign-Out / Session Teardown | P0 | EPIC C (C4) | S6 Account sheet Sign-out; S10 | J9, J5 |
| 11 | Invite-Based & Self-Service Registration | P1 | EPIC B (B6, B7) | S4 Create Account/Invite | J6 |
| 12 | Keycloak OIDC Login (Opt-In) | P2 | EPIC B (B5) | S2 SSO button; S3 SSO Handoff | J7 |
| 13 | Tenant Administration (Platform Admin) | P1 | EPIC F (F1, F2) | S11 Tenant Admin; S13 User Directory | J8 (suspend effect) |
| 14 | IAM Administration — Roles/Perms/Users/Teams/Identities/Flags | P2 | EPIC F (F3) | S12 IAM Console; S12b; S13 | — (admin flows within S12) |

**All 14 inventory features are covered.** Cross-cutting web primitives (localStorage stores, `X-Tenant-Id`/`Bearer`/`X-Access-Pass` headers, `sanitizeNextUrl`, `rwr.tenant-changed`, theme preservation, 401/403 handling) are mapped to native equivalents in §0 and referenced throughout.

---

## 6. Native Implementation Notes (build guidance)

- **Routing:** `expo-router` groups: `(gate)`, `(auth)`, `(admin)`, `(locked)`, and role-tab groups. `<AuthGate>` is a top-level layout that resolves pass→session→perms→primary before rendering children.
- **Secure storage:** tokens/pass only in `expo-secure-store`; scoped data in `expo-sqlite` with a `tenant_id` column + per-tenant DB attach or row-scoped queries; theme in `AsyncStorage`.
- **Networking:** single `apiClient` (fetch wrapper) stamps `Authorization`, `X-Tenant-Id`, `X-Access-Pass`; central 401/403 handler (generic-401 → clear+login; `token_revoked` → hard sign-out; `tenant_suspended` → locked; `tenant_mismatch` → re-resolve).
- **Events:** an app `EventEmitter` fires `rf.tenant-changed` to invalidate React Query keys and swap SQLite scope (mirrors web `rwr.tenant-changed`).
- **Deep links / push:** universal/app links for invite + email-verify + notification navigation, all passed through `sanitizeNextUrl` before `router.navigate`.
- **Biometric convenience (optional):** `expo-local-authentication` can gate re-open of a cached (unexpired) session for faster return without re-typing — never replaces server auth.
- **Honesty tiers:** any evidence-bearing preview inside auth surfaces renders T1/T2/T3 chips + detectability labels; unknown = honest-empty.
