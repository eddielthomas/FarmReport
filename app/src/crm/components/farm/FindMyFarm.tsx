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
import { MapPin, Search, Loader2, Check, Info, Crosshair } from 'lucide-react';
import { cn } from '@crm/lib/utils';
import { Button } from '@crm/components/ui/button';
import { Input } from '@crm/components/ui/input';
import {
  findParcelByPoint, findParcelByAddress, type Parcel,
} from '@crm/lib/gateway-parcel';

type Polygonal = GeoJSON.Polygon | GeoJSON.MultiPolygon;

// Keyless Esri satellite substrate — same source BoundaryImport's preview uses,
// so the "find" map and the "preview" map read as one surface.
const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    'esri-imagery': {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Esri, Maxar, Earthstar Geographics',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0B0A08' } },
    { id: 'esri-imagery', type: 'raster', source: 'esri-imagery' },
  ],
};

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

      {/* Drop-a-pin satellite map */}
      <PinMap onPick={(lat, lon) => void runPoint(lat, lon)} busy={busy} />

      {/* Result / status line */}
      {status === 'found' && found && (
        <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[color-mix(in_oklch,var(--risk-healthy)_40%,transparent)] bg-[color-mix(in_oklch,var(--risk-healthy-fill)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--fg)]">
          <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--risk-healthy)]" />
          <span>
            Found your farm{found.address ? <> — <span className="font-medium">{found.address}</span></> : ''}
            {found.areaHa != null && <> · <span className="tabular-nums">{found.areaHa.toLocaleString(undefined, { maximumFractionDigits: 1 })} ha</span></>}.
            {' '}Not right? Adjust below or import manually.
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
    </div>
  );
}

// -----------------------------------------------------------------------------
// PinMap — a satellite canvas where a click drops a pin and reports lat/lon.
// Degrades to a static note when WebGL is unavailable (same posture as
// GeometryPreview), so onboarding never hard-crashes on a headless/VM browser.
// -----------------------------------------------------------------------------

function PinMap({ onPick, busy }: { onPick: (lat: number, lon: number) => void; busy: boolean }) {
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
      map = new maplibregl.Map({
        container: el, style: SATELLITE_STYLE, center: [-98, 39], zoom: 3,
        attributionControl: { compact: true }, maxPitch: 0,
      });
    } catch (e) {
      console.warn('[FindMyFarm] map init failed; hiding pin drop', e);
      setFailed(true);
      return;
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    map.on('error', (ev) => { console.warn('[FindMyFarm] map error', ev?.error ?? ev); });
    map.on('click', (e) => {
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
      ro?.disconnect();
      try { map.remove(); } catch { /* ignore */ }
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

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
        className="relative h-[220px] w-full overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)]"
        aria-label="Drop a pin to find your farm"
      />
      <div className="pointer-events-none absolute left-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-[var(--radius-full)] bg-[color-mix(in_oklch,var(--bg)_70%,transparent)] px-2.5 py-1 text-[11px] font-medium text-[var(--fg)] backdrop-blur-sm">
        <MapPin className="size-3 text-[var(--accent)]" />
        {busy ? 'Locating…' : 'Click the map to drop a pin on your farm'}
      </div>
    </div>
  );
}
