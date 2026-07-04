// =============================================================================
// BillingPanel — account subscription & invoices (Stripe self-serve).
// -----------------------------------------------------------------------------
// Wired to /api/v1/billing/*. Shows the tenant's current plan, the plan catalog
// (Subscribe → hosted Stripe Checkout), a "Manage billing" button (hosted Stripe
// Customer Portal), and the invoice history. Degrades to an honest, actionable
// empty-state when Stripe isn't configured (no keys / SDK) instead of erroring.
// =============================================================================

import { useQuery, useMutation } from '@tanstack/react-query';
import { CreditCard, ExternalLink, Check, Loader2, ReceiptText, ShieldAlert } from 'lucide-react';
import { apiGet, apiPost } from '@crm/lib/api';

interface PlanDef {
  key: string; name: string; blurb: string; features: string[];
  featured: boolean; contactSales: boolean; purchasable: boolean;
}
interface SubStatus {
  configured: boolean; hasCustomer: boolean; canManage: boolean;
  activePlanKey: string | null;
  subscription: null | {
    plan_key: string | null; status: string; current_period_end: string | null;
    cancel_at_period_end: boolean;
  };
}
interface Invoice {
  stripe_invoice_id: string; number: string | null; status: string | null;
  amount_due: number | null; amount_paid: number | null; currency: string;
  hosted_invoice_url: string | null; invoice_pdf: string | null; created_at: string;
}

const money = (minor: number | null, cur = 'usd') =>
  minor == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(minor / 100);
