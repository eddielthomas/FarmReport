// =============================================================================
// AiAssistantRail — right-rail AI chat shell (S7A)
// -----------------------------------------------------------------------------
// Composable shell that matches the "AI Assistant" right column in the Sales
// Dashboard concept. S7B will fill it with real data; this primitive only
// owns layout, scroll behaviour, and the input dock.
//
// Anatomy:
//   • Header        — title + minimise/expand control.
//   • Message list  — user / assistant bubbles, with optional attachments.
//   • Suggestions   — quick-reply chips (optional).
//   • Composer dock — input + Files / Images / Audio / Send buttons.
// =============================================================================

import * as React from 'react';
import { Send, Paperclip, Mic, Image as ImageIcon, FileText, Minimize2, Sparkles } from 'lucide-react';
import { cn } from '@crm/lib/utils';
import { BrandMark } from './brand-mark';

export interface AssistantUser {
  id:    string;
  name:  string;
  avatar?: string;
}

export interface AssistantAttachment {
  id:    string;
  label: string;
  icon?: React.ReactNode;
}

export interface AssistantMessage {
  id:     string;
  author: 'user' | 'assistant';
  user?:  AssistantUser;
  /** Plain text or rich JSX. */
  body:   React.ReactNode;
  attachments?: AssistantAttachment[];
  /** Display timestamp (`10:12`). */
  time?:  string;
}

export interface AiAssistantRailProps extends React.HTMLAttributes<HTMLDivElement> {
  title?:       React.ReactNode;
  user?:        AssistantUser;
  messages:     AssistantMessage[];
  suggestions?: string[];
  /** Submit handler when the composer is sent. */
  onSubmit?:    (text: string) => void;
  /** Optional minimise control. */
  onCollapse?:  () => void;
  /** Hide composer (read-only thread). */
  readOnly?:    boolean;
  placeholder?: string;
}

export function AiAssistantRail({
  title = 'AI Assistant',
  user,
  messages,
  suggestions,
  onSubmit,
  onCollapse,
  readOnly,
  placeholder = 'Enter your AI Assistant Request',
  className,
  ...rest
}: AiAssistantRailProps) {
  const [draft, setDraft] = React.useState('');
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    // Auto-scroll to newest message
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  function send() {
    const text = draft.trim();
    if (!text || readOnly) return;
    onSubmit?.(text);
    setDraft('');
  }

  return (
    <section
      role="complementary"
      aria-label={typeof title === 'string' ? title : 'AI Assistant'}
      className={cn(
        'flex flex-col h-full min-h-0 rounded-[var(--radius-2xl)]',
        'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
        'shadow-[var(--shadow-card)] overflow-hidden',
        className,
      )}
      {...rest}
    >
      {/* Header */}
      <header className="flex items-center justify-between gap-3 p-4 pb-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <Sparkles className="size-4 text-[var(--fg)]" />
          <span>{title}</span>
        </div>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Minimise assistant"
            className="grid place-items-center size-7 rounded-[var(--radius-full)] bg-[var(--surface-sunken)] hover:bg-[var(--fg)] hover:text-[var(--fg-inverted)] transition-colors duration-[var(--duration-fast)]"
          >
            <Minimize2 className="size-3.5" />
          </button>
        )}
      </header>

      {/* Messages */}
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        {messages.length === 0 && (
          <div className="text-[12px] text-[var(--fg-subtle)]">
            No messages yet — start a conversation below.
          </div>
        )}
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} self={m.user?.id === user?.id} />
        ))}
      </div>

      {/* Suggestions */}
      {suggestions && suggestions.length > 0 && !readOnly && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSubmit?.(s)}
              className="rounded-[var(--radius-full)] bg-[var(--surface-sunken)] text-[var(--fg)] text-[12px] px-3 py-1 hover:bg-[var(--fg)] hover:text-[var(--fg-inverted)] transition-colors duration-[var(--duration-fast)]"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Composer */}
      {!readOnly && (
        <form
          onSubmit={(e) => { e.preventDefault(); send(); }}
          className="p-3 border-t border-[var(--border)] flex flex-col gap-2"
        >
          <div className="flex items-center gap-1.5">
            <ComposerButton icon={<FileText className="size-3.5" />}  label="Files"  />
            <ComposerButton icon={<ImageIcon className="size-3.5" />} label="Images" />
            <ComposerButton icon={<Mic className="size-3.5" />}       label="Audio Chat" />
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 h-10 rounded-[var(--radius-full)] bg-[var(--surface-sunken)] px-3">
              <Paperclip className="size-3.5 text-[var(--fg-muted)]" />
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={placeholder}
                className="flex-1 bg-transparent outline-none text-[13px] placeholder:text-[var(--fg-subtle)] text-[var(--fg)]"
                aria-label="Assistant prompt"
              />
            </div>
            <button
              type="submit"
              disabled={!draft.trim()}
              aria-label="Send"
              className="grid place-items-center size-10 rounded-[var(--radius-full)] bg-[var(--fg)] text-[var(--fg-inverted)] hover:bg-[var(--fg)]/85 disabled:opacity-40 disabled:pointer-events-none transition-colors duration-[var(--duration-fast)]"
            >
              <Send className="size-4" />
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// MessageRow — single chat row. User messages right-aligned with avatar;
// assistant messages left-aligned with the BrandMark plate.
// -----------------------------------------------------------------------------
function MessageRow({ message, self }: { message: AssistantMessage; self: boolean }) {
  const isUser = message.author === 'user';
  return (
    <div className={cn('flex items-start gap-3', isUser && self && 'flex-row-reverse')}>
      {isUser
        ? <AvatarBubble user={message.user} />
        : <BrandMark size={32} />
      }
      <div className={cn('flex-1 min-w-0 flex flex-col gap-1', isUser && self && 'items-end text-right')}>
        <div className="text-[13px] font-medium text-[var(--fg)]">
          {message.user?.name ?? (isUser ? 'You' : 'Daxa')}
        </div>
        <div className="text-[13px] leading-snug text-[var(--fg)]/90">
          {message.body}
        </div>
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1">
            {message.attachments.map((a) => (
              <span
                key={a.id}
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-2 py-1 text-[11px]"
              >
                {a.icon ?? <FileText className="size-3" />}
                {a.label}
              </span>
            ))}
          </div>
        )}
        {message.time && (
          <span className="text-[10px] text-[var(--fg-subtle)] mt-0.5">{message.time}</span>
        )}
      </div>
    </div>
  );
}

function AvatarBubble({ user }: { user?: AssistantUser }) {
  if (!user) {
    return <div className="size-8 rounded-[var(--radius-full)] bg-[var(--surface-sunken)]" />;
  }
  return (
    <span
      className="grid place-items-center size-8 rounded-[var(--radius-full)] bg-[var(--surface-sunken)] overflow-hidden text-[12px] font-medium text-[var(--fg)]"
      title={user.name}
    >
      {user.avatar
        ? <img src={user.avatar} alt={user.name} className="size-full object-cover" />
        : user.name.charAt(0).toUpperCase()
      }
    </span>
  );
}

function ComposerButton({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[var(--radius-full)] bg-[var(--surface-sunken)] text-[11px] text-[var(--fg-muted)] hover:bg-[var(--fg)] hover:text-[var(--fg-inverted)] transition-colors duration-[var(--duration-fast)]"
    >
      {icon}{label}
    </button>
  );
}
