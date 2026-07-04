// =============================================================================
// CompaniesView — Sales > Companies tab (S7B)
// -----------------------------------------------------------------------------
// Account list using the concept's "71,74%" arc-gauge style. Rows come from
// `/sales/leads` (grouped by company), each row shows: company name, primary
// contact, lead status, and a small MetricArc representing engagement.
// =============================================================================

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building2, Search } from 'lucide-react';
import { apiGet } from '@crm/lib/api';
import type { Lead } from '@crm/lib/types';
import { MetricArc } from '@crm/components/ui/metric-arc';
import { Badge, statusVariant } from '@crm/components/ui/badge';
import { Input } from '@crm/components/ui/input';
import { cn, formatCurrency } from '@crm/lib/utils';

interface Account {
  company:   string;
  contacts:  Lead[];
  revenue:   number;
  /** Engagement score 0..100 — for the arc gauge. */
  engagement: number;
}

export function CompaniesView() {
  const [q, setQ] = React.useState('');
  const { data: leads = [] } = useQuery({
    queryKey: ['sales', 'leads', 'companies'],
    queryFn:  () => apiGet<Lead[]>('/sales/leads'),
  });

  const accounts: Account[] = React.useMemo(() => {
    const groups = new Map<string, Lead[]>();
    leads.forEach((l) => {
      const k = (l.company ?? l.email?.split('@')[1] ?? 'Unattached').trim() || 'Unattached';
      const list = groups.get(k) ?? [];
      list.push(l);
      groups.set(k, list);
    });
    return [...groups.entries()].map(([company, contacts]) => {
      const revenue = contacts.reduce((s, l) => s + Number(l.total_revenue ?? 0), 0);
      const wonRatio = contacts.filter((l) => l.status === 'Client').length / Math.max(1, contacts.length);
      const engagement = clampPct(wonRatio * 100 + Math.min(20, revenue / 1000));
      return { company, contacts, revenue, engagement };
    }).sort((a, b) => b.revenue - a.revenue);
  }, [leads]);

  const filtered = accounts.filter((a) => a.company.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-[1600px] mx-auto space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <div className="text-[12px] text-[var(--fg-muted)]">Sales</div>
          <h1 className="text-[34px] sm:text-[44px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)] leading-tight">
            Companies
          </h1>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-[var(--fg-muted)]" aria-hidden="true" />
          <Input
            variant="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type Company Name or ID"
            className="pl-9"
            aria-label="Search companies"
          />
        </div>
      </div>

      <ul className="space-y-2">
        {filtered.length === 0 && (
          <li className="rounded-[var(--radius-xl)] border border-dashed border-[var(--border)] p-8 text-center text-[var(--fg-muted)]">
            No companies match. Add a company by creating a lead with a company name.
          </li>
        )}
        {filtered.map((a) => (
          <li
            key={a.company}
            className={cn(
              'flex items-center gap-4 p-4',
              'rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
              'shadow-[var(--shadow-card)]',
              'hover:bg-[var(--surface-sunken)] transition-colors duration-[var(--duration-fast)]',
            )}
          >
            <span className="grid place-items-center size-10 rounded-[var(--radius-full)] bg-[var(--surface-sunken)] text-[var(--fg)]">
              <Building2 className="size-4" />
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[14px] font-semibold text-[var(--fg)] truncate">{a.company}</span>
                <Badge variant={statusVariant(a.contacts[0]?.status ?? '')} size="sm">
                  {a.contacts[0]?.status ?? '—'}
                </Badge>
              </div>
              <div className="text-[11px] text-[var(--fg-muted)] truncate">
                {a.contacts.length} contact{a.contacts.length === 1 ? '' : 's'} · {formatCurrency(a.revenue)} total
              </div>
            </div>
            <MetricArc value={a.engagement} size={110} thickness={8} showValue label="Engagement" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function clampPct(n: number) { return Math.max(0, Math.min(100, n)); }
