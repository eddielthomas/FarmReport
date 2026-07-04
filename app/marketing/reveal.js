/* RWR Sentinel — premium polish wiring
 * Scroll-reveal + cursor glow + scroll progress.
 *
 * Loaded as <script type="module" src="./marketing/reveal.js"></script>
 * after the existing site.js. Keeps a clean cooperation with site.js
 * (which uses the legacy `.in` class) by writing `.reveal-in` instead.
 * Honors `prefers-reduced-motion: reduce`.
 */

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── SCROLL REVEAL ────────────────────────────────────────────────── */
function wireReveal() {
  const els = document.querySelectorAll('.reveal');
  if (!els.length) return;

  if (REDUCED || !('IntersectionObserver' in window)) {
    els.forEach(el => el.classList.add('reveal-in'));
    return;
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('reveal-in');
        io.unobserve(e.target);
      }
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });

  els.forEach(el => io.observe(el));
}

/* ── CURSOR GLOW (hero areas only) ────────────────────────────────── */
function wireCursorGlow() {
  if (REDUCED) return;
  const heroes = document.querySelectorAll('.home-hero, .page-hero');
  if (!heroes.length) return;

  heroes.forEach(hero => {
    hero.classList.add('hero-cursor-glow');
    let rafId = 0;
    let pendingX = 50, pendingY = 50;

    const onMove = (ev) => {
      const rect = hero.getBoundingClientRect();
      pendingX = ((ev.clientX - rect.left) / rect.width) * 100;
      pendingY = ((ev.clientY - rect.top) / rect.height) * 100;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        hero.style.setProperty('--cx', pendingX + '%');
        hero.style.setProperty('--cy', pendingY + '%');
        rafId = 0;
      });
    };
    const onLeave = () => {
      hero.style.setProperty('--cx', '50%');
      hero.style.setProperty('--cy', '50%');
    };

    hero.addEventListener('mousemove', onMove, { passive: true });
    hero.addEventListener('mouseleave', onLeave, { passive: true });
  });
}

/* ── SCROLL PROGRESS BAR ──────────────────────────────────────────── */
function wireScrollProgress() {
  if (REDUCED) return;
  let bar = document.querySelector('.scroll-progress');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'scroll-progress';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);
  }
  let ticking = false;
  const update = () => {
    const h = document.documentElement;
    const max = (h.scrollHeight - h.clientHeight) || 1;
    const pct = Math.max(0, Math.min(100, (window.scrollY / max) * 100));
    bar.style.width = pct + '%';
    ticking = false;
  };
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  }, { passive: true });
  update();
}

/* ── BOOT ─────────────────────────────────────────────────────────── */
function boot() {
  wireReveal();
  wireCursorGlow();
  wireScrollProgress();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
