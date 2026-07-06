// =============================================================================
// FindMyFarm — the keystone onboarding affordance: locate a farm's parcel
// boundary automatically (via the AlphaGeo gateway relay) so the user doesn't
// have to hand-import GeoJSON.
// -----------------------------------------------------------------------------
// Two ways in:
//   • Type an address   → GET /farm/gw/parcel-by-address?q
//   • Drop a pin on the  → GET /farm/gw/parcel?lat&lon
//     satellite map
// A resolved parcel boundary is handed up via onParcel(boundary) — the SAME sink
// the manual BoundaryImport feeds, so review/create are untouched.
//
// GRACEFUL BY DESIGN: when the gateway env is unset the relay returns a 503 and
// the client reports { configured:false }. We then collapse to a subtle note and
// let the manual import/paste path below carry onboarding — it is NEVER blocked.
//
// Style: tokens only (cobalt --accent, warm --surface/--fg-muted), frosted
// over-map controls, WebGL-failure fallback — matching BoundaryImport.
// =============================================================================

import * as React from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapPin, Search, Loader2, Check, Info, Crosshair, Wand2 } from 'lucide-react';
import { cn } from '@crm/lib/utils';
import { Button } from '@crm/components/ui/button';
import { Input } from '@crm/components/ui/input';
import {
  findParcelByPoint, findParcelByAddress, type Parcel,
} from '@crm/lib/gateway-parcel';

type Polygonal = GeoJSON.Polygon | GeoJSON.MultiPolygon;

// Keyless Esri satellite substrate — same source BoundaryImport's preview uses,
// so the "find" map and the "preview" map read as one surface. Rendered on a
// globe (maplibre v5 projection) with an atmosphere so onboarding opens on the
// whole planet, then flies down to the located farm.
const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  projection: { type: 'globe' },
  sources: {
    'esri-imagery': {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Esri, Maxar, Earthstar Geographics',
    },
  },
  sky: {
    'sky-color': '#0a1a3a',
    'sky-horizon-blend': 0.5,
    'horizon-color': '#3a5f8a',
    'horizon-fog-blend': 0.6,
    'fog-color': '#0B0A08',
    'fog-ground-blend': 0.4,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 4, 0.5, 8, 0],
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#05060a' } },
    { id: 'esri-imagery', type: 'raster', source: 'esri-imagery' },
  ],
};

// Centroid of a (multi)polygon boundary — used to fly the globe to the farm.
function boundaryCenter(b: Polygonal): [number, number] {
  const rings = b.type === 'Polygon' ? [b.coordinates[0]] : b.coordinates.map((p) => p[0]);
  let x = 0, y = 0, n = 0;
  for (const ring of rings) for (const [lng, lat] of ring) { x += lng; y += lat; n++; }
  return n ? [x / n, y / n] : [0, 0];
}

type Status = 'idle' | 'searching' | 'found' | 'notfound' | 'error';

export interface FindMyFarmProps {
  /** Called with the resolved parcel boundary — feeds the same state manual import sets. */
  onParcel: (boundary: Polygonal) => void;
  className?: string;
}

