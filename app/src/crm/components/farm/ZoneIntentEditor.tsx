// =============================================================================
// ZoneIntentEditor — one monitoring zone with its watching intent + geometry.
// -----------------------------------------------------------------------------
// A zone tells the pipeline *how to read change* on a piece of ground: a barn
// isn't a field, a wetland is *supposed* to hold standing water. This editor
// captures that intent as a small JSON contract plus a Polygon boundary and
// emits a ZoneDraft up to the onboarding flow.
//
// The intent shape maps to the /api/v1/farm/farms/:id/zones {intent: JSON}
// payload. Geometry is captured with the same BoundaryImport control used for
// the farm boundary (polygonOnly — zones are single Polygons).
// =============================================================================

import * as React from 'react';
import { Droplets, Waves, Sprout, BellRing, Trash2, MapPinned } from 'lucide-react';
import { cn } from '@crm/lib/utils';
import { Input, Label } from '@crm/components/ui/input';
import { BoundaryImport } from '@crm/components/farm/BoundaryImport';

// ---- Zone contract (local domain types — reused by OnboardingCopilot) -------

export type ZoneType = 'irrigation-zone' | 'barn' | 'wetland' | 'field' | 'test-plot';
export type Priority = 'low' | 'med' | 'high';

export interface ZoneIntent {
  expectedWaterFlow: boolean;
  standingWaterAllowed: boolean;
  vegetationPriority: Priority;
  alertSensitivity: Priority;
}

export interface ZoneDraft {
  /** Client-side id for list reconciliation (not sent to the API). */
  key: string;
  name: string;
  type: ZoneType;
  intent: ZoneIntent;
  geom: GeoJSON.Polygon | null;
  parcel_id?: string;
}

export const ZONE_TYPES: { value: ZoneType; label: string }[] = [
  { value: 'field',           label: 'Crop field' },
  { value: 'irrigation-zone', label: 'Irrigation zone' },
  { value: 'barn',            label: 'Barn / structure' },
  { value: 'wetland',         label: 'Wetland / pond' },
  { value: 'test-plot',       label: 'Test plot' },
];

const PRIORITIES: Priority[] = ['low', 'med', 'high'];

/** A sensible default intent per zone type — barns don't irrigate, wetlands
 *  are meant to hold water, test plots watch closely. */
export function defaultIntentFor(type: ZoneType): ZoneIntent {
  switch (type) {
    case 'barn':            return { expectedWaterFlow: false, standingWaterAllowed: false, vegetationPriority: 'low',  alertSensitivity: 'med' };
    case 'wetland':         return { expectedWaterFlow: true,  standingWaterAllowed: true,  vegetationPriority: 'med',  alertSensitivity: 'low' };
    case 'irrigation-zone': return { expectedWaterFlow: true,  standingWaterAllowed: false, vegetationPriority: 'high', alertSensitivity: 'high' };
    case 'test-plot':       return { expectedWaterFlow: true,  standingWaterAllowed: false, vegetationPriority: 'high', alertSensitivity: 'high' };
    case 'field':
    default:                return { expectedWaterFlow: true,  standingWaterAllowed: false, vegetationPriority: 'high', alertSensitivity: 'med' };
  }
}

export function newZoneDraft(type: ZoneType = 'field'): ZoneDraft {
  return {
    key: (globalThis.crypto?.randomUUID?.() ?? `z_${Math.random().toString(36).slice(2)}`),
    name: '',
    type,
    intent: defaultIntentFor(type),
    geom: null,
  };
}

// ---- Small controls ---------------------------------------------------------

function Toggle({ checked, onChange, on, off, icon }: {
  checked: boolean; onChange: (v: boolean) => void; on: string; off: string; icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex items-center gap-2 rounded-[var(--radius-md)] border px-3 py-1.5 text-[12px] font-medium',
        'transition-colors duration-[var(--duration-fast)]',
        checked
          ? 'border-[color-mix(in_oklch,var(--accent)_45%,transparent)] bg-[color-mix(in_oklch,var(--accent)_12%,transparent)] text-[var(--accent-strong)]'
          : 'border-[var(--border)] bg-[var(--surface-sunken)]/50 text-[var(--fg-muted)] hover:text-[var(--fg)]',
      )}
    >
      <span className={cn(checked ? 'text-[var(--accent)]' : 'text-[var(--fg-subtle)]')}>{icon}</span>
      {checked ? on : off}
    </button>
  );
}

