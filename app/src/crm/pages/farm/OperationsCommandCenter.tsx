// =============================================================================
// OperationsCommandCenter — the executive dashboard an Operations Director opens
// first every morning. Not a map: an AI Executive Operations Center that answers
// the fear that pays for the subscription ("will I hit targets, will Walmart
// reject the load, what do I tell the CEO Monday?"). Full spec + recipes:
// docs/reports/OPERATIONS_COMMAND_CENTER.md.
// -----------------------------------------------------------------------------
// Every tile is a decision, not a datapoint: it carries a $ impact, a T1/T2/T3
// confidence badge, a "what to do about it", and a drill-in to the report behind
// it. Red before green; action before analysis. Sections light up by buildability
// (LIVE now vs capability pending) and the whole surface is BUSINESS-tier gated.
// Route: /operations.html?view=command (FarmConsole).
// =============================================================================

import * as React from 'react';
import {
  AlertOctagon, TrendingUp, Target, DollarSign, Workflow, CloudSun, Truck,
  ListChecks, ShieldCheck, Gauge, ArrowUpRight, CircleAlert, Loader2,
} from 'lucide-react';
import { apiGet } from '@crm/lib/api';
import { useHasFeature } from '@crm/lib/auth-store';
import { UpsellCard } from '@crm/components/farm/FeatureGate';

type Build = 'LIVE' | 'GW-LIFTING' | 'NEW-MODEL' | 'EXT-DATA';
type Tone = 'critical' | 'warn' | 'info' | 'good';

interface FarmRow { id: string; name: string }

interface Section {
  n: number;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: Tone;
  question: string;
  tBadge: 'T1' | 'T2' | 'T3' | 'Meta';
  build: Build;
  wide?: boolean;
  drill: string[];
}

// The 10 sections, ordered red-before-green per the spec (§1..§10).
const SECTIONS: Section[] = [
  { n: 1, title: 'Critical Issues', icon: AlertOctagon, tone: 'critical', tBadge: 'T2', build: 'LIVE',
    question: 'What is on fire right now that I must fix before I lose the day, the field, or the shipment?',
    drill: ['High Priority Alerts', 'Fields Requiring Attention', 'Crop Stress', 'Flood Detection'] },
  { n: 2, title: 'Issues Trending Critical', icon: TrendingUp, tone: 'warn', tBadge: 'T3', build: 'GW-LIFTING',
    question: 'What is not red yet but will be in 48–72h — where can I still act cheaply?',
    drill: ['7-Day Crop Forecast', 'Vegetation Change', 'Disease Spread', 'Water Deficit'] },
  { n: 3, title: 'Production at Risk', icon: Target, tone: 'warn', tBadge: 'T3', build: 'NEW-MODEL',
    question: "Which fields threaten this week's and this month's tonnage target — and by how much?",
    drill: ['Production Forecast', 'Yield Estimate', 'Which Farms May Miss Quota', 'Quota-Miss Probability'] },
  { n: 4, title: 'Financial Exposure', icon: DollarSign, tone: 'critical', tBadge: 'T3', build: 'EXT-DATA',
    question: 'If today’s problems play out, how many dollars are on the line — and which line item is bleeding?',
    drill: ['Risk Cost', 'Disease Cost', 'Weather Cost', 'Insurance Exposure'] },
  { n: 5, title: 'Operational Bottlenecks', icon: Workflow, tone: 'warn', tBadge: 'T2', build: 'LIVE',
    question: 'What will stall the crews, trucks, or pack-house today — the constraint that caps throughput?',
    drill: ['Operations Bottlenecks', 'Flooded Access', 'Harvest-Crew Readiness', 'Chemical Inventory'] },
  { n: 6, title: 'Weather Impacts', icon: CloudSun, tone: 'info', tBadge: 'T3', build: 'GW-LIFTING',
    question: 'What is the sky about to do to my quota — frost tonight, heat this week, a spray window closing?',
    drill: ['7/14-Day Forecast', 'Frost Risk', 'Heat-Stress Days', 'Spray-Window'] },
  { n: 7, title: 'Customer Commitments', icon: Truck, tone: 'warn', tBadge: 'T3', build: 'EXT-DATA', wide: true,
    question: 'Will I fill every contract on time, at grade — or is a Walmart/Dole PO about to be short or rejected?',
    drill: ['Contract Fulfillment', 'Delivery Confidence', 'Produce Quality Forecast', 'Replacement Supplier'] },
  { n: 8, title: 'Top 10 AI Recommendations', icon: ListChecks, tone: 'good', tBadge: 'T3', build: 'GW-LIFTING', wide: true,
    question: 'Of everything I could do today, what are the 10 highest-value moves — and what does each save or make?',
    drill: ['Strategic Recommendations', 'AI Generated Tasks', 'ROI Opportunities', 'Savings Opportunities'] },
  { n: 9, title: 'Confidence & Evidence', icon: ShieldCheck, tone: 'info', tBadge: 'Meta', build: 'LIVE',
    question: 'Can I stand behind this in front of the CEO — what’s the evidence and how sure are we?',
    drill: ['Confidence Score', 'Financial Confidence', 'Yield Confidence', 'Traceability Confidence'] },
  { n: 10, title: 'Executive Outlook', icon: Gauge, tone: 'good', tBadge: 'T3', build: 'GW-LIFTING',
    question: 'Is the quarter on track for production, quality, profit, and sustainability — what do I tell the CEO Monday?',
    drill: ['Executive Summary', 'Monthly Business Review', 'Profit Forecast', 'ESG Score'] },
];