export function FindMyFarm({ onParcel, className }: FindMyFarmProps) {
  const [address, setAddress] = React.useState('');
  const [status, setStatus] = React.useState<Status>('idle');
  // null until we learn the gateway isn't wired up; once false we collapse to a note.
  const [configured, setConfigured] = React.useState(true);
  const [found, setFound] = React.useState<Parcel | null>(null);
  const [errMsg, setErrMsg] = React.useState<string | null>(null);
  // Where to fly the globe: a located parcel's centroid (or a dropped pin).
  const [focus, setFocus] = React.useState<{ lng: number; lat: number; zoom: number } | null>(null);

  // Handle a GatewayResult uniformly for both entry points.
  const consume = React.useCallback((
    res: { configured: true; parcel: Parcel | null } | { configured: false },
  ) => {
    if (!res.configured) {
      setConfigured(false);
      setStatus('idle');
      return;
    }
    if (!res.parcel) {
      setStatus('notfound');
      setFound(null);
      return;
    }
    setFound(res.parcel);
    setStatus('found');
    const [lng, lat] = boundaryCenter(res.parcel.boundary);
    setFocus({ lng, lat, zoom: 14 });
    onParcel(res.parcel.boundary);
  }, [onParcel]);

  const runAddress = React.useCallback(async () => {
    const q = address.trim();
    if (!q) return;
    setStatus('searching'); setErrMsg(null);
    try {
      consume(await findParcelByAddress(q));
    } catch (e) {
      setStatus('error');
      setErrMsg(e instanceof Error ? e.message : 'Lookup failed.');
    }
  }, [address, consume]);

  const runPoint = React.useCallback(async (lat: number, lon: number) => {
    setStatus('searching'); setErrMsg(null);
    try {
      consume(await findParcelByPoint(lat, lon));
    } catch (e) {
      setStatus('error');
      setErrMsg(e instanceof Error ? e.message : 'Lookup failed.');
    }
  }, [consume]);

  // Gateway not wired up (env unset) — degrade to a subtle, non-blocking note.
  if (!configured) {
    return (
      <div
        className={cn(
          'flex items-start gap-2 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)]/50 px-3.5 py-2.5 text-[12px] text-[var(--fg-muted)]',
          className,
        )}
      >
        <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--fg-subtle)]" />
        <span>Automatic lookup isn't connected yet — import or draw your boundary below.</span>
      </div>
    );
  }

  const busy = status === 'searching';

  return (
    <div
      className={cn(
        'rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface-sunken)]/40 p-4 space-y-3',
        className,
      )}
    >
      <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
        <Crosshair className="size-3.5 text-[var(--accent)]" /> Find my farm
      </div>
      <p className="text-[12px] text-[var(--fg-muted)]">
        Type your farm address, or drop a pin on the map — we'll pull the parcel boundary for you.
        You can fine-tune it below afterward.
      </p>

      {/* Address lookup */}
      <div className="flex items-center gap-2">
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void runAddress(); } }}
          placeholder="e.g. 1200 County Road 14, Fresno, CA"
          className="h-9 flex-1 text-[13px]"
          disabled={busy}
        />
        <Button type="button" variant="accent" size="sm" onClick={() => void runAddress()} disabled={busy || !address.trim()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />} Find
        </Button>
      </div>

      {/* Drop-a-pin globe */}
      <PinMap onPick={(lat, lon) => void runPoint(lat, lon)} busy={busy} focus={focus} />

      {/* Result / status line */}
      {status === 'found' && found && (
        <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[color-mix(in_oklch,var(--risk-healthy)_40%,transparent)] bg-[color-mix(in_oklch,var(--risk-healthy-fill)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--fg)]">
          <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--risk-healthy)]" />
          <span>
            {found.approximate ? 'Located your farm' : 'Found your parcel'}
            {found.address ? <> — <span className="font-medium">{found.address}</span></> : ''}
            {found.areaHa != null && <> · <span className="tabular-nums">{found.areaHa.toLocaleString(undefined, { maximumFractionDigits: 1 })} ha</span></>}.
            {found.approximate
              ? <> {' '}This is an <span className="font-medium">approximate</span> outline — drag its corners below to trace your exact boundary.</>
              : <> {' '}Not right? Adjust below or import manually.</>}
          </span>
        </div>
      )}
      {status === 'notfound' && (
        <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)]/60 px-3 py-2 text-[12px] text-[var(--fg-muted)]">
          <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--fg-subtle)]" />
          <span>No parcel found there. Try a more specific address, drop the pin on the field, or import the boundary below.</span>
        </div>
      )}
      {status === 'error' && (
        <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)]/60 px-3 py-2 text-[12px] text-[var(--fg-muted)]">
          <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--fg-subtle)]" />
          <span>Automatic lookup ran into a problem{errMsg ? ` (${errMsg})` : ''}. You can import or draw your boundary below.</span>
        </div>
      )}

      {/* AI auto-trace (SAM2 field segmentation) — stubbed until the gateway
          delineation endpoint lands (wing_farm-agent/requests ASK 19dc90e6). When
          ready: on click, POST the point → segmented boundary → onParcel(boundary),
          which drops the traced polygon straight into the editor to fine-tune. */}
      <AutoTraceButton />
    </div>
  );
}

/** Placeholder for AI field auto-trace. The gateway can run SAM2 on the Sentinel-2
 *  tile to delineate a parcel boundary (parcel delineationOption, tier T3); the
 *  callable endpoint is pending (farm↔gateway ASK). Disabled until then so the
 *  affordance is discoverable without implying it works yet. */
function AutoTraceButton() {
  return (
    <button
      type="button"
      disabled
      title="AI field segmentation (SAM2 on Sentinel-2) — coming soon. It will auto-trace your field boundary for you to fine-tune."
      className="flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-dashed border-[var(--border)] bg-[var(--surface-sunken)]/40 px-3 py-2 text-[12px] text-[var(--fg-muted)] disabled:cursor-not-allowed disabled:opacity-70"
    >
      <Wand2 className="size-3.5 text-[var(--accent)]" />
      Auto-trace field with AI
      <span className="ml-1 rounded-full border border-[var(--border)] px-1.5 py-px text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-subtle)]">Soon</span>
    </button>
  );
}

