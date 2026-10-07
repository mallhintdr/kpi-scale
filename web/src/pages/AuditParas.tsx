import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { PageHeader } from '../components/AppShell';
import { Bar, UnitField } from '../components/rev';
import { Badge, Button, Card, Empty, ErrorState, Field, FormError, Input, Loading, SectionTitle, Segmented, Select, Sheet, Textarea } from '../components/ui';
import { get, patch, post } from '../lib/api';
import { MILLIONS, fmtPKR, useCaps, useMeta, type UnitRef } from '../lib/rev';
import { useSave } from './admin/shared';

interface Para {
  _id: string; unitId: { _id: string; name: string; type: string }; category: string; auditYear: string; paraNo: string; subject?: string;
  amount: number; recovered: number; status: 'pending' | 'settled'; remarks?: string;
}
interface ParaList { unit: UnitRef; items: Para[]; summary: { _id: string; n: number; amount: number; recovered: number; settled: number }[] }

export default function AuditParas() {
  const caps = useCaps();
  const [unit, setUnit] = useState<UnitRef | null>(null);
  const [status, setStatus] = useState<'all' | 'pending' | 'settled'>('pending');
  const [editing, setEditing] = useState<Para | 'new' | null>(null);
  useEffect(() => {
    if (!unit && caps.roots[0]) setUnit(caps.roots[0]);
  }, [caps.roots, unit]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['rev', 'paras', unit?._id, status],
    queryFn: () => get<ParaList>(`/rev/audit-paras?unitId=${unit!._id}${status !== 'all' ? `&status=${status}` : ''}`),
    enabled: !!unit,
  });
  const canAdd = caps.isPatwari || caps.isWasilBaqi;
  const tot = data?.summary.reduce((a, s) => ({ n: a.n + s.n, amount: a.amount + s.amount, recovered: a.recovered + s.recovered, settled: a.settled + s.settled }), { n: 0, amount: 0, recovered: 0, settled: 0 });

  return (
    <>
      <PageHeader title="Audit paras" subtitle="Recorded at tehsil and patwar circle level" actions={canAdd && <Button size="sm" onClick={() => setEditing('new')}><Plus className="size-4" />Add</Button>} />
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <UnitField value={unit} onChange={setUnit} />
        <Segmented value={status} onChange={setStatus} options={[{ value: 'pending', label: 'Pending' }, { value: 'settled', label: 'Settled' }, { value: 'all', label: 'All' }]} />
      </div>
      {isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : data && (
        <>
          {tot && tot.n > 0 && (
            <Card className="mb-3 grid grid-cols-3 divide-x divide-slate-100 dark:divide-slate-800">
              <Mini label="Paras" value={`${tot.settled}/${tot.n}`} sub="settled" />
              <Mini label="Amount" value={fmtPKR(tot.amount)} unit={MILLIONS} />
              <Mini label="Recovered" value={fmtPKR(tot.recovered)} sub={tot.amount ? `${Math.round((tot.recovered / tot.amount) * 100)}%` : undefined} unit={MILLIONS} />
            </Card>
          )}
          {data.summary.length > 0 && (
            <>
              <SectionTitle>By category</SectionTitle>
              <Card className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.summary.map((s) => {
                  const p = s.amount ? (s.recovered / s.amount) * 100 : null;
                  return (
                    <div key={s._id} className="px-4 py-2.5">
                      <div className="mb-1 flex justify-between text-sm"><span className="font-medium">{s._id}</span><span className="text-slate-500 tabular-nums">{s.settled}/{s.n} · {fmtPKR(s.recovered)} / {fmtPKR(s.amount)}</span></div>
                      <Bar value={p} />
                    </div>
                  );
                })}
              </Card>
            </>
          )}
          <SectionTitle>Paras · {data.items.length}</SectionTitle>
          {!data.items.length ? <Card><Empty title="No audit paras" /></Card> : (
            <Card className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.items.map((p) => (
                <button key={p._id} onClick={() => setEditing(p)} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">Para {p.paraNo}</span>
                      <span className="text-xs text-slate-500">{p.auditYear} · {p.category}</span>
                    </div>
                    <div className="truncate text-xs text-slate-500">{p.unitId?.name}{p.subject && <> · {p.subject}</>}</div>
                    <div className="mt-1 text-xs tabular-nums"><b>{fmtPKR(p.recovered)}</b> / {fmtPKR(p.amount)}</div>
                  </div>
                  <Badge tone={p.status === 'settled' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'} className="capitalize">{p.status}</Badge>
                </button>
              ))}
            </Card>
          )}
        </>
      )}
      {editing && <ParaSheet para={editing === 'new' ? null : editing} defaultUnit={unit} onClose={() => setEditing(null)} />}
    </>
  );
}

