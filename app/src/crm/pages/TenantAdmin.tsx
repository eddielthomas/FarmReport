// =============================================================================
// TenantAdmin — platform tenant directory (S7C re-skin)
// -----------------------------------------------------------------------------
// IA: tenant cards grid (with status + plan badges), new-tenant modal, detail
// modal with users + audit log + metadata, plus the "switch to this tenant"
// pivot. Visual layer rewritten on the new tokens + Card primitive.
// =============================================================================

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut, ApiError } from '@crm/lib/api';
import type { Tenant, TenantUser } from '@crm/lib/types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@crm/components/ui/card';
import { Badge, statusVariant } from '@crm/components/ui/badge';
import { Button } from '@crm/components/ui/button';
import { Input, Label } from '@crm/components/ui/input';
import { useAuthStore } from '@crm/lib/auth-store';
import { useTenantStore } from '@crm/lib/tenant-store';
import { formatRelative, cn } from '@crm/lib/utils';
import { Plus, ShieldAlert, X, ExternalLink, ChevronRight, Activity, Users2 } from 'lucide-react';
import { CoachmarkTour } from '@crm/components/ui/coachmark';
import { TOURS } from '@crm/lib/tours';

export function TenantAdmin() {
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const isAdmin = (user?.roles ?? []).includes('platform:admin');

  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Tenant | null>(null);

  const { data, error, isLoading } = useQuery({
    queryKey: ['tenants'],
    queryFn: () => apiGet<Tenant[]>('/tenants'),
    enabled: isAdmin,
    retry: false,
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => apiPut(`/tenants/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenants'] }),
  });

  if (!isAdmin) {
    return (
      <div className="h-full bg-[var(--bg)] flex items-center justify-center p-4">
        <Card className="max-w-md">
          <CardContent className="flex items-start gap-3 p-5">
            <ShieldAlert className="size-5 text-[var(--red)] mt-0.5 shrink-0" />
            <div className="space-y-1">
              <div className="text-[14px] font-semibold text-[var(--fg)]">Platform admin only</div>
              <div className="text-[12px] text-[var(--fg-muted)] leading-relaxed">
                You need the <code className="font-mono text-[var(--fg)]">platform:admin</code>{' '}
                role to view this page. Sign in as{' '}
                <code className="font-mono">admin@demo-buyer.local</code> or{' '}
                <code className="font-mono">admin@acme-produce.local</code>.
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
      <div className="p-4 sm:p-6 space-y-5 max-w-[1400px] mx-auto">
        <header className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
              Platform
            </div>
            <h1 className="text-[24px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)]">
              Tenants
            </h1>
            <div className="text-[12px] text-[var(--fg-muted)] mt-0.5">
              All buyer organizations on the platform
            </div>
          </div>
          <Button size="md" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New tenant
          </Button>
        </header>

        {error instanceof ApiError && error.status === 403 && (
          <Card className="border-[var(--red)]/40">
            <CardContent className="p-3 text-[12px] text-[var(--red)]">
              Access denied — admin role required.
            </CardContent>
          </Card>
        )}

        <div data-coachmark="tenants.list" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {isLoading && (
            <div className="col-span-full text-[12px] text-[var(--fg-muted)]">Loading…</div>
          )}
          {(data ?? []).map((t, i) => (
            <Card
              key={t.id}
              data-coachmark={i === 0 ? 'tenants.card' : undefined}
              onClick={() => setSelected(t)}
              className={cn(
                'cursor-pointer',
                'transition-all duration-[var(--duration-fast)]',
                'hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-popover)]',
              )}
            >
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <span className="truncate text-[15px]">{t.display_name}</span>
                  <Badge variant={statusVariant(t.status)}>{t.status}</Badge>
                </CardTitle>
                <CardDescription className="flex items-center justify-between">
                  <span className="font-mono">{t.slug}</span>
                  <Badge variant="outline" size="sm">{t.plan}</Badge>
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
                  Created {formatRelative(t.created_at)}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    {t.status === 'active' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setStatus.mutate({ id: t.id, status: 'suspended' })}
                      >
                        Suspend
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setStatus.mutate({ id: t.id, status: 'active' })}
                      >
                        Reactivate
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 text-[11px] font-medium text-[var(--fg)]">
                    Manage <ChevronRight className="size-3.5" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {creating && <NewTenantDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); qc.invalidateQueries({ queryKey: ['tenants'] }); }} />}
        {selected && <TenantDetailDialog tenant={selected} onClose={() => setSelected(null)} />}
        <CoachmarkTour tourId={TOURS.tenants.id} steps={TOURS.tenants.steps} />
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
function TenantDetailDialog({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const setTenantStore = useTenantStore((s) => s.setTenant);

  const { data: users = [], isLoading: usersLoading } = useQuery({
    queryKey: ['tenant-users', tenant.id],
    queryFn: () => apiGet<TenantUser[]>(`/tenants/${tenant.id}/users`),
    retry: false,
  });

  const { data: audit = [] } = useQuery({
    queryKey: ['tenant-audit', tenant.id],
    queryFn: async () => {
      try { return await apiGet<any[]>(`/tenants/${tenant.id}/audit`); }
      catch { return []; }
    },
    retry: false,
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Tenant ${tenant.display_name}`}
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 bg-[var(--overlay)] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={cn(
          'w-full max-w-3xl max-h-[88vh] overflow-hidden flex flex-col',
          'rounded-[var(--radius-2xl)] border border-[var(--border)]',
          'bg-[var(--surface-elevated)] text-[var(--fg)] shadow-[var(--shadow-overlay)]',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between p-5 border-b border-[var(--border)]">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
              Tenant
            </div>
            <div className="text-[20px] font-semibold tracking-[var(--tracking-tight)] truncate">{tenant.display_name}</div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[11px] font-mono text-[var(--fg-muted)]">{tenant.slug}</span>
              <Badge variant={statusVariant(tenant.status)} size="sm">{tenant.status}</Badge>
              <Badge variant="outline" size="sm">{tenant.plan}</Badge>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="size-9 grid place-items-center rounded-[var(--radius-full)] text-[var(--fg-muted)] hover:text-[var(--red)] hover:bg-[var(--surface-sunken)] transition-colors"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
              <Users2 className="size-3.5" />
              Users · {users.length}
            </div>
            <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1">
              {usersLoading && <div className="text-[11px] text-[var(--fg-muted)] p-2">Loading…</div>}
              {!usersLoading && users.length === 0 && (
                <div className="text-[11px] text-[var(--fg-subtle)] p-2">No users in this tenant</div>
              )}
              {users.map((u) => (
                <div
                  key={u.id}
                  className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-medium text-[var(--fg)] truncate">
                      {u.display_name || u.email}
                    </span>
                    <Badge variant="outline" size="sm">{(u.roles ?? [])[0] ?? 'member'}</Badge>
                  </div>
                  <div className="text-[10px] font-mono text-[var(--fg-muted)] truncate">{u.email}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
              <Activity className="size-3.5" />
              Recent activity · {audit.length}
            </div>
            <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1">
              {audit.length === 0 && (
                <div className="text-[11px] text-[var(--fg-subtle)] p-2">No audit events yet</div>
              )}
              {audit.slice(0, 30).map((a: any) => (
                <div
                  key={a.id}
                  className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="outline" size="sm">{a.action}</Badge>
                    <span className="text-[10px] font-mono text-[var(--fg-muted)]">
                      {formatRelative(a.created_at)}
                    </span>
                  </div>
                  <div className="text-[11px] text-[var(--fg)] truncate mt-1">
                    {a.resource}{a.resource_id ? ` · ${a.resource_id.slice(0, 8)}` : ''}
                  </div>
                  <div className="text-[10px] font-mono text-[var(--fg-muted)] truncate">
                    {a.actor_email ?? '—'}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="md:col-span-2 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-3">
            <div className="text-[11px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)] mb-2">
              Tenant metadata
            </div>
            <div className="grid grid-cols-2 gap-3 text-[12px]">
              <div>
                <div className="text-[10px] uppercase text-[var(--fg-muted)]">Created</div>
                <div className="text-[var(--fg)]">{formatRelative(tenant.created_at)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-[var(--fg-muted)]">ID</div>
                <div className="text-[var(--fg)] font-mono text-[10px]">{tenant.id}</div>
              </div>
            </div>
          </section>
        </div>

        <footer className="flex items-center justify-between gap-2 p-4 border-t border-[var(--border)]">
          <Button
            size="md"
            variant="outline"
            onClick={() => { setTenantStore(tenant.id, tenant.slug, tenant.display_name); window.location.href = '/operations.html'; }}
          >
            <ExternalLink className="size-4" /> Switch to this tenant
          </Button>
          <Button size="md" onClick={onClose}>Close</Button>
        </footer>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
function NewTenantDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ slug: '', display_name: '', plan: 'mvp' });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true); setErr(null);
    try { await apiPost('/tenants', form); onCreated(); }
    catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setSubmitting(false); }
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create tenant"
      className="fixed inset-0 z-[var(--z-modal)] bg-[var(--overlay)] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <Card className="w-[440px]" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>New tenant</CardTitle>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="size-7 grid place-items-center rounded-[var(--radius-full)] text-[var(--fg-muted)] hover:text-[var(--red)] hover:bg-[var(--surface-sunken)]"
          >
            <X className="size-4" />
          </button>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="t-slug">Slug (a-z, 0-9, hyphen)</Label>
              <Input id="t-slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="acme-produce" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="t-name">Display name</Label>
              <Input id="t-name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} placeholder="Acme Produce Co." />
            </div>
            <div className="space-y-1">
              <Label htmlFor="t-plan">Plan</Label>
              <select
                id="t-plan"
                value={form.plan}
                onChange={(e) => setForm({ ...form, plan: e.target.value })}
                className="w-full h-9 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] px-3 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                {['mvp','pro','enterprise'].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            {err && (
              <div className="text-[12px] text-[var(--red)] rounded-[var(--radius-md)] border border-[var(--red)]/30 bg-[color-mix(in_oklch,var(--red)_10%,transparent)] p-2">
                {err}
              </div>
            )}
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? 'Creating…' : 'Create tenant'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
