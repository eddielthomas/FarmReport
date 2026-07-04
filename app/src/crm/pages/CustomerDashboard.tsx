// =============================================================================
// CustomerDashboard — self-service portal for the customer:view role (S7C).
// -----------------------------------------------------------------------------
// IA preserved (account header, project KPI strip, GIS layers, project map,
// timeline, meetings, files, messages). Visual layer rewritten on the new
// tokens + Card / KpiCard primitives.
//
// S7C BUG FIX — listLeads under data.read.assigned returns [] for customer:view
// users because they have no sales.assignment rows. To find the customer's
// own lead row we now follow this lookup chain:
//   1. /sales/leads                                — best case, assignment hit.
//   2. /crm/contacts?email=<user.email>            — find own contact row.
//   3. /sales/leads?contact_id=<contact.id>        — join contact ↔ lead.
//   4. /crm/contacts/<contact.id>                  — last-resort detail probe.
// Only fall through to the "WELCOME" empty state if both paths returned zero.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { apiGet, apiPost } from '@crm/lib/api';
import type { Lead, Meeting, FileRecord, Message } from '@crm/lib/types';
import { useAuthStore } from '@crm/lib/auth-store';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@crm/components/ui/card';
import { Badge, statusVariant } from '@crm/components/ui/badge';
import { Button } from '@crm/components/ui/button';
import { Textarea } from '@crm/components/ui/input';
import { KpiCard } from '@crm/components/ui/kpi-card';
import { formatRelative, formatCurrency, cn } from '@crm/lib/utils';
import {
  CheckCircle2, CalendarDays, Paperclip, MessageSquare, MapPin,
  Activity, TrendingUp,
} from 'lucide-react';
import { CoachmarkTour } from '@crm/components/ui/coachmark';
import { TOURS } from '@crm/lib/tours';
import { GisLayersCard, type GisLayer } from '@crm/components/gis/GisLayersCard';
import {
  applyBrandStyle, applySarOverlay, sarOverlayStyle,
  fetchMyProjects, fetchProjectScenes,
  getStoredActiveProject, setStoredActiveProject, resolveDefaultScene,
  type CustomerProject, type CustomerScene,
} from '@crm/lib/customer-scenes';
import { SceneStrip }      from '@crm/components/customer/SceneStrip';
import { ProjectSwitcher } from '@crm/components/customer/ProjectSwitcher';

const TIMELINE: Array<{ key: 'infoRequestedAt'|'convertedToLeadAt'|'convertedToClientAt'; label: string }> = [
  { key: 'infoRequestedAt',     label: 'Info Requested' },
  { key: 'convertedToLeadAt',   label: 'Promoted to Lead' },
  { key: 'convertedToClientAt', label: 'Became Client' },
];

// ---- project geolocation helpers ------------------------------------------
const TENANT_REGIONS: Record<string, { lat: number; lon: number; spread: number; label: string }> = {
  'demo-buyer':   { lat: 36.7378, lon: -119.7871, spread: 0.18, label: 'Fresno, CA — Central Valley Growers' },
  'acme-produce': { lat: 36.6777, lon: -121.6555, spread: 0.22, label: 'Salinas Valley, CA — Acme Produce Co.' },
};
const DEFAULT_REGION = { lat: 39.8283, lon: -98.5795, spread: 0.5, label: 'United States' };

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

function projectCenter(lead: Lead, tenantSlug?: string) {
  const region = (tenantSlug && TENANT_REGIONS[tenantSlug]) || DEFAULT_REGION;
  const u = hash01(lead.id);
  const v = hash01(lead.id + ':lon');
  return {
    lat: region.lat + (u - 0.5) * region.spread,
    lon: region.lon + (v - 0.5) * region.spread,
    label: region.label,
  };
}

