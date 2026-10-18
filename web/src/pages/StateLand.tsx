/**
 * State Land Directory — every state-owned holding in each mouza.
 *   /state-land       directory (filters, list, Excel), summary (category, mouza-wise, listing completion)
 *   /state-land/:id   the holding: details, verification (Girdawar → Tehsildar), litigation, documents, history
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, Download, FileText, LocateFixed, MapPin, Plus, RotateCcw, Search, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import { useDeferredValue, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../components/AppShell';
import { UnitField } from '../components/rev';
import { Badge, Button, Card, Empty, ErrorState, Field, FormError, Input, Loading, SectionTitle, Segmented, Select, Textarea, useToast } from '../components/ui';
import { ApiError, del, download, get, patch, post } from '../lib/api';
import { useCaps, type UnitRef } from '../lib/rev';
import { AutoInput, DocSheet, LSheet, fmt, iso, splitNos } from './Litigation';

/* ---------- types ---------- */
interface Category { key: string; label: string; subTypes: string[]; owner?: string; sections?: ('acquisition' | 'allotment')[] }
interface Meta {
  categories: Category[]; departments: string[]; possession: [string, string][]; recordStatus: [string, string][]; landClass: string[]; uses: string[];
  encroachmentNature: string[]; encroachmentAction: string[]; docCategories: { key: string; label: string }[]; canEnter: boolean; canVerify: boolean; canApprove: boolean;
}
type Area = { kanal?: number; marla?: number; feet?: number };
type Status = 'entered' | 'verified' | 'approved' | 'returned';
interface Holding {
  _id: string; holdingId: string; unitId: { _id: string; name: string }; hadbast?: string; khewat?: string; khatauni?: string;
  land: { murabba?: string; khasraNos: string[]; parcels?: { murabba?: string; khasras: string[] }[] }; jamabandiYear?: string; location?: string;
  gps?: { lat: number; lng: number; at?: string }; boundaries?: { north?: string; south?: string; east?: string; west?: string };
  area: Area; acres: number; linear?: { lengthFt?: number; widthFt?: number };
  category: string; subType?: string; ownerRecord?: string; custodian?: string; landClass?: string; use?: string; structures?: string;
  acquisition?: { department?: string; purpose?: string; awardNo?: string; awardDate?: string; compensation?: 'yes' | 'no' | 'partly' | null; compensationAmount?: number; mutationNo?: string; mutationDate?: string };
  allotment?: { scheme?: string; allottee?: string; parentage?: string; orderNo?: string; orderDate?: string; authority?: string; leaseFrom?: string; leaseTo?: string; conditionsMet?: 'yes' | 'no' | 'review' | null; proprietary?: 'granted' | 'pending' | 'na' | null; mutationNo?: string };
  possession: string; encroachment?: { area?: Area; acres?: number; encroachers: string[]; nature?: string; since?: number; action?: string; retrievedOn?: string; retrievedArea?: Area };
  underLitigation: boolean; litigationIds: string[];
  record: { status: string; mutationNos?: string; demarcation?: 'yes' | 'no' | null; demarcationDate?: string; demarcationRef?: string; computerised?: 'yes' | 'no' | 'unchecked' | null; discrepancy?: string };
  lastVisit?: string; note?: string; status: Status; returnRemarks?: string;
  verifiedBy?: { name: string }; verifiedAt?: string; approvedBy?: { name: string }; approvedAt?: string; createdBy?: { name: string }; createdAt: string;
  history: { at: string; by?: { name: string }; action: string; remarks?: string }[];
}
interface Doc { _id: string; category: string; title?: string; docDate?: string; pages?: number; size: number; createdAt: string; uploadedBy?: { name: string } }

