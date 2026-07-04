/**
 * transition-fx.js
 *
 * Cinematic transition overlay that activates during engine swaps. Pure CSS
 * + minimal DOM. Listens for `transition:start` / `transition:end` window
 * events emitted by the engine host.
 *
 * @module features/transition-fx
 */

const STYLE_ID = 'rwr-transition-fx-styles';

/**
 * Inject the module's stylesheet exactly once.
 * @returns {void}
 */
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .rwr-tfx-root{
      position:absolute; inset:0;
      pointer-events:none;
      z-index:25;
      opacity:0;
      transition: opacity 200ms ease;
      will-change: opacity;
    }
    .rwr-tfx-root.is-on{ opacity:1; }

    .rwr-tfx-vignette{
      position:absolute; inset:0;
      background: radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.7) 100%);
      pointer-events:none;
    }

    .rwr-tfx-frost{
      position:absolute; inset:0;
      backdrop-filter: blur(0) saturate(100%);
      -webkit-backdrop-filter: blur(0) saturate(100%);
      transition: backdrop-filter 220ms ease, -webkit-backdrop-filter 220ms ease;
      pointer-events:none;
    }
    .rwr-tfx-root.is-on .rwr-tfx-frost{
      animation: rwr-tfx-frost-anim 700ms ease both;
    }
    @keyframes rwr-tfx-frost-anim{
      0%   { backdrop-filter: blur(0) saturate(100%);  -webkit-backdrop-filter: blur(0) saturate(100%); }
      45%  { backdrop-filter: blur(6px) saturate(140%); -webkit-backdrop-filter: blur(6px) saturate(140%); }
      100% { backdrop-filter: blur(0) saturate(100%);  -webkit-backdrop-filter: blur(0) saturate(100%); }
    }

    .rwr-tfx-rim{
      position:absolute; inset:0;
      box-shadow: inset 0 0 0 1px rgba(0,200,255,0.0);
      pointer-events:none;
      transition: box-shadow 180ms ease;
    }
    .rwr-tfx-root.is-on .rwr-tfx-rim{
      animation: rwr-tfx-rim-pulse 700ms ease both;
    }
    @keyframes rwr-tfx-rim-pulse{
      0%   { box-shadow: inset 0 0 0 1px rgba(0,200,255,0.0), inset 0 0 0 0 rgba(0,200,255,0.0); }
      30%  { box-shadow: inset 0 0 0 1px rgba(0,200,255,0.55), inset 0 0 28px 0 rgba(0,200,255,0.18); }
      70%  { box-shadow: inset 0 0 0 1px rgba(0,200,255,0.45), inset 0 0 36px 0 rgba(0,200,255,0.12); }
      100% { box-shadow: inset 0 0 0 1px rgba(0,200,255,0.0), inset 0 0 0 0 rgba(0,200,255,0.0); }
    }

    .rwr-tfx-scan{
      position:absolute;
      left:-2%; right:-2%;
      top:-12%;
      height:14%;
      pointer-events:none;
      opacity:0;
      background:
        linear-gradient(180deg,
          rgba(0,200,255,0)    0%,
          rgba(0,200,255,0.05) 30%,
          rgba(0,200,255,0.55) 50%,
          rgba(0,200,255,0.05) 70%,
          rgba(0,200,255,0)    100%);
      filter: blur(0.5px);
      mix-blend-mode: screen;
      transform: translate3d(0,0,0);
      will-change: transform, opacity;
    }
    .rwr-tfx-scan::before,
    .rwr-tfx-scan::after{
      content:"";
      position:absolute; left:0; right:0; height:1px;
      background: rgba(0,200,255,0.85);
      box-shadow: 0 0 12px rgba(0,200,255,0.7);
    }
    .rwr-tfx-scan::before{ top:48%; }
    .rwr-tfx-scan::after{ top:52%; opacity:0.6; }
    .rwr-tfx-root.is-on .rwr-tfx-scan{
      animation: rwr-tfx-scan-anim 600ms cubic-bezier(0.55, 0.1, 0.45, 0.95) both;
    }
    @keyframes rwr-tfx-scan-anim{
      0%   { transform: translateY(0);     opacity:0;   }
      10%  { opacity:0.9; }
      90%  { opacity:0.9; }
      100% { transform: translateY(900%);  opacity:0;   }
    }

    body.is-transitioning{ cursor: progress; }

    @media (prefers-reduced-motion: reduce){
      .rwr-tfx-root, .rwr-tfx-frost, .rwr-tfx-rim, .rwr-tfx-scan{
        transition: none !important;
        animation: none !important;
      }
      .rwr-tfx-root.is-on .rwr-tfx-frost,
      .rwr-tfx-root.is-on .rwr-tfx-rim,
      .rwr-tfx-root.is-on .rwr-tfx-scan{
        animation: none !important;
      }
      .rwr-tfx-root.is-on .rwr-tfx-rim{
        box-shadow: inset 0 0 0 1px rgba(0,200,255,0.35);
      }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Mount the cinematic transition overlay.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.container Element the overlay attaches to (typically the viewport)
 * @returns {{ destroy: () => void }}
 */
export function mountTransitionFx({ container }) {
  if (!container) throw new Error('mountTransitionFx: container is required');

  injectStyles();

  const root = document.createElement('div');
  root.className = 'rwr-tfx-root';
  root.setAttribute('aria-hidden', 'true');

  const vignette = document.createElement('div');
  vignette.className = 'rwr-tfx-vignette';

  const frost = document.createElement('div');
  frost.className = 'rwr-tfx-frost';

  const rim = document.createElement('div');
  rim.className = 'rwr-tfx-rim';

  const scan = document.createElement('div');
  scan.className = 'rwr-tfx-scan';

  root.appendChild(vignette);
  root.appendChild(frost);
  root.appendChild(rim);
  root.appendChild(scan);

  container.appendChild(root);

  let activeTimer = 0;

  /**
   * Trigger the start of a transition.
   * Restarts the CSS animations even when overlapping events arrive.
   */
  function start() {
    document.body.classList.add('is-transitioning');
    // Force a reflow trick to restart CSS animations cleanly.
    root.classList.remove('is-on');
    // eslint-disable-next-line no-unused-expressions
    void root.offsetWidth;
    root.classList.add('is-on');

    // Safety net: in case `transition:end` never fires we auto-clear.
    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = setTimeout(() => {
      root.classList.remove('is-on');
      document.body.classList.remove('is-transitioning');
      activeTimer = 0;
    }, 1600);
  }

  /**
   * End the transition gracefully.
   */
  function end() {
    if (activeTimer) { clearTimeout(activeTimer); activeTimer = 0; }
    root.classList.remove('is-on');
    document.body.classList.remove('is-transitioning');
  }

  function onStart(_ev) { start(); }
  function onEnd(_ev) { end(); }

  window.addEventListener('transition:start', onStart);
  window.addEventListener('transition:end',   onEnd);

  return {
    destroy() {
      window.removeEventListener('transition:start', onStart);
      window.removeEventListener('transition:end',   onEnd);
      if (activeTimer) { clearTimeout(activeTimer); activeTimer = 0; }
      document.body.classList.remove('is-transitioning');
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}

export default mountTransitionFx;
