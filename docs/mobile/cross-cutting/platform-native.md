# Report.Farm Mobile — Native Platform Layer (iOS + Android)

**Status:** design / implementation-grade
**Owner:** Mobile Architecture Lead
**Scope:** the *native capability layer* only — maps, 3D cutaway, camera→segmentation, geolocation, offline tiles, permissions, push, background jobs, deep links. Feature/domain screens (auth, onboarding, studio, mission control, reports) are specced in sibling docs; this doc is the substrate they sit on.
**Target stack:** Expo SDK 52+ (RN 0.76, New Architecture / Fabric ON), TypeScript, expo-router, offline-first via expo-sqlite + Drizzle. iOS 15+ / Android 8+ (API 26+).

> Grounding: verified against the live web app — `maplibre-gl@^5.6.0` (globe projection), `three@^0.171.0` (raw three.js `ParcelCutaway`), `deck.gl@^9.3` + `cesium@^1.141` (globe find-my-farm), Esri World Imagery keyless raster tiles, SSE via `fetch()`+`ReadableStream` with `Authorization: Bearer` + `x-tenant-id` headers (`gateway-signals.ts`), and the `/api/v1/farm/gw/*` byte-forwarder relay. Files read: `StudioMap.tsx`, `FindMyFarm.tsx`, `ParcelCutaway.tsx`, `gateway-signals.ts`, plus the full domain inventory.

---

## 0. TL;DR — the three load-bearing native decisions

