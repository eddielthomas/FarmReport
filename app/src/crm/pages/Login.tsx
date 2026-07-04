// =============================================================================
// Login surface — Sign in or Create account (S7C re-skin).
// -----------------------------------------------------------------------------
// Flow after marketing/access.html gate:
//   /access.html (passcode) → /login.html (sign in OR register) → primary surface
//
// S7C visual layer:
//   - BrandMark as the logo block.
//   - PillTabs for the sign-in / register mode toggle.
//   - SurfaceModeToggle in the top-right so users can pick light/dark before
//     they sign in.
//   - Card primitives + token-based palette throughout.
// =============================================================================

import { useEffect, useState } from 'react';
import { devLogin, devRegister, ApiError, type InviteType } from '@crm/lib/api';
import {
  useAuthStore,
  primarySurfaceForRoles,
  allowedSurfacesForRoles,
  sanitizeNextUrl,
} from '@crm/lib/auth-store';
import { useTenantStore } from '@crm/lib/tenant-store';
import { useSurfaceMode } from '@crm/lib/surface-store';
import { Button } from '@crm/components/ui/button';
import { Input, Label } from '@crm/components/ui/input';
import { Card, CardContent } from '@crm/components/ui/card';
import { BrandMark } from '@crm/components/ui/brand-mark';
import { SurfaceModeToggle } from '@crm/components/ui/surface-mode-toggle';
import { PillTabs, type PillTabItem } from '@crm/components/ui/pill-tabs';
import { cn } from '@crm/lib/utils';
import {
  Shield, UserCog, Briefcase, Headset, BarChart3, HardHat, ArrowRight,
  Users, Building2, Truck, Sprout,
} from 'lucide-react';

const DEFAULT_TENANT = 'demo-buyer';

interface DemoAccount {
  role: string;
  label: string;
  description: string;
  icon: React.ReactNode;
}

// Farm personas — map 1:1 to the demo-buyer accounts seeded in 300_farm_demo_accounts.sql
// (admin@ / buyer@ / ops@ / grower@demo-buyer.demo). The email is `${role}@${tenant}.demo`.
const DEMO_ACCOUNTS: DemoAccount[] = [
  { role: 'admin',  label: 'Buyer Admin',       description: 'All surfaces · onboard suppliers & farms, manage the account', icon: <Shield className="size-4" /> },
  { role: 'buyer',  label: 'Portfolio Lead',    description: 'Watch the supplier portfolio · risk, reports',                icon: <BarChart3 className="size-4" /> },
  { role: 'ops',    label: 'Farm Operations',   description: 'Onboard farms, set zone intent, triage alerts',               icon: <UserCog className="size-4" /> },
  { role: 'grower', label: 'Grower',            description: 'See your own farms and the findings on your fields',          icon: <Sprout className="size-4" /> },
];

interface InviteTypeDef {
  key:   InviteType;
  label: string;
  blurb: string;
  icon:  React.ReactNode;
}

const INVITE_TYPES: InviteTypeDef[] = [
  { key: 'employee', label: 'Employee', blurb: 'Sales / analytics access',   icon: <Users className="size-4" /> },
  { key: 'customer', label: 'Customer', blurb: 'Customer portal only',       icon: <Building2 className="size-4" /> },
  { key: 'vendor',   label: 'Vendor',   blurb: 'Vendor surface + dashboard', icon: <Truck className="size-4" /> },
];

type Mode = 'signin' | 'register';
const MODE_ITEMS: ReadonlyArray<PillTabItem<Mode>> = [
  { key: 'signin',   label: 'Sign in' },
  { key: 'register', label: 'Create account' },
];

