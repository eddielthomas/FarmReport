// =============================================================================
// FieldChatPanel — reusable message thread for the field PWA (S17).
// -----------------------------------------------------------------------------
// Bootstraps a conversation (per-job thread or tenant ops channel), renders the
// message list (GET /chat/conversations/:id/messages), provides a composer
// (POST), and subscribes to the socket.io conversation room (chat:join) for
// realtime bubbles. Mirrors the field design-kit styling.
//
// Two modes:
//   mode="job"  + jobId  -> POST /field/jobs/:id/conversation
//   mode="ops"           -> GET  /field/ops-channel
// =============================================================================

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@crm/lib/api';
import { getFieldSocket } from '@crm/lib/field-socket';
import { useAuthStore } from '@crm/lib/auth-store';
import { cn } from '@crm/lib/utils';
import { Send } from 'lucide-react';

interface ChatMessage {
  id:             string;
  sender_user_id: string | null;
  sender_kind:    string;
  body:           string;
  created_at:     string;
}

interface FieldChatPanelProps {
  mode:   'job' | 'ops';
  jobId?: string;
}

function relTime(iso: string): string {
  const d = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((Date.now() - d) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function FieldChatPanel({ mode, jobId }: FieldChatPanelProps) {
  const queryClient = useQueryClient();
  const myId = useAuthStore((s) => s.user?.id ?? null);
  const [convId, setConvId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  const [bootErr, setBootErr] = React.useState<string | null>(null);

  // ---- bootstrap the conversation ----------------------------------------
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = mode === 'job' && jobId
          ? await apiPost<{ conversation_id: string }>(`/field/jobs/${jobId}/conversation`)
          : await apiGet<{ conversation_id: string }>(`/field/ops-channel`);
        if (!cancelled) setConvId(r.conversation_id);
      } catch {
        if (!cancelled) setBootErr('Could not open the message thread.');
      }
    })();
    return () => { cancelled = true; };
  }, [mode, jobId]);

  // ---- messages -----------------------------------------------------------
  const { data: messages = [] } = useQuery({
    queryKey: ['field-chat', convId],
    queryFn:  () => apiGet<ChatMessage[]>(`/chat/conversations/${convId}/messages?limit=200`),
    enabled:  !!convId,
    refetchInterval: 20_000,
  });

  // ---- socket: join room + refetch on new message ------------------------
  React.useEffect(() => {
    if (!convId) return;
    const sock = getFieldSocket();
    if (!sock) return;
    const join = () => sock.emit('chat:join', { conversation_id: convId });
    if (sock.connected) join();
    sock.on('connect', join);
    const onMsg = (env: { payload?: { conversation_id?: string } }) => {
      if (env?.payload?.conversation_id === convId) {
        queryClient.invalidateQueries({ queryKey: ['field-chat', convId] });
      }
    };
    sock.on('chat.message.sent', onMsg);
    return () => {
      sock.off('connect', join);
      sock.off('chat.message.sent', onMsg);
      try { sock.emit('chat:leave', { conversation_id: convId }); } catch { /* ignore */ }
    };
  }, [convId, queryClient]);

  // ---- send ---------------------------------------------------------------
  const sendMut = useMutation({
    mutationFn: (text: string) =>
      apiPost(`/chat/conversations/${convId}/messages`, { body: text }),
    onSuccess: () => {
      setDraft('');
      queryClient.invalidateQueries({ queryKey: ['field-chat', convId] });
    },
  });

  // ---- autoscroll ---------------------------------------------------------
  const endRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  if (bootErr) {
    return (
      <div className="p-3 rounded-[var(--radius-lg)] bg-[var(--red-soft)] text-[12px] text-[var(--fg)]">
        {bootErr}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        className="rounded-[var(--radius-lg)] bg-[var(--surface)] border border-[var(--border)] p-2 space-y-2 overflow-y-auto"
        style={{ maxHeight: 280, minHeight: 120 }}
      >
        {messages.length === 0 && (
          <div className="text-[12px] text-[var(--fg-subtle)] text-center py-4">
            {convId ? 'No messages yet. Say hello to ops.' : 'Opening thread…'}
          </div>
        )}
        {messages.map((m) => {
          const mine = m.sender_user_id && m.sender_user_id === myId;
          return (
            <div key={m.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[80%] px-3 py-2 rounded-[var(--radius-lg)] text-[13px]',
                  mine
                    ? 'bg-[var(--accent)] text-[var(--fg-on-accent)]'
                    : 'bg-[var(--surface-sunken)] text-[var(--fg)] border border-[var(--border)]',
                )}
              >
                <div className="whitespace-pre-wrap break-words">{m.body}</div>
                <div className={cn('mt-1 text-[10px]', mine ? 'text-[var(--fg-on-accent)]/70' : 'text-[var(--fg-muted)]')}>
                  {relTime(m.created_at)}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const t = draft.trim();
          if (t && convId) sendMut.mutate(t);
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={mode === 'ops' ? 'Message ops…' : 'Message ops about this job…'}
          disabled={!convId}
          className="flex-1 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--surface)] border border-[var(--border)] text-[var(--fg)] text-[14px] disabled:opacity-50"
          style={{ minHeight: 44 }}
        />
        <button
          type="submit"
          aria-label="Send message"
          disabled={!convId || sendMut.isPending || !draft.trim()}
          className="grid place-items-center size-11 rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--fg-on-accent)] disabled:opacity-50"
        >
          <Send className="size-5" />
        </button>
      </form>
    </div>
  );
}
