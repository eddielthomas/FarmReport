// =============================================================================
// TenantSwitcher — tenant dropdown in the top-right cluster (S7C re-skin)
// -----------------------------------------------------------------------------
// Trigger is a pill that matches the SurfaceModeToggle / sign-out button. The
// dropdown panel uses the new surface tokens, with focusable rows + a tiny
// "current tenant" check indicator.
// =============================================================================

import { useEffect, useState, useRef } from 'react';
import { apiGet, devLogin } from '@crm/lib/api';
import { useTenantStore } from '@crm/lib/tenant-store';
import { useAuthStore } from '@crm/lib/auth-store';
import type { Tenant } from '@crm/lib/types';
import { ChevronDown, Building2, Check } from 'lucide-react';
import { cn } from '@crm/lib/utils';

interface KnownTenant { id?: string; slug: string; display_name: string; }

// Fallback list so the switcher works before the user is authenticated.
const SEED_TENANTS: KnownTenant[] = [
  { slug: 'demo-buyer',   display_name: 'Demo Produce Buyer' },
  { slug: 'acme-produce', display_name: 'Acme Produce Co.' },
];

export function TenantSwitcher() {
  const { currentTenantSlug, currentTenantName, setTenant } = useTenantStore();
  const { token, setSession } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [tenants, setTenants] = useState<KnownTenant[]>(SEED_TENANTS);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!token) return;
    apiGet<Tenant[]>('/tenants')
      .then((rows) => {
        if (rows.length > 0) setTenants(rows.map((t) => ({ id: t.id, slug: t.slug, display_name: t.display_name })));
      })
      .catch(() => { /* non-admin → silent */ });
  }, [token]);

  // Esc closes; clicking outside closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
    }
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function switchTo(t: KnownTenant) {
    setOpen(false);
    try {
      const res = await devLogin(t.slug, 'admin@' + t.slug + '.local');
      setSession(res.token, res.user);
      setTenant(res.user.tenant_id, res.user.tenant_slug ?? t.slug, t.display_name);
      window.dispatchEvent(new Event('rwr.tenant-changed'));
    } catch (err) {
      console.error('[tenant-switch] failed:', err);
    }
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-2 h-9 px-3 rounded-[var(--radius-full)]',
          'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
          'hover:bg-[var(--surface-sunken)]',
          'transition-colors duration-[var(--duration-fast)]',
          'text-[12px] font-medium',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]',
        )}
      >
        <Building2 className="size-3.5 text-[var(--fg-muted)]" />
        <span className="max-w-[12ch] truncate">
          {currentTenantName ?? currentTenantSlug ?? 'Select tenant'}
        </span>
        <ChevronDown className="size-3 text-[var(--fg-muted)]" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <ul
            role="listbox"
            className={cn(
              'absolute right-0 top-11 z-50 min-w-[220px] p-1.5',
              'rounded-[var(--radius-lg)] border border-[var(--border)]',
              'bg-[var(--surface-elevated)] text-[var(--fg)]',
              'shadow-[var(--shadow-popover)]',
            )}
          >
            <li
              role="presentation"
              className="px-2 pt-1 pb-1.5 text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]"
            >
              Switch tenant
            </li>
            {tenants.map((t) => {
              const active = currentTenantSlug === t.slug;
              return (
                <li key={t.slug} role="option" aria-selected={active}>
                  <button
                    type="button"
                    onClick={() => switchTo(t)}
                    className={cn(
                      'w-full text-left flex items-start gap-2 px-2 py-1.5 rounded-[var(--radius-md)]',
                      'hover:bg-[var(--surface-sunken)] transition-colors duration-[var(--duration-fast)]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                    )}
                  >
                    <Check
                      className={cn(
                        'size-3.5 mt-0.5 shrink-0',
                        active ? 'text-[var(--accent-strong)]' : 'opacity-0',
                      )}
                    />
                    <div className="min-w-0">
                      <div className="text-[12px] font-medium text-[var(--fg)] truncate">
                        {t.display_name}
                      </div>
                      <div className="text-[10px] text-[var(--fg-muted)] font-mono">{t.slug}</div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
