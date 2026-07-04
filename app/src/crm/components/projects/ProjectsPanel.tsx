// =============================================================================
// ProjectsPanel — staff client / project / scan management (P1/P2).
// -----------------------------------------------------------------------------
// Role-gated surface (crm.project.read to view; crm.project.write to create;
// crm.project.scan to request a scan). Lets ops/sales:
//   * see every monitored AOI with its client, bounds, signal source, last scan + count
//   * create a new client (organization)
//   * create a new project bound to a client + AOI (gateway or bundled source)
//   * request a scan for a project AOI → results ingest + attribute to project
//
// Backed by /crm/projects, /crm/organizations, /crm/projects/:id/scans and
// /crm/projects/:id/detections. Read-through; the heavy lifting is server-side.
// =============================================================================

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@crm/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@crm/components/ui/card';
import { Badge } from '@crm/components/ui/badge';
import { Button } from '@crm/components/ui/button';
import { Input, Textarea, Label } from '@crm/components/ui/input';
import { cn, formatRelative } from '@crm/lib/utils';
import { Plus, Radar, MapPin, Building2, FolderPlus, X, RefreshCw, UserPlus } from 'lucide-react';

interface Project {
  id: string; title: string; description?: string | null; status: string;
  leak_source?: string | null; sub_project_id?: string | null;
  aoi_west?: number | null; aoi_south?: number | null; aoi_east?: number | null; aoi_north?: number | null;
  center_lat?: number | null; center_lon?: number | null; default_zoom?: number | null;
  customer_organization_id?: string | null;
  customer_contact_id?: string | null;
}
interface PortalInvite { email: string; temp_password: string; login_url: string; created: boolean }
interface Org { id: string; name: string }
interface Scan { id: string; status: string; result_summary?: { detections?: number; confirmed?: number; suspected?: number }; requested_at?: string; error?: string | null }

