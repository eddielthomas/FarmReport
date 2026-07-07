// =============================================================================
// OnboardingCopilot — the guided flow that gets a farm into Report.Farm (Screen C).
// -----------------------------------------------------------------------------
// Five honest steps, wired to the live /api/v1/farm/* API:
//   1. Farm basics  — name, farm types, crops, optional supplier.
//   2. Boundary     — import/paste a Polygon/MultiPolygon (BoundaryImport).
//   3. Parcels      — optional, repeatable sub-boundaries.
//   4. Zones        — repeatable ZoneIntentEditor rows (monitoring intent + geom).
//   5. Review & create — POST the farm, then each parcel and zone; on success
//      show the new farm id + a link to the portfolio. A 422 invalid_geometry is
//      surfaced inline on the step that owns the offending shape.
//
// Style follows PortfolioDashboard: tokens only, tabular-nums, spring hover, and
// honest empty/error states — nothing is fabricated.
// =============================================================================

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Tractor, MapPinned, Grid2x2, Layers, ClipboardCheck, Plus, Check, X,
  ArrowRight, ArrowLeft, Sprout, Building2, PartyPopper, ExternalLink, AlertTriangle, Trash2,
} from 'lucide-react';
import { apiGet, apiPost, ApiError } from '@crm/lib/api';
import { useHasRole } from '@crm/lib/auth-store';
import { Button } from '@crm/components/ui/button';
import { Input, Label } from '@crm/components/ui/input';
import { BoundaryImport, geometryAreaHa } from '@crm/components/farm/BoundaryImport';
import { BoundaryEditorMap } from '@crm/components/farm/BoundaryEditorMap';
import { FindMyFarm } from '@crm/components/farm/FindMyFarm';
import {
  ZoneIntentEditor, newZoneDraft, ZONE_TYPES,
  type ZoneDraft,
} from '@crm/components/farm/ZoneIntentEditor';
import { type SupplierRollup } from '@crm/lib/farm-types';

// ---- presets ----------------------------------------------------------------

const FARM_TYPES = ['cropland', 'orchard', 'vineyard', 'pasture', 'livestock', 'aquaculture', 'greenhouse', 'mixed'];
const CROPS = ['corn', 'soybean', 'wheat', 'rice', 'coffee', 'cocoa', 'sugarcane', 'cotton', 'palm oil', 'citrus', 'grapes', 'almonds', 'barley', 'sorghum'];

interface ParcelDraft { key: string; name: string; geom: GeoJSON.Polygon | null; }
function newParcel(): ParcelDraft {
  return { key: (globalThis.crypto?.randomUUID?.() ?? `p_${Math.random().toString(36).slice(2)}`), name: '', geom: null };
}

const STEPS = [
  { id: 0, label: 'Farm basics', icon: Tractor },
  { id: 1, label: 'Boundary',    icon: MapPinned },
  { id: 2, label: 'Parcels',     icon: Grid2x2 },
  { id: 3, label: 'Zones',       icon: Layers },
  { id: 4, label: 'Review',      icon: ClipboardCheck },
] as const;

// ---- reusable bits ----------------------------------------------------------

