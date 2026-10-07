import { useQuery } from '@tanstack/react-query';
import { Medal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/AppShell';
import { Bar, FyPicker, RevBandBadge, UnitField } from '../components/rev';
import { Avatar, Card, Empty, ErrorState, Field, Loading, Select } from '../components/ui';
import { get } from '../lib/api';
import { fmtPKR, useCaps, useFy, type Block, type Post, type RevBand, type UnitRef } from '../lib/rev';

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
    if (!unit && caps.roots[0]) setUnit(caps.roots[0]);
  }, [caps.roots, unit]);
  const options = POSTS_BY_UNIT[unit?.type ?? 'tehsil'] ?? [];
  useEffect(() => {
    if (options.length && !options.some((o) => o.code === post)) setPost(options[options.length - 1].code);
  }, [unit]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['rev', 'league', unit?._id, post, fy],
    queryFn: () => get<{ items: LeagueRow[]; postLabel: string }>(`/rev/league?unitId=${unit!._id}&post=${post}&fy=${fy}`),
    enabled: !!unit && !!fy && options.some((o) => o.code === post),
  });

  return (
    <>
      <PageHeader title="League tables" subtitle="Officers ranked by score" actions={<FyPicker />} />
      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Within">{() => <UnitField value={unit} onChange={setUnit} accept={['division', 'district', 'tehsil', 'qanungoi']} />}</Field>
        <Field label="Rank">{(id) => <Select id={id} value={post} onChange={(e) => setPost(e.target.value as Post)}>{options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}</Select>}</Field>
      </Card>
      {!options.length ? <Card><Empty title="Choose a division, district, tehsil or qanungoi" /></Card> : isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : !data?.items.length ? (
        <Card><Empty title="No officers found" /></Card>
      ) : (
        <Card className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.items.map((r) => (
            <Link key={r.user._id} to={`/officers/${r.user._id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800">
              <span className="w-7 text-center">
                {r.rank && r.rank <= 3 ? <Medal className={`mx-auto size-5 ${r.rank === 1 ? 'text-gold-500' : r.rank === 2 ? 'text-slate-400' : 'text-amber-700'}`} /> : <span className="text-xs font-bold tabular-nums text-slate-400">{r.rank ?? '–'}</span>}
              </span>
              <Avatar name={r.user.name} size={38} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{r.user.name}{r.user.bps && <span className="ml-1 text-xs text-slate-400">BPS-{r.user.bps}</span>}</div>
                <div className="truncate text-xs text-slate-500">{r.charges.join(', ')}{r.context && <> · {r.context}</>}</div>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="w-36"><Bar value={r.score} /></div>
                  {r.target > 0 && <span className="text-[11px] text-slate-400">{fmtPKR(r.collected)} / {fmtPKR(r.target)}</span>}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="text-lg font-bold tabular-nums text-slate-900 dark:text-white">{r.score == null ? '—' : Math.round(r.score)}</span>
                <RevBandBadge band={r.band} />
              </div>
            </Link>
          ))}
        </Card>
      )}
    </>
  );
}