export function ProjectsPanel() {
  const qc = useQueryClient();
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showClientForm, setShowClientForm] = useState(false);

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['crm-projects-admin'],
    queryFn: () => apiGet<Project[]>('/crm/projects'),
  });
  const { data: orgs = [] } = useQuery({
    queryKey: ['crm-orgs'],
    queryFn: () => apiGet<Org[]>('/crm/organizations').catch(() => [] as Org[]),
  });
  const orgName = (id?: string | null) => orgs.find((o) => o.id === id)?.name ?? '—';

  return (
    <Card data-coachmark="pm.projects">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-1.5">
            <Radar className="size-3.5" /> Projects &amp; Scans
          </CardTitle>
          <CardDescription>Clients, project AOIs, and satellite scan requests</CardDescription>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => { setShowClientForm((v) => !v); setShowProjectForm(false); }}>
            <Building2 className="size-4" /> New client
          </Button>
          <Button size="sm" onClick={() => { setShowProjectForm((v) => !v); setShowClientForm(false); }}>
            <FolderPlus className="size-4" /> New project
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {showClientForm && (
          <NewClientForm onClose={() => setShowClientForm(false)}
            onCreated={() => { qc.invalidateQueries({ queryKey: ['crm-orgs'] }); setShowClientForm(false); }} />
        )}
        {showProjectForm && (
          <NewProjectForm orgs={orgs} onClose={() => setShowProjectForm(false)}
            onCreated={() => { qc.invalidateQueries({ queryKey: ['crm-projects-admin'] }); setShowProjectForm(false); }} />
        )}

        {isLoading && <div className="text-[12px] text-[var(--fg-muted)] p-2">Loading projects…</div>}
        {!isLoading && projects.length === 0 && (
          <div className="text-[12px] text-[var(--fg-subtle)] text-center p-3">No projects yet — create one to define a scan area.</div>
        )}
        <div className="space-y-2">
          {projects.map((p) => (
            <ProjectRow key={p.id} project={p} clientName={orgName(p.customer_organization_id)} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ProjectRow({ project, clientName }: { project: Project; clientName: string }) {
  const qc = useQueryClient();
  const [lastScan, setLastScan] = useState<Scan | null>(null);

  const { data: scans = [] } = useQuery({
    queryKey: ['project-scans', project.id],
    queryFn: () => apiGet<Scan[]>(`/crm/projects/${project.id}/scans`).catch(() => [] as Scan[]),
  });
  const { data: detections = [] } = useQuery({
    queryKey: ['project-detections', project.id],
    queryFn: () => apiGet<unknown[]>(`/crm/projects/${project.id}/detections`).catch(() => []),
  });

  const requestScan = useMutation({
    mutationFn: () => apiPost<Scan>(`/crm/projects/${project.id}/scans`, {}),
    onSuccess: (s) => {
      setLastScan(s);
      qc.invalidateQueries({ queryKey: ['project-scans', project.id] });
      qc.invalidateQueries({ queryKey: ['project-detections', project.id] });
    },
    onError: (e: unknown) => setLastScan({ id: '', status: 'failed', error: (e as { message?: string })?.message ?? 'scan failed' }),
  });

  const [invite, setInvite] = useState<PortalInvite | null>(null);
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const invitePortal = useMutation({
    mutationFn: () => apiPost<PortalInvite>(`/crm/contacts/${project.customer_contact_id}/invite-portal`, {}),
    onSuccess: (r) => { setInvite(r); setInviteErr(null); },
    onError: (e: unknown) => { setInviteErr((e as { message?: string })?.message ?? 'invite failed'); setInvite(null); },
  });

  const recent = lastScan ?? scans[0] ?? null;
  const hasAoi = project.aoi_west != null && project.aoi_north != null;

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-[var(--fg)] truncate">{project.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--fg-muted)]">
            <span className="flex items-center gap-1"><Building2 className="size-3" />{clientName}</span>
            <Badge variant={project.leak_source === 'gateway' ? 'accent' : 'outline'} size="sm">{project.leak_source ?? 'unset'}</Badge>
            {hasAoi
              ? <span className="flex items-center gap-1 font-mono"><MapPin className="size-3" />{Number(project.center_lat).toFixed(3)}, {Number(project.center_lon).toFixed(3)}</span>
              : <span className="text-[var(--orange)]">no AOI</span>}
            <span>{detections.length} detections</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <Button size="sm" disabled={!hasAoi || requestScan.isPending}
            onClick={() => requestScan.mutate()} title={hasAoi ? 'Request a satellite scan for this AOI' : 'Set an AOI first'}>
            <RefreshCw className={cn('size-3.5', requestScan.isPending && 'animate-spin')} />
            {requestScan.isPending ? 'Scanning…' : 'Request scan'}
          </Button>
          {project.customer_contact_id && (
            <Button size="sm" variant="outline" disabled={invitePortal.isPending}
              onClick={() => invitePortal.mutate()} title="Create this client's SSO portal login">
              <UserPlus className="size-3.5" />
              {invitePortal.isPending ? 'Inviting…' : 'Invite to portal'}
            </Button>
          )}
        </div>
      </div>
      {recent && (
        <div className={cn('mt-2 text-[11px]', recent.status === 'failed' ? 'text-[var(--red)]' : 'text-[var(--fg-muted)]')}>
          {recent.status === 'failed'
            ? `Last scan failed: ${recent.error ?? 'unknown'}`
            : `Last scan ${recent.requested_at ? formatRelative(recent.requested_at) : 'just now'} — ${recent.result_summary?.detections ?? 0} indicators (${recent.result_summary?.confirmed ?? 0} confirmed)`}
        </div>
      )}
      {inviteErr && <div className="mt-2 text-[11px] text-[var(--red)]">Portal invite failed: {inviteErr}</div>}
      {invite && (
        <div className="mt-2 rounded-[var(--radius-md)] border border-[var(--accent-strong)]/40 bg-[color-mix(in_oklch,var(--accent)_8%,transparent)] p-2 text-[11px] space-y-0.5">
          <div className="font-medium text-[var(--fg)]">Portal login {invite.created ? 'created' : 'refreshed'} for {invite.email}</div>
          <div>Temp password: <code className="font-mono text-[var(--fg)]">{invite.temp_password}</code> (they reset it on first sign-in)</div>
          <div>Login link: <a href={invite.login_url} className="underline text-[var(--accent-strong)]">{invite.login_url}</a></div>
        </div>
      )}
    </div>
  );
}

function NewClientForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      const org = await apiPost<Org>('/crm/organizations', { name, industry: 'Agriculture' });
      if (email) {
        await apiPost('/crm/contacts', { organization_id: org.id, first_name: first || 'Contact', last_name: last || name, email });
      }
      return org;
    },
    onSuccess: onCreated,
    onError: (e: unknown) => setErr((e as { message?: string })?.message ?? 'create failed'),
  });
  return (
    <form className="rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--surface-sunken)] p-3 space-y-3"
      onSubmit={(e) => { e.preventDefault(); setErr(null); create.mutate(); }}>
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-semibold">New client</div>
        <button type="button" onClick={onClose} aria-label="Close"><X className="size-4 text-[var(--fg-muted)]" /></button>
      </div>
      <div className="space-y-1"><Label>Organization name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Farms Co-op" required /></div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1"><Label>Contact first</Label><Input value={first} onChange={(e) => setFirst(e.target.value)} /></div>
        <div className="space-y-1"><Label>Contact last</Label><Input value={last} onChange={(e) => setLast(e.target.value)} /></div>
      </div>
      <div className="space-y-1"><Label>Contact email (portal login)</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ops@client.com" /></div>
      {err && <div className="text-[11px] text-[var(--red)]">{err}</div>}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>{create.isPending ? 'Creating…' : 'Create client'}</Button>
      </div>
    </form>
  );
}

