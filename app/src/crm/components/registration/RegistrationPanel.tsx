// =============================================================================
// RegistrationPanel — staff review of self-service portal registrations.
// -----------------------------------------------------------------------------
// Role-gated (crm.registration.read to view; crm.registration.manage to act).
// Two sections:
//   * Pending requests — approve (provisions the SSO login + links the project)
//     or reject. Approval surfaces a temp password to relay when email delivery
//     isn't configured.
//   * Access codes — the org/access codes a prospect enters on /register.html.
//     Create new codes (role + optional project) and deactivate old ones.
//
// Self-hides when the caller lacks crm.registration.read (the queries 403).
// =============================================================================

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@crm/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@crm/components/ui/card';
import { Badge } from '@crm/components/ui/badge';
import { Button } from '@crm/components/ui/button';
import { Input, Label } from '@crm/components/ui/input';
import { cn, formatRelative } from '@crm/lib/utils';
import { UserCheck, UserX, KeyRound, Plus, ShieldCheck, MailCheck, MailWarning } from 'lucide-react';

interface RegRequest {
  id: string; email: string; first_name?: string | null; last_name?: string | null;
  company?: string | null; role: string; project_id?: string | null; status: string;
  email_verified: boolean; reviewed_at?: string | null; reject_reason?: string | null; created_at: string;
}
interface RegCode {
  id: string; code: string; role: string; project_id?: string | null; project_title?: string | null;
  label?: string | null; max_uses?: number | null; used_count: number; expires_at?: string | null;
  active: boolean; created_at: string;
}
interface ApproveResult {
  status: string; email: string; role: string; created: boolean;
  login_url: string; email_delivered: boolean; temp_password?: string;
}

export function RegistrationPanel() {
  const qc = useQueryClient();
  const reqQ = useQuery({
    queryKey: ['registration-requests'],
    queryFn: () => apiGet<{ requests: RegRequest[] }>('/crm/registration-requests'),
    retry: false,
  });
  const codeQ = useQuery({
    queryKey: ['registration-codes'],
    queryFn: () => apiGet<{ codes: RegCode[] }>('/crm/registration-codes'),
    retry: false,
  });

  // If the caller can't read registrations, render nothing (it's a staff-only tool).
  if (reqQ.isError) return null;

  const requests = reqQ.data?.requests ?? [];
  const codes = codeQ.data?.codes ?? [];
  const pending = requests.filter((r) => r.status === 'pending');

  return (
    <Card data-coachmark="pm.registration">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" /> Portal registrations</CardTitle>
          <CardDescription>
            Review self-service access requests and manage the access codes people use to register.
          </CardDescription>
        </div>
        {pending.length > 0 && <Badge variant="accent">{pending.length} pending</Badge>}
      </CardHeader>
      <CardContent className="space-y-5">
        <RequestList requests={requests} onChanged={() => qc.invalidateQueries({ queryKey: ['registration-requests'] })} />
        <CodeSection codes={codes} onChanged={() => qc.invalidateQueries({ queryKey: ['registration-codes'] })} />
      </CardContent>
    </Card>
  );
}

function RequestList({ requests, onChanged }: { requests: RegRequest[]; onChanged: () => void }) {
  const pending = requests.filter((r) => r.status === 'pending');
  if (requests.length === 0) {
    return <div className="text-[12px] text-[var(--fg-muted)]">No registration requests yet.</div>;
  }
  return (
    <div className="space-y-2">
      <Label>Requests</Label>
      {pending.length === 0 && <div className="text-[12px] text-[var(--fg-muted)]">No pending requests.</div>}
      {pending.map((r) => <RequestRow key={r.id} req={r} onChanged={onChanged} />)}
    </div>
  );
}

