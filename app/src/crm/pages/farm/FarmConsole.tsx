// =============================================================================
// FarmConsole — the farm surface router (Wave-2).
// -----------------------------------------------------------------------------
// The operations.html entry mounts this. It picks the active farm view from the
// URL query string so all farm screens live under one surface without new HTML
// entries:
//   /operations.html                 → Portfolio Dashboard (default)
//   /operations.html?view=onboard    → Onboarding Copilot
//   /operations.html?farm=<uuid>     → Farm Detail
// Navigation is plain hrefs (full reload) — simple, robust, and each view reads
// its own params. FarmDetail is loaded lazily so the surface still compiles if
// that screen isn't present yet.
// =============================================================================

import { lazy, Suspense } from 'react';
import { PortfolioDashboard } from './PortfolioDashboard';
import { OnboardingCopilot } from './OnboardingCopilot';

// Lazy so a missing FarmDetail module never breaks the whole surface.
const FarmDetail = lazy(() =>
  import('./FarmDetail')
    .then((m) => ({ default: m.FarmDetail }))
    .catch(() => ({ default: () => <MissingView name="Farm Detail" /> })),
);

function MissingView({ name }: { name: string }) {
  return (
    <div className="crm h-full grid place-items-center bg-[var(--bg)] text-[var(--fg-muted)]">
      <div className="text-center">
        <div className="text-[15px] font-semibold text-[var(--fg)]">{name} is coming online</div>
        <a href="/operations.html" className="text-[13px] text-[var(--accent)]">← Back to portfolio</a>
      </div>
    </div>
  );
}

export function FarmConsole() {
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const view = params.get('view');
  const farmId = params.get('farm');

  if (view === 'onboard') return <OnboardingCopilot />;
  if (farmId) {
    return (
      <Suspense fallback={<div className="crm h-full grid place-items-center bg-[var(--bg)] text-[var(--fg-subtle)]"><span className="animate-pulse text-[13px]">Loading farm…</span></div>}>
        <FarmDetail />
      </Suspense>
    );
  }
  return <PortfolioDashboard />;
}
