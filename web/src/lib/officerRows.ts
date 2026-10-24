/**
 * Officer rows in League tables, Staff performance and the Report builder.
 *
 * locationParts: the official's place as labelled levels (District › Tehsil › Qanungoi › Patwar Circle),
 *   leaving out the levels already fixed by the area being viewed.
 * mergeByOfficer: an official holding several units under the same parent is shown once — the parent
 *   levels once, then the units — with target and achievement summed (exact for Performance mode).
 */
import { achievement } from './mode';
import { levelIndex, levels, UNIT_LABEL, UNIT_PLURAL } from './rev';

export interface CellLike { pct: number | null; done: number; of: number }
export interface OfficerRowLike {
  user: { _id: string; name: string };
  unitId: string;
  charges: string[];
  chargeType: string;
  areas?: Record<string, string>;
  target: number;
  collected: number;
  heads: Record<string, CellLike>;
}

const cleanName = (s: string) => s.replace(/ \(test\)/g, '');

/** The row's own unit level: the deepest level present in its areas. */
function ownLevel(r: OfficerRowLike) {
  const keys = Object.keys(r.areas ?? {});
  return keys.sort((a, b) => levelIndex(b) - levelIndex(a))[0];
}

/** Levels below the top one (e.g. District, Tehsil, Qanungoi) down to the row's unit (exclusive). */
export function parentParts(r: OfficerRowLike, _scopeType?: string) {
  const own = ownLevel(r);
  const to = own ? levelIndex(own) : levels().length;
  return levels()
    .slice(1, to)
    .map((l) => ({ label: UNIT_LABEL[l.key] ?? l.label, name: r.areas?.[l.key], level: levelIndex(l.key) }))
    .filter((p): p is { label: string; name: string; level: number } => !!p.name)
    .map((p) => ({ ...p, name: cleanName(p.name) }));
}

/** "Tehsil Hasilpur › Qanungoi H-Q3 › Patwar Circles H-Q3-06, H-Q3-07 (Addl.)" */
export function locationParts(r: OfficerRowLike & { unitList?: { name: string; chargeType: string }[] }, scopeType?: string) {
  const own = ownLevel(r);
  const units = r.unitList ?? [{ name: r.charges.join(', '), chargeType: r.chargeType }];
  const unitLabel = own ? (units.length > 1 ? UNIT_PLURAL[own] : UNIT_LABEL[own]) : '';
  const unitNames = units.map((u) => cleanName(u.name) + (u.chargeType === 'additional' ? ' (Addl.)' : u.chargeType && u.chargeType !== 'regular' ? ' (Look After)' : '')).join(', ');
  const parts = [...parentParts(r, scopeType), { label: unitLabel ?? '', name: unitNames, level: own ? levelIndex(own) : levels().length }];
  // Don't repeat the parent's name: "Hasilpur Qanungoi-3" under Tehsil Hasilpur → "Qanungoi-3"
  return parts.map((p, i) => {
    const prev = parts[i - 1]?.name;
    return prev && p.name.startsWith(`${prev} `) && p.name.length > prev.length + 1 ? { ...p, name: p.name.slice(prev.length + 1) } : p;
  });
}

/**
 * Two lines that fit a phone: the two levels under the top one (District, Tehsil) on the first,
 * everything below (Qanungoi, Patwar Circle) on the second.
 */
export function locationRows(r: Parameters<typeof locationParts>[0], scopeType?: string) {
  const parts = locationParts(r, scopeType);
  return [parts.filter((p) => p.level <= 2), parts.filter((p) => p.level > 2)].filter((l) => l.length);
}
const lineText = (l: { label: string; name: string }[]) => l.map((p) => (p.label ? `${p.label} ${p.name}` : p.name)).join(' · ');
export const locationLines = (r: Parameters<typeof locationParts>[0], scopeType?: string) => locationRows(r, scopeType).map(lineText);

export const locationText = (r: Parameters<typeof locationParts>[0], scopeType?: string) =>
  locationLines(r, scopeType).join(' › ');

/** Combine an official's rows that share the same parent area. */
export function mergeByOfficer<R extends OfficerRowLike>(rows: R[]): (R & { unitList: { name: string; chargeType: string }[] })[] {
  const groups = new Map<string, R[]>();
  for (const r of rows) {
    const own = ownLevel(r);
    const parent = levels().filter((l) => own && levelIndex(l.key) < levelIndex(own)).map((l) => r.areas?.[l.key] ?? '').join('|');
    const k = `${r.user._id}|${own}|${parent}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((g) => {
    const first = g[0];
    const units = g.map((r) => ({ name: r.charges.join(', '), chargeType: r.chargeType }));
    if (g.length === 1) return { ...first, unitList: units };
    const heads: Record<string, CellLike> = {};
    for (const r of g) for (const [code, c] of Object.entries(r.heads)) {
      const h = (heads[code] ??= { pct: null, done: 0, of: 0 });
      h.done += c.done;
      h.of += c.of;
    }
    for (const h of Object.values(heads)) h.pct = achievement(h.done, h.of);
    return {
      ...first,
      unitList: units,
      charges: units.map((u) => u.name),
      chargeType: g.some((r) => r.chargeType === 'regular') ? 'regular' : first.chargeType,
      target: g.reduce((s, r) => s + r.target, 0),
      collected: g.reduce((s, r) => s + r.collected, 0),
      heads,
    };
  });
}
