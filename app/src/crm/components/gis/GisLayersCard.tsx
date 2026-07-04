// =============================================================================
// GisLayersCard — customer-facing GIS upload + management panel.
// -----------------------------------------------------------------------------
// Drop a file (or pick via dialog), choose a kind + color, name it; the file
// is uploaded to /api/v1/gis/layers, parsed server-side, and surfaced as a
// vector or raster overlay on the customer's project map.
//
// Below the upload zone is the layer list: status badge (parsing/ready/failed),
// toggle visibility, recolor, rename inline, delete.
//
// Exposes onLayersChange so the parent can refresh the map source when a
// layer is added / toggled / removed.
// =============================================================================

import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDel, apiGet, apiPatch, apiUpload } from '@crm/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@crm/components/ui/card';
import { Badge } from '@crm/components/ui/badge';
import { Button } from '@crm/components/ui/button';
import { Input, Label } from '@crm/components/ui/input';
import { cn, formatRelative } from '@crm/lib/utils';
import { UploadCloud, Trash2, Eye, EyeOff, Edit3, AlertCircle, Layers, FileText, Droplets, Waves, Sprout, Building, Image as ImageIcon, Map as MapIcon } from 'lucide-react';

export type GisKind = 'field-boundary' | 'irrigation' | 'soil' | 'drainage' | 'imagery' | 'assets' | 'other';

export interface GisLayer {
  id: string;
  lead_id: string | null;
  name: string;
  kind: GisKind;
  source_format: string;
  status: 'parsing' | 'ready' | 'failed';
  parse_error: string | null;
  feature_count: number;
  visible: boolean;
  color: string;
  opacity: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  bbox: { type: 'Polygon'; coordinates: number[][][] } | null;
}

const KIND_CONFIG: Record<GisKind, { label: string; color: string; icon: React.ReactNode }> = {
  'field-boundary': { label: 'Field Boundaries',      color: '#00e68a', icon: <MapIcon  className="size-3" /> },
  irrigation:       { label: 'Irrigation',            color: '#00d4ff', icon: <Droplets className="size-3" /> },
  soil:             { label: 'Soil / Zones',          color: '#c8892e', icon: <Sprout   className="size-3" /> },
  drainage:         { label: 'Drainage',              color: '#4d9fff', icon: <Waves    className="size-3" /> },
  imagery:          { label: 'Imagery / Raster',      color: '#a855f7', icon: <ImageIcon className="size-3" /> },
  assets:           { label: 'Assets / POIs',         color: '#ffb020', icon: <Building className="size-3" /> },
  other:            { label: 'Other',                 color: '#8094b4', icon: <FileText className="size-3" /> },
};

interface Props {
  leadId?: string | null;
  onLayersChange?: (layers: GisLayer[]) => void;
}

