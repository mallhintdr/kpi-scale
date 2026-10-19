/**
 * Starter blueprints. A new organisation is created from one of these and its admin edits it freely.
 * `revenue_department` reproduces the Board of Revenue framework exactly.
 */
import type { BlueprintInput as Blueprint } from './blueprint.js';
import { PK_TEMPLATES } from './templates-pk.js';

const BANDS: Blueprint['bands'] = [
  { key: 'outstanding', label: 'Outstanding', min: 90 },
  { key: 'good', label: 'Good', min: 75 },
  { key: 'satisfactory', label: 'Satisfactory', min: 60 },
  { key: 'below', label: 'Below par', min: 40 },
  { key: 'poor', label: 'Poor', min: 0 },
];

const STD_BLOCKS: Blueprint['blocks'] = [
  { key: 'revenue', label: 'Revenue recovery', kind: 'target' },
  { key: 'arrears', label: 'Arrears recovery', kind: 'arrears' },
  { key: 'cases', label: 'Case disposal', kind: 'flow' },
  { key: 'audit', label: 'Audit paras', kind: 'register' },
  { key: 'tasks', label: 'Tasks on time', kind: 'tasks' },
];

/* ---------------- Board of Revenue — Revenue Department ---------------- */
const PATWARI_HEAD = { level: 'circle', enterPosts: ['patwari', 'wasilbaqi'], verifyPosts: ['wasilbaqi'], arrears: true, block: 'revenue', unit: 'money' } as const;
const WB_HEAD = { level: 'circle', enterPosts: ['wasilbaqi'], verifyPosts: ['wasilbaqi'], arrears: true, block: 'revenue', unit: 'money' } as const;
const SCI_HEAD = { level: 'circle', enterPosts: ['sci'], verifyPosts: ['sci'], block: 'cases', unit: 'count', weight: 1 } as const;
const RO_HEAD = {
  level: 'tehsil', perHolder: true, holderPosts: ['tehsildar', 'naib_tehsildar'], enterPosts: ['tehsildar', 'naib_tehsildar', 'wasilbaqi'],
  verifyPosts: ['wasilbaqi'], block: 'cases', unit: 'count', weight: 1,
} as const;

const m = (x: any) => ({ perHolder: false, holderPosts: [], arrears: false, active: true, weight: 1, ...x });

