// =============================================================================
// DocumentsView — Sales > Documents tab (S7B)
// -----------------------------------------------------------------------------
// Grid of document tiles. Documents come from `/sales/files` (tenant-wide, no
// lead filter). The visual is a 3-up card grid that re-uses the standard card
// shape from S7A.
// =============================================================================

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Download, Upload, Search } from 'lucide-react';
import { apiGet } from '@crm/lib/api';
import type { FileRecord } from '@crm/lib/types';
import { Button } from '@crm/components/ui/button';
import { Input } from '@crm/components/ui/input';
import { cn, formatDate } from '@crm/lib/utils';

export function DocumentsView() {
  const [q, setQ] = React.useState('');
  const { data: files = [] } = useQuery<FileRecord[]>({
    queryKey: ['sales', 'files', 'all'],
    queryFn:  async () => {
      try { return await apiGet<FileRecord[]>('/sales/files'); }
      catch { return []; }
    },
  });

  const filtered = files.filter((f) => f.file_name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-[1600px] mx-auto space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <div className="text-[12px] text-[var(--fg-muted)]">Sales</div>
          <h1 className="text-[34px] sm:text-[44px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)] leading-tight">
            Documents
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-[var(--fg-muted)]" aria-hidden="true" />
            <Input
              variant="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search documents"
              className="pl-9"
              aria-label="Search documents"
            />
          </div>
          <Button variant="accent" size="md">
            <Upload className="size-3.5" /> Upload
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {filtered.length === 0 && (
          <div className="col-span-full rounded-[var(--radius-xl)] border border-dashed border-[var(--border)] p-10 text-center text-[var(--fg-muted)]">
            No documents yet. Drop one above to seed the library.
          </div>
        )}
        {filtered.map((f) => (
          <article
            key={f.id}
            className={cn(
              'flex flex-col gap-3 p-4',
              'rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
              'shadow-[var(--shadow-card)] hover:bg-[var(--surface-sunken)] transition-colors duration-[var(--duration-fast)]',
            )}
          >
            <div className="flex items-center gap-2">
              <span className="grid place-items-center size-8 rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--fg-on-accent)]">
                <FileText className="size-4" />
              </span>
              <span className="text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
                {(f.file_type ?? 'file').split('/').pop()}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold text-[var(--fg)] truncate" title={f.file_name}>{f.file_name}</div>
              <div className="text-[11px] text-[var(--fg-muted)]">
                {formatBytes(f.file_size)} · {formatDate(f.uploaded_at)}
              </div>
            </div>
            <div className="flex justify-end">
              <Button asChild={false} size="sm" variant="ghost" onClick={() => f.signed_url && window.open(f.signed_url, '_blank')}>
                <Download className="size-3.5" /> Download
              </Button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
