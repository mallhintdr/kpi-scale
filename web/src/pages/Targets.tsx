import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PageHeader } from '../components/AppShell';
import { FyPicker } from '../components/rev';
import { Button, Card, Empty, ErrorState, Field, Loading, Select, useToast } from '../components/ui';
import { get, put } from '../lib/api';
import { fmtPKR, MILLIONS, symCaption, UNIT_LABEL, useCaps, useFy, useMeta, type HeadDef } from '../lib/rev';

interface Row { unitId: string; roUserId: string | null; label: string; sub?: string; target: number; arrearDemand: number; opening: number }
interface Grid { head: HeadDef; tehsil: { _id: string; name: string }; canEdit: boolean; rows: Row[] }

export default function Targets() {
  const caps = useCaps();
  const { data: meta } = useMeta();
  const [fy] = useFy();
  const setters = new Set((meta?.posts ?? []).filter((p) => p.caps.includes('set_targets')).map((p) => p.key));
  const tehsils = caps.isAdmin ? [] : [
    ...caps.charges.filter((c) => setters.has(c.post)).map((c) => c.unit),
    ...caps.grants.filter((g) => g.unit && g.rights.includes('set_targets')).map((g) => g.unit!),
  ].filter((u, i, all) => all.findIndex((x) => x._id === u._id) === i);
  const [tehsilId, setTehsilId] = useState('');
  const [head, setHead] = useState('');
  useEffect(() => {
    if (!tehsilId && tehsils[0]) setTehsilId(tehsils[0]._id);
  }, [tehsils, tehsilId]);
  useEffect(() => {
    if (!head && meta?.heads[0]) setHead(meta.heads[0].code);
  }, [meta, head]);

  return (
    <>
      <PageHeader title="Targets & demand" subtitle="Annual targets and opening balances for the units under you" actions={<FyPicker />} />
      {!tehsils.length ? <Card><Empty title="Your posting does not set targets" body="Annual targets are set by the posts your organisation allows to set them." /></Card> : (
        <>
          <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-2">
            {tehsils.length > 1 && (
              <Field label="Area">{(id) => <Select id={id} value={tehsilId} onChange={(e) => setTehsilId(e.target.value)}>{tehsils.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}</Select>}</Field>
            )}
            <Field label="KPI">
              {(id) => (
                <Select id={id} value={head} onChange={(e) => setHead(e.target.value)}>
                  <optgroup label="Target KPIs">{meta?.heads.filter((h) => h.kind === 'revenue').map((h) => <option key={h.code} value={h.code}>{h.name}</option>)}</optgroup>
                  <optgroup label="Workload KPIs (opening pending)">{meta?.heads.filter((h) => h.kind === 'case').map((h) => <option key={h.code} value={h.code}>{h.name}</option>)}</optgroup>
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
      {/* Phones: one card per circle, inputs side by side */}
      <Card className="divide-y divide-slate-100 sm:hidden dark:divide-slate-800">
        {rows.map((r, i) => (
          <div key={`${r.unitId}${r.roUserId ?? ''}`} className="px-3 py-2.5">
            <div className="text-sm font-medium">{r.label}{r.sub && <span className="ml-1.5 text-[11px] font-normal text-slate-500">{r.sub}</span>}</div>
            {isCase ? (
              <label className="mt-1.5 block text-[11px] text-slate-500">Opening pending
                <input type="number" inputMode="numeric" min={0} disabled={!data.canEdit} className={`${cell} mt-0.5`} value={r.opening || ''} onChange={set(i, 'opening')} />
              </label>
            ) : (
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <label className="block text-[11px] text-slate-500">Current target {symCaption()}
                  <input type="number" inputMode="decimal" min={0} disabled={!data.canEdit} className={`${cell} mt-0.5`} value={r.target || ''} onChange={set(i, 'target')} />
                </label>
                <label className="block text-[11px] text-slate-500">Arrears {symCaption()}
                  <input type="number" inputMode="decimal" min={0} disabled={!data.canEdit} className={`${cell} mt-0.5`} value={r.arrearDemand || ''} onChange={set(i, 'arrearDemand')} />
                </label>
              </div>
            )}
          </div>
        ))}
        <div className="flex justify-between bg-slate-50 px-3 py-2 text-sm font-semibold dark:bg-slate-800">
          <span>Total · {rows.length}</span>
          <span className="tabular-nums">{isCase ? total('opening') : <>{fmtPKR(total('target'))} · {fmtPKR(total('arrearDemand'))} <span className="text-[10px] font-medium text-slate-400">{MILLIONS}</span></>}</span>
        </div>
      </Card>
      <Card className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[420px] text-sm">
          <thead className="sticky top-0 bg-brand-700 text-center text-[14px] text-white">
            <tr className="border-b border-slate-100 dark:border-slate-800">
              <th className="w-12 border-r border-white/20 px-2 py-2.5 text-center font-medium">#</th>
              <th className="border-r border-white/20 px-3 py-2.5 font-medium">{data.head.perHolder ? 'Officer' : UNIT_LABEL[data.head.level]}</th>
              {isCase ? <th className="px-3 py-2.5 text-right font-medium">Opening Pending</th> : (
                <>
                  <th className="border-r border-white/20 px-3 py-2.5 text-right font-medium">Current target {symCaption()}</th>
                  <th className="px-3 py-2.5 text-right font-medium">Arrears {symCaption()}</th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((r, i) => (
              <tr key={`${r.unitId}${r.roUserId ?? ''}`}>
                <td className="border-r border-slate-200 px-2 py-1.5 text-center text-xs font-semibold text-slate-500 tabular-nums dark:border-slate-700">{i + 1}</td>
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
              <td />
              <td className="px-3 py-2.5">Total · {rows.length} <span className="text-[10px] font-medium text-slate-400">{isCase ? '' : MILLIONS}</span></td>
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
