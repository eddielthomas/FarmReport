// =============================================================================
// VendorPortal — supplier-only surface (S7C re-skin)
// -----------------------------------------------------------------------------
// IA preserved (header banner, expiring-soon warning, four tabs, contract
// list). Visual layer rewritten on tokens: PillTabs for the tab strip, Card
// for contract rows, new Badge variants for status.
// =============================================================================

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@crm/lib/api';
import { useAuthStore, useHasRole } from '@crm/lib/auth-store';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@crm/components/ui/card';
import { Badge, type BadgeProps } from '@crm/components/ui/badge';
import { PillTabs, type PillTabItem } from '@crm/components/ui/pill-tabs';
import { cn, formatRelative } from '@crm/lib/utils';
import {
  FileText, FolderTree, Receipt, ScrollText, Calendar, ShieldCheck, CircleAlert,
} from 'lucide-react';

interface VendorContract {
  id: string;
  tenant_id: string;
  vendor_user_id: string;
  contract_kind:
    | 'sales_partner'
    | 'data_provider'
    | 'channel_partner'
    | 'implementation_partner'
    | 'repair_partner';
  status: 'draft' | 'active' | 'expired' | 'revoked';
  starts_at: string;
  ends_at: string | null;
  signed_at: string | null;
  terms_doc_url: string | null;
  created_at: string;
  updated_at: string;
  scope_count?: number;
}

type TabKey = 'contracts' | 'resources' | 'billing' | 'documents';

const TABS: ReadonlyArray<PillTabItem<TabKey>> = [
  { key: 'contracts', label: 'My Contracts', icon: <FileText className="size-3.5" /> },
  { key: 'resources', label: 'My Resources', icon: <FolderTree className="size-3.5" /> },
  { key: 'billing',   label: 'Billing',      icon: <Receipt className="size-3.5" /> },
  { key: 'documents', label: 'Documents',    icon: <ScrollText className="size-3.5" /> },
];

const KIND_LABEL: Record<VendorContract['contract_kind'], string> = {
  sales_partner:          'Sales Partner',
  data_provider:          'Data Provider',
  channel_partner:        'Channel Partner',
  implementation_partner: 'Implementation Partner',
  repair_partner:         'Repair Partner',
};

function contractStatusVariant(status: VendorContract['status']): BadgeProps['variant'] {
  switch (status) {
    case 'active':  return 'success';
    case 'draft':   return 'info';
    case 'expired': return 'warning';
    case 'revoked': return 'destructive';
    default:        return 'secondary';
  }
}

export function VendorPortal() {
  const user = useAuthStore((s) => s.user);
  const canBilling = useHasRole('vendor:billing');
  const [tab, setTab] = useState<TabKey>('contracts');

  const tabsWithDisabled = useMemo<ReadonlyArray<PillTabItem<TabKey>>>(
    () => TABS.map((t) => ({ ...t, disabled: t.key === 'billing' && !canBilling })),
    [canBilling],
  );

  const { data: contracts = [], isLoading, isError, error } = useQuery({
    queryKey: ['vendor-contracts'],
    queryFn:  () => apiGet<VendorContract[]>('/vendor-pool/contracts'),
  });

  const activeCount  = contracts.filter((c) => c.status === 'active').length;
  const expiringSoon = useMemo(() => {
    const horizon = Date.now() + 14 * 24 * 60 * 60 * 1000;
    return contracts.filter(
      (c) => c.status === 'active' && c.ends_at && new Date(c.ends_at).getTime() <= horizon,
    );
  }, [contracts]);

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
      <div className="p-4 sm:p-6 space-y-5 max-w-[1400px] mx-auto">
        {/* ---- Header banner ----------------------------------------------- */}
        <Card>
          <CardContent className="p-5 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
                Supplier portal
              </div>
              <div className="text-[20px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)] mt-1 truncate">
                {user?.display_name ?? user?.email ?? 'Supplier'}
              </div>
              <div className="text-[11px] text-[var(--fg-muted)] flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1">
                <span className="font-mono">{user?.email}</span>
                <span className="opacity-40">·</span>
                <span>tenant {user?.tenant_slug ?? user?.tenant_id}</span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              <div className="text-[11px] flex items-center gap-1.5 text-[var(--fg-muted)]">
                <ShieldCheck className="size-3.5 text-[var(--green)]" />
                <span className="uppercase tracking-[var(--tracking-wide)]">Session secure</span>
              </div>
              <Badge variant={activeCount > 0 ? 'success' : 'soft'}>
                {activeCount} active contract{activeCount === 1 ? '' : 's'}
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* ---- Expiring contract warning ---------------------------------- */}
        {expiringSoon.length > 0 && (
          <Card className="border-[var(--orange)]/40">
            <CardContent className="p-3 flex items-start gap-2.5">
              <CircleAlert className="size-4 mt-0.5 text-[var(--orange)] shrink-0" />
              <div className="text-[12px] text-[var(--fg)]">
                <span className="uppercase tracking-[var(--tracking-wide)] text-[var(--orange)] font-semibold">
                  Expiring soon ·
                </span>{' '}
                {expiringSoon.length} contract{expiringSoon.length === 1 ? '' : 's'} expire within 14 days.
                Contact your tenant admin to renew.
              </div>
            </CardContent>
          </Card>
        )}

        {/* ---- Tab strip --------------------------------------------------- */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <PillTabs<TabKey>
            value={tab}
            onChange={setTab}
            items={tabsWithDisabled}
            size="md"
            aria-label="Supplier portal sections"
          />
          {tab === 'contracts' && contracts.length > 0 && (
            <Badge variant="soft" size="sm">
              {contracts.length} contract{contracts.length === 1 ? '' : 's'}
            </Badge>
          )}
        </div>

        {/* ---- Tab panels -------------------------------------------------- */}
        <div role="tabpanel" id={`vendor-tab-${tab}`}>
          {tab === 'contracts' && (
            <ContractsTab
              contracts={contracts}
              isLoading={isLoading}
              isError={isError}
              error={error}
            />
          )}
          {tab === 'resources' && <ResourcesTab />}
          {tab === 'billing'   && <BillingTab canBilling={canBilling} />}
          {tab === 'documents' && <DocumentsTab />}
        </div>
      </div>
    </div>
  );
}

