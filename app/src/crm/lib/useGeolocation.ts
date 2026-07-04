// =============================================================================
// useGeolocation — geolocation watcher + auto-poster (S9B).
// -----------------------------------------------------------------------------
// Wraps `navigator.geolocation.watchPosition()` and:
//   * Returns the latest fix (lat, lon, accuracy_m, heading, speed, captured_at)
//   * Tracks permission state (`prompt` | `granted` | `denied`)
//   * Auto-posts the fix to POST /field/location every POST_INTERVAL_MS
//     (debounced) so the tenant's manager dashboard sees live positions.
//     The auto-poster only runs when `enabled=true` so calling components
//     can pause it (e.g. while reviewing the Me tab).
//
// Notes:
//   * Reads via `enableHighAccuracy: true` — phones use GPS chip rather than
//     wifi triangulation.
//   * The watch is started ONCE on mount and torn down on unmount. The
//     network post is throttled separately so a high-frequency update from
//     the OS does not spam the API.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiPost } from './api';

const POST_INTERVAL_MS = 30_000; // server-side heartbeat cadence

export type GeoPermission = 'prompt' | 'granted' | 'denied' | 'unsupported';

export interface GeoFix {
  lat:          number;
  lon:          number;
  accuracy_m:   number;
  heading_deg:  number | null;
  speed_mps:    number | null;
  captured_at:  string; // ISO
}

export interface UseGeolocationOptions {
  /** When true (default), run the watcher (live in-tab marker). */
  enabled?: boolean;
  /** Override the auto-post cadence. Useful for tests. */
  postIntervalMs?: number;
  /** Enable high-accuracy mode. Default true. */
  highAccuracy?: boolean;
  /**
   * When true (default), throttled fixes are auto-posted to /field/location.
   * When false, the watcher still runs so the in-tab marker stays live, but
   * the network heartbeat is suppressed — used to only report position while
   * the technician is actively on shift.
   */
  postingEnabled?: boolean;
}

export interface UseGeolocationResult {
  fix:        GeoFix | null;
  error:      string | null;
  permission: GeoPermission;
  /** Manually request a single one-shot position. Returns a fresh fix. */
  requestOnce: () => Promise<GeoFix>;
  /** Re-request permission (useful after user denied initially). */
  requestPermission: () => void;
}

function fixFromPosition(pos: GeolocationPosition): GeoFix {
  return {
    lat:         pos.coords.latitude,
    lon:         pos.coords.longitude,
    accuracy_m:  pos.coords.accuracy ?? 0,
    heading_deg: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
    speed_mps:   Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
    captured_at: new Date(pos.timestamp || Date.now()).toISOString(),
  };
}

/**
 * useGeolocation — primary hook for any tab that needs live GPS.
 */
export function useGeolocation(opts: UseGeolocationOptions = {}): UseGeolocationResult {
  const enabled         = opts.enabled ?? true;
  const postIntervalMs  = opts.postIntervalMs ?? POST_INTERVAL_MS;
  const highAccuracy    = opts.highAccuracy ?? true;
  const postingEnabled  = opts.postingEnabled ?? true;

  const [fix, setFix] = useState<GeoFix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<GeoPermission>(
    typeof navigator !== 'undefined' && 'geolocation' in navigator ? 'prompt' : 'unsupported',
  );

  const watchIdRef = useRef<number | null>(null);
  const lastPostRef = useRef<number>(0);
  const lastFixRef = useRef<GeoFix | null>(null);
  // Read inside the watcher closure so toggling on/off does not tear down and
  // restart the geolocation watch (which would re-prompt and lose the fix).
  const postingEnabledRef = useRef<boolean>(postingEnabled);

  // Keep the ref current and log transitions so operators can confirm the
  // heartbeat starts/stops with the shift.
  useEffect(() => {
    if (postingEnabledRef.current !== postingEnabled) {
      // eslint-disable-next-line no-console
      console.log(`[geo] location posting ${postingEnabled ? 'ENABLED' : 'SUSPENDED'}`);
    }
    postingEnabledRef.current = postingEnabled;
  }, [postingEnabled]);

  // Permission inquiry (best-effort — Safari does not implement this API).
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!('permissions' in navigator) || !navigator.permissions?.query) return;
    let cancelled = false;
    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((status) => {
        if (cancelled) return;
        setPermission(status.state as GeoPermission);
        status.onchange = () => {
          if (!cancelled) setPermission(status.state as GeoPermission);
        };
      })
      .catch(() => { /* ignore — fall back to prompt */ });
    return () => { cancelled = true; };
  }, []);

  // Persistent watcher + auto-poster.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
    if (!enabled) return;

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const next = fixFromPosition(pos);
        lastFixRef.current = next;
        setFix(next);
        setError(null);
        setPermission('granted');

        // Throttled auto-post — every postIntervalMs, and only while posting
        // is enabled (i.e. the technician is on shift). The watcher itself
        // keeps running so the live in-tab marker stays current off-shift.
        const now = Date.now();
        if (postingEnabledRef.current && now - lastPostRef.current >= postIntervalMs) {
          lastPostRef.current = now;
          apiPost('/field/location', next).catch(() => {
            // Silent — the watcher must keep running even if the API is down.
          });
        }
      },
      (err) => {
        setError(err.message || 'gps_error');
        if (err.code === err.PERMISSION_DENIED) setPermission('denied');
      },
      {
        enableHighAccuracy: highAccuracy,
        maximumAge:         5_000,
        timeout:            20_000,
      },
    );

    return () => {
      if (watchIdRef.current != null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [enabled, postIntervalMs, highAccuracy]);

  const requestOnce = useCallback((): Promise<GeoFix> => {
    return new Promise((resolve, reject) => {
      if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
        reject(new Error('geolocation_unsupported'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const next = fixFromPosition(pos);
          lastFixRef.current = next;
          setFix(next);
          setError(null);
          setPermission('granted');
          resolve(next);
        },
        (err) => {
          setError(err.message || 'gps_error');
          if (err.code === err.PERMISSION_DENIED) setPermission('denied');
          reject(err);
        },
        { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
      );
    });
  }, []);

  const requestPermission = useCallback(() => {
    // Best-effort: issuing a one-shot read triggers the OS permission prompt.
    requestOnce().catch(() => { /* swallow */ });
  }, [requestOnce]);

  return { fix, error, permission, requestOnce, requestPermission };
}

// =============================================================================
// Distance helpers — Haversine, returns metres. Used by JobsTab to compute
// "X km away" and by MapTab to size the geofence circle in screen pixels.
// =============================================================================
const R_EARTH_M = 6_371_000;
function toRad(deg: number) { return (deg * Math.PI) / 180; }

export function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(h));
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '—';
  if (meters < 1_000) return `${Math.round(meters)} m`;
  if (meters < 10_000) return `${(meters / 1_000).toFixed(1)} km`;
  return `${Math.round(meters / 1_000)} km`;
}
