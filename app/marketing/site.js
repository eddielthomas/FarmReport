/* RWR Sentinel — shared marketing JS
 * Starfield canvas, nav scroll/mega/burger, scroll reveal, year stamp.
 * Loaded as <script type="module" src="./site.js" defer></script>
 */

// ── STARFIELD ───────────────────────────────────────────────────────
(function starfield(){
  const c = document.getElementById('stars');
  if(!c) return;
  const ctx = c.getContext('2d');
  let w=0,h=0,stars=[];
  const dpr = Math.min(window.devicePixelRatio||1, 2);
  function resize(){
    // NB: clientWidth/clientHeight are read-only (layout-derived) — assigning to
    // them throws in strict-mode modules and aborted resize() (starfield never
    // rendered). The canvas display size comes from CSS; we only need the
    // backing-store size here.
    w = window.innerWidth;
    h = Math.max(window.innerHeight, document.body.scrollHeight);
    c.width = w*dpr; c.height = h*dpr;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    const target = Math.floor((w*h)/9000);
    stars = new Array(target).fill(0).map(()=>({
      x: Math.random()*w,
      y: Math.random()*h,
      r: Math.random()*1.2 + 0.2,
      a: Math.random()*0.6 + 0.2,
      tw: Math.random()*0.02 + 0.005,
      ph: Math.random()*Math.PI*2,
      hue: Math.random() < 0.18 ? 'cyan' : (Math.random() < 0.32 ? 'violet' : 'white')
    }));
  }
  function frame(t){
    ctx.clearRect(0,0,w,h);
    for(const s of stars){
      const a = s.a + Math.sin((t*s.tw)+s.ph)*0.25;
      const col = s.hue==='cyan' ? `rgba(0,229,255,${Math.max(0,a)})`
                : s.hue==='violet' ? `rgba(167,139,250,${Math.max(0,a)})`
                : `rgba(232,237,248,${Math.max(0,a)})`;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(s.x,s.y,s.r,0,Math.PI*2);
      ctx.fill();
    }
    requestAnimationFrame(frame);
  }
  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);
})();

// ── NAV: scroll state, mega dropdowns, mobile drawer ────────────────
(function nav(){
  const navEl = document.querySelector('.nav');
  if(navEl){
    const onScroll = () => navEl.classList.toggle('scrolled', window.scrollY > 18);
    window.addEventListener('scroll', onScroll, {passive:true});
    onScroll();
  }

  // Mega dropdown — hover on desktop, click on touch
  document.querySelectorAll('.nav-item').forEach(item => {
    const trigger = item.querySelector('.nav-trigger');
    if(!trigger || !item.querySelector('.megapanel')) return;
    let timer = null;
    const open = () => { clearTimeout(timer); document.querySelectorAll('.nav-item.open').forEach(x => x!==item && x.classList.remove('open')); item.classList.add('open'); };
    const close = () => { timer = setTimeout(()=>item.classList.remove('open'), 180); };
    item.addEventListener('mouseenter', open);
    item.addEventListener('mouseleave', close);
    trigger.addEventListener('click', e => { e.preventDefault(); item.classList.toggle('open'); });
  });
  document.addEventListener('click', e => {
    if(!e.target.closest('.nav-item')) document.querySelectorAll('.nav-item.open').forEach(x => x.classList.remove('open'));
  });

  // Mobile burger
  const burger = document.querySelector('.nav-burger');
  const drawer = document.querySelector('.mobile-drawer');
  if(burger && drawer){
    burger.addEventListener('click', () => {
      const open = drawer.classList.toggle('open');
      burger.classList.toggle('open', open);
      document.body.style.overflow = open ? 'hidden' : '';
    });
    drawer.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
      drawer.classList.remove('open');
      burger.classList.remove('open');
      document.body.style.overflow = '';
    }));
  }
})();

// ── SCROLL REVEAL ───────────────────────────────────────────────────
(function reveal(){
  const els = document.querySelectorAll('.reveal');
  if(!('IntersectionObserver' in window) || !els.length){
    els.forEach(el => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(entries => {
    for(const e of entries){
      if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); }
    }
  }, {threshold:0.12, rootMargin:'0px 0px -60px 0px'});
  els.forEach(el => io.observe(el));
})();

// ── YEAR STAMP ──────────────────────────────────────────────────────
document.querySelectorAll('[data-year]').forEach(el => el.textContent = new Date().getFullYear());

// ── PILOT GATE (sessionStorage) ─────────────────────────────────────
(function gate(){
  const veil = document.getElementById('rwrGate');
  if(!veil) return;
  if(sessionStorage.getItem('rwr_gate_ok') === '1'){ veil.classList.add('hide'); return; }
  const inp = document.getElementById('rwrGateInput');
  const btn = document.getElementById('rwrGateBtn');
  const err = document.getElementById('rwrGateErr');
  const accept = () => {
    const v = (inp.value || '').trim();
    if(v === 'StarDateMay26'){
      sessionStorage.setItem('rwr_gate_ok','1');
      veil.classList.add('hide');
    } else {
      err.textContent = 'INVALID PASSCODE';
      inp.value = '';
      inp.focus();
    }
  };
  btn?.addEventListener('click', accept);
  inp?.addEventListener('keydown', e => { if(e.key==='Enter') accept(); });
  setTimeout(()=>inp?.focus(), 60);
})();