export const revenueDepartment: Blueprint = {
  name: 'Revenue Department',
  industry: 'Public sector',
  levels: [
    { key: 'division', label: 'Division', plural: 'Divisions', profile: 'division' },
    { key: 'district', label: 'District', plural: 'Districts', profile: 'district' },
    { key: 'tehsil', label: 'Tehsil', plural: 'Tehsils', profile: 'tehsil' },
    { key: 'qanungoi', label: 'Qanungoi', plural: 'Qanungois', profile: 'girdawar' },
    { key: 'circle', label: 'Patwar Circle', plural: 'Patwar Circles', profile: 'patwari' },
    { key: 'mouza', label: 'Mouza', plural: 'Mouzas', profile: 'patwari' },
  ],
  posts: [
    { key: 'commissioner', label: 'Commissioner', levels: ['division'], single: true, scored: true, profile: 'division', oversightAt: [], caps: ['assign_targets', 'compare'] },
    { key: 'dc', label: 'Deputy Commissioner', levels: ['district'], single: true, scored: true, profile: 'district', oversightAt: [], caps: ['assign_targets', 'compare'] },
    { key: 'adc_rev', label: 'ADC (Revenue)', levels: ['district'], single: true, scored: true, profile: 'district', oversightAt: [], caps: ['assign_targets', 'compare'] },
    { key: 'ac', label: 'Assistant Commissioner', levels: ['tehsil'], single: true, scored: true, profile: 'tehsil', oversightAt: [], caps: ['assign_targets'] },
    // Cholistan Development Authority: a district-level unit of the division with its own officers
    { key: 'md_cda', label: 'Managing Director (CDA)', levels: ['district'], single: true, scored: true, profile: 'district', oversightAt: [], caps: ['assign_targets', 'compare'], rankWith: 'dc' },
    { key: 'drc', label: 'Director Revenue & Colonies (DRC)', levels: ['district'], single: true, scored: true, profile: 'district', oversightAt: [], caps: ['assign_targets', 'compare'], rankWith: 'adc_rev' },
    { key: 'co', label: 'Colonization Officer (CO)', levels: ['tehsil'], single: true, scored: true, profile: 'tehsil', oversightAt: [], caps: ['assign_targets'], rankWith: 'ac' },
    { key: 'tehsildar', label: 'Tehsildar', levels: ['tehsil', 'qanungoi'], single: true, exclusiveWith: ['naib_tehsildar'], scored: true, profile: 'ro', widenTo: 'tehsil', oversightAt: ['tehsil'], caps: ['assign_targets', 'state_land_approve'] },
    { key: 'naib_tehsildar', label: 'Naib Tehsildar', levels: ['qanungoi'], single: true, exclusiveWith: ['tehsildar'], scored: true, profile: 'ro', widenTo: 'tehsil', oversightAt: [], caps: ['assign_targets', 'state_land_approve'] },
    { key: 'girdawar', label: 'Girdawar', levels: ['qanungoi'], single: false, scored: true, profile: 'girdawar', oversightAt: [], caps: ['assign_targets', 'state_land_verify'] },
    { key: 'patwari', label: 'Patwari', levels: ['circle'], single: false, scored: true, profile: 'patwari', oversightAt: [], caps: ['litigation', 'state_land'] },
    { key: 'wasilbaqi', label: 'Wasil Baqi Navees', levels: ['tehsil'], single: true, scored: false, oversightAt: [], caps: ['set_targets', 'manage_registers'] },
    { key: 'reader', label: 'Reader', levels: ['district', 'tehsil'], single: false, scored: false, oversightAt: [], caps: ['litigation'] },
    { key: 'colony_clerk', label: 'Colony Clerk', levels: ['district', 'tehsil'], single: false, scored: false, oversightAt: [], caps: ['litigation'] },
    { key: 'pa', label: 'PA', levels: ['district', 'tehsil'], single: false, scored: false, oversightAt: [], caps: ['litigation'] },
    { key: 'sci', label: 'Service Centre In-charge (SCI)', levels: ['tehsil'], single: true, scored: false, oversightAt: [], caps: [] },
  ],
  blocks: STD_BLOCKS,
  tags: [{ key: 'rabi', label: 'Rabi' }, { key: 'kharif', label: 'Kharif' }],
  metrics: [
    m({ code: 'WR_RABI', name: 'Water Rate — Rabi', group: 'Water Rate', tag: 'rabi', weight: 12, ...PATWARI_HEAD }),
    m({ code: 'WR_KHARIF', name: 'Water Rate — Kharif', group: 'Water Rate', tag: 'kharif', weight: 12, ...PATWARI_HEAD }),
    m({ code: 'TAWAN_RABI', name: 'Tawan — Rabi', group: 'Tawan', tag: 'rabi', weight: 3, ...WB_HEAD }),
    m({ code: 'TAWAN_KHARIF', name: 'Tawan — Kharif', group: 'Tawan', tag: 'kharif', weight: 3, ...WB_HEAD }),
    m({ code: 'AIT_LAND', name: 'AIT — Land Based', group: 'AIT', weight: 12, ...PATWARI_HEAD }),
    m({ code: 'AIT_INCOME', name: 'AIT — Income Based', group: 'AIT', weight: 8, ...PATWARI_HEAD }),
    m({ code: 'LEASE', name: 'Lease Money (State Land)', group: 'Lease Money', weight: 10, ...PATWARI_HEAD }),
    m({ code: 'MUT_FEE', name: 'Mutation Fee', group: 'Mutation Fee', weight: 10, ...WB_HEAD }),
    m({ code: 'COND_FEE', name: 'Condonation Fee', group: 'Condonation Fee', weight: 5, ...WB_HEAD }),
    m({ code: 'STAMP', name: 'Stamp Duty', group: 'Stamp Duty', weight: 10, ...WB_HEAD }),
    m({ code: 'FBR_236C', name: 'FBR 236-C', group: 'FBR', weight: 8, ...WB_HEAD }),
    m({ code: 'FBR_236K', name: 'FBR 236-K', group: 'FBR', weight: 7, ...WB_HEAD }),
    m({ code: 'KMI', name: 'Khewat Mutation Issues', group: 'KMI', ...SCI_HEAD }),
    m({ code: 'MISSING_MUT', name: 'Missing Mutations', group: 'Missing Mutations', ...SCI_HEAD }),
    m({ code: 'GPC', name: 'Green Property Certificate', group: 'GPC', ...SCI_HEAD }),
    m({ code: 'INHERIT', name: 'Inheritance Mutations', group: 'Inheritance', ...SCI_HEAD }),
    m({ code: 'PENDING_MUT', name: 'Pending Mutations', group: 'Pending Mutations', ...SCI_HEAD }),
    m({ code: 'REGISTRY', name: 'Pending Registries', group: 'Registries', ...RO_HEAD }),
    m({ code: 'PARTITION', name: 'Partition Cases', group: 'Partition', ...RO_HEAD }),
  ],
  registers: [
    {
      key: 'audit', label: 'Audit paras', block: 'audit', levels: ['tehsil', 'circle'], enterPosts: ['patwari', 'wasilbaqi'], amountLabel: 'Recoverable',
      categories: ['Water Rate', 'AIT', 'Mutation Fee', 'Condonation Fee', 'Stamp Duty', 'FBR Fees', 'Lease Money'],
    },
  ],
  profiles: [
    { key: 'patwari', label: 'Patwari', weights: { revenue: 40, arrears: 15, cases: 30, audit: 5, tasks: 10 } },
    { key: 'girdawar', label: 'Girdawar', weights: { revenue: 35, arrears: 15, cases: 30, audit: 5, tasks: 15 } },
    { key: 'ro', label: 'Tehsildar / Naib Tehsildar', weights: { revenue: 30, arrears: 10, cases: 30, audit: 15, tasks: 15 } },
    { key: 'tehsil', label: 'Tehsil / AC', weights: { revenue: 30, arrears: 10, cases: 25, audit: 20, tasks: 15 } },
    { key: 'district', label: 'District / DC / ADC(R)', weights: { revenue: 30, arrears: 10, cases: 25, audit: 20, tasks: 15 } },
    { key: 'division', label: 'Division / Commissioner', weights: { revenue: 30, arrears: 10, cases: 25, audit: 25, tasks: 10 } },
  ],
  bands: BANDS,
  calendar: { fyStartMonth: 7 },
  terms: { money: 'Revenue', achieved: 'Recovered', flowGroup: 'Case registers', disposed: 'Disposed', pending: 'Pending', items: 'cases', reference: 'Challan / PSID no.' },
  money: { currency: 'PKR', symbol: 'Rs', scale: 1e6, scaleLabel: 'Millions', decimals: 2 },
};

