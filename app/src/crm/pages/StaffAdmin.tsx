// =============================================================================
// StaffAdmin — tenant-scoped user + team management (S7C re-skin)
// -----------------------------------------------------------------------------
// IA preserved (users tab + teams tab, invite + role editor + team membership).
// Visual layer rewritten on the new token primitives; PillTabs replaces the
// sidebar tab buttons.
// =============================================================================

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut, apiDel } from '@crm/lib/api';
import type { StaffUser, Team } from '@crm/lib/types';
import { ALL_ROLES } from '@crm/lib/types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@crm/components/ui/card';
import { Badge } from '@crm/components/ui/badge';
import { Button } from '@crm/components/ui/button';
import { Input, Label } from '@crm/components/ui/input';
import { PillTabs, type PillTabItem } from '@crm/components/ui/pill-tabs';
import { Plus, Trash2, UserPlus, ShieldCheck, X } from 'lucide-react';
import { cn, formatRelative } from '@crm/lib/utils';
import { CoachmarkTour } from '@crm/components/ui/coachmark';
import { TOURS } from '@crm/lib/tours';

type TabKey = 'users' | 'teams';
const TAB_ITEMS: ReadonlyArray<PillTabItem<TabKey>> = [
  { key: 'users', label: 'Users' },
  { key: 'teams', label: 'Teams' },
];

export function StaffAdmin() {
  const [tab, setTab] = useState<TabKey>('users');
  return (
    <div className="h-full overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
      <div className="p-4 sm:p-6 space-y-5 max-w-[1400px] mx-auto">
        <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
              Directory
            </div>
            <h1 className="text-[24px] font-semibold tracking-[var(--tracking-tight)]">
              Staff &amp; Teams
            </h1>
            <div className="text-[12px] text-[var(--fg-muted)] mt-0.5">
              Manage users, roles, and team membership for this tenant.
            </div>
          </div>
          <PillTabs<TabKey>
            value={tab}
            onChange={setTab}
            items={TAB_ITEMS}
            size="md"
            aria-label="Staff section"
            data-coachmark="staff.tabs"
          />
        </header>

        <section data-coachmark={tab === 'users' ? 'staff.users' : 'staff.teams'}>
          {tab === 'users' ? <UsersPanel /> : <TeamsPanel />}
        </section>
      </div>
      <CoachmarkTour tourId={TOURS.staff.id} steps={TOURS.staff.steps} />
    </div>
  );
}

// ---- USERS -----------------------------------------------------------------

