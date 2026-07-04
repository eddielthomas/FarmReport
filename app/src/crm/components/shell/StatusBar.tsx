// =============================================================================
// StatusBar — tiny uppercase-label app footer (S7C re-skin)
// -----------------------------------------------------------------------------
// Concept aesthetic: a single thin band with token-driven typography. The
// "● ONLINE" indicator paints with `--green`; everything else stays in
// `--fg-muted` so the bar reads as ambient context, not chrome.
// =============================================================================

import { useAuthStore } from '@crm/lib/auth-store';
import { useTenantStore } from '@crm/lib/tenant-store';

export function StatusBar({ status }: { status?: string }) {
  const { user } = useAuthStore();
  const { currentTenantSlug } = useTenantStore();
  return (
    <div
      role="status"
      aria-live="polite"
      className="
        h-7 px-3 sm:px-4 border-t border-[var(--border)]
        bg-[var(--bg-elevated)] text-[var(--fg-muted)]
        flex items-center justify-between select-none
        text-[10px] font-medium uppercase tracking-[var(--tracking-wider)]
      "
    >
      <div className="flex items-center gap-4 min-w-0">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-1.5 rounded-full bg-[var(--green)]"
          />
          <span>Online</span>
        </span>
        <span className="hidden sm:inline">
          <span className="text-[var(--fg-subtle)]">Tenant</span>{' '}
          <span className="text-[var(--fg)]">{currentTenantSlug ?? '—'}</span>
        </span>
        <span className="hidden md:inline truncate">
          <span className="text-[var(--fg-subtle)]">User</span>{' '}
          <span className="text-[var(--fg)]">{user?.email ?? '—'}</span>
        </span>
      </div>
      <div className="flex items-center gap-4 shrink-0">
        <span className="text-[var(--fg)]">{status ?? 'Ready'}</span>
        <span className="hidden sm:inline text-[var(--fg-subtle)]">
          Report.Farm v0.1
        </span>
      </div>
    </div>
  );
}