const useMeta = () => useQuery({ queryKey: ['sl', 'meta'], queryFn: () => get<Meta>('/state-land/meta'), staleTime: 300_000 });
const acres = (n?: number) => (n == null ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const kmf = (a?: Area) => [a?.kanal ? `${a.kanal} K` : '', a?.marla ? `${a.marla} M` : '', a?.feet ? `${a.feet} Ft` : ''].filter(Boolean).join(' – ') || '—';
const STATUS: Record<Status, [string, string]> = {
  entered: ['Awaiting verification', 'bg-amber-100 text-amber-800'],
  verified: ['Verified · awaiting approval', 'bg-sky-100 text-sky-800'],
  approved: ['Approved', 'bg-emerald-100 text-emerald-800'],
  returned: ['Returned for correction', 'bg-rose-100 text-rose-800'],
};
const StatusBadge = ({ s }: { s: Status }) => <Badge tone={STATUS[s][1]}>{STATUS[s][0]}</Badge>;
const label = (pairs: [string, string][] | undefined, k?: string | null) => pairs?.find(([x]) => x === k)?.[1] ?? k ?? '—';
const th = 'border-b border-r border-white/50 px-2.5 py-2';
const td = 'border-b border-r border-slate-200 px-2.5 py-1.5 dark:border-slate-700';

/* ================================================================== *
 *  Directory
 * ================================================================== */
export function StateLandList() {
  const meta = useMeta();
  const [view, setView] = useState<'directory' | 'summary'>('directory');
  const [area, setArea] = useState<UnitRef | null>(null);
  const [search, setSearch] = useState('');
  const term = useDeferredValue(search.trim());
  const [category, setCategory] = useState('');
  const [possession, setPossession] = useState('');
  const [recordStatus, setRecordStatus] = useState('');
  const [status, setStatus] = useState('');
  const [extra, setExtra] = useState<{ litigation?: 'yes'; leases?: 'expired' | 'expiring' }>({});
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [marking, setMarking] = useState(false);
  const params = new URLSearchParams({ page: String(page), ...(term ? { search: term } : {}), ...(area ? { unitId: area._id } : {}), ...(category ? { category } : {}), ...(possession ? { possession } : {}), ...(recordStatus ? { recordStatus } : {}), ...(status ? { status } : {}), ...extra });
  useEffect(() => setPage(1), [term, area, category, possession, recordStatus, status, extra]);
  const list = useQuery({ queryKey: ['sl', 'list', params.toString()], queryFn: () => get<{ items: (Holding & { categoryLabel: string; possessionLabel: string; recordLabel: string })[]; total: number }>(`/state-land?${params}`) });
  const sum = useQuery({ queryKey: ['sl', 'summary', area?._id], queryFn: () => get<Summary>(`/state-land/summary${area ? `?unitId=${area._id}` : ''}`) });
  const t = sum.data?.totals;
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 50));
  const clear = () => { setCategory(''); setPossession(''); setRecordStatus(''); setStatus(''); setExtra({}); setSearch(''); };
  const pick = (f: () => void) => () => { clear(); f(); setView('directory'); };

  return (
    <>
      <PageHeader title="State Land Directory" subtitle="Every piece of state-owned land in your jurisdiction" actions={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => download(`/state-land/export/xlsx?${params}`, 'state-land-directory.xlsx')}><Download className="size-4" />Excel</Button>
          {meta.data?.canEnter && <Button size="sm" variant="secondary" onClick={() => setMarking(true)}><CheckCircle2 className="size-4" />Mouza Listing</Button>}
          {meta.data?.canEnter && <Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" />New Holding</Button>}
        </div>
      } />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Segmented value={view} onChange={setView} options={[{ value: 'directory', label: 'Directory' }, { value: 'summary', label: 'Summary' }]} />
        <div className="w-72 max-w-full"><UnitField value={area} onChange={setArea} placeholder="Whole jurisdiction" /></div>
        {area && <Button size="sm" variant="ghost" onClick={() => setArea(null)}><X className="size-4" />Clear area</Button>}
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {[
          { l: 'Holdings', v: t?.holdings?.toLocaleString(), on: pick(() => {}) },
          { l: 'Total Acres', v: acres(t?.acres) },
          { l: 'Encroached Acres', v: acres(t?.encroachedAcres), tone: t?.encroachedAcres ? 'text-rose-700' : undefined, on: pick(() => setPossession('any_encroached')) },
          { l: 'Under Litigation', v: t?.litigation, tone: 'text-violet-700', on: pick(() => setExtra({ litigation: 'yes' })) },
          { l: 'Not Mutated', v: t?.notMutated, tone: t?.notMutated ? 'text-amber-700' : undefined, on: pick(() => setRecordStatus('not_mutated')) },
          { l: 'Leases Expired', v: t?.leasesExpired, tone: t?.leasesExpired ? 'text-rose-700' : undefined, on: pick(() => setExtra({ leases: 'expired' })) },
          { l: 'Approved', v: t ? `${t.approved} / ${t.holdings}` : undefined, tone: 'text-emerald-700', on: pick(() => setStatus('approved')) },
        ].map((c) => (
          <Card key={c.l} className={clsx('p-3', c.on && 'cursor-pointer hover:ring-brand-200')} onClick={c.on}>
            <div className={clsx('text-xl font-bold tabular-nums', c.tone)}>{c.v ?? '—'}</div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{c.l}</div>
          </Card>
        ))}
      </div>

      {view === 'summary' ? <SummaryView data={sum.data} loading={sum.isLoading} meta={meta.data} canMark={!!meta.data?.canEnter} canConfirm={!!meta.data?.canVerify} onPickCategory={(k) => { clear(); setCategory(k); setView('directory'); }} /> : <>
        <Card className="mb-3 grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-5 print:hidden">
          <div className="relative lg:col-span-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><Input className="pl-9" placeholder="ID, khasra, khewat, allottee, encroacher…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <Select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Any category</option>{meta.data?.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Select>
          <Select value={possession} onChange={(e) => setPossession(e.target.value)}><option value="">Any possession</option><option value="any_encroached">Encroached (fully or partly)</option>{meta.data?.possession.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          <Select value={recordStatus} onChange={(e) => setRecordStatus(e.target.value)}><option value="">Any record status</option>{meta.data?.recordStatus.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          <div className="flex gap-2">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any verification</option>{(Object.keys(STATUS) as Status[]).map((k) => <option key={k} value={k}>{STATUS[k][0]}</option>)}</Select>
            {(category || possession || recordStatus || status || term || extra.litigation || extra.leases) && <Button variant="ghost" onClick={clear}><X className="size-4" /></Button>}
          </div>
        </Card>
        {(extra.litigation || extra.leases) && <div className="mb-2 text-xs text-slate-500">Showing: {extra.litigation ? 'under litigation' : extra.leases === 'expired' ? 'leases expired' : 'leases expiring in 60 days'}</div>}
        {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} retry={list.refetch} /> : !list.data?.items.length ? (
          <Card><Empty icon={MapPin} title="No holdings" body={meta.data?.canEnter ? 'Add the first state land holding with New Holding.' : 'No state land recorded here yet.'} /></Card>
        ) : (
          <>
            <Card className="overflow-x-auto">
              <table className="w-full min-w-[900px] border-separate border-spacing-0 text-[13px]">
                <thead className="bg-brand-700 text-center text-[12.5px] text-white">
                  <tr>{['#', 'Holding ID', 'Mouza', 'Category', 'Murabba / Khasra', 'Acres', 'Possession', 'Record', 'Status'].map((h) => <th key={h} className={th}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {list.data.items.map((h, i) => (
                    <tr key={h._id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                      <td className={clsx(td, 'text-center text-xs text-slate-500')}>{(page - 1) * 50 + i + 1}</td>
                      <td className={clsx(td, 'whitespace-nowrap font-mono text-[12px] font-semibold')}><Link to={`/state-land/${h._id}`} className="hover:underline">{h.holdingId}</Link></td>
                      <td className={td}>{h.unitId?.name.replace(' (test)', '')}</td>
                      <td className={td}>{h.categoryLabel}{h.subType && <div className="text-[11px] text-slate-500">{h.subType}{h.custodian && ` · ${h.custodian}`}</div>}</td>
                      <td className={clsx(td, 'text-xs')} dir="auto">{h.land.murabba || h.land.khasraNos.join(', ')}</td>
                      <td className={clsx(td, 'text-right tabular-nums')}>{acres(h.acres)}</td>
                      <td className={clsx(td, (h.possession === 'encroached' || h.possession === 'part_encroached') && 'font-semibold text-rose-700')}>{h.possessionLabel}{h.underLitigation && <div className="text-[11px] font-normal text-violet-700">Under litigation</div>}</td>
                      <td className={clsx(td, h.record?.status !== 'mutated' && 'text-amber-700')}>{h.recordLabel}</td>
                      <td className={clsx(td, 'border-r-0 text-center')}><StatusBadge s={h.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <div className="mt-2 flex items-center justify-between text-sm text-slate-500">
              <span>{list.data.total.toLocaleString()} holding(s)</span>
              {pages > 1 && <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><span className="self-center">Page {page} of {pages}</span><Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div>}
            </div>
          </>
        )}
      </>}
      {creating && <HoldingForm onClose={() => setCreating(false)} />}
      {marking && <MouzaListingSheet onClose={() => setMarking(false)} />}
    </>
  );
}

/* ---------- summary: category-wise, mouza-wise, listing completion ---------- */
type Sums = { holdings: number; acres: number; encroachedAcres: number; encroached: number; litigation: number; notMutated: number; leasesExpired: number; approved: number; verified: number; returned: number };
interface Summary {
  totals: Sums; leasesExpiring: number;
  byCategory: (Sums & { _id: string; label: string })[];
  byMouza: (Sums & { _id: string; name: string; tehsil?: string; complete: boolean; confirmed: boolean })[];
  mouzas: { total: number; complete: number; confirmed: number };
}
function SummaryView({ data, loading, canMark, canConfirm, onPickCategory }: { data?: Summary; loading: boolean; meta?: Meta; canMark: boolean; canConfirm: boolean; onPickCategory: (k: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  if (loading || !data) return <Loading />;
  const mark = async (unitId: string, action: 'complete' | 'reopen' | 'confirm') => {
    try { await post(`/state-land/mouza/${unitId}`, { action }); qc.invalidateQueries({ queryKey: ['sl'] }); toast(action === 'confirm' ? 'Listing confirmed' : action === 'complete' ? 'Marked complete' : 'Reopened'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const pct = data.mouzas.total ? Math.round((data.mouzas.confirmed / data.mouzas.total) * 100) : 0;
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-x-6 gap-y-1 p-3 text-sm">
        <b>Listing completion</b>
        <span>{data.mouzas.total.toLocaleString()} mouzas</span>
        <span className="text-sky-700">{data.mouzas.complete} marked complete by Patwari</span>
        <span className="text-emerald-700">{data.mouzas.confirmed} confirmed by Girdawar ({pct}%)</span>
        {data.leasesExpiring > 0 && <span className="text-amber-700">{data.leasesExpiring} lease(s) expiring within 60 days</span>}
      </Card>
      <div>
        <SectionTitle>By Category</SectionTitle>
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-separate border-spacing-0 text-[13px]">
            <thead className="bg-brand-700 text-center text-[12.5px] text-white"><tr>{['Category', 'Holdings', 'Acres', 'Encroached Acres', 'Under Litigation', 'Not Mutated', 'Approved'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody>
              {data.byCategory.map((c) => (
                <tr key={c._id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60" onClick={() => onPickCategory(c._id)}>
                  <td className={clsx(td, 'font-medium text-brand-800 underline-offset-2 hover:underline')}>{c.label}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{c.holdings}</td>
                  <td className={clsx(td, 'text-right tabular-nums')}>{acres(c.acres)}</td>
                  <td className={clsx(td, 'text-right tabular-nums', c.encroachedAcres > 0 && 'text-rose-700')}>{acres(c.encroachedAcres)}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{c.litigation}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{c.notMutated}</td>
                  <td className={clsx(td, 'border-r-0 text-center tabular-nums')}>{c.approved} / {c.holdings}</td>
                </tr>
              ))}
              {!data.byCategory.length && <tr><td colSpan={7} className={clsx(td, 'text-center text-slate-500')}>No holdings yet</td></tr>}
            </tbody>
            {data.byCategory.length > 0 && (
              <tfoot className="bg-slate-50 font-semibold dark:bg-slate-800">
                <tr><td className={td}>Total</td><td className={clsx(td, 'text-center')}>{data.totals.holdings}</td><td className={clsx(td, 'text-right')}>{acres(data.totals.acres)}</td><td className={clsx(td, 'text-right')}>{acres(data.totals.encroachedAcres)}</td><td className={clsx(td, 'text-center')}>{data.totals.litigation}</td><td className={clsx(td, 'text-center')}>{data.totals.notMutated}</td><td className={clsx(td, 'border-r-0 text-center')}>{data.totals.approved} / {data.totals.holdings}</td></tr>
              </tfoot>
            )}
          </table>
        </Card>
      </div>
      <div>
        <SectionTitle>Mouza Summary</SectionTitle>
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-separate border-spacing-0 text-[13px]">
            <thead className="bg-brand-700 text-center text-[12.5px] text-white"><tr>{['#', 'Tehsil', 'Mouza', 'Holdings', 'Acres', 'Encroached Acres', 'Litigation', 'Not Mutated', 'Leases Expired', 'Approved', 'Listing'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody>
              {data.byMouza.map((m, i) => (
                <tr key={m._id}>
                  <td className={clsx(td, 'text-center text-xs text-slate-500')}>{i + 1}</td>
                  <td className={td}>{m.tehsil}</td>
                  <td className={td}>{m.name.replace(' (test)', '')}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{m.holdings}</td>
                  <td className={clsx(td, 'text-right tabular-nums')}>{acres(m.acres)}</td>
                  <td className={clsx(td, 'text-right tabular-nums', m.encroachedAcres > 0 && 'text-rose-700')}>{acres(m.encroachedAcres)}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{m.litigation}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{m.notMutated}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{m.leasesExpired}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{m.approved} / {m.holdings}</td>
                  <td className={clsx(td, 'border-r-0 whitespace-nowrap text-center text-xs')}>
                    {m.confirmed ? <span className="font-semibold text-emerald-700">Confirmed</span> : m.complete ? <span className="text-sky-700">Complete</span> : <span className="text-slate-400">In progress</span>}
                    <span className="print:hidden">
                      {canConfirm && m.complete && !m.confirmed && <button className="ml-2 font-semibold text-brand-700 hover:underline" onClick={() => mark(m._id, 'confirm')}>Confirm</button>}
                      {canMark && !m.complete && <button className="ml-2 font-semibold text-brand-700 hover:underline" onClick={() => mark(m._id, 'complete')}>Mark complete</button>}
                      {canMark && m.complete && <button className="ml-2 text-slate-500 hover:underline" onClick={() => mark(m._id, 'reopen')}>Reopen</button>}
                    </span>
                  </td>
                </tr>
              ))}
              {!data.byMouza.length && <tr><td colSpan={11} className={clsx(td, 'text-center text-slate-500')}>No mouza has state land recorded yet</td></tr>}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

/** Patwari: mark a mouza's listing complete (including mouzas with no state land at all). */
function MouzaListingSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mq, setMq] = useState('');
  const mterm = useDeferredValue(mq);
  const mouzas = useQuery({ queryKey: ['sl', 'mouzas', mterm], queryFn: () => get<{ _id: string; name: string; tehsil?: string }[]>(`/state-land/mouzas?search=${encodeURIComponent(mterm)}`) });
  const [unitId, setUnitId] = useState('');
  const state = useQuery({ queryKey: ['sl', 'mouza', unitId], queryFn: () => get<{ mark?: { complete: boolean; confirmed: boolean; completedBy?: { name: string }; completedAt?: string; confirmedBy?: { name: string } } }>(`/state-land/mouza/${unitId}`), enabled: !!unitId });
  const act = async (action: 'complete' | 'reopen') => {
    try { await post(`/state-land/mouza/${unitId}`, { action }); qc.invalidateQueries({ queryKey: ['sl'] }); toast(action === 'complete' ? 'Listing marked complete' : 'Listing reopened'); onClose(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const m = state.data?.mark;
  return (
    <LSheet open onClose={onClose} title="Mouza State Land Listing">
      <p className="text-sm text-slate-600 dark:text-slate-300">When every state land holding of a mouza is entered, mark its listing complete; the Girdawar then confirms it. Mark a mouza with no state land complete too.</p>
      <Field label="Mouza">{(id) => <AutoInput id={id} strict placeholder="Type mouza name…" onQuery={setMq} value={unitId} options={(mouzas.data ?? []).map((x) => ({ value: x._id, label: x.name, hint: x.tehsil }))} onChange={setUnitId} />}</Field>
      {unitId && (
        <Card className="space-y-2 p-3 text-sm">
          <div>Status: {m?.confirmed ? <b className="text-emerald-700">Confirmed by {m.confirmedBy?.name}</b> : m?.complete ? <b className="text-sky-700">Marked complete by {m.completedBy?.name} on {fmt(m.completedAt)}</b> : <b className="text-slate-500">In progress</b>}</div>
          {m?.complete ? <Button variant="secondary" onClick={() => act('reopen')}><RotateCcw className="size-4" />Reopen Listing</Button> : <Button onClick={() => act('complete')}><CheckCircle2 className="size-4" />Mark Listing Complete</Button>}
        </Card>
      )}
    </LSheet>
  );
}

/* ================================================================== *
 *  New / edit holding
 * ================================================================== */
type Parcel = { murabba: string; khasras: string };
const n = (s: string) => (s.trim() ? Number(s) : undefined);
const s0 = (v?: number | null) => (v == null ? '' : String(v));

function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <div className="rounded-lg border border-slate-300 p-2.5 dark:border-slate-600">
      <div className="mb-2 flex items-baseline justify-between gap-2"><span className="text-xs font-bold uppercase tracking-wide text-brand-700">{title}</span>{note && <span className="text-[11px] text-slate-500">{note}</span>}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
function AreaInputs({ value, onChange }: { value: { kanal: string; marla: string; feet: string }; onChange: (v: { kanal: string; marla: string; feet: string }) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {(['kanal', 'marla', 'feet'] as const).map((k) => <Field key={k} label={k === 'feet' ? 'Feet' : k[0].toUpperCase() + k.slice(1)}>{(id) => <Input id={id} type="number" min={0} step="any" value={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.value })} />}</Field>)}
    </div>
  );
}
const areaIn = (a?: Area) => ({ kanal: s0(a?.kanal), marla: s0(a?.marla), feet: s0(a?.feet) });
const areaOut = (a: { kanal: string; marla: string; feet: string }) => ({ kanal: n(a.kanal), marla: n(a.marla), feet: n(a.feet) });

function HoldingForm({ initial, onClose }: { initial?: Holding; onClose: () => void }) {
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const m = meta.data;
  const [mq, setMq] = useState('');
  const mterm = useDeferredValue(mq);
  const mouzas = useQuery({ queryKey: ['sl', 'mouzas', mterm], queryFn: () => get<{ _id: string; name: string; tehsil?: string }[]>(`/state-land/mouzas?search=${encodeURIComponent(mterm)}`), enabled: !initial });
  const h = initial;
  const parcelsInit: Parcel[] = h?.land.parcels?.some((p) => p.murabba) ? h.land.parcels.filter((p) => p.murabba).map((p) => ({ murabba: p.murabba ?? '', khasras: p.khasras.join(', ') })) : [{ murabba: '', khasras: '' }];
  const [f, setF] = useState(() => ({
    unitId: h?.unitId._id ?? '', mouzaName: h?.unitId.name ?? '',
    hadbast: h?.hadbast ?? '', khewat: h?.khewat ?? '', khatauni: h?.khatauni ?? '', jamabandiYear: h?.jamabandiYear ?? '', location: h?.location ?? '',
    landMode: (h && !h.land.parcels?.some((p) => p.murabba) && h.land.khasraNos.length ? 'khasra' : 'murabba') as 'murabba' | 'khasra',
    parcels: parcelsInit, khasraNos: h && !h.land.parcels?.some((p) => p.murabba) ? h.land.khasraNos.join(', ') : '',
    gps: h?.gps ?? null as Holding['gps'] | null,
    boundaries: { north: h?.boundaries?.north ?? '', south: h?.boundaries?.south ?? '', east: h?.boundaries?.east ?? '', west: h?.boundaries?.west ?? '' },
    area: areaIn(h?.area), lengthFt: s0(h?.linear?.lengthFt), widthFt: s0(h?.linear?.widthFt),
    category: h?.category ?? '', subType: h?.subType ?? '', ownerRecord: h?.ownerRecord ?? '', custodian: h?.custodian ?? '', landClass: h?.landClass ?? '', use: h?.use ?? '', structures: h?.structures ?? '',
    acq: { department: h?.acquisition?.department ?? '', purpose: h?.acquisition?.purpose ?? '', awardNo: h?.acquisition?.awardNo ?? '', awardDate: iso(h?.acquisition?.awardDate), compensation: h?.acquisition?.compensation ?? '', compensationAmount: s0(h?.acquisition?.compensationAmount), mutationNo: h?.acquisition?.mutationNo ?? '', mutationDate: iso(h?.acquisition?.mutationDate) },
    allot: { scheme: h?.allotment?.scheme ?? '', allottee: h?.allotment?.allottee ?? '', parentage: h?.allotment?.parentage ?? '', orderNo: h?.allotment?.orderNo ?? '', orderDate: iso(h?.allotment?.orderDate), authority: h?.allotment?.authority ?? '', leaseFrom: iso(h?.allotment?.leaseFrom), leaseTo: iso(h?.allotment?.leaseTo), conditionsMet: h?.allotment?.conditionsMet ?? '', proprietary: h?.allotment?.proprietary ?? '', mutationNo: h?.allotment?.mutationNo ?? '' },
    possession: h?.possession ?? '',
    enc: { area: areaIn(h?.encroachment?.area), encroachers: h?.encroachment?.encroachers?.length ? h.encroachment.encroachers : [''], nature: h?.encroachment?.nature ?? '', since: s0(h?.encroachment?.since), action: h?.encroachment?.action ?? '', retrievedOn: iso(h?.encroachment?.retrievedOn), retrievedArea: areaIn(h?.encroachment?.retrievedArea) },
    underLitigation: h?.underLitigation ?? false, litigationIds: (h?.litigationIds ?? []).map((x: any) => (typeof x === 'string' ? x : x._id)) as string[],
    record: { status: h?.record.status ?? '', mutationNos: h?.record.mutationNos ?? '', demarcation: h?.record.demarcation ?? '', demarcationDate: iso(h?.record.demarcationDate), demarcationRef: h?.record.demarcationRef ?? '', computerised: h?.record.computerised ?? '', discrepancy: h?.record.discrepancy ?? '' },
    lastVisit: iso(h?.lastVisit), note: h?.note ?? '',
  }));
  type F = typeof f;
  const set = <K extends keyof F>(k: K, v: F[K]) => setF((x) => ({ ...x, [k]: v }));
  const cat = m?.categories.find((c) => c.key === f.category);
  const encroached = f.possession === 'encroached' || f.possession === 'part_encroached';
  const cases = useQuery({ queryKey: ['sl', 'cases', f.unitId], queryFn: () => get<{ _id: string; caseId: string; label: string }[]>(`/state-land/mouza-cases?unitId=${f.unitId}`), enabled: !!f.unitId && f.underLitigation });
  const [error, setError] = useState<unknown>(null);
  const [dup, setDup] = useState<{ caseId: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);

  const locate = () => {
    if (!navigator.geolocation) return toast('This device cannot give a location', 'error');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { set('gps', { lat: p.coords.latitude, lng: p.coords.longitude, at: new Date().toISOString() }); setLocating(false); },
      () => { toast('Location not available — allow location access and try at the site', 'error'); setLocating(false); },
      { enableHighAccuracy: true, timeout: 20_000 },
    );
  };

  const save = async (force = false) => {
    setBusy(true); setError(null);
    const body = {
      ...(initial ? {} : { unitId: f.unitId }),
      hadbast: f.hadbast || undefined, khewat: f.khewat || undefined, khatauni: f.khatauni || undefined, jamabandiYear: f.jamabandiYear || undefined, location: f.location || undefined,
      land: { parcels: f.landMode === 'murabba' ? f.parcels.map((p) => ({ murabba: p.murabba.trim(), khasras: splitNos(p.khasras) })) : [{ khasras: splitNos(f.khasraNos) }] },
      gps: f.gps ?? null,
      boundaries: f.boundaries,
      area: areaOut(f.area), linear: { lengthFt: n(f.lengthFt), widthFt: n(f.widthFt) },
      category: f.category, subType: f.subType || undefined, ownerRecord: f.ownerRecord || undefined, custodian: f.custodian || undefined, landClass: f.landClass || undefined, use: f.use || undefined, structures: f.structures || undefined,
      ...(cat?.sections?.includes('acquisition') ? { acquisition: { ...f.acq, awardDate: f.acq.awardDate || null, mutationDate: f.acq.mutationDate || null, compensation: f.acq.compensation || null, compensationAmount: n(f.acq.compensationAmount) ?? null } } : {}),
      ...(cat?.sections?.includes('allotment') ? { allotment: { ...f.allot, orderDate: f.allot.orderDate || null, leaseFrom: f.allot.leaseFrom || null, leaseTo: f.allot.leaseTo || null, conditionsMet: f.allot.conditionsMet || null, proprietary: f.allot.proprietary || null } } : {}),
      possession: f.possession,
      ...(encroached ? { encroachment: { area: areaOut(f.enc.area), encroachers: f.enc.encroachers.map((x) => x.trim()).filter(Boolean), nature: f.enc.nature || undefined, since: n(f.enc.since) ?? null, action: f.enc.action || undefined, retrievedOn: f.enc.retrievedOn || null, retrievedArea: areaOut(f.enc.retrievedArea) } } : {}),
      underLitigation: f.underLitigation, litigationIds: f.underLitigation ? f.litigationIds : [],
      record: { ...f.record, demarcation: f.record.demarcation || null, demarcationDate: f.record.demarcationDate || null, computerised: f.record.computerised || null },
      lastVisit: f.lastVisit || null, note: f.note || undefined,
    };
    try {
      const r = initial ? await patch<Holding>(`/state-land/${initial._id}`, body) : await post<Holding>(`/state-land${force ? '?force=true' : ''}`, body);
      qc.invalidateQueries({ queryKey: ['sl'] });
      toast(initial ? 'Holding updated — sent for verification' : `Holding ${r.holdingId} created`);
      onClose();
      if (!initial) navigate(`/state-land/${r._id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'POSSIBLE_DUPLICATE') setDup(e.body?.error?.details ?? null);
      else setError(e);
    } finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!initial && !f.unitId) return setError(new Error('Choose the mouza from the list'));
    if (!f.category) return setError(new Error('Choose the category'));
    if (!f.possession) return setError(new Error('Choose the possession status'));
    if (!f.record.status) return setError(new Error('Choose the record status'));
    save();
  };
  const opts = (xs?: string[]) => xs ?? [];

  return (
    <LSheet open onClose={onClose} title={initial ? `Edit ${initial.holdingId}` : 'New State Land Holding'} footer={<Button form="sl-form" type="submit" block loading={busy}>{initial ? 'Save (goes for verification again)' : 'Save Holding'}</Button>}>
      <form id="sl-form" onSubmit={submit} className="space-y-3">
        <Section title="Location and record">
          <div className="grid gap-2 sm:grid-cols-4">
            {!initial && (
              <div className="sm:col-span-2"><Field label="Mouza">
                {(id) => <AutoInput id={id} strict required placeholder="Type mouza name…" onQuery={setMq} value={f.unitId}
                  options={[...(f.unitId ? [{ value: f.unitId, label: f.mouzaName }] : []), ...(mouzas.data ?? []).filter((x) => x._id !== f.unitId).map((x) => ({ value: x._id, label: x.name, hint: x.tehsil }))]}
                  onChange={(v) => setF((x) => ({ ...x, unitId: v, mouzaName: mouzas.data?.find((y) => y._id === v)?.name ?? x.mouzaName }))} />}
              </Field></div>
            )}
            <Field label="Hadbast No.">{(id) => <Input id={id} value={f.hadbast} onChange={(e) => set('hadbast', e.target.value)} />}</Field>
            <Field label="Jamabandi Year">{(id) => <Input id={id} value={f.jamabandiYear} onChange={(e) => set('jamabandiYear', e.target.value)} placeholder="e.g. 2022-23" />}</Field>
            <Field label="Khewat No(s).">{(id) => <Input id={id} value={f.khewat} onChange={(e) => set('khewat', e.target.value)} />}</Field>
            <Field label="Khatauni No(s).">{(id) => <Input id={id} value={f.khatauni} onChange={(e) => set('khatauni', e.target.value)} />}</Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-slate-500">How land is recorded in this tehsil</span>
            <Segmented value={f.landMode} onChange={(v) => set('landMode', v)} options={[{ value: 'murabba', label: 'Murabba + Killa / Khasra' }, { value: 'khasra', label: 'Khasra Only' }]} />
          </div>
          {f.landMode === 'murabba' ? (
            <div className="space-y-1.5">
              <div className="grid grid-cols-[8rem_1fr_2rem] gap-1.5 text-[12px] font-semibold text-slate-600 dark:text-slate-300"><span>Murabba No.</span><span>Killa / Khasra Nos. (comma separated)</span><span /></div>
              {f.parcels.map((p, i) => (
                <div key={i} className="grid grid-cols-[8rem_1fr_2rem] items-center gap-1.5">
                  <Input value={p.murabba} placeholder="e.g. 45" onChange={(e) => set('parcels', f.parcels.map((y, j) => (j === i ? { ...y, murabba: e.target.value } : y)))} />
                  <Input value={p.khasras} placeholder="e.g. 12, 13, 18/1" onChange={(e) => set('parcels', f.parcels.map((y, j) => (j === i ? { ...y, khasras: e.target.value } : y)))} />
                  {f.parcels.length > 1 ? <Button type="button" size="sm" variant="ghost" aria-label="Remove murabba" onClick={() => set('parcels', f.parcels.filter((_, j) => j !== i))}><X className="size-4" /></Button> : <span />}
                </div>
              ))}
              <button type="button" className="text-xs font-semibold text-brand-700 hover:underline" onClick={() => set('parcels', [...f.parcels, { murabba: '', khasras: '' }])}>+ Add another murabba</button>
            </div>
          ) : <Field label="Khasra / Killa Nos.">{(id) => <Input id={id} value={f.khasraNos} onChange={(e) => set('khasraNos', e.target.value)} placeholder="e.g. 45/2, 46, 112" />}</Field>}
          <Field label="Location Description">{(id) => <Input id={id} dir="auto" value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="e.g. along Hasilpur–Bahawalpur road, north side" />}</Field>
          <div className="grid gap-2 sm:grid-cols-4">
            {(['north', 'south', 'east', 'west'] as const).map((k) => <Field key={k} label={k[0].toUpperCase() + k.slice(1)}>{(id) => <Input id={id} dir="auto" value={f.boundaries[k]} onChange={(e) => set('boundaries', { ...f.boundaries, [k]: e.target.value })} placeholder="Boundary" />}</Field>)}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Button type="button" size="sm" variant="secondary" loading={locating} onClick={locate}><LocateFixed className="size-4" />{f.gps ? 'Update GPS Point' : 'Capture GPS at Site'}</Button>
            {f.gps ? <span className="font-mono text-xs">{f.gps.lat.toFixed(6)}, {f.gps.lng.toFixed(6)} <button type="button" className="ml-1 text-slate-500 hover:underline" onClick={() => set('gps', null)}>clear</button></span> : <span className="text-xs text-slate-500">Optional</span>}
          </div>
        </Section>

        <Section title="Area">
          <div className="grid gap-2 sm:grid-cols-[3fr_2fr]">
            <AreaInputs value={f.area} onChange={(v) => set('area', v)} />
            <div className="grid grid-cols-2 gap-2">
              <Field label="Length (ft)">{(id) => <Input id={id} type="number" min={0} value={f.lengthFt} onChange={(e) => set('lengthFt', e.target.value)} placeholder="roads, canals" />}</Field>
              <Field label="Width (ft)">{(id) => <Input id={id} type="number" min={0} value={f.widthFt} onChange={(e) => set('widthFt', e.target.value)} />}</Field>
            </div>
          </div>
        </Section>

        <Section title="Classification and ownership">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Category">{(id) => <Select id={id} required value={f.category} onChange={(e) => { const c = m?.categories.find((x) => x.key === e.target.value); setF((x) => ({ ...x, category: e.target.value, subType: '', ownerRecord: x.ownerRecord || c?.owner || '' })); }}><option value="">Choose…</option>{m?.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Select>}</Field>
            <Field label="Sub-type">{(id) => <AutoInput id={id} placeholder={cat ? 'Type or pick…' : 'Choose category first'} options={opts(cat?.subTypes)} value={f.subType} onChange={(v) => set('subType', v)} />}</Field>
            <Field label="Owner as per Record">{(id) => <AutoInput id={id} dir="auto" options={['Sarkar Daulatmadar', 'Mehkma Nehar', 'Mehkma Shahrah', 'Mehkma Taleem', 'Mehkma Jangalat', 'Railway', 'WAPDA', 'Auqaf', 'Shamilat Deh']} value={f.ownerRecord} onChange={(v) => set('ownerRecord', v)} placeholder="As written in the jamabandi" />}</Field>
            <Field label="Custodian / User Department">{(id) => <AutoInput id={id} options={opts(m?.departments)} value={f.custodian} onChange={(v) => set('custodian', v)} placeholder="Type or pick…" />}</Field>
            <Field label="Land Classification">{(id) => <AutoInput id={id} options={opts(m?.landClass)} value={f.landClass} onChange={(v) => set('landClass', v)} placeholder="Type or pick…" />}</Field>
            <Field label="Present Use">{(id) => <AutoInput id={id} options={opts(m?.uses)} value={f.use} onChange={(v) => set('use', v)} placeholder="Type or pick…" />}</Field>
          </div>
          <Field label="Structures on Land">{(id) => <Input id={id} dir="auto" value={f.structures} onChange={(e) => set('structures', e.target.value)} placeholder="None / pucca building / kacha rooms …" />}</Field>
        </Section>

        {cat?.sections?.includes('acquisition') && (
          <Section title="Acquisition (Land Acquisition Act)">
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Acquiring Department">{(id) => <AutoInput id={id} options={opts(m?.departments)} value={f.acq.department} onChange={(v) => set('acq', { ...f.acq, department: v })} />}</Field>
              <Field label="Purpose">{(id) => <Input id={id} value={f.acq.purpose} onChange={(e) => set('acq', { ...f.acq, purpose: e.target.value })} />}</Field>
              <Field label="Award No.">{(id) => <Input id={id} value={f.acq.awardNo} onChange={(e) => set('acq', { ...f.acq, awardNo: e.target.value })} />}</Field>
              <Field label="Award Date">{(id) => <Input id={id} type="date" value={f.acq.awardDate} onChange={(e) => set('acq', { ...f.acq, awardDate: e.target.value })} />}</Field>
              <Field label="Compensation Paid?">{(id) => <Select id={id} value={f.acq.compensation} onChange={(e) => set('acq', { ...f.acq, compensation: e.target.value as never })}><option value="">—</option><option value="yes">Yes</option><option value="partly">Partly</option><option value="no">No</option></Select>}</Field>
              <Field label="Compensation (Rs)">{(id) => <Input id={id} type="number" min={0} value={f.acq.compensationAmount} onChange={(e) => set('acq', { ...f.acq, compensationAmount: e.target.value })} />}</Field>
              <Field label="Mutation No. (for Dept)">{(id) => <Input id={id} value={f.acq.mutationNo} onChange={(e) => set('acq', { ...f.acq, mutationNo: e.target.value })} placeholder="blank = not yet" />}</Field>
              <Field label="Mutation Date">{(id) => <Input id={id} type="date" value={f.acq.mutationDate} onChange={(e) => set('acq', { ...f.acq, mutationDate: e.target.value })} />}</Field>
            </div>
          </Section>
        )}

        {cat?.sections?.includes('allotment') && (
          <Section title="Allotment / lease" note="Rent and arrears are tracked in the Lease Money KPI">
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Scheme / Policy">{(id) => <AutoInput id={id} options={opts(cat?.subTypes)} value={f.allot.scheme} onChange={(v) => set('allot', { ...f.allot, scheme: v })} />}</Field>
              <Field label="Allottee / Lessee">{(id) => <Input id={id} dir="auto" value={f.allot.allottee} onChange={(e) => set('allot', { ...f.allot, allottee: e.target.value })} />}</Field>
              <Field label="Parentage">{(id) => <Input id={id} dir="auto" value={f.allot.parentage} onChange={(e) => set('allot', { ...f.allot, parentage: e.target.value })} placeholder="s/o, d/o, w/o" />}</Field>
              <Field label="Order No.">{(id) => <Input id={id} value={f.allot.orderNo} onChange={(e) => set('allot', { ...f.allot, orderNo: e.target.value })} />}</Field>
              <Field label="Order Date">{(id) => <Input id={id} type="date" value={f.allot.orderDate} onChange={(e) => set('allot', { ...f.allot, orderDate: e.target.value })} />}</Field>
              <Field label="Authority">{(id) => <Input id={id} value={f.allot.authority} onChange={(e) => set('allot', { ...f.allot, authority: e.target.value })} placeholder="e.g. Collector, Member Colonies" />}</Field>
              <Field label="Lease From">{(id) => <Input id={id} type="date" value={f.allot.leaseFrom} onChange={(e) => set('allot', { ...f.allot, leaseFrom: e.target.value })} />}</Field>
              <Field label="Lease To">{(id) => <Input id={id} type="date" value={f.allot.leaseTo} onChange={(e) => set('allot', { ...f.allot, leaseTo: e.target.value })} />}</Field>
              <Field label="Conditions Met?">{(id) => <Select id={id} value={f.allot.conditionsMet} onChange={(e) => set('allot', { ...f.allot, conditionsMet: e.target.value as never })}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option><option value="review">Under review</option></Select>}</Field>
              <Field label="Proprietary Rights">{(id) => <Select id={id} value={f.allot.proprietary} onChange={(e) => set('allot', { ...f.allot, proprietary: e.target.value as never })}><option value="">—</option><option value="granted">Granted</option><option value="pending">Pending</option><option value="na">Not applicable</option></Select>}</Field>
              <Field label="Mutation No.">{(id) => <Input id={id} value={f.allot.mutationNo} onChange={(e) => set('allot', { ...f.allot, mutationNo: e.target.value })} />}</Field>
            </div>
          </Section>
        )}

        <Section title="Possession">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Possession Status">{(id) => <Select id={id} required value={f.possession} onChange={(e) => set('possession', e.target.value)}><option value="">Choose…</option>{m?.possession.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
            <Field label="Last Site Visit">{(id) => <Input id={id} type="date" value={f.lastVisit} onChange={(e) => set('lastVisit', e.target.value)} />}</Field>
          </div>
          {encroached && (
            <div className="space-y-2 rounded-md bg-rose-50 p-2 dark:bg-rose-950/30">
              <div className="text-xs font-semibold text-rose-800 dark:text-rose-300">Encroachment</div>
              <AreaInputs value={f.enc.area} onChange={(v) => set('enc', { ...f.enc, area: v })} />
              <div className="space-y-1.5">
                <div className="text-[13px] font-semibold">Encroacher(s)</div>
                {f.enc.encroachers.map((x, i) => (
                  <div key={i} className="flex gap-1.5">
                    <Input dir="auto" value={x} placeholder="Name, s/o …" onChange={(e) => set('enc', { ...f.enc, encroachers: f.enc.encroachers.map((y, j) => (j === i ? e.target.value : y)) })} />
                    {f.enc.encroachers.length > 1 && <Button type="button" size="sm" variant="ghost" onClick={() => set('enc', { ...f.enc, encroachers: f.enc.encroachers.filter((_, j) => j !== i) })}><X className="size-4" /></Button>}
                  </div>
                ))}
                <button type="button" className="text-xs font-semibold text-brand-700 hover:underline" onClick={() => set('enc', { ...f.enc, encroachers: [...f.enc.encroachers, ''] })}>+ Add another</button>
              </div>
              <div className="grid gap-2 sm:grid-cols-4">
                <Field label="Nature">{(id) => <AutoInput id={id} options={opts(m?.encroachmentNature)} value={f.enc.nature} onChange={(v) => set('enc', { ...f.enc, nature: v })} />}</Field>
                <Field label="Since (Year)">{(id) => <Input id={id} type="number" min={1900} max={2100} value={f.enc.since} onChange={(e) => set('enc', { ...f.enc, since: e.target.value })} />}</Field>
                <Field label="Action Taken">{(id) => <Select id={id} value={f.enc.action} onChange={(e) => set('enc', { ...f.enc, action: e.target.value })}><option value="">—</option>{m?.encroachmentAction.map((a) => <option key={a}>{a}</option>)}</Select>}</Field>
                <Field label="Retrieved On">{(id) => <Input id={id} type="date" value={f.enc.retrievedOn} onChange={(e) => set('enc', { ...f.enc, retrievedOn: e.target.value })} />}</Field>
              </div>
              {f.enc.retrievedOn && <div><div className="mb-1 text-[13px] font-semibold">Area Retrieved</div><AreaInputs value={f.enc.retrievedArea} onChange={(v) => set('enc', { ...f.enc, retrievedArea: v })} /></div>}
            </div>
          )}
        </Section>

        <Section title="Litigation">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-brand-600" checked={f.underLitigation} onChange={(e) => set('underLitigation', e.target.checked)} />This land is under litigation</label>
          {f.underLitigation && (
            !f.unitId ? <p className="text-xs text-slate-500">Choose the mouza to link its cases.</p> :
            cases.isLoading ? <Loading /> : !cases.data?.length ? <p className="text-xs text-slate-500">No case of this mouza is in the Litigation register yet. Add it there, then link it here.</p> : (
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-md ring-1 ring-slate-200 p-2 dark:ring-slate-700">
                {cases.data.map((c) => (
                  <label key={c._id} className="flex items-center gap-2 text-xs"><input type="checkbox" className="size-4 accent-brand-600" checked={f.litigationIds.includes(c._id)} onChange={(e) => set('litigationIds', e.target.checked ? [...f.litigationIds, c._id] : f.litigationIds.filter((x) => x !== c._id))} />{c.label}</label>
                ))}
              </div>
            )
          )}
        </Section>

        <Section title="Record and demarcation">
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Record Status">{(id) => <Select id={id} required value={f.record.status} onChange={(e) => set('record', { ...f.record, status: e.target.value })}><option value="">Choose…</option>{m?.recordStatus.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
            <Field label="Mutation No(s).">{(id) => <Input id={id} value={f.record.mutationNos} onChange={(e) => set('record', { ...f.record, mutationNos: e.target.value })} />}</Field>
            <Field label="Computerised Record Matches?">{(id) => <Select id={id} value={f.record.computerised} onChange={(e) => set('record', { ...f.record, computerised: e.target.value as never })}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option><option value="unchecked">Not checked</option></Select>}</Field>
            <Field label="Demarcation Done?">{(id) => <Select id={id} value={f.record.demarcation} onChange={(e) => set('record', { ...f.record, demarcation: e.target.value as never })}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></Select>}</Field>
            {f.record.demarcation === 'yes' && <Field label="Demarcation Date">{(id) => <Input id={id} type="date" value={f.record.demarcationDate} onChange={(e) => set('record', { ...f.record, demarcationDate: e.target.value })} />}</Field>}
            {f.record.demarcation === 'yes' && <Field label="Report Reference">{(id) => <Input id={id} value={f.record.demarcationRef} onChange={(e) => set('record', { ...f.record, demarcationRef: e.target.value })} />}</Field>}
          </div>
          <Field label="Discrepancy Note">{(id) => <Input id={id} dir="auto" value={f.record.discrepancy} onChange={(e) => set('record', { ...f.record, discrepancy: e.target.value })} placeholder="e.g. area in record differs from site" />}</Field>
        </Section>

        <Field label="Note">{(id) => <Textarea id={id} rows={1} dir="auto" value={f.note} onChange={(e) => set('note', e.target.value)} />}</Field>
        {dup && (
          <Card className="space-y-2 border-l-4 border-amber-500 p-3 text-sm">
            <div>A holding of the same category with an overlapping khasra already exists: <Link to={`/state-land/${dup.id}`} className="font-semibold underline">{dup.caseId}</Link>. Is this a different holding?</div>
            <Button type="button" size="sm" variant="secondary" onClick={() => save(true)}>Yes, create a new holding</Button>
          </Card>
        )}
        <FormError error={error} />
      </form>
    </LSheet>
  );
}

/* ================================================================== *
 *  Holding page
 * ================================================================== */
export function StateLandHoldingPage() {
  const { id } = useParams();
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const caps = useCaps();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['sl', 'holding', id],
    queryFn: () => get<{ holding: Holding; cases: { _id: string; caseId: string; caseType: string; courtName: string; status: string; nextHearing?: string }[]; tehsil?: string; docs: Doc[]; categoryLabel: string; canEdit: boolean; canVerify: boolean; canApprove: boolean }>(`/state-land/${id}`),
  });
  const [sheet, setSheet] = useState<null | 'edit' | 'doc' | 'return'>(null);
  const [remarks, setRemarks] = useState('');
  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorState error={error} retry={refetch} />;
  const h = data.holding;
  const m = meta.data;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['sl'] }); refetch(); };
  const act = async (path: 'verify' | 'approve' | 'return', body: object = {}) => {
    try { await post(`/state-land/${h._id}/${path}`, body); toast(path === 'verify' ? 'Verified' : path === 'approve' ? 'Approved' : 'Returned for correction'); setSheet(null); setRemarks(''); refresh(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const remove = async () => { if (!confirm(`Remove holding ${h.holdingId}?`)) return; await del(`/state-land/${h._id}`); qc.invalidateQueries({ queryKey: ['sl'] }); navigate('/state-land'); };
  const removeDoc = async (d: Doc) => { if (!confirm('Remove this document?')) return; await del(`/state-land/${h._id}/docs/${d._id}`); refresh(); };
  const row = (k: string, v: ReactNode) => (v == null || v === '' || v === '—' ? null : <div className="grid grid-cols-[11rem_1fr] gap-2 border-b border-slate-100 py-1.5 text-sm last:border-0 dark:border-slate-800"><span className="text-slate-500">{k}</span><span dir="auto">{v}</span></div>);
  const withM = (h.land.parcels ?? []).filter((p) => p.murabba);
  const enc = h.encroachment;
  const encroached = h.possession === 'encroached' || h.possession === 'part_encroached';
  const leaseExpired = h.allotment?.leaseTo && new Date(h.allotment.leaseTo) < new Date();

  return (
    <>
      <PageHeader title={h.holdingId} subtitle={`${data.categoryLabel}${h.subType ? ` · ${h.subType}` : ''} · ${h.unitId.name.replace(' (test)', '')}${data.tehsil ? `, ${data.tehsil}` : ''}`} actions={
        <div className="flex flex-wrap gap-2 print:hidden">
          {data.canEdit && <Button size="sm" variant="secondary" onClick={() => setSheet('edit')}>Edit</Button>}
          {data.canEdit && <Button size="sm" variant="secondary" onClick={() => setSheet('doc')}><Upload className="size-4" />Attach</Button>}
          <Button size="sm" variant="ghost" onClick={() => window.print()}><FileText className="size-4" />Print</Button>
          {caps.isAdmin && <Button size="sm" variant="ghost" onClick={remove}><Trash2 className="size-4" /></Button>}
        </div>
      } />

      <Card className={clsx('mb-3 flex flex-wrap items-center gap-3 border-l-4 p-3 text-sm', h.status === 'approved' ? 'border-emerald-500' : h.status === 'returned' ? 'border-rose-500' : 'border-amber-500')}>
        <StatusBadge s={h.status} />
        <span className="text-slate-600 dark:text-slate-300">
          Entered by {h.createdBy?.name ?? '—'} on {fmt(h.createdAt)}
          {h.verifiedBy && ` · verified by ${h.verifiedBy.name} on ${fmt(h.verifiedAt)}`}
          {h.approvedBy && ` · approved by ${h.approvedBy.name} on ${fmt(h.approvedAt)}`}
        </span>
        {h.status === 'returned' && h.returnRemarks && <span className="w-full text-rose-700"><b>Remarks:</b> {h.returnRemarks}</span>}
        <div className="ml-auto flex gap-2 print:hidden">
          {data.canVerify && h.status === 'entered' && <Button size="sm" onClick={() => act('verify')}><ShieldCheck className="size-4" />Verify</Button>}
          {data.canApprove && h.status === 'verified' && <Button size="sm" onClick={() => act('approve')}><CheckCircle2 className="size-4" />Approve</Button>}
          {(data.canVerify || data.canApprove) && h.status !== 'returned' && h.status !== 'approved' && <Button size="sm" variant="secondary" onClick={() => setSheet('return')}><RotateCcw className="size-4" />Return</Button>}
          {data.canApprove && h.status === 'approved' && <Button size="sm" variant="ghost" onClick={() => setSheet('return')}><RotateCcw className="size-4" />Return</Button>}
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <SectionTitle>Location and Record</SectionTitle>
          {row('Mouza', `${h.unitId.name.replace(' (test)', '')}${data.tehsil ? `, Tehsil ${data.tehsil}` : ''}`)}
          {row('Hadbast No.', h.hadbast)}
          {row('Khewat / Khatauni', [h.khewat, h.khatauni].filter(Boolean).join(' / '))}
          {withM.length ? row('Murabba → Killa / Khasra', withM.map((p) => `${p.murabba}: ${p.khasras.join(', ') || '—'}`).join('  |  ')) : row('Khasra / Killa Nos.', h.land.khasraNos.join(', '))}
          {row('Jamabandi Year', h.jamabandiYear)}
          {row('Location', h.location)}
          {row('Boundaries', h.boundaries && Object.values(h.boundaries).some(Boolean) ? `N: ${h.boundaries.north || '—'} · S: ${h.boundaries.south || '—'} · E: ${h.boundaries.east || '—'} · W: ${h.boundaries.west || '—'}` : '')}
          {row('GPS', h.gps?.lat ? <a className="text-brand-700 underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${h.gps.lat},${h.gps.lng}`}>{h.gps.lat.toFixed(6)}, {h.gps.lng.toFixed(6)} (map)</a> : '')}
          {row('Area', `${kmf(h.area)} = ${acres(h.acres)} acres`)}
          {row('Length × Width', h.linear?.lengthFt ? `${h.linear.lengthFt} ft × ${h.linear.widthFt ?? '—'} ft` : '')}
        </Card>
        <Card className="p-4">
          <SectionTitle>Classification and Ownership</SectionTitle>
          {row('Category', data.categoryLabel)}
          {row('Sub-type', h.subType)}
          {row('Owner as per Record', h.ownerRecord)}
          {row('Custodian Department', h.custodian)}
          {row('Land Classification', h.landClass)}
          {row('Present Use', h.use)}
          {row('Structures', h.structures)}
          {row('Possession', <span className={clsx(encroached && 'font-semibold text-rose-700')}>{label(m?.possession, h.possession)}</span>)}
          {row('Record Status', <span className={clsx(h.record.status !== 'mutated' && 'text-amber-700')}>{label(m?.recordStatus, h.record.status)}</span>)}
          {row('Mutation No(s).', h.record.mutationNos)}
          {row('Demarcation', h.record.demarcation === 'yes' ? `Done${h.record.demarcationDate ? ` on ${fmt(h.record.demarcationDate)}` : ''}${h.record.demarcationRef ? ` (${h.record.demarcationRef})` : ''}` : h.record.demarcation === 'no' ? 'Not done' : '')}
          {row('Computerised Record', ({ yes: 'Matches', no: 'Does not match', unchecked: 'Not checked' } as Record<string, string>)[h.record.computerised ?? ''] ?? '')}
          {row('Discrepancy', h.record.discrepancy)}
          {row('Last Site Visit', h.lastVisit ? fmt(h.lastVisit) : '')}
        </Card>

        {h.acquisition && Object.values(h.acquisition).some(Boolean) && (
          <Card className="p-4">
            <SectionTitle>Acquisition</SectionTitle>
            {row('Department / Purpose', [h.acquisition.department, h.acquisition.purpose].filter(Boolean).join(' — '))}
            {row('Award', [h.acquisition.awardNo, h.acquisition.awardDate && fmt(h.acquisition.awardDate)].filter(Boolean).join(' dated '))}
            {row('Compensation', h.acquisition.compensation ? `${{ yes: 'Paid', no: 'Not paid', partly: 'Partly paid' }[h.acquisition.compensation]}${h.acquisition.compensationAmount ? ` · Rs ${h.acquisition.compensationAmount.toLocaleString()}` : ''}` : '')}
            {row('Mutation for Department', h.acquisition.mutationNo ? `${h.acquisition.mutationNo}${h.acquisition.mutationDate ? ` (${fmt(h.acquisition.mutationDate)})` : ''}` : <span className="text-amber-700">Not yet</span>)}
          </Card>
        )}
        {h.allotment && Object.values(h.allotment).some(Boolean) && (
          <Card className="p-4">
            <SectionTitle>Allotment / Lease</SectionTitle>
            {row('Scheme', h.allotment.scheme)}
            {row('Allottee / Lessee', [h.allotment.allottee, h.allotment.parentage].filter(Boolean).join(' '))}
            {row('Order', [h.allotment.orderNo, h.allotment.orderDate && fmt(h.allotment.orderDate), h.allotment.authority].filter(Boolean).join(' · '))}
            {row('Lease Period', h.allotment.leaseFrom || h.allotment.leaseTo ? <span className={clsx(leaseExpired && 'font-semibold text-rose-700')}>{fmt(h.allotment.leaseFrom)} to {fmt(h.allotment.leaseTo)}{leaseExpired && ' — expired'}</span> : '')}
            {row('Conditions Met', ({ yes: 'Yes', no: 'No', review: 'Under review' } as Record<string, string>)[h.allotment.conditionsMet ?? ''] ?? '')}
            {row('Proprietary Rights', ({ granted: 'Granted', pending: 'Pending', na: 'Not applicable' } as Record<string, string>)[h.allotment.proprietary ?? ''] ?? '')}
            {row('Mutation No.', h.allotment.mutationNo)}
          </Card>
        )}
        {encroached && enc && (
          <Card className="border-l-4 border-rose-500 p-4">
            <SectionTitle>Encroachment</SectionTitle>
            {row('Encroached Area', `${kmf(enc.area)} = ${acres(enc.acres)} acres`)}
            {row('Encroacher(s)', enc.encroachers.join('; '))}
            {row('Nature / Since', [enc.nature, enc.since].filter(Boolean).join(' · since '))}
            {row('Action Taken', enc.action)}
            {row('Retrieved', enc.retrievedOn ? `${fmt(enc.retrievedOn)} · ${kmf(enc.retrievedArea)}` : '')}
          </Card>
        )}
        {(h.underLitigation || data.cases.length > 0) && (
          <Card className="border-l-4 border-violet-500 p-4">
            <SectionTitle>Litigation</SectionTitle>
            {!data.cases.length && <p className="text-sm text-slate-500">Under litigation — no case linked from the Litigation register yet.</p>}
            {data.cases.map((c) => (
              <div key={c._id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-1.5 text-sm last:border-0 dark:border-slate-800">
                <Link to={`/litigation/${c._id}`} className="font-mono font-semibold text-violet-800 hover:underline">{c.caseId}</Link>
                <span>{c.caseType} · {c.courtName}</span>
                <Badge tone={c.status === 'decided' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}>{c.status === 'decided' ? 'Decided' : `Pending${c.nextHearing ? ` · next ${fmt(c.nextHearing)}` : ''}`}</Badge>
              </div>
            ))}
          </Card>
        )}
      </div>

      {h.note && <Card className="mt-3 p-4 text-sm"><b>Note:</b> <span dir="auto">{h.note}</span></Card>}

      <SectionTitle action={data.canEdit && <Button size="sm" variant="ghost" className="print:hidden" onClick={() => setSheet('doc')}><Plus className="size-4" />Attach</Button>}>Documents</SectionTitle>
      <Card className="p-3">
        {!data.docs.length ? <p className="text-sm text-slate-500">No documents yet — attach the fard, aks shajra, mutation, site photos…</p> : data.docs.map((d) => (
          <div key={d._id} className="flex items-center gap-2 border-b border-slate-100 py-1.5 text-sm last:border-0 dark:border-slate-800">
            <FileText className="size-4 shrink-0 text-rose-600" />
            <button className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => download(`/state-land/${h._id}/docs/${d._id}`, `${h.holdingId} ${d.title ?? d.category}.pdf`)}>
              <b>{m?.docCategories.find((c) => c.key === d.category)?.label ?? d.category}</b>{d.title && ` — ${d.title}`}
            </button>
            <span className="text-xs text-slate-500">{d.pages ?? 1} p · {Math.round(d.size / 1024)} KB · {fmt(d.docDate ?? d.createdAt)}</span>
            {data.canEdit && <button className="text-slate-400 hover:text-rose-600 print:hidden" onClick={() => removeDoc(d)} aria-label="Remove"><Trash2 className="size-4" /></button>}
          </div>
        ))}
      </Card>

      <SectionTitle>History</SectionTitle>
      <Card className="p-3 text-sm">
        {[...h.history].reverse().map((x, i) => (
          <div key={i} className="flex gap-2 border-b border-slate-100 py-1 last:border-0 dark:border-slate-800"><span className="w-36 shrink-0 text-xs text-slate-500">{new Date(x.at).toLocaleString('en-GB')}</span><span><b>{x.by?.name ?? '—'}</b> {x.action}{x.remarks && <span className="text-slate-500"> — {x.remarks}</span>}</span></div>
        ))}
      </Card>

      {sheet === 'edit' && <HoldingForm initial={h} onClose={() => { setSheet(null); refresh(); }} />}
      {sheet === 'doc' && <DocSheet uploadUrl={`/state-land/${h._id}/docs`} label={h.holdingId} categories={m?.docCategories ?? []} onDone={() => { setSheet(null); refresh(); }} />}
      {sheet === 'return' && (
        <LSheet open onClose={() => setSheet(null)} title={`Return ${h.holdingId} for Correction`} footer={<Button block disabled={remarks.trim().length < 3} onClick={() => act('return', { remarks })}><RotateCcw className="size-4" />Return to Patwari</Button>}>
          <Field label="Remarks (what to correct)">{(id) => <Textarea id={id} rows={3} dir="auto" value={remarks} onChange={(e) => setRemarks(e.target.value)} />}</Field>
        </LSheet>
      )}
    </>
  );
}
