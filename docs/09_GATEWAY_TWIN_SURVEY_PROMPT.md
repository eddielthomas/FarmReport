# 09 — Gateway Digital-Twin Survey Prompt

> **Hand this document to the BACKEND GATEWAY AGENT** (the agent that owns the AlphaGeo Gateway / `alphageoserver`, deployed on the box fronting AlphaGeoCore). It is a request for a precise, empirical inventory. **Reply against what is actually running on the deployed gateway today**, not against aspirational docs. Where a capability does not exist, say so explicitly and (if relevant) say whether it *could* be exposed and at what cost.

---

## 1. Who is asking and why

I am the **Report.Farm farm agent**. Report.Farm is a multi-tenant farm + supply-chain intelligence SaaS. We are a **thin vertical**: we build **no EO/ML of our own**. We consume AlphaGeo's geospatial intelligence entirely through an **additive, import-guarded `/api/farm/*` relay** that the app mounts and that delegates to your gateway. To be unambiguous:

- We call **your gateway's public/relay surface** (the same surface RWR's proven harvest relay already hits: `harvest_routes` / `imagery` / `detection_routes` and the indicator/EO/scan pipeline behind them).
- We are **NOT** targeting the gateway's `/v1/*` control plane — that surface is flag-gated OFF by default in our architecture and is out of scope for this survey.
- Our relay clones RWR's harvest relay + background-ingest files (`server.mjs` harvest section, `ingest-alphageo.mjs`, `crm/ingest-core.mjs`) re-pointed to farm names.

**What we are building on top of you:** an **enterprise digital-twin parcel workspace** — a persistent, per-parcel "twin" that shows change-over-time (EO differential), derived signals, a map + optional 3D parcel-cutaway, a copilot grounded in the twin's data, and live change events. This survey exists to discover **exactly what your gateway exposes (or can expose) for that digital-twin surface.**

**One load-bearing premise to confirm or correct first:** our task brief states "the AlphaGeo gateway already supports digital-twin logic." Our own canonical docs contradict this (they describe the gateway as scan/EO/indicator/imagery/evidence only, with no twin-state endpoint). **Please resolve this empirically as your first answer** — see Q1 below. Everything downstream depends on it.

---

## 2. How to reply (required format)

Do **not** reply in prose. Reply with:

1. **A capability table** — one row per capability in §3, with these columns exactly:

   | Capability | Exists today? (YES / PARTIAL / NO / COULD-EXPOSE) | Concrete interface (HTTP method + path, or function symbol) | Request shape | Response shape | Auth | Sync / Async / Streamed | Flags/config required | Hard limits | Notes |

2. **Example request/response payloads** — a fenced code block per capability that is YES or PARTIAL, showing a real (or realistically representative) request and response body, including the exact envelope/field names. For streamed endpoints, include a sample of the raw tick frames and the terminal/summary frame.

3. **A short answer to each numbered open question in §4** — answer inline, numbered to match.

4. **A "TODAY vs PLANNED" split** — for anything that is COULD-EXPOSE or PARTIAL, state what exists now vs what would need to be built, and who/what gates it.

If a capability does not exist and is not planned, write a single row with NO and a one-line reason. Do not pad.

---

## 3. Capabilities to inventory

For **each** capability below, give the concrete interface (endpoint/path **or** function symbol), request + response shape, auth model, and whether it is synchronous, asynchronous (job + poll), or streamed (SSE/WS). Note tenant-scoping semantics for every one.

### 3.1 Twin lifecycle (persistence & state)
- Can the gateway **register/track a parcel AOI as a persistent twin** — i.e. a stored object keyed by tenant + AOI that survives across requests?
- If yes: what **state does it hold** (AOI geometry, tenant, analysis history, last-scan timestamps, cached indicators, subscriptions)? What is the create / read / update / delete surface? What is the identity/handle we get back (twin id, AOI id, job id)?
- If no persistent twin exists: is a twin purely a client-side concept we assemble from per-scan results, or is there any server-side AOI registry we should key off?

### 3.2 EO / differential cube (change-over-time per parcel)
- What **change-over-time EO data** is available per parcel: which measurements (**NDVI, EVI, moisture/water-stress, thermal, SAR**, others)?
- At what **cadence** (revisit interval) and **spatial resolution** per measurement?
- How is it **requested** — bbox + analyses + time range? Is there a differential/cube endpoint that returns a time series, or do we assemble a series from repeated single-date scans?
- Optical-only today, or are SAR / thermal / moisture actually wired?

### 3.3 Soil / subsurface / layer data (for 3D parcel-cutaway)
- Are **soil-horizon, DEM/elevation, or any subsurface/strata rasters** (e.g. SoilGrids, elevation, slope) available through the gateway that could drive a **3D parcel-cutaway** (vertical strata under the parcel top face)?
- Served as **STAC/COG**, tiles, or numeric profiles? Or is **only optical/indicator imagery** available (state this plainly if so)?

### 3.4 Indicator matrix / derived signals / embeddings
- What **derived signals / indicator instances** are available per AOI, and in what shape (GeoJSON FeatureCollection? tabular?)?
- Which **signal kinds** are really available today (ndvi / evi / water_stress / change / anomaly / …)?
- Do returned features carry per-AOI properties like `measurement`, `value`, `confidence`, `cloud_pct`, `scene_id`, `acquired_at` — or must we build a mapping layer?
- Are **embeddings** (per-AOI/per-scene vectors) exposed at all, and if so, dimensionality + how to fetch?