function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-5 ${className}`}>
      {children}
    </div>
  );
}

function SectionHead({ icon, title, right }: { icon: React.ReactNode; title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2 text-[13px] font-semibold tracking-[var(--tracking-wide)] uppercase text-[var(--fg-muted)]">
        <span className="text-[var(--accent)]">{icon}</span>{title}
      </div>
      {right}
    </div>
  );
}

function ChipMultiSelect({ options, selected, onToggle, onAdd, placeholder }: {
  options: string[]; selected: string[]; onToggle: (v: string) => void; onAdd: (v: string) => void; placeholder: string;
}) {
  const [custom, setCustom] = React.useState('');
  const all = React.useMemo(() => Array.from(new Set([...options, ...selected])), [options, selected]);
  const commit = () => {
    const v = custom.trim().toLowerCase();
    if (v) { onAdd(v); setCustom(''); }
  };
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {all.map((o) => {
          const on = selected.includes(o);
          return (
            <button
              key={o}
              type="button"
              onClick={() => onToggle(o)}
              className={
                'inline-flex items-center gap-1 rounded-[var(--radius-full)] px-3 py-1 text-[12px] font-medium capitalize transition-colors duration-[var(--duration-fast)] ' +
                (on
                  ? 'bg-[var(--accent)] text-[var(--fg-on-accent)]'
                  : 'bg-[var(--surface-sunken)] text-[var(--fg-muted)] hover:text-[var(--fg)]')
              }
            >
              {on && <Check className="size-3" />}{o}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
          placeholder={placeholder}
          className="h-8 max-w-[240px] text-[12px]"
        />
        <Button type="button" variant="ghost" size="sm" onClick={commit} disabled={!custom.trim()}>
          <Plus className="size-3.5" /> Add
        </Button>
      </div>
    </div>
  );
}

// ---- main -------------------------------------------------------------------

interface CreateResult { farmId: string; parcels: number; zones: number; }

export function OnboardingCopilot() {
  // Onboarding writes a farm (POST /farm/farms → farm.profile.write). Watch-only
  // roles (Portfolio Lead, Grower) hold farm:view but NOT farm:onboard, so the
  // server rejects their create with 403. Gate the whole flow up front so they
  // get an honest message instead of filling out the wizard only to hit a wall
  // on the final step. Buyer Admin + Farm Operations (and platform admins) pass.
  const canOnboard = useHasRole('farm:onboard');

  const [step, setStep] = React.useState(0);

  // form state
  const [name, setName] = React.useState('');
  const [farmTypes, setFarmTypes] = React.useState<string[]>([]);
  const [crops, setCrops] = React.useState<string[]>([]);
  const [supplierId, setSupplierId] = React.useState<string>('');
  const [boundary, setBoundary] = React.useState<GeoJSON.Polygon | GeoJSON.MultiPolygon | null>(null);
  const [parcels, setParcels] = React.useState<ParcelDraft[]>([]);
  const [zones, setZones] = React.useState<ZoneDraft[]>([]);
  const timezone = React.useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
  }, []);

  // create state
  const [creating, setCreating] = React.useState(false);
  const [result, setResult] = React.useState<CreateResult | null>(null);
  const [boundaryError, setBoundaryError] = React.useState<string | null>(null);
  const [zoneErrors, setZoneErrors] = React.useState<Record<string, string>>({});
  const [createError, setCreateError] = React.useState<string | null>(null);
  // If the farm POST succeeds but a child fails, we surface the partial state.
  const [partialFarmId, setPartialFarmId] = React.useState<string | null>(null);

  // Optional supplier picker — real portfolio suppliers, if any exist.
  const suppliers = useQuery({
    queryKey: ['farm', 'suppliers', 'onboard'],
    queryFn: () => apiGet<SupplierRollup[]>('/farm/portfolio/suppliers'),
  });

  const toggle = (set: React.Dispatch<React.SetStateAction<string[]>>) => (v: string) =>
    set((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
  const add = (set: React.Dispatch<React.SetStateAction<string[]>>) => (v: string) =>
    set((cur) => (cur.includes(v) ? cur : [...cur, v]));

  const nameOk = name.trim().length > 0;
  const canProceed = (s: number): boolean => {
    if (s === 0) return nameOk && farmTypes.length > 0;
    if (s === 1) return boundary != null;
    return true; // parcels & zones are optional
  };
  const readyToCreate = nameOk && farmTypes.length > 0 && boundary != null;

  const goNext = () => setStep((s) => Math.min(4, s + 1));
  const goBack = () => setStep((s) => Math.max(0, s - 1));

  // ---- create -----------------------------------------------------------------
  const handleCreate = async () => {
    setCreating(true);
    setCreateError(null); setBoundaryError(null); setZoneErrors({}); setPartialFarmId(null);
    try {
      const farm = await apiPost<{ id: string }>('/farm/farms', {
        name: name.trim(),
        farmTypes,
        crops,
        boundaries: boundary,
        timezone,
        ...(supplierId ? { supplier_id: supplierId } : {}),
      });
      setPartialFarmId(farm.id);

      // Parcels — keep a draft-key → server-id map so zones can attach.
      const parcelIdByKey: Record<string, string> = {};
      let parcelCount = 0;
      for (const p of parcels) {
        if (!p.geom) continue;
        const created = await apiPost<{ id: string }>(`/farm/farms/${farm.id}/parcels`, {
          name: p.name.trim() || 'Parcel',
          geom: p.geom,
        });
        parcelIdByKey[p.key] = created.id;
        parcelCount++;
      }

      // Zones — with intent JSON + optional resolved parcel id.
      let zoneCount = 0;
      for (const z of zones) {
        if (!z.geom) continue;
        await apiPost(`/farm/farms/${farm.id}/zones`, {
          name: z.name.trim() || 'Zone',
          type: z.type,
          intent: z.intent,
          geom: z.geom,
          ...(z.parcel_id && parcelIdByKey[z.parcel_id] ? { parcel_id: parcelIdByKey[z.parcel_id] } : {}),
        });
        zoneCount++;
      }

      setResult({ farmId: farm.id, parcels: parcelCount, zones: zoneCount });
    } catch (e) {
      handleCreateError(e);
    } finally {
      setCreating(false);
    }
  };

  const handleCreateError = (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.status === 422 && (e.message === 'invalid_geometry' || /geometry/i.test(e.message))) {
        // The farm boundary is the most common offender when no child was reached.
        if (!partialFarmId) {
          setBoundaryError('This boundary is not a valid polygon (self-intersecting or unclosed). Fix the shape and try again.');
          setStep(1);
          return;
        }
        setCreateError('A parcel or zone boundary is not a valid polygon (self-intersecting). Review the offending shape on the Parcels or Zones step.');
        setStep(3);
        return;
      }
      // Permission / session problems return 403 (missing_permission:*) or 401.
      // The raw key is meaningless to a user — usually it means the signed-in
      // session predates a role change and no longer carries farm:onboard, or the
      // account simply isn't an operator. Give an actionable message either way.
      if (e.status === 403 || e.status === 401 || /permission|forbidden|unauthorized/i.test(e.message)) {
        setCreateError(
          'Your session can\'t register a farm — this account isn\'t an operator, or your sign-in predates a recent permission change. ' +
          'Sign out and back in, or use a Buyer Admin / Farm Operations account, then try again.',
        );
        return;
      }
      setCreateError(`Couldn't create the farm: ${e.message}${e.detail ? ` — ${e.detail}` : ''}`);
      return;
    }
    setCreateError(e instanceof Error ? e.message : 'Something went wrong creating the farm.');
  };

  const supplierName = suppliers.data?.find((s) => s.supplier_id === supplierId)?.supplier_name;

  // ---- permission gate --------------------------------------------------------
  // Watch-only roles can reach this URL but cannot create a farm — surface that
  // honestly instead of a dead-end 403 on the final step.
  if (!canOnboard) {
    return (
      <div className="crm h-full overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
        <div className="mx-auto max-w-[560px] px-5 sm:px-8 py-20">
          <Panel className="text-center">
            <div className="mx-auto grid size-14 place-items-center rounded-[var(--radius-full)] bg-[var(--surface-sunken)] text-[var(--fg-subtle)]">
              <Tractor className="size-7" />
            </div>
            <h1 className="mt-4 text-[22px] font-semibold font-[var(--font-display)] tracking-[var(--tracking-tight)]">
              Onboarding needs an operator role
            </h1>
            <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
              Adding a farm to the portfolio is done by a <strong>Buyer Admin</strong> or
              {' '}<strong>Farm Operations</strong> user. Your role can view the portfolio and
              its reports, but not register new farms. Ask an admin to onboard the farm — or sign
              in with an operator account.
            </p>
            <div className="mt-6">
              <Button asChild variant="accent" size="lg">
                <a href="/operations.html">Back to portfolio <ArrowRight className="size-4" /></a>
              </Button>
            </div>
          </Panel>
        </div>
      </div>
    );
  }

  // ---- success screen ---------------------------------------------------------
  if (result) {
    return (
      <div className="crm h-full overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
        <div className="mx-auto max-w-[720px] px-5 sm:px-8 py-16">
          <Panel className="text-center">
            <div className="mx-auto grid size-14 place-items-center rounded-[var(--radius-full)] bg-[color-mix(in_oklch,var(--risk-healthy-fill)_18%,transparent)] text-[var(--risk-healthy)]">
              <PartyPopper className="size-7" />
            </div>
            <h1 className="mt-4 text-[24px] font-semibold font-[var(--font-display)] tracking-[var(--tracking-tight)]">
              {name.trim()} is now under monitoring
            </h1>
            <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
              The farm boundary is registered. Risk and yield signals populate as the AlphaGeo satellite
              connection ingests the first pass over this AOI.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[13px] tabular-nums text-[var(--fg-muted)]">
              <span>Farm ID <span className="font-[var(--font-mono)] text-[var(--fg)]">{result.farmId}</span></span>
              <span>{result.parcels} parcel{result.parcels === 1 ? '' : 's'}</span>
              <span>{result.zones} zone{result.zones === 1 ? '' : 's'}</span>
            </div>
            <div className="mt-6 flex items-center justify-center gap-3">
              <Button asChild variant="accent" size="lg">
                <a href="/operations.html">View on portfolio <ExternalLink className="size-4" /></a>
              </Button>
            </div>
          </Panel>
        </div>
      </div>
    );
  }

  // ---- wizard -----------------------------------------------------------------
  return (
    <div className="crm h-full overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8 py-6">
        {/* header */}
        <header className="mb-6">
          <div className="text-[11px] uppercase tracking-[var(--tracking-widest)] text-[var(--fg-subtle)]">Onboarding Copilot</div>
          <h1 className="text-[26px] sm:text-[30px] font-semibold tracking-[var(--tracking-tight)] font-[var(--font-display)]">
            Add a farm to your portfolio
          </h1>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-6">
          {/* step rail */}
          <nav aria-label="Onboarding steps" className="lg:sticky lg:top-6 self-start">
            <ol className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible">
              {STEPS.map((s) => {
                const done = s.id < step && canProceed(s.id);
                const active = s.id === step;
                const reachable = s.id <= step || canProceed(step);
                const Icon = s.icon;
                return (
                  <li key={s.id} className="shrink-0">
                    <button
                      type="button"
                      onClick={() => { if (s.id <= step || reachable) setStep(s.id); }}
                      aria-current={active ? 'step' : undefined}
                      className={
                        'flex w-full items-center gap-3 rounded-[var(--radius-lg)] px-3 py-2.5 text-left transition-colors duration-[var(--duration-fast)] ' +
                        (active
                          ? 'bg-[color-mix(in_oklch,var(--accent)_12%,transparent)] text-[var(--fg)]'
                          : 'text-[var(--fg-muted)] hover:bg-[var(--surface-sunken)]/60')
                      }
                    >
                      <span className={
                        'grid size-7 shrink-0 place-items-center rounded-[var(--radius-full)] text-[12px] font-semibold tabular-nums transition-colors ' +
                        (active ? 'bg-[var(--accent)] text-[var(--fg-on-accent)]'
                          : done ? 'bg-[color-mix(in_oklch,var(--risk-healthy-fill)_20%,transparent)] text-[var(--risk-healthy)]'
                          : 'bg-[var(--surface-sunken)] text-[var(--fg-subtle)]')
                      }>
                        {done ? <Check className="size-3.5" /> : <Icon className="size-3.5" />}
                      </span>
                      <span className="text-[13px] font-medium whitespace-nowrap">{s.label}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          {/* step body */}
          <div className="min-w-0 space-y-6">
            {/* STEP 1 — basics */}
            {step === 0 && (
              <Panel>
                <SectionHead icon={<Tractor className="size-4" />} title="Farm basics" />
                <div className="space-y-5">
                  <div className="space-y-1.5">
                    <Label htmlFor="farm-name">Farm name</Label>
                    <Input id="farm-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. North Valley Farms" className="max-w-[420px]" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Farm types <span className="normal-case text-[var(--fg-subtle)]">· at least one</span></Label>
                    <ChipMultiSelect options={FARM_TYPES} selected={farmTypes} onToggle={toggle(setFarmTypes)} onAdd={add(setFarmTypes)} placeholder="Add a type…" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Crops <span className="normal-case text-[var(--fg-subtle)]">· optional</span></Label>
                    <ChipMultiSelect options={CROPS} selected={crops} onToggle={toggle(setCrops)} onAdd={add(setCrops)} placeholder="Add a crop…" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="supplier" className="inline-flex items-center gap-1.5"><Building2 className="size-3.5 text-[var(--accent)]" /> Supplier <span className="normal-case text-[var(--fg-subtle)]">· optional</span></Label>
                    <select
                      id="supplier"
                      value={supplierId}
                      onChange={(e) => setSupplierId(e.target.value)}
                      className="h-9 w-full max-w-[420px] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
                    >
                      <option value="">No supplier — direct</option>
                      {suppliers.data?.map((s) => <option key={s.supplier_id} value={s.supplier_id}>{s.supplier_name}</option>)}
                    </select>
                    {suppliers.isLoading && <p className="text-[11px] text-[var(--fg-subtle)]">Loading suppliers…</p>}
                  </div>
                </div>
              </Panel>
            )}

            {/* STEP 2 — boundary */}
            {step === 1 && (
              <Panel>
                <SectionHead icon={<MapPinned className="size-4" />} title="Farm boundary" />
                <p className="mb-4 text-[13px] text-[var(--fg-muted)]">
                  Find your farm by address or pin — or import a boundary file / paste GeoJSON. Then
                  fine-tune it exactly on the map below: drag vertices, add or delete points, or redraw.
                </p>
                <FindMyFarm className="mb-4" onParcel={(b) => { setBoundary(b); setBoundaryError(null); }} />
                {/* Editable satellite surface — correct the AI auto-trace / imported shape precisely. */}
                <BoundaryEditorMap value={boundary} onChange={(b) => { setBoundary(b); setBoundaryError(null); }} height={460} className="mb-4" />
                <BoundaryImport value={boundary} onGeometry={setBoundary} error={boundaryError} hidePreview />
              </Panel>
            )}

            {/* STEP 3 — parcels */}
            {step === 2 && (
              <Panel>
                <SectionHead
                  icon={<Grid2x2 className="size-4" />} title="Parcels"
                  right={<Button type="button" variant="secondary" size="sm" onClick={() => setParcels((p) => [...p, newParcel()])}><Plus className="size-3.5" /> Add parcel</Button>}
                />
                <p className="mb-4 text-[13px] text-[var(--fg-muted)]">
                  Optional. Split the farm into legal or management parcels — each a single Polygon.
                  You can skip this and add parcels later.
                </p>
                {parcels.length === 0 ? (
                  <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-sunken)]/40 px-4 py-8 text-center text-[13px] text-[var(--fg-muted)]">
                    No parcels yet. Add one, or continue to zones.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {parcels.map((p, i) => (
                      <div key={p.key} className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex-1 space-y-1.5">
                            <Label htmlFor={`parcel-${p.key}`}>Parcel {i + 1} name</Label>
                            <Input
                              id={`parcel-${p.key}`}
                              value={p.name}
                              onChange={(e) => setParcels((cur) => cur.map((x) => x.key === p.key ? { ...x, name: e.target.value } : x))}
                              placeholder="e.g. North 40"
                              className="max-w-[360px]"
                            />
                          </div>
                          <button type="button" onClick={() => setParcels((cur) => cur.filter((x) => x.key !== p.key))} className="inline-flex items-center gap-1 text-[12px] text-[var(--fg-muted)] hover:text-[var(--risk-critical)] transition-colors">
                            <Trash2 className="size-3.5" /> Remove
                          </button>
                        </div>
                        <BoundaryImport
                          polygonOnly
                          value={p.geom}
                          onGeometry={(g) => setParcels((cur) => cur.map((x) => x.key === p.key ? { ...x, geom: g as GeoJSON.Polygon | null } : x))}
                          height={180}
                          compact
                        />
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            )}

            {/* STEP 4 — zones */}
            {step === 3 && (
              <Panel>
                <SectionHead
                  icon={<Layers className="size-4" />} title="Monitoring zones"
                  right={<Button type="button" variant="secondary" size="sm" onClick={() => setZones((z) => [...z, newZoneDraft()])}><Plus className="size-3.5" /> Add zone</Button>}
                />
                <p className="mb-4 text-[13px] text-[var(--fg-muted)]">
                  Zones tell the pipeline how to read change: a barn shouldn't green up, a wetland is
                  supposed to hold water. Set each zone's intent so alerts stay meaningful.
                </p>
                {zones.length === 0 ? (
                  <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-sunken)]/40 px-4 py-8 text-center text-[13px] text-[var(--fg-muted)]">
                    No zones yet. Add a zone to capture per-area monitoring intent, or continue to review.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {zones.map((z, i) => (
                      <ZoneIntentEditor
                        key={z.key}
                        zone={z}
                        index={i}
                        parcels={parcels.filter((p) => p.geom).map((p) => ({ id: p.key, name: p.name || `Parcel ${parcels.indexOf(p) + 1}` }))}
                        geomError={zoneErrors[z.key] ?? null}
                        onChange={(next) => setZones((cur) => cur.map((x) => x.key === z.key ? next : x))}
                        onRemove={() => setZones((cur) => cur.filter((x) => x.key !== z.key))}
                      />
                    ))}
                  </div>
                )}
              </Panel>
            )}

            {/* STEP 5 — review */}
            {step === 4 && (
              <Panel>
                <SectionHead icon={<ClipboardCheck className="size-4" />} title="Review & create" />
                <dl className="divide-y divide-[var(--border)] text-[13px]">
                  <ReviewRow label="Farm name" value={name.trim() || <Missing>required</Missing>} />
                  <ReviewRow label="Farm types" value={farmTypes.length ? <ChipRow items={farmTypes} /> : <Missing>at least one required</Missing>} />
                  <ReviewRow label="Crops" value={crops.length ? <ChipRow items={crops} /> : <span className="text-[var(--fg-subtle)]">none</span>} />
                  <ReviewRow label="Supplier" value={supplierName ?? <span className="text-[var(--fg-subtle)]">Direct (no supplier)</span>} />
                  <ReviewRow
                    label="Boundary"
                    value={boundary
                      ? <span className="inline-flex items-center gap-2 tabular-nums"><Sprout className="size-4 text-[var(--risk-healthy)]" />{geometryAreaHa(boundary).toLocaleString(undefined, { maximumFractionDigits: 1 })} ha · {boundary.type}</span>
                      : <Missing>required — go to Boundary step</Missing>}
                  />
                  <ReviewRow label="Parcels" value={<span className="tabular-nums">{parcels.filter((p) => p.geom).length} with geometry / {parcels.length} added</span>} />
                  <ReviewRow
                    label="Zones"
                    value={
                      zones.filter((z) => z.geom).length === 0
                        ? <span className="text-[var(--fg-subtle)]">none</span>
                        : <ul className="space-y-1">
                            {zones.filter((z) => z.geom).map((z) => {
                              const t = ZONE_TYPES.find((x) => x.value === z.type)?.label ?? z.type;
                              return <li key={z.key} className="flex items-center gap-2">
                                <span className="font-medium text-[var(--fg)]">{z.name.trim() || 'Unnamed'}</span>
                                <span className="text-[var(--fg-subtle)]">{t}</span>
                                <span className="tabular-nums text-[var(--fg-subtle)]">{geometryAreaHa(z.geom!).toLocaleString(undefined, { maximumFractionDigits: 1 })} ha</span>
                              </li>;
                            })}
                          </ul>
                    }
                  />
                </dl>

                {createError && (
                  <div className="mt-4 flex items-start gap-2 rounded-[var(--radius-md)] border border-[color-mix(in_oklch,var(--risk-critical)_40%,transparent)] bg-[color-mix(in_oklch,var(--risk-critical-fill)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--risk-critical)]">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>{createError}{partialFarmId && <> The farm itself was created (ID <span className="font-[var(--font-mono)]">{partialFarmId}</span>); re-running will not duplicate it — remove already-created children first.</>}</span>
                  </div>
                )}

                <div className="mt-5 flex items-center gap-3">
                  <Button type="button" variant="accent" size="lg" onClick={handleCreate} disabled={!readyToCreate || creating}>
                    {creating ? 'Creating…' : <>Create farm <Check className="size-4" /></>}
                  </Button>
                  {!readyToCreate && <span className="text-[12px] text-[var(--fg-muted)]">A name, at least one farm type, and a boundary are required.</span>}
                </div>
              </Panel>
            )}

            {/* footer nav */}
            <div className="flex items-center justify-between">
              <Button type="button" variant="ghost" onClick={goBack} disabled={step === 0}>
                <ArrowLeft className="size-4" /> Back
              </Button>
              {step < 4 && (
                <Button type="button" variant="accent" onClick={goNext} disabled={!canProceed(step)}>
                  Next <ArrowRight className="size-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- review helpers ---------------------------------------------------------

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-4 py-3">
      <dt className="text-[11px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-subtle)] pt-0.5">{label}</dt>
      <dd className="text-[var(--fg)]">{value}</dd>
    </div>
  );
}
function ChipRow({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => <span key={i} className="rounded-[var(--radius-full)] bg-[var(--surface-sunken)] px-2 py-0.5 text-[11px] capitalize text-[var(--fg-muted)]">{i}</span>)}
    </div>
  );
}
function Missing({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1 text-[var(--risk-stress)]"><X className="size-3.5" />{children}</span>;
}
