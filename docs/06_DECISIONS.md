# 06 — Session Decisions Overlay (reconciliation)

> **What this is.** The docs `00`–`05` (+ `BOOTSTRAP.md`) are the **canonical execution plan**, authored by the gateway agent against the *actual deployed* RWR + AlphaGeo code. This doc is a thin **overlay**: it records four product/architecture decisions made with the user in a later planning session and states, for each, whether it **agrees with**, **extends**, or **supersedes** the canonical docs. Where it extends/supersedes, the change is spelled out concretely so `03`/`04` can absorb it. Nothing here reopens the grounded mechanics in `00`–`05`.
>
> An earlier version of this session also produced three docs (`architecture.md`, `integration.md`, `roadmap.md`). They were **retired** — the gateway agent's set is better grounded (notably: it uses the deployed `/api/farm/*` harvest-relay pattern, not the `/v1/*` control plane, which is flag-gated OFF by default). This overlay preserves the only parts of that work that add signal: the four decisions below.

---

## D1 — Thin vertical (delegate ALL EO/ML to AlphaGeo) — **AGREES**

Report.Farm builds no Earth-observation or ML analytics; it consumes AlphaGeo's via the `/api/farm/*` relay and turns results into domain Observations/Signals/Alerts/Reports. This is already the canonical stance (`02 §2`, `03 §5`). No change. It also means the spec's from-scratch Kafka/Fusion/Reasoning engines are **not** built in the app tier.

## D2 — First wedge: supply-chain / major buyers — **EXTENDS `03` + `04`**

Canonical `04` is farmer-first and single-farm (P2 = one farm's first NDVI signal). The wedge decision keeps that substrate — you need clone → data model → first real signal regardless — but **re-targets the value layer built on top** at *major buyers monitoring a portfolio of suppliers*. This is additive, not a rewrite:

**Data-model additions (new migrations, continuing the `03` 200-band):**

| File | Adds | Notes |
|---|---|---|
| `206_farm_supplychain.sql` | `farm.buyer` (or reuse `iam.tenant` as the buyer), `farm.supplier`, `farm.sourcing_region` | Supplier is an org in a buyer's network; a `farm.farm_profile` belongs to a supplier. Reuses RWR's org-hierarchy spine. |
| `207_farm_rollup.sql` | `farm.risk_score`, `farm.yield_at_risk`, `farm.disruption_alert` + rollup views supplier → region → buyer | Mirrors RWR's `analytics.rollup` / `org/rollup.mjs` / `org/drilldown.mjs` — the reason this wedge is cheap. |
| `210_farm_rls.sql` (extend) | RLS policies for the new tables | Same tenant-iso pattern as every `farm.*` table. |

`farm.farm_profile` gains a nullable `supplier_id UUID REFERENCES farm.supplier(id)`.

**Workstream reprioritization (adjust `04`):**
- P1 also lands **bulk supplier onboarding** (shapefile/KML/CSV import of many boundaries — RWR's `shpjs`/`@tmcw/togeojson` already there). The single-farm onboarding copilot is unchanged; bulk is the buyer path.
- **New P3.5 — Supply-chain rollups & portfolio:** aggregate signals into `risk_score`/`yield_at_risk` at supplier → region → buyer; buyer **portfolio dashboard** + **executive report** (aggregate risk, revenue-at-risk); buyer-level `disruption_alert` ("X% of Region Y sourcing at yield risk"). Reuses the org-rollup engine.
- Farmer/landowner self-serve stays a **later** superset — the per-field primitives are identical, so nothing is thrown away.

## D3 — Event backbone: Redis Streams push + Postgres outbox — **EXTENDS `02`/`04` (DECIDED)**

Two parts, both adopted from day one:

- **Postgres transactional outbox** for the app's *internal* fan-out (observation → derived signal → alert → report → notify): entirely app-side, replayable, ordered, spec-compatible event names.
- **Core→app result notification via Redis Streams push** (**user decision: from day one, not deferred**). Core pushes a change event the moment a scene is processed; the app reacts immediately instead of polling. This **supersedes** the canonical background-ingest polling (`02 §5.2`, `05 §8b`) as the *primary* freshness mechanism. The harvest-relay SSE (`02 §3.2`) stays for *interactive* scans (user clicks "analyze" → live progress). Background-ingest polling is retained only as a **fallback/backfill** for AOIs that missed an event (e.g. app downtime).

**What this adds to the canonical plan:**
- **P2 (`04`) gains an infra + contract task:** stand up the Core→app Redis Streams channel and the app-side consumer. Wire it through the deployment-agnostic `ChangeEventSource` (see D4) so co-located and remote share one consumer.
- **`02` gains a push path** alongside the relay: the app subscribes to a Core change stream (co-located) or receives Core `notifier/webhook` posts (remote), then pulls the result via `signals-by-bbox` / job status and runs the same `upsertObservations` ingest core. The relay/ingest code is unchanged downstream of the trigger — only the *trigger* changes from timer to event.
- **Event names** stay spec-compatible (`ingest.normalized.observation.v1`, `signal.derived.v1`, `alert.created.v1`, …) so a later Kafka swap is transport-only.

## D4 — Deployment-agnostic (co-located OR remote) — **EXTENDS `02`/`05`**

Canonical `05 §8` assumes co-located (`docker cp` the router to the box, shared `ALPHAGEO_HARVEST_TOKEN`, nginx IP-gate). Keep that as the default. The two cross-tier channels are (a) the `/api/farm/*` HTTP relay and (b) Redis Streams result notification:
- **HTTP relay** works either way — co-located hits the gateway on the internal network; remote hits it over TLS with the same bearer. No code change.
- **Result notification** — because D3 adopts Redis Streams push from day one, the app-side consumer is built behind a `ChangeEventSource` interface with two implementations, chosen by config at deploy time:
  - `RedisStreamSource` (co-located) — `XREAD` on Core's change stream over the internal network.
  - `WebhookSource` (remote) — Report.Farm exposes a signed `POST /hooks/alphageo/change`; Core's `notifier/webhook` adapter is pointed at it. (RWR's webhook-verifier utilities are reused for the HMAC check.)

  Everything downstream of the source (pull result → normalize → `upsertObservations` → outbox → alerts) is identical. This is the abstraction P2 must build (D3).

---

## Net effect on the canonical plan

| Canonical doc | Change from this overlay |
|---|---|
| `00_MEGAPROMPT` | None (thin-vertical + additive invariants already hold). |
| `01_CLONE_PLAN` | None. |
| `02_ALPHAGEO_INTEGRATION` | Relay contract unchanged. **Add** a Redis Streams push trigger (D3) feeding the same ingest core; relay SSE retained for interactive scans; polling demoted to fallback/backfill. |
| `03_DATA_MODEL` | **Add** `206_farm_supplychain.sql` + `207_farm_rollup.sql`; `farm_profile.supplier_id`; extend `210_farm_rls.sql`. |
| `04_WORKSTREAMS` | **Add P3.5** (supply-chain rollups/portfolio); pull **bulk supplier onboarding** into P1; **P2 gains** the Redis Streams push channel + `ChangeEventSource` consumer (D3/D4). |
| `05_BOOTSTRAP_SEQUENCE` | P0–P1 unchanged; **P2/Step 8–9** add configuring the Core change stream + app consumer alongside the relay wiring. |

**All four decisions are now settled.** No open items; D3 resolved to Redis Streams push from day one.
