export type LeadStatus = 'Info Request' | 'Lead' | 'Client';

export interface StatusTimestamps {
  infoRequestedAt?: string;
  convertedToLeadAt?: string;
  convertedToClientAt?: string;
}

export interface Lead {
  id: string;
  tenant_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  position: string | null;
  status: LeadStatus;
  source: string | null;
  source_details: string | null;
  interest: string | null;
  total_revenue: string | number;
  status_timestamps: StatusTimestamps;
  selected_products: Array<{ id?: string; name: string; price: number; sku?: string }>;
  created_at: string;
  updated_at: string;
}

export interface Opportunity {
  id: string;
  tenant_id: string;
  lead_id: string | null;
  name: string;
  stage: 'discovery' | 'qualified' | 'proposal' | 'won' | 'lost';
  amount: string | number;
  close_date: string | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: string;
  lead_id: string;
  body: string;
  author_id: string | null;
  created_at: string;
}

export interface Meeting {
  id: string;
  lead_id: string | null;
  title: string;
  start_at: string;
  end_at: string;
  location: string | null;
  attendees: Array<{ name?: string; email?: string }>;
  notes: string | null;
  created_at: string;
}

export interface Message {
  id: string;
  lead_id: string;
  sender: 'agent' | 'contact';
  body: string;
  attachments: Array<{ name: string; size?: number; url?: string }>;
  created_at: string;
}

export interface FileRecord {
  id: string;
  lead_id: string | null;
  file_name: string;
  file_size: number;
  file_type: string | null;
  storage_path: string;
  signed_url: string | null;
  uploaded_at: string;
}

export interface Product {
  id: string;
  name: string;
  sku: string | null;
  price: string | number;
  active: boolean;
}

export type CaseStatus = 'open' | 'assigned' | 'in_progress' | 'blocked' | 'closed';
export type CasePriority = 'low' | 'medium' | 'high' | 'critical';

export interface Case {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  status: CaseStatus;
  priority: CasePriority;
  detection_id: string | null;
  opened_at: string;
  closed_at: string | null;
  assignments?: Array<{ id: string; assignee_id: string; assigned_at: string; released_at: string | null }>;
  activity?: Array<{ id: string; kind: string; body: string | null; payload: Record<string, unknown>; actor_id: string | null; created_at: string }>;
  attachments?: Array<{ id: string; file_name: string; file_size: number; storage_path: string; uploaded_at: string }>;
}

export interface Tenant {
  id: string;
  slug: string;
  display_name: string;
  status: string;
  plan: string;
  created_at: string;
  updated_at: string;
}

// Sprint A5.1 (ADR-0024) — additive org claim block on the authenticated user.
// Present only when the active tenant has a parent org AND the user holds an
// org-tier role; null/undefined for standalone tenants (org_id IS NULL).
export interface UserOrgClaim {
  org_id: string;
  org_slug: string;
  org_roles: string[];
}

export interface User {
  id: string;
  email: string;
  display_name: string;
  tenant_id: string;
  tenant_slug?: string;
  roles: string[];
  org?: UserOrgClaim | null;
}

// GET /iam/my-orgs response shapes (Sprint A5.1).
export interface MyOrgDistrict {
  tenant_id: string;
  tenant_slug: string;
  display_name: string;
}
export interface MyOrg {
  org_id: string;
  org_slug: string;
  display_name: string;
  billing_mode: 'per_district' | 'consolidated';
  org_roles: string[];
  districts: MyOrgDistrict[];
}

export interface TenantUser {
  id: string;
  email: string;
  display_name: string;
  roles: string[];
}

export interface StaffUser {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  roles: string[];
  status: 'active' | 'inactive';
  created_at: string;
}

export interface Team {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  members: Array<{
    user_id: string;
    email: string;
    display_name: string;
    role: 'lead' | 'member';
    joined_at: string;
  }>;
}

// ---- Roles -----------------------------------------------------------------
export type Role =
  | 'platform:admin'
  | 'sales:manage'
  | 'ops:manage'
  | 'analytics:view'
  | 'dashboard:view'
  | 'customer:view';

export const ALL_ROLES: Role[] = [
  'platform:admin',
  'sales:manage',
  'ops:manage',
  'analytics:view',
  'dashboard:view',
  'customer:view',
];

export interface DashboardMetrics {
  totalLeads: number;
  pendingInfoRequests: number;
  totalActiveClients: number;
  openLeads: number;
  totalProfit: number;
  conversionRate: number;
  chartData: Array<{ month: string; leads: number; clients: number; revenue: number; conversionRate: number }>;
}

export interface IncomeBucket { label: string; income: number }

export interface StatusHistoryEntry {
  id: string;
  from_status: string | null;
  to_status: string;
  changed_at: string;
  changed_by: string | null;
  note: string | null;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  detail?: string;
}
