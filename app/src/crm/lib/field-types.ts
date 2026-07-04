// =============================================================================
// field-types.ts — TypeScript contracts mirroring api/v1/field/* envelopes.
// -----------------------------------------------------------------------------
// Kept thin and forgiving: optional fields default to null/undefined because
// the API will fill them lazily as a job progresses (e.g. closed_at).
// =============================================================================

export type FieldJobStatus =
  | 'assigned'
  | 'en_route'
  | 'on_site'
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'cancelled';

export interface FieldJob {
  id:                  string;
  tenant_id:           string;
  title:               string;
  description:         string | null;
  status:              FieldJobStatus;
  priority:            'low' | 'medium' | 'high' | 'critical';
  assigned_to:         string | null;
  assigned_to_name?:   string | null;
  address:             string | null;
  /** Job site location (PostGIS point in the DB; lat/lon in the JSON). */
  lat:                 number | null;
  lon:                 number | null;
  geofence_radius_m:   number;
  scheduled_start_at:  string | null;
  scheduled_end_at:    string | null;
  started_at:          string | null;
  completed_at:        string | null;
  created_at:          string;
  updated_at:          string;
  /** Optional eager-loaded summaries. */
  open_tasks?:         number;
  total_tasks?:        number;
  uploads_count?:      number;
}

export interface FieldTask {
  id:           string;
  job_id:       string;
  title:        string;
  completed_at: string | null;
  created_at:   string;
}

export interface FieldUpload {
  id:                       string;
  job_id:                   string;
  user_id:                  string;
  file_name:                string;
  file_size:                number;
  mime_type:                string | null;
  signed_url:               string | null;
  gps_verified:             boolean;
  gps_distance_from_job_m:  number | null;
  lat:                      number | null;
  lon:                      number | null;
  captured_at:              string;
  created_at:               string;
}

export interface FieldTimeEntry {
  id:                string;
  job_id:            string;
  user_id:           string;
  started_at:        string;
  ended_at:          string | null;
  duration_seconds:  number | null;
}

export interface FieldTechPosition {
  user_id:       string;
  display_name?: string | null;
  email?:        string | null;
  tenant_id:     string;
  lat:           number;
  lon:           number;
  accuracy_m:    number;
  heading_deg:   number | null;
  speed_mps:     number | null;
  captured_at:   string;
  /** Server-derived: idle | en_route | on_site | far_drift | spoofing_suspected */
  inferred_status?: 'idle' | 'en_route' | 'on_site' | 'far_drift' | 'spoofing_suspected';
  current_job_id?:  string | null;
}

export interface FieldCheckInResponse {
  time_entry: FieldTimeEntry;
  gps_verified: boolean;
  distance_m: number;
}

export interface FieldGpsOutOfGeofence {
  error: 'gps_out_of_geofence';
  detail?: string;
  distance_m?: number;
  radius_m?: number;
}

export interface FieldUploadResponse {
  id: string;
  gps_verified: boolean;
  gps_distance_from_job_m: number | null;
  signed_url: string | null;
}

/** Statuses considered "on shift" for the purposes of badging. */
export const ACTIVE_JOB_STATUSES: FieldJobStatus[] = [
  'assigned', 'en_route', 'on_site', 'in_progress', 'paused',
];

export const JOB_STATUS_LABEL: Record<FieldJobStatus, string> = {
  assigned:    'Assigned',
  en_route:    'En route',
  on_site:     'On site',
  in_progress: 'In progress',
  paused:      'Paused',
  completed:   'Completed',
  cancelled:   'Cancelled',
};
