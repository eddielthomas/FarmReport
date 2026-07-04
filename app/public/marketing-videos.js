/* RWR marketing-video mounter.
 * Replaces every [data-screenshot] placeholder with its premium Remotion
 * video from /media/<key>.mp4 (poster /media/<key>.jpg).
 *
 * Two placeholder shapes are supported:
 *   1. Standalone banner: the element itself is the slot
 *      (e.g. <div class="screenshot-placeholder" data-screenshot="solutions-overview">).
 *   2. Split row: the element is a wrapper whose ".visual" child is the slot
 *      (e.g. <div class="split" data-screenshot="solutions-leak-detection"> … <div class="visual">).
 *
 * Idempotent: skips any slot that already holds a <video> (so hand-embedded
 * pages like index.html are never double-mounted).
 */
(function () {
  function mount() {
    var nodes = document.querySelectorAll('[data-screenshot]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute('data-screenshot');
      if (!key) continue;

      var inner = el.querySelector('.visual');
      var slot = inner || el;
      if (slot.querySelector('video')) continue; // already mounted / hand-embedded

      var v = document.createElement('video');
      v.autoplay = true; v.muted = true; v.loop = true;
      v.playsInline = true; v.setAttribute('playsinline', '');
      v.setAttribute('muted', '');
      v.preload = 'metadata';
      v.poster = '/media/' + key + '.jpg';

      // object-fit:contain — show the WHOLE composition, centered, never
      // clipped. The video bg (#05070d) matches the Remotion canvas bg, so any
      // letterbox bars are seamless with the cinematic frame.
      v.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;' +
        'object-fit:contain;object-position:center;display:block;' +
        'background:#05070d;border-radius:inherit;z-index:1;';

      // WebM (VP9) first for ~30-50% smaller payload, MP4 (H.264) fallback.
      var webm = document.createElement('source');
      webm.src = '/media/' + key + '.webm';
      webm.type = 'video/webm';
      v.appendChild(webm);
      var mp4 = document.createElement('source');
      mp4.src = '/media/' + key + '.mp4';
      mp4.type = 'video/mp4';
      v.appendChild(mp4);

      var cs = window.getComputedStyle(slot);
      if (cs.position === 'static') slot.style.position = 'relative';
      slot.style.overflow = 'hidden';
      slot.appendChild(v);

      // Best-effort autoplay kick (muted autoplay is allowed, but be safe).
      var p = v.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    }
  }

  if (document.readyState !== 'loading') mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
