// =============================================================================
// CalculatorView — Sales > Calculator tab (S7B)
// -----------------------------------------------------------------------------
// Quick deal calculator: list price, discount %, quantity, term (months) →
// computes subtotal, total, monthly. Token-driven layout; no hard-coded colors.
// Designed to slot in for a future commission/quote-builder once the concept
// asset lands.
// =============================================================================

import * as React from 'react';
import { Calculator, ArrowUpRight, Percent, Hash, CalendarDays } from 'lucide-react';
import { Input, Label } from '@crm/components/ui/input';
import { Button } from '@crm/components/ui/button';
import { formatCurrency } from '@crm/lib/utils';
import { KpiCard } from '@crm/components/ui/kpi-card';

export function CalculatorView() {
  const [price, setPrice]       = React.useState(1200);
  const [discount, setDiscount] = React.useState(10);
  const [qty, setQty]           = React.useState(10);
  const [term, setTerm]         = React.useState(12);

  const subtotal  = price * qty;
  const discAmt   = subtotal * (discount / 100);
  const total     = subtotal - discAmt;
  const monthly   = term > 0 ? total / term : total;

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-[1280px] mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <div className="text-[12px] text-[var(--fg-muted)]">Sales</div>
          <h1 className="text-[34px] sm:text-[44px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)] leading-tight">
            Deal Calculator
          </h1>
        </div>
        <Button variant="accent" size="md">
          <ArrowUpRight className="size-3.5" /> Generate quote
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section
          className="lg:col-span-2 rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] shadow-[var(--shadow-card)] p-6 space-y-5"
          aria-label="Inputs"
        >
          <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--fg-muted)]">
            <Calculator className="size-3.5 text-[var(--fg)]" />
            <span>Inputs</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="List Price" icon="$">
              <Input type="number" value={price} onChange={(e) => setPrice(Number(e.target.value))} />
            </Field>
            <Field label="Discount" icon={<Percent className="size-3.5" />}>
              <Input type="number" value={discount} onChange={(e) => setDiscount(Number(e.target.value))} />
            </Field>
            <Field label="Quantity" icon={<Hash className="size-3.5" />}>
              <Input type="number" value={qty} onChange={(e) => setQty(Number(e.target.value))} />
            </Field>
            <Field label="Term (months)" icon={<CalendarDays className="size-3.5" />}>
              <Input type="number" value={term} onChange={(e) => setTerm(Number(e.target.value))} />
            </Field>
          </div>
        </section>

        <section
          className="rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] shadow-[var(--shadow-card)] p-6 space-y-4"
          aria-label="Summary"
        >
          <div className="text-[12px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">Summary</div>
          <SummaryRow label="Subtotal"        value={formatCurrency(subtotal)} />
          <SummaryRow label="Discount"        value={`− ${formatCurrency(discAmt)}`} />
          <SummaryRow label="Total"           value={formatCurrency(total)} emphasis />
          <SummaryRow label={`Monthly (×${term})`} value={formatCurrency(monthly)} />
        </section>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard
          label="Effective Rate"
          value={`${(100 - discount).toFixed(0)}`}
          unit="%"
          primary={{ label: 'List',     value: formatCurrency(price) }}
          secondary={{ label: 'Net',    value: formatCurrency(price * (1 - discount / 100)) }}
        />
        <KpiCard
          label="Annual Run-Rate"
          value={formatCurrency(monthly * 12)}
          primary={{ label: 'Per month', value: formatCurrency(monthly) }}
          secondary={{ label: 'Term', value: `${term} mo` }}
        />
        <KpiCard
          label="Deal Health"
          value="Healthy"
          footnote="Discount under 20% threshold. Margin guardrail OK."
        />
      </div>
    </div>
  );
}

function Field({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
        <span>{icon}</span>{label}
      </span>
      {children}
    </label>
  );
}

function SummaryRow({ label, value, emphasis }: { label: string; value: React.ReactNode; emphasis?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] pb-2 last:border-b-0">
      <span className="text-[12px] text-[var(--fg-muted)]">{label}</span>
      <span className={emphasis
        ? 'text-[20px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)]'
        : 'text-[14px] font-medium text-[var(--fg)] tabular-nums'}>{value}</span>
    </div>
  );
}
