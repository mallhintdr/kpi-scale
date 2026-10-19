/**
 * State Land Directory — every state-owned khasra (Murabba → Killa → Sub-killa) in each mouza.
 *   /state-land       directory (filters, khasra list, bulk verify / approve, Excel), summary, entry, settings
 *   /state-land/:id   one khasra: details, verification (Girdawar → Tehsildar), litigation, documents, history
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, Download, FileText, MapPin, Plus, RotateCcw, Search, Settings2, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import { useDeferredValue, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../components/AppShell';
import { UnitField } from '../components/rev';
import { Badge, Button, Card, Empty, ErrorState, Field, FormError, Input, Loading, SectionTitle, Segmented, Select, Textarea, useToast } from '../components/ui';
import { del, download, get, patch, post, put } from '../lib/api';
import { useCaps, type UnitRef } from '../lib/rev';
import { AutoInput, DocSheet, LSheet, fmt, iso } from './Litigation';

/* ---------- types ---------- */
interface Category { key: string; label: string; subTypes: string[]; owner?: string; sections?: ('acquisition' | 'allotment')[] }
interface Meta {
  categories: Category[]; departments: string[]; possession: [string, string][]; recordStatus: [string, string][]; landClass: string[]; uses: string[];
  encroachmentNature: string[]; encroachmentAction: string[]; docCategories: { key: string; label: string }[]; canEnter: boolean; canVerify: boolean; canApprove: boolean; isAdmin: boolean;
  owners: string[]; kashtTypes: string[]; possessedBy: [string, string][]; nature: string[];
}
type Area = { kanal?: number; marla?: number; feet?: number };
type Status = 'entered' | 'verified' | 'approved' | 'returned';
interface Khasra {
  _id: string; holdingId: string; khasraNo: string; murabba: string; killa: number; subKilla?: string; unitId: { _id: string; name: string }; khewat?: string; khatauni?: string; jamabandiYear?: string;
  area: Area; acres: number;
  category: string; subType?: string; ownerRecord?: string; ownerShare?: string; custodian?: string;
  kasht?: { type?: string; names: string[] }; site?: { possessedBy?: string; names: string[]; nature: string[] }; landClass?: string; use?: string; structures?: string;
  acquisition?: { department?: string; purpose?: string; awardNo?: string; awardDate?: string; compensation?: 'yes' | 'no' | 'partly' | null; compensationAmount?: number; mutationNo?: string; mutationDate?: string };
  allotment?: { scheme?: string; allottee?: string; parentage?: string; orderNo?: string; orderDate?: string; authority?: string; leaseFrom?: string; leaseTo?: string; conditionsMet?: 'yes' | 'no' | 'review' | null; proprietary?: 'granted' | 'pending' | 'na' | null; mutationNo?: string };
  possession: string; encroachment?: { area?: Area; acres?: number; encroachers: string[]; nature?: string; since?: number; action?: string; retrievedOn?: string; retrievedArea?: Area };
  underLitigation: boolean; litigationIds: (string | { _id: string })[];
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
const NOT_IN_LIST = 'Not in the list? Ask the administrator to add it, so every user uses the same name.';

/* ================================================================== *
 *  Directory
 * ================================================================== */
export function StateLandList() {
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
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
  const [marking, setMarking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [returning, setReturning] = useState(false);
  const params = new URLSearchParams({ page: String(page), ...(term ? { search: term } : {}), ...(area ? { unitId: area._id } : {}), ...(category ? { category } : {}), ...(possession ? { possession } : {}), ...(recordStatus ? { recordStatus } : {}), ...(status ? { status } : {}), ...extra });
  useEffect(() => { setPage(1); setPicked(new Set()); }, [term, area, category, possession, recordStatus, status, extra]);
  const list = useQuery({ queryKey: ['sl', 'list', params.toString()], queryFn: () => get<{ items: (Khasra & { categoryLabel: string; possessionLabel: string; recordLabel: string })[]; total: number; pageSize: number }>(`/state-land?${params}`) });
  const sum = useQuery({ queryKey: ['sl', 'summary', area?._id], queryFn: () => get<Summary>(`/state-land/summary${area ? `?unitId=${area._id}` : ''}`) });
  const t = sum.data?.totals;
  const size = list.data?.pageSize ?? 100;
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / size));
  const clear = () => { setCategory(''); setPossession(''); setRecordStatus(''); setStatus(''); setExtra({}); setSearch(''); };
  const pick = (f: () => void) => () => { clear(); f(); setView('directory'); };
  const checker = !!(meta.data?.canVerify || meta.data?.canApprove);
  const items = list.data?.items ?? [];
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const bulk = async (action: 'verify' | 'approve' | 'return', remarks?: string) => {
    try {
      const r = await post<{ done: number; skipped: { khasra: string; reason: string }[] }>('/state-land/bulk', { ids: [...picked], action, remarks });
      toast(`${r.done} khasra(s) ${action === 'verify' ? 'verified' : action === 'approve' ? 'approved' : 'returned'}${r.skipped.length ? ` · ${r.skipped.length} skipped (${r.skipped[0].khasra}: ${r.skipped[0].reason})` : ''}`, r.skipped.length && !r.done ? 'error' : 'ok');
      setPicked(new Set()); setReturning(false); qc.invalidateQueries({ queryKey: ['sl'] });
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <>
      <PageHeader title="State Land Directory" subtitle="Every state-owned khasra in your jurisdiction" actions={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => download(`/state-land/export/xlsx?${params}`, 'state-land-directory.xlsx')}><Download className="size-4" />Excel</Button>
          {meta.data?.isAdmin && <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}><Settings2 className="size-4" />Settings</Button>}
          {meta.data?.canEnter && <Button size="sm" variant="secondary" onClick={() => setMarking(true)}><CheckCircle2 className="size-4" />Mouza Listing</Button>}
          {meta.data?.canEnter && <Link to="/state-land/entry"><Button size="sm"><Plus className="size-4" />Enter State Land</Button></Link>}
        </div>
      } />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Segmented value={view} onChange={setView} options={[{ value: 'directory', label: 'Directory' }, { value: 'summary', label: 'Summary' }]} />
        <div className="w-72 max-w-full"><UnitField value={area} onChange={setArea} placeholder="Whole jurisdiction" /></div>
        {area && <Button size="sm" variant="ghost" onClick={() => setArea(null)}><X className="size-4" />Clear area</Button>}
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {[
          { l: 'Khasras', v: t?.khasras?.toLocaleString(), on: pick(() => {}) },
          { l: 'Total Acres', v: acres(t?.acres) },
          { l: 'Encroached Acres', v: acres(t?.encroachedAcres), tone: t?.encroachedAcres ? 'text-rose-700' : undefined, on: pick(() => setPossession('any_encroached')) },
          { l: 'Under Litigation', v: t?.litigation, tone: 'text-violet-700', on: pick(() => setExtra({ litigation: 'yes' })) },
          { l: 'Not Mutated', v: t?.notMutated, tone: t?.notMutated ? 'text-amber-700' : undefined, on: pick(() => setRecordStatus('not_mutated')) },
          { l: 'Leases Expired', v: t?.leasesExpired, tone: t?.leasesExpired ? 'text-rose-700' : undefined, on: pick(() => setExtra({ leases: 'expired' })) },
          { l: 'Approved', v: t ? `${t.approved} / ${t.khasras}` : undefined, tone: 'text-emerald-700', on: pick(() => setStatus('approved')) },
        ].map((c) => (
          <Card key={c.l} className={clsx('p-3', c.on && 'cursor-pointer hover:ring-brand-200')} onClick={c.on}>
            <div className={clsx('text-xl font-bold tabular-nums', c.tone)}>{c.v ?? '—'}</div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{c.l}</div>
          </Card>
        ))}
      </div>

