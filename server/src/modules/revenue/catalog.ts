/** Static catalogue for the Board of Revenue KPI framework. */

export const UNIT_TYPES = ['division', 'district', 'tehsil', 'qanungoi', 'circle', 'mouza'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const POSTS = ['commissioner', 'dc', 'adc_rev', 'ac', 'tehsildar', 'naib_tehsildar', 'girdawar', 'patwari', 'wasilbaqi', 'sci'] as const;
export type Post = (typeof POSTS)[number];

export const POST_LABEL: Record<Post, string> = {
  commissioner: 'Commissioner',
  dc: 'Deputy Commissioner',
  adc_rev: 'ADC (Revenue)',
  ac: 'Assistant Commissioner',
  tehsildar: 'Tehsildar',
  naib_tehsildar: 'Naib Tehsildar',
  girdawar: 'Girdawar',
  patwari: 'Patwari',
  wasilbaqi: 'Wasil Baqi Navees',
  sci: 'Service Centre In-charge (SCI)',
};

/** Which unit type each post holds charge of. */
export const POST_UNIT: Record<Post, UnitType> = {
  commissioner: 'division',
  dc: 'district',
  adc_rev: 'district',
  ac: 'tehsil',
  tehsildar: 'tehsil', // oversees the tehsil; directly-held qanungois are separate 'ro' charges
  naib_tehsildar: 'qanungoi',
  girdawar: 'qanungoi',
  patwari: 'circle',
  wasilbaqi: 'tehsil',
  sci: 'tehsil',
};

/** Posts limited to a single holder per unit. */
export const SINGLE_HOLDER: Post[] = ['commissioner', 'dc', 'adc_rev', 'ac', 'tehsildar', 'wasilbaqi', 'sci'];

/** Score level used to pick block weights. */
export type Level = 'patwari' | 'girdawar' | 'ro' | 'tehsil' | 'district' | 'division';
export const LEVELS: Level[] = ['patwari', 'girdawar', 'ro', 'tehsil', 'district', 'division'];
export const UNIT_LEVEL: Partial<Record<UnitType, Level>> = { circle: 'patwari', qanungoi: 'girdawar', tehsil: 'tehsil', district: 'district', division: 'division' };
export const POST_LEVEL: Record<Post, Level> = {
  patwari: 'patwari', girdawar: 'girdawar', naib_tehsildar: 'ro', tehsildar: 'ro', ac: 'tehsil', adc_rev: 'district', dc: 'district', commissioner: 'division', wasilbaqi: 'tehsil', sci: 'tehsil',
};

export type HeadKind = 'revenue' | 'case';
export type EnteredBy = 'patwari' | 'wasilbaqi' | 'sci' | 'ro';
/** Data-officer posts: enter/verify figures, are not scored. */
export const DATA_POSTS: Post[] = ['wasilbaqi', 'sci'];

export interface HeadDef {
  code: string;
  name: string;
  group: string;
  kind: HeadKind;
  crop?: 'rabi' | 'kharif';
  enteredBy: EnteredBy;
  /** circle = per patwar circle; ro = per revenue officer (registries / partition) */
  level: 'circle' | 'ro';
  weight: number; // default weight inside its block
}

export const HEADS: HeadDef[] = [
  { code: 'WR_RABI', name: 'Water Rate — Rabi', group: 'Water Rate', kind: 'revenue', crop: 'rabi', enteredBy: 'patwari', level: 'circle', weight: 12 },
  { code: 'WR_KHARIF', name: 'Water Rate — Kharif', group: 'Water Rate', kind: 'revenue', crop: 'kharif', enteredBy: 'patwari', level: 'circle', weight: 12 },
  { code: 'TAWAN_RABI', name: 'Tawan — Rabi', group: 'Tawan', kind: 'revenue', crop: 'rabi', enteredBy: 'wasilbaqi', level: 'circle', weight: 3 },
  { code: 'TAWAN_KHARIF', name: 'Tawan — Kharif', group: 'Tawan', kind: 'revenue', crop: 'kharif', enteredBy: 'wasilbaqi', level: 'circle', weight: 3 },
  { code: 'AIT_LAND', name: 'AIT — Land Based', group: 'AIT', kind: 'revenue', enteredBy: 'patwari', level: 'circle', weight: 12 },
  { code: 'AIT_INCOME', name: 'AIT — Income Based', group: 'AIT', kind: 'revenue', enteredBy: 'patwari', level: 'circle', weight: 8 },
  { code: 'LEASE', name: 'Lease Money (State Land)', group: 'Lease Money', kind: 'revenue', enteredBy: 'patwari', level: 'circle', weight: 10 },
  { code: 'MUT_FEE', name: 'Mutation Fee', group: 'Mutation Fee', kind: 'revenue', enteredBy: 'wasilbaqi', level: 'circle', weight: 10 },
  { code: 'COND_FEE', name: 'Condonation Fee', group: 'Condonation Fee', kind: 'revenue', enteredBy: 'wasilbaqi', level: 'circle', weight: 5 },
  { code: 'STAMP', name: 'Stamp Duty', group: 'Stamp Duty', kind: 'revenue', enteredBy: 'wasilbaqi', level: 'circle', weight: 10 },
  { code: 'FBR_236C', name: 'FBR 236-C', group: 'FBR', kind: 'revenue', enteredBy: 'wasilbaqi', level: 'circle', weight: 8 },
  { code: 'FBR_236K', name: 'FBR 236-K', group: 'FBR', kind: 'revenue', enteredBy: 'wasilbaqi', level: 'circle', weight: 7 },

  { code: 'KMI', name: 'Khewat Mutation Issues', group: 'KMI', kind: 'case', enteredBy: 'sci', level: 'circle', weight: 1 },
  { code: 'MISSING_MUT', name: 'Missing Mutations', group: 'Missing Mutations', kind: 'case', enteredBy: 'sci', level: 'circle', weight: 1 },
  { code: 'GPC', name: 'Green Property Certificate', group: 'GPC', kind: 'case', enteredBy: 'sci', level: 'circle', weight: 1 },
  { code: 'INHERIT', name: 'Inheritance Mutations', group: 'Inheritance', kind: 'case', enteredBy: 'sci', level: 'circle', weight: 1 },
  { code: 'REGISTRY', name: 'Pending Registries', group: 'Registries', kind: 'case', enteredBy: 'ro', level: 'ro', weight: 1 },
  { code: 'PARTITION', name: 'Partition Cases', group: 'Partition', kind: 'case', enteredBy: 'ro', level: 'ro', weight: 1 },
];
export const HEAD_BY_CODE = new Map(HEADS.map((h) => [h.code, h]));
export const REVENUE_HEADS = HEADS.filter((h) => h.kind === 'revenue');
export const CASE_HEADS = HEADS.filter((h) => h.kind === 'case');

/** Audit para categories (entered manually, scored separately from arrears). */
export const AUDIT_CATEGORIES = ['Water Rate', 'AIT', 'Mutation Fee', 'Condonation Fee', 'Stamp Duty', 'FBR Fees', 'Lease Money'] as const;

export const BLOCKS = ['revenue', 'arrears', 'cases', 'audit', 'tasks'] as const;
export type Block = (typeof BLOCKS)[number];
export type BlockWeights = Record<Block, number>;

export const DEFAULT_BLOCK_WEIGHTS: Record<Level, BlockWeights> = {
  patwari: { revenue: 40, arrears: 15, cases: 30, audit: 5, tasks: 10 },
  girdawar: { revenue: 35, arrears: 15, cases: 30, audit: 5, tasks: 15 },
  ro: { revenue: 30, arrears: 10, cases: 30, audit: 15, tasks: 15 },
  tehsil: { revenue: 30, arrears: 10, cases: 25, audit: 20, tasks: 15 },
  district: { revenue: 30, arrears: 10, cases: 25, audit: 20, tasks: 15 },
  division: { revenue: 30, arrears: 10, cases: 25, audit: 25, tasks: 10 },
};
export const DEFAULT_HEAD_WEIGHTS: Record<string, number> = Object.fromEntries(HEADS.map((h) => [h.code, h.weight]));

/* ---------- Fiscal year helpers (July–June) ---------- */
export const fyOf = (d: Date) => {
  const y = d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
};
export const fyStartYear = (fy: string) => Number(fy.slice(0, 4));
/** Months of a fiscal year as YYYY-MM, July first. */
export const fyMonths = (fy: string) => {
  const y = fyStartYear(fy);
  return Array.from({ length: 12 }, (_, i) => {
    const m = (6 + i) % 12;
    return `${m < 6 ? y + 1 : y}-${String(m + 1).padStart(2, '0')}`;
  });
};
export const isValidFy = (fy: string) => /^\d{4}-\d{2}$/.test(fy) && (fyStartYear(fy) + 1) % 100 === Number(fy.slice(5));
/** Fraction of the fiscal year elapsed (for pace). */
export const fyElapsed = (fy: string, now = new Date()) => {
  const start = new Date(fyStartYear(fy), 6, 1).getTime();
  const end = new Date(fyStartYear(fy) + 1, 6, 1).getTime();
  return Math.max(0, Math.min(1, (now.getTime() - start) / (end - start)));
};
