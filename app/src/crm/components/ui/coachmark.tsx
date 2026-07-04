// =============================================================================
// Coach-mark tour primitive.
// -----------------------------------------------------------------------------
// Pulses a halo over a target DOM element (resolved by data-coachmark="<key>"
// attribute) and floats a tooltip card alongside it. Multi-step, with prev /
// next / skip / progress dots. Persists "seen" state in localStorage keyed by
// the tour id so each user only sees a given tour once.
//
// Usage:
//   <CoachmarkTour
//     tourId="sales.v1"
//     steps={[
//       { target: 'sales.kpis',      title: 'Your day in one glance', body: '...' },
//       { target: 'sales.pipeline',  title: 'Drag leads through stages', body: '...' },
//     ]}
//   />
//
//   <button data-coachmark="sales.kpis">…</button>
//
// Anywhere inside the surface, drop a <CoachmarkLauncher tourId="sales.v1"/>
// in the TopNav area for the "?" help button that re-triggers the tour.
// =============================================================================

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X, HelpCircle } from 'lucide-react';
import { cn } from '@crm/lib/utils';

export interface CoachmarkStep {
  /** data-coachmark value to anchor against. If absent, step is centered on screen. */
  target?: string;
  title: string;
  body: string;
  /** Override placement; default "auto" picks the side with the most room. */
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  /** Accent color for the halo + progress dot. Falls back to signal-cyan. */
  accent?: string;
}

interface TourProps {
  tourId: string;
  steps: CoachmarkStep[];
  /** Optional override — if absent, tour auto-opens once per tourId via localStorage. */
  open?: boolean;
  onClose?: () => void;
}

const LS_PREFIX = 'rwr.coachmark.';

export function CoachmarkTour({ tourId, steps, open: controlledOpen, onClose }: TourProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const open = controlledOpen ?? internalOpen;

  // Auto-open once per tourId.
  useEffect(() => {
    if (controlledOpen !== undefined) return;
    if (typeof window === 'undefined') return;
    const seen = localStorage.getItem(LS_PREFIX + tourId);
    if (!seen) setInternalOpen(true);
  }, [tourId, controlledOpen]);

  const close = () => {
    if (typeof window !== 'undefined') localStorage.setItem(LS_PREFIX + tourId, '1');
    setInternalOpen(false);
    setStepIdx(0);
    onClose?.();
  };

  if (!open || steps.length === 0) return null;
  const step = steps[Math.min(stepIdx, steps.length - 1)];
  const isLast = stepIdx >= steps.length - 1;

  return (
    <CoachmarkOverlay
      step={step}
      stepIdx={stepIdx}
      total={steps.length}
      onPrev={() => setStepIdx((i) => Math.max(0, i - 1))}
      onNext={() => (isLast ? close() : setStepIdx((i) => i + 1))}
      onSkip={close}
      isLast={isLast}
      tourId={tourId}
    />
  );
}

// -----------------------------------------------------------------------------
// Visual layer — backdrop with cut-out halo + floating tooltip.
// -----------------------------------------------------------------------------
interface OverlayProps {
  step: CoachmarkStep;
  stepIdx: number;
  total: number;
  isLast: boolean;
  tourId: string;
  onPrev: () => void;
  onNext: () => void;
  onSkip: () => void;
}

