import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PageHeader } from '../components/AppShell';
import { FyPicker } from '../components/rev';
import { Button, Card, Empty, ErrorState, Field, Loading, Select, useToast } from '../components/ui';
import { get, put } from '../lib/api';
import { fmtPKR, useCaps, useFy, useMeta, type HeadDef } from '../lib/rev';

interface Row { unitId: string; roUserId: string | null; label: string; sub?: string; target: number; arrearDemand: number; opening: number }
interface Grid { head: HeadDef; tehsil: { _id: string; name: string }; canEdit: boolean; rows: Row[] }

export default function Targets() {
  const caps = useCaps();
  const { data: meta } = useMeta();
  const [fy] = useFy();
  const tehsils = caps.isAdmin ? [] : caps.charges.filter((c) => c.post === 'wasilbaqi').map((c) => c.unit);
  const [tehsilId, setTehsilId] = useState('');
  const [head, setHead] = useState('WR_RABI');
  useEffect(() => {
    if (!tehsilId && tehsils[0]) setTehsilId(tehsils[0]._id);
  }, [tehsils, tehsilId]);

  return (
    <>
      <PageHeader title="Targets & demand" subtitle="Set by Wasil Baqi Navees for each patwar circle" actions={<FyPicker />} />
      {!tehsils.length ? <Card><Empty title="Only Wasil Baqi Navees set targets" body="Targets and demand are set at tehsil level by the Wasil Baqi Navees." /></Card> : (
        <>
          <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-2">
            {tehsils.length > 1 && (
              <Field label="Tehsil">{(id) => <Select id={id} value={tehsilId} onChange={(e) => setTehsilId(e.target.value)}>{tehsils.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}</Select>}</Field>
            )}
            <Field label="Head">
              {(id) => (
                <Select id={id} value={head} onChange={(e) => setHead(e.target.value)}>
                  <optgroup label="Revenue">{meta?.heads.filter((h) => h.kind === 'revenue').map((h) => <option key={h.code} value={h.code}>{h.name}</option>)}</optgroup>
                  <optgroup label="Case registers (opening pending)">{meta?.heads.filter((h) => h.kind === 'case').map((h) => <option key={h.code} value={h.code}>{h.name}</option>)}</optgroup>
                </Select>
              )}
            </Field>
          </Card>
          {tehsilId && fy && <TargetGrid tehsilId={tehsilId} fy={fy} head={head} />}
        </>
      )}
    </>
  );
}

function TargetGrid({ tehsilId, fy, head }: { tehsilId: string; fy: string; head: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['rev', 'targets', tehsilId, fy, head];
  const { data, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => get<Grid>(`/rev/targets?tehsilId=${tehsilId}&fy=${fy}&head=${head}`) });
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => setRows(data?.rows ?? []), [data]);

  const save = useMutation({
    mutationFn: () => put('/rev/targets', { tehsilId, fy, head, rows: rows.map(({ unitId, roUserId, target, arrearDemand, opening }) => ({ unitId, roUserId, target, arrearDemand, opening })) }),
    onSuccess: () => {
      toast('Targets saved');
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ['rev', 'unit'] });
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} retry={refetch} />;
  if (!data) return null;
  const isCase = data.head.kind === 'case';
  const set = (i: number, k: 'target' | 'arrearDemand' | 'opening') => (e: React.ChangeEvent<HTMLInputElement>) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: Math.max(0, Number(e.target.value) || 0) } : x)));
  const total = (k: 'target' | 'arrearDemand' | 'opening') => rows.reduce((s, r) => s + r[k], 0);
  const cell = 'h-10 w-full rounded-lg bg-white px-2 text-right tabular-nums ring-1 ring-slate-200 focus:ring-2 focus:ring-brand-500 outline-none dark:bg-slate-900 dark:ring-slate-700';

  return (
    <div className="pb-24 lg:pb-0">
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead className="sticky top-0 bg-white text-left text-xs text-slate-500 dark:bg-slate-900">
            <tr className="border-b border-slate-100 dark:border-slate-800">
              <th className="px-3 py-2.5 font-medium">{data.head.level === 'ro' ? 'Revenue officer' : 'Patwar circle'}</th>
              {isCase ? <th className="px-3 py-2.5 text-right font-medium">Opening pending</th> : (
                <>
                  <th className="px-3 py-2.5 text-right font-medium">Current demand (Rs)</th>
                  <th className="px-3 py-2.5 text-right font-medium">Arrears (Rs)</th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((r, i) => (
              <tr key={`${r.unitId}${r.roUserId ?? ''}`}>
                <td className="px-3 py-1.5"><div className="font-medium">{r.label}</div>{r.sub && <div className="text-[11px] text-slate-500">{r.sub}</div>}</td>
                {isCase ? (
                  <td className="px-3 py-1.5"><input type="number" inputMode="numeric" min={0} disabled={!data.canEdit} className={cell} value={r.opening || ''} onChange={set(i, 'opening')} /></td>
                ) : (
                  <>
                    <td className="px-3 py-1.5"><input type="number" inputMode="decimal" min={0} disabled={!data.canEdit} className={cell} value={r.target || ''} onChange={set(i, 'target')} /></td>
                    <td className="px-3 py-1.5"><input type="number" inputMode="decimal" min={0} disabled={!data.canEdit} className={cell} value={r.arrearDemand || ''} onChange={set(i, 'arrearDemand')} /></td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-slate-200 font-semibold dark:border-slate-700">
            <tr>
              <td className="px-3 py-2.5">Total · {rows.length}</td>
              {isCase ? <td className="px-3 py-2.5 text-right tabular-nums">{total('opening')}</td> : (
                <>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtPKR(total('target'))}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtPKR(total('arrearDemand'))}</td>
                </>
              )}
            </tr>
          </tfoot>
        </table>
      </Card>
      {data.canEdit && (
        <div className="pb-safe fixed inset-x-0 bottom-16 z-30 border-t border-slate-200 bg-white/95 p-3 backdrop-blur lg:static lg:mt-4 lg:border-0 lg:bg-transparent lg:p-0 dark:border-slate-800 dark:bg-slate-900/95">
          <Button block loading={save.isPending} onClick={() => save.mutate()}><Save className="size-4" />Save {data.head.name}</Button>
        </div>
      )}
    </div>
  );
}