// -----------------------------------------------------------------------------
// PinMap — a satellite canvas where a click drops a pin and reports lat/lon.
// Degrades to a static note when WebGL is unavailable (same posture as
// GeometryPreview), so onboarding never hard-crashes on a headless/VM browser.
// -----------------------------------------------------------------------------

function PinMap({ onPick, busy, focus }: { onPick: (lat: number, lon: number) => void; busy: boolean; focus: { lng: number; lat: number; zoom: number } | null }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<maplibregl.Map | null>(null);
  const markerRef = React.useRef<maplibregl.Marker | null>(null);
  const onPickRef = React.useRef(onPick);
  onPickRef.current = onPick;
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    let map: maplibregl.Map;
    try {
      // Open on the whole planet — a slow-spinning satellite globe floating in space.
      map = new maplibregl.Map({
        container: el, style: SATELLITE_STYLE, center: [-30, 12], zoom: 0.15,
        attributionControl: { compact: true }, maxPitch: 0, renderWorldCopies: false,
      });
    } catch (e) {
      console.warn('[FindMyFarm] map init failed; hiding pin drop', e);
      setFailed(true);
      return;
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    map.on('error', (ev) => { console.warn('[FindMyFarm] map error', ev?.error ?? ev); });
    // Belt-and-suspenders: ensure globe even if the style projection is dropped.
    map.on('style.load', () => { try { map.setProjection({ type: 'globe' }); } catch { /* pre-v5 core has no globe */ } });
    // A brief, bounded intro spin so the planet feels alive — then it settles.
    // (Perpetual spin churns the globe's GPU readback path and spams warnings.)
    let spin = true;
    const SPIN_MS = 7000;
    const startedAt = (typeof performance !== 'undefined' ? performance.now() : 0);
    const stopSpin = () => { spin = false; };
    map.on('mousedown', stopSpin); map.on('touchstart', stopSpin); map.on('wheel', stopSpin);
    const tick = () => {
      if (!mapRef.current) return;
      const elapsed = (typeof performance !== 'undefined' ? performance.now() : 0) - startedAt;
      if (spin && elapsed < SPIN_MS) {
        if (!map.isMoving()) { const c = map.getCenter(); map.easeTo({ center: [c.lng + 0.6, c.lat], duration: 400, easing: (t) => t }); }
        rafId = requestAnimationFrame(tick);
      }
    };
    let rafId = requestAnimationFrame(tick);
    map.on('click', (e) => {
      spin = false;
      const { lat, lng } = e.lngLat;
      if (!markerRef.current) {
        markerRef.current = new maplibregl.Marker({ color: '#4C7EFF' }).setLngLat([lng, lat]).addTo(map);
      } else {
        markerRef.current.setLngLat([lng, lat]);
      }
      onPickRef.current(lat, lng);
    });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.resize()) : null;
    ro?.observe(el);
    return () => {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      try { map.remove(); } catch { /* ignore */ }
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  // Fly the globe to a located farm and drop/settle the pin there.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    if (!markerRef.current) markerRef.current = new maplibregl.Marker({ color: '#4C7EFF' }).setLngLat([focus.lng, focus.lat]).addTo(map);
    else markerRef.current.setLngLat([focus.lng, focus.lat]);
    map.flyTo({ center: [focus.lng, focus.lat], zoom: focus.zoom, duration: 2600, essential: true });
  }, [focus]);

  if (failed) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-6 text-center text-[12px] text-[var(--fg-muted)]">
        <MapPin className="size-4 text-[var(--fg-subtle)]" />
        Pin-drop map unavailable in this browser — use the address search above or import below.
      </div>
    );
  }

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="relative h-[440px] w-full overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[#05060a]"
        aria-label="Drop a pin to find your farm"
      />
      <div className="pointer-events-none absolute left-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-[var(--radius-full)] bg-[color-mix(in_oklch,var(--bg)_70%,transparent)] px-2.5 py-1 text-[11px] font-medium text-[var(--fg)] backdrop-blur-sm">
        <MapPin className="size-3 text-[var(--accent)]" />
        {busy ? 'Locating…' : 'Click the map to drop a pin on your farm'}
      </div>
    </div>
  );
}