1. **Maps: standardize on `@maplibre/maplibre-react-native` (MapLibre Native), NOT react-native-maps.** The entire web surface is MapLibre-GL: style spec, `raster-*` paint transforms for the NDVI/moisture/thermal layer switcher, vector `fill/line/circle/symbol` layers for twins/signals/drafts, and a keyless Esri raster basemap. MapLibre Native consumes the *same* StyleSpecification JSON and the same GeoJSON sources, so ~90% of the web map logic ports as data, not rewrite. react-native-maps (Google/Apple tiles) would force a re-implementation of every layer and lose the Esri basemap + raster-paint EO colorization. **Caveat:** MapLibre Native has **no globe projection** — the spinning satellite globe degrades to a flat/orthographic find-my-farm map on mobile (documented fallback, matches the web's own WebGL-failure fallback posture).

2. **3D geological cutaway: `expo-gl` + `three` (raw three.js port), NOT Skia.** `ParcelCutaway` is already raw three.js r171 (BoxGeometry + 6 materials + ACES tone mapping + a composited-tile top face). It ports almost verbatim onto `expo-gl`'s `GLView` with `expo-three`'s `Renderer`. Skia would mean re-authoring the whole scene in a 2.5D projection — more work, worse result. Bundle `soil-strata.jpg` as an asset; proxy/cache the Esri top-face tiles.

3. **Background scan jobs + SSE: `react-native-sse` (XHR-streaming, header-capable) + `expo-task-manager`/`expo-background-task`, driven by push completion.** RN has no `fetch().body.getReader()`, so the web's SSE reader must be replaced by an XHR-streaming SSE client that can still attach `Authorization: Bearer` + `x-tenant-id`. Because HD-twin builds take 5+ minutes and OS backgrounding will suspend the socket, the **authoritative completion signal is a push notification** (`farm.complete` → APNs/FCM), with SSE used only while the app is foregrounded and `twins/:aoi` polled as source-of-truth on resume — mirroring the web's "gateway job outlives the page, resume on remount" pattern.

---

## 1. Native capability matrix (at a glance)

| Capability | Library | iOS backing | Android backing | Risk |
|---|---|---|---|---|
| Interactive map / parcel-draw / boundary editor / twin overlays / layer switcher | `@maplibre/maplibre-react-native` | Metal (MapLibre Native iOS) | OpenGL/Vulkan (MapLibre Native Android) | Med — Expo config plugin, custom dev client required |
| Satellite "globe" (find-my-farm) | MapLibre flat map (globe fallback) or optional `expo-cesium`/WebView | Metal | GL | Low (fallback) / High (Cesium native) |
| 3D geological land-slice cutaway | `expo-gl` + `three` + `expo-three` | Metal-backed GL (EXGL) | GLES3 (EXGL) | Med — texture/tile CORS, GL context loss |
| Camera capture (drone/photo → segmentation) | `expo-camera` + `expo-image-picker` + `expo-image-manipulator` | AVFoundation | CameraX | Low |
| Geolocation (drop-pin, GPS boundary) | `expo-location` | CoreLocation | FusedLocation | Low |
| Offline map tiles | MapLibre `OfflineManager` (AmbientCache + regions) | SQLite mbtiles-ish store | same | Med — Esri ToS on caching |
| Permissions | `expo-*` per-module + `expo-tracking-transparency` | Info.plist usage strings | AndroidManifest + runtime | Low |
| Push (APNs/FCM) | `expo-notifications` + `expo-device` | APNs | FCM | Med — FCM setup, APNs key |
| Background scan jobs | `expo-task-manager` + `expo-background-task` + push wake | BGTaskScheduler | WorkManager | High — OS suspension |
| Deep links / universal links | `expo-linking` + expo-router | Associated Domains | App Links (assetlinks) | Med — domain verification |
| Secure token storage | `expo-secure-store` | Keychain | Keystore/EncryptedSharedPrefs | Low |
| SSE (job progress) | `react-native-sse` (XHR streaming) | — | — | Med — header injection, reconnect |
| Offline DB | `expo-sqlite` + `drizzle-orm` | SQLite | SQLite | Low |

**Requires a custom Expo Dev Client / EAS build** (not Expo Go): MapLibre Native, expo-gl three scenes with custom textures, background tasks, and FCM. Plan for `eas build --profile development` from day one.

---

## 2. Interactive maps — the core native surface

### 2.1 Library choice: MapLibre Native (decision + rationale)

The web app is 100% MapLibre-GL v5. Three surfaces depend on it:

- **StudioMap** — Esri raster basemap + `raster-*` paint switcher (satellite/ndvi/moisture/thermal) + twin `fill/line/circle/symbol` layers + `draft-*`/`edit-vert`/`edit-mid` authoring layers + `mask-fill` isolate + `signals-glow`/`signals-dot`.
- **FindMyFarm PinMap** — globe-projection satellite, drop-pin marker, flyTo.
- **FarmMap / GeometryPreview** — boundary + parcels + zones preview, fitBounds.

`@maplibre/maplibre-react-native` (the community RN binding for MapLibre Native) accepts the **same StyleSpecification JSON and GeoJSON `ShapeSource`s**, so we port the *data model* of the map (sources/layers/paint) rather than rewrite it. This is the single biggest native-porting win in the app.

**Rejected: `react-native-maps`.** It renders Apple/Google native tiles and exposes only `Polygon`/`Polyline`/`Marker`/`Overlay` primitives — no style spec, no `raster-hue-rotate` paint, no data-driven `['get','color']` styling. Every EO layer, twin layer, and the keyless-Esri basemap would be a bespoke rewrite, and the map would look nothing like the web. Only reason to keep it in a back pocket: if Apple/Google turn-by-turn or their POI basemaps are ever needed (they are not for this product).

**Config plugin (app.json):**
```jsonc
{ "plugins": [
  ["@maplibre/maplibre-react-native"],
  ["expo-location", { "locationWhenInUsePermission": "Report.Farm uses your location to center the map on your farm and to drop a pin on a field." }],
  ["expo-camera", { "cameraPermission": "Report.Farm uses the camera to photograph assets and fields for AI segmentation into digital twins." }],
  ["expo-notifications", { "icon": "./assets/notif-icon.png", "color": "#4C7EFF" }]
] }
```

### 2.2 Basemap + layer switcher (port `LAYER_PAINT`)

Reuse the exact web paint constants — they are `raster-*` numeric props MapLibre Native supports:

```ts
// maps/basemap.ts  (verbatim from StudioMap.tsx LAYER_PAINT)
export const LAYER_PAINT = {
  satellite: { 'raster-saturation': -0.05, 'raster-contrast': 0.1,  'raster-hue-rotate': 0,   'raster-brightness-min': 0,    'raster-brightness-max': 1 },
  ndvi:      { 'raster-saturation': -1,    'raster-contrast': 0.55, 'raster-hue-rotate': 90,  'raster-brightness-min': 0.15, 'raster-brightness-max': 0.9 },
  moisture:  { 'raster-saturation': -0.8,  'raster-contrast': 0.1,  'raster-hue-rotate': 200, 'raster-brightness-min': 0.1,  'raster-brightness-max': 0.75 },
  thermal:   { 'raster-saturation': -0.5,  'raster-contrast': 0.6,  'raster-hue-rotate': -40, 'raster-brightness-min': 0.05, 'raster-brightness-max': 0.95 },
} as const;

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
```

```tsx
// maps/StudioMap.native.tsx (skeleton)
import { MapView, Camera, RasterSource, RasterLayer, ShapeSource, FillLayer, LineLayer, CircleLayer, SymbolLayer } from '@maplibre/maplibre-react-native';

<MapView style={{flex:1}} mapStyle={{version:8, sources:{}, layers:[]}} attributionEnabled compassEnabled={false} pitchEnabled={false} rotateEnabled={false}>
  <Camera ref={camRef} />
  <RasterSource id="esri" tileUrlTemplates={[ESRI]} tileSize={256}>
    <RasterLayer id="esri" style={{ ...LAYER_PAINT[layer], rasterOpacity: opacity }} />
  </RasterSource>

  {/* isolate mask (world box with property punched out) */}
  <ShapeSource id="mask" shape={maskFC}><FillLayer id="mask-fill" style={{ fillColor:'#05060a', fillOpacity:0.6 }} /></ShapeSource>

  {/* property boundary */}
  <ShapeSource id="property" shape={propertyFC}>
    <FillLayer id="property-fill" style={{ fillColor:'#4C7EFF', fillOpacity:0.05 }} />
    <LineLayer id="property-line" style={{ lineColor:'#6E97FF', lineWidth:2.5, lineDasharray:[2,1.5] }} />
  </ShapeSource>

  {/* signals — teal glow + dot */}
  <ShapeSource id="signals" shape={signalsFC}>
    <CircleLayer id="signals-glow" style={{ circleRadius:9, circleColor:'#2DD4BF', circleOpacity:0.18, circleBlur:0.6 }} />
    <CircleLayer id="signals-dot"  style={{ circleRadius:4, circleColor:'#2DD4BF', circleStrokeColor:'#04201c', circleStrokeWidth:1 }} />
  </ShapeSource>

  {/* twins — data-driven color */}
  <ShapeSource id="twin-poly" shape={twinPolyFC}>
    <FillLayer id="twin-poly-fill" style={{ fillColor:['get','color'], fillOpacity:0.32 }} />
    <LineLayer id="twin-poly-line" style={{ lineColor:['get','color'], lineWidth:2 }} />
  </ShapeSource>
  <ShapeSource id="twin-point" shape={twinPointFC}>
    <CircleLayer id="twin-point" style={{ circleRadius:7, circleColor:['get','color'], circleStrokeColor:'#fff', circleStrokeWidth:2 }} />
    <SymbolLayer id="twin-label" style={{ textField:['get','name'], textSize:11, textOffset:[0,1.3], textAnchor:'top', textColor:'#fff', textHaloColor:'#000', textHaloWidth:1.2 }} />
  </ShapeSource>
</MapView>
```

**Note property naming**: MapLibre RN uses camelCase style props (`fillColor`, `rasterHueRotate`) vs the web's kebab paint keys. Write one adapter `paintToNative(webPaint)` to convert, so the constants stay a single source of truth.

**Property `text-halo`/labels**: MapLibre Native needs glyph fonts for `SymbolLayer` text. Either bundle a `glyphs` PBF endpoint in the style, or (simpler) render twin labels as RN overlay views positioned via `map.pointForCoordinate()` (avoids glyph packaging). Recommend RN-overlay labels for the twin name chips to dodge glyph tooling.

### 2.3 Authoring tools → touch gestures (the tool rail)

The web tool rail (select/edit-boundary/note/issue/task/measure/zone/parcel-draw/object-library/rect/circle/row/duplicate/delete/undo/redo/isolate/labels) is mouse+keyboard. Native re-maps each interaction to touch. Keep the tool rail as a vertical floating column of buttons (already touch-friendly); the *canvas* interactions change:

| Web gesture | Native gesture | Impl |
|---|---|---|
| click to place point/vertex | **tap** | `MapView onPress → e.geometry.coordinates` |
| drag twin / vertex | **pan on selected handle** | `react-native-gesture-handler` Pan + `map.getCoordinateFromView`; disable `MapView.scrollEnabled` while a handle is active |
| dbl-click finish poly/row | **"Finish" button** in the contextual hint bar (+ tap-near-first-vertex to close) | explicit button — no reliable dbl-tap on map |
| right-click delete vertex | **long-press vertex** | `onLongPress` hit-test on `edit-vert` |
| click edge midpoint to add vertex | **tap `edit-mid` dot** | queryRenderedFeatures at tap |
| mousedown-drag rect/circle | **two-finger or drag-from-anchor** | pan from first-touch anchor; live-update `draft` source |
| Cmd+Z / Cmd+D / Del | on-screen undo/redo/duplicate/delete buttons (already in rail) | store actions |
| Esc cancel | "Cancel" in contextual hint bar | — |
| hover tooltip | long-press tooltip / omit | — |

Critical native detail: **selectively disable map pan/zoom while an authoring drag is in flight** (`scrollEnabled={activeHandle==null}`) or the map will fight the gesture. Use `react-native-gesture-handler` with a `Pan` recognizer that claims the gesture on handle-touch.

Hit-testing: MapLibre RN exposes `queryRenderedFeaturesAtPoint([x,y], filter, [layerIds])` — use it for tap-select of `twin-poly-fill`/`twin-point`/`twin-line` and for vertex/midpoint picking, exactly like the web `queryRenderedFeatures`.

Geometry math (`metersBetween`, `circlePolygon`, `rectPolygon`, `translate`, `ringAreaM2`, `geomAreaAcres`, `closeRing`) is **pure TS — port verbatim** from `twins-store.ts`. No native dependency.

### 2.4 Boundary import (shpjs / togeojson) — the DOM problem

`BoundaryImport` uses `shpjs` (arrayBuffer OK on RN) and `@tmcw/togeojson` + browser `DOMParser` (NOT in RN). Native plan:

- **File pick:** `expo-document-picker` (`.geojson/.json/.kml/.zip`), read via `expo-file-system` `readAsStringAsync`/base64.
- **GeoJSON:** `JSON.parse` — works.
- **Shapefile (.zip):** `shpjs@6` works on RN if fed an `ArrayBuffer` (use `FileSystem` → base64 → `Buffer`). Verify in a spike; `shpjs` pulls `jszip` (already RN-safe).
- **KML:** `@tmcw/togeojson` needs a DOM. Ship `@xmldom/xmldom` (already a web dep at `^0.9.5`) as the `DOMParser` polyfill and pass its document into `togeojson.kml()`. This is the intended RN path.
- **Paste GeoJSON:** trivial `TextInput` + `JSON.parse`.

`extractPolygonal`, `toSinglePolygon`, `geometryBbox`, `geometryAreaHa`, `geometryVertexCount` are pure — port verbatim. **These run fully offline** (a genuine offline-first win: users can import/draw a boundary with no connectivity; only the parcel/vision lookups need network).

### 2.5 The satellite globe (find-my-farm) — degradation

Web `PinMap` uses MapLibre v5 **globe projection** with atmosphere/sky/fog and a 7s intro spin. **MapLibre Native does not support globe projection.** Options:

1. **(Recommended) Flat satellite map fallback.** Open zoomed-out (`zoom≈2`) on the Esri raster, drop-pin on tap, `flyTo` located centroid. Add a subtle "Find your farm" chip. This *is* the web's own documented WebGL-failure fallback — honest and consistent. Ship this for v1.
2. **Cesium-native via WebView.** The web already has `cesium@^1.141` for a globe find-my-farm; embed a lightweight Cesium page in `react-native-webview` and bridge pin events via `postMessage`. High effort, heavy WebGL in a WebView, memory risk on low-end Android. Defer.
3. **Wait for MapLibre Native globe** (tracked upstream) — do not block on it.

Pin-drop lookup itself (`/farm/gw/parcel?lat&lon`, `/farm/gw/parcel-by-address?q`, OSM Nominatim fallback) is network I/O — port the `gateway-parcel.ts` client as-is (see §7). Preserve tier honesty: cadastral = exact (T2), OSM/vision = **approximate (T3)** with the "drag corners to trace your exact boundary" copy.

### 2.6 Offline map tiles

MapLibre Native ships an **OfflineManager / OfflinePackmanager** (`@maplibre/maplibre-react-native` exports `offlineManager`). Two modes:

- **Ambient cache** — LRU cache of recently viewed tiles (default; set `offlineManager.setTileCountLimit`). Free offline glanceability of places the user already visited.
- **Offline regions** — explicit `createPack({ name, styleURL, bounds, minZoom, maxZoom })` per farm AOI. On farm open (online), pre-download a pack covering `aoi_west/south/east/north` at z10–16 so the field is fully usable offline in the barn/field.

**Legal/ToS risk (High-to-track):** Esri World Imagery is keyless for *interactive* use; bulk pre-caching may violate Esri ToS. Mitigations: (a) cap offline packs to the farm AOI only (small), (b) evaluate a licensed source (Mapbox Satellite / MapTiler / self-hosted) for the offline-region path, (c) make offline-download opt-in per farm. **Flag for product/legal before shipping bulk tile caching.**

Store pack metadata (farmId → packName, bounds, downloadedAt, byteSize) in SQLite so we can show "Available offline" badges and evict stale packs.

---

## 3. 3D geological cutaway — expo-gl + three

### 3.1 Decision: port raw three.js onto expo-gl

`ParcelCutaway.tsx` is already raw three.js r171 with **no react-three-fiber** — a `BoxGeometry(2.2, 0.9, 2.2)` with 6 materials (satellite top, 4 emissive soil-strata sides, dark bottom), ACES tone mapping, 4 lights, `group.rotation.y += dt*0.12` auto-rotate, `ResizeObserver`, and WebGL-context-loss guard. This maps cleanly to **`expo-gl` `GLView` + `expo-three` `Renderer`**:

```tsx
// twin/ParcelCutaway.native.tsx
import { GLView } from 'expo-gl';
import { Renderer } from 'expo-three';
import * as THREE from 'three';
import { Asset } from 'expo-asset';

function onContextCreate(gl) {
  const renderer = new Renderer({ gl, alpha: true, antialias: true });
  renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  // ... scene/camera/lights/materials IDENTICAL to web ParcelCutaway ...
  const render = () => { group.rotation.y += clock.getDelta()*0.12; renderer.render(scene, camera); gl.endFrameEXP(); requestAnimationFrame(render); };
  render();
}
<GLView style={{ height }} onContextCreate={onContextCreate} onLayout={...} />
```

### 3.2 The two texture problems (native-specific)

The web builds textures from **DOM `<canvas>`** and **`new Image()`** — neither exists in RN. Rework:

1. **Soil-strata side texture** (`buildStrataTexture` procedural + `/textures/soil-strata.jpg` photoreal swap):
   - **Bundle `soil-strata.jpg` as an Expo asset** (`assets/textures/soil-strata.jpg`); load via `expo-asset` → `expo-three` `TextureLoader.loadAsync(asset.localUri)`. This removes the network dependency entirely (better than web).
   - The procedural canvas fallback can't run (no canvas). Instead ship a **static low-res `soil-strata-fallback.jpg`** bundled asset used until the full-res loads, or `@shopify/react-native-skia` offscreen `Surface` to draw the strata bands if we want procedural. Simplest: bundle both a placeholder and full texture.

2. **Satellite top-face texture** (`buildSatelliteTexture` composites a 4×4 grid of Esri z18 tiles via canvas `drawImage`):
   - No canvas compositing in RN. Options:
     - **(Recommended) Composite server-side or via Skia.** Add a tiny app-relay helper `GET /api/v1/farm/tiles/composite?lng&lat&z=18&grid=4` that stitches the 4×4 Esri grid into one JPEG and returns it (also solves Esri CORS + caching + auth). Load that single image as the `topMat.map`.
     - **Or** composite on-device with `@shopify/react-native-skia` (`Skia.Surface.Make` → draw 16 images → `makeImageSnapshot` → base64 → three texture). More code, no server change.
     - **Or** drop compositing: use one Esri tile scaled up (blurrier top) — acceptable for a rotating cutaway.
   - **Offline:** top face needs tiles → show the dark/strata block with no satellite cap when offline (honest degradation). Cache the composited JPEG per twin in FileSystem keyed by `center@z`.

### 3.3 GL lifecycle & risks

- **Context loss:** listen for GL context loss; on Android especially, backgrounding can drop the GL context. Guard like the web (`webglcontextlost → setFailed(true)`) and render the static fallback card (`Layers3` icon + acreage + geom type). Re-create on remount.
- **Memory:** dispose geometries/materials/textures on unmount (the web already does this in the cleanup return — port it). Only mount the cutaway when the Overview tab is visible; unmount on tab blur.
- **Performance:** cap `pixelRatio` at 2, keep the single box + rim mesh — it's cheap. Fine on mid-tier devices.
- **Alternative considered — Skia:** rejected. Would require re-projecting a 3D block into 2.5D by hand and re-lighting; the three.js port is less work and photoreal.

---

## 4. Camera capture → object-to-twin segmentation

The web has **no camera path** — this is a *new mobile-native capability* that feeds the existing gateway vision endpoints (`/farm/gw/vision/segment`, `/segment/refine`). Design it now; wire when the gateway vision endpoint deploys (currently `404 vision_not_available`).

### 4.1 Capture pipeline

```
expo-camera (CameraView)
  → capture photo (or expo-image-picker for existing drone shots / gallery)
  → expo-location: stamp EXIF lat/lon + device heading (for georef)
  → expo-image-manipulator: downscale to ≤2048px, JPEG q0.8, strip to reduce upload
  → POST multipart to app relay → gateway /api/vision/segment
  → objects[] (label, confidence, tier T3, polygon in EPSG:4326 or image-space)
  → user taps an object → refine (SAM2 cached embedding_session) → confirm as Twin
```

**Two segmentation modes:**
- **Field auto-trace (exists):** point-anchored, `segmentFieldAtPoint(lat,lon)` over a `±0.012°` bbox of *satellite* imagery (not the camera). Already specced; port `gateway-vision.ts` (`segmentFieldAtPoint`, `pickFieldForPin` ray-cast — pure TS). The 202 async path reuses the SSE reader (§5).
- **Photo/drone object-to-twin (new):** upload a *captured* image; gateway returns image-space object masks. Because a ground/drone photo isn't georeferenced to lat/lon polygons the way Sentinel-2 is, treat photo-segmentation output as **twin metadata + attached evidence photo**, not a map polygon — drop the confirmed object into the object-library placement flow (user positions it on the map). Georef only when EXIF GPS + altitude + camera intrinsics are trustworthy (drone nadir shots).

### 4.2 Libraries + per-platform

- `expo-camera` (`CameraView`) — iOS AVFoundation, Android CameraX. Handles permission, torch, zoom.
- `expo-image-picker` — pick existing drone/gallery images (drone workflow: user offloads DJI shots to phone, imports).
- `expo-image-manipulator` — resize/compress/rotate; strip metadata selectively (keep GPS if present).
- `expo-media-library` (optional) — save annotated captures back to the twin's Docs tab.
- Upload: `expo-file-system` `uploadAsync` (background-capable) → multipart to a new relay `POST /api/v1/farm/gw/vision/segment` (add multipart passthrough) with `Authorization: Bearer` + `x-tenant-id`.

**Honesty:** all vision output is **T3 screening** — never present a segmented boundary as authoritative; label "AI-suggested, confirm/refine". Preserve the web's `unavailable/empty/error` states and the `404 → vision_not_available → "coming soon"` collapse.

**Risks:** iOS camera perms strings mandatory (App Store rejection otherwise); large drone JPEGs → compress before upload; segmentation is online-only → queue captures offline as pending "to-segment" items in SQLite and flush on reconnect.

---

## 5. Background scan jobs + SSE (the hardest native problem)

### 5.1 What the web does

`launchScanJob` → `aoiFromGeom` (`POST /gw/aoi/from-geom` → `aoi_id`) → `runScan` (`POST /gw/scan` → 202 `{jobId}`) → persist `ScanJob` to `localStorage rf.studio.scanjobs.v1` → `ScanJobsRunner` drives it via **`fetch()` + `ReadableStream.getReader()`** consuming SSE (`farm.progress`→`farm.complete/error`), reconnect on drop, poll `twins/:aoi` as source-of-truth, 12-min ceiling. Builds survive navigation and resume on remount.

### 5.2 Why it can't port directly

1. **No `ReadableStream` reader in RN.** `fetch().body` is null. Must use an SSE client built on `XMLHttpRequest` streaming.
2. **`EventSource` can't set headers** — and we *must* send `Authorization: Bearer` + `x-tenant-id`. So use **`react-native-sse`** (supports custom headers over XHR) — it reframes `\n\n`, exposes `event:`/`data:` and custom event names (`farm.progress` etc.), and reconnects.
3. **OS suspends the socket on background.** A 5-min build will not complete with the app backgrounded. iOS gives ~30s after background; Android Doze kills sockets.

### 5.3 Native architecture

```
Foreground:  react-native-sse EventSource(/gw/jobs/:id/events, {headers: Bearer + tenant})
             → farm.progress → update SQLite job (pct/stage) → progress dock re-renders
             → farm.complete → fetchTwins(aoi) → materialize → mark complete
Background:  socket suspended. Rely on:
   (a) PUSH: gateway emits farm.complete → app-relay → APNs/FCM data push
       → expo-notifications background handler → set job=complete, schedule twins fetch on next open
   (b) RESUME: on app foreground, for every job status='running':
       poll GET /gw/jobs/:id (snapshot) and GET /gw/twins/:aoi (twinLooksReady?)
       → complete if ready, else re-open SSE
   (c) expo-background-task (WorkManager/BGTaskScheduler): periodic (~15 min min interval)
       best-effort poll of running jobs; NOT guaranteed timely — push is primary.
```

**Key native decision:** **push is the authoritative completion signal**, SSE is a foreground nicety, and `twins/:aoi` is the source-of-truth reconciler (exactly the web's "twins as source of truth" pattern, now spanning app relaunch). This requires the gateway/relay to emit a push on `farm.complete` (see §6.3) — coordinate with the gateway team; if push isn't available, degrade to resume-poll-on-open (jobs complete "when you come back").

**SSE client wrapper** (drop-in for `streamJobEvents`):
```ts
import EventSource from 'react-native-sse';
export function streamJobEvents(jobId, onEvent, abort: AbortController) {
  const es = new EventSource(`${API}/farm/gw/jobs/${jobId}/events`, {
    headers: authHeaders({ accept: 'text/event-stream' }),   // Bearer + x-tenant-id
    pollingInterval: 0,                                       // no auto-reGET; we manage reconnect
  });
  for (const name of ['farm.progress','farm.complete','farm.error']) {
    es.addEventListener(name as any, (e:any) => onEvent({ event:name, data: JSON.parse(e.data||'{}') }));
  }
  abort.signal.addEventListener('abort', () => es.close());
  return es;
}
```

Persist jobs to SQLite (`scan_jobs` table, §8) not localStorage. On cold start, `ScanJobsRunner` reads running jobs and resumes drive loops — identical logic to web remount.

**Risks (High):** background execution limits are the #1 mobile risk. iOS BGTaskScheduler runs opportunistically (no guarantee); Android WorkManager min 15-min periodic. Never promise "we'll finish while closed" without push. Silent data pushes (APNs `content-available:1`, FCM data-only) are throttled by iOS — use a user-visible `farm.complete` notification as the reliable path.

---

## 6. Push notifications (APNs / FCM)

### 6.1 Library + setup

`expo-notifications` + `expo-device`. Get an Expo push token (or raw APNs/FCM device token if going bare/native-send). Register on login, store server-side keyed by `(tenant_id, user_id, device)`.

- **iOS:** APNs key (.p8) in EAS credentials; `aps-environment` entitlement; request permission via `Notifications.requestPermissionsAsync()` (include provisional/critical only if justified).
- **Android:** FCM `google-services.json` via config plugin; **notification channels** required on API 26+ — define channels: `alerts-critical` (high importance, sound/vibrate), `alerts` (default), `scans` (low, progress/complete), `reports` (low).

### 6.2 What pushes map to

The `farm.alert` model has `channels TEXT[]` already including `push`. Native push targets:

| Event | Source | Channel | Deep link |
|---|---|---|---|
| Critical/high disruption alert (irrigation-failure, flooding, disease-hotspot) | `farm.alert` ingest (P2) | `alerts-critical` | `reportfarm://farm/<id>/alerts/<alertId>` |
| Scan/HD-twin build complete | gateway `farm.complete` | `scans` | `reportfarm://studio?twin=<id>` |
| Scan failed/timeout | `farm.error` | `scans` | `reportfarm://studio` |
| Report ready | `farm.report` generate | `reports` | `reportfarm://report/<id>` |

Payload carries `{ tenant_id, deeplink, alertId?, jobId?, aoiId?, severity, dedup_key }`. On tap → expo-router navigates via the deep link (§7). **Multi-tenant guard:** if the push tenant ≠ active tenant, prompt to switch tenant before navigating (re-mint required, online).

### 6.3 Server-side coordination (call-out)

Add to the app relay / ingest worker:
- **Device registration:** `POST /api/v1/notifications/register {expo_token, platform, device_id}` (new endpoint, tenant-scoped).
- **Alert fan-out:** the P2 ingest worker, when it writes an `open` `farm.alert` whose `channels` includes `push`, enqueues an Expo push to that tenant's registered devices.
- **Scan-complete push:** gateway `farm.complete` → relay → push to the launching user's devices. This is what makes background scans usable.

**Risk:** background scan-complete depends on this server work; without it, scans only reconcile on app-open. Flag as a dependency.

---

## 7. Deep links & universal/app links

### 7.1 Scheme + prefixes

- Custom scheme: `reportfarm://` (dev/push).
- Universal Links (iOS Associated Domains `applinks:app.report.farm`) + Android App Links (`assetlinks.json` at `https://app.report.farm/.well-known/assetlinks.json`) for web→app handoff and email links.

### 7.2 expo-router route map (mirror web surfaces)

| Web URL | Deep link | Native route |
|---|---|---|
| `operations.html` | `reportfarm://portfolio` | `/(tabs)/portfolio` |
| `operations.html?farm=<id>` | `.../farm/<id>` | `/farm/[id]` |
| `operations.html?view=onboard` | `.../onboard` | `/onboard` |
| `studio.html` | `.../studio` | `/(tabs)/studio` |
| `studio.html?view=explorer` | `.../studio/explorer` | `/studio/explorer` |
| `studio.html?twin=<id>` | `.../studio?twin=<id>` → `/twin/[id]` | `/twin/[id]` |
| `report.html?report=<id>` | `.../report/<id>` | `/report/[id]` |
| `access.html` / register verify | `.../access?...` | `/access` |
| invite / email verify links | universal link → `/onboard` or `/verify` | — |

### 7.3 Security — port `sanitizeNextUrl`

The web guards deep links / `?next=` against open-redirect/traversal/foreign-host (`must end .html`, no slashes, no foreign host). **Reproduce this for native**: validate every inbound deep link against an allow-list of known routes + params before navigating; never `router.push` a raw external URL from a push payload. Reuse the role→surface allow-list (`allowedSurfacesForRoles` / `primarySurfaceForRoles`) from cached roles so a deep link the current role can't visit bounces to their primary tab.

Handle **auth-required deep links while logged out**: stash the intended route, route to `/login`, replay after auth (like web `?next=`).

---

## 8. Offline DB (expo-sqlite + Drizzle) — native storage substrate

The web's client-of-record is `localStorage` (`rf.studio.twins.v1`, `rf.studio.scanjobs.v1`) — per-browser, no sync. Native replaces this with **expo-sqlite + drizzle-orm**, tenant-partitioned. Server-authoritative farm data (farms/parcels/zones/observations/alerts/reports/portfolio) is cached read-through via React Query + a SQLite persistence layer.

**Partition every table by `tenant_id`** so tenant switch never leaks rows. On sign-out or tenant suspension, purge the tenant's rows.

### 8.1 Core DDL (Drizzle / SQLite)

```sql
-- twins (port of Twin; localStorage rf.studio.twins.v1 → table)
CREATE TABLE twin (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,              -- structure|equipment|crop|field|livestock|water|infra
  kind          TEXT NOT NULL,
  icon          TEXT, color TEXT,
  parcel_id     TEXT,                       -- nullable (orphan twins)
  geom          TEXT NOT NULL,              -- JSON: point|rect|circle|polyline|polygon
  specs         TEXT,                       -- JSON {sizeLabel,installDate,costUsd,vendor,notes}
  status        TEXT,                       -- JSON {online, readings:[{label,value,unit}]}
  linked_ids    TEXT,                       -- JSON string[]
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  dirty         INTEGER NOT NULL DEFAULT 0, -- 1 = needs server sync (future)
  deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX twin_tenant_parcel ON twin(tenant_id, parcel_id);
CREATE INDEX twin_tenant_updated ON twin(tenant_id, updated_at DESC);

-- child collections (were nested arrays on Twin) → normalized for query/sync
CREATE TABLE twin_maintenance (id TEXT PRIMARY KEY, twin_id TEXT NOT NULL, date TEXT, type TEXT, notes TEXT, created_at INTEGER);
CREATE TABLE twin_doc         (id TEXT PRIMARY KEY, twin_id TEXT NOT NULL, name TEXT, url TEXT, local_uri TEXT, note TEXT); -- local_uri = camera/file attach
CREATE TABLE twin_event       (id TEXT PRIMARY KEY, twin_id TEXT NOT NULL, date TEXT, time TEXT, title TEXT, kind TEXT, notes TEXT, done INTEGER);
CREATE TABLE twin_routine     (id TEXT PRIMARY KEY, twin_id TEXT NOT NULL, name TEXT, cadence TEXT, day_of_week INTEGER, time_of_day TEXT, action TEXT, active INTEGER, last_run TEXT);
CREATE TABLE twin_yield       (id TEXT PRIMARY KEY, twin_id TEXT NOT NULL, season TEXT, crop TEXT, quantity REAL, unit TEXT, quality TEXT, harvest_date TEXT, notes TEXT);
CREATE TABLE twin_treatment   (id TEXT PRIMARY KEY, twin_id TEXT NOT NULL, date TEXT, category TEXT, product TEXT, rate TEXT, area TEXT, applicator TEXT, reentry_hours INTEGER, notes TEXT);
CREATE TABLE twin_reading     (id TEXT PRIMARY KEY, twin_id TEXT NOT NULL, label TEXT, value TEXT, unit TEXT); -- status.readings

-- scan jobs (port rf.studio.scanjobs.v1) — MUST survive relaunch
CREATE TABLE scan_job (
  id           TEXT PRIMARY KEY,            -- sj_...
  tenant_id    TEXT NOT NULL,
  job_id       TEXT,                        -- gateway jobId
  aoi_id       TEXT, property_id TEXT, twin_id TEXT, result_twin_id TEXT,
  label        TEXT, signals TEXT,          -- JSON ScanSignal[] (sar|moisture|thermal|superres)
  boundary     TEXT,                        -- JSON ring fallback
  status       TEXT NOT NULL,               -- running|complete|error
  pct          INTEGER DEFAULT 0, stage TEXT, message TEXT,
  started_at   INTEGER, updated_at INTEGER
);
CREATE INDEX scan_job_running ON scan_job(tenant_id, status);

-- read-through cache of server-authoritative data (React Query persistence)
CREATE TABLE farm_cache        (tenant_id TEXT, id TEXT, json TEXT, aoi_w REAL, aoi_s REAL, aoi_e REAL, aoi_n REAL, cached_at INTEGER, PRIMARY KEY(tenant_id,id));
CREATE TABLE parcel_cache      (tenant_id TEXT, id TEXT, farm_id TEXT, json TEXT, cached_at INTEGER, PRIMARY KEY(tenant_id,id));
CREATE TABLE zone_cache        (tenant_id TEXT, id TEXT, farm_id TEXT, json TEXT, cached_at INTEGER, PRIMARY KEY(tenant_id,id));
CREATE TABLE alert_cache       (tenant_id TEXT, id TEXT, farm_id TEXT, json TEXT, status TEXT, cached_at INTEGER, PRIMARY KEY(tenant_id,id));
CREATE TABLE observation_cache (tenant_id TEXT, id TEXT, farm_id TEXT, json TEXT, cached_at INTEGER, PRIMARY KEY(tenant_id,id));
CREATE TABLE signal_cache      (tenant_id TEXT, bbox_key TEXT, json TEXT, cached_at INTEGER, PRIMARY KEY(tenant_id,bbox_key)); -- last FeatureCollection per AOI

-- offline write queue (ack alert, feedback, generate report, farm/parcel/zone create)
CREATE TABLE mutation_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL, method TEXT, path TEXT, body TEXT,
  idempotency_key TEXT, created_at INTEGER, tries INTEGER DEFAULT 0, last_error TEXT
);

-- offline tile packs
CREATE TABLE tile_pack (farm_id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, bounds TEXT, min_z INTEGER, max_z INTEGER, bytes INTEGER, downloaded_at INTEGER);
```

### 8.2 Offline write queue semantics

Writes that need connectivity + server-side validation (PostGIS `ST_IsValid`, RLS): farm/parcel/zone create, alert ack, report generate, action-feedback. Queue them, flush on reconnect (NetInfo), and reconcile:
- **Alert ack** — replay may hit `409 invalid_status_transition` (already resolved/suppressed) → drop from queue, no error to user.
- **Farm create** — multi-step (farm→parcels→zones), non-atomic on server. Track `partialFarmId`; on partial failure, do not re-POST the created farm (dedupe via idempotency key). Mirror the web's `handleCreateError` taxonomy (`422 invalid_geometry` → bounce to boundary step).
- **Geometry** — compute preview area/bbox locally (`ringAreaM2`), but treat server `area_ha`/`aoi_*` as source-of-truth on sync (server can't be spoofed).
- **Token expiry at replay** — if JWT expired (decode `exp`), re-auth before flushing; every queued request carries `Authorization: Bearer` + `x-tenant-id` at replay time.

---

## 9. Permissions (per-platform)

| Permission | Modules | iOS (Info.plist) | Android (Manifest + runtime) | When requested |
|---|---|---|---|---|
| Location (when-in-use) | expo-location | `NSLocationWhenInUseUsageDescription` | `ACCESS_FINE_LOCATION`/`COARSE` | On find-my-farm / "use my location" tap (not at launch) |
| Camera | expo-camera | `NSCameraUsageDescription` | `CAMERA` | On first capture in object-to-twin / photo attach |
| Photo library | expo-image-picker/media-library | `NSPhotoLibraryUsageDescription`, `...AddUsageDescription` | `READ_MEDIA_IMAGES` (API 33+) / scoped | On "import drone photo" / save capture |
| Notifications | expo-notifications | provisional/authorized | `POST_NOTIFICATIONS` (API 33+) | After first meaningful value (post-onboarding), not cold launch |
| App Tracking Transparency | expo-tracking-transparency | `NSUserTrackingUsageDescription` | n/a | Only if analytics SDK requires IDFA (likely skip) |
| Background fetch | expo-background-task | BGTaskScheduler ids in Info.plist | `WAKE_LOCK` (WorkManager) | implicit |

**Rules:** request lazily at point-of-use with a pre-permission priming screen (explain *why* before the OS dialog); handle denial gracefully (find-my-farm falls back to address search; camera falls back to gallery import). Never block onboarding on any permission. Provide a Settings deep-link (`Linking.openSettings()`) when a needed permission is "denied, don't ask again".

---

## 10. Auth transport on native (no cookies)

The web uses cookies for the access-pass and localStorage for the JWT. Native has neither in the same way — use headers + secure storage (the inventory explicitly notes native shells should use the header path):

- **Access pass:** `POST /api/v1/access/verify` returns `pass_token` in the body (for native). Store in `expo-secure-store`; send as **`X-Access-Pass: <token>`** on gated requests. 1h TTL → re-prompt on expiry. Gate is online-only.
- **Session JWT (8h):** `expo-secure-store` (Keychain/Keystore). Send **`Authorization: Bearer <jwt>` + `X-Tenant-Id: <uuid|slug>` on every business call.** Decode `exp` client-side to pre-empt expiry.
- **401 handling:** `401 token_revoked` or `403 tenant_suspended` → hard sign-out / locked state (clear secure store + purge tenant SQLite + cancel push registration + route to login), mirroring web `clear-on-401`.
- **Persisted state → secure store / SQLite:** `rwr.auth`→secure-store(token+user), `rwr.tenant`→secure-store(id/slug/name/myOrgs), `rwr.surface-mode`→AsyncStorage (theme, preserved on logout).
- **OIDC (opt-in):** `expo-auth-session` PKCE + system browser, app-link redirect; capture the app JWT handoff.

Central `api()` client (port `api.ts`): base URL, inject Bearer + X-Tenant-Id + X-Access-Pass, `ApiError` with `status`, clear-on-401, and the `isUnconfigured` (503 `gateway_unconfigured`) / `vision_not_available` (404) honest-degradation detectors — carried verbatim so every gateway surface degrades identically to web.

---

## 11. Honesty tiers in native UI (must carry)

Non-negotiable, load-bearing for product trust — reproduce verbatim:
- **Tier badges:** T1 regulatory / T2 evidence / T3 screening. Cadastral parcels = T2 (exact); OSM/vision = T3 (approximate → "drag corners to trace exact").
- **Honest-empty:** "No signals yet — run a scan", "No parcel found", "No clear field detected here", "Awaiting first satellite pass". Never fabricate.
- **Honest-degraded states → distinct UI, not generic errors:** `503 gateway_unconfigured` → "Automatic lookup isn't connected yet — import or draw below"; `404 vision_not_available` → "AI auto-trace isn't live yet"; WebGL/GL failure → static fallback card; `422 bbox_too_large`/`invalid_geometry`, `502 unreachable` each map to their own copy.
- **RiskPill:** `band=null` → "Unmonitored" (dashed), never a fake green; color never carries meaning alone (icon+label required) — colorblind-safe. Port the `RiskBand` ramp component.
- **Nulls preserved:** `sceneId`/`cloudPct` honest-nulls on signals; ndvi/evi absent (honest `no_producer`).

---

## 12. Diagram — native layer topology (text)

```
┌──────────────────────────────── Expo App (RN 0.76, expo-router) ─────────────────────────────┐
│                                                                                               │
│  UI screens (Portfolio / Onboard / Studio / Twin / Report / Login)                            │
│      │                                                                                         │
│  ┌───┴───────────── Native capability layer (THIS DOC) ─────────────────────────────────┐     │
│  │                                                                                        │    │
│  │  MapLibre Native ── Esri raster + LAYER_PAINT switcher + twin/signal/draft/edit layers │    │
│  │      │  gesture-handler → tap/pan/long-press authoring; queryRenderedFeatures hit-test │    │
│  │      └─ OfflineManager (ambient cache + per-AOI packs)                                  │    │
│  │                                                                                        │    │
│  │  expo-gl + three ── ParcelCutaway (BoxGeom, ACES, bundled soil-strata.jpg,             │    │
│  │                     server-composited satellite top-face)                              │    │
│  │                                                                                        │    │
│  │  expo-camera/-image-picker/-image-manipulator → upload → vision/segment (T3)           │    │
│  │  expo-location (drop-pin, GPS boundary)                                                 │    │
│  │  react-native-sse (Bearer+tenant) ─┐                                                    │    │
│  │  expo-task-manager/-background-task ┼─ scan-job runner (foreground SSE + resume-poll)   │    │
│  │  expo-notifications (APNs/FCM) ─────┘  ← authoritative farm.complete / alert push       │    │
│  │  expo-linking (deep/universal links, sanitized) → expo-router                           │    │
│  │  expo-secure-store (JWT, access-pass, tenant) · expo-sqlite+Drizzle (offline DB)        │    │
│  └────────────────────────────────────────────────────────────────────────────────────────┘   │
│                                    │  Authorization: Bearer + X-Tenant-Id + X-Access-Pass       │
└────────────────────────────────────┼──────────────────────────────────────────────────────────┘
                                     ▼
          app API  /api/v1/farm/*  (REST: farms/parcels/zones/observations/alerts/reports/portfolio)
          app relay /api/v1/farm/gw/* (byte-forwarder) ──► AlphaGeo gateway /api/farm|gis|aoi|vision
          (NEW) /api/v1/notifications/register · (NEW) /api/v1/farm/tiles/composite
```

---

## 13. Per-platform difference summary

| Area | iOS specifics | Android specifics |
|---|---|---|
| Map renderer | MapLibre Native on **Metal** | MapLibre Native on **GLES/Vulkan**; more device GPU variance → test low-end |
| 3D cutaway | EXGL over Metal; context stable | EXGL context can drop on background → guard + rebuild |
| Push | APNs .p8 key; provisional auth possible; silent push throttled | FCM `google-services.json`; **notification channels mandatory** (API 26+); `POST_NOTIFICATIONS` runtime (API 33+) |
| Background jobs | BGTaskScheduler — opportunistic, register task ids in Info.plist | WorkManager — 15-min min periodic; Doze/OEM battery killers (Xiaomi/Huawei) aggressive → push primary |
| Deep links | Associated Domains entitlement + AASA file | `assetlinks.json` + `autoVerify` intent filter |
| Offline media perms | Photo add/read usage strings | Scoped storage / `READ_MEDIA_IMAGES` (API 33+) |
| Location precision | "Precise/Approximate" toggle (iOS 14+) → handle approximate | background-location not needed (foreground pin only) |
| Tile caching legal | same Esri ToS concern | same |

---

## 14. Risks & mitigations (ranked)

1. **Background scan completion (High).** OS suspends SSE; builds are 5+ min. → **Push-driven completion** (needs server work §6.3) + resume-poll-on-open + `twins/:aoi` reconciler. Never promise closed-app completion without push.
2. **Esri tile caching / basemap ToS (High-to-track).** Keyless Esri may forbid bulk caching. → Cap offline packs to farm AOI, evaluate licensed source for offline path, make opt-in, get legal sign-off.
3. **MapLibre Native requires custom dev client + no globe (Med-High).** → EAS dev client from day one; ship flat find-my-farm fallback; defer Cesium-WebView globe.
4. **SSE header injection + reconnect on flaky mobile networks (Med).** → `react-native-sse` (XHR, header-capable) + exponential backoff + poll fallback; port `\n\n` reframing/heartbeat-skip logic.
5. **expo-gl context loss + texture pipeline (Med).** → Bundle `soil-strata.jpg`; server-composite the satellite top-face (also fixes Esri CORS/auth); dispose on unmount; static fallback card.
6. **KML parsing without DOM (Med).** → `@xmldom/xmldom` polyfill for `@tmcw/togeojson`; spike `shpjs` on RN early.
7. **Offline write reconciliation (Med).** → Idempotency keys, 409-tolerant ack replay, partial-farm-create tracking, server area/aoi authoritative.
8. **Multi-tenant leakage in offline cache (Med).** → Partition every SQLite table by `tenant_id`; purge on tenant switch/sign-out; emit app-level `tenant-changed` to invalidate React Query.
9. **Push tenant ≠ active tenant (Low-Med).** → Prompt tenant switch (online re-mint) before deep-link nav.
10. **Camera/vision is online-only + not yet deployed (Low).** → Queue captures offline; preserve `vision_not_available` "coming soon"; T3 labels.

---

## 15. Build order (native track)

1. **Foundation:** EAS dev client, `api()` client (Bearer/tenant/access-pass + honest-degradation detectors), `expo-secure-store` auth, `expo-sqlite`+Drizzle schema (§8), NetInfo + mutation queue.
2. **MapLibre Native basemap + layer switcher + FarmMap/GeometryPreview** (read-only overlays). Offline ambient cache.
3. **Studio authoring:** tool rail → touch gestures, draft/edit vertex layers, twins CRUD to SQLite, geometry helpers (port pure TS).
4. **Find-my-farm** (flat fallback), parcel lookup client, boundary import (`@xmldom/xmldom` KML, `shpjs`, GeoJSON), onboarding wizard with SQLite draft autosave.
5. **3D cutaway** (expo-gl + three), server tile-composite endpoint, bundled strata texture.
6. **Scan jobs:** `react-native-sse` runner + SQLite job store + resume-on-open; then push-driven completion (with server §6.3).
7. **Push** (APNs/FCM, channels, device register) + alert deep links.
8. **Camera → vision** capture pipeline (wire when gateway vision deploys).
9. **Offline tile packs** (after legal sign-off), deep/universal links + sanitizer, polish.
