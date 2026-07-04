/* =============================================================================
 * role-gate.js — Sprint 12 client-side surface allow-list (UX only).
 * -----------------------------------------------------------------------------
 * THIS IS NOT AUTHORIZATION. The server-side `requirePermission` middleware
 * on every /api/v1 route is the actual security boundary. This script just
 * prevents users from staring at a surface they cannot usefully interact
 * with — and from seeing a flash-of-unauthorized-content before the React
 * bundle loads and redirects them.
 *
 * Each authenticated HTML entry must reference this file as a SYNCHRONOUS
 * <script src="/role-gate.js" data-surface="dashboard.html"></script> placed
 * BEFORE any <style> block or <body>, so the redirect happens before paint.
 *
 * Behaviour:
 *   1. Read the surface attribute off the <script data-surface="…"> tag.
 *   2. Read `rwr.auth` from localStorage (zustand persist envelope).
 *   3. If no token:
 *        - on login.html → no-op (let the login UI render)
 *        - elsewhere    → redirect to /login.html?next=/<surface>
 *   4. If token but the surface is NOT in the user's allow-list:
 *        - on login.html → redirect to /<primarySurface>
 *        - elsewhere    → redirect to /<primarySurface>
 *
 * Sprint A2: the routing maps are now PACK-DRIVEN. A build-time generated
 * script (`/role-gate-pack.js`, written by scripts/gen-role-pack.mjs from the
 * ACTIVE vertical's YAML) sets `window.__RWR_ROLE_PACK` SYNCHRONOUSLY before
 * this file runs. We read it synchronously — NO async fetch — so pre-paint
 * gating is preserved. If the global is missing (generated file absent), we
 * fall back to the hardcoded RWR map below so a surface is NEVER left ungated.
 *
 * The allow-list and primarySurface logic here MUST stay in sync with
 * mvp/src/crm/lib/auth-store.ts. Both now derive from the SAME generated pack
 * (single source of truth). The qa-s12-roles.mjs harness parses this file via
 * fs.readFile and compares the canonical decisions cell-by-cell.
 * ===========================================================================*/