// ---- main page -------------------------------------------------------------
export function CustomerDashboard() {
  const user = useAuthStore((s) => s.user);
  const isCustomerView = (user?.roles ?? []).includes('customer:view');

  // ── S14C — customer-scoped project list ───────────────────────────────────
  // The new /customer/me/projects endpoint resolves the caller via
  // email → sales.contact → sales.contact_lead → crm.project, so it works
  // even when no sales.assignment row exists.  We keep the legacy lead
  // lookup as a fallback for users with 0 projects (info-request stage).
  const { data: projects = [], isLoading: projectsLoading } = useQuery<CustomerProject[]>({
    queryKey: ['customer-me-projects', user?.email],
    queryFn:  fetchMyProjects,
    staleTime: 60_000,
  });

  // Active project — persisted to localStorage so a reload returns to the
  // same project the customer was last viewing.
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => getStoredActiveProject());

  // Keep the active id valid as the project set changes.
  useEffect(() => {
    if (!projects.length) return;
    const stillValid = activeProjectId && projects.some((p) => p.id === activeProjectId);
    if (!stillValid) {
      const next = projects[0].id;
      setActiveProjectId(next);
      setStoredActiveProject(next);
    }
  }, [projects, activeProjectId]);

  // Scenes for the active project — read-only fetch (customer scope on server).
  const { data: scenes = [] } = useQuery<CustomerScene[]>({
    queryKey: ['customer-project-scenes', activeProjectId],
    queryFn:  () => activeProjectId ? fetchProjectScenes(activeProjectId) : Promise.resolve([]),
    enabled:  !!activeProjectId,
    staleTime: 30_000,
  });

  const defaultScene = useMemo(() => resolveDefaultScene(scenes), [scenes]);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);

  // When the project switches OR the scene set first arrives, reset the
  // active scene back to the project's default.  A subsequent user click on
  // the scene strip is what flips this off the default.
  useEffect(() => {
    if (!scenes.length) { setActiveSceneId(null); return; }
    setActiveSceneId(defaultScene?.id ?? scenes[0].id);
  }, [activeProjectId, defaultScene?.id, scenes.length]);

  const activeScene = useMemo(
    () => scenes.find((s) => s.id === activeSceneId) ?? defaultScene,
    [scenes, activeSceneId, defaultScene],
  );

  // ── S7C bug fix — chained lead lookup (fallback path) ─────────────────────
  // Only fires when projects.length === 0 — keeps the existing "WELCOME"
  // empty-state intact for info-request-stage users.
  const { data: lead, isLoading: leadLoading } = useQuery<Lead | null>({
    queryKey: ['customer-lead', user?.email],
    queryFn: async (): Promise<Lead | null> => {
      // Step 1 — best-case direct lookup.
      const direct = await apiGet<Lead[]>('/sales/leads').catch(() => [] as Lead[]);
      if (direct.length > 0) return direct[0];
      if (!isCustomerView || !user?.email) return null;

      // Step 2 — find the customer's own contact row by exact email.
      const email = String(user.email).trim();
      const contacts = await apiGet<Array<{ id: string }>>(
        `/crm/contacts?email=${encodeURIComponent(email)}`,
      ).catch(() => [] as Array<{ id: string }>);
      const contact = contacts[0];
      if (!contact?.id) return null;

      // Step 3 — leads linked to that contact via sales.contact_lead /
      // sales.lead.primary_contact_id. The server-side handler treats the
      // join as the visibility branch when the param is present.
      const byContact = await apiGet<Lead[]>(
        `/sales/leads?contact_id=${encodeURIComponent(contact.id)}`,
      ).catch(() => [] as Lead[]);
      if (byContact.length > 0) return byContact[0];

      // Step 4 — last-resort detail probe (e.g. contact endpoint returns the
      // linked-leads embed in the future). Best-effort; safe to ignore on 404.
      const contactDetail = await apiGet<{ leads?: Lead[] }>(
        `/crm/contacts/${encodeURIComponent(contact.id)}`,
      ).catch(() => ({} as { leads?: Lead[] }));
      if (contactDetail?.leads && contactDetail.leads.length > 0) {
        return contactDetail.leads[0];
      }
      return null;
    },
    // Skip the legacy lookup chain once we already have at least one project
    // — the hero map will be driven by the project's default scene instead.
    enabled:   !projectsLoading && projects.length === 0,
    staleTime: 60_000,
  });

  const [gisLayers, setGisLayers] = useState<GisLayer[]>([]);
  const isLoading = projectsLoading || (projects.length === 0 && leadLoading);

  // Active project shape (used by the hero header when in project-mode).
  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  if (isLoading) {
    return (
      <div className="h-full bg-[var(--bg)] grid place-items-center">
        <div className="text-[12px] text-[var(--fg-muted)] uppercase tracking-[var(--tracking-wider)] animate-pulse">
          Loading…
        </div>
      </div>
    );
  }

  // ── No active project AND no legacy lead → "welcome" empty state ─────────
  if (!activeProject && !lead) {
    return (
      <div className="h-full bg-[var(--bg)] grid place-items-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="p-8 space-y-2 text-center">
            <div className="text-[10px] uppercase tracking-[var(--tracking-widest)] text-[var(--fg-muted)]">
              Welcome, {user?.display_name ?? 'Customer'}
            </div>
            <div className="text-[18px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)]">
              Your account is being prepared
            </div>
            <div className="text-[12px] text-[var(--fg-muted)] leading-relaxed">
              We could not locate a project or lead record linked to <code className="font-mono">{user?.email}</code> yet.
              Check back shortly or contact your account team.
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // The header/KPIs/sub-cards downstream assume a `lead` for legacy data.
  // When the customer has a project but no lead (rare in dev seeds; common
  // in real onboarding), we synthesise a minimal placeholder so the cards
  // can still render without crashing.  In production we'd back this with a
  // /customer/me/projects/:id summary endpoint.
  const headerLead: Lead | null = lead ?? (activeProject ? {
    id: activeProject.id,
    tenant_id: activeProject.tenant_id,
    name: activeProject.title,
    email: user?.email ?? null,
    phone: null,
    company: activeProject.title,
    position: null,
    status: 'Client',
    source: null,
    source_details: null,
    interest: null,
    total_revenue: 0,
    status_timestamps: {},
    selected_products: [],
    created_at: activeProject.created_at ?? new Date().toISOString(),
    updated_at: activeProject.updated_at ?? new Date().toISOString(),
  } as Lead : null);

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
      <div className="p-4 sm:p-6 space-y-5 max-w-[1400px] mx-auto relative">
        <CoachmarkTour tourId={TOURS.customer.id} steps={TOURS.customer.steps} />

        {/* S14C — Project switcher: only shown when the customer can see
            more than one project.  Single-project users skip it; zero-project
            users fall through to the legacy lead path above. */}
        {projects.length > 1 && (
          <ProjectSwitcher
            projects={projects}
            activeId={activeProjectId ?? undefined}
            onPick={(id) => { setActiveProjectId(id); setStoredActiveProject(id); }}
          />
        )}

        <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
              {activeProject ? 'Active project' : 'Your account'}
            </div>
            <h1 className="text-[24px] font-semibold tracking-[var(--tracking-tight)] leading-tight">
              {activeProject?.title ?? headerLead?.company ?? headerLead?.name}
            </h1>
            <div className="text-[12px] text-[var(--fg-muted)] mt-1">
              {activeProject?.description ??
                `${headerLead?.position ?? ''} · ${headerLead?.email ?? ''} · ${headerLead?.phone ?? ''}`}
            </div>
          </div>
          {headerLead && <Badge variant={statusVariant(headerLead.status)} size="lg">{headerLead.status}</Badge>}
        </header>

        {headerLead && <ProjectAnalytics lead={headerLead} />}

        {headerLead && <GisLayersCard leadId={headerLead.id} onLayersChange={setGisLayers} />}

        {/* S14C — Hero map.  When the active project has at least one saved
            scene, drive the map with that scene (fly camera, brand basemap,
            CSS filter, SAR overlay).  Otherwise fall back to the deterministic
            ProjectMap that the legacy lead-mode used. */}
        <Card data-coachmark="customer.map">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-1.5">
                <MapPin className="size-3.5" />
                {activeScene ? activeScene.title : 'Project location'}
              </CardTitle>
              <CardDescription>
                {activeScene
                  ? (activeScene.description ?? 'Saved view')
                  : 'Your farm region on our monitoring grid'}
              </CardDescription>
            </div>
            {activeScene
              ? <SceneCoords scene={activeScene} />
              : (headerLead && <ProjectCoords lead={headerLead} tenantSlug={user?.tenant_slug} />)}
          </CardHeader>
          <CardContent className="space-y-3">
            {activeScene
              ? <HeroSceneMap scene={activeScene} />
              : (headerLead && <ProjectMap lead={headerLead} tenantSlug={user?.tenant_slug} gisLayers={gisLayers} />)}

            {/* Scene strip — sits directly under the hero map.  Hidden when
                the project has no saved scenes. */}
            {scenes.length > 0 && (
              <SceneStrip
                scenes={scenes}
                activeId={activeScene?.id}
                onPick={(s) => setActiveSceneId(s.id)}
              />
            )}
          </CardContent>
        </Card>

        {lead && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Card data-coachmark="customer.timeline">
            <CardHeader>
              <CardTitle>Status timeline</CardTitle>
              <CardDescription>Your journey with us</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="space-y-2">
                {TIMELINE.map((step) => {
                  const at = (lead.status_timestamps ?? {})[step.key];
                  const reached = !!at;
                  return (
                    <li
                      key={step.key}
                      className={cn(
                        'flex items-start gap-2.5 rounded-[var(--radius-md)] p-2.5',
                        'border border-[var(--border)] bg-[var(--surface)]',
                        reached && 'border-[var(--accent-strong)]/40 bg-[color-mix(in_oklch,var(--accent)_8%,transparent)]',
                      )}
                    >
                      <CheckCircle2
                        className={cn(
                          'size-4 mt-0.5 shrink-0',
                          reached ? 'text-[var(--green)]' : 'text-[var(--fg-subtle)] opacity-50',
                        )}
                      />
                      <div className="flex-1">
                        <div className={cn('text-[12px]', reached ? 'text-[var(--fg)] font-medium' : 'text-[var(--fg-muted)]')}>
                          {step.label}
                        </div>
                        {at && (
                          <div className="text-[10px] text-[var(--fg-muted)]">{formatRelative(at)}</div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <CalendarDays className="size-3.5" />
                Meetings
              </CardTitle>
              <CardDescription>Scheduled with our team</CardDescription>
            </CardHeader>
            <CardContent>
              <MeetingsList leadId={lead.id} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Paperclip className="size-3.5" />
                Shared files
              </CardTitle>
              <CardDescription>Documents on your account</CardDescription>
            </CardHeader>
            <CardContent>
              <FilesList leadId={lead.id} />
            </CardContent>
          </Card>

          <Card data-coachmark="customer.chat">
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <MessageSquare className="size-3.5" />
                Messages
              </CardTitle>
              <CardDescription>Direct line to our team</CardDescription>
            </CardHeader>
            <CardContent>
              <MessagesPanel leadId={lead.id} />
            </CardContent>
          </Card>
        </div>
        )}
      </div>
    </div>
  );
}

// ---- project coords ribbon -----------------------------------------------
function ProjectCoords({ lead, tenantSlug }: { lead: Lead; tenantSlug?: string }) {
  const c = useMemo(() => projectCenter(lead, tenantSlug), [lead.id, tenantSlug]);
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
        {c.label}
      </div>
      <div className="text-[11px] font-mono text-[var(--fg)]">
        {c.lat.toFixed(4)}°, {c.lon.toFixed(4)}°
      </div>
    </div>
  );
}

// ---- analytics strip ------------------------------------------------------
function ProjectAnalytics({ lead }: { lead: Lead }) {
  const { data: meetings = [] } = useQuery({
    queryKey: ['analytics-meetings', lead.id],
    queryFn:  async () => {
      const all = await apiGet<Meeting[]>('/sales/meetings').catch(() => []);
      return all.filter((m) => m.lead_id === lead.id);
    },
  });
  const { data: files = [] } = useQuery({
    queryKey: ['analytics-files', lead.id],
    queryFn:  () => apiGet<FileRecord[]>(`/sales/leads/${lead.id}/files`).catch(() => []),
  });
  const { data: messages = [] } = useQuery({
    queryKey: ['analytics-messages', lead.id],
    queryFn:  () => apiGet<Message[]>(`/sales/leads/${lead.id}/messages`).catch(() => []),
  });

  const ts = lead.status_timestamps ?? {};
  const reachedSteps = [ts.infoRequestedAt, ts.convertedToLeadAt, ts.convertedToClientAt].filter(Boolean).length;
  const progress = Math.round((reachedSteps / 3) * 100);
  const firstContact = ts.infoRequestedAt ?? lead.created_at;
  const daysActive = Math.max(0, Math.floor((Date.now() - new Date(firstContact).getTime()) / 86_400_000));
  const productsValue = (lead.selected_products ?? []).reduce((s, p) => s + Number(p.price ?? 0), 0);
  const totalValue = Number(lead.total_revenue ?? 0) || productsValue;
  const upcomingMeetings = meetings.filter((m) => new Date(m.start_at).getTime() > Date.now()).length;
  const agentMessages = messages.filter((m) => m.sender === 'agent').length;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      <KpiCard
        icon={<Activity className="size-3.5" />}
        label="Progress"
        value={progress}
        unit="%"
        tint={progress >= 100 ? 'green' : progress >= 33 ? 'accent' : 'orange'}
        footnote={`${reachedSteps} of 3 stages`}
      />
      <KpiCard
        icon={<CalendarDays className="size-3.5" />}
        label="Days active"
        value={daysActive}
        tint="cyan"
        footnote="Since first contact"
      />
      <KpiCard
        icon={<TrendingUp className="size-3.5" />}
        label="Project value"
        value={formatCurrency(totalValue)}
        tint="accent"
        footnote={(lead.selected_products ?? []).length ? `${(lead.selected_products ?? []).length} products` : 'Awaiting scope'}
      />
      <KpiCard
        icon={<CalendarDays className="size-3.5" />}
        label="Meetings"
        value={meetings.length}
        tint="accent"
        footnote={`${upcomingMeetings} upcoming`}
      />
      <KpiCard
        icon={<Paperclip className="size-3.5" />}
        label="Files"
        value={files.length}
        tint="cyan"
        footnote="Shared documents"
      />
      <KpiCard
        icon={<MessageSquare className="size-3.5" />}
        label="Messages"
        value={messages.length}
        tint="accent"
        footnote={`${agentMessages} from our team`}
      />
    </div>
  );
}

// ---- project map ----------------------------------------------------------
function ProjectMap({ lead, tenantSlug, gisLayers = [] }:
  { lead: Lead; tenantSlug?: string; gisLayers?: GisLayer[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef       = useRef<maplibregl.Map | null>(null);
  const loadedRef    = useRef(false);
  const center       = useMemo(() => projectCenter(lead, tenantSlug), [lead.id, tenantSlug]);

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
            tileSize: 256,
            maxzoom: 19,
            attribution: 'Imagery © Esri',
          },
        },
        layers: [{ id: 'esri', type: 'raster', source: 'esri' }],
      },
      center: [center.lon, center.lat],
      zoom: 12,
      attributionControl: false,
      maxZoom: 18,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;

    map.on('load', () => {
      loadedRef.current = true;
      const ring = circleGeoJSON(center.lat, center.lon, 1.5, 64);
      map.addSource('zone', { type: 'geojson', data: ring });
      // The accent ring uses the token color so dark + light read consistently
      // — `getComputedStyle` resolves it against the document root.
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#B9FF66';
      map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zone', paint: { 'fill-color': accent, 'fill-opacity': 0.10 } });
      map.addLayer({ id: 'zone-line', type: 'line', source: 'zone', paint: { 'line-color': accent, 'line-width': 1.5, 'line-dasharray': [2, 2] } });

      const el = document.createElement('div');
      el.style.cssText =
        `width:14px;height:14px;border-radius:50%;background:${accent};` +
        `box-shadow:0 0 0 4px color-mix(in oklch, ${accent} 30%, transparent),0 0 12px color-mix(in oklch, ${accent} 50%, transparent);` +
        'border:2px solid #0A0A0A;cursor:pointer;';
      new maplibregl.Marker({ element: el })
        .setLngLat([center.lon, center.lat])
        .setPopup(
          new maplibregl.Popup({ offset: 14, closeButton: false }).setHTML(
            `<div style="font-family:'Urbanist',system-ui,sans-serif;font-size:11px;color:#0A0A0A;line-height:1.4">
               <div style="font-weight:600">${escapeHtml(lead.company ?? lead.name)}</div>
               <div>${escapeHtml(lead.status)}</div>
             </div>`,
          ),
        )
        .addTo(map);
    });

    return () => { map.remove(); mapRef.current = null; loadedRef.current = false; };
  }, [center.lat, center.lon, lead.id]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = async () => {
      const wanted = new Set(gisLayers.filter((l) => l.status === 'ready' && l.visible).map((l) => l.id));

      const allLayers = map.getStyle().layers ?? [];
      for (const l of allLayers) {
        if (l.id.startsWith('gis-')) {
          const layerId = l.id.replace(/^gis-/, '').replace(/-(fill|line|point|outline)$/, '');
          if (!wanted.has(layerId)) map.removeLayer(l.id);
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
        const lFillId = `gis-${layer.id}-fill`;
        const lLineId = `gis-${layer.id}-line`;
        const lPtId   = `gis-${layer.id}-point`;

        if (!map.getSource(sId)) {
          try {
            const fc = await apiGet<{ type: string; features: any[] }>(`/gis/layers/${layer.id}/features`);
            map.addSource(sId, { type: 'geojson', data: fc as any });
          } catch (e) {
            console.warn('[gis] fetch failed for', layer.id, e);
            continue;
          }
        }
        if (!map.getLayer(lFillId)) {
          map.addLayer({ id: lFillId, type: 'fill', source: sId,
            paint: { 'fill-color': layer.color, 'fill-opacity': layer.opacity * 0.35 },
            filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
          });
        }
        if (!map.getLayer(lLineId)) {
          map.addLayer({ id: lLineId, type: 'line', source: sId,
            paint: { 'line-color': layer.color, 'line-width': 2, 'line-opacity': layer.opacity },
            filter: ['any',
              ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'MultiLineString'],
              ['==', ['geometry-type'], 'Polygon'],    ['==', ['geometry-type'], 'MultiPolygon'],
            ],
          });
        }
        if (!map.getLayer(lPtId)) {
          map.addLayer({ id: lPtId, type: 'circle', source: sId,
            paint: {
              'circle-color': layer.color,
              'circle-radius': 4,
              'circle-opacity': layer.opacity,
              'circle-stroke-color': '#0A0A0A',
              'circle-stroke-width': 1,
            },
            filter: ['any', ['==', ['geometry-type'], 'Point'], ['==', ['geometry-type'], 'MultiPoint']],
          });
        }
      }
    };
    if (loadedRef.current) apply();
    else map.once('load', apply);
  }, [gisLayers]);

  const onCount = gisLayers.filter((l) => l.visible && l.status === 'ready').length;

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="h-[340px] w-full rounded-[var(--radius-lg)] border border-[var(--border)] overflow-hidden"
      />
      <div
        className={cn(
          'absolute top-3 left-3 px-2.5 py-1 rounded-[var(--radius-full)]',
          'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
          'text-[10px] uppercase tracking-[var(--tracking-wide)] pointer-events-none',
        )}
      >
        Monitored zone · 1.5 km
      </div>
      {onCount > 0 && (
        <div
          className={cn(
            'absolute top-3 right-3 px-2.5 py-1 rounded-[var(--radius-full)]',
            'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
            'text-[10px] uppercase tracking-[var(--tracking-wide)] pointer-events-none',
          )}
        >
          {onCount} layer{onCount === 1 ? '' : 's'} on
        </div>
      )}
    </div>
  );
}

