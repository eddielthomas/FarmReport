// =============================================================================
// /api/v1 router — composed onto the existing vanilla-http server in
// api/server.mjs via `await handleV1(req, res)`. Returns `true` if it handled
// the request (so the outer router can short-circuit), `false` otherwise.
//
// Pattern: every business route is gated by requireAuth + requireTenant.
// Tenant-admin routes additionally require the platform:admin role.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { send, ok, notFound, serverErr, readBody } from './http.mjs';
import { requireAuth } from './middleware/auth.mjs';
import { requireTenant } from './middleware/tenant.mjs';
import { checkRevocation } from './middleware/revocation.mjs';
import { hydrateFlags } from './middleware/flags.mjs';
import { hydratePermissions, bustAllPermissions } from './middleware/policy.mjs';
import { requireVendorScope } from './middleware/vendorScope.mjs';
import { devLogin, whoami, register, registerWithInvite, switchTenant } from './auth.mjs';
import { loginRedirect as oidcLogin, callback as oidcCallback } from './auth-oidc.mjs';
import { registrationConfig, submitRegistration, verifyRegistration } from './auth-register.mjs';
import * as orgsMod from './iam/orgs.mjs';
import { verify as accessVerify } from './access.mjs';
import { requireAccessGate, stampSyntheticPass } from './middleware/accessGate.mjs';
import * as invitesMod from './iam/invites.mjs';
import * as identitiesMod from './iam/identities.mjs';
import * as tenantFlagsMod from './iam/tenant_flags.mjs';
import * as tenantAliasesMod from './iam/tenant_aliases.mjs';
import * as tokenRevocationMod from './iam/token_revocation.mjs';
import * as tenants from './tenants.mjs';
import * as emailPrefsMod from './iam/email_prefs.mjs';
import { drainOnce, reclaimStuck } from './email/drain.mjs';
import { requireRole, requireAnyRole } from './middleware/auth.mjs';
// Sprint A2 — active vertical (SolutionPack) resolved once at boot. The public
// /api/v1/vertical endpoint exposes its CLIENT-SAFE surface config so the
// client gate / SPA can read the single source of truth. No secrets emitted.
import { getActiveVertical, activeVerticalId } from '../../../packages/config/verticals/index.mjs';

// Resolve + cache the active vertical's public projection once. Defensive: a
// loader throw degrades to null and the endpoint returns 503 rather than
// crashing the router import.
let _verticalPublic = null;
try {
  const pack = getActiveVertical();
  _verticalPublic = Object.freeze({
    id: pack.id,
    displayName: pack.displayName ?? pack.name ?? pack.id,
    version: pack.version,
    knownRoles: pack.knownRoles ?? [],
    roleSurfaceAllowList: pack.roleSurfaceAllowList ?? {},
    primarySurfaceByRole: pack.primarySurfaceByRole ?? {},
    basemaps: pack.basemaps ?? [],
    defaultBasemap: pack.defaultBasemap ?? null,
    vocabulary: pack.vocabulary ?? {},
    activeVerticalId: activeVerticalId(),
  });
} catch (err) {
  console.warn('[api/v1] active vertical resolve failed:', err?.message ?? err);
  _verticalPublic = null;
}

// Kick off the token revocation prune worker once at module import time.
tokenRevocationMod.startPruneWorker();

// S3B — start the email outbox drain loop. Production runs unconditionally;
// tests opt out with EMAIL_DRAIN_DISABLED=1 and invoke drainOnce() manually.
if (process.env.NODE_ENV !== 'test' && process.env.EMAIL_DRAIN_DISABLED !== '1') {
  const tick = async () => {
    try {
      await reclaimStuck();
      await drainOnce();
    } catch (err) {
      console.error('[email.drain] tick_failed', err?.message ?? err);
    }
  };
  // Stagger first run by a few seconds so server boot isn't blocked.
  setTimeout(() => { tick(); setInterval(tick, 15_000); }, 5_000);
}

// Lazy-loaded handlers — wired in later phases.
let leadsMod, notesMod, meetingsMod, messagesMod, filesMod, productsMod, opportunitiesMod, proposalsMod, contractsMod, contactsMod, casesMod, analyticsMod, iamUsersMod, iamTeamsMod, iamRolesMod, iamPermsMod, gisMod, assignmentsMod,
    crmOrganizationsMod, crmContactsMod, crmActivitiesMod, crmRevenueMod, crmVendorsMod,
    crmMapMod,
    crmProjectsMod, crmScenesMod, crmScansMod, crmFieldResultsMod, crmPortalInvitesMod, crmRegistrationMod, customerProjectsMod,
    billingStreamsMod,
    chatConversationsMod, chatMessagesMod, chatMembersMod,
    calendarCredentialsMod,
    vendorContractsMod, vendorScopesMod, iamVendorsMod,
    fieldJobsMod, fieldLocationMod, fieldCheckinMod, fieldUploadsMod, fieldTasksMod,
    fieldNotesMod, fieldConversationMod, investigationsMod, reportsMod, orgRollupMod, orgDrilldownMod,
    farmFarmsMod, farmObservationsMod, farmAlertsMod, farmPortfolioMod, farmReportsMod, farmGatewayMod;
async function lazy(mod) {
  if (mod === 'leads')             return leadsMod             ??= await import('./sales/leads.mjs');
  if (mod === 'notes')             return notesMod             ??= await import('./sales/notes.mjs');
  if (mod === 'meetings')          return meetingsMod          ??= await import('./sales/meetings.mjs');
  if (mod === 'messages')          return messagesMod          ??= await import('./sales/messages.mjs');
  if (mod === 'files')             return filesMod             ??= await import('./sales/files.mjs');
  if (mod === 'products')          return productsMod          ??= await import('./sales/products.mjs');
  if (mod === 'opportunities')     return opportunitiesMod     ??= await import('./sales/opportunities.mjs');
  if (mod === 'proposals')         return proposalsMod         ??= await import('./sales/proposals.mjs');
  if (mod === 'contracts')         return contractsMod         ??= await import('./sales/contracts.mjs');
  if (mod === 'contacts')          return contactsMod          ??= await import('./sales/contacts.mjs');
  if (mod === 'cases')             return casesMod             ??= await import('./ops/cases.mjs');
  if (mod === 'analytics')         return analyticsMod         ??= await import('./analytics/index.mjs');
  if (mod === 'iam-users')         return iamUsersMod          ??= await import('./iam/users.mjs');
  if (mod === 'iam-teams')         return iamTeamsMod          ??= await import('./iam/teams.mjs');
  if (mod === 'iam-roles')         return iamRolesMod          ??= await import('./iam/roles.mjs');
  if (mod === 'iam-perms')         return iamPermsMod          ??= await import('./iam/permissions.mjs');
  if (mod === 'gis')               return gisMod               ??= await import('./gis/index.mjs');
  if (mod === 'assignments')       return assignmentsMod       ??= await import('./sales/assignments.mjs');
  // Sprint 2A — CRM lifecycle modules.
  if (mod === 'crm-organizations') return crmOrganizationsMod  ??= await import('./crm/organizations.mjs');
  if (mod === 'crm-contacts')      return crmContactsMod       ??= await import('./crm/contacts.mjs');
  if (mod === 'crm-activities')    return crmActivitiesMod     ??= await import('./crm/activities.mjs');
  if (mod === 'crm-revenue')       return crmRevenueMod        ??= await import('./crm/revenue.mjs');
  if (mod === 'crm-vendors')       return crmVendorsMod        ??= await import('./crm/vendors.mjs');
  // Sprint 5A — CRM map adapter (EPIC-008 P-008 Phases 1-3).
  if (mod === 'crm-map')           return crmMapMod            ??= await import('./crm/map.mjs');
  // Sprint 14A — customer projects + saved scenes.
  if (mod === 'crm-projects')      return crmProjectsMod       ??= await import('./crm/projects.mjs');
  if (mod === 'crm-scenes')        return crmScenesMod         ??= await import('./crm/scenes.mjs');
  if (mod === 'crm-scans')         return crmScansMod          ??= await import('./crm/scans.mjs');
  if (mod === 'crm-field-results') return crmFieldResultsMod   ??= await import('./crm/field-results.mjs');
  if (mod === 'crm-portal-invites') return crmPortalInvitesMod  ??= await import('./crm/portal-invites.mjs');
  if (mod === 'crm-registration')  return crmRegistrationMod   ??= await import('./crm/registration-admin.mjs');
  if (mod === 'customer-projects') return customerProjectsMod  ??= await import('./customer/projects.mjs');
  // Sprint 2B — billing streams.
  if (mod === 'billing-streams')   return billingStreamsMod    ??= await import('./billing/streams.mjs');
  // Sprint 3A — chat (EPIC-005 P-004 Phase 1).
  if (mod === 'chat-conversations') return chatConversationsMod ??= await import('./chat/conversations.mjs');
  if (mod === 'chat-messages')      return chatMessagesMod      ??= await import('./chat/messages.mjs');
  if (mod === 'chat-members')       return chatMembersMod       ??= await import('./chat/members.mjs');
  // Sprint 4A — calendar credentials (EPIC-007 P-007 Phase 1).
  if (mod === 'calendar-credentials') return calendarCredentialsMod ??= await import('./calendar/credentials.mjs');
  // Sprint 4B — vendor pool (EPIC-009 P-009 Phases 1-3).
  if (mod === 'vendor-contracts')     return vendorContractsMod    ??= await import('./vendor-pool/contracts.mjs');
  if (mod === 'vendor-scopes')        return vendorScopesMod       ??= await import('./vendor-pool/scopes.mjs');
  if (mod === 'iam-vendors')          return iamVendorsMod         ??= await import('./iam/vendors.mjs');
  // Sprint 9A — Field Service Management.
  if (mod === 'field-jobs')           return fieldJobsMod           ??= await import('./field/jobs.mjs');
  if (mod === 'field-location')       return fieldLocationMod       ??= await import('./field/location.mjs');
  if (mod === 'field-checkin')        return fieldCheckinMod        ??= await import('./field/checkin.mjs');
  if (mod === 'field-uploads')        return fieldUploadsMod        ??= await import('./field/uploads.mjs');
  if (mod === 'field-tasks')          return fieldTasksMod          ??= await import('./field/tasks.mjs');
  // Sprint S17 — Field Job Management.
  if (mod === 'field-notes')          return fieldNotesMod          ??= await import('./field/notes.mjs');
  if (mod === 'field-conversation')   return fieldConversationMod   ??= await import('./field/conversation.mjs');
  // Sprint — Investigation Typing + Evidence + Timeline.
  if (mod === 'investigations')       return investigationsMod      ??= await import('./ops/investigations.mjs');
  // Sprint ③ — Reporting engine.
  if (mod === 'reports')              return reportsMod             ??= await import('./reports/index.mjs');
  // Sprint A5.2 — ADR-0024 org oversight roll-up (forest, not trees).
  if (mod === 'org-rollup')           return orgRollupMod           ??= await import('./org/rollup.mjs');
  if (mod === 'org-drilldown')        return orgDrilldownMod        ??= await import('./org/drilldown.mjs');
  // Wave-2 Lane 2 — Report.Farm farm-domain API (farm.* schema).
  if (mod === 'farm-farms')           return farmFarmsMod           ??= await import('./farm/farms.mjs');
  if (mod === 'farm-observations')    return farmObservationsMod    ??= await import('./farm/observations.mjs');
  if (mod === 'farm-alerts')          return farmAlertsMod          ??= await import('./farm/alerts.mjs');
  if (mod === 'farm-portfolio')       return farmPortfolioMod       ??= await import('./farm/portfolio.mjs');
  if (mod === 'farm-reports')         return farmReportsMod         ??= await import('./farm/reports.mjs');
  // AlphaGeo gateway relay — thin byte-forwarder to /api/farm/* (twins, signals, scan, jobs, SSE).
  if (mod === 'farm-gateway')         return farmGatewayMod         ??= await import('./farm/gateway.mjs');
  return null;
}

