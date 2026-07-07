# Sync, Realtime & Notifications — Mobile Architecture

**Surface:** Report.Farm iOS/Android app (Expo + React Native + TypeScript, offline-first)
**Owner:** Mobile architecture lead
**Status:** Design (implementation-grade)
**Depends on:** `app/api/v1/farm/*` REST + `app/api/v1/farm/gw/*` gateway relay, `iam.*` auth, the client `twins-store` / `scan-jobs` stores (localStorage today → SQLite on mobile).

---

## 0. TL;DR — the three load-bearing decisions

1. **One durable outbox, one sync engine.** Every offline mutation is written to a single `outbox` table in SQLite *inside the same transaction* as the optimistic local write, then replayed FIFO-per-entity on reconnect. The server error taxonomy is already precise (`422 invalid_geometry`, `409 invalid_status_transition`, `403 missing_permission`, `401 token_revoked`, `503 gateway_unconfigured`) — the outbox replayer branches on exactly these codes rather than a generic retry. Idempotency keys make replay safe against partial-success (farm created, child failed).

2. **The scan/HD-twin build is a *server-owned* job; the phone only observes it.** We reproduce the web `launchScanJob → 202 {jobId} → SSE farm.progress/complete → twins/:aoi → materialize` loop verbatim, but the observer must survive the app being backgrounded/killed. Foreground: `react-native-sse` (XHR streaming, injects `Authorization: Bearer` + `X-Tenant-Id`). Background/killed: **a server-sent `farm.complete` push notification is the source of truth**, not a held-open socket — the phone re-pulls `twins/:aoi` on wake. SSE is a fast-path optimization, push is the guarantee.

3. **Two independent realtime planes.** (a) *Interactive SSE* for scan progress while the studio is on screen. (b) *Push (APNs/FCM via expo-notifications)* for alerts and build-complete when the app is not foregrounded. These never share a transport. Alerts are server-fanned (`farm.alert.channels` already includes `push`); the mobile app only registers a device token and renders/deep-links the payload.

---

## 1. Scope & non-goals

**In scope:** offline mutation queue + replay; per-entity pull/push cadence; scan SSE + HD-twin build on mobile (background task + local notification + progress); alert push delivery; degraded/offline UX; the gateway 202+SSE non-blocking job model.

**Out of scope (other design docs):** the local SQLite/Drizzle schema *content* per feature domain (owned by the data-model doc — this doc only defines the *sync metadata* columns and the outbox/cursor tables), map tile caching, and auth/session storage mechanics (owned by the auth doc — referenced here only where token lifetime gates sync).

**Hard invariants carried from web (do not violate):**
- Never fabricate a signal/observation/alert. Honest-empty and honesty tiers (T1/T2/T3) survive offline.
- All `/gw/*` endpoints require a live gateway and return `503 gateway_unconfigured` in stub mode — mobile degrades, never crashes.
- Every business request carries `Authorization: Bearer <jwt>` **and** `X-Tenant-Id: <uuid|slug>`. The offline DB is partitioned per tenant.

---

## 2. System architecture (text diagram)

```
┌──────────────────────────── React Native app (per active tenant) ────────────────────────────┐
│                                                                                                │
│  UI (expo-router screens)                                                                      │
│    │  reads via TanStack Query (memory cache)          writes via mutation hooks               │
│    ▼                                                     │                                      │
│  ┌───────────────────────────────┐                       ▼                                      │
│  │  Local read models (SQLite)   │◄────────┐    ┌──────────────────────┐                       │
│  │  farms/parcels/zones/alerts/  │         │    │  writeLocalAndEnqueue │  (single tx)          │
│  │  observations/reports/twins/  │         │    │  1. mutate read model │                       │
│  │  scan_jobs (+ sync_meta cols) │         │    │  2. insert outbox row │                       │
│  └───────────────────────────────┘         │    └──────────┬───────────┘                       │
│         ▲             ▲                     │               │                                    │
│         │ pull        │ apply push          │ apply flush   ▼                                    │
│  ┌──────┴───────┐  ┌──┴─────────────┐   ┌───┴──────────────────────────┐                        │
│  │ Pull sync    │  │ Realtime plane │   │  Outbox replayer (push sync)  │                        │
│  │ (delta poll  │  │  A: SSE (scan) │   │  FIFO per entity, idempotent, │                        │
│  │  + cursors)  │  │  B: push (FCM) │   │  error-taxonomy branch, backoff│                       │
│  └──────┬───────┘  └──┬─────────────┘   └───────────────┬──────────────┘                        │
│         │             │                                 │                                        │
│  ┌──────┴─────────────┴─────────────────────────────────┴──────────────┐                        │
│  │ Connectivity + session gate (NetInfo, token exp, tenant, access pass)│                        │
│  └───────────────────────────────────┬────────────────────────────────┘                         │
└──────────────────────────────────────┼──────────────────────────────────────────────────────────┘
                                        │ HTTPS (Bearer + X-Tenant-Id + X-Access-Pass)
                                        ▼
        app/api/v1/farm/*  (REST, Postgres/PostGIS, RLS)  ──┐
        app/api/v1/farm/gw/* (relay → AlphaGeo gateway) ────┤ 202 + SSE job model
        app/api/v1/push/register-device  (NEW — §8.3)      ─┤ device token store
                                                            ▼
                        AlphaGeo gateway (scan pipeline, EO, twins)
                        + push fan-out (APNs/FCM) for farm.alert.channels⊇{push}
```