      {view === 'summary' ? <SummaryView data={sum.data} loading={sum.isLoading} canMark={!!meta.data?.canEnter} canConfirm={!!meta.data?.canVerify} onPickCategory={(k) => { clear(); setCategory(k); setView('directory'); }} /> : <>
        <Card className="mb-3 grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-5 print:hidden">
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><Input className="pl-9" placeholder="Khasra (45/12), murabba, khewat, name…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <Select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Any category</option>{meta.data?.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Select>
          <Select value={possession} onChange={(e) => setPossession(e.target.value)}><option value="">Any possession</option><option value="any_encroached">Encroached (fully or partly)</option>{meta.data?.possession.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          <Select value={recordStatus} onChange={(e) => setRecordStatus(e.target.value)}><option value="">Any record status</option>{meta.data?.recordStatus.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          <div className="flex gap-2">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any verification</option>{(Object.keys(STATUS) as Status[]).map((k) => <option key={k} value={k}>{STATUS[k][0]}</option>)}</Select>
            {(category || possession || recordStatus || status || term || extra.litigation || extra.leases) && <Button variant="ghost" onClick={clear}><X className="size-4" /></Button>}
          </div>
        </Card>
        {(extra.litigation || extra.leases) && <div className="mb-2 text-xs text-slate-500">Showing: {extra.litigation ? 'under litigation' : extra.leases === 'expired' ? 'leases expired' : 'leases expiring in 60 days'}</div>}
        {checker && picked.size > 0 && (
          <Card className="mb-2 flex flex-wrap items-center gap-2 border-l-4 border-brand-600 p-2.5 text-sm print:hidden">
            <b>{picked.size} khasra(s) selected</b>
            {meta.data?.canVerify && <Button size="sm" onClick={() => bulk('verify')}><ShieldCheck className="size-4" />Verify</Button>}
            {meta.data?.canApprove && <Button size="sm" onClick={() => bulk('approve')}><CheckCircle2 className="size-4" />Approve</Button>}
            <Button size="sm" variant="secondary" onClick={() => setReturning(true)}><RotateCcw className="size-4" />Return</Button>
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
          </Card>
        )}
        {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} retry={list.refetch} /> : !items.length ? (
          <Card><Empty icon={MapPin} title="No state land" body={meta.data?.canEnter ? 'Add khasras with Enter State Land.' : 'No state land recorded here yet.'} /></Card>
        ) : (
          <>
            <Card className="overflow-x-auto">
              <table className="w-full min-w-[960px] border-separate border-spacing-0 text-[13px]">
                <thead className="bg-brand-700 text-center text-[12.5px] text-white">
                  <tr>
                    {checker && <th className={clsx(th, 'w-8 print:hidden')}><input type="checkbox" className="size-4 accent-white" checked={items.every((h) => picked.has(h._id))} onChange={(e) => setPicked(e.target.checked ? new Set(items.map((h) => h._id)) : new Set())} aria-label="Select all" /></th>}
                    {['#', 'Mouza', 'Khasra No.', 'Khewat / Khatauni', 'Category', 'Area', 'Acres', 'Possession', 'Record', 'Status'].map((h) => <th key={h} className={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {items.map((h, i) => (
                    <tr key={h._id} className={clsx('hover:bg-slate-50 dark:hover:bg-slate-800/60', picked.has(h._id) && 'bg-brand-50 dark:bg-brand-900/30')}>
                      {checker && <td className={clsx(td, 'text-center print:hidden')}><input type="checkbox" className="size-4 accent-brand-600" checked={picked.has(h._id)} onChange={() => toggle(h._id)} /></td>}
                      <td className={clsx(td, 'text-center text-xs text-slate-500')}>{(page - 1) * size + i + 1}</td>
                      <td className={td}>{h.unitId?.name.replace(' (test)', '')}</td>
                      <td className={clsx(td, 'whitespace-nowrap font-mono text-[12.5px] font-semibold')}><Link to={`/state-land/${h._id}`} className="hover:underline">{h.khasraNo}</Link></td>
                      <td className={clsx(td, 'text-xs')}>{[h.khewat, h.khatauni].filter(Boolean).join(' / ') || '—'}</td>
                      <td className={td}>{h.categoryLabel}{h.subType && <div className="text-[11px] text-slate-500">{h.subType}{h.custodian && ` · ${h.custodian}`}</div>}</td>
                      <td className={clsx(td, 'whitespace-nowrap text-xs')}>{kmf(h.area)}</td>
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
              <span>{list.data!.total.toLocaleString()} khasra(s)</span>
              {pages > 1 && <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><span className="self-center">Page {page} of {pages}</span><Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div>}
            </div>
          </>
        )}
      </>}
      {marking && <MouzaListingSheet onClose={() => setMarking(false)} />}
      {settingsOpen && meta.data && <SettingsSheet meta={meta.data} onClose={() => setSettingsOpen(false)} />}
      {returning && <ReturnSheet title={`Return ${picked.size} Khasra(s) for Correction`} onClose={() => setReturning(false)} onReturn={(r) => bulk('return', r)} />}
    </>
  );
}

function ReturnSheet({ title, onClose, onReturn }: { title: string; onClose: () => void; onReturn: (remarks: string) => void }) {
  const [remarks, setRemarks] = useState('');
  return (
    <LSheet open onClose={onClose} title={title} footer={<Button block disabled={remarks.trim().length < 3} onClick={() => onReturn(remarks)}><RotateCcw className="size-4" />Return to Patwari</Button>}>
      <Field label="Remarks (what to correct)">{(id) => <Textarea id={id} rows={3} dir="auto" value={remarks} onChange={(e) => setRemarks(e.target.value)} />}</Field>
    </LSheet>
  );
}

/* ---------- summary: category-wise, mouza-wise, listing completion ---------- */
type Sums = { khasras: number; acres: number; encroachedAcres: number; encroached: number; litigation: number; notMutated: number; leasesExpired: number; approved: number; verified: number; returned: number };
interface Summary {
  totals: Sums; leasesExpiring: number;
  byCategory: (Sums & { _id: string; label: string })[];
  byMouza: (Sums & { _id: string; name: string; tehsil?: string; murabbas: number; complete: boolean; confirmed: boolean })[];
  mouzas: { total: number; complete: number; confirmed: number };
}
function SummaryView({ data, loading, canMark, canConfirm, onPickCategory }: { data?: Summary; loading: boolean; canMark: boolean; canConfirm: boolean; onPickCategory: (k: string) => void }) {
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
            <thead className="bg-brand-700 text-center text-[12.5px] text-white"><tr>{['Category', 'Khasras', 'Acres', 'Encroached Acres', 'Under Litigation', 'Not Mutated', 'Approved'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody>
              {data.byCategory.map((c) => (
                <tr key={c._id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60" onClick={() => onPickCategory(c._id)}>
                  <td className={clsx(td, 'font-medium text-brand-800 hover:underline')}>{c.label}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{c.khasras}</td>
                  <td className={clsx(td, 'text-right tabular-nums')}>{acres(c.acres)}</td>
                  <td className={clsx(td, 'text-right tabular-nums', c.encroachedAcres > 0 && 'text-rose-700')}>{acres(c.encroachedAcres)}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{c.litigation}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{c.notMutated}</td>
                  <td className={clsx(td, 'border-r-0 text-center tabular-nums')}>{c.approved} / {c.khasras}</td>
                </tr>
              ))}
              {!data.byCategory.length && <tr><td colSpan={7} className={clsx(td, 'text-center text-slate-500')}>No state land entered yet</td></tr>}
            </tbody>
            {data.byCategory.length > 0 && (
              <tfoot className="bg-slate-50 font-semibold dark:bg-slate-800">
                <tr><td className={td}>Total</td><td className={clsx(td, 'text-center')}>{data.totals.khasras}</td><td className={clsx(td, 'text-right')}>{acres(data.totals.acres)}</td><td className={clsx(td, 'text-right')}>{acres(data.totals.encroachedAcres)}</td><td className={clsx(td, 'text-center')}>{data.totals.litigation}</td><td className={clsx(td, 'text-center')}>{data.totals.notMutated}</td><td className={clsx(td, 'border-r-0 text-center')}>{data.totals.approved} / {data.totals.khasras}</td></tr>
              </tfoot>
            )}
          </table>
        </Card>
      </div>
      <div>
        <SectionTitle>Mouza Summary</SectionTitle>
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-separate border-spacing-0 text-[13px]">
            <thead className="bg-brand-700 text-center text-[12.5px] text-white"><tr>{['#', 'Tehsil', 'Mouza', 'Murabbas', 'Khasras', 'Acres', 'Encroached Acres', 'Litigation', 'Not Mutated', 'Approved', 'Listing'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody>
              {data.byMouza.map((m, i) => (
                <tr key={m._id}>
                  <td className={clsx(td, 'text-center text-xs text-slate-500')}>{i + 1}</td>
                  <td className={td}>{m.tehsil}</td>
                  <td className={td}>{m.name.replace(' (test)', '')}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{m.murabbas}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{m.khasras}</td>
                  <td className={clsx(td, 'text-right tabular-nums')}>{acres(m.acres)}</td>
                  <td className={clsx(td, 'text-right tabular-nums', m.encroachedAcres > 0 && 'text-rose-700')}>{acres(m.encroachedAcres)}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{m.litigation}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{m.notMutated}</td>
                  <td className={clsx(td, 'text-center tabular-nums')}>{m.approved} / {m.khasras}</td>
                  <td className={clsx(td, 'whitespace-nowrap border-r-0 text-center text-xs')}>
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
      <p className="text-sm text-slate-600 dark:text-slate-300">When every state land khasra of a mouza is entered, mark its listing complete; the Girdawar then confirms it. Mark a mouza with no state land complete too.</p>
      <Field label="Mouza">{(id) => <AutoInput id={id} strict placeholder="Type mouza name…" onQuery={setMq} value={unitId} options={(mouzas.data ?? []).map((x) => ({ value: x._id, label: x.name, hint: x.tehsil }))} onChange={setUnitId} />}</Field>
      {unitId && (
        <Card className="space-y-2 p-3 text-sm">
          <div>Status: {m?.confirmed ? <b className="text-emerald-700">Confirmed by {m.confirmedBy?.name}</b> : m?.complete ? <b className="text-sky-700">Marked complete by {m.completedBy?.name} on <span className="font-semibold">{fmt(m.completedAt)}</span></b> : <b className="text-slate-500">In progress</b>}</div>
          {m?.complete ? <Button variant="secondary" onClick={() => act('reopen')}><RotateCcw className="size-4" />Reopen Listing</Button> : <Button onClick={() => act('complete')}><CheckCircle2 className="size-4" />Mark Listing Complete</Button>}
        </Card>
      )}
    </LSheet>
  );
}

/* ---------- Settings (admin): categories, sub-types, departments ---------- */
function SettingsSheet({ meta, onClose }: { meta: Meta; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [cats, setCats] = useState(() => meta.categories.map((c) => ({ ...c, text: c.subTypes.join('\n') })));
  const [depts, setDepts] = useState(meta.departments.join('\n'));
  const [error, setError] = useState<unknown>(null);
  const [newCat, setNewCat] = useState('');
  const save = async () => {
    setError(null);
    try {
      await put('/state-land/settings', { categories: cats.map(({ text, ...c }) => ({ ...c, subTypes: text.split('\n').map((x) => x.trim()).filter(Boolean) })), departments: depts.split('\n').map((x) => x.trim()).filter(Boolean) });
      qc.invalidateQueries({ queryKey: ['sl'] }); toast('State land lists saved'); onClose();
    } catch (e) { setError(e); }
  };
  const addCat = () => {
    const lbl = newCat.trim();
    if (lbl.length < 2) return;
    const key = lbl.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `cat_${cats.length}`;
    setCats([...cats, { key: cats.some((c) => c.key === key) ? `${key}_${cats.length}` : key, label: lbl, subTypes: [], text: '', sections: [] }]);
    setNewCat('');
  };
  return (
    <LSheet open onClose={onClose} title="State Land Settings" footer={<Button block onClick={save}>Save Lists</Button>}>
      <p className="text-sm text-slate-600 dark:text-slate-300">Users pick categories, sub-types and departments from these lists only, so every entry uses the same names. Add new types here when asked.</p>
      {cats.map((c, i) => (
        <div key={c.key} className="rounded-lg border border-slate-300 p-2.5 dark:border-slate-600">
          <div className="grid gap-2 sm:grid-cols-[1fr_12rem]">
            <Field label="Category">{(id) => <Input id={id} value={c.label} onChange={(e) => setCats(cats.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />}</Field>
            <Field label="Extra Section">{(id) => <Select id={id} value={c.sections?.[0] ?? ''} onChange={(e) => setCats(cats.map((x, j) => (j === i ? { ...x, sections: e.target.value ? [e.target.value as 'acquisition'] : [] } : x)))}><option value="">None</option><option value="allotment">Allotment / lease</option><option value="acquisition">Acquisition</option></Select>}</Field>
          </div>
          <Field label="Sub-types (one per line)">{(id) => <Textarea id={id} rows={3} value={c.text} onChange={(e) => setCats(cats.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />}</Field>
        </div>
      ))}
      <div className="flex gap-2"><Input placeholder="New category name" value={newCat} onChange={(e) => setNewCat(e.target.value)} /><Button type="button" variant="secondary" onClick={addCat}><Plus className="size-4" />Add</Button></div>
      <Field label="Departments (one per line)">{(id) => <Textarea id={id} rows={8} value={depts} onChange={(e) => setDepts(e.target.value)} />}</Field>
      <FormError error={error} />
    </LSheet>
  );
}

/* ================================================================== *
 *  Shared details form (classification, possession, litigation, record)
 * ================================================================== */
type AreaS = { kanal: string; marla: string; feet: string };
const n = (s: string) => (s.trim() ? Number(s) : undefined);
const s0 = (v?: number | null) => (v == null ? '' : String(v));
const areaIn = (a?: Area): AreaS => ({ kanal: s0(a?.kanal), marla: s0(a?.marla), feet: s0(a?.feet) });
const areaOut = (a: AreaS): Area => ({ kanal: n(a.kanal), marla: n(a.marla), feet: n(a.feet) });

function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <div className="rounded-lg border border-slate-300 p-2.5 dark:border-slate-600">
      <div className="mb-2 flex items-baseline justify-between gap-2"><span className="text-xs font-bold uppercase tracking-wide text-brand-700">{title}</span>{note && <span className="text-[11px] text-slate-500">{note}</span>}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
/** Numbers only (one decimal point allowed). */
const numeric = (v: string) => v.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
/** Kanal / Marla / Feet boxes: labelled in forms, compact (numbers only) in the killa table. */
function AreaBoxes({ value, onChange, labels }: { value: AreaS; onChange: (v: AreaS) => void; labels?: boolean }) {
  if (labels) return (
    <div className="grid grid-cols-3 gap-1">
      {(['kanal', 'marla', 'feet'] as const).map((k) => <Field key={k} label={k === 'feet' ? 'Feet' : k[0].toUpperCase() + k.slice(1)}>{(id) => <Input id={id} inputMode="decimal" value={value[k]} onChange={(e) => onChange({ ...value, [k]: numeric(e.target.value) })} />}</Field>)}
    </div>
  );
  return (
    <div className="flex gap-1">
      {(['kanal', 'marla', 'feet'] as const).map((k) => (
        <input key={k} inputMode="decimal" aria-label={k} title={k === 'kanal' ? 'Kanal' : k === 'marla' ? 'Marla' : 'Feet'} placeholder={k === 'kanal' ? 'K' : k === 'marla' ? 'M' : 'Ft'} value={value[k]}
          onChange={(e) => onChange({ ...value, [k]: numeric(e.target.value) })}
          className={clsx('h-8 rounded-md bg-white px-1 text-center text-sm tabular-nums ring-1 ring-slate-400 outline-none focus:ring-2 focus:ring-brand-500 dark:bg-slate-900 dark:ring-slate-500', k === 'feet' ? 'w-16' : 'w-12')} />
      ))}
    </div>
  );
}

const OTHER = '__other__';
/** A list with an "Other" choice that opens a box to type the entry as written. */
function ListOrOther({ id, options, value, onChange, placeholder }: { id?: string; options: (string | [string, string])[]; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const opts = options.map((o) => (typeof o === 'string' ? ([o, o] as [string, string]) : o));
  const [other, setOther] = useState(() => !!value && !opts.some(([k]) => k === value));
  return (
    <div className="space-y-1">
      <Select id={id} value={other ? OTHER : value} onChange={(e) => { if (e.target.value === OTHER) { setOther(true); onChange(''); } else { setOther(false); onChange(e.target.value); } }}>
        <option value="">Choose…</option>
        {opts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        <option value={OTHER}>Other — type it…</option>
      </Select>
      {other && <Input dir="auto" autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? 'Type as written'} />}
    </div>
  );
}
/** Tick one or more; "Other" adds a typed entry. */
function MultiPick({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const [txt, setTxt] = useState('');
  const add = () => { const t = txt.trim(); if (t && !value.includes(t)) onChange([...value, t]); setTxt(''); };
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {[...options, ...value.filter((v) => !options.includes(v))].map((o) => (
        <button key={o} type="button" onClick={() => toggle(o)} className={clsx('rounded-full px-2.5 py-1 text-xs ring-1 transition', value.includes(o) ? 'bg-brand-700 text-white ring-brand-700' : 'bg-white ring-slate-400 hover:bg-brand-50 dark:bg-slate-900')}>{o}</button>
      ))}
      <span className="flex items-center gap-1">
        <input value={txt} dir="auto" onChange={(e) => setTxt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} placeholder="Other…" className="h-7 w-28 rounded-full bg-white px-2.5 text-xs ring-1 ring-slate-400 outline-none focus:ring-brand-500 dark:bg-slate-900" />
        {txt.trim() && <button type="button" className="text-xs font-semibold text-brand-700 hover:underline" onClick={add}>Add</button>}
      </span>
    </div>
  );
}
/** Several names, suggested from those already entered in the mouza; any new name can be typed. */
function NameList({ value, onChange, unitId, placeholder }: { value: string[]; onChange: (v: string[]) => void; unitId: string; placeholder?: string }) {
  const names = useQuery({ queryKey: ['sl', 'names', unitId], queryFn: () => get<string[]>(`/state-land/names?unitId=${unitId}`), enabled: !!unitId, staleTime: 60_000 });
  const rows = value.length ? value : [''];
  return (
    <div className="space-y-1.5">
      {rows.map((v, i) => (
        <div key={i} className="flex gap-1.5">
          <div className="flex-1"><AutoInput dir="auto" options={names.data ?? []} value={v} onChange={(x) => onChange(rows.map((y, j) => (j === i ? x : y)))} placeholder={i ? 'Another name' : placeholder ?? 'Name, s/o …'} /></div>
          {rows.length > 1 && <Button type="button" size="sm" variant="ghost" aria-label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}><X className="size-4" /></Button>}
        </div>
      ))}
      <button type="button" className="text-xs font-semibold text-brand-700 hover:underline" onClick={() => onChange([...rows, ''])}>+ Add another name</button>
    </div>
  );
}

function detailsInit(h?: Khasra) {
  return {
    jamabandiYear: h?.jamabandiYear ?? '',
    category: h?.category ?? '', subType: h?.subType ?? '', ownerRecord: h?.ownerRecord ?? '', ownerShare: h?.ownerShare ?? '', custodian: h?.custodian ?? '',
    kasht: { type: h?.kasht?.type ?? '', names: h?.kasht?.names?.length ? h.kasht.names : [''] },
    site: { possessedBy: h?.site?.possessedBy ?? '', names: h?.site?.names?.length ? h.site.names : [''], nature: h?.site?.nature ?? [] }, landClass: h?.landClass ?? '', use: h?.use ?? '', structures: h?.structures ?? '',
    acq: { department: h?.acquisition?.department ?? '', purpose: h?.acquisition?.purpose ?? '', awardNo: h?.acquisition?.awardNo ?? '', awardDate: iso(h?.acquisition?.awardDate), compensation: h?.acquisition?.compensation ?? '', compensationAmount: s0(h?.acquisition?.compensationAmount), mutationNo: h?.acquisition?.mutationNo ?? '', mutationDate: iso(h?.acquisition?.mutationDate) },
    allot: { scheme: h?.allotment?.scheme ?? '', allottee: h?.allotment?.allottee ?? '', parentage: h?.allotment?.parentage ?? '', orderNo: h?.allotment?.orderNo ?? '', orderDate: iso(h?.allotment?.orderDate), authority: h?.allotment?.authority ?? '', leaseFrom: iso(h?.allotment?.leaseFrom), leaseTo: iso(h?.allotment?.leaseTo), conditionsMet: h?.allotment?.conditionsMet ?? '', proprietary: h?.allotment?.proprietary ?? '', mutationNo: h?.allotment?.mutationNo ?? '' },
    enc: { encroachers: h?.encroachment?.encroachers?.length ? h.encroachment.encroachers : [''], nature: h?.encroachment?.nature ?? '', since: s0(h?.encroachment?.since), action: h?.encroachment?.action ?? '', retrievedOn: iso(h?.encroachment?.retrievedOn), retrievedArea: areaIn(h?.encroachment?.retrievedArea) },
    underLitigation: h?.underLitigation ?? false, litigationIds: (h?.litigationIds ?? []).map((x) => (typeof x === 'string' ? x : x._id)),
    record: { status: h?.record.status ?? '', mutationNos: h?.record.mutationNos ?? '', demarcation: h?.record.demarcation ?? '', demarcationDate: iso(h?.record.demarcationDate), demarcationRef: h?.record.demarcationRef ?? '', computerised: h?.record.computerised ?? '', discrepancy: h?.record.discrepancy ?? '' },
    lastVisit: iso(h?.lastVisit), note: h?.note ?? '',
  };
}
type DetailsS = ReturnType<typeof detailsInit>;
const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
function detailsOut(f: DetailsS, cat?: Category) {
  const encroached = f.site.possessedBy === 'unauthorised';
  return {
    jamabandiYear: f.jamabandiYear || undefined,
    category: f.category, subType: f.subType || undefined, ownerRecord: f.ownerRecord, ownerShare: f.ownerShare || undefined, custodian: f.custodian || undefined,
    kasht: { type: f.kasht.type, names: clean(f.kasht.names) },
    site: { possessedBy: f.site.possessedBy, names: f.site.possessedBy === 'department' || f.site.possessedBy === 'vacant' ? [] : clean(f.site.names), nature: f.site.nature }, landClass: f.landClass || undefined, use: f.use || undefined, structures: f.structures || undefined,
    ...(cat?.sections?.includes('acquisition') ? { acquisition: { ...f.acq, awardDate: f.acq.awardDate || null, mutationDate: f.acq.mutationDate || null, compensation: f.acq.compensation || null, compensationAmount: n(f.acq.compensationAmount) ?? null } } : {}),
    ...(cat?.sections?.includes('allotment') ? { allotment: { ...f.allot, orderDate: f.allot.orderDate || null, leaseFrom: f.allot.leaseFrom || null, leaseTo: f.allot.leaseTo || null, conditionsMet: f.allot.conditionsMet || null, proprietary: f.allot.proprietary || null } } : {}),
    ...(encroached ? { encroachment: { encroachers: clean(f.site.names), nature: f.enc.nature || undefined, since: n(f.enc.since) ?? null, action: f.enc.action || undefined, retrievedOn: f.enc.retrievedOn || null, retrievedArea: areaOut(f.enc.retrievedArea) } } : {}),
    underLitigation: f.underLitigation, litigationIds: f.underLitigation ? f.litigationIds : [],
    record: { ...f.record, demarcation: f.record.demarcation || null, demarcationDate: f.record.demarcationDate || null, computerised: f.record.computerised || null },
    lastVisit: f.lastVisit || null, note: f.note || undefined,
  };
}
const checkDetails = (f: DetailsS) =>
  !f.ownerRecord.trim() ? 'Part A: enter khana malkiyat (ownership as per record)'
  : !f.kasht.type.trim() ? 'Part A: enter khana kasht (possession as per record)'
  : !f.site.possessedBy.trim() ? 'Part B: enter who is in possession at site'
  : !f.site.nature.length ? 'Part B: tick the nature of the land at site'
  : !f.category ? 'Choose the category'
  : !f.record.status ? 'Choose the record status' : null;

function DetailsFields({ f, setF, m, unitId, partNote }: { f: DetailsS; setF: (f: DetailsS) => void; m?: Meta; unitId: string; partNote?: string }) {
  const set = <K extends keyof DetailsS>(k: K, v: DetailsS[K]) => setF({ ...f, [k]: v });
  const cat = m?.categories.find((c) => c.key === f.category);
  const encroached = f.site.possessedBy === 'unauthorised';
  const cases = useQuery({ queryKey: ['sl', 'cases', unitId], queryFn: () => get<{ _id: string; caseId: string; label: string }[]>(`/state-land/mouza-cases?unitId=${unitId}`), enabled: !!unitId && f.underLitigation });
  return (
    <>
      <Section title="Part A · As per record (jamabandi)">
        <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr]">
          <Field label="Khana Malkiyat (Ownership)">{(id) => <ListOrOther id={id} options={m?.owners ?? []} value={f.ownerRecord} onChange={(v) => set('ownerRecord', v)} placeholder="Owner as written in the record" />}</Field>
          <Field label="Share">{(id) => <Input id={id} value={f.ownerShare} onChange={(e) => set('ownerShare', e.target.value)} placeholder="whole / 1/2 …" />}</Field>
          <Field label="Jamabandi Year">{(id) => <Input id={id} value={f.jamabandiYear} onChange={(e) => set('jamabandiYear', e.target.value)} placeholder="e.g. 2022-23" />}</Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Khana Kasht (Possession as per Record)">{(id) => <ListOrOther id={id} options={m?.kashtTypes ?? []} value={f.kasht.type} onChange={(v) => set('kasht', { ...f.kasht, type: v })} />}</Field>
          <Field label="Name(s) in Khana Kasht">{() => <NameList unitId={unitId} value={f.kasht.names} onChange={(v) => set('kasht', { ...f.kasht, names: v })} />}</Field>
        </div>
      </Section>

      <Section title={`Part B · Physical possession at site${partNote ? '' : ''}`} note={partNote}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="In Possession Of">{(id) => <ListOrOther id={id} options={m?.possessedBy ?? []} value={f.site.possessedBy} onChange={(v) => set('site', { ...f.site, possessedBy: v })} />}</Field>
          <Field label="Last Site Visit">{(id) => <Input id={id} type="date" value={f.lastVisit} onChange={(e) => set('lastVisit', e.target.value)} />}</Field>
        </div>
        {f.site.possessedBy && !['department', 'vacant', 'recorded'].includes(f.site.possessedBy) && (
          <Field label={encroached ? 'Name(s) of Person(s) in Unauthorised Possession' : 'Name(s) of Person(s) in Possession'}>{() => <NameList unitId={unitId} value={f.site.names} onChange={(v) => set('site', { ...f.site, names: v })} />}</Field>
        )}
        <div>
          <div className="mb-1 text-[13px] font-semibold">Nature of Land at Site <span className="font-normal text-slate-500">(tick all that apply)</span></div>
          <MultiPick options={m?.nature ?? []} value={f.site.nature} onChange={(v) => set('site', { ...f.site, nature: v })} />
        </div>
        {encroached && (
          <div className="space-y-2 rounded-md bg-rose-50 p-2 dark:bg-rose-950/30">
            <div className="text-xs font-semibold text-rose-800 dark:text-rose-300">Possession differs from record — encroachment</div>
            <div className="grid gap-2 sm:grid-cols-4">
              <Field label="Use by Encroacher">{(id) => <AutoInput id={id} options={m?.encroachmentNature ?? []} value={f.enc.nature} onChange={(v) => set('enc', { ...f.enc, nature: v })} />}</Field>
              <Field label="Since (Year)">{(id) => <Input id={id} inputMode="numeric" value={f.enc.since} onChange={(e) => set('enc', { ...f.enc, since: e.target.value.replace(/\D/g, '').slice(0, 4) })} />}</Field>
              <Field label="Action Taken">{(id) => <Select id={id} value={f.enc.action} onChange={(e) => set('enc', { ...f.enc, action: e.target.value })}><option value="">—</option>{m?.encroachmentAction.map((a) => <option key={a}>{a}</option>)}</Select>}</Field>
              <Field label="Retrieved On">{(id) => <Input id={id} type="date" value={f.enc.retrievedOn} onChange={(e) => set('enc', { ...f.enc, retrievedOn: e.target.value })} />}</Field>
            </div>
            {f.enc.retrievedOn && <div><div className="mb-1 text-[13px] font-semibold">Area Retrieved</div><AreaBoxes labels value={f.enc.retrievedArea} onChange={(v) => set('enc', { ...f.enc, retrievedArea: v })} /></div>}
          </div>
        )}
      </Section>

      <Section title="Classification" note={NOT_IN_LIST}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Category">{(id) => <Select id={id} required value={f.category} onChange={(e) => { const c = m?.categories.find((x) => x.key === e.target.value); setF({ ...f, category: e.target.value, subType: '', ownerRecord: f.ownerRecord || c?.owner || '' }); }}><option value="">Choose…</option>{m?.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Select>}</Field>
          <Field label="Sub-type">{(id) => <AutoInput id={id} strict placeholder={cat ? 'Type to search…' : 'Choose category first'} options={cat?.subTypes ?? []} value={f.subType} onChange={(v) => set('subType', v)} />}</Field>
          <Field label="Custodian / User Department">{(id) => <AutoInput id={id} strict options={m?.departments ?? []} value={f.custodian} onChange={(v) => set('custodian', v)} placeholder="Type to search…" />}</Field>
          <Field label="Land Classification">{(id) => <AutoInput id={id} options={m?.landClass ?? []} value={f.landClass} onChange={(v) => set('landClass', v)} placeholder="Type or pick…" />}</Field>
          <Field label="Present Use">{(id) => <AutoInput id={id} options={m?.uses ?? []} value={f.use} onChange={(v) => set('use', v)} placeholder="Type or pick…" />}</Field>
          <Field label="Structures on Land">{(id) => <Input id={id} dir="auto" value={f.structures} onChange={(e) => set('structures', e.target.value)} placeholder="None / pucca building / kacha rooms …" />}</Field>
        </div>
      </Section>

      {cat?.sections?.includes('acquisition') && (
        <Section title="Acquisition (Land Acquisition Act)">
          <div className="grid gap-2 sm:grid-cols-4">
            <Field label="Acquiring Department">{(id) => <AutoInput id={id} strict options={m?.departments ?? []} value={f.acq.department} onChange={(v) => set('acq', { ...f.acq, department: v })} />}</Field>
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
          <div className="grid gap-2 sm:grid-cols-4">
            <Field label="Scheme / Policy">{(id) => <AutoInput id={id} strict options={cat?.subTypes ?? []} value={f.allot.scheme} onChange={(v) => set('allot', { ...f.allot, scheme: v })} />}</Field>
            <Field label="Allottee / Lessee">{(id) => <Input id={id} dir="auto" value={f.allot.allottee} onChange={(e) => set('allot', { ...f.allot, allottee: e.target.value })} />}</Field>
            <Field label="Parentage">{(id) => <Input id={id} dir="auto" value={f.allot.parentage} onChange={(e) => set('allot', { ...f.allot, parentage: e.target.value })} placeholder="s/o, d/o, w/o" />}</Field>
            <Field label="Authority">{(id) => <Input id={id} value={f.allot.authority} onChange={(e) => set('allot', { ...f.allot, authority: e.target.value })} placeholder="e.g. Collector" />}</Field>
            <Field label="Order No.">{(id) => <Input id={id} value={f.allot.orderNo} onChange={(e) => set('allot', { ...f.allot, orderNo: e.target.value })} />}</Field>
            <Field label="Order Date">{(id) => <Input id={id} type="date" value={f.allot.orderDate} onChange={(e) => set('allot', { ...f.allot, orderDate: e.target.value })} />}</Field>
            <Field label="Lease From">{(id) => <Input id={id} type="date" value={f.allot.leaseFrom} onChange={(e) => set('allot', { ...f.allot, leaseFrom: e.target.value })} />}</Field>
            <Field label="Lease To">{(id) => <Input id={id} type="date" value={f.allot.leaseTo} onChange={(e) => set('allot', { ...f.allot, leaseTo: e.target.value })} />}</Field>
            <Field label="Conditions Met?">{(id) => <Select id={id} value={f.allot.conditionsMet} onChange={(e) => set('allot', { ...f.allot, conditionsMet: e.target.value as never })}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option><option value="review">Under review</option></Select>}</Field>
            <Field label="Proprietary Rights">{(id) => <Select id={id} value={f.allot.proprietary} onChange={(e) => set('allot', { ...f.allot, proprietary: e.target.value as never })}><option value="">—</option><option value="granted">Granted</option><option value="pending">Pending</option><option value="na">Not applicable</option></Select>}</Field>
            <Field label="Mutation No.">{(id) => <Input id={id} value={f.allot.mutationNo} onChange={(e) => set('allot', { ...f.allot, mutationNo: e.target.value })} />}</Field>
          </div>
        </Section>
      )}

      <Section title="Litigation">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-brand-600" checked={f.underLitigation} onChange={(e) => set('underLitigation', e.target.checked)} />This land is under litigation</label>
        {f.underLitigation && (
          !unitId ? <p className="text-xs text-slate-500">Choose the mouza to link its cases.</p> :
          cases.isLoading ? <Loading /> : !cases.data?.length ? <p className="text-xs text-slate-500">No case of this mouza is in the Litigation register yet. Add it there, then link it here.</p> : (
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md p-2 ring-1 ring-slate-200 dark:ring-slate-700">
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
    </>
  );
}

/** Edit one khasra: its area, khewat / khatauni and details. */
function KhasraEdit({ h, onClose }: { h: Khasra; onClose: () => void }) {
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const [areaS, setAreaS] = useState(areaIn(h.area));
  const [enc, setEnc] = useState(areaIn(h.encroachment?.area));
  const [khewat, setKhewat] = useState(h.khewat ?? '');
  const [khatauni, setKhatauni] = useState(h.khatauni ?? '');
  const [d, setD] = useState(() => detailsInit(h));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const msg = checkDetails(d);
    if (msg) return setError(new Error(msg));
    setBusy(true); setError(null);
    try {
      await patch(`/state-land/${h._id}`, { ...detailsOut(d, meta.data?.categories.find((c) => c.key === d.category)), khewat: khewat || undefined, khatauni: khatauni || undefined, area: areaOut(areaS), ...(d.site.possessedBy === 'unauthorised' ? { encroachedArea: areaOut(enc) } : {}) });
      qc.invalidateQueries({ queryKey: ['sl'] }); toast('Khasra updated — sent for verification'); onClose();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <LSheet open onClose={onClose} title={`Edit Khasra ${h.khasraNo}`} footer={<Button form="sl-edit" type="submit" block loading={busy}>Save (goes for verification again)</Button>}>
      <form id="sl-edit" onSubmit={save} className="space-y-3">
        <Section title={`Khasra ${h.khasraNo} · ${h.unitId.name}`}>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr]">
            <Field label="Khewat No(s).">{(id) => <Input id={id} value={khewat} onChange={(e) => setKhewat(e.target.value)} />}</Field>
            <Field label="Khatauni No(s).">{(id) => <Input id={id} value={khatauni} onChange={(e) => setKhatauni(e.target.value)} />}</Field>
            <div><div className="mb-1 text-[13px] font-semibold">Area (Kanal · Marla · Feet)</div><AreaBoxes value={areaS} onChange={setAreaS} /></div>
          </div>
          {d.site.possessedBy === 'unauthorised' && <div className="sm:w-1/2"><div className="mb-1 text-[13px] font-semibold text-rose-700">Encroached Area <span className="font-normal text-slate-500">(blank = whole khasra)</span></div><AreaBoxes value={enc} onChange={setEnc} /></div>}
        </Section>
        <DetailsFields f={d} setF={setD} m={meta.data} unitId={h.unitId._id} />
        <FormError error={error} />
      </form>
    </LSheet>
  );
}

/* ================================================================== *
 *  Khasra page
 * ================================================================== */
export function StateLandHoldingPage() {
  const { id } = useParams();
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const caps = useCaps();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['sl', 'khasra', id],
    queryFn: () => get<{ khasra: Khasra; cases: { _id: string; caseId: string; caseType: string; courtName: string; status: string; nextHearing?: string }[]; tehsil?: string; docs: Doc[]; categoryLabel: string; siblings: { _id: string; khasraNo: string }[]; canEdit: boolean; canVerify: boolean; canApprove: boolean }>(`/state-land/${id}`),
  });
  const [sheet, setSheet] = useState<null | 'edit' | 'doc' | 'return'>(null);
  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorState error={error} retry={refetch} />;
  const h = data.khasra;
  const m = meta.data;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['sl'] }); refetch(); };
  const act = async (path: 'verify' | 'approve' | 'return', body: object = {}) => {
    try { await post(`/state-land/${h._id}/${path}`, body); toast(path === 'verify' ? 'Verified' : path === 'approve' ? 'Approved' : 'Returned for correction'); setSheet(null); refresh(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const canRemove = caps.isAdmin || (data.canEdit && (h.status === 'entered' || h.status === 'returned'));
  const remove = async () => { if (!confirm(`Remove khasra ${h.khasraNo}?`)) return; try { await del(`/state-land/${h._id}`); qc.invalidateQueries({ queryKey: ['sl'] }); navigate('/state-land'); } catch (e) { toast((e as Error).message, 'error'); } };
  const removeDoc = async (d: Doc) => { if (!confirm('Remove this document?')) return; await del(`/state-land/${h._id}/docs/${d._id}`); refresh(); };
  const row = (k: string, v: ReactNode) => (v == null || v === '' || v === '—' ? null : <div className="grid grid-cols-[11rem_1fr] gap-2 border-b border-slate-100 py-1.5 text-sm last:border-0 dark:border-slate-800"><span className="text-slate-500">{k}</span><span dir="auto">{v}</span></div>);
  const enc = h.encroachment;
  const encroached = h.possession === 'encroached' || h.possession === 'part_encroached';
  const leaseExpired = h.allotment?.leaseTo && new Date(h.allotment.leaseTo) < new Date();
  const map = (x: Record<string, string>, k?: string | null) => (k ? x[k] ?? '' : '');

  return (
    <>
      <PageHeader title={`Khasra ${h.khasraNo}`} subtitle={`${data.categoryLabel}${h.subType ? ` · ${h.subType}` : ''} · ${h.unitId.name.replace(' (test)', '')}${data.tehsil ? `, ${data.tehsil}` : ''}`} actions={
        <div className="flex flex-wrap gap-2 print:hidden">
          {data.canEdit && <Button size="sm" variant="secondary" onClick={() => setSheet('edit')}>Edit</Button>}
          {data.canEdit && <Button size="sm" variant="secondary" onClick={() => setSheet('doc')}><Upload className="size-4" />Attach</Button>}
          <Button size="sm" variant="ghost" onClick={() => window.print()}><FileText className="size-4" />Print</Button>
          {canRemove && <Button size="sm" variant="ghost" onClick={remove} aria-label="Remove"><Trash2 className="size-4" /></Button>}
        </div>
      } />

      <Card className={clsx('mb-3 flex flex-wrap items-center gap-3 border-l-4 p-3 text-sm', h.status === 'approved' ? 'border-emerald-500' : h.status === 'returned' ? 'border-rose-500' : 'border-amber-500')}>
        <StatusBadge s={h.status} />
        <span className="text-slate-600 dark:text-slate-300">
          Entered by {h.createdBy?.name ?? '—'} on <span className="font-semibold">{fmt(h.createdAt)}</span>
          {h.verifiedBy && ` · verified by ${h.verifiedBy.name} on ${fmt(h.verifiedAt)}`}
          {h.approvedBy && ` · approved by ${h.approvedBy.name} on ${fmt(h.approvedAt)}`}
        </span>
        {h.status === 'returned' && h.returnRemarks && <span className="w-full text-rose-700"><b>Remarks:</b> {h.returnRemarks}</span>}
        <div className="ml-auto flex gap-2 print:hidden">
          {data.canVerify && h.status === 'entered' && <Button size="sm" onClick={() => act('verify')}><ShieldCheck className="size-4" />Verify</Button>}
          {data.canApprove && h.status === 'verified' && <Button size="sm" onClick={() => act('approve')}><CheckCircle2 className="size-4" />Approve</Button>}
          {(data.canVerify || data.canApprove) && h.status !== 'returned' && (h.status !== 'approved' || data.canApprove) && <Button size="sm" variant="secondary" onClick={() => setSheet('return')}><RotateCcw className="size-4" />Return</Button>}
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <SectionTitle>Khasra and Record</SectionTitle>
          {row('Mouza', `${h.unitId.name.replace(' (test)', '')}${data.tehsil ? `, Tehsil ${data.tehsil}` : ''}`)}
          {row('Murabba / Mustateel No.', h.murabba)}
          {row('Killa', `${h.killa}${h.subKilla ? ` · sub-killa ${h.subKilla}` : ''}`)}
          {row('Khewat / Khatauni', [h.khewat, h.khatauni].filter(Boolean).join(' / '))}
          {row('Area', `${kmf(h.area)} = ${acres(h.acres)} acres`)}
          {row('Jamabandi Year', h.jamabandiYear)}
          {data.siblings.length > 1 && row(`State land in murabba ${h.murabba}`, <span className="flex flex-wrap gap-1">{data.siblings.map((s) => <Link key={s._id} to={`/state-land/${s._id}`} className={clsx('rounded px-1.5 font-mono text-xs ring-1', s._id === h._id ? 'bg-brand-700 text-white ring-brand-700' : 'ring-slate-300 hover:bg-brand-50')}>{s.khasraNo.slice(h.murabba.length + 1)}</Link>)}</span>)}
        </Card>
        <Card className="p-4">
          <SectionTitle>Classification and Ownership</SectionTitle>
          {row('Category', data.categoryLabel)}
          {row('Sub-type', h.subType)}
          {row('Custodian Department', h.custodian)}
          {row('Land Classification', h.landClass)}
          {row('Present Use', h.use)}
          {row('Structures', h.structures)}
          {row('Record Status', <span className={clsx(h.record.status !== 'mutated' && 'text-amber-700')}>{label(m?.recordStatus, h.record.status)}</span>)}
          {row('Mutation No(s).', h.record.mutationNos)}
          {row('Demarcation', h.record.demarcation === 'yes' ? `Done${h.record.demarcationDate ? ` on ${fmt(h.record.demarcationDate)}` : ''}${h.record.demarcationRef ? ` (${h.record.demarcationRef})` : ''}` : h.record.demarcation === 'no' ? 'Not done' : '')}
          {row('Computerised Record', map({ yes: 'Matches', no: 'Does not match', unchecked: 'Not checked' }, h.record.computerised))}
          {row('Discrepancy', h.record.discrepancy)}
          {row('Last Site Visit', h.lastVisit ? fmt(h.lastVisit) : '')}
        </Card>

        <Card className="p-4">
          <SectionTitle>Part A · As per Record</SectionTitle>
          {row('Khana Malkiyat (Ownership)', [h.ownerRecord, h.ownerShare && `share ${h.ownerShare}`].filter(Boolean).join(' · '))}
          {row('Khana Kasht', h.kasht?.type)}
          {row('Name(s) in Khana Kasht', (h.kasht?.names ?? []).join('; '))}
        </Card>
        <Card className={clsx('p-4', encroached && 'border-l-4 border-rose-500')}>
          <SectionTitle>Part B · Physical Possession</SectionTitle>
          {row('In Possession Of', <span className={clsx(encroached && 'font-semibold text-rose-700')}>{label(m?.possessedBy, h.site?.possessedBy)}</span>)}
          {row('Name(s)', (h.site?.names ?? []).join('; '))}
          {row('Nature of Land at Site', (h.site?.nature ?? []).join(', '))}
          {row('Status', <span className={clsx(encroached && 'font-semibold text-rose-700')}>{label(m?.possession, h.possession)}{encroached ? ' — differs from record' : ''}</span>)}
        </Card>

        {h.acquisition && Object.values(h.acquisition).some(Boolean) && (
          <Card className="p-4">
            <SectionTitle>Acquisition</SectionTitle>
            {row('Department / Purpose', [h.acquisition.department, h.acquisition.purpose].filter(Boolean).join(' — '))}
            {row('Award', [h.acquisition.awardNo, h.acquisition.awardDate && fmt(h.acquisition.awardDate)].filter(Boolean).join(' dated '))}
            {row('Compensation', h.acquisition.compensation ? `${map({ yes: 'Paid', no: 'Not paid', partly: 'Partly paid' }, h.acquisition.compensation)}${h.acquisition.compensationAmount ? ` · Rs ${h.acquisition.compensationAmount.toLocaleString()}` : ''}` : '')}
            {row('Mutation for Department', h.acquisition.mutationNo ? `${h.acquisition.mutationNo}${h.acquisition.mutationDate ? ` (${fmt(h.acquisition.mutationDate)})` : ''}` : <span className="text-amber-700">Not yet</span>)}
          </Card>
        )}
        {h.allotment && Object.values(h.allotment).some(Boolean) && (
          <Card className="p-4">
            <SectionTitle>Allotment / Lease</SectionTitle>
            {row('Scheme', h.allotment.scheme)}
            {row('Allottee / Lessee', [h.allotment.allottee, h.allotment.parentage].filter(Boolean).join(' '))}
            {row('Order', [h.allotment.orderNo, h.allotment.orderDate && fmt(h.allotment.orderDate), h.allotment.authority].filter(Boolean).join(' · '))}
            {row('Lease Period', h.allotment.leaseFrom || h.allotment.leaseTo ? <span className={clsx(leaseExpired && 'font-semibold text-rose-700')}><span className="font-semibold">{fmt(h.allotment.leaseFrom)}</span> to <span className="font-semibold">{fmt(h.allotment.leaseTo)}</span>{leaseExpired && ' — expired'}</span> : '')}
            {row('Conditions Met', map({ yes: 'Yes', no: 'No', review: 'Under review' }, h.allotment.conditionsMet))}
            {row('Proprietary Rights', map({ granted: 'Granted', pending: 'Pending', na: 'Not applicable' }, h.allotment.proprietary))}
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
            <button className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => download(`/state-land/${h._id}/docs/${d._id}`, `${h.khasraNo.replace(/\//g, '-')} ${d.title ?? d.category}.pdf`)}>
              <b>{m?.docCategories.find((c) => c.key === d.category)?.label ?? d.category}</b>{d.title && ` — ${d.title}`}
            </button>
            <span className="text-xs text-slate-500">{d.pages ?? 1} p · {Math.round(d.size / 1024)} KB · <span className="font-semibold">{fmt(d.docDate ?? d.createdAt)}</span></span>
            {data.canEdit && <button className="text-slate-400 hover:text-rose-600 print:hidden" onClick={() => removeDoc(d)} aria-label="Remove"><Trash2 className="size-4" /></button>}
          </div>
        ))}
      </Card>

      <SectionTitle>History</SectionTitle>
      <Card className="p-3 text-sm">
        {[...h.history].reverse().map((x, i) => (
          <div key={i} className="flex gap-2 border-b border-slate-100 py-1 last:border-0 dark:border-slate-800"><span className="w-36 shrink-0 text-xs text-slate-500"><span className="font-semibold">{new Date(x.at).toLocaleString('en-GB')}</span></span><span><b>{x.by?.name ?? '—'}</b> {x.action}{x.remarks && <span className="text-slate-500"> — {x.remarks}</span>}</span></div>
        ))}
      </Card>

      {sheet === 'edit' && <KhasraEdit h={h} onClose={() => { setSheet(null); refresh(); }} />}
      {sheet === 'doc' && <DocSheet uploadUrl={`/state-land/${h._id}/docs`} label={h.khasraNo} categories={m?.docCategories ?? []} onDone={() => { setSheet(null); refresh(); }} />}
      {sheet === 'return' && <ReturnSheet title={`Return Khasra ${h.khasraNo} for Correction`} onClose={() => setSheet(null)} onReturn={(remarks) => act('return', { remarks })} />}
    </>
  );
}
