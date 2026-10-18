/**
 * Reference lists for the State Land Directory (see STATE_LAND_PLAN.md §3).
 * Categories carry their sub-types, the usual owner as written in the record and which optional
 * sections of the form apply (acquisition, allotment / lease).
 * These are the defaults; admins add types in Settings so every user picks the same names.
 */
import { Tenant } from '../../models/index.js';
export interface Category { key: string; label: string; subTypes: string[]; owner?: string; sections?: ('acquisition' | 'allotment')[] }

export const CATEGORIES: Category[] = [
  { key: 'provincial', label: 'Provincial Government', owner: 'Sarkar Daulatmadar', subTypes: ['Banjar qadeem', 'Banjar jadeed', 'Ghair mumkin', 'Culturable waste', 'Unculturable', 'Nazool (urban state land)', 'Abadi deh (state-owned part)', 'Resumed land', 'Other'] },
  { key: 'colony', label: 'Colony Land', owner: 'Sarkar Daulatmadar', sections: ['allotment'], subTypes: ['Unallotted', 'Allotted (proprietary rights pending)', 'Proprietary rights granted', 'Temporary cultivation lease', 'Reserved for public purpose', 'Resumed', 'Other'] },
  { key: 'land_reforms', label: 'Land Reforms / Land Commission', owner: 'Land Commission', sections: ['allotment'], subTypes: ['Resumed – unallotted', 'Resumed – allotted to tenants', 'Dispute pending', 'Other'] },
  { key: 'evacuee', label: 'Evacuee Property', owner: 'Evacuee Trust Property Board', subTypes: ['Evacuee trust property (ETPB)', 'Ex-evacuee settled land', 'Unsettled evacuee land', 'Other'] },
  { key: 'auqaf', label: 'Auqaf', owner: 'Auqaf Department', subTypes: ['Shrine', 'Mosque', 'Waqf agricultural land', 'Waqf urban property', 'Other'] },
  { key: 'federal', label: 'Federal Department', subTypes: ['Railway line', 'Railway station / yard', 'Railway colony', 'WAPDA grid station', 'WAPDA line / tower', 'WAPDA colony', 'Military / cantonment / defence land', 'National highway (NHA)', 'Pak PWD', 'Post office', 'Telecom (PTCL)', 'Other federal'] },
  { key: 'provincial_dept', label: 'Provincial Department (Public Use)', subTypes: ['Road / highway (C&W)', 'Canal', 'Distributary / minor', 'Drain', 'Irrigation colony / rest house', 'School / college', 'BHU / RHC / hospital', 'Forest – reserved', 'Forest – protected', 'Linear plantation', 'Police station / post', 'Livestock farm / veterinary hospital', 'Agriculture farm', 'Fisheries', 'Union council / municipal', 'Cholistan land (CDA)', 'Other provincial'] },
  { key: 'acquired', label: 'Acquired Land', sections: ['acquisition'], subTypes: ['For road', 'For canal / drain', 'For school / college', 'For hospital / BHU', 'For housing scheme', 'For industrial estate', 'For defence', 'Other purpose'] },
  { key: 'scheme', label: 'Allotted / Leased Under Scheme', owner: 'Sarkar Daulatmadar', sections: ['allotment'], subTypes: ['Lamberdari scheme', 'Jinnah Abadi', '5-marla / 7-marla scheme', 'Landless tenants', 'Ex-servicemen / gallantry award', 'Cholistan allotment', 'Horse / camel breeding grant', 'Temporary cultivation lease', 'Commercial lease', 'Industrial lease', 'Other scheme'] },
  { key: 'community', label: 'Community / Public Purpose', subTypes: ['Graveyard', 'Eidgah', 'Pond / johar', 'Playground', 'Rasta (path)', 'Shamilat deh', 'Public building', 'Other'] },
  { key: 'other', label: 'Other / Unclassified', subTypes: ['Other'] },
];

export const DEPARTMENTS = [
  'Provincial Government', 'Board of Revenue / Collector', 'Colonies Department', 'Land Commission', 'Evacuee Trust Property Board', 'Auqaf Department',
  'Pakistan Railways', 'WAPDA', 'Military Lands & Cantonments / Defence', 'National Highway Authority', 'Pak PWD', 'Pakistan Post', 'PTCL',
  'Communication & Works (Highways)', 'Irrigation Department', 'School Education Department', 'Higher Education Department', 'Health Department',
  'Forest Department', 'Police Department', 'Livestock & Dairy Development', 'Agriculture Department', 'Fisheries Department',
  'Local Government', 'Cholistan Development Authority', 'Housing / Development Authority', 'Industries Department', 'Village / community', 'Other',
];

export const POSSESSION: [string, string][] = [
  ['department', 'With owner department'], ['allottee', 'With allottee / lessee'], ['encroached', 'Encroached (fully)'], ['part_encroached', 'Partly encroached'], ['vacant', 'Vacant / unused'], ['mixed', 'Mixed'],
];
export const RECORD_STATUS: [string, string][] = [
  ['mutated', 'Mutated in favour of owner'], ['not_mutated', 'Not mutated'], ['partly', 'Partly mutated'], ['not_traceable', 'Record not traceable'],
];
export const LAND_CLASS = ['Chahi', 'Nehri', 'Chahi nehri', 'Barani', 'Banjar qadeem', 'Banjar jadeed', 'Ghair mumkin – road', 'Ghair mumkin – canal', 'Ghair mumkin – abadi', 'Ghair mumkin – rail', 'Ghair mumkin – other', 'Other'];
export const USES = ['Agriculture', 'Building / office', 'Road / canal / rail in use', 'Vacant', 'Graveyard', 'Commercial', 'Residential', 'Plantation / forest', 'Other'];
export const ENCROACHMENT_NATURE = ['Cultivation', 'Building', 'Shops / commercial', 'Residential houses', 'Boundary wall / fencing', 'Other'];
export const ENCROACHMENT_ACTION = ['None', 'Notice issued', 'FIR lodged', 'Case filed', 'Retrieval operation', 'Retrieved'];
export const DOC_CATEGORIES: [string, string][] = [
  ['fard', 'Fard (jamabandi extract)'], ['shajra', 'Aks shajra / site plan'], ['mutation', 'Mutation'], ['award', 'Acquisition award'], ['allotment', 'Allotment order / lease deed'], ['demarcation', 'Demarcation report'], ['photo', 'Site photos'], ['other', 'Other'],
];

export const POSSESSION_LABEL = new Map(POSSESSION);
export const RECORD_LABEL = new Map(RECORD_STATUS);
export const isEncroached = (p?: string | null) => p === 'encroached' || p === 'part_encroached';

/** Kanal / Marla / square feet → acres (1 acre = 8 kanal = 160 marla = 43,560 sq ft). */
export const toAcres = (a?: { kanal?: number | null; marla?: number | null; feet?: number | null } | null) =>
  a ? Math.round(((a.kanal ?? 0) / 8 + (a.marla ?? 0) / 160 + (a.feet ?? 0) / 43_560) * 10_000) / 10_000 : 0;

/** The organisation's lists: admin-edited categories / sub-types / departments, else the defaults. */
export async function slSettings(tenantId: string): Promise<{ categories: Category[]; departments: string[] }> {
  const t = await Tenant.findById(tenantId).select('stateLand').lean();
  const x: any = t?.stateLand ?? {};
  return { categories: x.categories?.length ? x.categories : CATEGORIES, departments: x.departments?.length ? x.departments : DEPARTMENTS };
}
export const labelIn = (cats: Category[], k?: string | null) => cats.find((c) => c.key === k)?.label ?? k ?? '';
