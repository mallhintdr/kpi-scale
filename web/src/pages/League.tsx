import { useQuery } from '@tanstack/react-query';
import { Medal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { achievement, useViewMode } from '../lib/mode';
import { PageHeader } from '../components/AppShell';
import { Bar, FyPicker, RevBandBadge, UnitField } from '../components/rev';
import { Card, Empty, ErrorState, Field, Loading, Select } from '../components/ui';
import { get } from '../lib/api';
import { MILLIONS, fmtPKR, useCaps, useFy, type Block, type Post, type RevBand, type UnitRef } from '../lib/rev';

interface LeagueRow {
  user: { _id: string; name: string; designation?: string; bps?: number };
  charges: string[]; context: string; score: number | null; band: RevBand; blocks: Record<Block, number | null>;
  target: number; collected: number; rank: number | null;
}

export const POSTS_BY_UNIT: Record<string, { code: Post; label: string }[]> = {
  division: [{ code: 'dc', label: 'Deputy Commissioners' }, { code: 'adc_rev', label: 'ADCs (Revenue)' }, { code: 'ac', label: 'Assistant Commissioners' }, { code: 'tehsildar', label: 'Tehsildars' }, { code: 'naib_tehsildar', label: 'Naib Tehsildars' }, { code: 'girdawar', label: 'Girdawars' }, { code: 'patwari', label: 'Patwaris' }],
  district: [{ code: 'ac', label: 'Assistant Commissioners' }, { code: 'tehsildar', label: 'Tehsildars' }, { code: 'naib_tehsildar', label: 'Naib Tehsildars' }, { code: 'girdawar', label: 'Girdawars' }, { code: 'patwari', label: 'Patwaris' }],
  tehsil: [{ code: 'tehsildar', label: 'Tehsildar' }, { code: 'naib_tehsildar', label: 'Naib Tehsildars' }, { code: 'girdawar', label: 'Girdawars' }, { code: 'patwari', label: 'Patwaris' }],
  qanungoi: [{ code: 'patwari', label: 'Patwaris' }],
};

export default function League() {
  const caps = useCaps();
  const [fy] = useFy();
  const [unit, setUnit] = useState<UnitRef | null>(null);
  const [post, setPost] = useState<Post>('patwari');
  useEffect(() => {
    if (!unit && caps.viewRoot) setUnit(caps.viewRoot);
  }, [caps.viewRoot, unit]);
  const options = POSTS_BY_UNIT[unit?.type ?? 'tehsil'] ?? [];
  useEffect(() => {
    if (options.length && !options.some((o) => o.code === post)) setPost(options[options.length - 1].code);
  }, [unit]); // eslint-disable-line react-hooks/exhaustive-deps

  const [mode] = useViewMode();
  const perf = mode === 'performance';
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['rev', 'league', unit?._id, post, fy],
    queryFn: () => get<{ items: LeagueRow[]; postLabel: string }>(`/rev/league?unitId=${unit!._id}&post=${post}&fy=${fy}`),
    enabled: !!unit && !!fy && options.some((o) => o.code === post),
  });

  // Performance mode ranks on revenue achievement; KPI mode keeps the weighted score order from the API
  const val = (r: LeagueRow) => (perf ? achievement(r.collected, r.target) : r.score);
  const items = (data?.items ?? []).slice().sort((a, b) => (val(b) ?? -1) - (val(a) ?? -1)).map((r, i) => ({ ...r, rank: val(r) == null ? null : i + 1 }));

  return (
    <>
      <PageHeader title="League tables" subtitle={perf ? 'Officers ranked by achievement against target' : 'Officers ranked by weighted KPI score'} actions={<FyPicker />} />
      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Within">{() => <UnitField value={unit} onChange={setUnit} accept={['division', 'district', 'tehsil', 'qanungoi']} />}</Field>
        <Field label="Rank">{(id) => <Select id={id} value={post} onChange={(e) => setPost(e.target.value as Post)}>{options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}</Select>}</Field>
      </Card>
      {!options.length ? <Card><Empty title="Choose a division, district, tehsil or qanungoi" /></Card> : isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : !data?.items.length ? (
        <Card><Empty title="No officers found" /></Card>
      ) : (
        <>
        <p className="mb-1.5 text-center text-[10px] font-medium text-slate-400">Collection figures {MILLIONS}</p>
        <Card className="overflow-hidden">
          {/* Header row */}
          <div className="grid grid-cols-[2.75rem_1fr_5.5rem] bg-brand-700 text-[11px] font-semibold uppercase tracking-wide text-white">
            <div className="border-r border-white/20 px-1 py-2.5 text-center">#</div>
            <div className="border-r border-white/20 px-3 py-2.5">Officer</div>
            <div className="px-3 py-2.5 text-right">{perf ? 'Achieved' : 'Score'}</div>
          </div>
          <div className="divide-y divide-slate-200 dark:divide-slate-700">
          {items.map((r) => (
            <Link key={r.user._id} to={`/officers/${r.user._id}`} className="grid grid-cols-[2.75rem_1fr_5.5rem] items-stretch hover:bg-slate-50 dark:hover:bg-slate-800">
              <span className="flex flex-col items-center justify-center gap-0.5 border-r border-slate-200 py-3 dark:border-slate-700">
                <span className="text-sm font-bold tabular-nums text-slate-600 dark:text-slate-300">{r.rank ?? '–'}</span>
                {r.rank && r.rank <= 3 && <Medal className={`size-4 ${r.rank === 1 ? 'text-gold-500' : r.rank === 2 ? 'text-slate-400' : 'text-amber-700'}`} />}
              </span>
              <div className="min-w-0 border-r border-slate-200 px-3 py-3 dark:border-slate-700">
                <div className="truncate font-medium">{r.user.name}{r.user.bps && <span className="ml-1 hidden text-xs text-slate-400 sm:inline">BPS-{r.user.bps}</span>}</div>
                <div className="truncate text-xs text-slate-500">{r.charges.join(', ')}{r.context && <> · {r.context}</>}</div>
                {r.target > 0 && <div className="mt-1 text-[12px] font-medium text-slate-700 tabular-nums dark:text-slate-200">{fmtPKR(r.collected)} / {fmtPKR(r.target)}</div>}
                <div className="mt-1 max-w-56"><Bar value={val(r)} /></div>
              </div>
              <div className="flex flex-col items-end justify-center gap-1 px-3 py-3">
                <span className="text-lg font-bold tabular-nums text-slate-900 dark:text-white">{val(r) == null ? '—' : perf ? `${Math.round(val(r)!)}%` : Math.round(val(r)!)}</span>
                {!perf && <RevBandBadge band={r.band} />}
              </div>
            </Link>
          ))}
          </div>
        </Card>
        </>
      )}
    </>
  );
}