function Segmented({ value, onChange, label, icon }: {
  value: Priority; onChange: (v: Priority) => void; label: string; icon: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="inline-flex items-center gap-1.5"><span className="text-[var(--accent)]">{icon}</span>{label}</Label>
      <div className="inline-flex rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-0.5">
        {PRIORITIES.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            aria-pressed={value === p}
            className={cn(
              'rounded-[calc(var(--radius-md)-2px)] px-3 py-1 text-[12px] font-medium capitalize transition-colors duration-[var(--duration-fast)]',
              value === p ? 'bg-[var(--surface)] text-[var(--fg)] shadow-[var(--shadow-soft)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg)]',
            )}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- Editor -----------------------------------------------------------------

export interface ZoneIntentEditorProps {
  zone: ZoneDraft;
  index: number;
  onChange: (next: ZoneDraft) => void;
  onRemove: () => void;
  /** Optional parcels to attach a zone to (name-only chips). */
  parcels?: { id: string; name: string }[];
  /** External geometry error (e.g. a per-zone 422 from the API). */
  geomError?: string | null;
}

export function ZoneIntentEditor({ zone, index, onChange, onRemove, parcels, geomError }: ZoneIntentEditorProps) {
  const set = <K extends keyof ZoneDraft>(k: K, v: ZoneDraft[K]) => onChange({ ...zone, [k]: v });
  const setIntent = <K extends keyof ZoneIntent>(k: K, v: ZoneIntent[K]) => onChange({ ...zone, intent: { ...zone.intent, [k]: v } });

  return (
    <div className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--fg)]">
          <span className="grid size-6 place-items-center rounded-[var(--radius-full)] bg-[color-mix(in_oklch,var(--accent)_14%,transparent)] text-[11px] tabular-nums text-[var(--accent-strong)]">{index + 1}</span>
          Zone {index + 1}
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex items-center gap-1 text-[12px] text-[var(--fg-muted)] hover:text-[var(--risk-critical)] transition-colors"
        >
          <Trash2 className="size-3.5" /> Remove
        </button>
      </div>

      {/* Name + type */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`zone-name-${zone.key}`}>Zone name</Label>
          <Input
            id={`zone-name-${zone.key}`}
            value={zone.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="e.g. West Pivot Field"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`zone-type-${zone.key}`}>Zone type</Label>
          <select
            id={`zone-type-${zone.key}`}
            value={zone.type}
            onChange={(e) => {
              const type = e.target.value as ZoneType;
              // Re-seed intent defaults for the new type but keep any geometry/name.
              onChange({ ...zone, type, intent: defaultIntentFor(type) });
            }}
            className="h-9 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
          >
            {ZONE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
      </div>

      {/* Intent */}
      <div className="space-y-3">
        <div className="text-[11px] font-medium uppercase tracking-[var(--tracking-wide)] text-[var(--fg-subtle)]">Monitoring intent</div>
        <div className="flex flex-wrap gap-2">
          <Toggle
            checked={zone.intent.expectedWaterFlow}
            onChange={(v) => setIntent('expectedWaterFlow', v)}
            on="Expects irrigation" off="No irrigation expected"
            icon={<Droplets className="size-3.5" />}
          />
          <Toggle
            checked={zone.intent.standingWaterAllowed}
            onChange={(v) => setIntent('standingWaterAllowed', v)}
            on="Standing water OK" off="Standing water flags"
            icon={<Waves className="size-3.5" />}
          />
        </div>
        <div className="flex flex-wrap gap-6">
          <Segmented value={zone.intent.vegetationPriority} onChange={(v) => setIntent('vegetationPriority', v)} label="Vegetation priority" icon={<Sprout className="size-3.5" />} />
          <Segmented value={zone.intent.alertSensitivity} onChange={(v) => setIntent('alertSensitivity', v)} label="Alert sensitivity" icon={<BellRing className="size-3.5" />} />
        </div>
      </div>

      {/* Optional parcel attachment */}
      {parcels && parcels.length > 0 && (
        <div className="space-y-1.5">
          <Label>Belongs to parcel <span className="normal-case text-[var(--fg-subtle)]">(optional)</span></Label>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => set('parcel_id', undefined)}
              className={cn(
                'rounded-[var(--radius-full)] px-2.5 py-1 text-[11px] font-medium transition-colors',
                zone.parcel_id == null ? 'bg-[var(--accent)] text-[var(--fg-on-accent)]' : 'bg-[var(--surface-sunken)] text-[var(--fg-muted)] hover:text-[var(--fg)]',
              )}
            >
              None
            </button>
            {parcels.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => set('parcel_id', p.id)}
                className={cn(
                  'rounded-[var(--radius-full)] px-2.5 py-1 text-[11px] font-medium transition-colors',
                  zone.parcel_id === p.id ? 'bg-[var(--accent)] text-[var(--fg-on-accent)]' : 'bg-[var(--surface-sunken)] text-[var(--fg-muted)] hover:text-[var(--fg)]',
                )}
              >
                {p.name || 'Unnamed'}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Geometry */}
      <div className="space-y-1.5">
        <Label className="inline-flex items-center gap-1.5"><MapPinned className="size-3.5 text-[var(--accent)]" /> Zone boundary</Label>
        <BoundaryImport
          polygonOnly
          value={zone.geom}
          onGeometry={(g) => set('geom', g as GeoJSON.Polygon | null)}
          height={180}
          compact
          error={geomError}
        />
      </div>
    </div>
  );
}