---

## 3. Entity sync taxonomy

Direction, cadence, offline-writability, and conflict policy **per entity**. This table is the contract every screen obeys.

| Entity (source of record) | Read dir | Write dir | Offline-writable? | Pull cadence | Conflict policy | Notes |
|---|---|---|---|---|---|---|
| `farm_profile` (server) | pull | outbox | ✅ create/update | on focus + 5 min stale + push-invalidate | LWW on `updated_at`; server recomputes `area_ha`/`aoi_*` (authoritative) | POST raw GeoJSON; treat server echo as truth. |
| `parcel` (server) | pull | outbox | ✅ create | on farm open | append-only create; no offline edit | ordered after farm create (id resolution). |
| `zone` (server) | pull | outbox | ✅ create + intent edit | on farm open | LWW; intent JSONB merged field-wise | zone→parcel FK resolved on flush. |
| `observation` (server) | pull only | — | ❌ | on farm open + push-invalidate | server-only; **honest-empty until ingest** | never fabricate; idempotency `(farm_id, external_id)`. |
| `alert` (server) | pull + **push** | outbox (ack only) | ✅ ack | push-driven; 2 min poll fallback | ack: `open→ack` idempotent; `409` on resolved/suppressed | prime push target (`channels⊇push`). |
| `report` (server) | pull | outbox (generate req) | ⚠️ queue generate | on report list open | generate is online-only server job | cache artifact_urls (pdf/html) for offline view. |
| `portfolio rollup / suppliers / regions` (server views) | pull only | — | ❌ | on portfolio focus + 5 min | honest-zero until worker runs | cache aggregates + bands. |
| `twin` (**client** of record) | local + materialize | local (SQLite) | ✅ full CRUD | n/a (local) | LWW per-twin; `updatedAt` | today per-device; server sync is a future ask (§11). |
| `scan_job` (**client** of record) | local | local | ✅ (launch queued) | n/a; driven by SSE/push | last-writer per `jobId`; resume on wake | job outlives app; see §7. |
| `annotation` (client, ephemeral on web) | local | local | ✅ | n/a | LWW | **improvement over web:** persist to SQLite. |
| device token (server) | — | direct call | ❌ (needs net) | on login + token rotate | upsert by `(user, device_id)` | §8.3. |

**Cadence primitives**
- `on focus`: `useFocusEffect` re-validates if `now - last_pull > staleTime`.
- `staleTime` defaults: hot lists (alerts) 60 s, warm (farms/zones) 5 min, cold (rollups) 5 min, static (catalog) ∞ (bundled).
- `push-invalidate`: a data-change push (or `farm.complete`) marks the affected cursor dirty → next focus force-pulls.

---

## 4. Offline outbox pattern

### 4.1 Principle

A mutation is **not** "fire an HTTP call and hope". It is: *atomically* (a) apply the optimistic change to the local read model and (b) append a durable envelope to `outbox`, in **one SQLite transaction**. The UI reads the optimistic state immediately. A background replayer drains `outbox` FIFO-per-entity when the network + a valid session exist. Nothing is lost across app kills because the queue is on disk.

### 4.2 Outbox DDL (Drizzle / expo-sqlite)