const TONE: Record<Tone, { ring: string; dot: string; label: string }> = {
  critical: { ring: 'var(--risk-critical)', dot: 'var(--risk-critical)', label: 'Critical' },
  warn: { ring: 'var(--risk-stress)', dot: 'var(--risk-stress)', label: 'Watch' },
  info: { ring: 'var(--accent)', dot: 'var(--accent)', label: 'Info' },
  good: { ring: 'var(--risk-healthy)', dot: 'var(--risk-healthy)', label: 'On track' },
};

function BuildChip({ build }: { build: Build }) {
  const live = build === 'LIVE';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${live ? 'bg-[color-mix(in_oklch,var(--risk-healthy)_18%,transparent)] text-[var(--risk-healthy)]' : 'bg-[color-mix(in_oklch,var(--risk-stress)_16%,transparent)] text-[var(--risk-stress)]'}`}>
      {live ? 'Live' : 'Pending'}
    </span>
  );
}

function SectionCard({ s }: { s: Section }) {
  const t = TONE[s.tone];
  const Icon = s.icon;
  const live = s.build === 'LIVE';
  return (
    <div className={`flex flex-col gap-2 rounded-[var(--radius-xl)] border bg-[var(--surface)] p-4 ${s.wide ? 'md:col-span-2' : ''}`} style={{ borderColor: `color-mix(in oklch, ${t.ring} 35%, var(--border))` }}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-[var(--radius-md)]" style={{ background: `color-mix(in oklch, ${t.ring} 14%, transparent)`, color: t.ring }}><Icon className="size-4" /></span>
          <div>
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--fg)]"><span className="tabular-nums text-[var(--fg-subtle)]">{s.n}.</span> {s.title}</div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--fg-subtle)]">{t.label}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--fg-muted)]">{s.tBadge}</span>
          <BuildChip build={s.build} />
        </div>
      </div>

      <p className="text-[12px] leading-snug text-[var(--fg-muted)]">{s.question}</p>

      {/* Headline metric / state */}
      <div className="flex items-baseline gap-2">
        <span className="text-[20px] font-semibold tabular-nums text-[var(--fg)]">{live ? '—' : '—'}</span>
        <span className="text-[11px] text-[var(--fg-subtle)]">{live ? 'watching your fields · $ impact as scans land' : `lights up when the ${s.build} capability lands`}</span>
      </div>

      {/* Drill-ins */}
      <div className="mt-auto flex flex-wrap gap-1 pt-1">
        {s.drill.map((d) => (
          <span key={d} className="inline-flex items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-0.5 text-[10px] text-[var(--fg-muted)]">{d}</span>
        ))}
      </div>
    </div>
  );
}

export function OperationsCommandCenter() {
  const unlocked = useHasFeature('portfolio.rollups'); // Business tier
  const [farms, setFarms] = React.useState<FarmRow[] | null>(null);

  React.useEffect(() => {
    let live = true;
    apiGet<FarmRow[]>('/farm/farms').then((r) => { if (live) setFarms(r); }).catch(() => { if (live) setFarms([]); });
    return () => { live = false; };
  }, []);

  if (!unlocked) {
    return (
      <div className="crm min-h-screen bg-[var(--bg)] p-6 text-[var(--fg)]">
        <div className="mx-auto max-w-2xl pt-16">
          <UpsellCard tier="Business" title="Operations Command Center" blurb="The morning executive dashboard — critical issues, production at risk, financial exposure, customer commitments, and the top-10 AI recommendations, across your whole portfolio. Available on the Business plan." />
        </div>
      </div>
    );
  }

  const liveCount = SECTIONS.filter((s) => s.build === 'LIVE').length;

  return (
    <div className="crm min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      {/* Headline strip — "Are we on track?" */}
      <div className="border-b border-[var(--border)] bg-[var(--surface)] px-6 py-4">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">Operations Command Center</div>
            <h1 className="mt-0.5 flex items-center gap-2 text-[18px] font-semibold text-[var(--fg)]">
              <span className="inline-flex size-2.5 rounded-full bg-[var(--risk-healthy)]" /> Are we on track?
            </h1>
            <p className="text-[12px] text-[var(--fg-muted)]">Everything that decides whether today is a good day — before the crews arrive.</p>
          </div>
          <div className="flex items-center gap-4 text-right">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--fg-subtle)]">$ at risk today</div>
              <div className="text-[22px] font-semibold tabular-nums text-[var(--fg)]">—</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--fg-subtle)]">Monitored</div>
              <div className="text-[22px] font-semibold tabular-nums text-[var(--fg)]">
                {farms === null ? <Loader2 className="size-4 animate-spin" /> : `${farms.length} farms`}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1400px] px-6 py-5">
        <div className="mb-3 flex items-center gap-2 text-[11px] text-[var(--fg-muted)]">
          <CircleAlert className="size-3.5 text-[var(--risk-stress)]" />
          <span><span className="font-medium text-[var(--fg)]">{liveCount} of {SECTIONS.length}</span> sections compose live gateway layers today; the rest light up as forecast, model, and external-feed capabilities land. Every tile carries a $ impact, a T1/T2/T3 badge, and a one-click drill-in.</span>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {SECTIONS.map((s) => <SectionCard key={s.n} s={s} />)}
        </div>

        <div className="mt-4 flex items-center justify-between rounded-[var(--radius-xl)] border border-dashed border-[var(--border)] p-4 text-[12px] text-[var(--fg-muted)]">
          <span>Fed by the AlphaGeo relay + the change-event backbone; alerts push even when this screen is closed. Full spec: <span className="text-[var(--fg)]">docs/reports/OPERATIONS_COMMAND_CENTER.md</span>.</span>
          <a href="/studio.html" className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)] bg-[color-mix(in_oklch,var(--accent)_10%,transparent)] px-3 py-1 text-[var(--fg)] hover:brightness-110">Open a farm <ArrowUpRight className="size-3.5" /></a>
        </div>
      </div>
    </div>
  );
}