// Role helpers — `requireRole` writes 403 and returns false on miss.
// `platform:admin` is treated as super-user by requireRole automatically.
// Sprint 1B: gate is satisfied by either the legacy role OR the canonical
// permission set hydrated by policy.mjs. This lets new RBAC users (sales.agent
// etc.) pass the prefix gate even when their legacy roles[] array is empty.
function hasAnyPerm(req, ...keys) {
  const perms = req.user?.permissions;
  if (!perms) return false;
  if (perms.has('platform.admin.all')) return true;
  for (const k of keys) if (perms.has(k)) return true;
  return false;
}
function gateOrRole(req, res, legacyRole, ...perms) {
  if (hasAnyPerm(req, ...perms)) return true;
  return requireRole(req, res, legacyRole);
}
const needsSales     = (req, res) => gateOrRole(req, res, 'sales:manage',
  'crm.lead.read','crm.lead.write','crm.contact.read','crm.opportunity.read');
const needsOps       = (req, res) => gateOrRole(req, res, 'ops:manage',
  'cases.read','cases.manage');
const needsAnalytics = (req, res) => gateOrRole(req, res, 'analytics:view',
  'crm.analytics.view','crm.dashboard.view',
  'crm.analytics.revenue.view','crm.analytics.export');

// Helper — try to import a module path; if missing, return null so the route
// returns 501 instead of crashing. Phases B–D fill these in.
async function tryLoad(name) {
  try { return await lazy(name); }
  catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

function notImpl(res, name) { send(res, 501, { success: false, error: 'not_implemented', detail: name }); }

// Returns true if the request was handled.
export async function handleV1(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith('/api/v1')) return false;

  req.requestId = randomUUID();
  const path = url.pathname.slice('/api/v1'.length) || '/';
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin':  process.env.CORS_ORIGIN ?? '*',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, x-tenant-id',
    });
    res.end();
    return true;
  }

  try {
    // ---- Sprint 10B: pilot access-code gate --------------------------------
    // Public-endpoint allowlist. Endpoints in this set bypass the access-code
    // gate AND the bearer-token check. Marketing inbound forms, auth flows,
    // and the access-code verify endpoint itself live here.
    //
    // Health probes for /api/v1 (no /api/v1/healthz exists — the legacy
    // /healthz on server.mjs covers that) are not in this list because the
    // /api/v1 prefix is not currently used for liveness probes.
    const PUBLIC_V1_PATHS = new Set([
      '/auth/dev-login',
      '/auth/register',
      '/auth/register-with-invite',
      '/auth/registration-config', // public: does the Register UI show?
      '/auth/register-request',     // public: submit a self-registration
      '/auth/register/verify',      // public: email-verify link target
      '/auth/whoami',           // bearer-protected but pre-tenant; gate is OK
      '/auth/oidc/login',       // P4 — Keycloak OIDC kickoff (302 to Keycloak)
      '/auth/oidc/callback',    // P4 — Keycloak OIDC return (sets app token)
      '/contact',
      '/contact/newsletter/confirm',
      '/access/verify',
      '/billing/webhook',       // Stripe webhook — signature-verified, no auth
      '/healthz',               // /api/v1/healthz mirror for proxies
      '/readyz',
      '/vertical',              // Sprint A2 — public active-vertical config
    ]);
    const isPublicV1 = PUBLIC_V1_PATHS.has(path);

    if (!isPublicV1) {
      const gate = requireAccessGate(req);
      if (!gate.ok) {
        send(res, 401, {
          success: false,
          error: 'access_gate_required',
          reason: gate.reason,
          redirect: '/access.html',
        });
        return true;
      }
    } else {
      // Public endpoints still benefit from the dev escape hatch stamp so
      // downstream cookie-driven static HTML serves OK in dev tests.
      stampSyntheticPass(res);
    }

    // ---- /api/v1/healthz + /readyz (mirror of legacy probes) ---------------
    if (path === '/healthz' && method === 'GET') {
      send(res, 200, { ok: true });
      return true;
    }
    if (path === '/readyz' && method === 'GET') {
      send(res, 200, { ok: true });
      return true;
    }

    // ---- Sprint A2: active vertical (SolutionPack) public config -----------
    // Single source of truth the client gate / SPA can consume. Read-only, no
    // secrets, no brand internals beyond what the client needs to route/label.
    if (path === '/vertical' && method === 'GET') {
      if (!_verticalPublic) {
        send(res, 503, { success: false, error: 'vertical_unavailable' });
        return true;
      }
      send(res, 200, { success: true, data: _verticalPublic });
      return true;
    }

    // ---- Sprint 10B: access-code verify ------------------------------------
    if (path === '/access/verify' && method === 'POST') {
      await accessVerify(req, res); return true;
    }

    // ---- Stripe webhook (public, signature-verified, RAW body) -------------
    // Must run BEFORE auth/tenant middleware and before any body parsing so the
    // handler can read the exact bytes Stripe signed.
    if (path === '/billing/webhook' && method === 'POST') {
      const wh = await import('./billing/webhook.mjs');
      await wh.handleWebhook(req, res);
      return true;
    }

    // ---- auth ----------------------------------------------------------------
    // /auth/dev-login is dev-only. In any other env we pretend it doesn't
    // exist (404 — never 403) so prod scanners can't fingerprint the route.
    if (path === '/auth/dev-login' && method === 'POST') {
      const devOk = process.env.NODE_ENV === 'development'
        && process.env.ALLOW_DEV_LOGIN === '1';
      if (!devOk) { notFound(res); return true; }
      await devLogin(req, res); return true;
    }
    // /auth/register (self-serve) is gone — invite-only now. Return 410 Gone
    // with a pointer to the new endpoint so clients fail loudly, not silently.
    if (path === '/auth/register' && method === 'POST') {
      await register(req, res); return true;
    }
    if (path === '/auth/register-with-invite' && method === 'POST') {
      await registerWithInvite(req, res); return true;
    }
    // Self-service registration (opt-in via ALLOW_SELF_REGISTRATION; the handlers
    // self-return 404 when the flag is off, so the route is invisible when disabled).
    if (path === '/auth/registration-config' && method === 'GET') {
      await registrationConfig(req, res); return true;
    }
    if (path === '/auth/register-request' && method === 'POST') {
      await submitRegistration(req, res); return true;
    }
    if (path === '/auth/register/verify' && method === 'GET') {
      await verifyRegistration(req, res); return true;
    }
    if (path === '/auth/whoami' && method === 'GET') {
      const a = await requireAuth(req, res); if (!a) return true;
      req.user = a.user;
      await whoami(req, res); return true;
    }
    // ---- P4: Keycloak OIDC code-grant. Each handler self-returns 404 JSON
    // when KEYCLOAK_* env is absent, so dev-login + invite flows are untouched.
    if (path === '/auth/oidc/login' && method === 'GET') {
      await oidcLogin(req, res); return true;
    }
    if (path === '/auth/oidc/callback' && method === 'GET') {
      await oidcCallback(req, res); return true;
    }

    // ---- public marketing endpoints (no auth) ------------------------------
    if (path === '/contact' && method === 'POST') {
      const c = await import('./contact.mjs');
      await c.submit(req, res); return true;
    }
    if (path === '/contact/newsletter/confirm' && method === 'GET') {
      const c = await import('./contact.mjs');
      await c.confirmNewsletter(req, res); return true;
    }

    // ---- everything below requires a valid bearer token --------------------
    const a = await requireAuth(req, res);
    if (!a) return true;
    req.user = a.user;

    // ---- permission hydration -----------------------------------------------
    // Resolves req.user.permissions (Set<string>) + req.user.roleKeys[] from
    // iam.user_role JOIN iam.role_permission, layered over the legacy roles[]
    // array shim. Soft-fails to legacy-only on DB error.
    await hydratePermissions(req);

    // ---- token revocation check (jti blocklist) -----------------------------
    // Runs AFTER requireAuth so we have req.user.jti to consult. Writes 401
    // on hit; the request is short-circuited.
    if (!(await checkRevocation(req, res))) return true;

    // ---- contact admin (platform:admin only) -------------------------------
    // Triage routes are platform-scoped (submissions are pre-tenant) so we
    // only require auth + the admin role; no tenant header needed.
    if (path.startsWith('/contact/admin')) {
      if (!requireRole(req, res, 'platform:admin')) return true;
      const adm = await import('./contact_admin.mjs');
      if (path === '/contact/admin/list' && method === 'GET') {
        await adm.list(req, res); return true;
      }
      const m = path.match(/^\/contact\/admin\/([0-9a-f-]{36})(\/[a-z]+)?$/i);
      if (m) {
        const subId = m[1]; const sub = m[2];
        if (!sub) {
          if (method === 'GET')   { await adm.getOne(req, res, subId); return true; }
          if (method === 'PATCH') { await adm.patch (req, res, subId); return true; }
        }
        if (sub === '/promote' && method === 'POST') { await adm.promote(req, res, subId);   return true; }
        if (sub === '/spam'    && method === 'POST') { await adm.markSpam(req, res, subId);  return true; }
      }
      // unknown sub-path under /contact/admin → 404 (don't leak into the
      // tenant-resolution path below; admin routes never require x-tenant-id).
      notFound(res);
      return true;
    }

    // ---- tenants (platform-admin) ------------------------------------------
    if (path === '/tenants' && method === 'GET')  { await tenants.listTenants(req, res); return true; }
    if (path === '/tenants' && method === 'POST') { await tenants.createTenant(req, res); return true; }
    {
      const m = path.match(/^\/tenants\/([0-9a-f-]{36})$/i);
      if (m) {
        if (method === 'GET') { await tenants.getTenant(req, res, m[1]); return true; }
        if (method === 'PUT') { await tenants.updateTenant(req, res, m[1]); return true; }
      }
    }

    // ---- iam/identities (platform-admin; cross-tenant) ---------------------
    // Identities are global; no X-Tenant-Id header required. Router enforces
    // platform.admin; handlers add granular checks for self-vs-other reads.
    if (path === '/iam/identities' && method === 'GET') {
      if (!requireRole(req, res, 'platform:admin')) return true;
      await identitiesMod.list(req, res); return true;
    }
    if (path === '/iam/identities' && method === 'POST') {
      if (!requireRole(req, res, 'platform:admin')) return true;
      await identitiesMod.create(req, res); return true;
    }
    {
      const m = path.match(/^\/iam\/identities\/([0-9a-f-]{36})\/memberships$/i);
      if (m) {
        if (!requireRole(req, res, 'platform:admin')) return true;
        if (method === 'GET')  { await identitiesMod.listMemberships(req, res, m[1]); return true; }
        if (method === 'POST') { await identitiesMod.createMembership(req, res, m[1]); return true; }
      }
    }
    {
      const m = path.match(/^\/iam\/identities\/([0-9a-f-]{36})\/memberships\/([0-9a-f-]{36})$/i);
      if (m && method === 'DELETE') {
        if (!requireRole(req, res, 'platform:admin')) return true;
        await identitiesMod.revokeMembership(req, res, m[1], m[2]); return true;
      }
    }

    // ---- iam/tenants/:id/flags (platform.admin OR tenant.admin) ------------
    {
      const m = path.match(/^\/iam\/tenants\/([0-9a-f-]{36})\/flags$/i);
      if (m) {
        if (method === 'GET') { await tenantFlagsMod.get(req, res, m[1]); return true; }
        if (method === 'PUT') { await tenantFlagsMod.put(req, res, m[1]); return true; }
      }
    }

    // ---- iam/tenants/:id/aliases (platform.admin OR tenant.admin) ----------
    {
      const m = path.match(/^\/iam\/tenants\/([0-9a-f-]{36})\/aliases$/i);
      if (m) {
        if (method === 'GET')  { await tenantAliasesMod.list(req, res, m[1]); return true; }
        if (method === 'POST') { await tenantAliasesMod.create(req, res, m[1]); return true; }
      }
      const m2 = path.match(/^\/iam\/tenants\/([0-9a-f-]{36})\/aliases\/([^/]+)$/i);
      if (m2 && method === 'DELETE') {
        await tenantAliasesMod.remove(req, res, m2[1], decodeURIComponent(m2[2])); return true;
      }
    }

    // ---- iam/tokens/:jti/revoke (platform.admin) ---------------------------
    {
      const m = path.match(/^\/iam\/tokens\/([A-Za-z0-9._\-]{1,256})\/revoke$/i);
      if (m && method === 'POST') {
        await tokenRevocationMod.revoke(req, res, m[1]); return true;
      }
    }

    // ---- iam/admin/bust-policy-cache (platform.admin) ----------------------
    // Sprint 9.1: after a migration mutates iam.role_permission rows the
    // 60s in-process policy cache continues to serve the pre-migration set
    // until it expires. Operators can hit this endpoint to evict everything
    // immediately. Idempotent and side-effect-bounded.
    if (path === '/iam/admin/bust-policy-cache' && method === 'POST') {
      if (!requireRole(req, res, 'platform:admin')) return true;
      const evicted = bustAllPermissions();
      ok(res, { evicted });
      return true;
    }

    // ---- iam/my-orgs (Sprint A5.1 — ADR-0024) ------------------------------
    // Cross-tenant by design: returns the caller's orgs + the districts
    // (tenants) they can act in. Requires auth (already run) but NOT a tenant
    // header. Read-only.
    if (path === '/iam/my-orgs' && method === 'GET') {
      await orgsMod.listMyOrgs(req, res); return true;
    }

    // ---- auth/switch-tenant (Sprint A5.1 — ADR-0024) -----------------------
    // Re-mints the JWT for a DIFFERENT district the caller is a member of.
    // Pre-tenant (no X-Tenant-Id needed) — the switch chooses the new tenant.
    if (path === '/auth/switch-tenant' && method === 'POST') {
      await switchTenant(req, res); return true;
    }

    // ---- everything below requires a resolved tenant -----------------------
    const tenant = await requireTenant(req, res);
    if (!tenant) return true;
    req.tenant = tenant;

    // ---- per-tenant feature flag hydration ---------------------------------
    // Adds req.tenant.flags (merged JSONB + iam.tenant_feature_flag rows).
    // 60s LRU; failures soft-default to {} so route handlers can rely on the
    // property existing.
    await hydrateFlags(req);

    // ---- tenant-scoped user directory (assignment dropdowns, mentions) -----
    if (path === '/tenants/me/users' && method === 'GET') {
      await tenants.listTenantUsers(req, res);
      return true;
    }

    // ---- iam/tenants/:id/email-prefs  (S3B) --------------------------------
    {
      const m = path.match(/^\/iam\/tenants\/([0-9a-f-]{36})\/email-prefs$/i);
      if (m) {
        if (method === 'GET')   { await emailPrefsMod.getTenant(req, res, m[1]);   return true; }
        if (method === 'PATCH') { await emailPrefsMod.patchTenant(req, res, m[1]); return true; }
      }
    }
    // ---- iam/users/:id/email-prefs  (S3B) ----------------------------------
    {
      const m = path.match(/^\/iam\/users\/([0-9a-f-]{36})\/email-prefs$/i);
      if (m) {
        if (method === 'GET')   { await emailPrefsMod.getUser(req, res, m[1]);   return true; }
        if (method === 'PATCH') { await emailPrefsMod.patchUser(req, res, m[1]); return true; }
      }
    }

    // ---- iam/invites — admin-only invite token mint + list -----------------
    if (path === '/iam/invites' && method === 'POST') {
      if (!requireRole(req, res, 'platform:admin')) return true;
      await invitesMod.create(req, res); return true;
    }
    if (path === '/iam/invites' && method === 'GET') {
      if (!requireRole(req, res, 'platform:admin')) return true;
      await invitesMod.list(req, res); return true;
    }

    // -------- iam/permissions + iam/roles (RBAC, Sprint 1B) ------------------
    {
      const perms = await tryLoad('iam-perms');
      if (path === '/iam/permissions' && method === 'GET') {
        perms ? await perms.list(req, res) : notImpl(res, 'iam.permissions.list');
        return true;
      }
    }
    {
      const roles = await tryLoad('iam-roles');
      if (path === '/iam/roles') {
        if (method === 'GET')  { roles ? await roles.list(req, res)   : notImpl(res, 'iam.roles.list');   return true; }
        if (method === 'POST') { roles ? await roles.create(req, res) : notImpl(res, 'iam.roles.create'); return true; }
      }
      const m = path.match(/^\/iam\/roles\/([0-9a-f-]{36})(\/permissions)?$/i);
      if (m) {
        const id = m[1]; const sub = m[2];
        if (!sub) {
          if (method === 'GET')    { roles ? await roles.detail(req, res, id) : notImpl(res, 'iam.roles.detail'); return true; }
          if (method === 'PATCH')  { roles ? await roles.update(req, res, id) : notImpl(res, 'iam.roles.update'); return true; }
          if (method === 'DELETE') { roles ? await roles.remove(req, res, id) : notImpl(res, 'iam.roles.remove'); return true; }
        } else if (sub === '/permissions' && method === 'POST') {
          roles ? await roles.setPermissions(req, res, id) : notImpl(res, 'iam.roles.setPermissions');
          return true;
        }
      }
      // user-role grants live under /iam/users/:user_id/roles
      const mu = path.match(/^\/iam\/users\/([0-9a-f-]{36})\/roles(?:\/([0-9a-f-]{36}))?$/i);
      if (mu) {
        const userId = mu[1]; const roleId = mu[2];
        if (!roleId) {
          if (method === 'GET')  { roles ? await roles.listUserRoles(req, res, userId) : notImpl(res, 'iam.user_role.list'); return true; }
          if (method === 'POST') { roles ? await roles.grantUserRole(req, res, userId) : notImpl(res, 'iam.user_role.grant'); return true; }
        } else if (method === 'DELETE') {
          roles ? await roles.revokeUserRole(req, res, userId, roleId) : notImpl(res, 'iam.user_role.revoke');
          return true;
        }
      }
    }

    // -------- sales/assignments (RBAC visibility, Sprint 1B) -----------------
    {
      const asg = await tryLoad('assignments');
      if (path === '/sales/assignments') {
        if (method === 'GET')  { asg ? await asg.list(req, res)             : notImpl(res, 'assignments.list');   return true; }
        if (method === 'POST') { asg ? await asg.createAssignment(req, res) : notImpl(res, 'assignments.create'); return true; }
      }
      const m = path.match(/^\/sales\/assignments\/([0-9a-f-]{36})$/i);
      if (m && method === 'DELETE') {
        asg ? await asg.release(req, res, m[1]) : notImpl(res, 'assignments.release');
        return true;
      }
    }

    // -------- iam/users (staff) --------------------------------------------
    // List/mutate is platform:admin-only. Non-admin assignment dropdowns must
    // use the narrower `/tenants/me/users` endpoint instead.
    {
      const users = await tryLoad('iam-users');
      if (path === '/iam/users') {
        if (method === 'GET')  { if (!requireRole(req, res, 'platform:admin')) return true; users ? await users.list(req, res)   : notImpl(res, 'iam.users.list');   return true; }
        if (method === 'POST') { users ? await users.create(req, res) : notImpl(res, 'iam.users.create'); return true; }
      }
      const m = path.match(/^\/iam\/users\/([0-9a-f-]{36})$/i);
      if (m) {
        if (method === 'PUT')    { users ? await users.update(req, res, m[1])     : notImpl(res, 'iam.users.update');     return true; }
        if (method === 'DELETE') { users ? await users.deactivate(req, res, m[1]) : notImpl(res, 'iam.users.deactivate'); return true; }
      }
    }

    // -------- iam/vendors (Sprint 4B — P-009 Phase 3) ----------------------
    {
      const vendors = await tryLoad('iam-vendors');
      if (path === '/iam/vendors' && method === 'GET') {
        vendors ? await vendors.list(req, res) : notImpl(res, 'iam.vendors.list');
        return true;
      }
      const m = path.match(/^\/iam\/vendors\/([0-9a-f-]{36})\/apply-template$/i);
      if (m && method === 'POST') {
        vendors ? await vendors.applyTemplate(req, res, m[1]) : notImpl(res, 'iam.vendors.applyTemplate');
        return true;
      }
    }

    // -------- vendor-pool/contracts + scopes (Sprint 4B — P-009 Phase 2) ----
    {
      const contracts = await tryLoad('vendor-contracts');
      const scopes    = await tryLoad('vendor-scopes');
      if (path === '/vendor-pool/contracts') {
        if (method === 'GET')  { contracts ? await contracts.list(req, res)   : notImpl(res, 'vendor.contracts.list');   return true; }
        if (method === 'POST') { contracts ? await contracts.create(req, res) : notImpl(res, 'vendor.contracts.create'); return true; }
      }
      const m = path.match(/^\/vendor-pool\/contracts\/([0-9a-f-]{36})(\/[a-z-]+)?(?:\/([0-9a-f-]{36}))?$/i);
      if (m) {
        const cid = m[1]; const sub = m[2]; const scopeId = m[3];
        if (!sub) {
          if (method === 'GET') { contracts ? await contracts.getOne(req, res, cid) : notImpl(res, 'vendor.contracts.get');    return true; }
          if (method === 'PUT') { contracts ? await contracts.update(req, res, cid) : notImpl(res, 'vendor.contracts.update'); return true; }
        }
        if (sub === '/activate' && method === 'POST') {
          contracts ? await contracts.activate(req, res, cid) : notImpl(res, 'vendor.contracts.activate');
          return true;
        }
        if (sub === '/revoke' && method === 'POST') {
          contracts ? await contracts.revoke(req, res, cid) : notImpl(res, 'vendor.contracts.revoke');
          return true;
        }
        if (sub === '/scopes' && !scopeId && method === 'POST') {
          scopes ? await scopes.addScope(req, res, cid) : notImpl(res, 'vendor.scopes.add');
          return true;
        }
        if (sub === '/scopes' && scopeId && method === 'DELETE') {
          scopes ? await scopes.removeScope(req, res, cid, scopeId) : notImpl(res, 'vendor.scopes.remove');
          return true;
        }
      }
    }

    // -------- iam/teams ----------------------------------------------------
    // List is platform:admin OR ops:manage (ops needs team rosters for case
    // assignment dropdowns in OperationsDashboard). Mutations are admin-only
    // (enforced inside each handler).
    {
      const teams = await tryLoad('iam-teams');
      if (path === '/iam/teams') {
        if (method === 'GET')  { if (!requireAnyRole(req, res, 'ops:manage')) return true; teams ? await teams.list(req, res)   : notImpl(res, 'iam.teams.list');   return true; }
        if (method === 'POST') { teams ? await teams.create(req, res) : notImpl(res, 'iam.teams.create'); return true; }
      }
      const m = path.match(/^\/iam\/teams\/([0-9a-f-]{36})(\/members(?:\/([0-9a-f-]{36}))?)?$/i);
      if (m) {
        const teamId = m[1]; const sub = m[2]; const userId = m[3];
        if (!sub) {
          if (method === 'PUT')    { teams ? await teams.update(req, res, teamId) : notImpl(res, 'iam.teams.update'); return true; }
          if (method === 'DELETE') { teams ? await teams.remove(req, res, teamId) : notImpl(res, 'iam.teams.remove'); return true; }
        } else if (sub.startsWith('/members') && !userId && method === 'GET') {
          teams ? await teams.listMembers(req, res, teamId) : notImpl(res, 'iam.teams.listMembers');
          return true;
        } else if (sub.startsWith('/members') && !userId && method === 'POST') {
          teams ? await teams.addMember(req, res, teamId) : notImpl(res, 'iam.teams.addMember');
          return true;
        } else if (userId && method === 'DELETE') {
          teams ? await teams.removeMember(req, res, teamId, userId) : notImpl(res, 'iam.teams.removeMember');
          return true;
        }
      }
    }

    // ---- RBAC prefix gates -------------------------------------------------
    // `requireRole` lets `platform:admin` through as a super-user.
    // Carve-out: customers (role customer:view) get read-only access to a
    // narrow set of sales endpoints needed by the customer portal:
    //   GET  /sales/leads
    //   GET  /sales/leads/:id
    //   GET  /sales/leads/:id/messages
    //   POST /sales/leads/:id/messages         (send a message)
    //   GET  /sales/leads/:id/files
    //   GET  /sales/meetings(?from=…)
    // Everything else under /sales/* still requires sales:manage.
    const customerAllowed = (() => {
      const roles = req.user?.roles ?? [];
      if (!roles.includes('customer:view')) return false;
      if (roles.includes('sales:manage'))   return false; // staff path handles it
      if (method === 'GET' && (
        path === '/sales/leads' ||
        /^\/sales\/leads\/[0-9a-f-]{36}$/i.test(path) ||
        /^\/sales\/leads\/[0-9a-f-]{36}\/(messages|files)$/i.test(path) ||
        /^\/sales\/meetings(\?|$)/.test(path)
      )) return true;
      if (method === 'POST' && /^\/sales\/leads\/[0-9a-f-]{36}\/messages$/i.test(path)) return true;
      return false;
    })();

    if (!customerAllowed) {
      if (path.startsWith('/sales/')     && !needsSales(req, res))     return true;
      if (path.startsWith('/ops/')       && !needsOps(req, res))       return true;
      if (path.startsWith('/analytics/') && !needsAnalytics(req, res)) return true;
      // Sprint 2B: /billing/* gated by the revenue perm bundle. The handler
      // does the granular requirePermission check per-endpoint.
      if (path.startsWith('/billing/')) {
        if (!hasAnyPerm(req, 'crm.revenue.read','crm.revenue.write')) {
          if (!requireRole(req, res, 'sales:manage')) return true;
        }
      }
      // Sprint 3A: /chat/* umbrella gate. Granular permission check is
      // re-applied inside each handler (requirePermission). The umbrella
      // gate stops casual probes for callers without any chat permission.
      if (path.startsWith('/chat/')) {
        if (!hasAnyPerm(req, 'crm.chat.read','crm.chat.write','crm.chat.admin')) {
          if (!requireRole(req, res, 'sales:manage')) return true;
        }
      }
    }

    // -------- vendor scope dry-run gate (Sprint 4B — P-009 Phase 2) --------
    // Mounted ahead of the CRM / Sales / Ops handler chain. Dry-run by default
    // (logs deny decisions via recordAudit but does not block traffic). Flip
    // RWR_VENDOR_SCOPE_ENFORCE=1 to switch to enforce mode after the dry-run
    // window confirms zero false-positives. Non-vendor callers pass through
    // transparently (the middleware short-circuits on hasVendorRole === false).
    {
      let vendorResourceType = null;
      let vendorResourceId   = null;
      if (path === '/sales/leads' || /^\/sales\/leads\/[0-9a-f-]{36}/i.test(path)) {
        vendorResourceType = 'lead';
        const mm = path.match(/^\/sales\/leads\/([0-9a-f-]{36})/i);
        if (mm) vendorResourceId = mm[1];
      } else if (path === '/crm/contacts' || /^\/crm\/contacts\/[0-9a-f-]{36}/i.test(path)) {
        vendorResourceType = 'contact';
        const mm = path.match(/^\/crm\/contacts\/([0-9a-f-]{36})/i);
        if (mm) vendorResourceId = mm[1];
      } else if (path === '/crm/organizations' || /^\/crm\/organizations\/[0-9a-f-]{36}/i.test(path)) {
        vendorResourceType = 'organization';
        const mm = path.match(/^\/crm\/organizations\/([0-9a-f-]{36})/i);
        if (mm) vendorResourceId = mm[1];
      } else if (path === '/ops/cases' || /^\/ops\/cases\/[0-9a-f-]{36}/i.test(path)) {
        vendorResourceType = 'case';
        const mm = path.match(/^\/ops\/cases\/([0-9a-f-]{36})/i);
        if (mm) vendorResourceId = mm[1];
      }
      if (vendorResourceType) {
        const ok = await requireVendorScope(req, res, vendorResourceType, vendorResourceId);
        if (!ok) return true;
      }
    }

    // -------- sales/leads ---------------------------------------------------
    {
      const leads = await tryLoad('leads');
      if (path === '/sales/leads') {
        if (method === 'GET')  { leads ? await leads.list(req, res)   : notImpl(res, 'leads.list');   return true; }
        if (method === 'POST') { leads ? await leads.create(req, res) : notImpl(res, 'leads.create'); return true; }
      }
      const m = path.match(/^\/sales\/leads\/([0-9a-f-]{36})(\/[a-z-]+)?$/i);
      if (m) {
        const id = m[1]; const sub = m[2];
        if (!sub) {
          if (method === 'GET')    { leads ? await leads.get(req, res, id)    : notImpl(res, 'leads.get');    return true; }
          if (method === 'PUT')    { leads ? await leads.update(req, res, id) : notImpl(res, 'leads.update'); return true; }
          if (method === 'DELETE') { leads ? await leads.remove(req, res, id) : notImpl(res, 'leads.remove'); return true; }
        }
        if (sub === '/status'         && method === 'POST') { leads ? await leads.changeStatus(req, res, id)  : notImpl(res, 'leads.changeStatus');  return true; }
        if (sub === '/products'       && method === 'POST') { leads ? await leads.attachProducts(req, res, id): notImpl(res, 'leads.attachProducts');return true; }
        if (sub === '/status-history' && method === 'GET')  { leads ? await leads.statusHistory(req, res, id) : notImpl(res, 'leads.statusHistory'); return true; }
        if (sub === '/notes' && method === 'GET')           { const notes = await tryLoad('notes'); notes ? await notes.listForLead(req, res, id) : notImpl(res, 'notes.list'); return true; }
        if (sub === '/notes' && method === 'POST')          { const notes = await tryLoad('notes'); notes ? await notes.createForLead(req, res, id) : notImpl(res, 'notes.create'); return true; }
        if (sub === '/messages' && method === 'GET')        { const msgs = await tryLoad('messages'); msgs ? await msgs.listForLead(req, res, id) : notImpl(res, 'messages.list'); return true; }
        if (sub === '/messages' && method === 'POST')       { const msgs = await tryLoad('messages'); msgs ? await msgs.createForLead(req, res, id) : notImpl(res, 'messages.create'); return true; }
        if (sub === '/files' && method === 'GET')           { const files = await tryLoad('files'); files ? await files.listForLead(req, res, id) : notImpl(res, 'files.list'); return true; }
      }
    }

    // -------- sales/notes ---------------------------------------------------
    {
      const m = path.match(/^\/sales\/notes\/([0-9a-f-]{36})$/i);
      if (m && method === 'DELETE') {
        const notes = await tryLoad('notes');
        notes ? await notes.remove(req, res, m[1]) : notImpl(res, 'notes.remove');
        return true;
      }
    }

    // -------- sales/meetings ------------------------------------------------
    {
      const meetings = await tryLoad('meetings');
      if (path === '/sales/meetings') {
        if (method === 'GET')  { meetings ? await meetings.list(req, res)   : notImpl(res, 'meetings.list');   return true; }
        if (method === 'POST') { meetings ? await meetings.create(req, res) : notImpl(res, 'meetings.create'); return true; }
      }
      const m = path.match(/^\/sales\/meetings\/([0-9a-f-]{36})$/i);
      if (m) {
        if (method === 'PUT')    { meetings ? await meetings.update(req, res, m[1])  : notImpl(res, 'meetings.update'); return true; }
        if (method === 'DELETE') { meetings ? await meetings.remove(req, res, m[1])  : notImpl(res, 'meetings.remove'); return true; }
      }
    }

    // -------- calendar/credentials (Sprint 4A — EPIC-007 P-007 Phase 1) ----
    // Self-only by default; platform.admin sees the tenant-wide list.
    // Phase 1 ships list + revoke; Phase 2 will add connect flows.
    {
      const cal = await tryLoad('calendar-credentials');
      if (path === '/calendar/credentials' && method === 'GET') {
        cal ? await cal.list(req, res) : notImpl(res, 'calendar.credentials.list');
        return true;
      }
      const m = path.match(/^\/calendar\/credentials\/([0-9a-f-]{36})$/i);
      if (m && method === 'DELETE') {
        cal ? await cal.revoke(req, res, m[1]) : notImpl(res, 'calendar.credentials.revoke');
        return true;
      }
    }

    // -------- sales/files ---------------------------------------------------
    {
      const files = await tryLoad('files');
      if (path === '/sales/files/upload' && method === 'POST') { files ? await files.upload(req, res) : notImpl(res, 'files.upload'); return true; }
      const m = path.match(/^\/sales\/files\/([0-9a-f-]{36})$/i);
      if (m && method === 'DELETE') { files ? await files.remove(req, res, m[1]) : notImpl(res, 'files.remove'); return true; }
    }

    // -------- sales/products / contacts / opportunities --------------------
    if (path === '/sales/products' && method === 'GET') {
      const products = await tryLoad('products');
      products ? await products.list(req, res) : notImpl(res, 'products.list'); return true;
    }
    if (path === '/sales/contacts/search' && method === 'GET') {
      const contacts = await tryLoad('contacts');
      contacts ? await contacts.search(req, res) : notImpl(res, 'contacts.search'); return true;
    }
    {
      const opps = await tryLoad('opportunities');
      if (path === '/sales/opportunities') {
        if (method === 'GET')  { opps ? await opps.list(req, res)   : notImpl(res, 'opportunities.list');   return true; }
        if (method === 'POST') { opps ? await opps.create(req, res) : notImpl(res, 'opportunities.create'); return true; }
      }
      const m = path.match(/^\/sales\/opportunities\/([0-9a-f-]{36})$/i);
      if (m && method === 'PUT') { opps ? await opps.update(req, res, m[1]) : notImpl(res, 'opportunities.update'); return true; }
      // Proposals scoped to an opportunity.
      const mp = path.match(/^\/sales\/opportunities\/([0-9a-f-]{36})\/proposals$/i);
      if (mp && method === 'GET') {
        const proposals = await tryLoad('proposals');
        proposals ? await proposals.listForOpportunity(req, res, mp[1]) : notImpl(res, 'proposals.listForOpportunity');
        return true;
      }
    }

    // -------- sales/proposals (Proposal + Contract sprint) -----------------
    {
      const proposals = await tryLoad('proposals');
      if (path === '/sales/proposals') {
        if (method === 'GET')  { proposals ? await proposals.list(req, res)   : notImpl(res, 'proposals.list');   return true; }
        if (method === 'POST') { proposals ? await proposals.create(req, res) : notImpl(res, 'proposals.create'); return true; }
      }
      const m = path.match(/^\/sales\/proposals\/([0-9a-f-]{36})(\/[a-z-]+)?$/i);
      if (m) {
        const id = m[1]; const sub = m[2];
        if (!sub) {
          if (method === 'GET') { proposals ? await proposals.get(req, res, id)    : notImpl(res, 'proposals.get');    return true; }
          if (method === 'PUT') { proposals ? await proposals.update(req, res, id) : notImpl(res, 'proposals.update'); return true; }
        }
        if (sub === '/status' && method === 'POST') {
          proposals ? await proposals.changeStatus(req, res, id) : notImpl(res, 'proposals.changeStatus');
          return true;
        }
        if (sub === '/convert' && method === 'POST') {
          const contracts = await tryLoad('contracts');
          contracts ? await contracts.convertFromProposal(req, res, id) : notImpl(res, 'contracts.convertFromProposal');
          return true;
        }
      }
    }

    // -------- sales/contracts (Proposal + Contract sprint) -----------------
    {
      const contracts = await tryLoad('contracts');
      if (path === '/sales/contracts') {
        if (method === 'GET')  { contracts ? await contracts.list(req, res)   : notImpl(res, 'contracts.list');   return true; }
        if (method === 'POST') { contracts ? await contracts.create(req, res) : notImpl(res, 'contracts.create'); return true; }
      }
      const m = path.match(/^\/sales\/contracts\/([0-9a-f-]{36})(\/[a-z-]+)?$/i);
      if (m) {
        const id = m[1]; const sub = m[2];
        if (!sub) {
          if (method === 'GET') { contracts ? await contracts.get(req, res, id)    : notImpl(res, 'contracts.get');    return true; }
          if (method === 'PUT') { contracts ? await contracts.update(req, res, id) : notImpl(res, 'contracts.update'); return true; }
        }
        if (sub === '/status' && method === 'POST') {
          contracts ? await contracts.changeStatus(req, res, id) : notImpl(res, 'contracts.changeStatus');
          return true;
        }
      }
    }

    // -------- crm/* (Sprint 2A lifecycle objects) --------------------------
    // RBAC gates are inside each handler via requirePermission. We do an
    // umbrella prefix gate too so unrelated roles see a 403 instead of being
    // probed for granular perms.
    if (path.startsWith('/crm/')) {
      if (!hasAnyPerm(req,
        'crm.organization.read','crm.organization.write',
        'crm.contact.read','crm.contact.write',
        'crm.activity.read','crm.activity.write',
        'crm.revenue.read','crm.revenue.write',
        'crm.vendor.read','crm.vendor.write',
        // Sprint 5A — /crm/map/* reads sales.lead under crm.lead.read.
        'crm.lead.read','crm.lead.write',
        // Sprint 14A — /crm/projects/* + /crm/projects/:id/scenes/*
        'crm.project.read','crm.project.write',
        'crm.scene.read','crm.scene.write',
      )) {
        if (!requireRole(req, res, 'sales:manage')) return true;
      }
    }
    {
      const orgs = await tryLoad('crm-organizations');
      if (path === '/crm/organizations') {
        if (method === 'GET')  { orgs ? await orgs.list(req, res)   : notImpl(res, 'crm.org.list');   return true; }
        if (method === 'POST') { orgs ? await orgs.create(req, res) : notImpl(res, 'crm.org.create'); return true; }
      }
      const m = path.match(/^\/crm\/organizations\/([0-9a-f-]{36})$/i);
      if (m) {
        if (method === 'GET') { orgs ? await orgs.get(req, res, m[1])    : notImpl(res, 'crm.org.get');    return true; }
        if (method === 'PUT') { orgs ? await orgs.update(req, res, m[1]) : notImpl(res, 'crm.org.update'); return true; }
      }
    }
    {
      const contacts = await tryLoad('crm-contacts');
      if (path === '/crm/contacts') {
        if (method === 'GET')  { contacts ? await contacts.list(req, res)   : notImpl(res, 'crm.contact.list');   return true; }
        if (method === 'POST') { contacts ? await contacts.create(req, res) : notImpl(res, 'crm.contact.create'); return true; }
      }
      const m = path.match(/^\/crm\/contacts\/([0-9a-f-]{36})(\/link-lead)?$/i);
      if (m) {
        const id = m[1]; const sub = m[2];
        if (!sub) {
          if (method === 'GET') { contacts ? await contacts.get(req, res, id)    : notImpl(res, 'crm.contact.get');    return true; }
          if (method === 'PUT') { contacts ? await contacts.update(req, res, id) : notImpl(res, 'crm.contact.update'); return true; }
        }
        if (sub === '/link-lead' && method === 'POST') {
          contacts ? await contacts.linkLead(req, res, id) : notImpl(res, 'crm.contact.link_lead');
          return true;
        }
      }
      // Provision a client's SSO portal login (creates the Keycloak user).
      const mip = path.match(/^\/crm\/contacts\/([0-9a-f-]{36})\/invite-portal$/i);
      if (mip && method === 'POST') {
        const pinv = await tryLoad('crm-portal-invites');
        pinv ? await pinv.create(req, res, mip[1]) : notImpl(res, 'crm.portal.invite');
        return true;
      }
    }
    // ---- self-registration review (staff) + access codes -------------------
    if (path.startsWith('/crm/registration-')) {
      const reg = await tryLoad('crm-registration');
      if (path === '/crm/registration-requests' && method === 'GET') {
        reg ? await reg.listRequests(req, res) : notImpl(res, 'crm.registration.list'); return true;
      }
      const ar = path.match(/^\/crm\/registration-requests\/([0-9a-f-]{36})\/(approve|reject)$/i);
      if (ar && method === 'POST') {
        if (!reg) { notImpl(res, 'crm.registration.review'); return true; }
        ar[2] === 'approve' ? await reg.approveRequest(req, res, ar[1]) : await reg.rejectRequest(req, res, ar[1]);
        return true;
      }
      if (path === '/crm/registration-codes') {
        if (method === 'GET')  { reg ? await reg.listCodes(req, res)  : notImpl(res, 'crm.registration.codes'); return true; }
        if (method === 'POST') { reg ? await reg.createCode(req, res) : notImpl(res, 'crm.registration.code.create'); return true; }
      }
      const dc = path.match(/^\/crm\/registration-codes\/([0-9a-f-]{36})\/deactivate$/i);
      if (dc && method === 'POST') {
        reg ? await reg.deactivateCode(req, res, dc[1]) : notImpl(res, 'crm.registration.code.deactivate'); return true;
      }
    }
    {
      const acts = await tryLoad('crm-activities');
      if (path === '/crm/activities') {
        if (method === 'GET')  { acts ? await acts.list(req, res)   : notImpl(res, 'crm.activity.list');   return true; }
        if (method === 'POST') { acts ? await acts.create(req, res) : notImpl(res, 'crm.activity.create'); return true; }
      }
    }
    {
      const rev = await tryLoad('crm-revenue');
      if (path === '/crm/revenue-records') {
        if (method === 'GET')  { rev ? await rev.list(req, res)   : notImpl(res, 'crm.revenue.list');   return true; }
        if (method === 'POST') { rev ? await rev.create(req, res) : notImpl(res, 'crm.revenue.create'); return true; }
      }
      const m = path.match(/^\/crm\/revenue-records\/([0-9a-f-]{36})$/i);
      if (m && method === 'GET') {
        rev ? await rev.get(req, res, m[1]) : notImpl(res, 'crm.revenue.get');
        return true;
      }
      const mc = path.match(/^\/crm\/revenue-records\/by-client\/([0-9a-f-]{36})$/i);
      if (mc && method === 'GET') {
        rev ? await rev.listByClient(req, res, mc[1]) : notImpl(res, 'crm.revenue.byClient');
        return true;
      }
    }
    {
      const ven = await tryLoad('crm-vendors');
      if (path === '/crm/vendors') {
        if (method === 'GET')  { ven ? await ven.list(req, res)   : notImpl(res, 'crm.vendor.list');   return true; }
        if (method === 'POST') { ven ? await ven.create(req, res) : notImpl(res, 'crm.vendor.create'); return true; }
      }
      const m = path.match(/^\/crm\/vendors\/([0-9a-f-]{36})$/i);
      if (m) {
        if (method === 'GET') { ven ? await ven.get(req, res, m[1])    : notImpl(res, 'crm.vendor.get');    return true; }
        if (method === 'PUT') { ven ? await ven.update(req, res, m[1]) : notImpl(res, 'crm.vendor.update'); return true; }
      }
    }

    // -------- crm/map (Sprint 5A — EPIC-008 P-008 Phases 1-3) --------------
    {
      const map = await tryLoad('crm-map');
      if (path === '/crm/map/pins' && method === 'GET') {
        map ? await map.pins(req, res) : notImpl(res, 'crm.map.pins');
        return true;
      }
      const mv = path.match(/^\/crm\/map\/pins\/([0-9a-f-]{36})\/visit$/i);
      if (mv && method === 'POST') {
        map ? await map.visit(req, res, mv[1]) : notImpl(res, 'crm.map.visit');
        return true;
      }
    }

    // -------- crm/projects + crm/projects/:id/scenes (Sprint 14A) ----------
    {
      const projects = await tryLoad('crm-projects');
      const scenes   = await tryLoad('crm-scenes');
      // Project collection
      if (path === '/crm/projects') {
        if (method === 'GET')  { projects ? await projects.list(req, res)   : notImpl(res, 'crm.projects.list');   return true; }
        if (method === 'POST') { projects ? await projects.create(req, res) : notImpl(res, 'crm.projects.create'); return true; }
      }
      // Scans + detections under a project (P1/P2 scan spine).
      const mscan1 = path.match(/^\/crm\/projects\/([0-9a-f-]{36})\/scans\/([0-9a-f-]{36})$/i);
      if (mscan1 && method === 'GET') {
        const scans = await tryLoad('crm-scans');
        scans ? await scans.get(req, res, mscan1[1], mscan1[2]) : notImpl(res, 'crm.scans.get');
        return true;
      }
      const mscan = path.match(/^\/crm\/projects\/([0-9a-f-]{36})\/scans$/i);
      if (mscan) {
        const scans = await tryLoad('crm-scans');
        if (method === 'GET')  { scans ? await scans.list(req, res, mscan[1])   : notImpl(res, 'crm.scans.list');   return true; }
        if (method === 'POST') { scans ? await scans.create(req, res, mscan[1]) : notImpl(res, 'crm.scans.create'); return true; }
      }
      const mdet = path.match(/^\/crm\/projects\/([0-9a-f-]{36})\/detections$/i);
      if (mdet && method === 'GET') {
        const scans = await tryLoad('crm-scans');
        scans ? await scans.listDetections(req, res, mdet[1]) : notImpl(res, 'crm.detections.list');
        return true;
      }
      // Field verification post-back against a detection (P5).
      const mfr = path.match(/^\/crm\/detections\/([0-9a-f-]{36})\/field-results$/i);
      if (mfr) {
        const fr = await tryLoad('crm-field-results');
        if (method === 'GET')  { fr ? await fr.list(req, res, mfr[1])   : notImpl(res, 'crm.field_results.list');   return true; }
        if (method === 'POST') { fr ? await fr.create(req, res, mfr[1]) : notImpl(res, 'crm.field_results.create'); return true; }
      }
      // Scene set-default — must match BEFORE the generic scene id pattern.
      const msd = path.match(/^\/crm\/projects\/([0-9a-f-]{36})\/scenes\/([0-9a-f-]{36})\/set-default$/i);
      if (msd && method === 'POST') {
        scenes ? await scenes.setDefault(req, res, msd[1], msd[2]) : notImpl(res, 'crm.scenes.setDefault');
        return true;
      }
      // Scene by id under project
      const msi = path.match(/^\/crm\/projects\/([0-9a-f-]{36})\/scenes\/([0-9a-f-]{36})$/i);
      if (msi) {
        if (method === 'GET')    { scenes ? await scenes.get(req, res, msi[1], msi[2])    : notImpl(res, 'crm.scenes.get');    return true; }
        if (method === 'PUT')    { scenes ? await scenes.update(req, res, msi[1], msi[2]) : notImpl(res, 'crm.scenes.update'); return true; }
        if (method === 'DELETE') { scenes ? await scenes.remove(req, res, msi[1], msi[2]) : notImpl(res, 'crm.scenes.remove'); return true; }
      }
      // Scene collection under project
      const msc = path.match(/^\/crm\/projects\/([0-9a-f-]{36})\/scenes$/i);
      if (msc) {
        if (method === 'GET')  { scenes ? await scenes.list(req, res, msc[1])   : notImpl(res, 'crm.scenes.list');   return true; }
        if (method === 'POST') { scenes ? await scenes.create(req, res, msc[1]) : notImpl(res, 'crm.scenes.create'); return true; }
      }
      // Project by id
      const mp = path.match(/^\/crm\/projects\/([0-9a-f-]{36})$/i);
      if (mp) {
        if (method === 'GET')    { projects ? await projects.get(req, res, mp[1])    : notImpl(res, 'crm.projects.get');    return true; }
        if (method === 'PUT')    { projects ? await projects.update(req, res, mp[1]) : notImpl(res, 'crm.projects.update'); return true; }
        if (method === 'DELETE') { projects ? await projects.remove(req, res, mp[1]) : notImpl(res, 'crm.projects.remove'); return true; }
      }
    }

    // -------- customer/me/projects (Sprint 14A — customer self-service) ----
    // Customer-bound projection. requireAuth has already run and req.user is
    // set; the underlying tenant comes from req.tenant (resolved from header
    // OR token). Granular perms enforced inside each handler.
    {
      const cust = await tryLoad('customer-projects');
      if (path === '/customer/me/projects' && method === 'GET') {
        cust ? await cust.listMyProjects(req, res) : notImpl(res, 'customer.projects.list');
        return true;
      }
      const mp = path.match(/^\/customer\/me\/projects\/([0-9a-f-]{36})$/i);
      if (mp && method === 'GET') {
        cust ? await cust.getMyProject(req, res, mp[1]) : notImpl(res, 'customer.projects.get');
        return true;
      }
      const ms = path.match(/^\/customer\/me\/projects\/([0-9a-f-]{36})\/scenes$/i);
      if (ms && method === 'GET') {
        cust ? await cust.listMyProjectScenes(req, res, ms[1]) : notImpl(res, 'customer.projects.scenes');
        return true;
      }
    }

    // -------- ops/investigation-types (catalog) ----------------------------
    if (path === '/ops/investigation-types' && method === 'GET') {
      const inv = await tryLoad('investigations');
      inv ? await inv.listTypes(req, res) : notImpl(res, 'investigations.listTypes');
      return true;
    }

    // -------- ops/cases ----------------------------------------------------
    {
      const cases = await tryLoad('cases');
      if (path === '/ops/cases') {
        if (method === 'GET')  { cases ? await cases.list(req, res)   : notImpl(res, 'cases.list');   return true; }
        if (method === 'POST') { cases ? await cases.create(req, res) : notImpl(res, 'cases.create'); return true; }
      }
      if (path === '/ops/cases/from-detection' && method === 'POST') {
        cases ? await cases.fromDetection(req, res) : notImpl(res, 'cases.fromDetection');
        return true;
      }
      const m = path.match(/^\/ops\/cases\/([0-9a-f-]{36})(\/[a-z-]+)?$/i);
      if (m) {
        const id = m[1]; const sub = m[2];
        if (!sub) {
          if (method === 'GET') { cases ? await cases.get(req, res, id)    : notImpl(res, 'cases.get');    return true; }
          if (method === 'PUT') { cases ? await cases.update(req, res, id) : notImpl(res, 'cases.update'); return true; }
        }
        if (sub === '/assign'      && method === 'POST') { cases ? await cases.assign(req, res, id)       : notImpl(res, 'cases.assign');      return true; }
        if (sub === '/activity'    && method === 'POST') { cases ? await cases.activity(req, res, id)     : notImpl(res, 'cases.activity');    return true; }
        if (sub === '/attachments' && method === 'POST') { cases ? await cases.attachments(req, res, id)  : notImpl(res, 'cases.attachments'); return true; }
        // Investigation Typing + Evidence + Timeline sub-resources.
        if (sub === '/investigation' && method === 'PATCH') { const inv = await tryLoad('investigations'); inv ? await inv.patchInvestigation(req, res, id) : notImpl(res, 'investigations.patch');         return true; }
        if (sub === '/evidence'      && method === 'GET')   { const inv = await tryLoad('investigations'); inv ? await inv.listEvidence(req, res, id)       : notImpl(res, 'investigations.evidence.list');  return true; }
        if (sub === '/evidence'      && method === 'POST')  { const inv = await tryLoad('investigations'); inv ? await inv.createEvidence(req, res, id)     : notImpl(res, 'investigations.evidence.create');return true; }
        if (sub === '/timeline'      && method === 'GET')   { const inv = await tryLoad('investigations'); inv ? await inv.listTimeline(req, res, id)       : notImpl(res, 'investigations.timeline.list');  return true; }
        if (sub === '/timeline'      && method === 'POST')  { const inv = await tryLoad('investigations'); inv ? await inv.createTimeline(req, res, id)     : notImpl(res, 'investigations.timeline.create');return true; }
      }
    }

    // -------- reports (Sprint ③ — Reporting engine) ------------------------
    // GET  /reports            list generated reports (?type= filter)
    // POST /reports/:type      generate exec|investigation|field|sales report
    // GET  /reports/:id        fetch a generated report (full payload)
    {
      if (path === '/reports' && method === 'GET') {
        const reports = await tryLoad('reports');
        reports ? await reports.list(req, res) : notImpl(res, 'reports.list');
        return true;
      }
      const rid = path.match(/^\/reports\/([0-9a-f-]{36})$/i);
      if (rid && method === 'GET') {
        const reports = await tryLoad('reports');
        reports ? await reports.get(req, res, rid[1]) : notImpl(res, 'reports.get');
        return true;
      }
      const rtype = path.match(/^\/reports\/([a-z]+)$/i);
      if (rtype && method === 'POST') {
        const reports = await tryLoad('reports');
        reports ? await reports.generate(req, res, rtype[1].toLowerCase()) : notImpl(res, 'reports.generate');
        return true;
      }
    }

    // -------- org/rollup (Sprint A5.2 — ADR-0024 oversight) ----------------
    // The State sees the FOREST, never the trees. Both endpoints gate on the
    // org claim + org.rollup.view (enforced inside the handlers); org-less
    // callers are refused (403). The read reads ONLY analytics.org_rollup.
    //   POST /org/rollup/refresh   publish/refresh the caller's org roll-up
    //   GET  /org/rollup           read the caller's org roll-up (aggregates)
    {
      if (path === '/org/rollup/refresh' && method === 'POST') {
        const orgRollup = await tryLoad('org-rollup');
        orgRollup ? await orgRollup.refresh(req, res) : notImpl(res, 'org.rollup.refresh');
        return true;
      }
      if (path === '/org/rollup' && method === 'GET') {
        const orgRollup = await tryLoad('org-rollup');
        orgRollup ? await orgRollup.readRollup(req, res) : notImpl(res, 'org.rollup.read');
        return true;
      }
    }

    // -------- org/drilldown (Sprint A5.3 — ADR-0024 entitled drill-down) ----
    // Entitled, RLS-scoped, AUDITED cross-district raw-row reads. Gated by the
    // org claim + org.drilldown (read) / state.admin (grant management).
    //   GET  /org/drilldown?resource=&district=   read entitled districts
    //   POST /org/scope-grants                     grant a user drill access
    //   GET  /org/scope-grants                     list grants
    {
      if (path === '/org/drilldown' && method === 'GET') {
        const dd = await tryLoad('org-drilldown');
        dd ? await dd.drilldown(req, res) : notImpl(res, 'org.drilldown.read');
        return true;
      }
      if (path === '/org/scope-grants' && method === 'POST') {
        const dd = await tryLoad('org-drilldown');
        dd ? await dd.createGrant(req, res) : notImpl(res, 'org.scope_grant.create');
        return true;
      }
      if (path === '/org/scope-grants' && method === 'GET') {
        const dd = await tryLoad('org-drilldown');
        dd ? await dd.listGrants(req, res) : notImpl(res, 'org.scope_grant.list');
        return true;
      }
    }

    // -------- gis ----------------------------------------------------------
    // Customers can upload, list, view, edit, and delete their own layers.
    // Ops/sales/admin can do the same for any tenant they belong to.
    {
      const gis = await tryLoad('gis');
      if (path === '/gis/layers' && method === 'POST') {
        gis ? await gis.upload(req, res) : notImpl(res, 'gis.upload'); return true;
      }
      if (/^\/gis\/layers(\?.*)?$/.test(path) && method === 'GET') {
        gis ? await gis.list(req, res) : notImpl(res, 'gis.list'); return true;
      }
      const single = path.match(/^\/gis\/layers\/([0-9a-f-]{36})$/i);
      if (single) {
        if (method === 'GET')    { gis ? await gis.getOne(req, res, single[1]) : notImpl(res, 'gis.getOne'); return true; }
        if (method === 'PATCH')  { gis ? await gis.patch (req, res, single[1]) : notImpl(res, 'gis.patch');  return true; }
        if (method === 'DELETE') { gis ? await gis.remove(req, res, single[1]) : notImpl(res, 'gis.remove'); return true; }
      }
      const feat = path.match(/^\/gis\/layers\/([0-9a-f-]{36})\/features$/i);
      if (feat && method === 'GET') { gis ? await gis.features(req, res, feat[1]) : notImpl(res, 'gis.features'); return true; }
      const dl = path.match(/^\/gis\/layers\/([0-9a-f-]{36})\/download$/i);
      if (dl   && method === 'GET') { gis ? await gis.download(req, res, dl[1])   : notImpl(res, 'gis.download'); return true; }
    }

    // -------- analytics ----------------------------------------------------
    {
      const analytics = await tryLoad('analytics');
      if (path === '/analytics/dashboard/metrics' && method === 'GET') { analytics ? await analytics.dashboardMetrics(req, res) : notImpl(res, 'analytics.dashboardMetrics'); return true; }
      if (path === '/analytics/stats'             && method === 'GET') { analytics ? await analytics.stats(req, res)            : notImpl(res, 'analytics.stats');            return true; }
      const m = path.match(/^\/analytics\/income\/(week|month|quarter|year)$/i);
      if (m && method === 'GET') { analytics ? await analytics.income(req, res, m[1]) : notImpl(res, 'analytics.income'); return true; }
      // Sprint 2B — new period-aware endpoints.
      if (path.startsWith('/analytics/lead-sources')    && method === 'GET') { analytics ? await analytics.leadSources(req, res)    : notImpl(res, 'analytics.leadSources');    return true; }
      if (path.startsWith('/analytics/billing-streams') && method === 'GET') { analytics ? await analytics.billingStreams(req, res) : notImpl(res, 'analytics.billingStreams'); return true; }
      if (path.startsWith('/analytics/conversion')      && method === 'GET') { analytics ? await analytics.conversion(req, res)     : notImpl(res, 'analytics.conversion');     return true; }
    }

    // -------- billing/streams (Sprint 2B) ----------------------------------
    {
      const streams = await tryLoad('billing-streams');
      if (path === '/billing/streams') {
        if (method === 'GET')  { streams ? await streams.list(req, res)   : notImpl(res, 'billing.streams.list');   return true; }
        if (method === 'POST') { streams ? await streams.create(req, res) : notImpl(res, 'billing.streams.create'); return true; }
      }
      const m = path.match(/^\/billing\/streams\/([0-9a-f-]{36})$/i);
      if (m) {
        if (method === 'GET') { streams ? await streams.getOne(req, res, m[1]) : notImpl(res, 'billing.streams.get');    return true; }
        if (method === 'PUT') { streams ? await streams.update(req, res, m[1]) : notImpl(res, 'billing.streams.update'); return true; }
      }
    }

    // -------- chat (Sprint 3A — EPIC-005 P-004 Phase 1) --------------------
    {
      const convs = await tryLoad('chat-conversations');
      if (path === '/chat/conversations') {
        if (method === 'GET')  { convs ? await convs.list(req, res)   : notImpl(res, 'chat.conversations.list');   return true; }
        if (method === 'POST') { convs ? await convs.create(req, res) : notImpl(res, 'chat.conversations.create'); return true; }
      }
      const m = path.match(/^\/chat\/conversations\/([0-9a-f-]{36})$/i);
      if (m) {
        if (method === 'GET') { convs ? await convs.get(req, res, m[1])    : notImpl(res, 'chat.conversations.get');    return true; }
        if (method === 'PUT') { convs ? await convs.update(req, res, m[1]) : notImpl(res, 'chat.conversations.update'); return true; }
      }

      // Members
      const members = await tryLoad('chat-members');
      const mm = path.match(/^\/chat\/conversations\/([0-9a-f-]{36})\/members$/i);
      if (mm) {
        if (method === 'GET')  { members ? await members.list(req, res, mm[1]) : notImpl(res, 'chat.members.list'); return true; }
        if (method === 'POST') { members ? await members.add(req, res, mm[1])  : notImpl(res, 'chat.members.add');  return true; }
      }
      const mmd = path.match(/^\/chat\/conversations\/([0-9a-f-]{36})\/members\/([0-9a-f-]{36})$/i);
      if (mmd && method === 'DELETE') {
        members ? await members.remove(req, res, mmd[1], mmd[2]) : notImpl(res, 'chat.members.remove');
        return true;
      }

      // Messages
      const msgs = await tryLoad('chat-messages');
      const msgList = path.match(/^\/chat\/conversations\/([0-9a-f-]{36})\/messages$/i);
      if (msgList) {
        if (method === 'GET')  { msgs ? await msgs.listForConversation(req, res, msgList[1])   : notImpl(res, 'chat.messages.list');   return true; }
        if (method === 'POST') { msgs ? await msgs.createForConversation(req, res, msgList[1]) : notImpl(res, 'chat.messages.create'); return true; }
      }
      const msgRead = path.match(/^\/chat\/conversations\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/read$/i);
      if (msgRead && method === 'POST') {
        msgs ? await msgs.markRead(req, res, msgRead[1], msgRead[2]) : notImpl(res, 'chat.messages.markRead');
        return true;
      }
    }

    // -------- field/* (Sprint 9A — Field Service Management) --------------
    // Umbrella prefix gate — any field.* permission grants entry; granular
    // requirePermission gates fire inside each handler.
    if (path.startsWith('/field/')) {
      if (!hasAnyPerm(req,
        'field.job.read','field.job.write','field.job.assign','field.job.lifecycle',
        'field.location.write','field.location.read.tenant',
        'field.checkin','field.upload.write','field.upload.read',
        'field.task.complete','field.task.manage','field.geofence.read',
        'crm.chat.read','crm.chat.write',
      )) {
        if (!requireAnyRole(req, res, 'sales:manage','ops:manage')) return true;
      }
    }
    // /field/jobs + /field/jobs/:id
    {
      const jobs = await tryLoad('field-jobs');
      if (path === '/field/jobs') {
        if (method === 'GET')  { jobs ? await jobs.list(req, res)   : notImpl(res, 'field.jobs.list');   return true; }
        if (method === 'POST') { jobs ? await jobs.create(req, res) : notImpl(res, 'field.jobs.create'); return true; }
      }
      const m = path.match(/^\/field\/jobs\/([0-9a-f-]{36})$/i);
      if (m) {
        if (method === 'GET') { jobs ? await jobs.get(req, res, m[1])    : notImpl(res, 'field.jobs.get');    return true; }
        if (method === 'PUT') { jobs ? await jobs.update(req, res, m[1]) : notImpl(res, 'field.jobs.update'); return true; }
      }
    }
    // /field/location  (POST own position)
    if (path === '/field/location' && method === 'POST') {
      const loc = await tryLoad('field-location');
      loc ? await loc.postPosition(req, res) : notImpl(res, 'field.location.post');
      return true;
    }
    // /field/technicians/positions  (manager list)
    if (path === '/field/technicians/positions' && method === 'GET') {
      const loc = await tryLoad('field-location');
      loc ? await loc.listPositions(req, res) : notImpl(res, 'field.technicians.positions');
      return true;
    }
    // /field/time/active — caller's open time entry (on-shift detection).
    if (path === '/field/time/active' && method === 'GET') {
      const ci = await tryLoad('field-checkin');
      ci ? await ci.activeTime(req, res) : notImpl(res, 'field.time.active');
      return true;
    }
    // /field/jobs/:id/check-in + /check-out
    {
      const ci = await tryLoad('field-checkin');
      const m = path.match(/^\/field\/jobs\/([0-9a-f-]{36})\/check-(in|out)$/i);
      if (m && method === 'POST') {
        if (m[2].toLowerCase() === 'in')  { ci ? await ci.checkIn(req, res, m[1])  : notImpl(res, 'field.checkin');  return true; }
        if (m[2].toLowerCase() === 'out') { ci ? await ci.checkOut(req, res, m[1]) : notImpl(res, 'field.checkout'); return true; }
      }
      // S17 — pause / resume lifecycle legs (reuse the check-in module).
      const lc = path.match(/^\/field\/jobs\/([0-9a-f-]{36})\/(pause|resume)$/i);
      if (lc && method === 'POST') {
        if (lc[2].toLowerCase() === 'pause')  { ci ? await ci.pause(req, res, lc[1])  : notImpl(res, 'field.job.pause');  return true; }
        if (lc[2].toLowerCase() === 'resume') { ci ? await ci.resume(req, res, lc[1]) : notImpl(res, 'field.job.resume'); return true; }
      }
    }
    // S17 — /field/jobs/:id/notes
    {
      const nt = await tryLoad('field-notes');
      const m = path.match(/^\/field\/jobs\/([0-9a-f-]{36})\/notes$/i);
      if (m) {
        if (method === 'GET')  { nt ? await nt.listNotes(req, res, m[1])  : notImpl(res, 'field.notes.list');   return true; }
        if (method === 'POST') { nt ? await nt.createNote(req, res, m[1]) : notImpl(res, 'field.notes.create'); return true; }
      }
    }
    // S17 — /field/jobs/:id/conversation (per-job thread bootstrap)
    {
      const cv = await tryLoad('field-conversation');
      const m = path.match(/^\/field\/jobs\/([0-9a-f-]{36})\/conversation$/i);
      if (m && method === 'POST') {
        cv ? await cv.jobConversation(req, res, m[1]) : notImpl(res, 'field.job.conversation');
        return true;
      }
      // /field/ops-channel (tenant-wide ops channel get-or-create)
      if (path === '/field/ops-channel' && method === 'GET') {
        cv ? await cv.opsChannel(req, res) : notImpl(res, 'field.ops_channel');
        return true;
      }
    }
    // /field/jobs/:id/uploads
    {
      const ups = await tryLoad('field-uploads');
      const m = path.match(/^\/field\/jobs\/([0-9a-f-]{36})\/uploads$/i);
      if (m) {
        if (method === 'POST') { ups ? await ups.createUpload(req, res, m[1]) : notImpl(res, 'field.uploads.create'); return true; }
        if (method === 'GET')  { ups ? await ups.listForJob(req, res, m[1])   : notImpl(res, 'field.uploads.list');   return true; }
      }
      const ms = path.match(/^\/field\/uploads\/([0-9a-f-]{36})\/signed$/i);
      if (ms && method === 'GET') {
        ups ? await ups.signedUrl(req, res, ms[1]) : notImpl(res, 'field.uploads.signed');
        return true;
      }
    }
    // /field/jobs/:id/tasks + /tasks/:tid + /tasks/:tid/complete
    {
      const tk = await tryLoad('field-tasks');
      const mc = path.match(/^\/field\/jobs\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})\/complete$/i);
      if (mc && method === 'POST') {
        tk ? await tk.completeTask(req, res, mc[1], mc[2]) : notImpl(res, 'field.tasks.complete');
        return true;
      }
      const md = path.match(/^\/field\/jobs\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})$/i);
      if (md && method === 'DELETE') {
        tk ? await tk.removeTask(req, res, md[1], md[2]) : notImpl(res, 'field.tasks.remove');
        return true;
      }
      const mn = path.match(/^\/field\/jobs\/([0-9a-f-]{36})\/tasks$/i);
      if (mn && method === 'POST') {
        tk ? await tk.createTask(req, res, mn[1]) : notImpl(res, 'field.tasks.create');
        return true;
      }
    }

    // -------- farm/* — Report.Farm vertical (Wave-2 Lane 2) ------------------
    // FarmProfile/parcel/zone CRUD, observations, alerts, buyer-portfolio
    // rollups, and report generation over the farm.* schema. Every handler is
    // tenant-scoped + permission-gated inside its module (farm/gate.mjs).
    if (path.startsWith('/farm/')) {
      // --- /farm/gw/* — AlphaGeo gateway relay (twins, signals, scan, jobs, SSE) ---
      if (path.startsWith('/farm/gw/')) {
        const gw = await tryLoad('farm-gateway');
        const mTwin = path.match(/^\/farm\/gw\/twins\/([^/]+)$/);
        if (mTwin && method === 'GET') {
          gw ? await gw.twins(req, res, decodeURIComponent(mTwin[1])) : notImpl(res, 'farm.gw.twins');
          return true;
        }
        if (path === '/farm/gw/signals-by-bbox' && method === 'GET') {
          gw ? await gw.signalsByBbox(req, res, url) : notImpl(res, 'farm.gw.signals');
          return true;
        }
        if (path === '/farm/gw/parcel' && method === 'GET') {
          gw ? await gw.parcel(req, res, url) : notImpl(res, 'farm.gw.parcel');
          return true;
        }
        if (path === '/farm/gw/parcel-by-address' && method === 'GET') {
          gw ? await gw.parcelByAddress(req, res, url) : notImpl(res, 'farm.gw.parcelByAddress');
          return true;
        }
        if (path === '/farm/gw/aoi/from-geom' && method === 'POST') {
          gw ? await gw.aoiFromGeom(req, res) : notImpl(res, 'farm.gw.aoiFromGeom');
          return true;
        }
        if (path === '/farm/gw/vision/segment' && method === 'POST') {
          gw ? await gw.visionSegment(req, res) : notImpl(res, 'farm.gw.visionSegment');
          return true;
        }
        if (path === '/farm/gw/vision/segment/refine' && method === 'POST') {
          gw ? await gw.visionRefine(req, res) : notImpl(res, 'farm.gw.visionRefine');
          return true;
        }
        if (path === '/farm/gw/vision/delineate' && method === 'POST') {
          gw ? await gw.visionDelineate(req, res) : notImpl(res, 'farm.gw.visionDelineate');
          return true;
        }
        if (path === '/farm/gw/scan' && method === 'POST') {
          gw ? await gw.scan(req, res) : notImpl(res, 'farm.gw.scan');
          return true;
        }
        const mEvents = path.match(/^\/farm\/gw\/jobs\/([^/]+)\/events$/);
        if (mEvents && method === 'GET') {
          gw ? await gw.jobEvents(req, res, decodeURIComponent(mEvents[1])) : notImpl(res, 'farm.gw.jobEvents');
          return true;
        }
        const mJob = path.match(/^\/farm\/gw\/jobs\/([^/]+)$/);
        if (mJob && method === 'GET') {
          gw ? await gw.job(req, res, decodeURIComponent(mJob[1])) : notImpl(res, 'farm.gw.job');
          return true;
        }
      }

      // /farm/farms  and  /farm/farms/:id (+ /parcels, /zones)
      const farms = await tryLoad('farm-farms');
      if (path === '/farm/farms') {
        if (method === 'GET')  { farms ? await farms.list(req, res)   : notImpl(res, 'farm.farms.list');   return true; }
        if (method === 'POST') { farms ? await farms.create(req, res) : notImpl(res, 'farm.farms.create'); return true; }
      }
      const mfSub = path.match(/^\/farm\/farms\/([0-9a-f-]{36})(\/parcels|\/zones)?$/i);
      if (mfSub) {
        const fid = mfSub[1]; const sub = mfSub[2];
        if (!sub) {
          if (method === 'GET')    { farms ? await farms.get(req, res, fid)    : notImpl(res, 'farm.farms.get');    return true; }
          if (method === 'PUT')    { farms ? await farms.update(req, res, fid) : notImpl(res, 'farm.farms.update'); return true; }
          if (method === 'DELETE') { farms ? await farms.remove(req, res, fid) : notImpl(res, 'farm.farms.remove'); return true; }
        } else if (sub === '/parcels') {
          if (method === 'GET')  { farms ? await farms.listParcels(req, res, fid)   : notImpl(res, 'farm.parcels.list');   return true; }
          if (method === 'POST') { farms ? await farms.createParcel(req, res, fid)  : notImpl(res, 'farm.parcels.create'); return true; }
        } else if (sub === '/zones') {
          if (method === 'GET')  { farms ? await farms.listZones(req, res, fid)  : notImpl(res, 'farm.zones.list');   return true; }
          if (method === 'POST') { farms ? await farms.createZone(req, res, fid) : notImpl(res, 'farm.zones.create'); return true; }
        }
      }

      // /farm/observations
      if (path === '/farm/observations' && method === 'GET') {
        const obs = await tryLoad('farm-observations');
        obs ? await obs.list(req, res) : notImpl(res, 'farm.observations.list');
        return true;
      }

      // /farm/alerts  and  /farm/alerts/:id/ack
      if (path === '/farm/alerts' && method === 'GET') {
        const al = await tryLoad('farm-alerts');
        al ? await al.list(req, res) : notImpl(res, 'farm.alerts.list');
        return true;
      }
      const mAck = path.match(/^\/farm\/alerts\/([0-9a-f-]{36})\/ack$/i);
      if (mAck && method === 'POST') {
        const al = await tryLoad('farm-alerts');
        al ? await al.ack(req, res, mAck[1]) : notImpl(res, 'farm.alerts.ack');
        return true;
      }

      // /farm/portfolio/{rollup,suppliers,regions}
      if (path.startsWith('/farm/portfolio/') && method === 'GET') {
        const pf = await tryLoad('farm-portfolio');
        if (path === '/farm/portfolio/rollup')    { pf ? await pf.rollup(req, res)    : notImpl(res, 'farm.portfolio.rollup');    return true; }
        if (path === '/farm/portfolio/suppliers') { pf ? await pf.suppliers(req, res) : notImpl(res, 'farm.portfolio.suppliers'); return true; }
        if (path === '/farm/portfolio/regions')   { pf ? await pf.regions(req, res)   : notImpl(res, 'farm.portfolio.regions');   return true; }
      }

      // /farm/reports  /farm/reports/generate  /farm/reports/:id
      if (path === '/farm/reports') {
        const rp = await tryLoad('farm-reports');
        if (method === 'GET') { rp ? await rp.list(req, res) : notImpl(res, 'farm.reports.list'); return true; }
      }
      if (path === '/farm/reports/generate' && method === 'POST') {
        const rp = await tryLoad('farm-reports');
        rp ? await rp.generate(req, res) : notImpl(res, 'farm.reports.generate');
        return true;
      }
      const mRep = path.match(/^\/farm\/reports\/([0-9a-f-]{36})$/i);
      if (mRep && method === 'GET') {
        const rp = await tryLoad('farm-reports');
        rp ? await rp.get(req, res, mRep[1]) : notImpl(res, 'farm.reports.get');
        return true;
      }
    }

    // -------- billing/* — Stripe subscriptions, invoices, account -----------
    // (the public /billing/webhook is handled earlier, pre-auth.)
    if (path.startsWith('/billing/')) {
      const subs = await import('./billing/subscriptions.mjs');
      if (path === '/billing/plans'        && method === 'GET')  { await subs.plans(req, res);     return true; }
      if (path === '/billing/subscription' && method === 'GET')  { await subs.current(req, res);   return true; }
      if (path === '/billing/invoices'     && method === 'GET')  { await subs.invoices(req, res);  return true; }
      if (path === '/billing/checkout'     && method === 'POST') { await subs.checkout(req, res);  return true; }
      if (path === '/billing/portal'       && method === 'POST') { await subs.portal(req, res);    return true; }
    }

    notFound(res);
    return true;
  } catch (err) {
    if (err?.message === 'payload_too_large') { send(res, 413, { success: false, error: 'payload_too_large' }); return true; }
    if (err?.message === 'invalid_json')      { send(res, 400, { success: false, error: 'invalid_json' });      return true; }
    serverErr(res, err);
    return true;
  }
}
