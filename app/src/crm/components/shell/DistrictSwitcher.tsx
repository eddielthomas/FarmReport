// =============================================================================
// DistrictSwitcher — Sprint A5.1 (ADR-0024) minimal org/district switcher.
// -----------------------------------------------------------------------------
// Renders ONLY when the authenticated user carries an org claim (the active
// tenant has a parent org). Lists "my districts under <org>" from GET
// /iam/my-orgs and switches the active district via POST /auth/switch-tenant
// (the JWT is re-minted with the target tenant_id). Standalone tenants
// (org_id IS NULL) never see this control — byte-identical pre-A5.1 UX.
//
// This is the deliberately-minimal A5.1 surface; the full grouped switcher
// (multiple orgs, search, district status badges) is deferred polish.
// =============================================================================

import { useEffect, useState, useRef } from 'react';
import { useAuthStore } from '@crm/lib/auth-store';
import { useTenantStore, loadMyOrgs } from '@crm/lib/tenant-store';
import { switchTenant } from '@crm/lib/orgs';
import { ChevronDown, Landmark, Check } from 'lucide-react';
import { cn } from '@crm/lib/utils';

export function DistrictSwitcher() {
  const user = useAuthStore((s) => s.user);
  const myOrgs = useTenantStore((s) => s.myOrgs);
  const currentTenantSlug = useTenantStore((s) => s.currentTenantSlug);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Hydrate the org list once the user is authenticated with an org claim.
  useEffect(() => {
    if (user?.org?.org_id) loadMyOrgs();
  }, [user?.org?.org_id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
    }
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // No org claim → render nothing (standalone tenant path).
  if (!user?.org?.org_id) return null;

  // The org owning the active tenant (the claim's org_id).
  const activeOrg = myOrgs.find((o) => o.org_id === user.org?.org_id) ?? null;
  const districts = activeOrg?.districts ?? [];
  if (districts.length === 0) return null;

  async function switchTo(slug: string) {
    if (busy || slug === currentTenantSlug) { setOpen(false); return; }
    setBusy(true);
    try {
      await switchTenant(slug);
      window.dispatchEvent(new Event('rwr.tenant-changed'));
      // Re-load with the new active tenant; then a hard reload re-renders every
      // surface against the new tenant_id (keeps parity with TenantSwitcher).
      window.location.reload();
    } catch (err) {
      console.error('[district-switch] failed:', err);
      setBusy(false);
      setOpen(false);
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
        title={`Districts under ${activeOrg?.display_name ?? user.org.org_slug}`}
        className={cn(
          'inline-flex items-center gap-2 h-9 px-3 rounded-[var(--radius-full)]',
          'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
          'hover:bg-[var(--surface-sunken)]',
          'transition-colors duration-[var(--duration-fast)]',
          'text-[12px] font-medium',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]',
        )}
      >
        <Landmark className="size-3.5 text-[var(--fg-muted)]" />
        <span className="max-w-[14ch] truncate">
          {activeOrg?.display_name ?? user.org.org_slug}
        </span>
        <ChevronDown className="size-3 text-[var(--fg-muted)]" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <ul
            role="listbox"
            className={cn(
              'absolute right-0 top-11 z-50 min-w-[240px] p-1.5',
              'rounded-[var(--radius-lg)] border border-[var(--border)]',
              'bg-[var(--surface-elevated)] text-[var(--fg)]',
              'shadow-[var(--shadow-popover)]',
            )}
          >
            <li
              role="presentation"
              className="px-2 pt-1 pb-1.5 text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]"
            >
              My districts · {activeOrg?.display_name ?? user.org.org_slug}
            </li>
            {districts.map((d) => {
              const active = currentTenantSlug === d.tenant_slug;
              return (
                <li key={d.tenant_slug} role="option" aria-selected={active}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => switchTo(d.tenant_slug)}
                    className={cn(
                      'w-full text-left flex items-start gap-2 px-2 py-1.5 rounded-[var(--radius-md)]',
                      'hover:bg-[var(--surface-sunken)] transition-colors duration-[var(--duration-fast)]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                      busy && 'opacity-60 cursor-not-allowed',
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
                        {d.display_name}
                      </div>
                      <div className="text-[10px] text-[var(--fg-muted)] font-mono">{d.tenant_slug}</div>
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
