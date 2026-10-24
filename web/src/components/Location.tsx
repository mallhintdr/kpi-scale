import { locationRows, type OfficerRowLike } from '../lib/officerRows';

/**
 * An official's place on two lines:
 *   District Bahawalpur · Tehsil Hasilpur
 *   Qanungoi Hasilpur Qanungoi-3 · Patwar Circle PC H-Q3-06
 */
export function Location({ row, scopeType, className }: { row: OfficerRowLike & { unitList?: { name: string; chargeType: string }[] }; scopeType?: string; className?: string }) {
  const lines = locationRows(row, scopeType);
  return (
    <div className={`min-w-0 ${className ?? 'text-xs leading-snug text-slate-600 dark:text-slate-300'}`}>
      {lines.map((line, li) => (
        <div key={li} className="flex flex-wrap gap-x-0 sm:gap-x-1.5">
          {line.map((p, i) => (
            <span key={i} className="min-w-0 break-words">
              {p.label && <span className="hidden text-slate-400 sm:inline">{p.label} </span>}
              <span className={li === lines.length - 1 && i === line.length - 1 ? 'font-semibold text-slate-800 dark:text-slate-100' : 'font-medium'}>{p.name}</span>
              {i < line.length - 1 && <span className="mx-1 text-slate-400 sm:hidden">·</span>}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
