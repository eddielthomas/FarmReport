// =============================================================================
// AiAssistantChat — concrete demo instance of AiAssistantRail (S7B)
// -----------------------------------------------------------------------------
// Pre-populates the rail with the literal conversation from the Overview Panel
// concept ("Hey Daxa, Can you check for discrepancies in revenue vs. projected
// values?" → file attachment "ID: #6287439" → assistant bubble "Main Deviations
// by Month" with July/August/September deltas).
//
// State is local — submitting a prompt appends a placeholder echo so analysts
// can sanity-check the UX before we wire the real LLM endpoint (out of S7B's
// scope).
// =============================================================================

import * as React from 'react';
import { FileText } from 'lucide-react';
import { AiAssistantRail, type AssistantMessage, type AssistantUser } from '@crm/components/ui/ai-assistant-rail';
import { useAuthStore } from '@crm/lib/auth-store';

const SEED: AssistantMessage[] = [
  {
    id:    'm-1',
    author:'user',
    time:  '10:12',
    body:  'Hey Daxa, Can you check for discrepancies in revenue vs. projected values?',
    attachments: [
      { id: 'a-1', label: 'ID: #6287439', icon: <FileText className="size-3" /> },
    ],
  },
  {
    id:    'm-2',
    author:'assistant',
    time:  '10:13',
    body: (
      <>
        <div className="font-semibold text-[var(--fg)]">Main Deviations by Month:</div>
        <ul className="mt-1 space-y-1 text-[12px]">
          <li className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2">
              <span className="size-1.5 rounded-[var(--radius-full)] bg-[var(--fg-subtle)]" />
              July
            </span>
            <span className="tabular-nums">$18.9K</span>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2">
              <span className="size-1.5 rounded-[var(--radius-full)] bg-[var(--fg-subtle)]" />
              August
            </span>
            <span className="tabular-nums">$21.7K</span>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2">
              <span className="size-1.5 rounded-[var(--radius-full)] bg-[var(--fg)]" />
              September
            </span>
            <span className="tabular-nums">$11.9K</span>
          </li>
        </ul>
        <div className="mt-3 h-2 rounded-[var(--radius-full)] bg-[var(--surface-sunken)] overflow-hidden relative">
          <span className="absolute inset-y-0 left-0 w-[26%] bg-[var(--accent)]" />
          <span className="absolute inset-y-0 left-[26%] w-[14%] bg-[var(--fg)]" />
        </div>
      </>
    ),
  },
];

export function AiAssistantChat({ className }: { className?: string }) {
  const user = useAuthStore((s) => s.user);
  const [messages, setMessages] = React.useState<AssistantMessage[]>(SEED);

  const me: AssistantUser = {
    id:     user?.id ?? 'me',
    name:   user?.display_name ?? user?.email?.split('@')[0] ?? 'You',
  };

  // Stamp the seed user with the live user details so the avatar shows.
  const seeded = React.useMemo<AssistantMessage[]>(() => (
    messages.map((m) => (m.author === 'user' && !m.user ? { ...m, user: me } : m))
  ), [messages, me]);

  function handleSubmit(text: string) {
    setMessages((prev) => [
      ...prev,
      {
        id:    `m-${prev.length + 1}`,
        author:'user',
        user:  me,
        time:  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        body:  text,
      },
    ]);
  }

  return (
    <AiAssistantRail
      title="AI Assistant"
      user={me}
      messages={seeded}
      onSubmit={handleSubmit}
      className={className}
    />
  );
}
