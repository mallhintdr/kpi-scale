/**
 * Starter blueprints for the Pakistani market. Each is a compact spec expanded by `build()` into a
 * full blueprint: keys are derived from labels, scoring blocks come from the KPIs used, and weight
 * profiles are set for leadership levels and field staff. Every one is a starting point the
 * organisation's admin can edit freely.
 */
import type { BlueprintInput } from './blueprint.js';

type Cap = 'set_targets' | 'assign_targets' | 'compare' | 'manage_registers';
interface PostSpec { label: string; at: string[]; data?: boolean; caps?: Cap[]; single?: boolean }
interface KpiSpec {
  name: string; group?: string; flow?: boolean; unit?: 'money' | 'count' | 'number'; at: string;
  by: string[]; verify: string[]; weight?: number; arrears?: boolean; tag?: string;
}
interface Spec {
  name: string; industry: string; category: string; description: string;
  levels: (string | [string, string])[]; // label or [label, plural]
  posts: PostSpec[];
  kpis: KpiSpec[];
  register?: { label: string; at: string[]; by: string[]; categories: string[]; amount?: string };
  blocks?: { target?: string; flow?: string; arrears?: string };
  terms: { money: string; achieved: string; flowGroup: string; disposed: string; pending: string; items: string; reference: string };
  fyStartMonth?: number;
  money?: { scale: number; scaleLabel: string; decimals?: number };
  tags?: string[];
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'x$1').slice(0, 40);
const code = (s: string) => key(s).toUpperCase().slice(0, 40);
const BANDS = [
  { key: 'outstanding', label: 'Outstanding', min: 90 },
  { key: 'good', label: 'Good', min: 75 },
  { key: 'satisfactory', label: 'Satisfactory', min: 60 },
  { key: 'below', label: 'Below par', min: 40 },
  { key: 'poor', label: 'Poor', min: 0 },
];

function build(s: Spec): BlueprintInput {
  const levels = s.levels.map((l) => (Array.isArray(l) ? { label: l[0], plural: l[1] } : { label: l, plural: undefined }));
  const lk = (label: string) => {
    const l = levels.find((x) => x.label === label);
    if (!l) throw new Error(`${s.name}: unknown level "${label}"`);
    return key(l.label);
  };
  const pk = (label: string) => {
    if (!s.posts.some((p) => p.label === label)) throw new Error(`${s.name}: unknown post "${label}"`);
    return key(label);
  };
  const hasFlow = s.kpis.some((k) => k.flow);
  const hasArrears = s.kpis.some((k) => k.arrears);
  const blocks: BlueprintInput['blocks'] = [
    { key: 'achievement', label: s.blocks?.target ?? `${s.terms.money} achievement`, kind: 'target' },
    ...(hasArrears ? [{ key: 'arrears', label: s.blocks?.arrears ?? 'Arrears recovery', kind: 'arrears' as const }] : []),
    ...(hasFlow ? [{ key: 'workload', label: s.blocks?.flow ?? s.terms.flowGroup, kind: 'flow' as const }] : []),
    ...(s.register ? [{ key: 'register', label: s.register.label, kind: 'register' as const }] : []),
    { key: 'tasks', label: 'Tasks on time', kind: 'tasks' },
  ];
  const weights = (w: Record<string, number>) => {
    const present = Object.fromEntries(Object.entries(w).filter(([k]) => blocks.some((b) => b.key === k)));
    const total = Object.values(present).reduce((a, b) => a + b, 0);
    const out = Object.fromEntries(Object.entries(present).map(([k, v]) => [k, Math.round((v / total) * 100)]));
    const drift = 100 - Object.values(out).reduce((a, b) => a + b, 0);
    out.achievement += drift;
    return out;
  };
  const field = levels.length - 1;
  return {
    name: s.name,
    industry: s.industry,
    levels: levels.map((l, i) => ({ key: key(l.label), label: l.label, ...(l.plural ? { plural: l.plural } : {}), profile: i === field ? 'field' : i === 0 ? 'leadership' : 'managers' })),
    posts: s.posts.map((p) => ({
      key: key(p.label), label: p.label, levels: p.at.map(lk), single: p.single ?? false, scored: !p.data,
      oversightAt: [], exclusiveWith: [], caps: p.caps ?? [],
      ...(p.data ? {} : { profile: p.at.some((a) => lk(a) === key(levels[field].label)) ? 'field' : p.at.some((a) => lk(a) === key(levels[0].label)) ? 'leadership' : 'managers' }),
    })),
    blocks,
    tags: (s.tags ?? []).map((t) => ({ key: key(t), label: t })),
    metrics: s.kpis.map((k) => ({
      code: code(k.name), name: k.name, group: k.group ?? k.name, block: k.flow ? 'workload' : 'achievement',
      unit: k.unit ?? (k.flow ? 'count' : 'money'), level: lk(k.at), perHolder: false, holderPosts: [],
      enterPosts: k.by.map(pk), verifyPosts: k.verify.map(pk), weight: k.weight ?? 1, arrears: !!k.arrears, active: true,
      ...(k.tag ? { tag: key(k.tag) } : {}),
    })),
    registers: s.register
      ? [{ key: 'register', label: s.register.label, block: 'register', levels: s.register.at.map(lk), enterPosts: s.register.by.map(pk), categories: s.register.categories, amountLabel: s.register.amount ?? 'Amount' }]
      : [],
    profiles: [
      { key: 'field', label: 'Field staff', weights: weights({ achievement: 50, arrears: 10, workload: 25, register: 5, tasks: 10 }) },
      { key: 'managers', label: 'Managers', weights: weights({ achievement: 40, arrears: 15, workload: 20, register: 15, tasks: 10 }) },
      { key: 'leadership', label: 'Leadership', weights: weights({ achievement: 40, arrears: 15, workload: 15, register: 20, tasks: 10 }) },
    ],
    bands: BANDS,
    calendar: { fyStartMonth: s.fyStartMonth ?? 7 },
    money: { currency: 'PKR', symbol: 'Rs', scale: s.money?.scale ?? 1e6, scaleLabel: s.money?.scaleLabel ?? 'Millions', decimals: s.money?.decimals ?? 2 },
    terms: s.terms,
  };
}

