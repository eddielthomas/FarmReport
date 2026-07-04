// =============================================================================
// engines/globe-three.js — Three.js sphere globe engine
// -----------------------------------------------------------------------------
// Self-contained Three.js setup wrapped in the uniform engine contract.
//   * scene + perspective camera + OrbitControls
//   * earth sphere with Blue-Marble texture (matches the legacy MVP)
//   * detection markers (beam + dot + ring) parented to the earth so they
//     rotate with the globe rather than floating in world space
//   * DS POI MultiPolygons drawn as line strips on a slightly inflated sphere
//   * directional sun light controlled by setSun({hourUTC, brightness})
// =============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const EARTH_R = 100;                               // earth sphere radius (units)
const POI_R   = EARTH_R * 1.0008;                  // POI overlay radius
const TEX_URL = 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg';
const SEV     = { high: 0xff4060, medium: 0xffb020, low: 0x4d9fff };

/** lon/lat (deg) on a sphere of radius `r` -> Vector3. */
const latLonToVec3 = (lat, lon, r = EARTH_R) => {
  const phi   = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta),
  );
};

// Globe is a "world view" engine — it should always show the planet
// from afar at start, regardless of the higher street-level zoom that
// 2D engines use. The DS viewport zoom is only honoured up to a soft cap.
const GLOBE_ZOOM_CAP   = 4;            // hard ceiling on initial globe zoom
const GLOBE_DEFAULT_Z  = 2;            // default if nothing supplied

/** Map a globe zoom (e.g. 4) to camera distance from earth centre. */
const zoomToDist = (z) => {
  // z=0 → far (10R), z=20 → very close (1.05R). Smooth log-ish ramp.
  const t = Math.max(0, Math.min(1, (z ?? GLOBE_DEFAULT_Z) / 20));
  return EARTH_R * (10 - 8.95 * t);
};

/** Camera distance back to a rough zoom (inverse of zoomToDist). */
const distToZoom = (d) => {
  const t = Math.max(0, Math.min(1, (10 - d / EARTH_R) / 8.95));
  return Math.round(t * 20);
};

/** Clamp any incoming zoom (e.g. 13 from a 2D viewport) to a globe-friendly value. */
const clampGlobeZoom = (z) => Math.min(GLOBE_ZOOM_CAP, Number.isFinite(z) ? z : GLOBE_DEFAULT_Z);

/**
 * Create the globe engine instance.
 * @param {{ mount: HTMLElement, ds: any, camera: { lat:number, lon:number, zoom:number } }} opts
 */