/* ---------------- Sales & marketing company ---------------- */
export const salesCompany: Blueprint = {
  name: 'Sales & Marketing',
  industry: 'Marketing',
  levels: [
    { key: 'company', label: 'Company', plural: 'Company', profile: 'leadership' },
    { key: 'region', label: 'Region', plural: 'Regions', profile: 'manager' },
    { key: 'branch', label: 'Branch', plural: 'Branches', profile: 'manager' },
    { key: 'territory', label: 'Territory', plural: 'Territories', profile: 'rep' },
  ],
  posts: [
    { key: 'ceo', label: 'Chief Executive', levels: ['company'], single: true, scored: true, profile: 'leadership', oversightAt: [], caps: ['assign_targets', 'compare'] },
    { key: 'regional_manager', label: 'Regional Manager', levels: ['region'], single: true, scored: true, profile: 'manager', oversightAt: [], caps: ['assign_targets', 'compare'] },
    { key: 'branch_manager', label: 'Branch Manager', levels: ['branch'], single: true, scored: true, profile: 'manager', oversightAt: [], caps: ['assign_targets', 'set_targets'] },
    { key: 'sales_rep', label: 'Sales Representative', levels: ['territory'], single: false, scored: true, profile: 'rep', oversightAt: [], caps: [] },
    { key: 'sales_admin', label: 'Sales Administrator', levels: ['branch'], single: false, scored: false, oversightAt: [], caps: ['set_targets', 'manage_registers'] },
  ],
  blocks: [
    { key: 'sales', label: 'Sales achievement', kind: 'target' },
    { key: 'receivables', label: 'Overdue receivables', kind: 'arrears' },
    { key: 'pipeline', label: 'Lead conversion', kind: 'flow' },
    { key: 'complaints', label: 'Customer complaints', kind: 'register' },
    { key: 'tasks', label: 'Tasks on time', kind: 'tasks' },
  ],
  tags: [],
  metrics: [
    m({ code: 'NEW_SALES', name: 'New business sales', group: 'Sales', block: 'sales', unit: 'money', level: 'territory', enterPosts: ['sales_rep', 'sales_admin'], verifyPosts: ['sales_admin'], weight: 50, arrears: true }),
    m({ code: 'RENEWALS', name: 'Renewals', group: 'Sales', block: 'sales', unit: 'money', level: 'territory', enterPosts: ['sales_rep', 'sales_admin'], verifyPosts: ['sales_admin'], weight: 30, arrears: true }),
    m({ code: 'COLLECTIONS', name: 'Cash collected', group: 'Collections', block: 'sales', unit: 'money', level: 'territory', enterPosts: ['sales_admin'], verifyPosts: ['sales_admin'], weight: 20, arrears: true }),
    m({ code: 'LEADS', name: 'Leads converted', group: 'Pipeline', block: 'pipeline', unit: 'count', level: 'territory', enterPosts: ['sales_rep', 'sales_admin'], verifyPosts: ['sales_admin'] }),
    m({ code: 'CAMPAIGNS', name: 'Campaigns delivered', group: 'Marketing', block: 'pipeline', unit: 'count', level: 'branch', enterPosts: ['branch_manager', 'sales_admin'], verifyPosts: ['sales_admin'] }),
  ],
  registers: [
    { key: 'complaints', label: 'Customer complaints', block: 'complaints', levels: ['branch', 'territory'], enterPosts: ['sales_admin', 'branch_manager'], amountLabel: 'Refund at stake', categories: ['Product', 'Service', 'Billing', 'Delivery'] },
  ],
  profiles: [
    { key: 'rep', label: 'Sales representative', weights: { sales: 50, receivables: 15, pipeline: 25, complaints: 5, tasks: 5 } },
    { key: 'manager', label: 'Managers', weights: { sales: 40, receivables: 15, pipeline: 20, complaints: 15, tasks: 10 } },
    { key: 'leadership', label: 'Leadership', weights: { sales: 40, receivables: 20, pipeline: 15, complaints: 15, tasks: 10 } },
  ],
  bands: BANDS,
  calendar: { fyStartMonth: 1 },
  terms: { money: 'Sales', achieved: 'Achieved', flowGroup: 'Pipeline', disposed: 'Converted', pending: 'Open', items: 'leads', reference: 'Invoice no.' },
  money: { currency: 'PKR', symbol: 'Rs', scale: 1e6, scaleLabel: 'Millions', decimals: 2 },
};