### 3.5 Tiles / imagery (map + 3D texturing)
- What **imagery/tile endpoints** exist for the map and for **texturing the 3D cutaway top face**?
- Can imagery be served as **signed COG URLs** and/or **`{z}/{x}/{y}` tiles** per farm AOI, **tenant-scoped**?
- What are the **auth and caching semantics** (URL signing, TTL, CDN/cache headers) for embedding these in a client (R3F/WebGL) surface?

### 3.6 Simulation / scenario ("what-if")
- Does the gateway expose (or could it expose) any **simulation / scenario-modeling primitive** — yield-at-risk, irrigation, disruption "what-if," anything deterministic or model-based?
- If none: confirm that **all sim compute must be app-side** (deterministic calculation over relayed indicator data) for the MVP.

### 3.7 Twin copilot support
- Does the gateway expose **tools/functions or a reasoning/agent endpoint** that our app's twin copilot should call (e.g. a grounded Q&A over a twin's data, or callable tool schemas)?
- If so: what is the **tool/function schema**, the invocation contract, and the grounding surface (what data the copilot sees)? Is it sync or streamed?
- If not: confirm the copilot must be **entirely app-side**, grounding itself on data pulled via §3.2/§3.4.

### 3.8 Event push (Redis Streams / webhooks)
- Does the gateway (or Core behind it) **publish change events** for a twin/AOI today: **Redis Streams** (stream name, message schema, consumer group) and/or **signed webhooks**?
- If yes: give **stream/topic names, exact payload schemas, event names**, and delivery/ordering/retention semantics.
- If no: confirm Core must be **extended to publish**, and note what that would take. (Our decision D3 assumes push "from day one," but no stream contract is documented — we need the real answer.)

---

## 4. Open questions to answer (verbatim from the integration plan, §9)

Answer each, numbered. These were surfaced by the Report.Farm integration-plan agent and must be resolved against the deployed box:

1. Does the gateway expose ANY existing twin-state or digital-twin endpoint (the task's premise that "the AlphaGeo GATEWAY already supports digital-twin logic")? The canonical docs say NO (gateway is scan/EO/indicator/imagery/evidence only) — confirm empirically on the box.

2. Do the delegate internals named in `02 §4` actually exist, and with what real signatures — `scan_pipeline.enqueue(bbox, analyses, tenant, aoi)` and `.stream(job_id)`, `indicator_svc.query_bbox(bbox, kinds, limit)`? These are illustrative skeletons, not verified APIs.

3. What is the native SSE tick shape — `{stage, state, done, total, message}` vs `{type:'progress', pct, stage, message}` — and the exact `_final` summary payload, so `normalizeHarvestTick` can be ported?

4. Does the indicator-instances federation actually return per-AOI GeoJSON with the `02 §3.3` properties (`measurement`, `value`, `confidence`, `cloud_pct`, `scene_id`, `acquired_at`), or must a mapping layer be built?

5. Which signal kinds are really available (ndvi / evi / water_stress / change), and are SAR / water-stress wired or is it optical-only today?

6. Does the gateway expose a Redis change stream today (stream name, message schema, consumer group), or must Core be extended to publish it? `06 D3` assumes push "from day one" but no stream contract is documented.

7. What are the exact `ALPHAGEO_HARVEST_TOKEN` / `ALPHAGEO_FARM_BASE` / `ALPHAGEO_GATEWAY_ORIGIN` env wirings and the nginx IP-gate config on the deployed box?

8. Is commercial-tasking escalation truly out of the current pipeline?

9. Does the gateway expose (or can it expose) any simulation / scenario-modeling primitive (yield-at-risk, irrigation, disruption "what-if") the app can delegate to, or must all sim compute be app-side deterministic calculation over relayed indicator data for the MVP?

10. Are soil-horizon / DEM / elevation rasters (e.g. SoilGrids) available through the gateway (STAC/COG or tiles) to feed the premium parcel-cutaway strata, or is only optical/indicator imagery served?

11. Can imagery be served as signed COG URLs and/or `{z}/{x}/{y}` tiles per farm AOI with tenant scoping, and what are the auth/caching semantics for embedding them in the R3F cutaway top face?

12. Locate or formally declare-missing the §7.5 report.farm↔AlphaGeo twin contract doc (and the `DIGITAL_TWIN_COPILOT_PATTERN.md` / `REPORTFARM_DIGITAL_TWIN_MEGAPROMPT.md` referenced by the task) before P2 build proceeds — who authors the canonical twin contract, the copilot grounding/tool schema, and the Redis change-event schema?

---

## 5. Also tell us, across everything above

- **TODAY vs PLANNED** for every capability (what runs now vs what is on a roadmap).
- Any **flags / env vars / config** needed to turn a capability on (name them exactly).
- **Example request/response payloads** with real field names/envelopes.
- **Hard limits**: max AOI area, max time range, rate limits, concurrent-scan caps, tile zoom range, payload size caps, job TTLs, streaming timeouts.
- **Auth model** per surface: token header name(s), tenant scoping mechanism, and the nginx/IP gate in front of the deployed box.

Be specific and answerable. A capability table plus example payloads is worth more than any amount of prose.
