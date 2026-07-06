// =============================================================================
// ParcelCutaway — a slowly-rotating "geological cutaway" of a twin's parcel.
// -----------------------------------------------------------------------------
// Ported from the concept prototype's React-Three-Fiber scene, rewritten in raw
// three.js (already a dependency) so it needs no new packages:
//   • Top face   — Esri satellite composite over the twin's AOI center.
//   • Side faces — procedurally-drawn soil strata (topsoil→subsoil→clay→bedrock).
//   • Bottom     — dark.
// Map construction is guarded (WebGL can be unavailable in VMs / headless / with
// hardware-accel off) so it degrades to a static card instead of crashing the
// workspace — same pattern as FarmMap/GeometryPreview.
// =============================================================================

import * as React from 'react';
import * as THREE from 'three';
import { Layers3 } from 'lucide-react';
import { geomCenter, geomAreaAcres, type Twin } from '@crm/lib/twins-store';

function lngLatToTile(lng: number, lat: number, z: number) {
  const n = Math.pow(2, z);
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y, z };
}

// Compose a 4×4 grid of Esri World Imagery tiles into a single canvas texture.
function buildSatelliteTexture(center: [number, number], zoom: number, onReady: (t: THREE.Texture) => void) {
  const [lng, lat] = center;
  const t = lngLatToTile(lng, lat, zoom);
  const GRID = 4, TILE = 256, SIZE = GRID * TILE;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE; canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#1e2a15';
  ctx.fillRect(0, 0, SIZE, SIZE);
  const originX = Math.floor(t.x) - GRID / 2 + 1;
  const originY = Math.floor(t.y) - GRID / 2 + 1;
  let loaded = 0, cancelled = false;
  const total = GRID * GRID;
  const finish = () => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    if (!cancelled) onReady(tex);
  };
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const tx = originX + gx, ty = originY + gy;
      img.onload = () => { if (!cancelled) ctx.drawImage(img, gx * TILE, gy * TILE, TILE, TILE); if (++loaded === total) finish(); };
      img.onerror = () => { if (++loaded === total) finish(); };
      img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${ty}/${tx}`;
    }
  }
  return () => { cancelled = true; };
}

// Procedural soil-strata texture: horizon bands with grain + mottling.
function buildStrataTexture(): THREE.Texture {
  const W = 512, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  // Horizons top→bottom: topsoil, subsoil, clay, weathered rock, bedrock.
  const bands: Array<[number, string]> = [
    [0.16, '#5b4327'], // O/A topsoil (dark organic)
    [0.34, '#6f4f2c'], // A/B
    [0.55, '#8a5a2f'], // B subsoil (iron-rich)
    [0.74, '#9a7b52'], // C clay/loam
    [0.88, '#7c7266'], // weathered rock
    [1.0,  '#4f4a44'], // bedrock
  ];
  let prev = 0;
  for (const [stop, color] of bands) {
    const y0 = prev * H, y1 = stop * H;
    const grad = ctx.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, color);
    grad.addColorStop(1, shade(color, -18));
    ctx.fillStyle = grad;
    ctx.fillRect(0, y0, W, y1 - y0);
    prev = stop;
  }
  // Grain + mottling speckle for a photoreal-ish read.
  for (let i = 0; i < 14000; i++) {
    const x = Math.random() * W, y = Math.random() * H;
    const a = Math.random() * 0.09;
    ctx.fillStyle = Math.random() > 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,240,210,${a * 0.7})`;
    ctx.fillRect(x, y, 1.4, 1.4);
  }
  // A few pebble clusters in the lower horizons.
  for (let i = 0; i < 60; i++) {
    const y = H * (0.6 + Math.random() * 0.38);
    ctx.beginPath();
    ctx.arc(Math.random() * W, y, 1 + Math.random() * 3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(40,36,30,${0.3 + Math.random() * 0.3})`;
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amt));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (n & 255) + amt));
  return `rgb(${r},${g},${b})`;
}

export function ParcelCutaway({ twin, height = 260 }: { twin: Twin; height?: number }) {
  const mountRef = React.useRef<HTMLDivElement>(null);
  const [failed, setFailed] = React.useState(false);
  const center = React.useMemo(() => geomCenter(twin.geom), [twin.geom]);
  const acres = geomAreaAcres(twin.geom);

  React.useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (e) {
      console.warn('[ParcelCutaway] WebGL unavailable; static fallback', e);
      setFailed(true);
      return;
    }

    const w = el.clientWidth || 300;
    const h = height;
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    el.appendChild(renderer.domElement);
    renderer.domElement.addEventListener('webglcontextlost', (ev: Event) => { ev.preventDefault(); setFailed(true); });

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0806, 9, 20);

    // 3/4 "block-diagram" view: high enough to see the satellite top, low enough
    // that the two near soil walls read as a tall geological slice.
    // 3/4 view — elevated enough that the rotating block always shows the top +
    // two soil walls (never a thin edge-on sliver), low enough that the earth
    // layers on those walls stay prominent.
    const camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
    camera.position.set(2.5, 1.75, 3.4);
    camera.lookAt(0, -0.02, 0);

    // Brighter ambient + a key light aimed more HORIZONTALLY so the vertical soil
    // walls (not just the flat top) are lit, plus a camera-side fill so the faces
    // we're looking at never fall to black.
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const key = new THREE.DirectionalLight(0xfff2d8, 2.4); key.position.set(5, 3.2, 4.5); scene.add(key);
    const camFill = new THREE.DirectionalLight(0xffffff, 0.7); camFill.position.set(2.6, 1.4, 4); scene.add(camFill);
    const fill = new THREE.DirectionalLight(0x7fa8c8, 0.5); fill.position.set(-3, 2.5, -2); scene.add(fill);
    const warm = new THREE.DirectionalLight(0xc88a5a, 0.35); warm.position.set(0, -1.5, 3); scene.add(warm);

    // Procedural strata shows instantly; the photoreal texture swaps in on load.
    const strata = buildStrataTexture();
    strata.wrapS = THREE.RepeatWrapping; strata.wrapT = THREE.ClampToEdgeWrapping;
    // Self-illuminated soil sides (emissiveMap = the strata image) so the earth
    // layers ALWAYS read — a lit-only vertical wall gets only grazing light and,
    // with ACES tone-mapping, crushes to black. Plain material, no custom shader.
    const makeSide = () => new THREE.MeshStandardMaterial({
      map: strata, emissive: new THREE.Color(0xe6dccb), emissiveMap: strata,
      emissiveIntensity: 0.55, roughness: 0.9, metalness: 0.0,
    });
    const px = makeSide(), nx = makeSide(), pz = makeSide(), nz = makeSide();
    const sideMats = [px, nx, pz, nz];
    const topMat = new THREE.MeshStandardMaterial({ color: 0x2a3a1e, roughness: 0.75, metalness: 0.0 });
    const bottomMat = new THREE.MeshStandardMaterial({ color: 0x080706, roughness: 1 });
    // Box order: +X, -X, +Y(top), -Y(bottom), +Z, -Z
    const materials = [px, nx, topMat, bottomMat, pz, nz];

    // Load the photoreal soil-profile texture and swap it into the side faces.
    new THREE.TextureLoader().load('/textures/soil-strata.jpg', (t: THREE.Texture) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      sideMats.forEach((m) => { m.map = t; m.emissiveMap = t; m.needsUpdate = true; });
    }, undefined, () => { /* keep procedural fallback on error */ });

    const W = 2.2, H = 0.9; // a shallow soil SLICE — wider than tall, a thin core sample
    const group = new THREE.Group();
    const cube = new THREE.Mesh(new THREE.BoxGeometry(W, H, W), materials);
    group.add(cube);
    // Thin bright rim on the top edge.
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(W * 0.34, W * 0.36, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
    );
    rim.rotation.x = -Math.PI / 2; rim.position.y = H / 2 + 0.004;
    group.add(rim);
    scene.add(group);

    const cancelSat = buildSatelliteTexture(center, 18, (tex) => {
      topMat.map = tex; topMat.color.set(0xffffff); topMat.needsUpdate = true;
    });

    let raf = 0;
    const clock = new THREE.Clock();
    const loop = () => {
      const dt = clock.getDelta();
      group.rotation.y += dt * 0.12;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    const onResize = () => {
      const nw = el.clientWidth || w;
      renderer.setSize(nw, h);
      camera.aspect = nw / h;
      camera.updateProjectionMatrix();
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    ro?.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      cancelSat?.();
      ro?.disconnect();
      strata.dispose();
      materials.forEach((m) => { (m as THREE.MeshStandardMaterial).map?.dispose?.(); m.dispose(); });
      cube.geometry.dispose();
      renderer.dispose();
      try { el.removeChild(renderer.domElement); } catch { /* ignore */ }
    };
  }, [center[0], center[1], height]);

  if (failed) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] text-center px-4"
        style={{ height }}
      >
        <Layers3 className="size-5 text-[var(--fg-subtle)]" />
        <div className="text-[12px] font-medium text-[var(--fg-muted)]">Cutaway unavailable in this browser</div>
        <div className="text-[11px] text-[var(--fg-subtle)]">{acres != null ? `${acres.toFixed(2)} ac · ` : ''}{twin.geom.type} geometry</div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[#0a0806]" style={{ height }}>
      <div ref={mountRef} className="absolute inset-0" aria-label="Parcel geological cutaway" />
      <div className="pointer-events-none absolute left-3 top-3 space-y-0.5 text-[11px] leading-tight text-white/85">
        <div className="font-[var(--font-mono)]">Parcel {twin.id.slice(2, 12).toUpperCase()}</div>
        {acres != null && <div className="font-[var(--font-mono)]">Area {acres.toFixed(2)} ac</div>}
      </div>
      <div className="pointer-events-none absolute bottom-2.5 right-2.5 rounded-full bg-black/50 px-2.5 py-1 text-[9px] uppercase tracking-[0.18em] text-white/70 backdrop-blur">
        Geological cutaway
      </div>
    </div>
  );
}
