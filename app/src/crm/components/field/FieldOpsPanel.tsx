// =============================================================================
// FieldOpsPanel — manager-facing live tech panel (S9B).
// -----------------------------------------------------------------------------
// Drops into ops + sales dashboards. Two sections:
//   * Mini-map (MapLibre) showing every tech's last-known position.
//   * Roster — list of techs with status, distance to current job, battery,
//     last-seen timestamp. Click a row to re-center the map on that tech.
//
// Live updates via socket.io — every `field.tech.moved` envelope advances
// the in-memory position for that user, throttled to 1 paint/sec.
// =============================================================================

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { apiGet } from '@crm/lib/api';
import { useFieldEvents, type FieldEventEnvelope } from '@crm/lib/field-socket';
import {
  type FieldTechPosition, type FieldJob,
} from '@crm/lib/field-types';
import { TechMarker, techStatusColor } from './TechMarker';
import { cn } from '@crm/lib/utils';
import {
  Users, ChevronDown, ChevronUp, MapPin, ShieldAlert,
} from 'lucide-react';

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';

interface FieldOpsPanelProps {
  /** Compact rail variant (used in SalesManager right-rail). Default false. */
  compact?: boolean;
  /** Allow callers to override the default-expanded heuristic. */
  defaultOpen?: boolean;
}

