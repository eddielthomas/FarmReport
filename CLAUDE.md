# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is the **planning root** for **Report.Farm** — a farm + supply-chain intelligence SaaS. There is no application code here *yet*; the plan is to clone `D:\Projects\RWR\mvp` (a mature multi-tenant SaaS shell) into this repo and reshape it. Do not invent build/lint/test commands until the app code lands.

Current artifacts:
- `deep-research-report.md` — the original ~900-line spec / "developer mega-prompt" (the **product** source of truth).
- `BOOTSTRAP.md` — index to the build/planning package.
- `docs/00_MEGAPROMPT.md` … `05_BOOTSTRAP_SEQUENCE.md` — **the canonical execution plan** (authored against the *actual deployed* RWR + AlphaGeo code). Multi-agent orchestration, clone procedure, the `/api/farm/*` integration contract, the `farm.*` data model, workstreams, and the literal first-session runbook. **Read these before planning anything.**
- `docs/06_DECISIONS.md` — session decisions overlay reconciling the four decisions below against `00`–`05`.

### The integration approach (do not re-derive)
Report.Farm integrates by **mirroring RWR's proven harvest relay**: it adds an additive, import-guarded **`/api/farm/*`** router to the deployed gateway (`phase41_api_gateway.py`) that delegates to AlphaGeo's existing scan/EO/indicator pipeline, and clones RWR's relay + background-ingest files (`server.mjs` harvest section, `ingest-alphageo.mjs`, `crm/ingest-core.mjs`) re-pointed to farm names. **Not** the Gateway's `/v1/*` control plane — that surface is flag-gated OFF by default. See `docs/02_ALPHAGEO_INTEGRATION.md`.

### Locked decisions (do not relitigate without the user; see `docs/06_DECISIONS.md`)
1. **Thin vertical** — Report.Farm builds no EO/ML; it delegates to AlphaGeo via the `/api/farm/*` relay and does not rebuild the spec's Kafka/Fusion/Reasoning engines.
2. **First wedge** — supply-chain / major buyers (portfolio-of-suppliers monitoring); adds a Buyer/Supplier/SourcingRegion overlay + rollups on top of the single-farm substrate.
3. **Event backbone** — Postgres transactional outbox for app-internal fan-out **and** Core→app **Redis Streams push from day one** (the app reacts to change events, not a poll). Harvest-relay SSE stays for interactive scans; background-ingest polling is fallback/backfill only. Event names spec-compatible (Kafka is a later transport-only swap). See `06_DECISIONS.md` D3.
4. **Deployment** — co-located is the default (per `05`); works remote over TLS. Result notification goes through a `ChangeEventSource` abstraction: `RedisStreamSource` (co-located) or signed-webhook `WebhookSource` (remote). Built in P2. See `06_DECISIONS.md` D4.

### The three source projects
- `D:\Projects\RWR\mvp` — Node/React multi-tenant SaaS shell to clone into `app/` (~80% reusable; **already relays to the AlphaGeo Gateway** via the harvest relay + `api/ingest-alphageo.mjs`).
- `D:\Projects\AlphaGeoCore` — Python/FastAPI geospatial intelligence substrate (adapters, processors, differential cube, embeddings, indicator matrix, tiles).
- `D:\Projects\alphageoserver` — the AlphaGeo Gateway: the single HTTP control plane fronting Core; farm surface added as an import-guarded `/api/farm/*` router alongside `harvest_routes`/`imagery`/`detection_routes`.

## The document and how to navigate it

`deep-research-report.md` is the master spec. It is organized top-down from product thesis to deployment checklist. Use these section headings (searchable with `grep -n '^#'`) as the map:

- **Executive summary / Developer mega-prompt** — the product thesis and the master prompt intended to drive a coding agent. Core positioning: *not* "satellite imagery for farms" but an autonomous farm operating layer (watches land/assets/crops/water/weather/machinery, explains change, estimates financial impact, ships scheduled reports + urgent alerts).
- **Architecture and operating model** — Mermaid architecture blueprint, component responsibilities, product modules. Two-layer design: **AlphaGeo core** (reusable geospatial intelligence) underneath, **Report.Farm** (agriculture vertical) on top.
- **Data contracts and integration standards** — canonical data model, example JSON schemas, the standards/connector matrix, ingestion/normalization rules, and the Kafka event taxonomy.
- **Intelligence, reports, alerts, and onboarding** — AI module guidance, reporting templates, alerting rules, the onboarding copilot + Farm Intelligence Profile, and UI mockups.
- **SaaS model, pricing, security, and operations** — multi-tenant metering, the imagery cost model, storage/caching/indexing, security/compliance, APIs/SDKs, and testing/CI-CD/SLOs.
- **Delivery roadmap, acceptance, confidence, and checklist** — roadmap, team shape, sprint deliverables, acceptance criteria, deployment checklist, and (importantly) the **confidence levels** and **open questions** sections at the end.

## Working conventions for this document

- The spec deliberately treats **cloud provider, programming language, and database** as unresolved, configurable choices — preserve that neutrality unless the user explicitly decides otherwise.
- Claims in the report carry inline `citeturn…` citation markers and explicit confidence levels. When editing, keep claims tied to their evidence and don't silently upgrade a "medium confidence" statement to fact.
- Pricing/imagery figures (e.g. per-km² ranges) are sourced estimates with citations — treat them as cited assumptions, not settled numbers.
- The design is **standards-first**: open geospatial/IoT standards (STAC, OGC APIs, COG, GeoParquet, Zarr, SensorThings; ISOBUS/ISOXML, ADAPT, MQTT, OPC UA, LoRaWAN, Modbus) are favored over vendor-specific APIs. Keep that ordering when extending integration sections.