function NewProjectForm({ orgs, onClose, onCreated }: { orgs: Org[]; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [orgId, setOrgId] = useState('');
  const [leakSource, setLeakSource] = useState<'gateway' | 'bundled'>('gateway');
  const [w, setW] = useState(''); const [s, setS] = useState(''); const [e2, setE] = useState(''); const [n, setN] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const west = Number(w), south = Number(s), east = Number(e2), north = Number(n);
      const hasAoi = [west, south, east, north].every(Number.isFinite);
      const body: Record<string, unknown> = {
        title, description: description || null, leak_source: leakSource,
        customer_organization_id: orgId || undefined,
      };
      if (hasAoi) {
        Object.assign(body, {
          aoi_west: west, aoi_south: south, aoi_east: east, aoi_north: north,
          center_lat: (south + north) / 2, center_lon: (west + east) / 2, default_zoom: 12,
        });
      }
      return apiPost<Project>('/crm/projects', body);
    },
    onSuccess: onCreated,
    onError: (er: unknown) => setErr((er as { message?: string })?.message ?? 'create failed'),
  });

  return (
    <form className="rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--surface-sunken)] p-3 space-y-3"
      onSubmit={(ev) => { ev.preventDefault(); setErr(null); create.mutate(); }}>
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-semibold">New project</div>
        <button type="button" onClick={onClose} aria-label="Close"><X className="size-4 text-[var(--fg-muted)]" /></button>
      </div>
      <div className="space-y-1"><Label>Title</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="North Field Monitoring Q3" required /></div>
      <div className="space-y-1"><Label>Description</Label><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label>Client</Label>
          <select className="w-full h-9 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] px-3 text-[13px]"
            value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            <option value="">— none —</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label>Signal source</Label>
          <select className="w-full h-9 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] px-3 text-[13px]"
            value={leakSource} onChange={(e) => setLeakSource(e.target.value as 'gateway' | 'bundled')}>
            <option value="gateway">gateway (live AlphaGeoCore)</option>
            <option value="bundled">bundled (676251)</option>
          </select>
        </div>
      </div>
      <div className="space-y-1">
        <Label>AOI bbox (W / S / E / N)</Label>
        <div className="grid grid-cols-4 gap-1.5">
          <Input value={w} onChange={(e) => setW(e.target.value)} placeholder="west" />
          <Input value={s} onChange={(e) => setS(e.target.value)} placeholder="south" />
          <Input value={e2} onChange={(e) => setE(e.target.value)} placeholder="east" />
          <Input value={n} onChange={(e) => setN(e.target.value)} placeholder="north" />
        </div>
      </div>
      {err && <div className="text-[11px] text-[var(--red)]">{err}</div>}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!title.trim() || create.isPending}>
          <Plus className="size-3.5" />{create.isPending ? 'Creating…' : 'Create project'}
        </Button>
      </div>
    </form>
  );
}