function CoachmarkOverlay(p: OverlayProps) {
  const { step, stepIdx, total, isLast, tourId, onPrev, onNext, onSkip } = p;
  const accent = step.accent ?? 'var(--signal-cyan)';
  const cardRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number; placement: string }>({
    top: 0, left: 0, placement: 'center',
  });

  // Resolve target rect each time step changes or on resize.
  useLayoutEffect(() => {
    function resolve() {
      if (!step.target) { setRect(null); return; }
      const el = document.querySelector<HTMLElement>(`[data-coachmark="${step.target}"]`);
      if (!el) { setRect(null); return; }
      const r = el.getBoundingClientRect();
      setRect(r);
      // Scroll into view if offscreen.
      if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
    }
    resolve();
    const onResize = () => resolve();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    const id = window.setInterval(resolve, 250); // catches lazy DOM mounts
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
      window.clearInterval(id);
    };
  }, [step.target, stepIdx]);

  // Compute card position relative to target.
  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const cardW = cardRef.current.offsetWidth || 320;
    const cardH = cardRef.current.offsetHeight || 180;
    const gap = 16;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (!rect) {
      setCardPos({ top: vh / 2 - cardH / 2, left: vw / 2 - cardW / 2, placement: 'center' });
      return;
    }

    const placement = step.placement === 'auto' || !step.placement
      ? pickPlacement(rect, cardW, cardH, vw, vh, gap)
      : step.placement;

    let top = 0; let left = 0;
    switch (placement) {
      case 'top':
        top = rect.top - cardH - gap;
        left = rect.left + rect.width / 2 - cardW / 2;
        break;
      case 'bottom':
        top = rect.bottom + gap;
        left = rect.left + rect.width / 2 - cardW / 2;
        break;
      case 'left':
        top = rect.top + rect.height / 2 - cardH / 2;
        left = rect.left - cardW - gap;
        break;
      case 'right':
        top = rect.top + rect.height / 2 - cardH / 2;
        left = rect.right + gap;
        break;
    }
    // Clamp inside viewport.
    top = Math.max(12, Math.min(vh - cardH - 12, top));
    left = Math.max(12, Math.min(vw - cardW - 12, left));
    setCardPos({ top, left, placement });
  }, [rect, step.placement, stepIdx]);

  // Keyboard: arrows + escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape')      onSkip();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') onNext();
      else if (e.key === 'ArrowLeft') onPrev();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNext, onPrev, onSkip]);

  return (
    <div
      className="fixed inset-0 z-[9999] pointer-events-none"
      aria-live="polite"
      role="dialog"
      aria-labelledby={`coach-${tourId}-${stepIdx}-title`}
    >
      {/* Dimming layer with cut-out for the target */}
      <svg className="absolute inset-0 w-full h-full pointer-events-auto" onClick={onSkip}>
        <defs>
          <mask id={`m-${tourId}-${stepIdx}`}>
            <rect width="100%" height="100%" fill="white" />
            {rect && (
              <rect
                x={Math.max(0, rect.left - 6)}
                y={Math.max(0, rect.top - 6)}
                width={rect.width + 12}
                height={rect.height + 12}
                rx="10"
                ry="10"
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(3,6,9,0.62)" mask={`url(#m-${tourId}-${stepIdx})`} />
      </svg>

      {/* Pulsing halo on target */}
      {rect && (
        <div
          className="absolute pointer-events-none"
          style={{
            top: rect.top - 8,
            left: rect.left - 8,
            width: rect.width + 16,
            height: rect.height + 16,
            border: `2px solid ${accent}`,
            borderRadius: 12,
            boxShadow: `0 0 0 4px ${accent}22, 0 0 32px ${accent}66`,
            animation: 'coachmark-pulse 1.6s ease-in-out infinite',
          }}
        />
      )}

      {/* Tooltip card */}
      <div
        ref={cardRef}
        className="absolute pointer-events-auto w-[320px] max-w-[calc(100vw-24px)] rounded-lg border border-[var(--rwr-borderH)] glass-3 p-4 shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
        style={{ top: cardPos.top, left: cardPos.left }}
      >
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="size-2 rounded-full shrink-0" style={{ background: accent, boxShadow: `0 0 12px ${accent}` }} />
            <span className="text-[9px] font-mono uppercase tracking-wider text-[var(--rwr-t2)]">
              {stepIdx + 1} of {total}
            </span>
          </div>
          <button
            onClick={onSkip}
            className="size-5 flex items-center justify-center rounded text-[var(--rwr-t2)] hover:text-[var(--signal-red)] hover:bg-[var(--accent)] transition-colors"
            aria-label="Close tour"
          >
            <X className="size-3" />
          </button>
        </div>
        <h3
          id={`coach-${tourId}-${stepIdx}-title`}
          className="text-[15px] font-semibold text-foreground mb-1.5"
          style={{ color: accent }}
        >
          {step.title}
        </h3>
        <p className="text-[12px] text-[var(--rwr-t1)] leading-relaxed mb-3">{step.body}</p>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            {Array.from({ length: total }).map((_, i) => (
              <span
                key={i}
                className={cn(
                  'size-1.5 rounded-full transition-all',
                  i === stepIdx ? 'w-6' : 'opacity-30',
                )}
                style={{ background: accent }}
              />
            ))}
          </div>
          <div className="flex items-center gap-1">
            {stepIdx > 0 && (
              <button
                onClick={onPrev}
                className="h-7 px-2 flex items-center gap-0.5 rounded text-[10px] font-mono uppercase tracking-wider text-[var(--rwr-t2)] hover:text-foreground hover:bg-[var(--accent)] transition-colors"
              >
                <ChevronLeft className="size-3" />Back
              </button>
            )}
            <button
              onClick={onNext}
              className="h-7 px-3 flex items-center gap-1 rounded text-[10px] font-mono uppercase tracking-wider font-semibold transition-all"
              style={{
                background: accent + '22',
                color: accent,
                border: `1px solid ${accent}55`,
              }}
            >
              {isLast ? 'Got it' : 'Next'}
              {!isLast && <ChevronRight className="size-3" />}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes coachmark-pulse {
          0%, 100% { transform: scale(1);   opacity: 0.85; }
          50%      { transform: scale(1.03); opacity: 1;   }
        }
      `}</style>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Placement picker — chooses side with most room.
// -----------------------------------------------------------------------------
function pickPlacement(r: DOMRect, w: number, h: number, vw: number, vh: number, gap: number) {
  const space = {
    top:    r.top - gap,
    bottom: vh - r.bottom - gap,
    left:   r.left - gap,
    right:  vw - r.right - gap,
  };
  if (space.bottom >= h) return 'bottom' as const;
  if (space.top    >= h) return 'top'    as const;
  if (space.right  >= w) return 'right'  as const;
  if (space.left   >= w) return 'left'   as const;
  return 'bottom' as const;
}

// -----------------------------------------------------------------------------
// CoachmarkLauncher — "?" pill that re-opens a tour on demand. Drop into TopNav.
// -----------------------------------------------------------------------------
export function CoachmarkLauncher({ tourId, label = 'Tour' }: { tourId: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => {
          if (typeof window !== 'undefined') localStorage.removeItem(LS_PREFIX + tourId);
          setOpen(true);
        }}
        className="size-6 flex items-center justify-center rounded text-[var(--rwr-t2)] hover:text-[var(--signal-cyan)] hover:bg-[var(--accent)] transition-colors"
        title={`Replay ${label}`}
        aria-label={`Replay ${label}`}
      >
        <HelpCircle className="size-3.5" />
      </button>
      {/* Companion tour mount handled by surface — launcher just clears the LS gate. */}
      {/* surfaces should also mount <CoachmarkTour> with same tourId so it auto-reopens */}
      {open && <span className="hidden" />}
    </>
  );
}

// -----------------------------------------------------------------------------
// useTour — hook for surfaces that want full control (open state + reset).
// -----------------------------------------------------------------------------
export function useTour(tourId: string) {
  const [open, setOpen] = useState(false);
  const start = () => {
    if (typeof window !== 'undefined') localStorage.removeItem(LS_PREFIX + tourId);
    setOpen(true);
  };
  const close = () => {
    if (typeof window !== 'undefined') localStorage.setItem(LS_PREFIX + tourId, '1');
    setOpen(false);
  };
  // Auto-open once if not seen.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!localStorage.getItem(LS_PREFIX + tourId)) setOpen(true);
  }, [tourId]);
  return { open, start, close, setOpen };
}