export function GisLayersCard({ leadId, onLayersChange }: Props) {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [pending, setPending] = useState<File | null>(null);
  const [name,    setName]    = useState('');
  const [kind,    setKind]    = useState<GisKind>('field-boundary');
  const [color,   setColor]   = useState(KIND_CONFIG['field-boundary'].color);
  const [error,   setError]   = useState<string | null>(null);

  const layersQuery = useQuery({
    queryKey: ['gis-layers', leadId ?? 'all'],
    queryFn:  async () => {
      const data = await apiGet<GisLayer[]>(`/gis/layers${leadId ? `?lead_id=${leadId}` : ''}`);
      onLayersChange?.(data);
      return data;
    },
  });

  const uploadMut = useMutation({
    mutationFn: async () => {
      if (!pending) throw new Error('no_file');
      const fd = new FormData();
      fd.append('file', pending);
      fd.append('name', name || pending.name);
      fd.append('kind', kind);
      fd.append('color', color);
      if (leadId) fd.append('lead_id', leadId);
      return apiUpload<GisLayer>('/gis/layers', fd);
    },
    onSuccess: () => {
      setPending(null); setName(''); setError(null);
      qc.invalidateQueries({ queryKey: ['gis-layers'] });
    },
    onError: (e: any) => setError(e?.message ?? 'upload_failed'),
  });

  const toggleMut = useMutation({
    mutationFn: async ({ id, visible }: { id: string; visible: boolean }) =>
      apiPatch<GisLayer>(`/gis/layers/${id}`, { visible }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gis-layers'] }),
  });

  const renameMut = useMutation({
    mutationFn: async ({ id, name, color }: { id: string; name?: string; color?: string }) =>
      apiPatch<GisLayer>(`/gis/layers/${id}`, { name, color }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gis-layers'] }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => apiDel<{ id: string }>(`/gis/layers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gis-layers'] }),
  });

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  }, []);

  function onFile(f: File) {
    setPending(f);
    setName(f.name.replace(/\.(geojson|json|kml|kmz|zip|tif|tiff|pdf|png|jpg|jpeg)$/i, ''));
    // Heuristic kind from filename keywords.
    const lower = f.name.toLowerCase();
    if      (/field|boundary|parcel|plot/.test(lower))   { setKind('field-boundary'); setColor(KIND_CONFIG['field-boundary'].color); }
    else if (/irrig|pivot|sprinkler|water/.test(lower))  { setKind('irrigation');     setColor(KIND_CONFIG.irrigation.color); }
    else if (/soil|zone|nutrient/.test(lower))           { setKind('soil');           setColor(KIND_CONFIG.soil.color); }
    else if (/drain|tile|ditch/.test(lower))             { setKind('drainage');       setColor(KIND_CONFIG.drainage.color); }
    else if (/imagery|ndvi|raster|tif/.test(lower))      { setKind('imagery');        setColor(KIND_CONFIG.imagery.color); }
  }

  const layers = layersQuery.data ?? [];

  return (
    <Card data-coachmark="customer.gis">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-1.5">
            <Layers className="size-3.5" />
            My GIS layers
          </CardTitle>
          <CardDescription>Field boundaries, irrigation, soil zones, imagery — overlay your data on the map</CardDescription>
        </div>
        <Badge variant="outline">{layers.length} {layers.length === 1 ? 'layer' : 'layers'}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* ---- Drop / pick zone ----------------------------------------- */}
        {!pending ? (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInput.current?.click()}
            className={cn(
              'rounded-[var(--radius-lg)] border border-dashed p-5 text-center cursor-pointer',
              'transition-colors duration-[var(--duration-fast)]',
              dragOver
                ? 'border-[var(--accent-strong)] bg-[color-mix(in_oklch,var(--accent)_8%,transparent)]'
                : 'border-[var(--border-strong)] hover:border-[var(--fg)] bg-[var(--surface-sunken)]',
            )}
          >
            <UploadCloud className="size-6 mx-auto text-[var(--fg-muted)] mb-2" />
            <div className="text-[13px] font-medium text-[var(--fg)]">Drop a GIS file here or click to browse</div>
            <div className="text-[11px] text-[var(--fg-muted)] mt-1">
              GeoJSON · Shapefile (.shp.zip) · KML · KMZ · GeoTIFF · PDF · PNG · JPG
            </div>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept=".geojson,.json,.kml,.kmz,.zip,.tif,.tiff,.pdf,.png,.jpg,.jpeg"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            />
          </div>
        ) : (
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-strong)] p-3 space-y-3 bg-[var(--surface-sunken)]">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[13px] font-medium text-[var(--fg)] truncate" title={pending.name}>
                {pending.name}
              </div>
              <div className="text-[11px] font-mono text-[var(--fg-muted)]">{formatBytes(pending.size)}</div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={pending.name} />
              </div>
              <div className="space-y-1">
                <Label>Kind</Label>
                <select
                  className="w-full h-9 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] px-3 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                  value={kind}
                  onChange={(e) => {
                    const k = e.target.value as GisKind;
                    setKind(k);
                    setColor(KIND_CONFIG[k].color);
                  }}
                >
                  {(Object.keys(KIND_CONFIG) as GisKind[]).map((k) => (
                    <option key={k} value={k}>{KIND_CONFIG[k].label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Label className="mb-0">Color</Label>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                aria-label="Layer color"
                className="size-8 rounded-[var(--radius-md)] border border-[var(--border)] cursor-pointer bg-transparent"
              />
              <span className="text-[11px] font-mono text-[var(--fg-muted)]">{color}</span>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-[12px] text-[var(--red)] rounded-[var(--radius-md)] border border-[var(--red)]/40 bg-[color-mix(in_oklch,var(--red)_10%,transparent)] p-2">
                <AlertCircle className="size-3.5 shrink-0" /><span className="truncate">{error}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={() => { setPending(null); setError(null); }}>
                Cancel
              </Button>
              <Button size="sm" disabled={uploadMut.isPending} onClick={() => uploadMut.mutate()}>
                {uploadMut.isPending ? 'Uploading…' : 'Upload + Parse'}
              </Button>
            </div>
          </div>
        )}

        {/* ---- Layer list ----------------------------------------------- */}
        <div className="space-y-1.5">
          {layersQuery.isLoading && (
            <div className="text-[11px] text-[var(--fg-muted)] p-2">Loading layers…</div>
          )}
          {!layersQuery.isLoading && layers.length === 0 && (
            <div className="text-[11px] text-[var(--fg-subtle)] text-center p-3">No layers uploaded yet</div>
          )}
          {layers.map((l) => (
            <LayerRow
              key={l.id}
              layer={l}
              onToggle={(v) => toggleMut.mutate({ id: l.id, visible: v })}
              onRename={(n) => renameMut.mutate({ id: l.id, name: n })}
              onRecolor={(c) => renameMut.mutate({ id: l.id, color: c })}
              onDelete={() => {
                if (confirm(`Delete layer "${l.name}"? This cannot be undone.`)) deleteMut.mutate(l.id);
              }}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// -----------------------------------------------------------------------------
function LayerRow({
  layer, onToggle, onRename, onRecolor, onDelete,
}: {
  layer: GisLayer;
  onToggle: (v: boolean) => void;
  onRename: (n: string) => void;
  onRecolor: (c: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name,    setName]    = useState(layer.name);
  const cfg = KIND_CONFIG[layer.kind];
  return (
    <div className={cn(
      'flex items-center gap-2 p-2 rounded-[var(--radius-md)]',
      'border border-[var(--border)] bg-[var(--surface)]',
      'hover:border-[var(--border-strong)]',
      'transition-colors duration-[var(--duration-fast)]',
      !layer.visible && 'opacity-60',
    )}>
      <button
        type="button"
        onClick={() => onToggle(!layer.visible)}
        aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
        className="size-7 grid place-items-center rounded-[var(--radius-md)] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-sunken)] transition-colors shrink-0"
      >
        {layer.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </button>

      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <input
          type="color"
          value={layer.color}
          onChange={(e) => onRecolor(e.target.value)}
          aria-label="Change color"
          className="size-4 rounded-[var(--radius-sm)] border border-[var(--border)] cursor-pointer bg-transparent shrink-0 p-0"
        />
        <span style={{ color: cfg.color }} aria-hidden="true">{cfg.icon}</span>
        {editing ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { setEditing(false); if (name && name !== layer.name) onRename(name); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { setEditing(false); if (name && name !== layer.name) onRename(name); }
              if (e.key === 'Escape') { setEditing(false); setName(layer.name); }
            }}
            className="text-[12px] flex-1 bg-transparent border-b border-[var(--border-strong)] outline-none text-[var(--fg)]"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-[12px] font-medium text-[var(--fg)] truncate flex-1 text-left hover:text-[var(--accent-strong)] focus-visible:outline-none focus-visible:underline"
          >
            {layer.name}
          </button>
        )}
      </div>

      <Badge
        variant={
          layer.status === 'ready'   ? 'success' :
          layer.status === 'parsing' ? 'soft'    :
                                       'destructive'
        }
        size="sm"
        title={layer.parse_error ?? undefined}
      >
        {layer.status}
      </Badge>
      <span className="text-[10px] font-mono text-[var(--fg-muted)] shrink-0">
        {layer.feature_count > 0 ? `${layer.feature_count}f` : layer.source_format}
      </span>
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete layer"
        className="size-7 grid place-items-center rounded-[var(--radius-md)] text-[var(--fg-muted)] hover:text-[var(--red)] hover:bg-[var(--surface-sunken)] transition-colors shrink-0"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
