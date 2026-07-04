// =============================================================================
// FarmMap — read-only field map for the Farm Detail surface (Screen B).
// -----------------------------------------------------------------------------
// Renders one farm over a dark satellite/vector canvas: the farm boundary
// (cobalt outline), its parcels (hairline neutral), and its monitoring zones
// filled by *intent* (irrigation, standing-water, structure, crop). Chrome
// floats over the imagery as frosted glass per the design system — the map
// canvas stays dark in both surface modes. Fits the camera to the geometry with
// a spatial spring; degrades to an honest "no geometry" state.
//
// Pure presentational: the caller owns the fetched geometry. Green here is a
// *vegetation/water data signal*, kept off the UI risk ramp on purpose.
// =============================================================================

import * as React from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapPinned, Droplets, Waves, Home, Sprout, Hexagon } from 'lucide-react';

// Keyless Esri World Imagery satellite raster — a true satellite canvas that
// paints without an API key or an external style JSON (the Carto vector style
// was silently failing to load its style/glyphs here). Matches the basemap the
// onboarding boundary preview uses, so both farm maps read consistently.
const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    'esri-imagery': {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0B0C0F' } },
    { id: 'esri-imagery', type: 'raster', source: 'esri-imagery' },
  ],
};

// Zone geometry + intent, as served by /farm/farms/:id/zones. Shared with
// ZoneList (which imports these), so the shape is declared once here.
export interface ZoneIntent {
  expectedWaterFlow?: boolean;
  standingWaterAllowed?: boolean;
  vegetationPriority?: 'low' | 'medium' | 'high' | string;
  alertSensitivity?: 'low' | 'medium' | 'high' | string;
  [k: string]: unknown;
}
export interface Zone {
  id: string;
  name: string;
  type: string | null;
  intent: ZoneIntent | null;
  parcel_id: string | null;
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
}
export interface Parcel {
  id: string;
  name: string;
  area_ha: number | string | null;
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
}

// --- Zone intent classification -------------------------------------------
// Derives a stable "kind" from the zone type + intent flags. Colors are
// concrete hex (MapLibre paint can't read CSS vars) drawn from the design
// system's categorical/telemetry palette — deliberately NOT the risk ramp.
export type ZoneKind = 'irrigation' | 'wetland' | 'structure' | 'crop' | 'other';

export const ZONE_KIND: Record<ZoneKind, { label: string; color: string; Icon: React.FC<{ className?: string }> }> = {
  irrigation: { label: 'Irrigation',    color: '#35C6DC', Icon: Droplets }, // --cyan telemetry
  wetland:    { label: 'Standing water', color: '#4C7EFF', Icon: Waves },   // --accent blue
  structure:  { label: 'Structure',     color: '#A8967A', Icon: Home },     // warm neutral
  crop:       { label: 'Crop field',    color: '#1BAF7A', Icon: Sprout },   // --viz-2 vegetation
  other:      { label: 'Zone',          color: '#8E7BE0', Icon: Hexagon },  // --viz-5 indigo
};

export function classifyZone(z: Pick<Zone, 'type' | 'intent'>): ZoneKind {
  const t = (z.type ?? '').toLowerCase();
  const i = z.intent ?? {};
  if (/barn|structure|building|shed|silo|storage/.test(t)) return 'structure';
  if (i.expectedWaterFlow || /irrig|pivot|sprinkler|drip/.test(t)) return 'irrigation';
  if (i.standingWaterAllowed || /pond|wetland|water|marsh|lake|basin/.test(t)) return 'wetland';
  if (/field|crop|plot|orchard|pasture|row/.test(t)) return 'crop';
  return 'other';
}

// --- Bounds helper ---------------------------------------------------------
type LngLatBounds = [number, number, number, number]; // [w, s, e, n]

function extendBounds(b: LngLatBounds | null, geom: GeoJSON.Geometry | null | undefined): LngLatBounds | null {
  if (!geom || !('coordinates' in geom)) return b;
  let acc = b;
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
      const [lng, lat] = c as [number, number];
      acc = acc
        ? [Math.min(acc[0], lng), Math.min(acc[1], lat), Math.max(acc[2], lng), Math.max(acc[3], lat)]
        : [lng, lat, lng, lat];
    } else if (Array.isArray(c)) {
      for (const inner of c) visit(inner);
    }
  };
  visit((geom as { coordinates: unknown }).coordinates);
  return acc;
}

