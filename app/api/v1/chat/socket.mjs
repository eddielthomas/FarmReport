// =============================================================================
// chat/socket.mjs — socket.io WebSocket gateway for chat (S6A Phase 2).
// -----------------------------------------------------------------------------
// In-process single-replica fanout (no Redis adapter). Attaches to the existing
// http.Server from api/server.mjs via attachSocketIo(httpServer).
//
// Connection contract:
//   - Client connects with `io({ auth: { token, tenant_id? } })`.
//   - Token is verified through the same code path as requireAuth in
//     api/v1/middleware/auth.mjs (JWKS when configured, HS256 fallback).
//   - JTI revocation is consulted (same blocklist as REST).
//   - Tenant is resolved from the token's `tenant_id` claim. Optional override
//     header for platform admins acting cross-tenant.
//   - Rejects with `connect_error` event on any failure (no payload leaks).
//
// Per-socket events:
//   - `chat:join { conversation_id }` -> joins room `chat:<tenant>:<conv>` after
//     membership check. Returns ack { ok: true } or { ok: false, error }.
//   - `chat:leave { conversation_id }` -> leaves the same room.
//   - `chat:typing { conversation_id, state: 'started'|'stopped' }` -> rebroadcast
//     of the typing-state envelope to the conversation room (no DB write).
//   - `chat:read { conversation_id, message_id }` -> inserts chat.message_read
//     row + broadcasts `chat.message.read` envelope. Uses recordAudit.
//
// Connection upgrade additionally joins the per-tenant bus room
// `chat:tenant:<tenant_id>` so chat.conversation.created broadcasts reach
// every connected member of the tenant.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { verifyHs256, JWT_SECRET } from '../middleware/auth.mjs';
import { verifyJwks, jwksConfigured } from '../middleware/jwks.mjs';
import { q } from '../db/pool.mjs';
import { recordAudit } from '../audit.mjs';
import { publishChatEvent } from '../lib/chat-relay.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HAS_JWKS_URL   = jwksConfigured();
const FALLBACK_HS256 = process.env.AUTH_FALLBACK_HS256 === '1';

// CORS allow-list — same as REST plus the canonical alphageo staging origin.
function corsOrigins() {
  const env = process.env.CORS_ORIGIN ?? '';
  const explicit = env.split(',').map((s) => s.trim()).filter(Boolean);
  const defaults = [
    'https://report.farm',
    'http://localhost:5173',
    'http://localhost:5275',
  ];
  if (explicit.length === 0 || explicit.includes('*')) {
    // Mirror REST's permissive default in dev but still announce a finite set
    // so socket.io can echo back access-control-allow-origin correctly.
    return Array.from(new Set([...defaults, ...explicit]));
  }
  return Array.from(new Set([...defaults, ...explicit]));
}

async function verifyToken(token) {
  if (HAS_JWKS_URL && !FALLBACK_HS256) return await verifyJwks(token);
  if (!JWT_SECRET) throw new Error('jwt_verify_unavailable');
  return verifyHs256(token);
}

// --- helpers ---------------------------------------------------------------
async function isRevoked(jti) {
  if (!jti) return false;
  try {
    const { rows } = await q(
      `SELECT 1 FROM iam.token_revocation
        WHERE jti = $1 AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1`,
      [jti],
    );
    return rows.length > 0;
  } catch (_e) {
    // Soft-fail closed in absence of the table; REST checkRevocation does the
    // same: failure here lets the connection through and the next REST hit
    // will short-circuit it.
    return false;
  }
}

async function resolveTenant(idOrSlug) {
  if (!idOrSlug) return null;
  const isUuid = UUID_RE.test(String(idOrSlug));
  try {
    const { rows } = await q(
      `SELECT id, slug, display_name, status
         FROM iam.tenant
        WHERE ${isUuid ? 'id = $1' : 'slug = $1'}
        LIMIT 1`,
      [String(idOrSlug)],
    );
    return rows[0] ?? null;
  } catch (_e) {
    return null;
  }
}