const statusTint = (s: string | null | undefined) =>
  s === 'active' || s === 'trialing' || s === 'paid' ? 'var(--risk-healthy)'
  : s === 'past_due' || s === 'open' ? 'var(--risk-stress)'
  : s === 'canceled' || s === 'uncollectible' || s === 'void' ? 'var(--risk-critical)'
  : 'var(--fg-subtle)';

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-5 ${className}`}>{children}</div>;
}

export function BillingPanel() {
  const status = useQuery({ queryKey: ['billing', 'subscription'], queryFn: () => apiGet<SubStatus>('/billing/subscription') });
  const plansQ = useQuery({ queryKey: ['billing', 'plans'], queryFn: () => apiGet<{ configured: boolean; plans: PlanDef[] }>('/billing/plans') });
  const invoicesQ = useQuery({ queryKey: ['billing', 'invoices'], queryFn: () => apiGet<Invoice[]>('/billing/invoices') });

  const checkout = useMutation({
    mutationFn: (plan_key: string) => apiPost<{ url: string }>('/billing/checkout', { plan_key }),
    onSuccess: (d) => { if (d.url) window.location.href = d.url; },
  });
  const portal = useMutation({
    mutationFn: () => apiPost<{ url: string }>('/billing/portal', {}),
    onSuccess: (d) => { if (d.url) window.location.href = d.url; },
  });

  const s = status.data;
  const configured = s?.configured ?? plansQ.data?.configured ?? false;
  const active = s?.activePlanKey ?? null;
  const canManage = s?.canManage ?? false;

  return (
    <div className="crm h-full overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto max-w-[1100px] px-5 sm:px-8 py-6 space-y-6">
        <header className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[var(--tracking-widest)] text-[var(--fg-subtle)]">Account</div>
            <h1 className="text-[26px] font-semibold tracking-[var(--tracking-tight)] font-[var(--font-display)] flex items-center gap-2">
              <CreditCard className="size-6 text-[var(--accent)]" /> Billing &amp; Subscription
            </h1>
          </div>
          {configured && s?.hasCustomer && canManage && (
            <button
              onClick={() => portal.mutate()} disabled={portal.isPending}
              className="inline-flex items-center gap-2 rounded-[var(--radius-full)] border border-[var(--border-strong)] bg-[var(--surface)] px-4 py-2 text-[13px] font-semibold hover:border-[var(--accent)] transition-colors"
            >
              {portal.isPending ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />} Manage billing
            </button>
          )}
        </header>

        {/* Not-configured banner */}
        {!configured && (
          <Card className="border-dashed">
            <div className="flex items-start gap-3">
              <ShieldAlert className="size-5 text-[var(--risk-stress)] shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-[15px]">Billing isn't connected yet</div>
                <p className="text-[13px] text-[var(--fg-muted)] mt-1 max-w-[70ch]">
                  Stripe hasn't been configured for this environment. Add your Stripe keys
                  (<code className="font-mono text-[12px]">STRIPE_SECRET_KEY</code>, <code className="font-mono text-[12px]">STRIPE_PRICE_*</code>,
                  <code className="font-mono text-[12px]"> STRIPE_WEBHOOK_SECRET</code>) and run <code className="font-mono text-[12px]">npm install stripe</code>.
                  Plans below are shown for reference.
                </p>
              </div>
            </div>
          </Card>
        )}

        {/* Current subscription */}
        {configured && (
          <Card>
            <div className="text-[11px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-subtle)] mb-2">Current plan</div>
            {s?.subscription ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[20px] font-semibold capitalize">{s.subscription.plan_key ?? 'Subscription'}</div>
                  <div className="text-[12px] text-[var(--fg-muted)] mt-0.5">
                    {s.subscription.cancel_at_period_end ? 'Cancels' : 'Renews'}{' '}
                    {s.subscription.current_period_end ? new Date(s.subscription.current_period_end).toLocaleDateString() : '—'}
                  </div>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-full)] px-3 py-1 text-[12px] font-semibold"
                  style={{ color: statusTint(s.subscription.status), background: `color-mix(in oklch, ${statusTint(s.subscription.status)} 15%, transparent)` }}>
                  <span className="size-2 rounded-full" style={{ background: statusTint(s.subscription.status) }} />
                  {s.subscription.status}
                </span>
              </div>
            ) : (
              <div className="text-[13px] text-[var(--fg-muted)]">No active subscription. Choose a plan below to get started.</div>
            )}
          </Card>
        )}

        {/* Plan catalog */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {(plansQ.data?.plans ?? []).map((p) => {
            const isCurrent = active === p.key;
            return (
              <Card key={p.key} className={p.featured ? 'ring-1 ring-[var(--accent)]' : ''}>
                <div className="flex items-center justify-between">
                  <div className="text-[16px] font-semibold">{p.name}</div>
                  {p.featured && <span className="text-[10px] font-mono uppercase tracking-wide text-[var(--accent)]">Popular</span>}
                </div>
                <p className="text-[12px] text-[var(--fg-muted)] mt-1 min-h-[32px]">{p.blurb}</p>
                <ul className="mt-3 space-y-1.5">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-1.5 text-[12px] text-[var(--fg)]">
                      <Check className="size-3.5 text-[var(--risk-healthy)] mt-0.5 shrink-0" /> {f}
                    </li>
                  ))}
                </ul>
                <div className="mt-4">
                  {isCurrent ? (
                    <div className="w-full text-center rounded-[var(--radius-full)] bg-[var(--surface-sunken)] py-2 text-[13px] font-semibold text-[var(--fg-muted)]">Current plan</div>
                  ) : p.contactSales ? (
                    <a href="/contact.html" className="block w-full text-center rounded-[var(--radius-full)] border border-[var(--border-strong)] py-2 text-[13px] font-semibold hover:border-[var(--accent)] transition-colors">Contact sales</a>
                  ) : (
                    <button
                      onClick={() => checkout.mutate(p.key)}
                      disabled={!p.purchasable || !canManage || checkout.isPending}
                      title={!canManage ? 'Requires a billing admin' : !p.purchasable ? 'Price not configured' : undefined}
                      className="w-full inline-flex items-center justify-center gap-2 rounded-[var(--radius-full)] bg-[var(--accent)] text-[var(--fg-on-accent)] py-2 text-[13px] font-semibold shadow-[var(--shadow-accent)] hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {checkout.isPending && checkout.variables === p.key ? <Loader2 className="size-4 animate-spin" /> : null}
                      {p.purchasable ? `Subscribe` : 'Unavailable'}
                    </button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
        {checkout.isError && <div className="text-[12px] text-[var(--risk-critical)]">Couldn't start checkout. {(checkout.error as Error)?.message}</div>}

        {/* Invoices */}
        <Card>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-subtle)] mb-3">
            <ReceiptText className="size-4 text-[var(--accent)]" /> Invoices
          </div>
          {(invoicesQ.data?.length ?? 0) === 0 ? (
            <div className="text-[13px] text-[var(--fg-muted)]">No invoices yet. They appear here after your first billing cycle.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-[11px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-subtle)] text-left">
                    <th className="font-medium py-2 pr-3">Invoice</th>
                    <th className="font-medium py-2 pr-3">Date</th>
                    <th className="font-medium py-2 pr-3">Status</th>
                    <th className="font-medium py-2 pr-3 text-right">Amount</th>
                    <th className="font-medium py-2 pr-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {invoicesQ.data!.map((inv) => (
                    <tr key={inv.stripe_invoice_id} className="border-t border-[var(--border)]">
                      <td className="py-2.5 pr-3 font-mono text-[12px]">{inv.number ?? inv.stripe_invoice_id.slice(0, 14)}</td>
                      <td className="py-2.5 pr-3 text-[var(--fg-muted)]">{new Date(inv.created_at).toLocaleDateString()}</td>
                      <td className="py-2.5 pr-3"><span style={{ color: statusTint(inv.status) }}>{inv.status}</span></td>
                      <td className="py-2.5 pr-3 tabular-nums text-right">{money(inv.amount_paid ?? inv.amount_due, inv.currency)}</td>
                      <td className="py-2.5 pr-3 text-right">
                        {inv.hosted_invoice_url && <a href={inv.hosted_invoice_url} target="_blank" rel="noreferrer" className="text-[var(--accent)] inline-flex items-center gap-1">View <ExternalLink className="size-3" /></a>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
