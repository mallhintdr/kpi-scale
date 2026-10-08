import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, Save } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../components/AppShell';
import { Badge, Button, Card, Empty, ErrorState, Field, FormError, Input, Loading, SectionTitle, Segmented, Select, useToast } from '../components/ui';
import { get, put } from '../lib/api';
import { useMe } from '../lib/auth';
import { MILLIONS, fmtPKR, fyMonthsUpToNow, monthLabel, useCaps, useFy, type HeadDef, type UnitRef } from '../lib/rev';

interface EntryRow {
  head: HeadDef;
  autoVerify?: boolean;
  target: { target: number; arrearDemand: number; opening: number } | null;
  entry: { current: number; arrear: number; received: number; disposed: number; ref?: string; status: 'submitted' | 'verified' | 'rejected'; note?: string; enteredBy?: { name: string } } | null;
  ytd: { cur: number; arr: number; rec: number; disp: number } | null;
}
interface Sheet { fy: string; month: string; unit: UnitRef; isWasilBaqi: boolean; items: EntryRow[] }
interface MyChargeFull { post: string; unit: { _id: string; type: string; name: string; anc: string[] } }

const STATUS_TONE = {
  submitted: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  verified: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  rejected: 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
};

export default function Entry() {
  const { user } = useMe();
  const caps = useCaps();
  const [fy] = useFy();
  const months = fyMonthsUpToNow(fy);
  const { data: charges = [] } = useQuery({ queryKey: ['rev', 'my-charges'], queryFn: () => get<MyChargeFull[]>('/rev/my-charges') });

  // Wasil Baqi and SCI work across every circle of their tehsil
  const wbTehsils = charges.filter((c) => c.post === 'wasilbaqi' || c.post === 'sci').map((c) => c.unit);
  const patwariCircles = charges.filter((c) => c.post === 'patwari').map((c) => c.unit);
  // Revenue officers enter their registers against the tehsil that contains their charge
  const roTehsils = useMemo(() => {
    const ids = new Set<string>();
    for (const c of charges) if (c.post === 'tehsildar' || c.post === 'naib_tehsildar') ids.add(c.unit.type === 'tehsil' ? c.unit._id : String(c.unit.anc[2]));
    return [...ids];
  }, [charges]);

  const [mode, setMode] = useState<'circle' | 'ro'>('circle');
  const [tehsilId, setTehsilId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [month, setMonth] = useState('');

  useEffect(() => {
    if (!month && months.length) setMonth(months[0]);
  }, [months, month]);
  useEffect(() => {
    if (!charges.length) return;
    if (!patwariCircles.length && !wbTehsils.length && roTehsils.length) setMode('ro');
    if (!tehsilId && wbTehsils[0]) setTehsilId(wbTehsils[0]._id);
    if (!unitId && patwariCircles[0]) setUnitId(patwariCircles[0]._id);
  }, [charges]); // eslint-disable-line react-hooks/exhaustive-deps

  const tehsilCircles = useQuery({
    queryKey: ['rev', 'circles', tehsilId],
    queryFn: () => get<UnitRef[]>(`/rev/units/${tehsilId}/descendants?type=circle`),
    enabled: !!tehsilId,
  });

  const target = mode === 'ro' ? { unitId: roTehsils[0], roUserId: user.id } : { unitId, roUserId: undefined };

  return (
    <>
      <PageHeader title="Enter figures" subtitle={`FY ${fy}`} actions={(caps.isPatwari || caps.isWasilBaqi) && <Link to="/audit-paras" className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-brand-700 ring-1 ring-brand-200 hover:bg-brand-50"><ListChecks className="size-4" />Audit paras</Link>} />
      {!caps.canEnter ? <Card><Empty title="No data entry rights" body="Data is entered by Patwaris, Wasil Baqi Navees and Revenue Officers." /></Card> : (
        <>
          <Card className="mb-4 space-y-3 p-4">
            {roTehsils.length > 0 && (patwariCircles.length > 0 || wbTehsils.length > 0) && (
              <Segmented value={mode} onChange={setMode} options={[{ value: 'circle', label: 'Patwar circle' }, { value: 'ro', label: 'My registers (RO)' }]} />
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {mode === 'circle' && (
                wbTehsils.length ? (
                  <Field label="Patwar circle">
                    {(id) => (
                      <Select id={id} value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                        <option value="">Choose circle…</option>
                        {tehsilCircles.data?.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
                      </Select>
                    )}
                  </Field>
                ) : (
                  <Field label="Patwar circle">
                    {(id) => (
                      <Select id={id} value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                        {patwariCircles.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
                      </Select>
                    )}
                  </Field>
                )
              )}
              <Field label="Month">
                {(id) => (
                  <Select id={id} value={month} onChange={(e) => setMonth(e.target.value)}>
                    {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
                  </Select>
                )}
              </Field>
            </div>
          </Card>
          {target.unitId && month ? <EntrySheet unitId={target.unitId} roUserId={target.roUserId} month={month} /> : <Card><Empty title="Choose a circle and month" /></Card>}
        </>
      )}
    </>
  );
}

type Draft = Record<string, { current: string; arrear: string; received: string; disposed: string; ref: string }>;

function EntrySheet({ unitId, roUserId, month }: { unitId: string; roUserId?: string; month: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['rev', 'entries', unitId, roUserId, month];
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => get<Sheet>(`/rev/entries?unitId=${unitId}&month=${month}${roUserId ? `&roUserId=${roUserId}` : ''}`),
  });
  const [draft, setDraft] = useState<Draft>({});
  useEffect(() => {
    if (!data) return;
    const d: Draft = {};
    for (const it of data.items) {
      const e = it.entry;
      d[it.head.code] = {
        current: e?.current ? String(e.current) : '', arrear: e?.arrear ? String(e.arrear) : '',
        received: e?.received ? String(e.received) : '', disposed: e?.disposed ? String(e.disposed) : '', ref: e?.ref ?? '',
      };
    }
    setDraft(d);
  }, [data]);

  const save = useMutation({
    mutationFn: () => {
      const items = data!.items
        .filter((it) => !(it.entry?.status === 'verified' && !it.autoVerify))
        .map((it) => {
          const d = draft[it.head.code];
          return { head: it.head.code, current: +d.current || 0, arrear: +d.arrear || 0, received: +d.received || 0, disposed: +d.disposed || 0, ref: d.ref || undefined, _touched: it.entry || d.current || d.arrear || d.received || d.disposed };
        })
        .filter((x) => x._touched)
        .map(({ _touched, ...x }) => x);
      if (!items.length) throw new Error('Nothing to save');
      return put<{ saved: number; status: string }>('/rev/entries', { unitId, roUserId, month, items });
    },
    onSuccess: (r) => {
      toast(r.status === 'verified' ? `Saved (${r.saved})` : `Submitted for verification (${r.saved})`);
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ['rev', 'unit'] });
      qc.invalidateQueries({ queryKey: ['rev', 'my-score'] });
    },
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} retry={refetch} />;
  if (!data?.items.length) return <Card><Empty title="No heads to enter here" /></Card>;

  const set = (code: string, k: keyof Draft[string]) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [code]: { ...d[code], [k]: e.target.value } }));
  const revenue = data.items.filter((i) => i.head.kind === 'revenue');
  const cases = data.items.filter((i) => i.head.kind === 'case');

  const locked = (it: EntryRow) => it.entry?.status === 'verified' && !it.autoVerify;
  const allAuto = data.items.every((i) => i.autoVerify);
  const head = (it: EntryRow) => (
    <div className="mb-2 flex items-start justify-between gap-2">
      <div>
        <div className="font-medium">{it.head.name}</div>
        {it.entry?.status === 'rejected' && it.entry.note && <div className="text-xs text-rose-600">{it.entry.note}</div>}
      </div>
      {it.entry && <Badge tone={STATUS_TONE[it.entry.status]} className="capitalize">{it.entry.status}</Badge>}
    </div>
  );

  return (
    <div className="pb-20 lg:pb-0">
      {revenue.length > 0 && (
        <>
          <SectionTitle>Collections · {monthLabel(month)} (Rs)</SectionTitle>
          <div className="grid gap-2.5 lg:grid-cols-2">
            {revenue.map((it) => (
              <Card key={it.head.code} className="p-4">
                {head(it)}
                <div className="mb-3 grid grid-cols-2 gap-x-3 text-xs text-slate-500">
                  <span className="tabular-nums">Target {fmtPKR(it.target?.target ?? 0)} · YTD {fmtPKR(it.ytd?.cur ?? 0)}</span>
                  <span className="tabular-nums">Arrears {fmtPKR(it.target?.arrearDemand ?? 0)} · YTD {fmtPKR(it.ytd?.arr ?? 0)}</span>
                  <span className="col-span-2 text-[10px] text-slate-400">Target/YTD {MILLIONS} · enter amounts below in exact Rs</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Current">{(id) => <Input id={id} type="number" inputMode="decimal" min={0} disabled={locked(it)} value={draft[it.head.code]?.current ?? ''} onChange={set(it.head.code, 'current')} />}</Field>
                  <Field label="Arrears">{(id) => <Input id={id} type="number" inputMode="decimal" min={0} disabled={locked(it)} value={draft[it.head.code]?.arrear ?? ''} onChange={set(it.head.code, 'arrear')} />}</Field>
                </div>
                <div className="mt-3"><Input placeholder="Challan / PSID no." disabled={locked(it)} value={draft[it.head.code]?.ref ?? ''} onChange={set(it.head.code, 'ref')} /></div>
              </Card>
            ))}
          </div>
        </>
      )}
      {cases.length > 0 && (
        <>
          <SectionTitle>Case registers · {monthLabel(month)}</SectionTitle>
          <div className="grid gap-2.5 lg:grid-cols-2">
            {cases.map((it) => {
              const pending = (it.target?.opening ?? 0) + (it.ytd?.rec ?? 0) - (it.ytd?.disp ?? 0);
              return (
                <Card key={it.head.code} className="p-4">
                  {head(it)}
                  <div className="mb-3 text-xs text-slate-500">Opening {it.target?.opening ?? 0} · YTD received {it.ytd?.rec ?? 0}, disposed {it.ytd?.disp ?? 0} · <b>Pending {pending}</b></div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Received">{(id) => <Input id={id} type="number" inputMode="numeric" min={0} disabled={locked(it)} value={draft[it.head.code]?.received ?? ''} onChange={set(it.head.code, 'received')} />}</Field>
                    <Field label="Disposed">{(id) => <Input id={id} type="number" inputMode="numeric" min={0} disabled={locked(it)} value={draft[it.head.code]?.disposed ?? ''} onChange={set(it.head.code, 'disposed')} />}</Field>
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}
      <div className="mt-3"><FormError error={save.error} /></div>
      <div className="pb-safe fixed inset-x-0 bottom-16 z-30 border-t border-slate-200 bg-white/95 p-3 backdrop-blur lg:static lg:mt-4 lg:border-0 lg:bg-transparent lg:p-0 dark:border-slate-800 dark:bg-slate-900/95">
        <Button block loading={save.isPending} onClick={() => save.mutate()}>
          <Save className="size-4" />{allAuto ? 'Save' : 'Submit for verification'}
        </Button>
      </div>
    </div>
  );
}