```sql
CREATE TABLE outbox (
  id            TEXT PRIMARY KEY,           -- ULID (monotonic; also the FIFO key)
  tenant_id     TEXT NOT NULL,              -- partition; replay only current tenant
  entity        TEXT NOT NULL,              -- 'farm' | 'parcel' | 'zone' | 'alert' | 'report' | 'twin' | ...
  entity_local_id TEXT,                     -- local optimistic id (for id-remap on create)
  op            TEXT NOT NULL,              -- 'create' | 'update' | 'delete' | 'ack' | 'generate'
  method        TEXT NOT NULL,              -- 'POST' | 'PUT' | 'DELETE'
  url_template  TEXT NOT NULL,              -- '/api/v1/farm/farms' | '/api/v1/farm/farms/{parentId}/parcels'
  parent_ref    TEXT,                       -- outbox.id of a create this depends on (parcel→farm, zone→parcel)
  body_json     TEXT NOT NULL,              -- serialized request payload (GeoJSON etc.)
  idempotency_key TEXT NOT NULL,            -- UUID; sent as Idempotency-Key header (server ask §11)
  status        TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'inflight'|'blocked'|'failed'|'done'
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0, -- epoch ms; backoff gate
  last_error_code TEXT,                     -- 'invalid_geometry'|'invalid_status_transition'|...
  last_error_msg  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX outbox_drain ON outbox (tenant_id, status, next_attempt_at);
CREATE INDEX outbox_entity ON outbox (entity, entity_local_id);
```

### 4.3 Mutation envelope (TypeScript)

```ts
export interface OutboxEnvelope {
  id: string;                 // ULID
  tenantId: string;
  entity: 'farm' | 'parcel' | 'zone' | 'alert' | 'report' | 'twin';
  entityLocalId?: string;     // e.g. 'local_farm_01H...'
  op: 'create' | 'update' | 'delete' | 'ack' | 'generate';
  method: 'POST' | 'PUT' | 'DELETE';
  urlTemplate: string;        // {parentId} placeholders resolved at flush from id-map
  parentRef?: string;         // outbox.id this row must flush AFTER (create ordering)
  body: unknown;
  idempotencyKey: string;     // stable across retries — the anti-duplicate token
}
```

### 4.4 The atomic local-write

```ts
// One transaction: optimistic read-model change + durable outbox row.
export async function writeLocalAndEnqueue(db, env: OutboxEnvelope, applyOptimistic: (tx) => void) {
  await db.transaction(async (tx) => {
    applyOptimistic(tx);                    // e.g. insert farm row with status='pending_sync'
    await tx.insert(outbox).values(toRow(env));
  });
  SyncEngine.kick();                        // best-effort immediate flush if online
}
```

Every optimistic row carries a `sync_state` column (`synced | pending | error`) so the UI can badge it (see §9.4).

### 4.5 Replay algorithm (drain loop)

```
drain(tenantId):
  if !online || !sessionValid(): return
  rows = SELECT * FROM outbox
         WHERE tenant_id=? AND status IN ('pending','failed')
           AND next_attempt_at <= now
         ORDER BY id ASC                      # ULID = creation order = FIFO
  for row in rows:
     if row.parent_ref and parentNotDone(row.parent_ref): continue   # ordering barrier
     mark inflight
     url  = resolveTemplate(row.url_template, idMap)   # {parentId} → server id from prior create
     resp = HTTP(row.method, url, body,
                 headers += Idempotency-Key: row.idempotency_key,
                            Authorization, X-Tenant-Id, X-Access-Pass)
     branch on resp:  (see §4.6)
```

Key rules:
- **FIFO per dependency chain, not globally serial.** Independent entities (two unrelated alert acks) may flush concurrently (bounded pool = 4). A `parent_ref` chain (farm→parcel→zone) is strictly ordered and the child waits until the parent row is `done` and its server id is in `idMap`.
- **Single-flight per `jobId`/entity id** to avoid double-submits after a wake.

### 4.6 Error taxonomy → replay branch (the crux)

The server is precise; the replayer mirrors it exactly. **Never** blanket-retry.