export function LoginPage() {
  // Keep the `<html data-surface>` attribute synced before children render so
  // the SurfaceModeToggle and the rest of the token cascade resolve correctly
  // when the user lands here from a cold browser session.
  useSurfaceMode();

  const setSession = useAuthStore((s) => s.setSession);
  const user       = useAuthStore((s) => s.user);
  const setTenant  = useTenantStore((s) => s.setTenant);

  const [mode, setMode]               = useState<Mode>('signin');
  const [tenantSlug, setTenantSlug]   = useState<string>(DEFAULT_TENANT);
  const [email, setEmail]             = useState<string>('');
  const [displayName, setDisplayName] = useState<string>('');
  const [inviteType, setInviteType]   = useState<InviteType>('employee');
  const [pending, setPending] = useState<'idle' | 'busy'>('idle');
  const [error, setError]     = useState<string | null>(null);
  // Self-service registration is opt-in (server flag ALLOW_SELF_REGISTRATION).
  // The "Request access" link only renders when the server says it's enabled.
  const [selfRegEnabled, setSelfRegEnabled] = useState(false);
  useEffect(() => {
    fetch('/api/v1/auth/registration-config')
      .then((r) => r.json())
      .then((j) => setSelfRegEnabled(Boolean(j?.data?.enabled ?? j?.enabled)))
      .catch(() => setSelfRegEnabled(false));
  }, []);

  // Already signed in? Route to primary surface immediately.
  // Sprint 12 — sanitize ?next= against the user's surface allow-list so a
  // user who originally clicked a /dashboard.html deep-link can't be forced
  // onto the ops dashboard if their role doesn't permit it.
  useEffect(() => {
    if (user) {
      const primary = primarySurfaceForRoles(user.roles);
      const allowed = allowedSurfacesForRoles(user.roles);
      const raw = new URLSearchParams(window.location.search).get('next');
      const safeNext = sanitizeNextUrl(raw);
      const target = safeNext && allowed.has(safeNext) ? safeNext : primary;
      window.location.replace(`/${target}`);
    }
  }, [user]);

  function landAfterAuth(u: { roles: string[]; tenant_id: string; tenant_slug?: string }, slug: string, token: string) {
    setTenant(u.tenant_id, u.tenant_slug ?? slug, u.tenant_slug ?? slug);
    setSession(token, u as Parameters<typeof setSession>[1]);
    // Sprint 12 — same allow-list check on the post-login redirect path.
    // If the ?next= param targets a surface this role can't visit, fall back
    // to the user's primary (role-resolved) surface instead.
    const primary = primarySurfaceForRoles(u.roles);
    const allowed = allowedSurfacesForRoles(u.roles);
    const raw = new URLSearchParams(window.location.search).get('next');
    const safeNext = sanitizeNextUrl(raw);
    const target = safeNext && allowed.has(safeNext) ? safeNext : primary;
    window.location.replace(`/${target}`);
  }

  async function submitSignIn(emailToUse: string, slug = tenantSlug) {
    setError(null);
    setPending('busy');
    try {
      const { token, user: u } = await devLogin(slug, emailToUse);
      landAfterAuth(u, slug, token);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'login_failed');
      setPending('idle');
    }
  }

  async function submitRegister() {
    setError(null);
    setPending('busy');
    try {
      const { token, user: u } = await devRegister({
        tenant_slug:  tenantSlug,
        email:        email.trim(),
        display_name: displayName.trim() || email.split('@')[0],
        invite_type:  inviteType,
      });
      landAfterAuth(u, tenantSlug, token);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'register_failed');
      setPending('idle');
    }
  }

  function pickDemo(role: DemoAccount['role']) {
    const demoEmail = `${role}@${tenantSlug}.demo`;
    setEmail(demoEmail);
    void submitSignIn(demoEmail);
  }

  return (
    <div className="min-h-screen w-full bg-[var(--bg)] text-[var(--fg)] flex flex-col">
      {/* Top bar — surface mode toggle floats top-right --------------------- */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-4">
        <a
          href="/"
          className="flex items-center gap-2 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded-[var(--radius-md)]"
          aria-label="Report.Farm home"
        >
          <BrandMark size={32} />
          <span className="hidden sm:flex flex-col leading-none">
            <span className="text-[14px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)]">
              Report.Farm
            </span>
            <span className="text-[10px] uppercase tracking-[var(--tracking-widest)] text-[var(--fg-muted)]">
              Mission Control
            </span>
          </span>
        </a>
        <SurfaceModeToggle compact />
      </div>

      {/* Main content ------------------------------------------------------ */}
      <div className="flex-1 flex items-start sm:items-center justify-center px-4 pb-10">
        <div className="w-full max-w-2xl space-y-5">
          <header className="text-center space-y-2">
            <h1 className="text-[28px] sm:text-[34px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)] leading-tight">
              {mode === 'signin' ? 'Welcome back' : 'Create your account'}
            </h1>
            <p className="text-[13px] text-[var(--fg-muted)] max-w-md mx-auto">
              {mode === 'signin'
                ? 'Pick a demo perspective, sign in with your credentials, or create a new account.'
                : 'Tell us your invite type — your access scope is set accordingly.'}
            </p>
          </header>

          <div className="flex justify-center">
            <PillTabs<Mode>
              value={mode}
              onChange={(m) => { setMode(m); setError(null); }}
              items={MODE_ITEMS}
              size="md"
              aria-label="Authentication mode"
            />
          </div>

          <Card>
            <CardContent className="p-5 sm:p-6 space-y-5">
              {mode === 'signin' && (
                <>
                  <div className="space-y-2">
                    <Label>Demo perspectives</Label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {DEMO_ACCOUNTS.map((acc) => (
                        <button
                          key={acc.role}
                          type="button"
                          disabled={pending === 'busy'}
                          onClick={() => pickDemo(acc.role)}
                          className={cn(
                            'group text-left rounded-[var(--radius-lg)] p-3',
                            'border border-[var(--border)] bg-[var(--surface)]',
                            'hover:border-[var(--border-strong)] hover:bg-[var(--surface-sunken)]',
                            'transition-colors duration-[var(--duration-fast)]',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                            'disabled:opacity-50 disabled:cursor-not-allowed',
                          )}
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="flex items-center gap-2 text-[12px] font-medium text-[var(--fg)]">
                              {acc.icon} {acc.label}
                            </span>
                            <ArrowRight className="size-3.5 text-[var(--fg-muted)] opacity-0 group-hover:opacity-100 transition" />
                          </div>
                          <div className="text-[11px] text-[var(--fg-muted)] leading-snug">{acc.description}</div>
                          <div className="text-[10px] font-mono text-[var(--fg-subtle)] mt-1.5 truncate">
                            {acc.role}@{tenantSlug}.demo
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="border-t border-[var(--border)] pt-5 space-y-3">
                    <Label>Sign in manually</Label>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!email.trim() || pending === 'busy') return;
                        void submitSignIn(email.trim());
                      }}
                      className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2 items-end"
                    >
                      <div className="space-y-1">
                        <Label htmlFor="tenant">Tenant</Label>
                        <Input
                          id="tenant"
                          value={tenantSlug}
                          onChange={(e) => setTenantSlug(e.target.value)}
                          placeholder="demo-buyer"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="email">Email</Label>
                        <Input
                          id="email"
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="you@tenant.demo"
                          autoComplete="email"
                        />
                      </div>
                      <Button type="submit" size="md" disabled={!email.trim() || pending === 'busy'}>
                        {pending === 'busy' ? 'Signing in…' : 'Sign in'}
                      </Button>
                    </form>
                  </div>
                </>
              )}

              {mode === 'register' && (
                <>
                  <div className="space-y-2">
                    <Label>Invite type</Label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {INVITE_TYPES.map((t) => {
                        const active = inviteType === t.key;
                        return (
                          <button
                            key={t.key}
                            type="button"
                            onClick={() => setInviteType(t.key)}
                            className={cn(
                              'text-left rounded-[var(--radius-lg)] p-3',
                              'border transition-colors duration-[var(--duration-fast)]',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                              active
                                ? 'border-[var(--fg)] bg-[var(--surface-sunken)] text-[var(--fg)]'
                                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:border-[var(--border-strong)]',
                            )}
                          >
                            <div className="flex items-center gap-2 text-[12px] font-medium mb-1">
                              {t.icon} {t.label}
                            </div>
                            <div className="text-[11px] leading-snug">{t.blurb}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!email.trim() || !tenantSlug.trim() || pending === 'busy') return;
                      void submitRegister();
                    }}
                    className="space-y-3 border-t border-[var(--border)] pt-5"
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="r-tenant">Tenant</Label>
                        <Input
                          id="r-tenant"
                          value={tenantSlug}
                          onChange={(e) => setTenantSlug(e.target.value)}
                          placeholder="demo-buyer"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="r-name">Full name</Label>
                        <Input
                          id="r-name"
                          value={displayName}
                          onChange={(e) => setDisplayName(e.target.value)}
                          placeholder="Jane Doe"
                          autoComplete="name"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="r-email">Email</Label>
                      <Input
                        id="r-email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@tenant.com"
                        autoComplete="email"
                      />
                    </div>
                    <Button type="submit" size="md" disabled={!email.trim() || !tenantSlug.trim() || pending === 'busy'}>
                      {pending === 'busy' ? 'Creating account…' : `Create ${inviteType} account`}
                    </Button>
                  </form>
                </>
              )}

              {error && (
                <div className="rounded-[var(--radius-md)] border border-[var(--red)]/40 bg-[color-mix(in_oklch,var(--red)_10%,transparent)] text-[var(--red)] text-[12px] font-mono p-2">
                  {error}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="text-center text-[11px] text-[var(--fg-muted)]">
            Demo tenant:{' '}
            <span className="text-[var(--fg)] font-mono">demo-buyer</span>
          </div>

          {selfRegEnabled && (
            <div className="text-center text-[12px] text-[var(--fg-muted)]">
              Have an access code from your AlphaGeo contact?{' '}
              <a href="/register.html" className="font-semibold text-[var(--fg)] underline underline-offset-2 hover:text-[var(--accent-strong)]">
                Request portal access
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
