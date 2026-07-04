// =============================================================================
// field-socket.ts — socket.io-client wrapper for the field-service bus (S9B).
// -----------------------------------------------------------------------------
// Connects to the same socket.io server the chat surfaces use (api/v1/chat
// /socket.mjs) — the server auto-joins every authenticated socket into both
// the chat:tenant:<id> AND field:tenant:<id> rooms, so we don't need to emit
// any client-side join for field events.
//
// Exposes:
//   * getFieldSocket()        lazy singleton — auth pulled from auth-store
//   * disconnectFieldSocket() destroy on logout / surface change
//   * useFieldEvents(map)     react hook to subscribe to typed envelopes
//
// Envelope shape (mirrors api/v1/lib/field-relay.mjs):
//   {
//     event_id: string,
//     type:    'field.tech.moved' | …,
//     schema_version: 1,
//     tenant_id: string,
//     occurred_at: ISO,
//     payload: { … per-event-type fields … }
//   }
// =============================================================================

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from './auth-store';
import { useTenantStore } from './tenant-store';

export type FieldEventType =
  | 'field.tech.moved'
  | 'field.job.assigned'
  | 'field.job.status_changed'
  | 'field.geofence.entered'
  | 'field.geofence.exited'
  | 'field.upload.created'
  | 'field.time_entry.opened'
  | 'field.time_entry.closed'
  | 'field.spoofing_suspected';

export interface FieldEventEnvelope<P = Record<string, unknown>> {
  event_id:       string;
  type:           FieldEventType;
  schema_version: number;
  tenant_id:      string;
  occurred_at:    string;
  payload:        P;
}

// --- singleton -------------------------------------------------------------
let _socket: Socket | null = null;
let _currentToken: string | null = null;
let _currentTenant: string | null = null;

function buildSocket(token: string, tenantId: string): Socket {
  const origin = typeof window === 'undefined'
    ? ''
    : `${window.location.protocol}//${window.location.host}`;
  return io(origin, {
    auth:        { token, tenant_id: tenantId },
    transports:  ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 8,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 10_000,
    timeout: 10_000,
    autoConnect: true,
  });
}

/**
 * getFieldSocket — returns the active socket.io client, creating one if the
 * auth tuple (token, tenant_id) has changed. Returns null when the user is
 * not authenticated yet (no token / no tenant).
 */
export function getFieldSocket(): Socket | null {
  const token  = useAuthStore.getState().token;
  const tenant = useTenantStore.getState().currentTenantId;
  if (!token || !tenant) {
    disconnectFieldSocket();
    return null;
  }
  if (_socket && _currentToken === token && _currentTenant === tenant) {
    return _socket;
  }
  disconnectFieldSocket();
  _socket = buildSocket(token, tenant);
  _currentToken = token;
  _currentTenant = tenant;
  return _socket;
}

export function disconnectFieldSocket(): void {
  if (_socket) {
    try { _socket.removeAllListeners(); } catch { /* ignore */ }
    try { _socket.disconnect(); } catch { /* ignore */ }
    _socket = null;
    _currentToken = null;
    _currentTenant = null;
  }
}

// --- react hook ------------------------------------------------------------
export type FieldEventHandlerMap = {
  [K in FieldEventType]?: (env: FieldEventEnvelope) => void;
};

/**
 * useFieldEvents — subscribe to a typed map of envelope handlers.
 *
 * Re-subscribes when the handler map identity changes, so callers should
 * memoize their handlers (or accept that the hook will re-bind on every
 * render — fine for low-frequency events).
 *
 * Also exposes a `connected` status via the returned ref so consumers can
 * render a connection-status dot in the top bar.
 */
export function useFieldEvents(handlers: FieldEventHandlerMap) {
  const connected = useRef(false);

  useEffect(() => {
    const sock = getFieldSocket();
    if (!sock) return;

    const onConnect = () => { connected.current = true; };
    const onDisconnect = () => { connected.current = false; };
    sock.on('connect', onConnect);
    sock.on('disconnect', onDisconnect);
    if (sock.connected) connected.current = true;

    const entries = Object.entries(handlers) as Array<
      [FieldEventType, (env: FieldEventEnvelope) => void]
    >;
    for (const [type, fn] of entries) {
      if (typeof fn === 'function') sock.on(type, fn);
    }

    return () => {
      sock.off('connect', onConnect);
      sock.off('disconnect', onDisconnect);
      for (const [type, fn] of entries) {
        if (typeof fn === 'function') sock.off(type, fn);
      }
    };
  }, [handlers]);

  return connected;
}