function UsersPanel() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const { data: users = [], isLoading } = useQuery({
    queryKey: ['staff-users'],
    queryFn:  () => apiGet<StaffUser[]>('/iam/users'),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[12px] text-[var(--fg-muted)]">
          {users.length} user{users.length === 1 ? '' : 's'}
        </div>
        <Button size="md" onClick={() => setCreating(true)}>
          <UserPlus className="size-4" /> Invite
        </Button>
      </div>
      {creating && (
        <NewUserForm
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); qc.invalidateQueries({ queryKey: ['staff-users'] }); }}
        />
      )}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
                <th className="text-left p-3 font-medium">User</th>
                <th className="text-left p-3 font-medium">Roles</th>
                <th className="text-left p-3 font-medium">Status</th>
                <th className="text-right p-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={4} className="p-4 text-center text-[11px] text-[var(--fg-muted)]">Loading…</td></tr>}
              {users.map((u) => <UserRow key={u.id} user={u} />)}
              {!isLoading && users.length === 0 && (
                <tr><td colSpan={4} className="p-4 text-center text-[11px] text-[var(--fg-subtle)]">No users yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function NewUserForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ email: '', display_name: '', roles: ['dashboard:view'] as string[] });
  const [submitting, setSubmitting] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.email.trim() || !form.display_name.trim()) return;
    setSubmitting(true);
    try { await apiPost('/iam/users', form); onCreated(); }
    catch (err) { console.error(err); }
    finally { setSubmitting(false); }
  }
  return (
    <Card>
      <form onSubmit={submit} className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex items-center justify-between sm:col-span-2">
          <div className="text-[14px] font-semibold text-[var(--fg)]">Invite user</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="size-7 grid place-items-center rounded-[var(--radius-full)] text-[var(--fg-muted)] hover:text-[var(--red)] hover:bg-[var(--surface-sunken)]"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-1">
          <Label htmlFor="u-email">Email</Label>
          <Input id="u-email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="u-name">Display name</Label>
          <Input id="u-name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
        </div>
        <div className="sm:col-span-2 space-y-1">
          <Label>Roles</Label>
          <div className="flex flex-wrap gap-1.5">
            {ALL_ROLES.map((r) => {
              const on = form.roles.includes(r);
              return (
                <button
                  type="button"
                  key={r}
                  onClick={() => setForm({
                    ...form,
                    roles: on ? form.roles.filter((x) => x !== r) : [...form.roles, r],
                  })}
                  className={cn(
                    'px-3 h-7 rounded-[var(--radius-full)] text-[11px] font-medium',
                    'transition-colors duration-[var(--duration-fast)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                    on
                      ? 'bg-[var(--fg)] text-[var(--fg-inverted)]'
                      : 'border border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-sunken)]',
                  )}
                >
                  {r}
                </button>
              );
            })}
          </div>
        </div>
        <div className="sm:col-span-2 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" size="md" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="md" disabled={submitting}>
            {submitting ? 'Inviting…' : 'Invite'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function UserRow({ user }: { user: StaffUser }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [roles, setRoles] = useState<string[]>(user.roles);
  const save = useMutation({
    mutationFn: () => apiPut(`/iam/users/${user.id}`, { roles }),
    onSuccess: () => { setEditing(false); qc.invalidateQueries({ queryKey: ['staff-users'] }); },
  });
  const deactivate = useMutation({
    mutationFn: () => apiDel(`/iam/users/${user.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff-users'] }),
  });
  return (
    <tr className="border-b border-[var(--border)]/60 last:border-0 hover:bg-[var(--surface-sunken)]/40 transition-colors">
      <td className="p-3">
        <div className="text-[13px] font-medium text-[var(--fg)]">{user.display_name}</div>
        <div className="text-[11px] text-[var(--fg-muted)] font-mono">{user.email}</div>
      </td>
      <td className="p-3">
        {editing ? (
          <div className="flex flex-wrap gap-1">
            {ALL_ROLES.map((r) => {
              const on = roles.includes(r);
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRoles(on ? roles.filter((x) => x !== r) : [...roles, r])}
                  className={cn(
                    'px-2 h-6 rounded-[var(--radius-full)] text-[10px] font-medium',
                    on
                      ? 'bg-[var(--fg)] text-[var(--fg-inverted)]'
                      : 'border border-[var(--border)] text-[var(--fg-muted)]',
                  )}
                >
                  {r}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {user.roles.map((r) => <Badge key={r} variant="outline" size="sm">{r}</Badge>)}
          </div>
        )}
      </td>
      <td className="p-3">
        <Badge variant={user.status === 'active' ? 'success' : 'destructive'} size="sm">
          {user.status}
        </Badge>
      </td>
      <td className="p-3 text-right">
        {editing ? (
          <div className="flex items-center justify-end gap-1.5">
            <Button size="sm" variant="outline" onClick={() => { setRoles(user.roles); setEditing(false); }}>Cancel</Button>
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? '…' : 'Save'}
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <ShieldCheck className="size-3.5" /> Roles
            </Button>
            {user.status === 'active' && (
              <Button size="sm" variant="outline" onClick={() => deactivate.mutate()} disabled={deactivate.isPending}>
                <Trash2 className="size-3.5" /> Deactivate
              </Button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

// ---- TEAMS -----------------------------------------------------------------

function TeamsPanel() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const { data: teams = [], isLoading } = useQuery({
    queryKey: ['staff-teams'],
    queryFn:  () => apiGet<Team[]>('/iam/teams'),
  });
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[12px] text-[var(--fg-muted)]">
          {teams.length} team{teams.length === 1 ? '' : 's'}
        </div>
        <Button size="md" onClick={() => setCreating(true)}>
          <Plus className="size-4" /> New team
        </Button>
      </div>
      {creating && (
        <NewTeamForm
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); qc.invalidateQueries({ queryKey: ['staff-teams'] }); }}
        />
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {isLoading && <div className="col-span-2 text-[12px] text-[var(--fg-muted)] p-3">Loading…</div>}
        {teams.map((t) => <TeamCard key={t.id} team={t} />)}
        {!isLoading && teams.length === 0 && (
          <div className="col-span-2 text-[12px] text-[var(--fg-subtle)] text-center p-4">No teams yet</div>
        )}
      </div>
    </div>
  );
}

function NewTeamForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ name: '', description: '' });
  const [submitting, setSubmitting] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSubmitting(true);
    try { await apiPost('/iam/teams', form); onCreated(); }
    catch (err) { console.error(err); }
    finally { setSubmitting(false); }
  }
  return (
    <Card>
      <form onSubmit={submit} className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex items-center justify-between sm:col-span-2">
          <div className="text-[14px] font-semibold text-[var(--fg)]">New team</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="size-7 grid place-items-center rounded-[var(--radius-full)] text-[var(--fg-muted)] hover:text-[var(--red)] hover:bg-[var(--surface-sunken)]"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-1">
          <Label htmlFor="tm-name">Name</Label>
          <Input id="tm-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="tm-desc">Description</Label>
          <Input id="tm-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="sm:col-span-2 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" size="md" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="md" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create team'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TeamCard({ team }: { team: Team }) {
  const qc = useQueryClient();
  const { data: tenantUsers = [] } = useQuery({
    queryKey: ['tenant-users'],
    queryFn:  () => apiGet<StaffUser[]>('/tenants/me/users'),
    staleTime: 60_000,
  });
  const [selectedUser, setSelectedUser] = useState('');
  const add = useMutation({
    mutationFn: () => apiPost(`/iam/teams/${team.id}/members`, { user_id: selectedUser, role: 'member' }),
    onSuccess: () => { setSelectedUser(''); qc.invalidateQueries({ queryKey: ['staff-teams'] }); },
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => apiDel(`/iam/teams/${team.id}/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff-teams'] }),
  });
  const removeTeam = useMutation({
    mutationFn: () => apiDel(`/iam/teams/${team.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff-teams'] }),
  });
  const memberIds = new Set(team.members.map((m) => m.user_id));
  const candidates = tenantUsers.filter((u) => !memberIds.has(u.id));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>{team.name}</span>
          <button
            type="button"
            onClick={() => { if (confirm('Delete team?')) removeTeam.mutate(); }}
            aria-label="Delete team"
            className="size-7 grid place-items-center rounded-[var(--radius-full)] text-[var(--fg-muted)] hover:text-[var(--red)] hover:bg-[var(--surface-sunken)] transition-colors"
          >
            <Trash2 className="size-3.5" />
          </button>
        </CardTitle>
        <CardDescription>{team.description ?? team.slug}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
          Members · {team.members.length}
        </div>
        <div className="space-y-1.5">
          {team.members.map((m) => (
            <div
              key={m.user_id}
              className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-2"
            >
              <div className="min-w-0">
                <div className="text-[12px] font-medium text-[var(--fg)] truncate">{m.display_name}</div>
                <div className="text-[10px] text-[var(--fg-muted)] font-mono truncate">
                  {m.email} · joined {formatRelative(m.joined_at)}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Badge variant="outline" size="sm">{m.role}</Badge>
                <button
                  type="button"
                  onClick={() => removeMember.mutate(m.user_id)}
                  aria-label="Remove member"
                  className="size-6 grid place-items-center rounded-[var(--radius-full)] text-[var(--fg-muted)] hover:text-[var(--red)] hover:bg-[var(--surface-sunken)] transition-colors"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
          {team.members.length === 0 && (
            <div className="text-[11px] text-[var(--fg-subtle)] p-2 text-center">No members</div>
          )}
        </div>
        {candidates.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={selectedUser}
              onChange={(e) => setSelectedUser(e.target.value)}
              aria-label="Add member"
              className="flex-1 h-9 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] px-3 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              <option value="">— add member —</option>
              {candidates.map((u) => <option key={u.id} value={u.id}>{u.display_name} · {u.email}</option>)}
            </select>
            <Button size="md" disabled={!selectedUser || add.isPending} onClick={() => add.mutate()}>Add</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