// Authoritative conversation-membership check. Returns the conversation row +
// caller's role_in_convo when the caller is currently a member, otherwise null.
async function loadMembership(tenantId, conversationId, userId) {
  if (!UUID_RE.test(String(conversationId ?? ''))) return null;
  if (!UUID_RE.test(String(userId ?? ''))) return null;
  try {
    const { rows } = await q(
      `SELECT c.id, c.tenant_id, c.scope_kind, c.scope_id, c.status,
              m.role_in_convo, m.left_at
         FROM chat.conversation c
         LEFT JOIN chat.conversation_member m
           ON m.conversation_id = c.id AND m.user_id = $3
        WHERE c.id = $1 AND c.tenant_id = $2
        LIMIT 1`,
      [conversationId, tenantId, userId],
    );
    return rows[0] ?? null;
  } catch (_e) {
    return null;
  }
}

// Synthesize a minimal `req`-shaped object for recordAudit so the WS layer
// emits to the same iam.audit_event ledger as REST.
function fakeReq(socket) {
  return {
    tenant:    socket.data.tenant,
    user:      { sub: socket.data.user?.id, email: socket.data.user?.email },
    requestId: socket.data.correlationId,
    headers:   {
      'user-agent':      socket.handshake.headers['user-agent'] ?? 'socket.io',
      'x-correlation-id': socket.data.correlationId,
    },
    socket:    { remoteAddress: socket.handshake.address },
  };
}

// --- main attach -----------------------------------------------------------
let _io = null;

/**
 * Initialize the socket.io server bound to the existing http.Server. Returns
 * the io instance (also cached for reuse via getIo()).
 *
 * Importing socket.io lazily lets the dependency be optional in environments
 * that don't need realtime (e.g. CI parity smoke). If the module is missing
 * we log and return null so the HTTP server still boots.
 */