// ---- Contracts tab ---------------------------------------------------------
function ContractsTab({
  contracts, isLoading, isError, error,
}: {
  contracts: VendorContract[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-[11px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)] animate-pulse">
          Loading contracts…
        </CardContent>
      </Card>
    );
  }
  if (isError) {
    return (
      <Card>
        <CardContent className="py-10 text-center space-y-1">
          <div className="text-[12px] text-[var(--red)]">Failed to load contracts</div>
          <div className="text-[11px] text-[var(--fg-muted)]">
            {(error as Error)?.message ?? 'unknown error'}
          </div>
        </CardContent>
      </Card>
    );
  }
  if (contracts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No contracts</CardTitle>
          <CardDescription>
            No contracts on file for your account. Contact your tenant admin to begin onboarding.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {contracts.map((c) => (
        <ContractRow key={c.id} contract={c} />
      ))}
    </div>
  );
}

function ContractRow({ contract: c }: { contract: VendorContract }) {
  const startsAt = c.starts_at ? new Date(c.starts_at) : null;
  const endsAt   = c.ends_at   ? new Date(c.ends_at)   : null;
  const daysLeft = endsAt
    ? Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000)
    : null;
  const scopeCount = c.scope_count ?? 0;

  const daysTone =
    daysLeft === null  ? 'text-[var(--fg-muted)]' :
    daysLeft <= 7      ? 'text-[var(--red)]'     :
    daysLeft <= 14     ? 'text-[var(--orange)]'  :
                         'text-[var(--fg-muted)]';

  return (
    <Card className="hover:border-[var(--border-strong)] transition-colors">
      <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline">{KIND_LABEL[c.contract_kind] ?? c.contract_kind}</Badge>
            <Badge variant={contractStatusVariant(c.status)}>{c.status}</Badge>
            {daysLeft !== null && c.status === 'active' && (
              <span className={cn('text-[10px] font-mono uppercase tracking-[var(--tracking-wide)]', daysTone)}>
                {daysLeft > 0 ? `${daysLeft}d remaining` : 'expired'}
              </span>
            )}
          </div>
          <div className="text-[11px] text-[var(--fg-muted)] flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Calendar className="size-3.5 opacity-60" />
            <span>
              {startsAt ? startsAt.toLocaleDateString() : '—'}
              {' → '}
              {endsAt ? endsAt.toLocaleDateString() : '—'}
            </span>
            <span className="opacity-40">·</span>
            <span>{scopeCount} scope row{scopeCount === 1 ? '' : 's'}</span>
            <span className="opacity-40">·</span>
            <span>updated {formatRelative(c.updated_at)}</span>
          </div>
          <div className="text-[10px] font-mono text-[var(--fg-subtle)] truncate">id {c.id}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled
            className={cn(
              'text-[11px] font-medium uppercase tracking-[var(--tracking-wide)]',
              'text-[var(--fg-muted)] opacity-60 cursor-not-allowed',
            )}
            title="Contract terms download lands in Phase 5"
          >
            View terms
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---- Resources tab ---------------------------------------------------------
function ResourcesTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Scoped resources</CardTitle>
        <CardDescription>The CRM rows your active contracts grant you access to.</CardDescription>
      </CardHeader>
      <CardContent className="text-[12px] text-[var(--fg-muted)] py-6 text-center">
        Resources scope view coming with P-004 chat surface for supplier channels.
      </CardContent>
    </Card>
  );
}

// ---- Billing tab -----------------------------------------------------------
function BillingTab({ canBilling }: { canBilling: boolean }) {
  if (!canBilling) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Billing</CardTitle>
          <CardDescription>Invoice lines and commissions.</CardDescription>
        </CardHeader>
        <CardContent className="text-[12px] text-[var(--fg-muted)] py-6 text-center">
          Your account does not include the{' '}
          <code className="font-mono text-[var(--fg)]">vendor:billing</code>{' '}
          role. Contact your tenant admin if you need access.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing</CardTitle>
        <CardDescription>Invoice lines and commissions.</CardDescription>
      </CardHeader>
      <CardContent className="text-[12px] text-[var(--fg-muted)] py-6 text-center">
        Invoice feed activates once the billing.stream pipeline targets your contracts.
      </CardContent>
    </Card>
  );
}

// ---- Documents tab ---------------------------------------------------------
function DocumentsTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Documents</CardTitle>
        <CardDescription>Contract terms and supporting attachments.</CardDescription>
      </CardHeader>
      <CardContent className="text-[12px] text-[var(--fg-muted)] py-6 text-center">
        Contract terms download — coming in Phase 5.
      </CardContent>
    </Card>
  );
}