interface FarmMapProps {
  boundary: GeoJSON.MultiPolygon | GeoJSON.Polygon | null;
  parcels: Parcel[];
  zones: Zone[];
  className?: string;
}

export function FarmMap({ boundary, parcels, zones, className = '' }: FarmMapProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const hasGeometry =
    !!boundary ||
    parcels.some((p) => p.geom) ||
    zones.some((z) => z.geom);

  // Compute the fit bounds + the zone-kinds present (for the legend).
  const { bounds, kindsPresent } = React.useMemo(() => {
    let b: LngLatBounds | null = null;
    b = extendBounds(b, boundary);
    for (const p of parcels) b = extendBounds(b, p.geom);
    for (const z of zones) b = extendBounds(b, z.geom);
    const kinds = new Set<ZoneKind>();
    for (const z of zones) if (z.geom) kinds.add(classifyZone(z));
    return { bounds: b, kindsPresent: kinds };
  }, [boundary, parcels, zones]);

  // Init map once.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current || !hasGeometry) return;
    // Map construction throws when a WebGL context can't be created (hardware
    // acceleration off, VM/remote desktop, driver issues, context exhaustion).
    // Degrade to a static fallback instead of letting the throw unmount the
    // FarmDetail tree.
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: el,
        style: SATELLITE_STYLE,
        center: bounds ? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2] : [-93.65, 42.0],
        zoom: 10,
        attributionControl: { compact: true },
        maxPitch: 0,
        dragRotate: false,
      });
    } catch (e) {
      console.warn('[FarmMap] map init failed; showing static fallback', e);
      setFailed(true);
      return;
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    mapRef.current = map;
    map.on('error', (ev) => { console.warn('[FarmMap] map error', ev?.error ?? ev); });
    map.on('load', () => {
      setReady(true);
      map.resize();
    });
    return () => {
      try { map.remove(); } catch { /* ignore */ }
      mapRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasGeometry]);

  // Keep the map sized to its container.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => mapRef.current?.resize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasGeometry]);

  // (Re)draw layers whenever geometry changes and the style is ready.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const boundaryFC: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: boundary ? [{ type: 'Feature', geometry: boundary, properties: {} }] : [],
    };
    const parcelFC: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: parcels
        .filter((p) => p.geom)
        .map((p) => ({ type: 'Feature', geometry: p.geom as GeoJSON.Geometry, properties: { name: p.name } })),
    };
    const zoneFC: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: zones
        .filter((z) => z.geom)
        .map((z) => {
          const kind = classifyZone(z);
          return {
            type: 'Feature',
            geometry: z.geom as GeoJSON.Geometry,
            properties: { name: z.name, kind, color: ZONE_KIND[kind].color },
          };
        }),
    };

    const upsert = (id: string, data: GeoJSON.FeatureCollection) => {
      const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
      else map.addSource(id, { type: 'geojson', data });
    };

    upsert('farm-boundary', boundaryFC);
    upsert('farm-parcels', parcelFC);
    upsert('farm-zones', zoneFC);

    if (!map.getLayer('parcels-fill')) {
      map.addLayer({
        id: 'parcels-fill', type: 'fill', source: 'farm-parcels',
        paint: { 'fill-color': '#F5F3EE', 'fill-opacity': 0.04 },
      });
      map.addLayer({
        id: 'parcels-line', type: 'line', source: 'farm-parcels',
        paint: { 'line-color': '#A8A39A', 'line-width': 1, 'line-opacity': 0.5, 'line-dasharray': [2, 2] },
      });
    }
    if (!map.getLayer('zones-fill')) {
      map.addLayer({
        id: 'zones-fill', type: 'fill', source: 'farm-zones',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.22 },
      });
      map.addLayer({
        id: 'zones-line', type: 'line', source: 'farm-zones',
        paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.9 },
      });
    }
    if (!map.getLayer('boundary-line')) {
      // Boundary drawn last so it reads above the fills.
      map.addLayer({
        id: 'boundary-glow', type: 'line', source: 'farm-boundary',
        paint: { 'line-color': '#4C7EFF', 'line-width': 6, 'line-opacity': 0.18, 'line-blur': 4 },
      });
      map.addLayer({
        id: 'boundary-line', type: 'line', source: 'farm-boundary',
        paint: { 'line-color': '#4C7EFF', 'line-width': 2, 'line-opacity': 0.95 },
      });
    }

    // Hover tooltip on zones.
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'farm-zone-popup', offset: 8 });
    const onEnter = (e: maplibregl.MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = 'pointer';
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as { name?: string; kind?: ZoneKind };
      const label = p.kind ? ZONE_KIND[p.kind as ZoneKind]?.label ?? 'Zone' : 'Zone';
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font:600 12px Inter,system-ui;color:#F5F3EE">${p.name ?? 'Zone'}</div>` +
          `<div style="font:500 11px Inter,system-ui;color:#A8A39A">${label}</div>`,
        )
        .addTo(map);
    };
    const onLeave = () => { map.getCanvas().style.cursor = ''; popup.remove(); };
    map.on('mousemove', 'zones-fill', onEnter);
    map.on('mouseleave', 'zones-fill', onLeave);

    // Fit to geometry with a gentle spatial spring.
    if (bounds) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], {
        padding: 56, duration: reduce ? 0 : 900, essential: true, maxZoom: 15,
      });
    }

    return () => {
      map.off('mousemove', 'zones-fill', onEnter);
      map.off('mouseleave', 'zones-fill', onLeave);
      popup.remove();
    };
  }, [ready, boundary, parcels, zones, bounds]);

  if (!hasGeometry) {
    return (
      <div
        className={`grid place-items-center rounded-[var(--radius-2xl)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-sunken)]/40 ${className}`}
        style={{ minHeight: 340 }}
      >
        <div className="text-center px-6">
          <MapPinned className="size-6 mx-auto text-[var(--fg-subtle)]" />
          <p className="mt-2 text-[13px] font-medium text-[var(--fg-muted)]">No field geometry on record</p>
          <p className="mt-1 text-[12px] text-[var(--fg-subtle)] max-w-[34ch]">
            Draw or import this farm's boundary in onboarding to place it on the map.
          </p>
        </div>
      </div>
    );
  }

  // WebGL unavailable — the field data is intact; only the interactive map can't
  // render. Show a clear fallback so FarmDetail stays fully usable.
  if (failed) {
    return (
      <div
        className={`grid place-items-center rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--surface-sunken)] ${className}`}
        style={{ minHeight: 340 }}
      >
        <div className="text-center px-6">
          <MapPinned className="size-6 mx-auto text-[var(--fg-subtle)]" />
          <p className="mt-2 text-[13px] font-medium text-[var(--fg-muted)]">Map preview unavailable in this browser</p>
          <p className="mt-1 text-[12px] text-[var(--fg-subtle)] max-w-[36ch]">
            The field boundary and zones are on record — only the interactive satellite map needs WebGL, which this browser couldn't start.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--border)] ${className}`} style={{ minHeight: 340 }}>
      {/* MapLibre's own stylesheet forces .maplibregl-map { position: relative },
          which defeats `absolute inset-0` and collapses the container to 0px.
          Fill the wrapper with an explicit height instead. */}
      <div ref={containerRef} className="h-full w-full" style={{ position: 'absolute', inset: 0 }} aria-label="Farm field map" />

      {/* Floating frosted zone-intent legend. */}
      {kindsPresent.size > 0 && (
        <div
          className="absolute left-3 top-3 rounded-[var(--radius-lg)] border border-white/10 px-3 py-2.5 shadow-[var(--shadow-popover)]"
          style={{
            background: 'var(--panel-glass)',
            backdropFilter: 'blur(20px) saturate(140%)',
            WebkitBackdropFilter: 'blur(20px) saturate(140%)',
          }}
        >
          <div className="text-[10px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)] mb-1.5">Zone intent</div>
          <div className="flex flex-col gap-1">
            {(Object.keys(ZONE_KIND) as ZoneKind[])
              .filter((k) => kindsPresent.has(k))
              .map((k) => {
                const m = ZONE_KIND[k];
                return (
                  <span key={k} className="inline-flex items-center gap-1.5 text-[11px] text-[var(--fg)]">
                    <span
                      className="size-2.5 rounded-[3px]"
                      style={{ background: m.color, boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${m.color} 55%, transparent)` }}
                    />
                    {m.label}
                  </span>
                );
              })}
            <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--fg)] pt-0.5">
              <span className="h-0.5 w-2.5 rounded-full" style={{ background: '#4C7EFF' }} />
              Farm boundary
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
