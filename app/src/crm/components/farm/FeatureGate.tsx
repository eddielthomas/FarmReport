// =============================================================================
// FeatureGate — plan-tier gating for the UI (Basic / Pro / Business).
// -----------------------------------------------------------------------------
// Reads the tenant's entitlements (loaded from /billing/entitlements) via
// useHasFeature. When the feature is included, renders children; otherwise either
// hides them (mode="hide") or shows an inline upsell (mode="upsell"). The server's
// requireFeature gate is the real boundary — this is UX (show / hide / upsell).
// =============================================================================

import * as React from 'react';
import { Lock, Sparkles } from 'lucide-react';
import { useHasFeature } from '@crm/lib/auth-store';
import { cn } from '@crm/lib/utils';

/** Small lock chip marking a feature that needs a higher tier (Pro / Business). */
export function UpsellPill({ tier, className }: { tier: 'Pro' | 'Business'; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border border-[color-mix(in_oklch,var(--accent)_45%,transparent)] bg-[color-mix(in_oklch,var(--accent)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)]', className)}>
      <Lock className="size-2.5" /> {tier}
    </span>
  );
}

/** Full inline upsell card shown in place of a gated surface. */
export function UpsellCard({ tier, title, blurb, className }: { tier: 'Pro' | 'Business'; title?: string; blurb?: string; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-[color-mix(in_oklch,var(--accent)_40%,transparent)] bg-[color-mix(in_oklch,var(--accent)_6%,transparent)] p-5 text-center', className)}>
      <Sparkles className="size-5 text-[var(--accent)]" />
      <div className="text-[13px] font-semibold text-[var(--fg)]">{title ?? `A ${tier} feature`}</div>
      {blurb && <div className="max-w-[42ch] text-[12px] text-[var(--fg-muted)]">{blurb}</div>}
      <a href="/operations.html?view=billing" className="mt-1 inline-flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-[var(--fg-on-accent)] hover:brightness-110">
        <Lock className="size-3.5" /> Upgrade to {tier}
      </a>
    </div>
  );
}

export function FeatureGate({
  feature, tier, mode = 'hide', title, blurb, children, className,
}: {
  feature: string;
  tier: 'Pro' | 'Business';
  /** hide = render nothing when locked; upsell = show an UpsellCard. */
  mode?: 'hide' | 'upsell';
  title?: string;
  blurb?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const ok = useHasFeature(feature);
  if (ok) return <>{children}</>;
  if (mode === 'upsell') return <UpsellCard tier={tier} title={title} blurb={blurb} className={className} />;
  return null;
}