export function FieldOpsPanel({ compact = false, defaultOpen }: FieldOpsPanelProps) {
  // NOTE: no `= []` default. A fresh default array on every render (while the
  // query is pending/erroring and `data` is undefined) made the `[positions]`
  // effect below re-fire each render → setLive → re-render → "Maximum update
  // depth exceeded". `positions` stays undefined until the query resolves to a
  // stable, React-Query-cached array.
  const { data: positions, refetch: refetchPositions } = useQuery({
    queryKey: ['field-tech-positions'],
    queryFn:  () => apiGet<FieldTechPosition[]>('/field/technicians/positions').catch(() => [] as FieldTechPosition[]),
    refetchInterval: 60_000,
  });
  const { data: jobs = [] } = useQuery({
    queryKey: ['field-jobs'],
    queryFn:  () => apiGet<FieldJob[]>('/field/jobs').catch(() => [] as FieldJob[]),
  });

  // Live merge — keep a Map<user_id, position> updated by socket events.
  const [live, setLive] = React.useState<Map<string, FieldTechPosition>>(() => new Map());
  React.useEffect(() => {
    if (!positions) return;
    const m = new Map<string, FieldTechPosition>();
    for (const p of positions) m.set(p.user_id, p);
    setLive(m);
  }, [positions]);

  useFieldEvents(React.useMemo(() => ({
    'field.tech.moved': (env: FieldEventEnvelope) => {
      const p = env.payload as Partial<FieldTechPosition> & { user_id?: string; location?: { lat: number; lon: number } };
      if (!p.user_id) return;
      setLive((prev) => {
        const next = new Map(prev);
        const existing = next.get(p.user_id!);
        next.set(p.user_id!, {
          user_id:        p.user_id!,
          display_name:   p.display_name   ?? existing?.display_name   ?? null,
          email:          p.email          ?? existing?.email          ?? null,
          tenant_id:      env.tenant_id,
          lat:            p.location?.lat ?? existing?.lat ?? 0,
          lon:            p.location?.lon ?? existing?.lon ?? 0,
          accuracy_m:     p.accuracy_m   ?? existing?.accuracy_m   ?? 0,
          heading_deg:    p.heading_deg  ?? existing?.heading_deg  ?? null,
          speed_mps:      p.speed_mps    ?? existing?.speed_mps    ?? null,
          captured_at:    (p as { captured_at?: string }).captured_at ?? new Date().toISOString(),
          inferred_status: existing?.inferred_status,
          current_job_id:  existing?.current_job_id,
        });
        return next;
      });
    },
    'field.geofence.entered': () => { refetchPositions(); },
    'field.geofence.exited':  () => { refetchPositions(); },
    'field.spoofing_suspected': () => { refetchPositions(); },
  }), [refetchPositions]));

  const techList = React.useMemo(() => Array.from(live.values()), [live]);
  const anyActive = techList.some(
    (t) => t.inferred_status === 'en_route' || t.inferred_status === 'on_site',
  );
  const [open, setOpen] = React.useState<boolean>(defaultOpen ?? anyActive ?? false);
  React.useEffect(() => { if (defaultOpen == null && anyActive) setOpen(true); }, [defaultOpen, anyActive]);

  // ---- Mini map -----------------------------------------------------------
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<maplibregl.Map | null>(null);
  const markersRef = React.useRef<Map<string, maplibregl.Marker>>(new Map());

  React.useEffect(() => {
    if (!open) return;
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    const map = new maplibregl.Map({
      container: el,
      style: STYLE_URL,
      center: [-98.5, 39.8],
      zoom: 3,
      attributionControl: { compact: true },
      maxPitch: 0,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    return () => {
      try { map.remove(); } catch { /* ignore */ }
      mapRef.current = null;
      markersRef.current = new Map();
    };
  }, [open]);

  // Sync markers
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !open) return;
    const apply = () => {
      const seen = new Set<string>();
      for (const t of techList) {
        if (!Number.isFinite(t.lat) || !Number.isFinite(t.lon)) continue;
        seen.add(t.user_id);
        let mk = markersRef.current.get(t.user_id);
        const color = techStatusColor(t.inferred_status);
        if (!mk) {
          const el = document.createElement('div');
          el.style.width  = '14px';
          el.style.height = '14px';
          el.style.borderRadius = '9999px';
          el.style.background = color;
          el.style.boxShadow = `0 0 0 4px color-mix(in oklch, ${color} 24%, transparent), 0 0 0 8px color-mix(in oklch, ${color} 10%, transparent)`;
          el.style.cursor = 'pointer';
          el.setAttribute('aria-label', t.display_name ?? 'Technician');
          el.title = t.display_name ?? t.email ?? 'tech';
          el.addEventListener('click', () => {
            map.flyTo({ center: [t.lon, t.lat], zoom: 14 });
          });
          mk = new maplibregl.Marker({ element: el }).setLngLat([t.lon, t.lat]).addTo(map);
          markersRef.current.set(t.user_id, mk);
        } else {
          mk.setLngLat([t.lon, t.lat]);
          mk.getElement().style.background = color;
        }
      }
      for (const [id, m] of markersRef.current.entries()) {
        if (!seen.has(id)) {
          m.remove();
          markersRef.current.delete(id);
        }
      }
      // Fit to bounds when we have ≥2 techs
      if (techList.length >= 2) {
        const b = new maplibregl.LngLatBounds();
        for (const t of techList) {
          if (Number.isFinite(t.lat) && Number.isFinite(t.lon)) b.extend([t.lon, t.lat]);
        }
        if (!b.isEmpty()) map.fitBounds(b, { padding: 40, duration: 600, maxZoom: 12 });
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [techList, open]);

  return (
    <section
      className={cn(
        'rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--surface)]',
        'shadow-[var(--shadow-card)] text-[var(--fg)]',
      )}
      aria-label="Field operations"
    >
      <header
        className="flex items-center gap-3 px-4 py-3 cursor-pointer"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="size-9 grid place-items-center rounded-[var(--radius-full)] bg-[var(--accent)]/15 text-[var(--accent-strong)]">
          <Users className="size-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
            Field Operations
          </div>
          <div className="text-[14px] font-semibold">
            {techList.length === 0
              ? 'No techs connected'
              : `${techList.length} tech${techList.length === 1 ? '' : 's'} live`}
            {anyActive && (
              <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[var(--tracking-wider)] px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[color-mix(in_oklch,var(--green)_22%,var(--surface))] text-[var(--green)]">
                Active
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label={open ? 'Collapse' : 'Expand'}
          aria-expanded={open}
          className="grid place-items-center size-9 rounded-[var(--radius-full)] border border-[var(--border)] bg-[var(--bg)]"
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        >
          {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      </header>

      {open && (
        <div className={cn('grid gap-3 p-3 pt-0', compact ? 'grid-cols-1' : 'lg:grid-cols-[2fr_1fr] grid-cols-1')}>
          <div
            ref={containerRef}
            className="rounded-[var(--radius-lg)] overflow-hidden bg-[var(--surface-sunken)] border border-[var(--border)]"
            style={{ minHeight: compact ? 200 : 320 }}
            aria-label="Live tech map"
          />
          <div className="space-y-1.5 max-h-[320px] overflow-y-auto pr-1">
            {techList.length === 0 && (
              <div className="text-[12px] text-[var(--fg-subtle)] text-center p-4">
                When techs sign in to the Field PWA they will appear here.
              </div>
            )}
            {techList.map((t) => {
              const job = jobs.find((j) => j.id === t.current_job_id);
              const ageMin = Math.round((Date.now() - new Date(t.captured_at).getTime()) / 60_000);
              return (
                <button
                  key={t.user_id}
                  type="button"
                  onClick={() => {
                    const map = mapRef.current;
                    if (map) map.flyTo({ center: [t.lon, t.lat], zoom: 14 });
                  }}
                  className={cn(
                    'w-full text-left p-2.5 rounded-[var(--radius-md)] border border-[var(--border)]',
                    'bg-[var(--bg-elevated)] hover:bg-[var(--surface-sunken)]',
                    'transition-colors duration-[var(--duration-fast)]',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <TechMarker position={t} size={12} pulse={false} />
                    <div className="text-[13px] font-semibold truncate flex-1">
                      {t.display_name ?? t.email ?? t.user_id}
                    </div>
                    {t.inferred_status === 'spoofing_suspected' && (
                      <ShieldAlert className="size-3.5 text-[var(--red)]" aria-label="Spoofing suspected" />
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--fg-muted)] flex items-center gap-2">
                    <span className="capitalize">{(t.inferred_status ?? 'idle').replace(/_/g, ' ')}</span>
                    <span aria-hidden="true">·</span>
                    <span>{ageMin <= 0 ? 'now' : `${ageMin} min ago`}</span>
                  </div>
                  {job && (
                    <div className="mt-1 text-[11px] text-[var(--fg)] flex items-center gap-1 truncate">
                      <MapPin className="size-3" />
                      {job.title}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