/* ---------------- HR services provider ---------------- */
export const hrServices: Blueprint = {
  name: 'HR Services',
  industry: 'Human resources',
  levels: [
    { key: 'company', label: 'Company', plural: 'Company', profile: 'lead' },
    { key: 'practice', label: 'Practice', plural: 'Practices', profile: 'lead' },
    { key: 'team', label: 'Team', plural: 'Teams', profile: 'consultant' },
  ],
  posts: [
    { key: 'director', label: 'Director', levels: ['company'], single: true, scored: true, profile: 'lead', oversightAt: [], caps: ['assign_targets', 'compare', 'set_targets'] },
    { key: 'practice_head', label: 'Practice Head', levels: ['practice'], single: true, scored: true, profile: 'lead', oversightAt: [], caps: ['assign_targets', 'compare', 'set_targets'] },
    { key: 'consultant', label: 'HR Consultant', levels: ['team'], single: false, scored: true, profile: 'consultant', oversightAt: [], caps: [] },
    { key: 'coordinator', label: 'Coordinator', levels: ['practice'], single: false, scored: false, oversightAt: [], caps: ['set_targets', 'manage_registers'] },
  ],
  blocks: [
    { key: 'placements', label: 'Placements & billing', kind: 'target' },
    { key: 'requests', label: 'Requests closed', kind: 'flow' },
    { key: 'grievances', label: 'Client grievances', kind: 'register' },
    { key: 'tasks', label: 'Tasks on time', kind: 'tasks' },
  ],
  tags: [],
  metrics: [
    m({ code: 'HIRES', name: 'Positions filled', group: 'Recruitment', block: 'placements', unit: 'count', level: 'team', enterPosts: ['consultant', 'coordinator'], verifyPosts: ['coordinator'], weight: 40 }),
    m({ code: 'BILLING', name: 'Fees billed', group: 'Billing', block: 'placements', unit: 'money', level: 'team', enterPosts: ['coordinator'], verifyPosts: ['coordinator'], weight: 40 }),
    m({ code: 'TRAINING_HRS', name: 'Training hours delivered', group: 'Training', block: 'placements', unit: 'number', level: 'team', enterPosts: ['consultant', 'coordinator'], verifyPosts: ['coordinator'], weight: 20 }),
    m({ code: 'HR_TICKETS', name: 'HR service requests', group: 'Service desk', block: 'requests', unit: 'count', level: 'team', enterPosts: ['consultant', 'coordinator'], verifyPosts: ['coordinator'] }),
    m({ code: 'PAYROLL_ISSUES', name: 'Payroll issues', group: 'Payroll', block: 'requests', unit: 'count', level: 'team', enterPosts: ['coordinator'], verifyPosts: ['coordinator'] }),
  ],
  registers: [
    { key: 'grievances', label: 'Client grievances', block: 'grievances', levels: ['practice', 'team'], enterPosts: ['coordinator'], amountLabel: 'Penalty at stake', categories: ['Delay', 'Quality', 'Compliance', 'Conduct'] },
  ],
  profiles: [
    { key: 'consultant', label: 'Consultants', weights: { placements: 55, requests: 30, grievances: 5, tasks: 10 } },
    { key: 'lead', label: 'Leads', weights: { placements: 45, requests: 25, grievances: 20, tasks: 10 } },
  ],
  bands: BANDS,
  calendar: { fyStartMonth: 1 },
  terms: { money: 'Placements & billing', achieved: 'Achieved', flowGroup: 'Service requests', disposed: 'Closed', pending: 'Open', items: 'requests', reference: 'Ticket no.' },
  money: { currency: 'PKR', symbol: 'Rs', scale: 1e6, scaleLabel: 'Millions', decimals: 2 },
};