// ---- shared panels --------------------------------------------------------

function MeetingsList({ leadId }: { leadId: string }) {
  const { data: meetings = [] } = useQuery({
    queryKey: ['meetings', leadId],
    queryFn:  async () => {
      const all = await apiGet<Meeting[]>(`/sales/meetings?from=${new Date(Date.now() - 86400_000).toISOString()}`).catch(() => []);
      return all.filter((m) => m.lead_id === leadId);
    },
  });
  return (
    <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
      {meetings.map((m) => (
        <div
          key={m.id}
          className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-2.5"
        >
          <div className="text-[12px] font-medium text-[var(--fg)]">{m.title}</div>
          <div className="text-[11px] text-[var(--fg-muted)]">
            {new Date(m.start_at).toLocaleString()} · {m.location ?? '—'}
          </div>
        </div>
      ))}
      {meetings.length === 0 && (
        <div className="text-[11px] text-[var(--fg-subtle)] text-center p-2">No meetings scheduled</div>
      )}
    </div>
  );
}

function FilesList({ leadId }: { leadId: string }) {
  const { data: files = [] } = useQuery({
    queryKey: ['files', leadId],
    queryFn:  () => apiGet<FileRecord[]>(`/sales/leads/${leadId}/files`).catch(() => []),
  });
  return (
    <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
      {files.map((f) => (
        <div
          key={f.id}
          className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-2.5"
        >
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-[var(--fg)] truncate">{f.file_name}</div>
            <div className="text-[11px] text-[var(--fg-muted)]">
              {Math.round(f.file_size / 1024)} KB · {formatRelative(f.uploaded_at)}
            </div>
          </div>
          {f.signed_url && (
            <a
              href={f.signed_url}
              className="text-[11px] font-medium text-[var(--fg)] underline hover:text-[var(--accent-strong)]"
            >
              View
            </a>
          )}
        </div>
      ))}
      {files.length === 0 && (
        <div className="text-[11px] text-[var(--fg-subtle)] text-center p-2">No files yet</div>
      )}
    </div>
  );
}