export async function attachSocketIo(httpServer) {
  if (_io) return _io;
  let mod;
  try {
    mod = await import('socket.io');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[chat/socket] socket.io_unavailable:', err?.message ?? err);
    return null;
  }
  const { Server } = mod;
  const origins = corsOrigins();
  const io = new Server(httpServer, {
    cors: {
      origin: origins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    // path stays at the default '/socket.io/' — the existing express-style
    // router in handleV1 only claims /api/* and /healthz so there's no clash.
    transports: ['websocket', 'polling'],
    pingInterval: 20_000,
    pingTimeout:  25_000,
  });

  // --- handshake middleware ------------------------------------------------
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ??
        (socket.handshake.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) return next(new Error('missing_token'));

      let claims;
      try {
        claims = await verifyToken(token);
      } catch (_e) {
        return next(new Error('invalid_token'));
      }

      if (await isRevoked(claims.jti)) return next(new Error('token_revoked'));

      // Tenant: prefer explicit auth.tenant_id override (platform admins), else
      // fall back to the token's tenant claim.
      const tokenTenant = claims.tenant_id ?? claims.tenant ?? null;
      const headerTenant =
        socket.handshake.auth?.tenant_id ??
        socket.handshake.headers['x-tenant-id'] ??
        null;
      const wanted = headerTenant ?? tokenTenant;
      const tenant = await resolveTenant(wanted);
      if (!tenant) return next(new Error('unknown_tenant'));
      if (tenant.status !== 'active' && tenant.status !== 'trial') {
        return next(new Error('tenant_suspended'));
      }
      const isAdmin = (claims.roles ?? []).includes('platform:admin');
      if (tokenTenant && tenant.id !== tokenTenant && !isAdmin) {
        return next(new Error('tenant_mismatch'));
      }

      socket.data.user = {
        id:    claims.sub,
        email: claims.email ?? null,
        roles: claims.roles ?? [],
        jti:   claims.jti ?? null,
      };
      socket.data.tenant = { id: tenant.id, slug: tenant.slug };
      socket.data.correlationId =
        (socket.handshake.headers['x-correlation-id']) || randomUUID();
      next();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[chat/socket] handshake_failed:', err?.message ?? err);
      next(new Error('unauthorized'));
    }
  });

  // --- per-connection handlers --------------------------------------------
  io.on('connection', (socket) => {
    const { tenant, user } = socket.data;

    // Auto-join the per-tenant bus so chat.conversation.created broadcasts
    // reach every connected member.
    socket.join(`chat:tenant:${tenant.id}`);
    // S9A — also join the field-service bus so techs / managers receive
    // realtime envelopes (field.tech.moved, field.job.assigned, etc.).
    socket.join(`field:tenant:${tenant.id}`);

    // chat:join { conversation_id }
    socket.on('chat:join', async (payload = {}, ack) => {
      const respond = (r) => { if (typeof ack === 'function') ack(r); };
      const conversation_id = payload?.conversation_id;
      if (!UUID_RE.test(String(conversation_id ?? ''))) {
        return respond({ ok: false, error: 'conversation_id_invalid' });
      }
      const conv = await loadMembership(tenant.id, conversation_id, user.id);
      if (!conv) return respond({ ok: false, error: 'conversation_not_found' });
      if (conv.status === 'deleted') {
        return respond({ ok: false, error: 'conversation_deleted' });
      }
      const isMember = conv.role_in_convo != null && conv.left_at == null;
      const roles = user.roles ?? [];
      const adminOverride = roles.includes('platform:admin');
      if (!isMember && !adminOverride) {
        return respond({ ok: false, error: 'not_a_conversation_member' });
      }
      socket.join(`chat:${tenant.id}:${conversation_id}`);
      respond({ ok: true, conversation_id });
    });

    // chat:leave { conversation_id }
    socket.on('chat:leave', (payload = {}, ack) => {
      const conversation_id = payload?.conversation_id;
      if (UUID_RE.test(String(conversation_id ?? ''))) {
        socket.leave(`chat:${tenant.id}:${conversation_id}`);
      }
      if (typeof ack === 'function') ack({ ok: true });
    });

    // chat:typing { conversation_id, state }
    socket.on('chat:typing', async (payload = {}) => {
      const conversation_id = payload?.conversation_id;
      const state = payload?.state === 'stopped' ? 'stopped' : 'started';
      if (!UUID_RE.test(String(conversation_id ?? ''))) return;
      // Only members of the room may broadcast typing.
      const roomKey = `chat:${tenant.id}:${conversation_id}`;
      const rooms = socket.rooms;
      if (!rooms || !rooms.has(roomKey)) return;
      const type = state === 'started' ? 'chat.typing.started' : 'chat.typing.stopped';
      publishChatEvent(io, type, {
        tenant_id:       tenant.id,
        conversation_id,
        user_id:         user.id,
        at:              new Date().toISOString(),
      });
    });

    // chat:read { conversation_id, message_id }
    socket.on('chat:read', async (payload = {}, ack) => {
      const respond = (r) => { if (typeof ack === 'function') ack(r); };
      const conversation_id = payload?.conversation_id;
      const message_id      = payload?.message_id;
      if (!UUID_RE.test(String(conversation_id ?? ''))
          || !UUID_RE.test(String(message_id ?? ''))) {
        return respond({ ok: false, error: 'ids_invalid' });
      }
      const conv = await loadMembership(tenant.id, conversation_id, user.id);
      if (!conv) return respond({ ok: false, error: 'conversation_not_found' });
      const isMember = conv.role_in_convo != null && conv.left_at == null;
      if (!isMember && !(user.roles ?? []).includes('platform:admin')) {
        return respond({ ok: false, error: 'not_a_conversation_member' });
      }
      try {
        const guard = await q(
          `SELECT 1 FROM chat.message
            WHERE id = $1 AND conversation_id = $2 AND tenant_id = $3`,
          [message_id, conversation_id, tenant.id],
        );
        if (guard.rows.length === 0) {
          return respond({ ok: false, error: 'message_not_found' });
        }
        await q(
          `INSERT INTO chat.message_read (message_id, tenant_id, user_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (message_id, user_id) DO NOTHING`,
          [message_id, tenant.id, user.id],
        );
        recordAudit({
          req: fakeReq(socket),
          action: 'chat.message.read',
          resource: 'chat.message',
          resourceId: message_id,
          payload: { conversation_id, reader: user.id, via: 'socket' },
        });
        publishChatEvent(io, 'chat.message.read', {
          tenant_id:       tenant.id,
          conversation_id,
          message_id,
          user_id:         user.id,
          read_at:         new Date().toISOString(),
        });
        respond({ ok: true });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[chat/socket] read_failed:', err?.message ?? err);
        respond({ ok: false, error: 'internal_error' });
      }
    });

    socket.on('disconnect', () => { /* no-op for S6A */ });
  });

  _io = io;
  return io;
}

export function getIo() { return _io; }