(function rwrRoleGate() {
  try {
    var script = document.currentScript;
    var surface = (script && script.getAttribute('data-surface')) || '';
    if (!surface) return; // misconfigured; fail open (server-side authz still applies).

    // --- 1) read persisted auth envelope ---------------------------------
    var raw = null;
    try { raw = window.localStorage.getItem('rwr.auth'); } catch (_e) {}
    var token = null;
    var roles = [];
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        var state = parsed && parsed.state ? parsed.state : parsed;
        token = state && state.token ? state.token : null;
        roles = (state && state.user && Array.isArray(state.user.roles)) ? state.user.roles : [];
      } catch (_e) { token = null; roles = []; }
    }

    var ALL_SURFACES = ['tenants.html','staff.html','sales.html','pm.html','analytics.html',
                        'operations.html','customer.html','vendor.html','field.html',
                        'dashboard.html','login.html'];

    // --- pack resolution: synchronous read of the build-injected global --
    // No fetch. If absent, PACK stays null and we use the hardcoded RWR funcs.
    var PACK = null;
    try {
      if (window.__RWR_ROLE_PACK
          && Array.isArray(window.__RWR_ROLE_PACK.primarySurfaceByRole)
          && Array.isArray(window.__RWR_ROLE_PACK.roleSurfaceAllowList)) {
        PACK = window.__RWR_ROLE_PACK;
      }
    } catch (_e) { PACK = null; }

    function roleMatches(key, rs) {
      if (key === '*admin') return rs.indexOf('platform:admin') >= 0;
      if (key === 'vendor:*') {
        for (var i = 0; i < rs.length; i++) {
          if (typeof rs[i] === 'string' && rs[i].indexOf('vendor:') === 0) return true;
        }
        return false;
      }
      return rs.indexOf(key) >= 0;
    }

    // --- 2) primarySurfaceForRoles ---------------------------------------
    // Pack-driven first-match (mirrors auth-store.ts); hardcoded RWR fallback.
    function primaryFromPack(rs) {
      if (rs.indexOf('platform:admin') >= 0) {
        for (var a = 0; a < PACK.primarySurfaceByRole.length; a++) {
          var ek = PACK.primarySurfaceByRole[a][0];
          if (ek === 'platform:admin' || ek === '*admin') return PACK.primarySurfaceByRole[a][1];
        }
        return 'tenants.html';
      }
      for (var i = 0; i < PACK.primarySurfaceByRole.length; i++) {
        var k = PACK.primarySurfaceByRole[i][0];
        if (k === 'platform:admin' || k === '*admin') continue;
        if (roleMatches(k, rs)) return PACK.primarySurfaceByRole[i][1];
      }
      return 'login.html';
    }
    function primaryFromHardcoded(rs) {
      if (rs.indexOf('platform:admin') >= 0) return 'tenants.html';
      for (var i = 0; i < rs.length; i++) {
        if (typeof rs[i] === 'string' && rs[i].indexOf('vendor:') === 0) return 'vendor.html';
      }
      if (rs.indexOf('ops.field_specialist') >= 0
       || rs.indexOf('field.technician') >= 0
       || rs.indexOf('field:technician') >= 0) return 'field.html';
      if (rs.indexOf('ops.coordinator') >= 0) return 'operations.html';
      if (rs.indexOf('ops:manage')      >= 0) return 'operations.html';
      if (rs.indexOf('sales:manage')    >= 0) return 'sales.html';
      if (rs.indexOf('analytics:view')  >= 0) return 'analytics.html';
      if (rs.indexOf('customer:view')   >= 0) return 'customer.html';
      if (rs.indexOf('dashboard:view')  >= 0) return 'dashboard.html';
      return 'login.html';
    }
    function primarySurfaceForRoles(rs) {
      return PACK ? primaryFromPack(rs) : primaryFromHardcoded(rs);
    }

    // --- 3) allowedSurfacesForRoles --------------------------------------
    // Pack-driven first-match (mirrors auth-store.ts); hardcoded RWR fallback.
    function allowedFromPack(rs) {
      if (rs.indexOf('platform:admin') >= 0) {
        var s = {}; for (var i = 0; i < ALL_SURFACES.length; i++) s[ALL_SURFACES[i]] = true; return s;
      }
      var allowed = { 'login.html': true };
      for (var j = 0; j < PACK.roleSurfaceAllowList.length; j++) {
        var key = PACK.roleSurfaceAllowList[j][0];
        if (key === '*admin') continue;
        if (roleMatches(key, rs)) {
          var surfaces = PACK.roleSurfaceAllowList[j][1] || [];
          for (var k = 0; k < surfaces.length; k++) allowed[surfaces[k]] = true;
          return allowed;
        }
      }
      return allowed;
    }
    function allowedFromHardcoded(rs) {
      var ALL = ALL_SURFACES;
      if (rs.indexOf('platform:admin') >= 0) {
        var s = {}; for (var i = 0; i < ALL.length; i++) s[ALL[i]] = true; return s;
      }
      var allowed = { 'login.html': true };
      for (var j = 0; j < rs.length; j++) {
        if (typeof rs[j] === 'string' && rs[j].indexOf('vendor:') === 0) {
          allowed['vendor.html'] = true; return allowed;
        }
      }
      var isFieldTier = rs.indexOf('field.technician') >= 0
                     || rs.indexOf('field:technician') >= 0
                     || rs.indexOf('ops.field_specialist') >= 0;
      if (isFieldTier) { allowed['field.html'] = true; return allowed; }
      if (rs.indexOf('ops.coordinator') >= 0 || rs.indexOf('ops:manage') >= 0) {
        allowed['operations.html'] = true;
        allowed['dashboard.html']  = true;
        allowed['pm.html']         = true;
        allowed['analytics.html']  = true;
        return allowed;
      }
      if (rs.indexOf('sales:manage') >= 0) {
        allowed['sales.html']     = true;
        allowed['analytics.html'] = true;
        return allowed;
      }
      if (rs.indexOf('analytics:view') >= 0) { allowed['analytics.html'] = true; return allowed; }
      if (rs.indexOf('customer:view')  >= 0) { allowed['customer.html']  = true; return allowed; }
      // dashboard:view alone is NOT a surface entitlement in S12 — falls
      // through to login.html-only.
      return allowed;
    }
    function allowedSurfacesForRoles(rs) {
      return PACK ? allowedFromPack(rs) : allowedFromHardcoded(rs);
    }

    // --- 4) decide --------------------------------------------------------
    var primary = primarySurfaceForRoles(roles);
    var allowMap = allowedSurfacesForRoles(roles);

    // login.html special-case: if already authed, bounce to primary.
    if (surface === 'login.html') {
      if (token) {
        // sanitize ?next= the same way Login.tsx does post-auth
        var next = null;
        try {
          var qs = new URLSearchParams(window.location.search);
          next = qs.get('next');
        } catch (_e) {}
        var safe = sanitizeNextPath(next);
        var target = (safe && allowMap[safe]) ? safe : primary;
        window.location.replace('/' + target);
      }
      return;
    }

    // All other surfaces: must have a token AND the surface must be allowed.
    if (!token) {
      window.location.replace('/login.html?next=' + encodeURIComponent('/' + surface));
      return;
    }
    if (!allowMap[surface]) {
      window.location.replace('/' + primary);
      return;
    }

    function sanitizeNextPath(n) {
      if (!n || typeof n !== 'string') return null;
      if (/^[a-z]+:/i.test(n))         return null;
      if (n.indexOf('//') === 0)       return null;
      var p = n.replace(/^\/+/, '');
      var qIdx = p.search(/[?#]/);
      if (qIdx >= 0) p = p.slice(0, qIdx);
      if (p.indexOf('..') >= 0)        return null;
      if (p.indexOf('\\') >= 0)        return null;
      if (p.indexOf('/') >= 0)         return null;
      if (!/\.html$/.test(p))          return null;
      return p;
    }
  } catch (_err) {
    // Fail open — if the gate throws, leave the user where they are. Server
    // authz still applies on every API call.
  }
})();
