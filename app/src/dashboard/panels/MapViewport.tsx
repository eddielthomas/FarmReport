// =============================================================================
// dashboard/panels/MapViewport.tsx — MapLibre canvas + customer GIS overlays.
// -----------------------------------------------------------------------------
// Phase 1: standalone MapLibre instance with ESRI imagery basemap, project pin
// stub, and customer GIS layer rendering. Phase 2 will absorb the detection
// markers / SAR overlays / mission state from dashboard.html.
// =============================================================================

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@crm/lib/api';
import { useDashboardStore } from '../store';

interface GisLayer {
  id: string; name: string; kind: string; status: string;
  visible: boolean; color: string; opacity: number;
  feature_count: number;
}

export function MapViewport() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef       = useRef<maplibregl.Map | null>(null);
  const loadedRef    = useRef(false);

  const layers = useDashboardStore((s) => s.layers);

  // Pull customer GIS layers for the current tenant.
  const { data: gisLayers = [] } = useQuery({
    queryKey: ['dashboard-gis-layers'],
    queryFn:  async () => {
      try { return await apiGet<GisLayer[]>('/gis/layers'); }
      catch { return [] as GisLayer[]; }
    },
    refetchInterval: 30_000,
  });

  // Initial map setup.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          esri: {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri',
          },
        },
        layers: [{ id: 'esri', type: 'raster', source: 'esri' }],
      },
      center: [-112.0740, 33.4484],
      zoom: 10,
      attributionControl: false,
      maxZoom: 18,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', () => { loadedRef.current = true; });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; loadedRef.current = false; };
  }, []);

  // Sync customer GIS layers onto the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = async () => {
      const wanted = new Set(gisLayers.filter((l) => l.status === 'ready' && l.visible).map((l) => l.id));
      for (const ml of (map.getStyle().layers ?? [])) {
        if (ml.id.startsWith('gis-')) {
          const layerId = ml.id.replace(/^gis-/, '').replace(/-(fill|line|point)$/, '');
          if (!wanted.has(layerId)) map.removeLayer(ml.id);
        }
      }
      for (const sId of Object.keys(map.getStyle().sources)) {
        if (sId.startsWith('gis-') && !wanted.has(sId.replace(/^gis-/, ''))) {
          try { map.removeSource(sId); } catch {}
        }
      }
      for (const layer of gisLayers) {
        if (!wanted.has(layer.id)) continue;
        const sId = `gis-${layer.id}`;
        if (!map.getSource(sId)) {
          try {
            const fc = await apiGet<{ type: string; features: any[] }>(`/gis/layers/${layer.id}/features`);
            map.addSource(sId, { type: 'geojson', data: fc as any });
          } catch (e) { continue; }
        }
        const fid = `gis-${layer.id}-fill`;
        const lid = `gis-${layer.id}-line`;
        const pid = `gis-${layer.id}-point`;
        if (!map.getLayer(fid)) map.addLayer({ id: fid, type: 'fill',   source: sId,
          paint: { 'fill-color': layer.color, 'fill-opacity': layer.opacity * 0.35 },
          filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']] });
        if (!map.getLayer(lid)) map.addLayer({ id: lid, type: 'line',   source: sId,
          paint: { 'line-color': layer.color, 'line-width': 2, 'line-opacity': layer.opacity },
          filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'MultiLineString'],
                   ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']] });
        if (!map.getLayer(pid)) map.addLayer({ id: pid, type: 'circle', source: sId,
          paint: { 'circle-color': layer.color, 'circle-radius': 4, 'circle-opacity': layer.opacity,
                   'circle-stroke-color': '#030609', 'circle-stroke-width': 1 },
          filter: ['any', ['==', ['geometry-type'], 'Point'], ['==', ['geometry-type'], 'MultiPoint']] });
      }
    };
    if (loadedRef.current) apply();
    else map.once('load', apply);
  }, [gisLayers]);

  const visibleCount = gisLayers.filter((l) => l.visible && l.status === 'ready').length;

  return (
    <main
      data-coachmark="dash.map"
      className="relative overflow-hidden"
      style={{ gridRow: 2, gridColumn: 2 }}
    >
      <div ref={containerRef} className="absolute inset-0" />

      {/* HUD: top-left layer count */}
      <div className="absolute top-2 left-2 z-10 px-2 py-1 panel rounded text-[9px] font-mono uppercase tracking-wider text-[var(--rwr-t2)] pointer-events-none">
        SAR · {layers.filter((l) => l.on).length} CORE LAYERS
        {visibleCount > 0 && <span className="ml-2 text-[var(--signal-magenta)]">· {visibleCount} CUSTOMER</span>}
      </div>

      {/* HUD: top-center scenestamp */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-2 py-1 panel rounded text-[9px] font-mono uppercase tracking-wider text-[var(--signal-cyan)] pointer-events-none">
        SCENE 2025-11-12 · INGESTED 18:42 UTC
      </div>
    </main>
  );
}