function MessagesPanel({ leadId }: { leadId: string }) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const { data: messages = [] } = useQuery({
    queryKey: ['messages', leadId],
    queryFn:  () => apiGet<Message[]>(`/sales/leads/${leadId}/messages`).catch(() => []),
  });
  const send = useMutation({
    mutationFn: () => apiPost(`/sales/leads/${leadId}/messages`, { sender: 'contact', body }),
    onSuccess: () => { setBody(''); qc.invalidateQueries({ queryKey: ['messages', leadId] }); },
  });
  return (
    <div className="space-y-2">
      <div className="space-y-1.5 max-h-[200px] overflow-y-auto pr-1">
        {messages.map((m) => (
          <div
            key={m.id}
            className={cn(
              'rounded-[var(--radius-md)] p-2.5 text-[12px]',
              'border border-[var(--border)]',
              m.sender === 'contact'
                ? 'ml-6 bg-[color-mix(in_oklch,var(--accent)_10%,var(--surface))] border-[var(--accent-strong)]/30'
                : 'mr-6 bg-[var(--surface)]',
            )}
          >
            <div className="flex items-center justify-between mb-1">
              <Badge variant={m.sender === 'contact' ? 'accent' : 'outline'} size="sm">{m.sender}</Badge>
              <span className="text-[10px] text-[var(--fg-muted)]">{formatRelative(m.created_at)}</span>
            </div>
            <div className="whitespace-pre-wrap text-[var(--fg)]">{m.body}</div>
          </div>
        ))}
        {messages.length === 0 && (
          <div className="text-[11px] text-[var(--fg-subtle)] text-center p-2">No messages yet</div>
        )}
      </div>
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Type a message to your account team…" />
      <div className="flex justify-end">
        <Button size="md" disabled={!body.trim() || send.isPending} onClick={() => send.mutate()}>
          {send.isPending ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </div>
  );
}