export async function create({ mount, ds, camera }) {
  // ---- renderer + scene + camera + controls -------------------------------
  const w = mount.clientWidth  || 800;
  const h = mount.clientHeight || 600;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  renderer.domElement.style.width  = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  const cam = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
  cam.position.set(0, 0, zoomToDist(clampGlobeZoom(camera?.zoom)));

  const controls = new OrbitControls(cam, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed   = 0.6;
  controls.minDistance   = EARTH_R * 1.05;
  controls.maxDistance   = EARTH_R * 10;
  controls.enablePan     = false;

  // ---- lights -------------------------------------------------------------
  // Bright, mostly-uniform illumination so the night side of Blue-Marble
  // is still readable — this is a command surface, not a flight sim.
  const ambient = new THREE.AmbientLight(0xffffff, 1.4);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(EARTH_R * 5, EARTH_R * 2, EARTH_R * 3);
  scene.add(sun);

  // ---- earth --------------------------------------------------------------
  // MeshBasicMaterial = no shading, full texture brightness everywhere.
  // We keep ambient/sun lights for any future shaded layers.
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_R, 96, 64),
    new THREE.MeshBasicMaterial({ color: 0x6688aa }), // tint until tex loads
  );
  scene.add(earth);

  // Brightness state shared between texture-loader and setSun so neither
  // stomps the other when they fire out of order.
  let currentMul = 1.0;

  // Texture is async but non-blocking — globe renders immediately, then upgrades.
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  loader.load(TEX_URL, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    earth.material.map = tex;
    earth.material.color.setScalar(currentMul); // honour brightness if already set
    earth.material.needsUpdate = true;
  }, undefined, (err) => console.warn('[globe-three] texture load failed', err));

  // Subtle atmosphere shell (back-side tinted sphere).
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_R * 1.025, 64, 48),
    new THREE.MeshBasicMaterial({
      color: 0x4d9fff, transparent: true, opacity: 0.08, side: THREE.BackSide,
    }),
  );
  scene.add(atmo);

  // ---- visible sun (orbits earth so the sun-bar drag is obvious) ----------
  // Sun mesh = small bright disc; sunHalo = additive glow shell. Both live
  // on a pivot Object3D so we just rotate the pivot to move the sun.
  const SUN_DIST = EARTH_R * 6;
  const sunPivot = new THREE.Object3D();
  scene.add(sunPivot);
  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_R * 0.18, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff2b8 }),
  );
  sunMesh.position.set(SUN_DIST, 0, 0);
  sunPivot.add(sunMesh);
  const sunHalo = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_R * 0.42, 24, 16),
    new THREE.MeshBasicMaterial({
      color: 0xffd166, transparent: true, opacity: 0.25,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  sunHalo.position.copy(sunMesh.position);
  sunPivot.add(sunHalo);

  // ---- detection markers (parented to earth so they rotate with sphere) ---
  /** @type {Map<string, THREE.Object3D>} */
  const markerByDetectionId = new Map();
  /** @type {Map<string, THREE.Object3D[]>} layerId -> objects to toggle */
  const layerObjects = new Map([
    ['leaks', []],
    ['pois',  []],
    ['aoi',   []],
  ]);

  for (const d of ds?.detections ?? []) {
    if (!Number.isFinite(d.lat) || !Number.isFinite(d.lon)) continue;
    const color = SEV[d.severity] ?? SEV.low;
    const grp = new THREE.Group();
    const pos = latLonToVec3(d.lat, d.lon, EARTH_R);
    grp.position.copy(pos);
    // Orient so +Y of the group points outward from earth centre.
    grp.lookAt(pos.clone().multiplyScalar(2));

    // Beam — slim cylinder from surface outward.
    const beamH = EARTH_R * 0.06;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, beamH, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 }),
    );
    beam.rotation.x = Math.PI / 2;
    beam.position.z = beamH / 2;
    grp.add(beam);

    // Dot at tip.
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 12, 12),
      new THREE.MeshBasicMaterial({ color }),
    );
    dot.position.z = beamH;
    grp.add(dot);

    // Pulse ring (flat ring on surface tangent plane).
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 1.4, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
    );
    ring.position.z = 0.05;
    grp.add(ring);

    earth.add(grp);
    markerByDetectionId.set(d.id, grp);
    const bucket = d.id?.startsWith?.('LEAK-') ? 'leaks' : 'pois';
    layerObjects.get(bucket).push(grp);
  }

  // ---- POI MultiPolygon line overlays ------------------------------------
  // Each MultiPolygon has shape: [polygon][ring][[lon,lat], …]
  const polyMat = new THREE.LineBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.85 });
  for (const d of ds?.detections ?? []) {
    const g = d.geom;
    if (!g || g.type !== 'MultiPolygon') continue;
    for (const polygon of g.coordinates) {
      for (const ring of polygon) {
        if (!ring?.length) continue;
        const pts = ring.map(([lon, lat]) => latLonToVec3(lat, lon, POI_R));
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const line = new THREE.Line(geo, polyMat);
        earth.add(line);
        layerObjects.get('aoi').push(line);
      }
    }
  }

  // ---- camera fly-to per DS viewport on init ------------------------------
  // Rotate earth so the requested lat/lon faces the camera (camera is fixed
  // along +Z). This avoids juggling camera spherical coords.
  const orientToLatLon = (lat, lon) => {
    earth.rotation.y = -((lon + 180) * Math.PI / 180) - Math.PI / 2;
    earth.rotation.x =  (lat * Math.PI / 180);
  };
  if (camera?.lat != null && camera?.lon != null) {
    orientToLatLon(camera.lat, camera.lon);
  } else if (ds?._viewport) {
    orientToLatLon(ds._viewport.lat, ds._viewport.lon);
    cam.position.set(0, 0, zoomToDist(clampGlobeZoom(ds._viewport.zoom)));
  }

  // ---- resize observer ----------------------------------------------------
  const onResize = () => {
    const W = mount.clientWidth  || 800;
    const H = mount.clientHeight || 600;
    renderer.setSize(W, H, false);
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(onResize);
  ro.observe(mount);

  // ---- render loop --------------------------------------------------------
  // LOD: scale every marker by current camera distance so beams/dots/AOI
  // strokes stay readable from world-view all the way down to street-level.
  // distScale = camDist / refDist (refDist = ~3R "comfortable globe view").
  const REF_DIST = EARTH_R * 3;
  let raf = 0;
  let alive = true;
  const t0 = performance.now();
  const tick = () => {
    if (!alive) return;
    const t = (performance.now() - t0) / 1000;
    const camDist  = cam.position.length();
    const distScale = Math.max(0.35, Math.min(4.0, camDist / REF_DIST));

    // Pulse rings + LOD-scale every marker group.
    for (const grp of markerByDetectionId.values()) {
      grp.scale.setScalar(distScale);
      const ring = grp.children?.[2];
      if (ring) {
        const s = 1 + 0.35 * Math.sin(t * 2.5);
        ring.scale.setScalar(s);
        ring.material.opacity = 0.45 * (1.1 - 0.5 * (s - 1));
      }
    }

    // Make AOI line overlays thicker / more opaque when zoomed out.
    polyMat.opacity = Math.min(1, 0.55 + 0.25 * Math.log10(1 + distScale));

    controls.update();
    renderer.render(scene, cam);
    raf = requestAnimationFrame(tick);
  };
  tick();

  // ---- engine API ---------------------------------------------------------

  // Animated flyTo — tweens earth.rotation (so the texture point at lat/lon
  // rolls under the camera) plus optional zoom along the current camera
  // bearing. Returns a Promise that resolves when the animation completes,
  // so callers can chain ("rotate first, THEN engine-swap + zoom in").
  // Pass `{ duration: 0 }` for an instant set (used by the engine-host
  // parking flyTo during mode swaps).
  let flyAnimToken = 0;
  function flyTo(lat, lon, zoom, opts = {}) {
    const duration = Number.isFinite(opts.duration) ? opts.duration : 1200;
    const targetRotY = -((lon + 180) * Math.PI / 180) - Math.PI / 2;
    const targetRotX = lat * Math.PI / 180;
    const targetDist = Number.isFinite(zoom) ? zoomToDist(zoom) : cam.position.length();

    if (duration <= 0) {
      earth.rotation.y = targetRotY;
      earth.rotation.x = targetRotX;
      cam.position.setLength(targetDist);
      return Promise.resolve();
    }

    const startRotY = earth.rotation.y;
    const startRotX = earth.rotation.x;
    // Wrap to shortest-path delta so we never spin the long way round.
    let dy = targetRotY - startRotY;
    while (dy >  Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    const dx = targetRotX - startRotX;
    const startDist = cam.position.length();
    const dDist = targetDist - startDist;

    const myToken = ++flyAnimToken;
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = () => {
        if (!alive || myToken !== flyAnimToken) { resolve(); return; }
        const t = Math.min(1, (performance.now() - t0) / duration);
        // easeInOutQuad
        const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        earth.rotation.y = startRotY + dy * e;
        earth.rotation.x = startRotX + dx * e;
        if (dDist !== 0) cam.position.setLength(startDist + dDist * e);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      step();
    });
  }

  function setSun({ hourUTC = 12, brightness = 100 } = {}) {
    // ── Sun position ────────────────────────────────────────────────────────
    // Hour 0..24 → angle 0..360° around the world Y axis. Tilt across the
    // ecliptic by varying the Y component slightly with the same hour phase.
    const ang  = (hourUTC / 24) * Math.PI * 2;
    const tilt = Math.sin(ang * 0.25) * 0.35;          // ±0.35 rad (~20°)
    sunPivot.rotation.set(tilt, ang, 0);

    // Keep the directional light in lockstep so any future lit materials
    // (atmosphere shader, building extrusions, etc.) light up correctly.
    const r = SUN_DIST;
    sun.position.set(
      Math.cos(ang) * r,
      Math.sin(ang) * Math.sin(tilt) * r,
      Math.sin(ang) * r,
    );

    // ── Brightness ──────────────────────────────────────────────────────────
    // Map slider 0..100 → multiplier 0.20..1.00. 0% is dim-but-readable
    // (not pitch black — this is a command surface), 100% = natural Blue-Marble.
    const b = Math.max(0, Math.min(100, brightness)) / 100;
    currentMul = 0.20 + 0.80 * b;
    earth.material.color.setScalar(currentMul);
    earth.material.needsUpdate = true;

    // Sun mesh + halo also track brightness so dragging the slider is obvious.
    sunMesh.material.color.setRGB(1, 0.95 * (0.5 + 0.5 * b), 0.72 * (0.4 + 0.6 * b));
    sunHalo.material.opacity = 0.18 + 0.32 * b;

    // Lights still react (used by Lambert/Phong layers).
    sun.intensity     = 0.4 + 1.2 * b;
    ambient.intensity = 0.6 + 1.0 * b;
  }

  function setLayerVisible(id, on) {
    const objs = layerObjects.get(id);
    if (!objs) return;
    for (const o of objs) o.visible = !!on;
  }

  function focus(d) {
    if (!d || !Number.isFinite(d.lat) || !Number.isFinite(d.lon)) return;
    flyTo(d.lat, d.lon, 16);
  }

  function getCamera() {
    // Compute lat/lon of the texture point currently centered under the
    // camera. Reading earth.rotation is wrong because OrbitControls moves
    // the camera around the earth — earth.rotation only reflects what
    // orientToLatLon last set (or auto-spin), not the user's actual view.
    earth.updateMatrixWorld(true);
    // World-space direction from earth centre to camera, normalised.
    const worldDir = cam.position.clone().normalize();
    // Transform into earth-local space so the lat/lon refers to the
    // texture (which rotates with earth.matrixWorld).
    const inv = new THREE.Matrix4().copy(earth.matrixWorld).invert();
    const localDir = worldDir.applyMatrix4(inv);
    const y = Math.max(-1, Math.min(1, localDir.y));
    const lat = Math.asin(y) * 180 / Math.PI;
    const lon = Math.atan2(localDir.z, localDir.x) * 180 / Math.PI;
    return {
      lat,
      lon,
      zoom: distToZoom(cam.position.length()),
    };
  }

  function dispose() {
    alive = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    renderer.dispose();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) {
        const m = o.material;
        (Array.isArray(m) ? m : [m]).forEach((mm) => {
          mm.map?.dispose?.();
          mm.dispose?.();
        });
      }
    });
    renderer.domElement.remove();
  }

  return { flyTo, setSun, setLayerVisible, focus, getCamera, dispose };
}

export default { create };