| HTTP / error code | Meaning | Replayer action |
|---|---|---|
| `2xx` | success | write server echo into read model, id-remap (`local_farm_x` → server uuid), `status='done'`, `sync_state='synced'`. |
| `422 invalid_geometry` | bad polygon | **do not retry.** `status='failed'`, surface inline "self-intersecting/unclosed" on the owning screen; user must fix + re-enqueue. |
| `409 invalid_status_transition` (alert ack on resolved/suppressed) | already moved on | treat as **terminal success** (converge): drop the ack, pull the alert to get real status. |
| `403 missing_permission` | role changed / not operator | `status='failed'`, actionable message ("your role can't do this; sign out/in"). No retry. |
| `401 token_revoked` | session dead | **halt drain**, force hard sign-out (clear session + tenant SQLite scope), keep outbox (replays after re-auth if same user/tenant). |
| `401` (expired, not revoked) | token past `exp` | pause drain, trigger re-auth/refresh, then resume — outbox untouched. |
| `503 gateway_unconfigured` (`/gw/*` launches) | gateway stub/down | `status='pending'`, exponential backoff, keep queued; show "will run when the gateway is connected". |
| `502 gateway_unreachable` | transient upstream | backoff retry. |
| `5xx` / network / timeout | transient | backoff retry (see §4.7). |

### 4.7 Backoff & attempt ceiling

- `next_attempt_at = now + min(30 min, base * 2^attempts) + jitter(±20%)`, `base = 2 s`.
- Retryable classes only (network, 5xx, 502, 503). Non-retryable (422/403) skip backoff → `failed` immediately.
- Attempt ceiling for retryables = 12, then `failed` with a "couldn't sync — retry" affordance (manual re-kick resets attempts).
- Drain is triggered by: NetInfo `online` transition, app foreground, successful re-auth, and a 60 s safety timer.

### 4.8 Partial-success (the onboarding create bundle)

Web creates `farm → parcels → zones` as **sequential POSTs, not an atomic server bundle**. The outbox models this natively:
- One `create` envelope per entity, chained by `parent_ref`.
- Idempotency-Key per envelope ⇒ a replay after a crash between parcel #2 and #3 does **not** duplicate #1/#2 (server dedupes on the key; §11 is the server ask).
- If a child fails `422`, the farm + earlier children stay `done`; only the failing child is `failed`. UI mirrors web's "farm already created, fix this shape" message and does not re-create the farm.

---

## 5. Local store: sync metadata