/* ---------------- Generic public service organisation ---------------- */
export const publicService: Blueprint = {
  name: 'Public Service Delivery',
  industry: 'Public sector',
  levels: [
    { key: 'province', label: 'Province', plural: 'Provinces', profile: 'senior' },
    { key: 'district', label: 'District', plural: 'Districts', profile: 'senior' },
    { key: 'office', label: 'Office', plural: 'Offices', profile: 'staff' },
  ],
  posts: [
    { key: 'secretary', label: 'Secretary', levels: ['province'], single: true, scored: true, profile: 'senior', oversightAt: [], caps: ['assign_targets', 'compare'] },
    { key: 'district_officer', label: 'District Officer', levels: ['district'], single: true, scored: true, profile: 'senior', oversightAt: [], caps: ['assign_targets', 'compare'] },
    { key: 'officer', label: 'Office In-charge', levels: ['office'], single: true, scored: true, profile: 'staff', oversightAt: [], caps: ['assign_targets'] },
    { key: 'data_clerk', label: 'Data Clerk', levels: ['district'], single: false, scored: false, oversightAt: [], caps: ['set_targets', 'manage_registers'] },
  ],
  blocks: [
    { key: 'collection', label: 'Fee collection', kind: 'target' },
    { key: 'arrears', label: 'Arrears recovery', kind: 'arrears' },
    { key: 'services', label: 'Applications disposed', kind: 'flow' },
    { key: 'audit', label: 'Audit observations', kind: 'register' },
    { key: 'tasks', label: 'Tasks on time', kind: 'tasks' },
  ],
  tags: [],
  metrics: [
    m({ code: 'FEES', name: 'Service fees', group: 'Fees', block: 'collection', unit: 'money', level: 'office', enterPosts: ['officer', 'data_clerk'], verifyPosts: ['data_clerk'], weight: 1, arrears: true }),
    m({ code: 'APPLICATIONS', name: 'Applications', group: 'Services', block: 'services', unit: 'count', level: 'office', enterPosts: ['officer', 'data_clerk'], verifyPosts: ['data_clerk'] }),
    m({ code: 'COMPLAINTS', name: 'Public complaints', group: 'Complaints', block: 'services', unit: 'count', level: 'office', enterPosts: ['officer', 'data_clerk'], verifyPosts: ['data_clerk'] }),
  ],
  registers: [
    { key: 'audit', label: 'Audit observations', block: 'audit', levels: ['district', 'office'], enterPosts: ['data_clerk'], amountLabel: 'Recoverable', categories: ['Fees', 'Procurement', 'Establishment'] },
  ],
  profiles: [
    { key: 'staff', label: 'Office staff', weights: { collection: 35, arrears: 10, services: 35, audit: 10, tasks: 10 } },
    { key: 'senior', label: 'Senior officers', weights: { collection: 30, arrears: 10, services: 30, audit: 20, tasks: 10 } },
  ],
  bands: BANDS,
  calendar: { fyStartMonth: 7 },
  terms: { money: 'Fee collection', achieved: 'Collected', flowGroup: 'Applications', disposed: 'Disposed', pending: 'Pending', items: 'applications', reference: 'Receipt no.' },
  money: { currency: 'PKR', symbol: 'Rs', scale: 1e6, scaleLabel: 'Millions', decimals: 2 },
};

