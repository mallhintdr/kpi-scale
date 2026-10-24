export type Role = 'superadmin' | 'owner' | 'admin' | 'manager' | 'employee';
export type Band = 'outstanding' | 'exceeds' | 'meets' | 'below' | 'poor' | 'n/a';
export type Unit = 'number' | 'percent' | 'currency' | 'hours' | 'rating';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  designation?: string;
  bps?: number | null;
  /** Guest demo session: viewing only. */
  readOnly?: boolean;
}
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  settings: { timezone: string; currency: string; ratingScale: number };
  /** The platform tenant (super-admin console), not an organisation. */
  isPlatform?: boolean;
  industry?: string;
  branding?: { shortName?: string; tagline?: string; logoUrl?: string };
}
export interface Ref {
  _id: string;
  name: string;
}
export interface Department {
  _id: string;
  name: string;
  code?: string;
  description?: string;
  headId?: Ref | null;
  parentId?: Ref | null;
  active: boolean;
  memberCount: number;
}
export interface Kpi {
  _id: string;
  name: string;
  description?: string;
  category?: string;
  unit: Unit;
  direction: 'higher_better' | 'lower_better';
  frequency: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  aggregation: 'sum' | 'average' | 'latest';
  defaultWeight: number;
  departmentId?: Ref | null;
  active: boolean;
}
export interface Cycle {
  _id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'draft' | 'active' | 'closed';
  kpiWeight: number;
  reviewTypes: { self: boolean; manager: boolean; peer: boolean };
  reviewDueDate?: string;
}
export interface Target {
  _id: string;
  kpiId: Kpi;
  userId: string;
  cycleId: string;
  targetValue: number;
  weight: number;
  actualValue: number | null;
  achievement: number | null;
  lastEntryAt?: string;
}
export interface Entry {
  _id: string;
  value: number;
  periodDate: string;
  note?: string;
  status: 'submitted' | 'approved' | 'rejected';
  enteredBy?: Ref;
  createdAt: string;
}
export interface Review {
  _id: string;
  type: 'self' | 'manager' | 'peer';
  status: 'pending' | 'submitted';
  rating?: number;
  strengths?: string;
  improvements?: string;
  comments?: string;
  dueDate?: string;
  submittedAt?: string;
  revieweeId: Ref & { designation?: string };
  reviewerId: (Ref & { designation?: string }) | null;
  cycleId: Ref & { status: string; endDate: string };
}
export interface PersonScore {
  userId: string;
  name: string;
  designation?: string;
  departmentName?: string;
  kpiScore: number | null;
  reviewRating: number | null;
  selfRating: number | null;
  finalScore: number | null;
  band: Band;
  targets: number;
  targetsWithData: number;
  rank?: number;
}
export interface Notification {
  _id: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  readAt?: string | null;
  createdAt: string;
}
export interface UserRow {
  _id: string;
  name: string;
  email: string;
  role: Role;
  status: 'active' | 'invited' | 'disabled';
  designation?: string;
  employeeCode?: string;
  phone?: string;
  bps?: number;
  lastLoginAt?: string;
  charges?: { post: string; postLabel: string; unit: string }[];
}
