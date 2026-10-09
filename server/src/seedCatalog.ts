/** Seed-only view of the Revenue Department template (the seeds generate data per KPI). */
import { blueprintSchema, fyHelpers } from './modules/org/blueprint.js';
import { revenueDepartment } from './modules/org/templates.js';

const bp = blueprintSchema.parse(revenueDepartment);
const kindOf = (block: string) => bp.blocks.find((b) => b.key === block)?.kind;
export const REVENUE_HEADS = bp.metrics.filter((m) => kindOf(m.block) === 'target').map((m) => ({ ...m, level: 'circle' as const, enteredBy: m.enterPosts[0] }));
export const CASE_HEADS = bp.metrics.filter((m) => kindOf(m.block) === 'flow').map((m) => ({ ...m, level: m.perHolder ? ('ro' as const) : ('circle' as const) }));
export const AUDIT_CATEGORIES = bp.registers[0].categories;
export const fyMonths = fyHelpers(bp.calendar.fyStartMonth).months;