const Mini = ({ label, value, sub, unit }: { label: string; value: string; sub?: string; unit?: string }) => (
  <div className="p-3 text-center">
    <div className="text-lg font-bold tabular-nums">{value}</div>
    <div className="text-[11px] text-slate-500">{label}{sub && ` · ${sub}`}</div>
    {unit && <div className="text-[10px] text-slate-400">{unit}</div>}
  </div>
);

function ParaSheet({ para, defaultUnit, onClose }: { para: Para | null; defaultUnit: UnitRef | null; onClose: () => void }) {
  const { data: meta } = useMeta();
  const [unit, setUnit] = useState<UnitRef | null>(para ? (para.unitId as UnitRef) : defaultUnit && ['tehsil', 'circle'].includes(defaultUnit.type) ? defaultUnit : null);
  const [f, setF] = useState({
    category: para?.category ?? 'Water Rate', auditYear: para?.auditYear ?? '2024-25', paraNo: para?.paraNo ?? '', subject: para?.subject ?? '',
    amount: String(para?.amount ?? ''), recovered: String(para?.recovered ?? '0'), status: para?.status ?? 'pending', remarks: para?.remarks ?? '',
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const save = useSave(() => {
    const body = { ...f, amount: Number(f.amount), recovered: Number(f.recovered), subject: f.subject || undefined, remarks: f.remarks || undefined };
    return para ? patch(`/rev/audit-paras/${para._id}`, body) : post('/rev/audit-paras', { ...body, unitId: unit?._id });
  }, [['rev']], 'Audit para saved', onClose);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined);
  };
  return (
    <Sheet open onClose={onClose} title={para ? `Para ${para.paraNo}` : 'New audit para'} footer={<Button form="para-form" type="submit" block loading={save.isPending}>Save</Button>}>
      <form id="para-form" onSubmit={submit} className="space-y-4">
        {!para && <Field label="Tehsil or patwar circle">{() => <UnitField value={unit} onChange={setUnit} accept={['tehsil', 'circle']} scope="work" />}</Field>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">{(id) => <Select id={id} value={f.category} onChange={set('category')}>{meta?.auditCategories.map((c) => <option key={c}>{c}</option>)}</Select>}</Field>
          <Field label="Audit year">{(id) => <Input id={id} required pattern="\d{4}-\d{2}" placeholder="2024-25" value={f.auditYear} onChange={set('auditYear')} disabled={!!para} />}</Field>
          <Field label="Para no.">{(id) => <Input id={id} required value={f.paraNo} onChange={set('paraNo')} disabled={!!para} />}</Field>
          <Field label="Status">{(id) => <Select id={id} value={f.status} onChange={set('status')}><option value="pending">Pending</option><option value="settled">Settled</option></Select>}</Field>
          <Field label="Amount (Rs)">{(id) => <Input id={id} type="number" inputMode="decimal" min={0} required value={f.amount} onChange={set('amount')} />}</Field>
          <Field label="Recovered (Rs)">{(id) => <Input id={id} type="number" inputMode="decimal" min={0} value={f.recovered} onChange={set('recovered')} />}</Field>
        </div>
        <Field label="Subject">{(id) => <Input id={id} value={f.subject} onChange={set('subject')} />}</Field>
        <Field label="Remarks">{(id) => <Textarea id={id} rows={2} value={f.remarks} onChange={set('remarks')} />}</Field>
        <FormError error={save.error} />
      </form>
    </Sheet>
  );
}