export const TEMPLATES: Record<string, { label: string; description: string; category: string; blueprint: Blueprint }> = {
  revenue_department: { label: 'Revenue Department (Board of Revenue)', category: 'Public sector', description: 'Division › District › Tehsil › Qanungoi › Patwar Circle › Mouza, revenue heads, case registers, audit paras.', blueprint: revenueDepartment },
  sales_company: { label: 'Sales & Marketing company', category: 'Sales & distribution', description: 'Company › Region › Branch › Territory, sales targets, lead conversion, complaints.', blueprint: salesCompany },
  hr_services: { label: 'HR Services provider', category: 'Services', description: 'Company › Practice › Team, placements, billing, service requests, grievances.', blueprint: hrServices },
  public_service: { label: 'Public service organisation', category: 'Public sector', description: 'Province › District › Office, fee collection, applications, audit observations.', blueprint: publicService },
  ...PK_TEMPLATES,
  blank: {
    label: 'Blank',
    category: 'Start from scratch',
    description: 'One level, one post, no KPIs — build everything yourself.',
    blueprint: {
      name: 'New organisation',
      levels: [{ key: 'organisation', label: 'Organisation', plural: 'Organisation', profile: 'default' }],
      posts: [{ key: 'head', label: 'Head', levels: ['organisation'], single: true, scored: true, oversightAt: [], caps: ['assign_targets', 'compare', 'set_targets', 'manage_registers'] }],
      blocks: [{ key: 'targets', label: 'Targets', kind: 'target' }, { key: 'tasks', label: 'Tasks on time', kind: 'tasks' }],
      metrics: [],
      registers: [],
      profiles: [{ key: 'default', label: 'Default', weights: { targets: 80, tasks: 20 } }],
      tags: [],
      bands: BANDS,
      calendar: { fyStartMonth: 1 },
      money: { currency: 'PKR', symbol: 'Rs', scale: 1e6, scaleLabel: 'Millions', decimals: 2 },
    },
  },
};
