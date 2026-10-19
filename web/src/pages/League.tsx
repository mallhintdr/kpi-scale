import { useQuery } from '@tanstack/react-query';
import { Medal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { achievement, useViewMode } from '../lib/mode';
import { useTargetSummary } from '../components/targets';
import { PageHeader } from '../components/AppShell';
import { FyPicker, RevBandBadge, UnitField } from '../components/rev';
import { Card, Empty, ErrorState, Field, Loading, Select } from '../components/ui';
import { get } from '../lib/api';
import { MILLIONS, fmtPKR, parentLevels, postsUnder, useCaps, useFy, type Block, type Post, type RevBand, type UnitRef } from '../lib/rev';

interface LeagueRow {
  user: { _id: string; name: string; designation?: string; bps?: number };
  unitId: string; chargeType: string; chargeCount: number;
  charges: string[]; context: string; score: number | null; band: RevBand; blocks: Record<Block, number | null>;
  target: number; collected: number; rank: number | null;
}

/** Scored posts below an area of this level, e.g. { code: 'patwari', label: 'Patwaris' }. */
export const POSTS_BY_UNIT = new Proxy({} as Record<string, { code: Post; label: string }[]>, { get: (_t, level: string) => postsUnder(level) });

export default function League() {
  const caps = useCaps();
  const [fy] = useFy();
  const [unit, setUnit] = useState<UnitRef | null>(null);
  const [post, setPost] = useState<Post>('');
  useEffect(() => {
    if (!unit && caps.viewRoot) setUnit(caps.viewRoot);
  }, [caps.viewRoot, unit]);
  const options = POSTS_BY_UNIT[unit?.type ?? 'tehsil'] ?? [];
  useEffect(() => {
    if (options.length && !options.some((o) => o.code === post)) setPost(options[options.length - 1].code);
  }, [unit]); // eslint-disable-line react-hooks/exhaustive-deps

  const [mode] = useViewMode();
  const [selected, setSelected] = useState<string | null>(null);
  const perf = mode !== 'kpi';
  const tmode = mode === 'targets';
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['rev', 'league', unit?._id, post, fy],
    queryFn: () => get<{ items: LeagueRow[]; postLabel: string }>(`/rev/league?unitId=${unit!._id}&post=${post}&fy=${fy}`),
    enabled: !!unit && !!fy && options.some((o) => o.code === post),
  });

  const tsum = useTargetSummary(unit?._id, post, fy, tmode);
  // Performance: revenue achievement · Targets: assigned-target achievement · KPI: weighted score
  const val = (r: LeagueRow) => (tmode ? tsum.get(`${r.user._id}|${r.unitId}`)?.pct ?? null : perf ? achievement(r.collected, r.target) : r.score);
  // Ties in Targets mode: more targets met ranks higher
  const met = (r: LeagueRow) => (tmode ? tsum.get(`${r.user._id}|${r.unitId}`)?.met ?? 0 : 0);
  const items = (data?.items ?? []).slice().sort((a, b) => (val(b) ?? -1) - (val(a) ?? -1) || met(b) - met(a)).map((r, i) => ({ ...r, rank: val(r) == null ? null : i + 1 }));

  return (
    <>
      <PageHeader title="League tables" subtitle={tmode ? 'Officers ranked by achievement of assigned targets' : perf ? 'Officers ranked by achievement against target' : 'Officers ranked by weighted KPI score'} actions={<FyPicker />} />
      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Within">{() => <UnitField value={unit} onChange={setUnit} accept={parentLevels()} />}</Field>
        <Field label="Rank">{(id) => <Select id={id} value={post} onChange={(e) => setPost(e.target.value as Post)}>{options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}</Select>}</Field>
      </Card>
      {!options.length ? <Card><Empty title="Choose a division, district, tehsil or qanungoi" /></Card> : isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : !data?.items.length ? (
        <Card><Empty title="No officers found" /></Card>
      ) : (
        <>
        <p className="mb-1.5 text-center text-[10px] font-medium text-slate-400">{tmode ? 'Average achievement of assigned targets · targets met / assigned' : <>Collection figures {MILLIONS}</>}</p>
        <Card className="overflow-hidden">
          {/* Header row */}
          <div className="grid grid-cols-[2.75rem_1fr_5.5rem] border-b border-slate-500 bg-brand-700 text-[11px] font-semibold uppercase tracking-wide text-white">
            <div className="border-r border-white/50 px-1 py-2.5 text-center">#</div>
            <div className="border-r border-white/50 px-3 py-2.5">Officer</div>
            <div className="px-3 py-2.5 text-center">{tmode ? 'Targets' : perf ? 'Achieved' : 'Score'}</div>
          </div>
          <div className="divide-y divide-slate-300 dark:divide-slate-600">
          {items.map((r) => (
            <div key={`${r.user._id}-${r.unitId}`} role="button" tabIndex={0} aria-pressed={selected === `${r.user._id}-${r.unitId}`}
              onClick={() => setSelected(selected === `${r.user._id}-${r.unitId}` ? null : `${r.user._id}-${r.unitId}`)}
              className={`grid cursor-pointer grid-cols-[2.75rem_1fr_5.5rem] items-stretch ${selected === `${r.user._id}-${r.unitId}` ? 'bg-amber-100 outline outline-2 -outline-offset-2 outline-amber-400 dark:bg-amber-500/25' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
              <span className="flex flex-col items-center justify-center gap-0.5 border-r border-slate-400 py-3 dark:border-slate-500">
                <span className="text-sm font-bold tabular-nums text-slate-600 dark:text-slate-300">{r.rank ?? '–'}</span>
                {r.rank && r.rank <= 3 && <Medal className={`size-4 ${r.rank === 1 ? 'text-gold-500' : r.rank === 2 ? 'text-slate-400' : 'text-amber-700'}`} />}
              </span>
              <div className="min-w-0 border-r border-slate-400 px-3 py-3 dark:border-slate-500">
                <div className="flex items-center gap-1.5"><Link to={`/officers/${r.user._id}`} onClick={(e) => e.stopPropagation()} title={`Open ${r.user.name}'s profile`} className={`truncate font-bold decoration-2 underline-offset-2 hover:text-brand-700 hover:underline focus-visible:underline ${selected === `${r.user._id}-${r.unitId}` ? 'underline' : ''}`}>{r.user.name}</Link>{r.user.bps && <span className="hidden text-xs text-slate-400 sm:inline">BPS-{r.user.bps}</span>}</div>
                <div className="truncate text-xs text-slate-500">{r.charges.join(', ')}{r.chargeType !== 'regular' && <span className="ml-1.5 rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-800">{r.chargeType === 'additional' ? 'Addl. charge' : 'Look after'}</span>}{r.context && <> · {r.context}</>}</div>
                {!tmode && r.target > 0 && <div className="mt-1 text-[12px] font-medium text-slate-700 tabular-nums dark:text-slate-200">{fmtPKR(r.collected)} / {fmtPKR(r.target)}</div>}
              </div>
              <div className="flex flex-col items-end justify-center gap-1 px-3 py-3">
                {perf ? <span className="text-lg font-bold tabular-nums text-slate-900 dark:text-white">{val(r) == null ? '—' : `${Math.round(val(r)!)}%`}</span> : <span className="text-lg font-bold tabular-nums text-slate-900 dark:text-white">{val(r) == null ? '—' : Math.round(val(r)!)}</span>}
                {!perf && <RevBandBadge band={r.band} />}
                {tmode && (tsum.get(`${r.user._id}|${r.unitId}`) ? <span className="text-[11px] text-slate-500 tabular-nums">{tsum.get(`${r.user._id}|${r.unitId}`)!.met}/{tsum.get(`${r.user._id}|${r.unitId}`)!.targets} met</span> : <span className="text-[11px] text-slate-400">No targets</span>)}
              </div>
            </div>
          ))}
          </div>
        </Card>
        </>
      )}
    </>
  );
}