function RequestRow({ req, onChanged }: { req: RegRequest; onChanged: () => void }) {
  const [result, setResult] = useState<ApproveResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const approve = useMutation({
    mutationFn: () => apiPost<ApproveResult>(`/crm/registration-requests/${req.id}/approve`, {}),
    onSuccess: (r) => { setResult(r); setErr(null); onChanged(); },
    onError: (e: unknown) => setErr((e as { message?: string })?.message ?? 'approve failed'),
  });
  const reject = useMutation({
    mutationFn: () => apiPost(`/crm/registration-requests/${req.id}/reject`, { reason }),
    onSuccess: () => { setRejecting(false); onChanged(); },
    onError: (e: unknown) => setErr((e as { message?: string })?.message ?? 'reject failed'),
  });

  const name = [req.first_name, req.last_name].filter(Boolean).join(' ') || req.email.split('@')[0];
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--fg)] truncate">
            {name}
            {req.email_verified
              ? <span className="inline-flex items-center gap-1 text-[10px] text-[var(--green)]"><MailCheck className="size-3" /> verified</span>
              : <span className="inline-flex items-center gap-1 text-[10px] text-[var(--amber,#9a6a00)]"><MailWarning className="size-3" /> unverified</span>}
          </div>
          <div className="text-[11px] text-[var(--fg-muted)] truncate">{req.email}{req.company ? ` · ${req.company}` : ''}</div>
          <div className="text-[10px] text-[var(--fg-subtle)] mt-0.5">
            {req.role} · requested {formatRelative(req.created_at)}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <Button size="sm" disabled={!req.email_verified || approve.isPending}
            onClick={() => approve.mutate()}
            title={req.email_verified ? 'Approve and provision their login' : 'Waiting on email confirmation'}>
            <UserCheck className="size-3.5" /> {approve.isPending ? 'Approving…' : 'Approve'}
          </Button>
          <Button size="sm" variant="outline" disabled={reject.isPending} onClick={() => setRejecting((v) => !v)}>
            <UserX className="size-3.5" /> Reject
          </Button>
        </div>
      </div>

      {rejecting && (
        <div className="mt-2 flex items-center gap-2">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" className="h-8 text-[12px]" />
          <Button size="sm" variant="outline" disabled={reject.isPending} onClick={() => reject.mutate()}>
            {reject.isPending ? 'Rejecting…' : 'Confirm reject'}
          </Button>
        </div>
      )}
      {err && <div className="mt-2 text-[11px] text-[var(--red)]">{err}</div>}
      {result && (
        <div className="mt-2 rounded-[var(--radius-md)] border border-[var(--green)]/40 bg-[color-mix(in_oklch,var(--green)_8%,transparent)] p-2 text-[11px] space-y-0.5">
          <div className="font-medium text-[var(--fg)]">Approved {result.email}</div>
          {result.email_delivered
            ? <div>A login email was sent to them.</div>
            : <>
                <div>Email delivery isn't configured — relay these manually:</div>
                <div>Sign-in: <a href={result.login_url} className="underline text-[var(--accent-strong)]">{result.login_url}</a></div>
                {result.temp_password && <div>Temp password: <code className="font-mono text-[var(--fg)]">{result.temp_password}</code></div>}
              </>}
        </div>
      )}
    </div>
  );
}

function CodeSection({ codes, onChanged }: { codes: RegCode[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => apiPost<{ code: RegCode }>(`/crm/registration-codes`, {
      code: code.trim() || undefined,
      label: label.trim() || undefined,
      max_uses: maxUses.trim() ? Number(maxUses.trim()) : undefined,
    }),
    onSuccess: (r) => { setNewCode(r.code.code); setErr(null); setCode(''); setLabel(''); setMaxUses(''); onChanged(); },
    onError: (e: unknown) => setErr((e as { message?: string })?.message ?? 'create failed'),
  });
  const deactivate = useMutation({
    mutationFn: (id: string) => apiPost(`/crm/registration-codes/${id}/deactivate`, {}),
    onSuccess: () => onChanged(),
  });

  return (
    <div className="space-y-2 border-t border-[var(--border)] pt-4">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1.5"><KeyRound className="size-3.5" /> Access codes</Label>
        <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
          <Plus className="size-3.5" /> New code
        </Button>
      </div>

      {open && (
        <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="space-y-1"><Label htmlFor="nc-code">Code (blank = auto)</Label><Input id="nc-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="AG-XXXXXXXX" className="h-8 text-[12px]" /></div>
            <div className="space-y-1"><Label htmlFor="nc-label">Label</Label><Input id="nc-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Houston pilot" className="h-8 text-[12px]" /></div>
            <div className="space-y-1"><Label htmlFor="nc-max">Max uses (blank = ∞)</Label><Input id="nc-max" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="∞" className="h-8 text-[12px]" /></div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? 'Creating…' : 'Create code'}
            </Button>
            <span className="text-[10px] text-[var(--fg-muted)]">New codes default to the customer role + this tenant.</span>
          </div>
          {err && <div className="text-[11px] text-[var(--red)]">{err}</div>}
          {newCode && <div className="text-[11px] text-[var(--green)]">Created code <code className="font-mono text-[var(--fg)]">{newCode}</code> — share it with the customer.</div>}
        </div>
      )}

      {codes.length === 0 && <div className="text-[12px] text-[var(--fg-muted)]">No access codes yet.</div>}
      {codes.map((c) => (
        <div key={c.id} className={cn('flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border)] px-3 py-2',
          !c.active && 'opacity-50')}>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[12px]">
              <code className="font-mono font-medium text-[var(--fg)]">{c.code}</code>
              <Badge variant={c.active ? 'success' : 'non'}>{c.active ? 'active' : 'inactive'}</Badge>
              <span className="text-[10px] text-[var(--fg-subtle)]">{c.role}</span>
            </div>
            <div className="text-[10px] text-[var(--fg-muted)] truncate">
              {c.label ? `${c.label} · ` : ''}{c.project_title ? `→ ${c.project_title} · ` : ''}
              used {c.used_count}{c.max_uses != null ? `/${c.max_uses}` : ''}
            </div>
          </div>
          {c.active && (
            <Button size="sm" variant="outline" disabled={deactivate.isPending} onClick={() => deactivate.mutate(c.id)}>
              Deactivate
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