Every server-sourced read model gets these columns (added by the data-model doc's tables):

```sql
  server_id     TEXT,               -- null until first successful sync of a local create
  sync_state    TEXT NOT NULL DEFAULT 'synced',  -- 'synced'|'pending'|'error'
  server_updated_at INTEGER,        -- for LWW + delta reconciliation
  local_updated_at  INTEGER,
  deleted       INTEGER NOT NULL DEFAULT 0       -- soft-delete tombstone (offline delete)
```

Plus a per-(tenant, entity) **cursor** table for delta pull:

```sql
CREATE TABLE sync_cursor (
  tenant_id  TEXT NOT NULL,
  entity     TEXT NOT NULL,          -- 'farms' | 'alerts' | 'observations' | ...
  scope_key  TEXT NOT NULL DEFAULT '', -- e.g. farm_id for per-farm lists
  cursor     TEXT,                    -- server high-water mark (updated_at ISO or opaque token)
  last_pull_at INTEGER,
  dirty      INTEGER NOT NULL DEFAULT 0, -- push-invalidated → force pull on next focus
  PRIMARY KEY (tenant_id, entity, scope_key)
);
```

---

## 6. Pull sync (server → device)

### 6.1 Delta vs snapshot

Current REST endpoints return full lists (`LIMIT 500/1000`) with no `updated_since` param. Two-phase plan:

- **Phase 1 (works today, no backend change):** snapshot pull on cadence. Fetch the list, upsert-by-id into SQLite, tombstone rows absent from the response *only for full-scope lists* (farms per tenant, zones per farm). Cheap enough at pilot scale (≤500 farms).
- **Phase 2 (server ask §11):** add `?updated_since=<cursor>&limit=` to list endpoints; store the max `updated_at` in `sync_cursor.cursor`; pull only deltas. Halves battery/bandwidth and is required before scale.

### 6.2 TanStack Query as the read path

- Queries read **from SQLite** (via a Drizzle-backed query fn), not directly from HTTP. HTTP is a *sync side-effect* that writes SQLite; Query observes SQLite and re-renders. This gives offline reads for free.
- `queryClient` is created per tenant; `rwr.tenant-changed`-equivalent event → `queryClient.clear()` + swap SQLite scope (mirror web's cache-invalidate-on-tenant-switch).
- Persist the Query cache with `@tanstack/query-async-storage-persister` only as a warm-start accelerant; SQLite remains the source of truth.

### 6.3 Reconciliation with pending local writes

When a pull returns a row that also has a `pending`/`inflight` outbox mutation, **local optimistic state wins** until that outbox row reaches `done` (don't clobber an unsynced edit with a stale server snapshot). Implementation: pull upserts skip rows whose `sync_state != 'synced'`.

---

## 7. Realtime plane A — scan SSE + HD-twin build on mobile

This is the port of `scan-jobs.ts` + `ScanJobsRunner.tsx` to RN. The web loop:

```
launchScanJob:  aoiFromGeom(polygon) → aoi_id
                runScan(aoi_id, signals) → 202 {jobId}
                persist ScanJob(status=running, pct=0)          # returns immediately
driveJob:       streamJobEvents(jobId)  # SSE farm.progress → pct/stage
                on farm.complete → fetchTwins(aoi_id) → materializeParcelTwin → upsert
                reconnect on drop; poll twins/:aoi as source of truth; 12-min ceiling
```

### 7.1 What changes on mobile

The web relies on the tab staying alive. A phone will background/lock/kill the app mid-build (builds are 5+ min). So the observer is **three-tiered**:

| App state | Observer | Mechanism |
|---|---|---|
| Foreground, studio open | live SSE | `react-native-sse` (RN `EventSource` shim over XHR) — attaches `Authorization` + `X-Tenant-Id` headers, which browser `EventSource` cannot. Frame reassembly on `\n\n`, skip `:`-comment heartbeats — same logic as `streamJobEvents`. |
| Foreground, elsewhere in app | live SSE (same) | The `ScanJobsRunner` equivalent is mounted app-globally (not just on the studio screen) so progress dock persists across expo-router navigation. |
| Backgrounded / locked / killed | **push + poll on wake** | SSE sockets are killed by the OS. `expo-task-manager` `BackgroundTask` (opportunistic, iOS ~15 min min interval — *not reliable for a 5-min build*), so the **guarantee is a server `farm.complete` push** (§8) that wakes the app; on open, `driveJob` reconciles via `fetchTwins(aoi_id)` (already the web "twins as source of truth" pattern). |

### 7.2 Job state machine (SQLite `scan_jobs`)

```
                launch (202 ack)
   [idle] ───────────────────────────► [running] ──farm.progress──► [running] (pct/stage updated)
                                            │
                 farm.complete / poll ready │        farm.error / timeout(12m)
                                            ▼                    │
                                     [materializing]             ▼
                                            │               [error]
                       fetchTwins(aoi) ok   ▼
                                        [complete] ──► notify local + upsert twin
```

- Persisted exactly like `ScanJob` (§scan-jobs.ts): `{id, jobId, aoiId, propertyId, twinId, label, signals, boundary, status, pct, stage, message, startedAt, updatedAt, resultTwinId}` → SQLite table, not localStorage.
- **Resume on relaunch:** on app start, for every `scan_jobs` row with `status='running'`, start a `driveJob` (SSE if foreground, else immediately poll `twins/:aoi` once and rely on push). Same "resume on remount" contract as web.
- **Launch while offline:** `aoiFromGeom`/`runScan` need the gateway. Queue the *intent* in the outbox (`entity='scan_job', op='create'`); on flush, perform the 2-step aoi→scan, then insert the running `scan_jobs` row. If gateway `503`, stay queued (backoff) — dock shows "queued, waiting for connection".

### 7.3 SSE client (react-native-sse) skeleton

```ts
import EventSource from 'react-native-sse';

export function streamJobEventsRN(jobId: string, onEvent: (e: JobEvent) => void, ac: AbortController) {
  const es = new EventSource(`${API_BASE}/api/v1/farm/gw/jobs/${encodeURIComponent(jobId)}/events`, {
    headers: { Authorization: `Bearer ${jwt}`, 'X-Tenant-Id': tenantId, Accept: 'text/event-stream' },
    // react-native-sse handles \n\n framing + reconnection; we disable auto-reconnect and own it
    pollingInterval: 0,
  });
  for (const name of ['farm.progress', 'farm.complete', 'farm.error']) {
    es.addEventListener(name as any, (ev: any) => onEvent({ event: name, data: safeJson(ev.data) }));
  }
  es.addEventListener('error', () => { /* backoff + reconnect, or fall to poll — mirror driveJob */ });
  ac.signal.addEventListener('abort', () => es.close());
  return es;
}
```

Notes:
- The relay sends `: connected` and 15 s `: ping` heartbeats — `react-native-sse` treats `:`-comment lines as keep-alive (ignored). Good.
- `503` on open ⇒ `ApiError('gateway_unconfigured')` ⇒ mark job error "Gateway not connected" (matches `driveJob`).
- iOS: SSE over XHR keeps working for the ~30 s the OS grants after background; do **not** depend on it — push is the guarantee.

### 7.4 Progress UX on mobile

- Global progress dock (bottom sheet handle / notification-style card) mirroring `JobCard`: spinner + `HD twin building · {pct}% · {stage} · {mins}m`, "View HD twin" on complete, dismiss, "Clear N finished".
- **Local notification on complete even in foreground** (subtle) and a **push** when backgrounded (§8), so a 5-min build never requires the user to babysit.
- "Builds keep running if you leave" copy carried over.

---

## 8. Realtime plane B — alert & build push (expo-notifications, APNs/FCM)

### 8.1 Why push, not polling

`farm.alert.channels` already includes `push`. Alerts are urgent, low-frequency, and must arrive when the app is closed — the textbook push case. Build-complete for a 5-min job is the same. Poll is only the *fallback* (2 min) for alerts when push is unavailable (permissions denied, no token).

### 8.2 Stack

- `expo-notifications` for permissions, token retrieval, foreground handler, channels/categories, deep-link routing.
- Transport: **FCM (Android) + APNs (iOS)**. Use Expo Push Service (`ExponentPushToken`) for pilot velocity; the server sends to Expo's endpoint which fans to APNs/FCM. Design the server device-token store to also accept raw APNs/FCM tokens so we can drop Expo's relay later without a client change.

### 8.3 Device-token registration (NEW server endpoint — §11 ask)

```
POST /api/v1/push/register-device
  Auth: Bearer + X-Tenant-Id
  body: { device_id, platform: 'ios'|'android', token, token_kind: 'expo'|'apns'|'fcm', app_version }
  → upsert iam.push_device (user_id, tenant_id, device_id UNIQUE per user, token, ...)

DELETE /api/v1/push/register-device/{device_id}   # on sign-out
```

Client registers: after login, after JWT refresh/rotate, and after the OS rotates the push token (`expo-notifications` `addPushTokenListener`). Unregister on sign-out (part of the §Sign-Out teardown).

### 8.4 Push payload contract

```jsonc
{
  "type": "farm.alert",              // or "farm.scan.complete", "farm.data.invalidate"
  "tenant_id": "…",                  // gate: drop if != active tenant (or offer switch)
  "alert_id": "…",                   // for farm.alert
  "farm_id": "…",
  "severity": "critical",            // drives channel + sound
  "title": "Irrigation failure detected — North Valley",
  "body": "NDVI drop + no standing water in irrigation zone.",
  "deep_link": "reportfarm://farm/{farm_id}/alerts/{alert_id}",
  "invalidate": ["alerts:{farm_id}", "observations:{farm_id}"]  // cursors to mark dirty
}
```

- **`farm.scan.complete`** carries `aoi_id` + `job_id` → app finds the `scan_jobs` row, pulls `twins/:aoi`, materializes, and flips the dock/notification to done.
- **`farm.data.invalidate`** is a silent/data push (content-available / FCM data message) that just marks `sync_cursor.dirty=1` so the next foreground force-pulls — this is how Core→app change events (locked decision D3, Redis Streams push) reach the phone without polling.

### 8.5 Notification channels (Android) / categories (iOS)

| Channel/category | Severity | Sound | Importance |
|---|---|---|---|
| `alerts-critical` | critical/high | alarm | HIGH / time-sensitive |
| `alerts-standard` | medium/low | default | DEFAULT |
| `builds` | build complete | subtle | LOW |
| `system` | session/tenant | none | MIN |

iOS `critical` severity may use `interruption-level: time-sensitive`. Respect Focus modes; do not request critical-alert entitlement for pilot.

### 8.6 Foreground handling & deep-link routing

- Foreground handler: show an in-app toast/banner for alerts (don't double-notify if the alerts screen is open for that farm); still fire `builds` locally.
- Tap → `deep_link` → `sanitizeNextUrl`-equivalent (reproduce the web open-redirect/allow-list guard for `reportfarm://` deep links and push nav) → expo-router `router.push`. If the push targets a non-active tenant, prompt "switch to {tenant} to view" (tenant switch is online-only).
- Cold-start from a tapped notification: read the initial notification response, defer routing until session hydrated + tenant scoped.

---

## 9. Degraded / offline states

### 9.1 Connectivity + session gate

Single `SyncGate` observable combines:
- `NetInfo.isInternetReachable` (not just `isConnected` — captive portals).
- `jwtValid` (decode `exp` client-side; pre-empt expiry ~60 s early).
- `accessPassValid` (1 h pass; §Access-Code gate). Gated surfaces blocked when absent/expired.
- `tenantActive` (last known `active|trial`; a `403 tenant_suspended` flips to `locked`).

Drain + SSE + push-register run only when `online && jwtValid && tenantActive`.

### 9.2 UX state matrix

| Condition | Reads | Writes | UI signal |
|---|---|---|---|
| online, session ok | live | flush immediately | normal; sync badge hidden |
| offline | SQLite cache w/ "stale · {age}" | queue to outbox; optimistic | offline banner; per-row "pending" chip |
| online, gateway `503` (`/gw/*`) | cached signals/twins + honest-empty | scan launches queued | "Automatic lookup / live signals not connected" (honest note) |
| JWT expired | cached | drain paused | silent re-auth; if it fails → login |
| `401 token_revoked` | cached until teardown | halt | hard sign-out banner |
| `403 tenant_suspended` | locked | blocked | full-screen "tenant suspended" lock |
| push denied / no token | poll fallback (2 min alerts) | unaffected | settings nudge to enable notifications |

### 9.3 Honesty tiers preserved offline

- Cache the *last* signals/observations FeatureCollection per AOI with an `acquired_at`/`fetched_at`; render `T1/T2/T3` badges, `cadastral (exact)` vs `osm/approximate`, `no_producer`, and honest-null `sceneId/cloudPct` exactly as web. **Offline never upgrades an approximate to exact or invents a value.**
- Honest-empty copy ("No signals yet — run a scan", "Awaiting first satellite pass", "AI auto-trace isn't live yet") ships in-bundle and renders without network.

### 9.4 Optimistic write badges

Rows with `sync_state='pending'` show a subtle clock chip; `error` shows a red retry chip with the mapped message (§4.6). Tapping error opens the owning editor pre-seeded (e.g. boundary step for `invalid_geometry`).

---

## 10. Token lifecycle × sync (interaction rules)

- **JWT 8 h.** Decode `exp`; when `< 60 s` remaining, pause new drains, attempt refresh/re-auth (dev-login/OIDC per env), resume. Every *replayed* request carries the *current* token, not the token captured at enqueue time (re-read at flush).
- **Access pass 1 h.** Sent as `X-Access-Pass` header (no cookies on native). If a gated call `302/401`s for a missing pass, prompt re-entry; queued writes wait.
- **Revocation.** `401 token_revoked` on any drain/pull ⇒ immediate hard sign-out: clear secure-store token + tenant, cancel SSE, unregister device token (best-effort), purge/lock tenant-scoped SQLite, route to login. Outbox is retained (same user/tenant re-login can resume) but never replayed under a different identity.
- **Tenant switch (admin/org).** Online-only; on switch, `queryClient.clear()`, swap SQLite scope, re-register device token binding (token is user-global but active-tenant gating changes), reset cursors.

---

## 11. Server-side asks (backend work this design depends on)

Prioritized; all additive, none block Phase-1.

1. **`Idempotency-Key` support** on `POST /farm/farms`, `/parcels`, `/zones`, `/reports/generate`, `/alerts/:id/ack`, and `/gw/scan`+`/gw/aoi/from-geom`. Store key→result for 24 h; replay returns the original result. *Unblocks safe outbox replay / partial-success.* **P0.**
2. **Push device registry + fan-out**: `POST/DELETE /api/v1/push/register-device` + a fan-out worker that sends `farm.alert` (when `channels⊇push`) and `farm.scan.complete` to APNs/FCM/Expo. Wire into the P2 ingest + the gateway job-complete. **P0 for the notifications story.**
3. **Delta pull params**: `?updated_since=<cursor>&limit=` (+ soft-delete tombstones or a `deleted_since`) on `/farm/farms`, `/parcels`, `/zones`, `/alerts`, `/observations`, `/reports`, portfolio views. **P1 (before scale).**
4. **Silent data-invalidate push** (`farm.data.invalidate`) sourced from the D3 Redis Streams Core→app events, so the phone marks cursors dirty instead of polling. **P1.**
5. **Twin server-sync** endpoints (`farm.asset`/`zone` write + a twin sync surface) so twins stop being per-device. Today `twin` is client-of-record only. **P2.**
6. SSE relay: confirm it forwards a **terminal `farm.complete` frame even if the client connected late** (the web loop already re-checks `twins/:aoi`; a guaranteed terminal frame simplifies mobile). **P2.**

---

## 12. Library choices (Expo SDK, pin at implementation)

| Concern | Library | Why |
|---|---|---|
| Local DB | `expo-sqlite` + `drizzle-orm` | typed schema, migrations, transactions for atomic local-write+enqueue. |
| ID generation | `ulid` | monotonic, sortable → free FIFO ordering + idempotency seeds. |
| Server cache/read | `@tanstack/react-query` (+ async-storage persister) | dedupe, focus refetch, cache invalidation on tenant switch. |
| Connectivity | `@react-native-community/netinfo` | reachability (captive-portal aware) drives drain/SSE gating. |
| SSE | `react-native-sse` | XHR-based `EventSource` that accepts auth headers (browser EventSource can't). |
| Push | `expo-notifications` (+ `expo-device`) | permissions, token, channels/categories, foreground handler, deep-link. |
| Background | `expo-task-manager` / `expo-background-task` | opportunistic drain + late-build reconcile (best-effort; push is the guarantee). |
| Secure token | `expo-secure-store` | JWT + access pass + device binding. |
| App-state/foreground | RN `AppState` + expo-router `useFocusEffect` | drain triggers, SSE mount/unmount, dirty-cursor pulls. |

---

## 13. Sequence walkthroughs (text)

### 13.1 Offline farm onboarding → reconnect

```
User (offline): completes wizard → Create
  writeLocalAndEnqueue x(1 farm + N parcels + M zones)   # chained parent_ref
  UI: success card "queued — will sync when online"; rows badged pending
Reconnect (NetInfo online):
  drain: POST farms (Idempotency-Key) → 201 {id} → idMap[local]=id, remap children urls
         POST parcels (parent done) → 201 …
         POST zones (parent parcel done, parcel_id resolved) → 201 …
  all done → rows sync_state=synced; badges clear
  (crash mid-way? re-drain; idempotency prevents dup farm/parcels)
```

### 13.2 Scan launch → background → push complete

```
Studio (online): Build HD twin
  outbox scan intent → drain → aoiFromGeom → aoi_id → runScan → 202 {jobId}
  insert scan_jobs(status=running); dock shows 0%
  foreground SSE: farm.progress → pct 12→47→…  (dock updates)
User backgrounds app → OS kills SSE socket
  ~4 min later: gateway job done → server fan-out → APNs/FCM "HD twin ready" (channel=builds)
App wake (tap): route studio; driveJob(resume) → fetchTwins(aoi_id) → materialize → status=complete
  twin appears in explorer; dock "View HD twin"
```

### 13.3 Alert arrives while app closed

```
Ingest detects threshold cross → farm.alert row (channels⊇push) → fan-out
  APNs/FCM critical → device
User taps → deep_link reportfarm://farm/F/alerts/A → sanitize → hydrate session → scope tenant
  open FarmDetail alerts; pull alerts (cursor was push-dirtied) → ack available
Ack offline later → outbox(op=ack, idempotency) → on flush 200, or 409→converge(pull status)
```

---

## 14. Build order (mobile milestones)

1. **M1 — Read cache + connectivity gate.** SQLite read models, TanStack-over-SQLite, NetInfo gate, stale badges, honest-empty/tier rendering offline. (No writes yet.)
2. **M2 — Outbox + replay.** Atomic local-write, drain loop, error-taxonomy branch, backoff, alert-ack + zone-intent + onboarding create bundle. Requires server Idempotency-Key (§11.1).
3. **M3 — Scan SSE + dock.** `react-native-sse`, global progress dock, resume-on-relaunch, `twins/:aoi` reconcile.
4. **M4 — Push.** Device registry, expo-notifications channels, alert + build-complete, deep-link routing, silent data-invalidate.
5. **M5 — Delta pull + hardening.** `updated_since` cursors, tombstones, background reconcile, battery/bandwidth tuning.
```