const LAKH = { scale: 1e5, scaleLabel: 'Lakhs', decimals: 2 };

/* ======================================================================== *
 *  Specs
 * ======================================================================== */
export const PK_SPECS: Record<string, Spec> = {
  /* ---------------- Public sector ---------------- */
  police: {
    name: 'Police', industry: 'Public sector', category: 'Public sector',
    description: 'Region › District › Circle › Police Station — FIRs, challans, recoveries, complaints.',
    levels: ['Region', 'District', 'Circle', ['Police Station', 'Police Stations']],
    posts: [
      { label: 'RPO', at: ['Region'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'DPO', at: ['District'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'SDPO', at: ['Circle'], single: true, caps: ['assign_targets'] },
      { label: 'SHO', at: ['Police Station'], single: true },
      { label: 'Moharrir', at: ['Police Station'], data: true, caps: ['manage_registers'] },
      { label: 'District Crime Clerk', at: ['District'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'FIRs investigated', group: 'Investigation', flow: true, at: 'Police Station', by: ['Moharrir', 'SHO'], verify: ['District Crime Clerk'], weight: 3 },
      { name: 'Challans submitted', group: 'Prosecution', flow: true, at: 'Police Station', by: ['Moharrir'], verify: ['District Crime Clerk'], weight: 2 },
      { name: 'Proclaimed offenders arrested', group: 'Arrests', unit: 'count', at: 'Police Station', by: ['Moharrir'], verify: ['District Crime Clerk'], weight: 2 },
      { name: 'Stolen property recovered', group: 'Recovery', at: 'Police Station', by: ['Moharrir'], verify: ['District Crime Clerk'], weight: 2 },
      { name: 'Traffic fines', group: 'Fines', at: 'Police Station', by: ['Moharrir'], verify: ['District Crime Clerk'], weight: 1 },
    ],
    register: { label: 'Public complaints', at: ['District', 'Police Station'], by: ['Moharrir', 'District Crime Clerk'], categories: ['8787 portal', 'Citizen portal', 'Front desk', 'Inquiry'], amount: 'Amount involved' },
    blocks: { target: 'Recovery & enforcement', flow: 'Case disposal' },
    terms: { money: 'Recoveries', achieved: 'Achieved', flowGroup: 'Case registers', disposed: 'Disposed', pending: 'Pending', items: 'cases', reference: 'FIR / DD no.' },
  },
  excise_taxation: {
    name: 'Excise, Taxation & Narcotics', industry: 'Public sector', category: 'Public sector',
    description: 'Division › District › Circle — property tax, motor vehicle tax, professional tax with arrears.',
    levels: ['Division', 'District', 'Circle'],
    posts: [
      { label: 'Director', at: ['Division'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Excise & Taxation Officer', at: ['District'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Excise & Taxation Inspector', at: ['Circle'] },
      { label: 'Assessment Clerk', at: ['District'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Urban immovable property tax', group: 'Property tax', at: 'Circle', by: ['Excise & Taxation Inspector', 'Assessment Clerk'], verify: ['Assessment Clerk'], weight: 4, arrears: true },
      { name: 'Motor vehicle tax', group: 'Motor vehicles', at: 'Circle', by: ['Assessment Clerk'], verify: ['Assessment Clerk'], weight: 3, arrears: true },
      { name: 'Professional tax', group: 'Professional tax', at: 'Circle', by: ['Excise & Taxation Inspector', 'Assessment Clerk'], verify: ['Assessment Clerk'], weight: 2, arrears: true },
      { name: 'Excise duty', group: 'Excise', at: 'Circle', by: ['Assessment Clerk'], verify: ['Assessment Clerk'], weight: 1 },
      { name: 'Property surveys', group: 'Surveys', flow: true, at: 'Circle', by: ['Excise & Taxation Inspector'], verify: ['Assessment Clerk'] },
    ],
    register: { label: 'Audit observations', at: ['District', 'Circle'], by: ['Assessment Clerk'], categories: ['Property tax', 'Motor vehicles', 'Professional tax', 'Excise'], amount: 'Recoverable' },
    terms: { money: 'Tax collection', achieved: 'Collected', flowGroup: 'Assessments', disposed: 'Completed', pending: 'Pending', items: 'surveys', reference: 'Challan no.' },
  },
  local_government: {
    name: 'Local Government (Municipal)', industry: 'Public sector', category: 'Public sector',
    description: 'District › Municipal Committee › Union Council — own-source revenue, licences, complaints.',
    levels: ['District', ['Municipal Committee', 'Municipal Committees'], 'Union Council'],
    posts: [
      { label: 'Chief Officer', at: ['District'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Municipal Officer', at: ['Municipal Committee'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'UC Secretary', at: ['Union Council'], single: true },
      { label: 'Revenue Clerk', at: ['Municipal Committee'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Property & conservancy fee', group: 'Own-source revenue', at: 'Union Council', by: ['UC Secretary', 'Revenue Clerk'], verify: ['Revenue Clerk'], weight: 3, arrears: true },
      { name: 'Trade licence fee', group: 'Licences', at: 'Union Council', by: ['UC Secretary', 'Revenue Clerk'], verify: ['Revenue Clerk'], weight: 2, arrears: true },
      { name: 'Building plan fee', group: 'Building control', at: 'Union Council', by: ['Revenue Clerk'], verify: ['Revenue Clerk'], weight: 2 },
      { name: 'Birth & death registrations', group: 'Civil registration', flow: true, at: 'Union Council', by: ['UC Secretary'], verify: ['Revenue Clerk'] },
      { name: 'Citizen complaints', group: 'Service delivery', flow: true, at: 'Union Council', by: ['UC Secretary'], verify: ['Revenue Clerk'] },
    ],
    register: { label: 'Encroachment cases', at: ['Union Council'], by: ['UC Secretary', 'Revenue Clerk'], categories: ['Roads', 'Markets', 'Parks', 'Drains'], amount: 'Fine imposed' },
    terms: { money: 'Own-source revenue', achieved: 'Collected', flowGroup: 'Service requests', disposed: 'Resolved', pending: 'Pending', items: 'requests', reference: 'Receipt no.' },
  },
  health_department: {
    name: 'District Health Authority', industry: 'Health', category: 'Public sector',
    description: 'District › Tehsil › Health Facility (BHU / RHC) — immunisation, OPD, deliveries, user charges.',
    levels: ['District', 'Tehsil', ['Health Facility', 'Health Facilities']],
    posts: [
      { label: 'CEO Health', at: ['District'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'DDHO', at: ['Tehsil'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Medical Officer', at: ['Health Facility'], single: true },
      { label: 'Vaccinator', at: ['Health Facility'] },
      { label: 'DHIS Coordinator', at: ['District'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Children fully immunised', group: 'EPI', unit: 'count', at: 'Health Facility', by: ['Vaccinator', 'Medical Officer'], verify: ['DHIS Coordinator'], weight: 4 },
      { name: 'Institutional deliveries', group: 'Maternal health', unit: 'count', at: 'Health Facility', by: ['Medical Officer'], verify: ['DHIS Coordinator'], weight: 3 },
      { name: 'Antenatal visits', group: 'Maternal health', unit: 'count', at: 'Health Facility', by: ['Medical Officer'], verify: ['DHIS Coordinator'], weight: 2 },
      { name: 'User charges', group: 'Revenue', at: 'Health Facility', by: ['Medical Officer'], verify: ['DHIS Coordinator'], weight: 1 },
      { name: 'OPD patients referred', group: 'Referrals', flow: true, at: 'Health Facility', by: ['Medical Officer'], verify: ['DHIS Coordinator'] },
    ],
    register: { label: 'Medicine stock-outs', at: ['Health Facility'], by: ['Medical Officer', 'DHIS Coordinator'], categories: ['Essential medicines', 'Vaccines', 'Contraceptives', 'Equipment'], amount: 'Value' },
    blocks: { target: 'Service coverage', flow: 'Referral follow-up' },
    terms: { money: 'User charges', achieved: 'Achieved', flowGroup: 'Referrals', disposed: 'Completed', pending: 'Pending', items: 'patients', reference: 'Register no.' },
  },
  school_education: {
    name: 'School Education Department', industry: 'Education', category: 'Public sector',
    description: 'District › Tehsil › Markaz › School — enrolment, attendance, results, non-salary budget.',
    levels: ['District', 'Tehsil', 'Markaz', 'School'],
    posts: [
      { label: 'CEO Education', at: ['District'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'DEO', at: ['Tehsil'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'AEO', at: ['Markaz'], caps: ['assign_targets'] },
      { label: 'Head Teacher', at: ['School'], single: true },
      { label: 'MEA', at: ['District'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'New enrolment', group: 'Enrolment', unit: 'count', at: 'School', by: ['Head Teacher'], verify: ['MEA', 'AEO'], weight: 4 },
      { name: 'Student attendance days', group: 'Attendance', unit: 'number', at: 'School', by: ['Head Teacher'], verify: ['AEO'], weight: 3 },
      { name: 'Students passing board exams', group: 'Results', unit: 'count', at: 'School', by: ['Head Teacher'], verify: ['MEA'], weight: 3 },
      { name: 'Non-salary budget utilised', group: 'Budget', at: 'School', by: ['Head Teacher'], verify: ['MEA'], weight: 1 },
      { name: 'Missing facilities', group: 'Facilities', flow: true, at: 'School', by: ['Head Teacher'], verify: ['AEO'] },
    ],
    register: { label: 'Inspection observations', at: ['School'], by: ['AEO', 'MEA'], categories: ['Teacher absence', 'Facilities', 'Cleanliness', 'Records'], amount: 'Amount' },
    blocks: { target: 'Learning outcomes', flow: 'Facility gaps closed' },
    terms: { money: 'Budget', achieved: 'Achieved', flowGroup: 'Facilities', disposed: 'Provided', pending: 'Missing', items: 'facilities', reference: 'Visit no.' },
    fyStartMonth: 7,
  },
  agriculture_extension: {
    name: 'Agriculture Extension', industry: 'Agriculture', category: 'Public sector',
    description: 'District › Tehsil › Markaz › Field Assistant beat — farmer outreach, demos, soil & water tests.',
    levels: ['District', 'Tehsil', 'Markaz', ['Beat', 'Beats']],
    posts: [
      { label: 'Deputy Director Agriculture', at: ['District'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Assistant Director', at: ['Tehsil'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Agriculture Officer', at: ['Markaz'], caps: ['assign_targets'] },
      { label: 'Field Assistant', at: ['Beat'] },
      { label: 'Data Assistant', at: ['District'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    tags: ['Rabi', 'Kharif'],
    kpis: [
      { name: 'Farmers trained — Rabi', group: 'Farmer training', unit: 'count', at: 'Beat', by: ['Field Assistant'], verify: ['Agriculture Officer'], weight: 3, tag: 'Rabi' },
      { name: 'Farmers trained — Kharif', group: 'Farmer training', unit: 'count', at: 'Beat', by: ['Field Assistant'], verify: ['Agriculture Officer'], weight: 3, tag: 'Kharif' },
      { name: 'Demonstration plots', group: 'Demonstrations', unit: 'count', at: 'Beat', by: ['Field Assistant'], verify: ['Agriculture Officer'], weight: 2 },
      { name: 'Soil & water samples', group: 'Testing', unit: 'count', at: 'Beat', by: ['Field Assistant'], verify: ['Data Assistant'], weight: 2 },
      { name: 'Kissan card registrations', group: 'Registrations', flow: true, at: 'Beat', by: ['Field Assistant'], verify: ['Data Assistant'] },
    ],
    register: { label: 'Pest attack reports', at: ['Beat'], by: ['Field Assistant', 'Data Assistant'], categories: ['Cotton', 'Wheat', 'Rice', 'Sugarcane', 'Maize'], amount: 'Area (acres)' },
    blocks: { target: 'Outreach' },
    terms: { money: 'Outreach', achieved: 'Achieved', flowGroup: 'Registrations', disposed: 'Completed', pending: 'Pending', items: 'applications', reference: 'Register no.' },
  },
  electricity_disco: {
    name: 'Electricity Distribution (DISCO)', industry: 'Utilities', category: 'Public sector',
    description: 'Circle › Division › Sub-division — bill recovery with arrears, connections, complaints, line losses.',
    levels: ['Circle', 'Division', ['Sub-division', 'Sub-divisions']],
    posts: [
      { label: 'Superintending Engineer', at: ['Circle'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Executive Engineer', at: ['Division'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'SDO', at: ['Sub-division'], single: true },
      { label: 'Revenue Officer', at: ['Division'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Bill recovery', group: 'Recovery', at: 'Sub-division', by: ['SDO', 'Revenue Officer'], verify: ['Revenue Officer'], weight: 5, arrears: true },
      { name: 'Detection bills', group: 'Theft control', at: 'Sub-division', by: ['SDO'], verify: ['Revenue Officer'], weight: 2, arrears: true },
      { name: 'New connections', group: 'Connections', flow: true, at: 'Sub-division', by: ['SDO'], verify: ['Revenue Officer'], weight: 2 },
      { name: 'Consumer complaints', group: 'Complaints', flow: true, at: 'Sub-division', by: ['SDO'], verify: ['Revenue Officer'], weight: 1 },
    ],
    register: { label: 'Theft cases (FIRs)', at: ['Sub-division'], by: ['SDO', 'Revenue Officer'], categories: ['Direct hook', 'Meter tampering', 'Bypass'], amount: 'Detection amount' },
    blocks: { target: 'Recovery', flow: 'Service requests' },
    terms: { money: 'Recovery', achieved: 'Recovered', flowGroup: 'Service requests', disposed: 'Resolved', pending: 'Pending', items: 'requests', reference: 'Reference no.' },
  },

  /* ---------------- Banking & finance ---------------- */
  commercial_bank: {
    name: 'Commercial Bank — Branch Network', industry: 'Banking', category: 'Banking & finance',
    description: 'Region › Area › Branch — deposits, advances, recovery, accounts, digital adoption, complaints.',
    levels: ['Region', 'Area', 'Branch'],
    posts: [
      { label: 'Regional Head', at: ['Region'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Area Manager', at: ['Area'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Branch Manager', at: ['Branch'], single: true, caps: ['assign_targets'] },
      { label: 'Relationship Officer', at: ['Branch'] },
      { label: 'Operations Manager', at: ['Branch'], data: true, caps: ['manage_registers'] },
      { label: 'Regional MIS Officer', at: ['Region'], data: true, caps: ['set_targets'] },
    ],
    kpis: [
      { name: 'Deposits mobilised', group: 'Deposits', at: 'Branch', by: ['Operations Manager'], verify: ['Regional MIS Officer'], weight: 4 },
      { name: 'CASA deposits', group: 'Deposits', at: 'Branch', by: ['Operations Manager'], verify: ['Regional MIS Officer'], weight: 2 },
      { name: 'Advances disbursed', group: 'Advances', at: 'Branch', by: ['Operations Manager'], verify: ['Regional MIS Officer'], weight: 3 },
      { name: 'Loan recovery', group: 'Recovery', at: 'Branch', by: ['Operations Manager'], verify: ['Regional MIS Officer'], weight: 3, arrears: true },
      { name: 'New accounts', group: 'Customers', unit: 'count', at: 'Branch', by: ['Relationship Officer', 'Operations Manager'], verify: ['Regional MIS Officer'], weight: 2 },
      { name: 'Digital banking activations', group: 'Digital', unit: 'count', at: 'Branch', by: ['Relationship Officer', 'Operations Manager'], verify: ['Regional MIS Officer'], weight: 1 },
      { name: 'Customer complaints', group: 'Complaints', flow: true, at: 'Branch', by: ['Operations Manager'], verify: ['Regional MIS Officer'] },
    ],
    register: { label: 'Audit & compliance observations', at: ['Branch'], by: ['Operations Manager'], categories: ['KYC / AML', 'Credit', 'Operations', 'Cash'], amount: 'Exposure' },
    blocks: { target: 'Business growth', arrears: 'Non-performing recovery', flow: 'Complaint resolution' },
    terms: { money: 'Business', achieved: 'Achieved', flowGroup: 'Complaints', disposed: 'Resolved', pending: 'Open', items: 'complaints', reference: 'Ref. no.' },
    fyStartMonth: 1,
  },
  microfinance: {
    name: 'Microfinance Bank / Institution', industry: 'Microfinance', category: 'Banking & finance',
    description: 'Region › Area › Branch › Loan Officer portfolio — disbursement, recovery, PAR, clients.',
    levels: ['Region', 'Area', 'Branch', ['Portfolio', 'Portfolios']],
    posts: [
      { label: 'Regional Manager', at: ['Region'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Area Manager', at: ['Area'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Branch Manager', at: ['Branch'], single: true, caps: ['assign_targets'] },
      { label: 'Loan Officer', at: ['Portfolio'], single: true },
      { label: 'Branch Accountant', at: ['Branch'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Loans disbursed', group: 'Disbursement', at: 'Portfolio', by: ['Branch Accountant'], verify: ['Branch Accountant'], weight: 3 },
      { name: 'Instalments recovered', group: 'Recovery', at: 'Portfolio', by: ['Loan Officer', 'Branch Accountant'], verify: ['Branch Accountant'], weight: 5, arrears: true },
      { name: 'New clients', group: 'Outreach', unit: 'count', at: 'Portfolio', by: ['Loan Officer'], verify: ['Branch Accountant'], weight: 2 },
      { name: 'Savings mobilised', group: 'Savings', at: 'Portfolio', by: ['Branch Accountant'], verify: ['Branch Accountant'], weight: 1 },
      { name: 'Loan applications', group: 'Appraisal', flow: true, at: 'Portfolio', by: ['Loan Officer'], verify: ['Branch Accountant'] },
    ],
    register: { label: 'Overdue cases (PAR 30+)', at: ['Portfolio'], by: ['Loan Officer', 'Branch Accountant'], categories: ['Business loss', 'Migration', 'Wilful default', 'Death / disability'], amount: 'Outstanding' },
    blocks: { target: 'Portfolio growth', arrears: 'Overdue recovery', flow: 'Application processing' },
    terms: { money: 'Portfolio', achieved: 'Achieved', flowGroup: 'Applications', disposed: 'Processed', pending: 'Pending', items: 'applications', reference: 'Loan no.' },
    fyStartMonth: 1,
  },
  insurance_takaful: {
    name: 'Insurance / Takaful Agency', industry: 'Insurance', category: 'Banking & finance',
    description: 'Zone › Branch › Sales Team — new premium, renewals, policies, claims settlement.',
    levels: ['Zone', 'Branch', ['Sales Team', 'Sales Teams']],
    posts: [
      { label: 'Zonal Head', at: ['Zone'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Branch Manager', at: ['Branch'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Sales Manager', at: ['Sales Team'], single: true },
      { label: 'Branch Admin', at: ['Branch'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'New business premium', group: 'Premium', at: 'Sales Team', by: ['Sales Manager', 'Branch Admin'], verify: ['Branch Admin'], weight: 5 },
      { name: 'Renewal premium', group: 'Premium', at: 'Sales Team', by: ['Branch Admin'], verify: ['Branch Admin'], weight: 3, arrears: true },
      { name: 'Policies issued', group: 'Policies', unit: 'count', at: 'Sales Team', by: ['Sales Manager', 'Branch Admin'], verify: ['Branch Admin'], weight: 2 },
      { name: 'Claims', group: 'Claims', flow: true, at: 'Sales Team', by: ['Branch Admin'], verify: ['Branch Admin'] },
    ],
    register: { label: 'Customer complaints', at: ['Branch'], by: ['Branch Admin'], categories: ['Mis-selling', 'Claims', 'Service', 'Refund'], amount: 'Amount' },
    blocks: { target: 'Premium', arrears: 'Lapsed renewals', flow: 'Claims settlement' },
    terms: { money: 'Premium', achieved: 'Achieved', flowGroup: 'Claims', disposed: 'Settled', pending: 'Pending', items: 'claims', reference: 'Policy no.' },
    fyStartMonth: 1,
  },

  /* ---------------- Sales & distribution ---------------- */
  fmcg_distribution: {
    name: 'FMCG Distribution', industry: 'FMCG', category: 'Sales & distribution',
    description: 'Region › Distributor › Order Booker route — primary & secondary sales, coverage, collections.',
    levels: ['Region', 'Distributor', ['Route', 'Routes']],
    posts: [
      { label: 'Regional Sales Manager', at: ['Region'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Area Sales Manager', at: ['Distributor'], caps: ['assign_targets', 'compare'] },
      { label: 'Order Booker', at: ['Route'], single: true },
      { label: 'Distributor Accountant', at: ['Distributor'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Secondary sales', group: 'Sales', at: 'Route', by: ['Order Booker', 'Distributor Accountant'], verify: ['Distributor Accountant'], weight: 5 },
      { name: 'Credit collections', group: 'Collections', at: 'Route', by: ['Distributor Accountant'], verify: ['Distributor Accountant'], weight: 2, arrears: true },
      { name: 'Productive outlets', group: 'Coverage', unit: 'count', at: 'Route', by: ['Order Booker'], verify: ['Distributor Accountant'], weight: 2 },
      { name: 'New outlets opened', group: 'Coverage', unit: 'count', at: 'Route', by: ['Order Booker'], verify: ['Distributor Accountant'], weight: 1 },
      { name: 'Primary sales', group: 'Primary', at: 'Distributor', by: ['Distributor Accountant'], verify: ['Distributor Accountant'], weight: 3 },
    ],
    register: { label: 'Market returns & claims', at: ['Distributor'], by: ['Distributor Accountant'], categories: ['Expired', 'Damaged', 'Short supply', 'Scheme claim'], amount: 'Value' },
    blocks: { target: 'Sales & coverage', arrears: 'Market credit' },
    terms: { money: 'Sales', achieved: 'Achieved', flowGroup: 'Orders', disposed: 'Delivered', pending: 'Pending', items: 'orders', reference: 'Invoice no.' },
  },
  pharma_sales: {
    name: 'Pharmaceutical Sales Force', industry: 'Pharmaceuticals', category: 'Sales & distribution',
    description: 'Zone › Region › Territory — sales vs target, doctor calls, coverage, new prescribers.',
    levels: ['Zone', 'Region', ['Territory', 'Territories']],
    posts: [
      { label: 'Zonal Sales Manager', at: ['Zone'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'District Manager', at: ['Region'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Medical Rep', at: ['Territory'], single: true },
      { label: 'Sales Analyst', at: ['Zone'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Territory sales', group: 'Sales', at: 'Territory', by: ['Sales Analyst'], verify: ['Sales Analyst'], weight: 5 },
      { name: 'Doctor calls', group: 'Calls', unit: 'count', at: 'Territory', by: ['Medical Rep'], verify: ['Sales Analyst'], weight: 3 },
      { name: 'New prescribers', group: 'Coverage', unit: 'count', at: 'Territory', by: ['Medical Rep'], verify: ['Sales Analyst'], weight: 2 },
      { name: 'Chemist coverage', group: 'Coverage', unit: 'count', at: 'Territory', by: ['Medical Rep'], verify: ['Sales Analyst'], weight: 1 },
    ],
    register: { label: 'Product complaints', at: ['Territory'], by: ['Medical Rep', 'Sales Analyst'], categories: ['Quality', 'Availability', 'Adverse event', 'Pricing'], amount: 'Value' },
    blocks: { target: 'Sales & coverage' },
    terms: { money: 'Sales', achieved: 'Achieved', flowGroup: 'Requests', disposed: 'Closed', pending: 'Open', items: 'requests', reference: 'Invoice no.' },
    fyStartMonth: 1,
  },
  telecom_retail: {
    name: 'Telecom Franchise & Retail', industry: 'Telecom', category: 'Sales & distribution',
    description: 'Region › Franchise › Retail cluster — SIM sales, recharge, digital wallet, device sales.',
    levels: ['Region', 'Franchise', ['Cluster', 'Clusters']],
    posts: [
      { label: 'Regional Business Manager', at: ['Region'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Franchise Owner', at: ['Franchise'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Territory Sales Officer', at: ['Cluster'] },
      { label: 'Franchise Back Office', at: ['Franchise'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Gross SIM additions', group: 'Acquisition', unit: 'count', at: 'Cluster', by: ['Territory Sales Officer', 'Franchise Back Office'], verify: ['Franchise Back Office'], weight: 4 },
      { name: 'Recharge sales', group: 'Revenue', at: 'Cluster', by: ['Franchise Back Office'], verify: ['Franchise Back Office'], weight: 4 },
      { name: 'Mobile wallet accounts', group: 'Digital', unit: 'count', at: 'Cluster', by: ['Territory Sales Officer'], verify: ['Franchise Back Office'], weight: 2 },
      { name: 'Device sales', group: 'Devices', at: 'Cluster', by: ['Franchise Back Office'], verify: ['Franchise Back Office'], weight: 1 },
      { name: 'Retailer onboarding', group: 'Retail network', flow: true, at: 'Cluster', by: ['Territory Sales Officer'], verify: ['Franchise Back Office'] },
    ],
    register: { label: 'Customer complaints', at: ['Franchise'], by: ['Franchise Back Office'], categories: ['Network', 'Billing', 'SIM / biometric', 'Wallet'], amount: 'Amount' },
    blocks: { target: 'Sales & acquisition', flow: 'Retail network' },
    terms: { money: 'Sales', achieved: 'Achieved', flowGroup: 'Onboarding', disposed: 'Activated', pending: 'Pending', items: 'retailers', reference: 'Transaction ID' },
    fyStartMonth: 1,
  },
  real_estate: {
    name: 'Real Estate & Housing Society', industry: 'Real estate', category: 'Sales & distribution',
    description: 'Head office › Sales team › Agent desk — bookings, instalment recovery, transfers, possession.',
    levels: [['Head Office', 'Head Office'], ['Sales Team', 'Sales Teams'], ['Desk', 'Desks']],
    posts: [
      { label: 'Director Sales', at: ['Head Office'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Team Lead', at: ['Sales Team'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Property Consultant', at: ['Desk'] },
      { label: 'Accounts Officer', at: ['Head Office'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Bookings value', group: 'Bookings', at: 'Desk', by: ['Property Consultant', 'Accounts Officer'], verify: ['Accounts Officer'], weight: 4 },
      { name: 'Instalments recovered', group: 'Recovery', at: 'Desk', by: ['Accounts Officer'], verify: ['Accounts Officer'], weight: 4, arrears: true },
      { name: 'Plots / units booked', group: 'Bookings', unit: 'count', at: 'Desk', by: ['Property Consultant'], verify: ['Accounts Officer'], weight: 2 },
      { name: 'Transfer requests', group: 'Transfers', flow: true, at: 'Desk', by: ['Accounts Officer'], verify: ['Accounts Officer'] },
    ],
    register: { label: 'Customer disputes', at: ['Head Office'], by: ['Accounts Officer'], categories: ['Possession delay', 'Refund', 'Allotment', 'Development'], amount: 'Amount' },
    blocks: { target: 'Sales', arrears: 'Overdue instalments', flow: 'Transfers' },
    terms: { money: 'Sales', achieved: 'Achieved', flowGroup: 'Transfers', disposed: 'Completed', pending: 'Pending', items: 'files', reference: 'File no.' },
    money: LAKH,
    fyStartMonth: 1,
  },

  /* ---------------- Services ---------------- */
  school_chain: {
    name: 'Private School / College Chain', industry: 'Education', category: 'Services',
    description: 'Region › Campus › Section — admissions, fee collection with arrears, results, parent complaints.',
    levels: ['Region', 'Campus', ['Section', 'Sections']],
    posts: [
      { label: 'Regional Director', at: ['Region'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Principal', at: ['Campus'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Section Head', at: ['Section'], single: true },
      { label: 'Campus Accountant', at: ['Campus'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Fee collection', group: 'Fees', at: 'Section', by: ['Campus Accountant'], verify: ['Campus Accountant'], weight: 4, arrears: true },
      { name: 'New admissions', group: 'Admissions', unit: 'count', at: 'Section', by: ['Section Head'], verify: ['Campus Accountant'], weight: 3 },
      { name: 'Students achieving A grade', group: 'Results', unit: 'count', at: 'Section', by: ['Section Head'], verify: ['Principal'], weight: 3 },
      { name: 'Student retention', group: 'Retention', unit: 'count', at: 'Section', by: ['Section Head'], verify: ['Campus Accountant'], weight: 1 },
      { name: 'Admission inquiries', group: 'Inquiries', flow: true, at: 'Section', by: ['Section Head'], verify: ['Campus Accountant'] },
    ],
    register: { label: 'Parent complaints', at: ['Campus'], by: ['Campus Accountant'], categories: ['Academics', 'Fees', 'Transport', 'Discipline'], amount: 'Amount' },
    blocks: { target: 'Admissions & fees', arrears: 'Fee defaulters', flow: 'Inquiry conversion' },
    terms: { money: 'Fee collection', achieved: 'Collected', flowGroup: 'Inquiries', disposed: 'Converted', pending: 'Open', items: 'inquiries', reference: 'Voucher no.' },
    money: LAKH,
    fyStartMonth: 4,
  },
  hospital: {
    name: 'Private Hospital / Healthcare Network', industry: 'Healthcare', category: 'Services',
    description: 'Network › Hospital › Department — patient revenue, OPD, admissions, lab tests, panel recovery.',
    levels: ['Network', 'Hospital', ['Department', 'Departments']],
    posts: [
      { label: 'CEO', at: ['Network'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Medical Director', at: ['Hospital'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Head of Department', at: ['Department'], single: true },
      { label: 'Billing Officer', at: ['Hospital'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Patient revenue', group: 'Revenue', at: 'Department', by: ['Billing Officer'], verify: ['Billing Officer'], weight: 4 },
      { name: 'Panel / corporate receivables', group: 'Receivables', at: 'Department', by: ['Billing Officer'], verify: ['Billing Officer'], weight: 2, arrears: true },
      { name: 'OPD visits', group: 'Volume', unit: 'count', at: 'Department', by: ['Head of Department', 'Billing Officer'], verify: ['Billing Officer'], weight: 2 },
      { name: 'Admissions', group: 'Volume', unit: 'count', at: 'Department', by: ['Head of Department'], verify: ['Billing Officer'], weight: 2 },
      { name: 'Lab & radiology tests', group: 'Diagnostics', flow: true, at: 'Department', by: ['Head of Department'], verify: ['Billing Officer'] },
    ],
    register: { label: 'Patient complaints & incidents', at: ['Hospital', 'Department'], by: ['Billing Officer'], categories: ['Clinical', 'Billing', 'Waiting time', 'Staff behaviour'], amount: 'Amount' },
    blocks: { target: 'Revenue & volume', arrears: 'Receivables', flow: 'Reports delivered' },
    terms: { money: 'Revenue', achieved: 'Achieved', flowGroup: 'Diagnostics', disposed: 'Reported', pending: 'Pending', items: 'tests', reference: 'MR no.' },
    fyStartMonth: 7,
  },
  courier_logistics: {
    name: 'Courier & Logistics', industry: 'Logistics', category: 'Services',
    description: 'Region › Hub › Route — deliveries, COD remittance, first-attempt success, complaints.',
    levels: ['Region', 'Hub', ['Route', 'Routes']],
    posts: [
      { label: 'Regional Operations Manager', at: ['Region'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Hub Manager', at: ['Hub'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Rider', at: ['Route'] },
      { label: 'Hub Supervisor', at: ['Hub'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Shipments', group: 'Deliveries', flow: true, at: 'Route', by: ['Rider', 'Hub Supervisor'], verify: ['Hub Supervisor'], weight: 4 },
      { name: 'COD remitted', group: 'Cash on delivery', at: 'Route', by: ['Hub Supervisor'], verify: ['Hub Supervisor'], weight: 4, arrears: true },
      { name: 'First-attempt deliveries', group: 'Quality', unit: 'count', at: 'Route', by: ['Rider'], verify: ['Hub Supervisor'], weight: 2 },
      { name: 'Pickups completed', group: 'Pickups', unit: 'count', at: 'Route', by: ['Rider'], verify: ['Hub Supervisor'], weight: 1 },
    ],
    register: { label: 'Lost & damaged shipments', at: ['Hub'], by: ['Hub Supervisor'], categories: ['Lost', 'Damaged', 'Wrong delivery', 'Delay claim'], amount: 'Claim value' },
    blocks: { target: 'COD & quality', arrears: 'COD outstanding', flow: 'Delivery success' },
    terms: { money: 'COD', achieved: 'Remitted', flowGroup: 'Shipments', disposed: 'Delivered', pending: 'Undelivered', items: 'shipments', reference: 'Tracking no.' },
    fyStartMonth: 1,
  },
  ngo_programme: {
    name: 'NGO / Development Programme', industry: 'Development sector', category: 'Services',
    description: 'Province › District › Field Office — beneficiaries reached, disbursements, trainings, grievances.',
    levels: ['Province', 'District', ['Field Office', 'Field Offices']],
    posts: [
      { label: 'Programme Manager', at: ['Province'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'District Coordinator', at: ['District'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Social Mobiliser', at: ['Field Office'] },
      { label: 'M&E Officer', at: ['District'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Beneficiaries reached', group: 'Outreach', unit: 'count', at: 'Field Office', by: ['Social Mobiliser'], verify: ['M&E Officer'], weight: 4 },
      { name: 'Grants / loans disbursed', group: 'Disbursement', at: 'Field Office', by: ['M&E Officer'], verify: ['M&E Officer'], weight: 3 },
      { name: 'Trainings conducted', group: 'Capacity building', unit: 'count', at: 'Field Office', by: ['Social Mobiliser'], verify: ['M&E Officer'], weight: 2 },
      { name: 'Community organisations formed', group: 'Mobilisation', unit: 'count', at: 'Field Office', by: ['Social Mobiliser'], verify: ['M&E Officer'], weight: 1 },
      { name: 'Beneficiary verifications', group: 'Verification', flow: true, at: 'Field Office', by: ['Social Mobiliser'], verify: ['M&E Officer'] },
    ],
    register: { label: 'Grievances', at: ['District', 'Field Office'], by: ['M&E Officer'], categories: ['Eligibility', 'Payment', 'Staff conduct', 'Delay'], amount: 'Amount' },
    blocks: { target: 'Programme delivery', flow: 'Verification' },
    terms: { money: 'Disbursement', achieved: 'Achieved', flowGroup: 'Verifications', disposed: 'Completed', pending: 'Pending', items: 'cases', reference: 'Beneficiary ID' },
  },
  it_services: {
    name: 'IT & Software Services', industry: 'Technology', category: 'Services',
    description: 'Company › Business Unit › Team — billable hours, invoicing & receivables, tickets, deliveries.',
    levels: ['Company', ['Business Unit', 'Business Units'], 'Team'],
    posts: [
      { label: 'CEO', at: ['Company'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Delivery Head', at: ['Business Unit'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Team Lead', at: ['Team'], single: true },
      { label: 'PMO Analyst', at: ['Company'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Revenue invoiced', group: 'Revenue', at: 'Team', by: ['PMO Analyst'], verify: ['PMO Analyst'], weight: 4, arrears: true },
      { name: 'Billable hours', group: 'Utilisation', unit: 'number', at: 'Team', by: ['Team Lead'], verify: ['PMO Analyst'], weight: 3 },
      { name: 'Milestones delivered', group: 'Delivery', unit: 'count', at: 'Team', by: ['Team Lead'], verify: ['PMO Analyst'], weight: 2 },
      { name: 'Support tickets', group: 'Support', flow: true, at: 'Team', by: ['Team Lead'], verify: ['PMO Analyst'] },
    ],
    register: { label: 'Client escalations', at: ['Business Unit'], by: ['PMO Analyst'], categories: ['Quality', 'Delay', 'Billing', 'Security'], amount: 'Penalty at stake' },
    blocks: { target: 'Revenue & utilisation', arrears: 'Receivables', flow: 'Ticket resolution' },
    terms: { money: 'Revenue', achieved: 'Achieved', flowGroup: 'Tickets', disposed: 'Resolved', pending: 'Open', items: 'tickets', reference: 'Invoice no.' },
    money: { scale: 1e6, scaleLabel: 'Millions', decimals: 2 },
    fyStartMonth: 7,
  },

  /* ---------------- Industry ---------------- */
  textile_manufacturing: {
    name: 'Textile / Manufacturing Plant', industry: 'Manufacturing', category: 'Industry',
    description: 'Plant › Department › Production line — output, dispatch, export realisation, efficiency.',
    levels: ['Plant', ['Department', 'Departments'], ['Line', 'Lines']],
    posts: [
      { label: 'General Manager', at: ['Plant'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Department Manager', at: ['Department'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Line Supervisor', at: ['Line'], single: true },
      { label: 'PPC Officer', at: ['Plant'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Production output', group: 'Production', unit: 'number', at: 'Line', by: ['Line Supervisor', 'PPC Officer'], verify: ['PPC Officer'], weight: 4 },
      { name: 'Export realisation', group: 'Sales', at: 'Department', by: ['PPC Officer'], verify: ['PPC Officer'], weight: 3, arrears: true },
      { name: 'First-pass quality units', group: 'Quality', unit: 'number', at: 'Line', by: ['Line Supervisor'], verify: ['PPC Officer'], weight: 2 },
      { name: 'Orders', group: 'Dispatch', flow: true, at: 'Department', by: ['PPC Officer'], verify: ['PPC Officer'] },
    ],
    register: { label: 'Quality & safety incidents', at: ['Line'], by: ['Line Supervisor', 'PPC Officer'], categories: ['Rejection', 'Machine breakdown', 'Safety', 'Compliance audit'], amount: 'Loss' },
    blocks: { target: 'Production & sales', arrears: 'Export receivables', flow: 'Order dispatch' },
    terms: { money: 'Sales', achieved: 'Achieved', flowGroup: 'Orders', disposed: 'Dispatched', pending: 'Pending', items: 'orders', reference: 'PO no.' },
  },
  construction_projects: {
    name: 'Construction & Projects', industry: 'Construction', category: 'Industry',
    description: 'Company › Project › Site — work done, billing & recovery, milestones, safety.',
    levels: ['Company', ['Project', 'Projects'], 'Site'],
    posts: [
      { label: 'Director Projects', at: ['Company'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Project Manager', at: ['Project'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Site Engineer', at: ['Site'] },
      { label: 'Quantity Surveyor', at: ['Project'], data: true, caps: ['set_targets', 'manage_registers'] },
    ],
    kpis: [
      { name: 'Work done (IPC value)', group: 'Progress', at: 'Site', by: ['Quantity Surveyor'], verify: ['Quantity Surveyor'], weight: 4 },
      { name: 'Bills recovered', group: 'Recovery', at: 'Project', by: ['Quantity Surveyor'], verify: ['Quantity Surveyor'], weight: 3, arrears: true },
      { name: 'Milestones achieved', group: 'Milestones', unit: 'count', at: 'Site', by: ['Site Engineer'], verify: ['Quantity Surveyor'], weight: 2 },
      { name: 'Snag items', group: 'Quality', flow: true, at: 'Site', by: ['Site Engineer'], verify: ['Quantity Surveyor'] },
    ],
    register: { label: 'HSE incidents', at: ['Site'], by: ['Site Engineer', 'Quantity Surveyor'], categories: ['Near miss', 'Injury', 'Environmental', 'Equipment'], amount: 'Cost' },
    blocks: { target: 'Progress & billing', arrears: 'Outstanding bills', flow: 'Snag closure' },
    terms: { money: 'Billing', achieved: 'Achieved', flowGroup: 'Snags', disposed: 'Closed', pending: 'Open', items: 'snags', reference: 'IPC no.' },
  },
  retail_chain: {
    name: 'Retail Store Chain', industry: 'Retail', category: 'Sales & distribution',
    description: 'Region › City › Store — store sales, footfall conversion, basket size, loyalty, shrinkage.',
    levels: ['Region', 'City', ['Store', 'Stores']],
    posts: [
      { label: 'Regional Manager', at: ['Region'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'City Manager', at: ['City'], single: true, caps: ['assign_targets', 'compare'] },
      { label: 'Store Manager', at: ['Store'], single: true },
      { label: 'Store Cashier', at: ['Store'], data: true, caps: ['manage_registers'] },
      { label: 'Merchandising Analyst', at: ['Region'], data: true, caps: ['set_targets'] },
    ],
    kpis: [
      { name: 'Store sales', group: 'Sales', at: 'Store', by: ['Store Cashier'], verify: ['Store Manager'], weight: 5 },
      { name: 'Transactions', group: 'Conversion', unit: 'count', at: 'Store', by: ['Store Cashier'], verify: ['Store Manager'], weight: 2 },
      { name: 'Loyalty members added', group: 'Loyalty', unit: 'count', at: 'Store', by: ['Store Cashier'], verify: ['Store Manager'], weight: 1 },
      { name: 'Customer orders (online pickup)', group: 'Omnichannel', flow: true, at: 'Store', by: ['Store Cashier'], verify: ['Store Manager'] },
    ],
    register: { label: 'Stock shrinkage', at: ['Store'], by: ['Store Cashier', 'Store Manager'], categories: ['Theft', 'Damage', 'Expiry', 'Admin error'], amount: 'Value' },
    blocks: { target: 'Sales', flow: 'Order fulfilment' },
    terms: { money: 'Sales', achieved: 'Achieved', flowGroup: 'Orders', disposed: 'Fulfilled', pending: 'Pending', items: 'orders', reference: 'Receipt no.' },
    money: LAKH,
    fyStartMonth: 1,
  },
};

export const PK_TEMPLATES = Object.fromEntries(
  Object.entries(PK_SPECS).map(([k, s]) => [k, { label: s.name, description: s.description, category: s.category, blueprint: build(s) }]),
);
