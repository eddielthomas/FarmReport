// =============================================================================
// asterra-client.mjs — minimal Node (global fetch) ASTERRA Recover API client.
// -----------------------------------------------------------------------------
// A faithful, dependency-free port of the Python transport + repository at
//   services/ingest-service/src/rwr_ingest/sources/asterra/{client,repository}.py
// covering exactly what the auto-ingest needs:
//   * login()           — POST credentials → bearer token pair, cached.
//   * listProjects()    — GET the ASTERRA projects visible to the account.
//   * iterPois(id)      — async-iterate every POI (leak polygon) for a project,
//                         following the API's page/limit/totalPages pagination.
//
// Auth flow (mirrors client.py):
//   POST  /recover-api/login    {userName, password} → {user, tokens:{accessToken, refreshToken, expiresIn}}
//   POST  /recover-api/refresh  Authorization: Bearer <refreshToken> → {tokens:{…}}
//   GET   /recover/v1/projects  ?includeArchived=false → [ {id, displayName, deliveryNames[]} ]
//   GET   /recover/v1/pois      ?projectIds=&limit=&page= → {data:[…], metadata:{limit,page,total,totalPages}}
// On a 401 from a protected GET we refresh once and retry (same as get_json).
//
// Credentials/base come from env so the whole feature is DORMANT until set:
//   ASTERRA_BASE_URL  (default https://recover-api.asterra.io/api)
//   ASTERRA_USERNAME
//   ASTERRA_PASSWORD
// asterraConfigured() is the single gate the scheduler checks.
//
// NOTE on endpoint paths: these are transcribed verbatim from the Python source
// (client.py uses '/recover-api/login' + '/recover-api/refresh'; repository.py
// uses '/recover/v1/projects' + '/recover/v1/pois'), appended to the base URL
// 'https://recover-api.asterra.io/api'. If the live deployment differs, the
// only knobs to adjust are these four path constants + ASTERRA_BASE_URL.
// =============================================================================

const BASE_URL = (process.env.ASTERRA_BASE_URL || 'https://recover-api.asterra.io/api').replace(/\/+$/, '');
const USERNAME = process.env.ASTERRA_USERNAME || '';
const PASSWORD = process.env.ASTERRA_PASSWORD || '';

const PATHS = {
  login:    '/recover-api/login',
  refresh:  '/recover-api/refresh',
  projects: '/recover/v1/projects',
  pois:     '/recover/v1/pois',
};

const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1000;
const EXPIRY_SKEW_S = 300;          // refresh this many seconds before stated expiry
const REQUEST_TIMEOUT_MS = 20_000;

// ---- typed errors (mirrors the Python hierarchy) ---------------------------
export class AsterraError extends Error {}
export class AsterraAuthError extends AsterraError {}
export class AsterraRateLimitError extends AsterraError {
  constructor(message, resetAt = null) { super(message); this.resetAt = resetAt; }
}

// True only when both credentials are present. The scheduler stays a no-op
// until an operator sets ASTERRA_USERNAME + ASTERRA_PASSWORD.
export function asterraConfigured() {
  return Boolean(USERNAME && PASSWORD);
}

async function fetchWithTimeout(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

export class AsterraClient {
  constructor({ baseUrl = BASE_URL, username = USERNAME, password = PASSWORD } = {}) {
    this._base = baseUrl.replace(/\/+$/, '');
    this._username = username;
    this._password = password;
    this._tokens = null;          // { accessToken, refreshToken, expiresIn }
    this._expiresAt = 0;          // epoch ms
  }

  _url(path) { return `${this._base}${path}`; }

  // POST credentials → token pair. Throws AsterraAuthError on non-2xx.
  async login() {
    if (!this._username || !this._password) {
      throw new AsterraAuthError('asterra credentials not configured');
    }
    let resp;
    try {
      resp = await fetchWithTimeout(this._url(PATHS.login), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ userName: this._username, password: this._password }),
      });
    } catch (e) {
      throw new AsterraAuthError(`login request failed: ${e?.message ?? e}`);
    }
    if (resp.status >= 400) {
      const body = await resp.text().catch(() => '');
      throw new AsterraAuthError(`login failed status=${resp.status} body=${body.slice(0, 200)}`);
    }
    const json = await resp.json();
    this._setTokens(json?.tokens);
    return this._tokens;
  }

  // Refresh using the cached refresh token; falls back to full login on failure.
  async _refresh() {
    if (!this._tokens?.refreshToken) { await this.login(); return; }
    let resp;
    try {
      resp = await fetchWithTimeout(this._url(PATHS.refresh), {
        method: 'POST',
        headers: { authorization: `Bearer ${this._tokens.refreshToken}`, accept: 'application/json' },
      });
    } catch {
      await this.login();
      return;
    }
    if (resp.status >= 400) { await this.login(); return; }
    const json = await resp.json();
    this._setTokens(json?.tokens);
  }

  _setTokens(tokens) {
    if (!tokens?.accessToken) throw new AsterraAuthError('login response missing accessToken');
    this._tokens = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: Number(tokens.expiresIn) || 0,
    };
    const ttl = this._tokens.expiresIn > 0 ? this._tokens.expiresIn : 3600;
    this._expiresAt = Date.now() + ttl * 1000;
  }

  async _ensureToken() {
    if (!this._tokens) { await this.login(); }
    else if (Date.now() >= this._expiresAt - EXPIRY_SKEW_S * 1000) { await this._refresh(); }
    return this._tokens.accessToken;
  }

  // Authenticated GET → parsed JSON. One 401 retry after a forced refresh.
  async _getJson(path, params = null, { maxRetries = 1 } = {}) {
    let attempt = 0;
    const qs = params
      ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
      : '';
    for (;;) {
      const token = await this._ensureToken();
      let resp;
      try {
        resp = await fetchWithTimeout(this._url(path) + qs, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        });
      } catch (e) {
        throw new AsterraError(`GET ${path} request failed: ${e?.message ?? e}`);
      }
      if (resp.status === 401 && attempt < maxRetries) { await this._refresh(); attempt++; continue; }
      if (resp.status === 429) {
        const raw = resp.headers.get('x-ratelimit-reset');
        const resetAt = raw ? new Date(Number(raw) * 1000) : null;
        throw new AsterraRateLimitError(`rate-limited on ${path}`, resetAt);
      }
      if (resp.status >= 400) {
        const body = await resp.text().catch(() => '');
        throw new AsterraError(`GET ${path} failed status=${resp.status} body=${body.slice(0, 200)}`);
      }
      return resp.json();
    }
  }

  // List ASTERRA projects visible to the account.
  async listProjects({ includeArchived = false } = {}) {
    const raw = await this._getJson(PATHS.projects, { includeArchived: String(includeArchived) });
    return Array.isArray(raw) ? raw : [];
  }

  // Async-iterate every POI for a project, following page/limit/totalPages.
  async *iterPois(projectId, { pageSize = DEFAULT_PAGE_SIZE } = {}) {
    if (projectId === undefined || projectId === null || projectId === '') {
      throw new AsterraError('projectId is required for iterPois');
    }
    const limit = Math.max(1, Math.min(Number(pageSize) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
    let page = 1;
    for (;;) {
      const raw = await this._getJson(PATHS.pois, {
        projectIds: String(projectId),
        limit,
        page,
      });
      const data = Array.isArray(raw?.data) ? raw.data : [];
      for (const item of data) yield item;
      const totalPages = Number(raw?.metadata?.totalPages) || 0;
      if (data.length === 0 || page >= totalPages) break;
      page++;
    }
  }
}