// ---- S14C hero scene map -------------------------------------------------
// Drives the hero map from a CustomerScene.  Flies to {center,zoom,pitch,
// bearing}, applies the brand basemap + CSS canvas filter, and toggles the
// SAR overlay (procedural radar speckle).  Active-layer rendering is left to
// the scene_layer spec — for now we render the layer ids as a chip strip so
// users see which detection layers are part of the saved view; we'll plug
// real layer rendering in once the layer registry lands on /customer.
function HeroSceneMap({ scene }: { scene: CustomerScene }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef   = useRef<HTMLDivElement | null>(null);
  const mapRef       = useRef<maplibregl.Map | null>(null);

  // Initial mount — create the map once.  The brand style + camera are
  // applied via the dependency effect below so a scene swap reuses the same
  // MapLibre instance (cheaper than tear-down + rebuild).
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          base: {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            maxzoom: 19,
          },
        },
        layers: [{ id: 'base', type: 'raster', source: 'base' }],
      },
      center: [scene.center_lon, scene.center_lat],
      zoom: scene.zoom ?? 12,
      pitch: scene.pitch ?? 0,
      bearing: scene.bearing ?? 0,
      attributionControl: false,
      maxZoom: 18,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
    // We intentionally do NOT include `scene` here — the dep effect below
    // handles every subsequent scene change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-scene apply — basemap, camera, SAR overlay.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applyBrandStyle(map, scene.basemap_id);
    map.flyTo({
      center: [scene.center_lon, scene.center_lat],
      zoom:    scene.zoom    ?? 12,
      pitch:   scene.pitch   ?? 0,
      bearing: scene.bearing ?? 0,
      duration: 1200,
      essential: true,
    });
    applySarOverlay(overlayRef.current, !!scene.sar_overlay, scene.sar_opacity ?? 60);
  }, [
    scene.id, scene.basemap_id,
    scene.center_lat, scene.center_lon,
    scene.zoom, scene.pitch, scene.bearing,
    scene.sar_overlay, scene.sar_opacity,
  ]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="h-[340px] w-full rounded-[var(--radius-lg)] border border-[var(--border)] overflow-hidden"
      />
      {/* Procedural SAR overlay — pointer-events: none so the map stays
          interactive.  Visibility + opacity are driven by `applySarOverlay`. */}
      <div ref={overlayRef} style={sarOverlayStyle()} />

      {/* Brand badge ribbon (top-left). */}
      <div
        className={cn(
          'absolute top-3 left-3 px-2.5 py-1 rounded-[var(--radius-full)]',
          'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
          'text-[10px] uppercase tracking-[var(--tracking-wide)] pointer-events-none',
        )}
      >
        {scene.basemap_id}
      </div>

      {/* Active-layers chip strip (top-right) — informational for now. */}
      {(scene.active_layers ?? []).length > 0 && (
        <div className="absolute top-3 right-12 flex gap-1 max-w-[60%] flex-wrap justify-end pointer-events-none">
          {scene.active_layers.slice(0, 5).map((l) => (
            <span
              key={l}
              className={cn(
                'px-2 py-0.5 rounded-[var(--radius-full)]',
                'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
                'text-[10px] uppercase tracking-[var(--tracking-wide)]',
              )}
            >
              {l}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SceneCoords({ scene }: { scene: CustomerScene }) {
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
        Saved scene · {scene.basemap_id}
      </div>
      <div className="text-[11px] font-mono text-[var(--fg)]">
        {scene.center_lat.toFixed(4)}°, {scene.center_lon.toFixed(4)}° · z{Number(scene.zoom).toFixed(0)}
      </div>
    </div>
  );
}

// ---- geo helpers ----------------------------------------------------------
function circleGeoJSON(lat: number, lon: number, radiusKm: number, steps = 64): GeoJSON.Feature<GeoJSON.Polygon> {
  const coords: Array<[number, number]> = [];
  const R = 6371;
  for (let i = 0; i <= steps; i++) {
    const brng = (i / steps) * 2 * Math.PI;
    const lat1 = (lat * Math.PI) / 180;
    const lon1 = (lon * Math.PI) / 180;
    const d = radiusKm / R;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lon2 = lon1 + Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
    coords.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } };
}

function escapeHtml(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}
