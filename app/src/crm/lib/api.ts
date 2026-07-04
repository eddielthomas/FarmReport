import { useAuthStore } from './auth-store';
import { useTenantStore } from './tenant-store';
import type { ApiEnvelope } from './types';

const BASE = '/api/v1';

interface RequestOpts extends RequestInit {
  /** Send body as JSON (default true if body is a plain object). */
  json?: boolean;
  /** Set to true to skip the bearer-token header (used by /auth/dev-login). */
  skipAuth?: boolean;
  /** Set to true to skip the X-Tenant-Id header (used by /auth/* and /tenants). */
  skipTenant?: boolean;
}

export class ApiError extends Error {
  status: number;
  detail?: string;
  constructor(message: string, status: number, detail?: string) {
    super(message); this.status = status; this.detail = detail;
  }
}

export async function api<T = unknown>(path: string, opts: RequestOpts = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${BASE}${path.startsWith('/') ? path : '/' + path}`;
  const headers = new Headers(opts.headers ?? {});

  let body = opts.body as BodyInit | undefined;
  const isPlainObj = body !== undefined && body !== null && !(body instanceof FormData) && typeof body === 'object';
  if (isPlainObj && opts.json !== false) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(body);
  }

  if (!opts.skipAuth) {
    const token = useAuthStore.getState().token;
    if (token) headers.set('authorization', `Bearer ${token}`);
  }
  if (!opts.skipTenant) {
    const tenantId = useTenantStore.getState().currentTenantId;
    if (tenantId) headers.set('x-tenant-id', tenantId);
  }

  const res = await fetch(url, { ...opts, headers, body });
  let payload: ApiEnvelope<T> | null = null;
  try { payload = await res.json(); } catch { /* non-JSON */ }

  if (res.status === 401 && !opts.skipAuth) {
    // An expired/invalid SITE access pass is not a login problem — the JWT
    // session is still valid. Re-verify the passcode on /access.html and come
    // back; wiping the session here would log the user out every time the
    // 1-hour pass token lapses.
    if (payload && (payload as { error?: string }).error === 'access_gate_required') {
      redirectToAccessGate();
    } else {
      redirectToLogin();
    }
  }

  if (!res.ok || (payload && payload.success === false)) {
    throw new ApiError(
      payload?.error ?? `http_${res.status}`,
      res.status,
      payload?.detail,
    );
  }
  return (payload?.data ?? payload) as T;
}

// Access-gate 401: pass token expired — bounce to /access.html KEEPING the
// auth session, so after re-entering the passcode the user lands right back.
// Debounced like redirectToLogin.
let redirecting = false;
function redirectToAccessGate() {
  if (redirecting || typeof window === 'undefined') return;
  redirecting = true;
  const here = window.location.pathname + window.location.search;
  if (!window.location.pathname.endsWith('/access.html')) {
    window.location.replace(`/access.html?next=${encodeURIComponent(here)}`);
  }
}

// 401 handler: clear stale session and bounce to /login.html.
// Debounced so a burst of parallel queries triggers exactly one navigation.
function redirectToLogin() {
  if (redirecting || typeof window === 'undefined') return;
  redirecting = true;
  try {
    useAuthStore.getState().clear();
    useTenantStore.getState().clear();
  } catch { /* zustand not ready — fine, fall through */ }
  const here = window.location.pathname + window.location.search;
  const onLogin = window.location.pathname.endsWith('/login.html');
  if (!onLogin) {
    window.location.replace(`/login.html?next=${encodeURIComponent(here)}`);
  }
}

export const apiGet  = <T>(path: string)            => api<T>(path);
export const apiPost = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body as BodyInit });
export const apiPut  = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT',  body: body as BodyInit });
export const apiDel  = <T>(path: string)            => api<T>(path, { method: 'DELETE' });
export const apiPatch = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body: body as BodyInit });
export const apiUpload = <T>(path: string, form: FormData) => api<T>(path, { method: 'POST', body: form });

export interface DevLoginResp {
  token: string;
  user: import('./types').User;
}
export function devLogin(tenant_slug: string, email: string) {
  return api<DevLoginResp>('/auth/dev-login', {
    method: 'POST',
    body: { tenant_slug, email },
    skipAuth: true,
    skipTenant: true,
  });
}

export type InviteType = 'employee' | 'customer' | 'vendor';
export function devRegister(args: {
  tenant_slug:  string;
  email:        string;
  display_name: string;
  invite_type:  InviteType;
}) {
  return api<DevLoginResp>('/auth/register', {
    method: 'POST',
    body: args,
    skipAuth: true,
    skipTenant: true,
  });
}
