/**
 * Litigation register — every court case affecting land in the user's jurisdiction.
 *   /litigation       dashboard, filters, list, new case, Excel export
 *   /litigation/:id   the case: details, hearings, decision, appeal / stages, notes, documents, PDF
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlarmClock, Camera, Download, FileText, Gavel, Image as ImageIcon, Plus, Scale, Search, Trash2, Upload, X } from 'lucide-react';
import { useDeferredValue, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../components/AppShell';
import { UnitField } from '../components/rev';
import { Badge, Button, Card, Empty, ErrorState, Field, FormError, Input, Loading, SectionTitle, Segmented, Select, Sheet, Textarea, useToast } from '../components/ui';
import { ApiError, del, download, get, patch, post, put } from '../lib/api';
import { useCaps, type UnitRef } from '../lib/rev';

interface Meta { courts: { group: string; items: [string, string][] }[]; caseTypes: string[]; khasraOnly: string[]; categories: { key: string; label: string }[]; canEnter: boolean }
interface ListRow { _id: string; caseId: string; unitId: { name: string } | null; caseType: string; courtName: string; applicants: string[]; respondents: string[]; nextHearing?: string; lastHearing?: string; status: 'pending' | 'decided'; stage: number; decision?: { date?: string } }
interface Hearing { _id: string; date: string; court?: string; proceedingsDone?: string; nextAction?: string; nextDate?: string; attendedBy?: string; by?: { name: string } }
interface Case {
  _id: string; caseId: string; unitId: { _id: string; name: string }; caseType: string; institutedOn: string; court: string; courtOther?: string; bench?: string; courtCaseNo?: string;
  applicants: string[]; respondents: string[]; land: { kanal?: number; marla?: number; sarsai?: number; murabba?: string; khasraNos: string[]; parcels?: { murabba?: string; khasras: string[] }[]; khewat?: string; khatauni?: string }; landSpec?: string; governmentParty: boolean;
  hearings: Hearing[]; lastHearing?: string; nextHearing?: string; lastProceedings?: string; nextAction?: string; status: 'pending' | 'decided';
  decision?: { date?: string; result?: string; summary?: string }; appeal: { filed: 'yes' | 'no' | 'undecided'; court?: string; courtOther?: string; filedOn?: string; appealNo?: string; reasonNotFiled?: string };
  stage: number; stages: { stage: number; court: string; courtOther?: string; courtCaseNo?: string; institutedOn?: string; decidedOn?: string; result?: string }[];
  note?: string; notes: { text: string; by?: { name: string }; at: string }[]; history: { at: string; by?: { name: string }; action: string }[];
}
interface Doc { _id: string; category: string; title?: string; docDate?: string; pages?: number; size: number; createdAt: string; uploadedBy?: { name: string } }

const fmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const iso = (d?: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const useMeta = () => useQuery({ queryKey: ['lit', 'meta'], queryFn: () => get<Meta>('/litigation/meta'), staleTime: 300_000 });
const courtLabel = (m: Meta | undefined, code?: string, other?: string) => (code === 'other' ? other || 'Other' : m?.courts.flatMap((g) => g.items).find(([k]) => k === code)?.[1] ?? code ?? '—');
const StatusBadge = ({ s }: { s: string }) => <Badge tone={s === 'decided' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}>{s === 'decided' ? 'Decided' : 'Pending'}</Badge>;

function CourtSelect({ meta, value, other, onChange, id }: { meta?: Meta; value: string; other?: string; onChange: (court: string, other?: string) => void; id?: string }) {
  return (
    <div className="space-y-1.5">
      <AutoInput id={id} strict options={courtOpts(meta)} value={value} onChange={(v) => onChange(v, other)} placeholder="Type to search courts…" />
      {value === 'other' && <Input placeholder="Name of the court" value={other ?? ''} onChange={(e) => onChange(value, e.target.value)} />}
    </div>
  );
}

/** Entry dialogs share the green-titled compact form style. */
const LSheet = (p: Parameters<typeof Sheet>[0]) => <Sheet {...p} tone="form" />;

/** Values already used in this jurisdiction (types, benches, parties…), for suggestions while typing. */
type Suggest = Record<string, string[]>;
const useSuggest = () => useQuery({ queryKey: ['lit', 'suggest'], queryFn: () => get<Suggest>('/litigation/suggest'), staleTime: 120_000 });

interface Opt { value: string; label: string; hint?: string }
/**
 * Text box that suggests matching items as the user types.
 * Free mode: whatever is typed is the value (suggestions only help keep entries uniform).
 * `strict`: the value must be picked from the list (court, mouza).
 */
function AutoInput({ id, options, value, onChange, strict, placeholder, onQuery, required, dir }: {
  id?: string; options: (Opt | string)[]; value: string; onChange: (v: string) => void; strict?: boolean; placeholder?: string; onQuery?: (q: string) => void; required?: boolean; dir?: string;
}) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const labelOf = (v: string) => opts.find((o) => o.value === v)?.label ?? v;
  const [text, setText] = useState(strict ? labelOf(value) : value);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  useEffect(() => { if (!open) setText(strict ? labelOf(value) : value); }, [value, open, options.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = text.trim().toLowerCase();
  const matches = (q && !(strict && labelOf(value) === text) ? opts.filter((o) => o.label.toLowerCase().includes(q)).sort((a, b) => +!a.label.toLowerCase().startsWith(q) - +!b.label.toLowerCase().startsWith(q)) : opts).filter((o) => strict || o.label !== text).slice(0, 12);
  const pick = (o: Opt) => { onChange(o.value); setText(o.label); setOpen(false); };
  return (
    <div className="relative">
      <Input id={id} dir={dir} autoComplete="off" required={required} placeholder={placeholder} value={text}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => { setOpen(false); if (strict && labelOf(value) !== text) setText(labelOf(value)); }, 150)}
        onChange={(e) => { setText(e.target.value); setOpen(true); setHi(0); onQuery?.(e.target.value); if (!strict) onChange(e.target.value); }}
        onKeyDown={(e) => {
          if (!open || !matches.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter' && (strict || q)) { e.preventDefault(); pick(matches[hi]); }
          else if (e.key === 'Escape') setOpen(false);
        }} />
      {open && matches.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-56 w-max min-w-full max-w-[min(26rem,90vw)] overflow-y-auto rounded-lg bg-white py-1 text-sm shadow-lg ring-1 ring-slate-300 dark:bg-slate-900 dark:ring-slate-600">
          {matches.map((o, i) => (
            <button type="button" key={o.value + i} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)} onMouseEnter={() => setHi(i)}
              className={clsx('flex w-full justify-between gap-2 px-2.5 py-1.5 text-left', i === hi && 'bg-brand-50 dark:bg-brand-900/40')} dir="auto">
              <span>{o.label}</span>{o.hint && <span className="shrink-0 whitespace-nowrap text-xs text-slate-500">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Several applicants / respondents: one box each, with suggestions from earlier cases. */
const Names = ({ value, onChange, id, suggestions }: { value: string[]; onChange: (v: string[]) => void; id?: string; suggestions: string[] }) => {
  const rows = value.length ? value : [''];
  return (
    <div className="space-y-1.5">
      {rows.map((v, i) => (
        <div key={i} className="flex gap-1.5">
          <div className="flex-1"><AutoInput id={i === 0 ? id : undefined} dir="auto" options={suggestions} value={v} onChange={(x) => onChange(rows.map((r, j) => (j === i ? x : r)))} placeholder={i ? 'Another name' : 'Name, s/o or d/o…'} /></div>
          {rows.length > 1 && <Button type="button" size="sm" variant="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove"><X className="size-4" /></Button>}
        </div>
      ))}
      <button type="button" className="text-xs font-semibold text-brand-700 hover:underline" onClick={() => onChange([...rows, ''])}>+ Add another</button>
    </div>
  );
};

/** Court picker: type to search the court list (strict), plus a name when "Other". */
const courtOpts = (m?: Meta): Opt[] => m?.courts.flatMap((g) => g.items.map(([k, l]) => ({ value: k, label: l, hint: g.group }))) ?? [];

/* ================================================================== *
 *  Register
 * ================================================================== */
export function LitigationList() {
  const meta = useMeta();
  const [search, setSearch] = useState('');
  const term = useDeferredValue(search.trim());
  const [status, setStatus] = useState<'' | 'pending' | 'decided'>('');
  const [court, setCourt] = useState('');
  const [area, setArea] = useState<UnitRef | null>(null);
  const [week, setWeek] = useState(false);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<'register' | 'causelist' | 'calendar' | 'monitor'>('register');
  const [importing, setImporting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const caps = useCaps();
  const today = new Date().toISOString().slice(0, 10);
  const in7 = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
  const params = new URLSearchParams({ page: String(page), ...(term ? { search: term } : {}), ...(status ? { status } : {}), ...(court ? { court } : {}), ...(area ? { unitId: area._id } : {}), ...(week ? { hearingFrom: today, hearingTo: in7 } : {}) });
  useEffect(() => setPage(1), [term, status, court, area, week]);
  const list = useQuery({ queryKey: ['lit', 'list', params.toString()], queryFn: () => get<{ items: ListRow[]; total: number }>(`/litigation?${params}`) });
  const dash = useQuery({ queryKey: ['lit', 'dash'], queryFn: () => get<{ total: number; pending: number; decided: number; thisWeek: number; overdue: number; appealDue: { _id: string; caseId: string; days: number }[] }>('/litigation/dashboard') });
  const d = dash.data;
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 50));

  return (
    <>
      <PageHeader title="Litigation" subtitle="Court cases in your jurisdiction" actions={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => download(`/litigation/export/xlsx?${params}`, 'litigation.xlsx')}><Download className="size-4" />Excel</Button>
          {meta.data?.canEnter && <Button size="sm" variant="secondary" onClick={() => setImporting(true)}><Upload className="size-4" />Import</Button>}
          {caps.isAdmin && <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>Settings</Button>}
          {meta.data?.canEnter && <Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" />New Case</Button>}
        </div>
      } />
      <div className="mb-3"><Segmented value={view} onChange={setView} options={[{ value: 'register', label: 'Register' }, { value: 'causelist', label: 'Cause List' }, { value: 'calendar', label: 'Calendar' }, { value: 'monitor', label: 'Monitoring' }]} /></div>
      {importing && <ImportSheet onClose={() => setImporting(false)} />}
      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
      {view === 'causelist' ? <CauseList area={area} /> : view === 'calendar' ? <HearingCalendar area={area} /> : view === 'monitor' ? <Monitoring /> : <>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          { l: 'Total Cases', v: d?.total, on: () => { setStatus(''); setWeek(false); } },
          { l: 'Pending', v: d?.pending, on: () => { setStatus('pending'); setWeek(false); }, tone: 'text-amber-700' },
          { l: 'Decided', v: d?.decided, on: () => { setStatus('decided'); setWeek(false); }, tone: 'text-emerald-700' },
          { l: 'Hearings This Week', v: d?.thisWeek, on: () => { setStatus('pending'); setWeek(true); }, tone: 'text-sky-700' },
          { l: 'Update Overdue', v: d?.overdue, tone: d?.overdue ? 'text-rose-700' : undefined },
        ].map((c) => (
          <Card key={c.l} className={clsx('p-3', c.on && 'cursor-pointer hover:ring-brand-200')} onClick={c.on}>
            <div className={clsx('text-2xl font-bold tabular-nums', c.tone)}>{c.v ?? '—'}</div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{c.l}</div>
          </Card>
        ))}
      </div>
      {!!d?.appealDue.length && (
        <Card className="mb-3 flex flex-wrap items-center gap-2 border-l-4 border-rose-500 p-3 text-sm">
          <AlarmClock className="size-4 text-rose-600" /><b>Appeal period ending:</b>
          {d.appealDue.map((a) => <Link key={a._id} to={`/litigation/${a._id}`} className="font-medium text-rose-700 underline">{a.caseId} ({a.days} day{a.days === 1 ? '' : 's'})</Link>)}
        </Card>
      )}
      <Card className="mb-3 grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><Input className="pl-9" placeholder="Case ID, party, court no., khasra, murabba…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <UnitField value={area} onChange={setArea} placeholder="Any area" />
        <Select value={court} onChange={(e) => setCourt(e.target.value)}><option value="">Any court</option>{meta.data?.courts.map((g) => <optgroup key={g.group} label={g.group}>{g.items.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</optgroup>)}</Select>
        <div className="flex gap-2">
          <Select value={status} onChange={(e) => setStatus(e.target.value as never)}><option value="">Any status</option><option value="pending">Pending</option><option value="decided">Decided</option></Select>
          {(area || court || status || week || term) && <Button variant="ghost" onClick={() => { setArea(null); setCourt(''); setStatus(''); setWeek(false); setSearch(''); }}><X className="size-4" /></Button>}
        </div>
      </Card>
      {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} retry={list.refetch} /> : !list.data?.items.length ? (
        <Card><Empty icon={Scale} title="No cases" body={meta.data?.canEnter ? 'Add the first case with New Case.' : 'No cases recorded in your jurisdiction yet.'} /></Card>
      ) : (
        <>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-separate border-spacing-0 text-[13px]">
              <thead className="bg-brand-700 text-center text-[12.5px] text-white">
                <tr>{['#', 'Case ID', 'Mouza', 'Type', 'Court', 'Parties', 'Next Hearing', 'Status'].map((h) => <th key={h} className="border-b border-r border-white/50 px-3 py-2">{h}</th>)}</tr>
              </thead>
              <tbody>
                {list.data.items.map((c, i) => {
                  const overdue = c.status === 'pending' && c.nextHearing && new Date(c.nextHearing) < new Date(Date.now() - 86_400_000);
                  return (
                    <tr key={c._id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60" onClick={() => (location.href = `/litigation/${c._id}`)}>
                      <td className="border-b border-r border-slate-200 px-2 py-2 text-center text-xs text-slate-500">{(page - 1) * 50 + i + 1}</td>
                      <td className="whitespace-nowrap border-b border-r border-slate-200 px-3 py-2 text-center font-mono text-[12px] font-semibold"><Link to={`/litigation/${c._id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">{c.caseId}</Link>{c.stage > 1 && <span className="ml-1 text-[10px] text-violet-700">S{c.stage}</span>}</td>
                      <td className="border-b border-r border-slate-200 px-3 py-2">{c.unitId?.name.replace(' (test)', '')}</td>
                      <td className="border-b border-r border-slate-200 px-3 py-2">{c.caseType}</td>
                      <td className="border-b border-r border-slate-200 px-3 py-2">{c.courtName}</td>
                      <td className="border-b border-r border-slate-200 px-3 py-2 text-xs" dir="auto">{c.applicants[0]}{c.applicants.length > 1 && ` +${c.applicants.length - 1}`} <span className="text-slate-400">v.</span> {c.respondents[0]}{c.respondents.length > 1 && ` +${c.respondents.length - 1}`}</td>
                      <td className={clsx('whitespace-nowrap border-b border-r border-slate-200 px-3 py-2 text-center', overdue && 'font-semibold text-rose-700')}>{c.status === 'decided' ? <span className="text-slate-400">Decided {fmt(c.decision?.date)}</span> : fmt(c.nextHearing)}</td>
                      <td className="border-b border-slate-200 px-3 py-2 text-center"><StatusBadge s={c.status} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
          <div className="mt-2 flex items-center justify-between text-sm text-slate-500">
            <span>{list.data.total.toLocaleString()} case(s)</span>
            {pages > 1 && <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><span className="self-center">Page {page} of {pages}</span><Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div>}
          </div>
        </>
      )}
      </>}
      {creating && <CaseForm onClose={() => setCreating(false)} />}
    </>
  );
}

/* ---------- Cause list: hearings by date, printable ---------- */
function CauseList({ area }: { area: UnitRef | null }) {
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10));
  const { data, isLoading } = useQuery({
    queryKey: ['lit', 'causelist', from, to, area?._id],
    queryFn: () => get<{ items: { _id: string; caseId: string; unitId: { name: string } | null; tehsilId: { name: string } | null; courtName: string; bench?: string; courtCaseNo?: string; applicants: string[]; respondents: string[]; nextHearing: string; nextAction?: string; caseType: string }[] }>(`/litigation/causelist?from=${from}&to=${to}${area ? `&unitId=${area._id}` : ''}`),
  });
  const days = [...new Set((data?.items ?? []).map((c) => c.nextHearing.slice(0, 10)))];
  return (
    <>
      <Card className="mb-3 flex flex-wrap items-end gap-3 p-3 print:hidden">
        <Field label="From">{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Button variant="secondary" onClick={() => window.print()}><FileText className="size-4" />Print Cause List</Button>
      </Card>
      <div className="hidden print:block print:mb-2"><b>Cause List</b> · {fmt(from)} to {fmt(to)}{area && ` · ${area.name}`}</div>
      {isLoading ? <Loading /> : !days.length ? <Card><Empty title="No hearings in these dates" /></Card> : days.map((d) => {
        const rows = data!.items.filter((c) => c.nextHearing.slice(0, 10) === d);
        return (
          <div key={d} className="mb-3 break-inside-avoid">
            <SectionTitle>{new Date(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · {rows.length} case(s)</SectionTitle>
            <Card className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-separate border-spacing-0 text-[13px]">
                <thead className="bg-brand-700 text-center text-[12.5px] text-white print:bg-slate-200 print:text-black">
                  <tr>{['#', 'Case ID', 'Court', 'Tehsil / Mouza', 'Parties', 'Type', 'To Be Done'].map((h) => <th key={h} className="border-b border-r border-white/50 px-2 py-1.5">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map((c, i) => (
                    <tr key={c._id}>
                      <td className="border-b border-r border-slate-200 px-2 py-1.5 text-center text-xs">{i + 1}</td>
                      <td className="whitespace-nowrap border-b border-r border-slate-200 px-2 py-1.5 font-mono text-[12px]"><Link to={`/litigation/${c._id}`} className="hover:underline">{c.caseId}</Link></td>
                      <td className="border-b border-r border-slate-200 px-2 py-1.5">{c.courtName}{c.bench && `, ${c.bench}`}{c.courtCaseNo && <div className="text-[11px] text-slate-500">{c.courtCaseNo}</div>}</td>
                      <td className="border-b border-r border-slate-200 px-2 py-1.5">{c.tehsilId?.name} / {c.unitId?.name.replace(' (test)', '')}</td>
                      <td className="border-b border-r border-slate-200 px-2 py-1.5 text-xs" dir="auto">{c.applicants.join('; ')} <span className="text-slate-400">v.</span> {c.respondents.join('; ')}</td>
                      <td className="border-b border-r border-slate-200 px-2 py-1.5">{c.caseType}</td>
                      <td className="border-b border-slate-200 px-2 py-1.5 text-xs" dir="auto">{c.nextAction || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        );
      })}
    </>
  );
}

/* ---------- Calendar: a month of hearings ---------- */
function HearingCalendar({ area }: { area: UnitRef | null }) {
  const [month, setMonth] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const { data, isLoading } = useQuery({
    queryKey: ['lit', 'calendar', ymd(month), area?._id],
    queryFn: () => get<{ items: { _id: string; caseId: string; courtName: string; nextHearing: string }[] }>(`/litigation/causelist?from=${ymd(month)}&to=${ymd(last)}${area ? `&unitId=${area._id}` : ''}`),
  });
  const byDay = new Map<string, { _id: string; caseId: string; courtName: string }[]>();
  for (const c of data?.items ?? []) { const k = c.nextHearing.slice(0, 10); byDay.set(k, [...(byDay.get(k) ?? []), c]); }
  const lead = (month.getDay() + 6) % 7; // weeks start on Monday
  const cells = [...Array(lead).fill(null), ...Array.from({ length: last.getDate() }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))];
  const today = ymd(new Date());
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  return (
    <Card className="p-3">
      <div className="mb-3 flex items-center justify-between">
        <Button size="sm" variant="ghost" onClick={() => shift(-1)}>‹ Previous</Button>
        <b>{month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}{isLoading && ' …'}</b>
        <Button size="sm" variant="ghost" onClick={() => shift(1)}>Next ›</Button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-[12px]">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => <div key={w} className="rounded bg-brand-700 py-1 text-center font-semibold text-white">{w}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={`x${i}`} />;
          const k = ymd(d); const rows = byDay.get(k) ?? [];
          return (
            <div key={k} className={clsx('min-h-20 rounded border border-slate-200 p-1', k === today && 'ring-2 ring-brand-500', rows.length && 'bg-sky-50 dark:bg-sky-950/30')}>
              <div className="flex justify-between text-[11px] text-slate-500"><span>{d.getDate()}</span>{rows.length > 0 && <b className="text-sky-700">{rows.length}</b>}</div>
              {rows.slice(0, 3).map((c) => <Link key={c._id} to={`/litigation/${c._id}`} title={c.courtName} className="block truncate font-mono text-[10.5px] text-sky-800 hover:underline">{c.caseId}</Link>)}
              {rows.length > 3 && <div className="text-[10px] text-slate-500">+{rows.length - 3} more</div>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ---------- Monitoring: where the cases are, what needs attention ---------- */
type Grp = { _id: string; label: string; total: number; pending: number; decided: number };
type MonCase = { _id: string; caseId: string; unitId: { name: string } | null; courtName: string; institutedOn?: string; years?: number; decision?: { date?: string; result?: string } };
function Monitoring() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['lit', 'stats'], queryFn: () => get<{ byCourt: Grp[]; byType: Grp[]; byTehsil: Grp[]; oldest: MonCase[]; noHearing: MonCase[]; againstGovt: MonCase[] }>('/litigation/stats') });
  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorState error={error} retry={refetch} />;
  const th = 'border-b border-r border-white/50 px-2 py-1.5';
  const td = 'border-b border-r border-slate-200 px-2 py-1.5';
  const GroupTable = ({ title, rows }: { title: string; rows: Grp[] }) => (
    <div>
      <SectionTitle>{title}</SectionTitle>
      <Card className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="bg-brand-700 text-center text-[12.5px] text-white"><tr>{['', 'Total', 'Pending', 'Decided'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.length ? rows.map((r) => <tr key={String(r._id)}><td className={td}>{r.label || '—'}</td>{[r.total, r.pending, r.decided].map((v, i) => <td key={i} className={clsx(td, 'text-center tabular-nums')}>{v}</td>)}</tr>) : <tr><td colSpan={4} className={clsx(td, 'text-center text-slate-500')}>No cases</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
  const CaseTable = ({ title, rows, extra }: { title: string; rows: MonCase[]; extra: [string, (c: MonCase) => string] }) => (
    <div>
      <SectionTitle>{title} · {rows.length}</SectionTitle>
      <Card className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="bg-brand-700 text-center text-[12.5px] text-white"><tr>{['Case ID', 'Mouza', 'Court', extra[0]].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.length ? rows.map((c) => (
              <tr key={c._id}>
                <td className={clsx(td, 'whitespace-nowrap font-mono text-[12px]')}><Link to={`/litigation/${c._id}`} className="hover:underline">{c.caseId}</Link></td>
                <td className={td}>{c.unitId?.name.replace(' (test)', '')}</td>
                <td className={td}>{c.courtName}</td>
                <td className={clsx(td, 'text-center')}>{extra[1](c)}</td>
              </tr>
            )) : <tr><td colSpan={4} className={clsx(td, 'text-center text-slate-500')}>None</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
  return (
    <div className="space-y-3">
      <div className="grid gap-4 lg:grid-cols-3">
        <GroupTable title="By Court" rows={data.byCourt} />
        <GroupTable title="By Case Type" rows={data.byType} />
        <GroupTable title="By Tehsil" rows={data.byTehsil} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <CaseTable title="Decided Against Government, Appeal Not Decided" rows={data.againstGovt} extra={['Decided On', (c) => fmt(c.decision?.date)]} />
        <CaseTable title="Pending With No Next Hearing" rows={data.noHearing} extra={['Instituted', (c) => fmt(c.institutedOn)]} />
      </div>
      <CaseTable title="Oldest Pending Cases" rows={data.oldest} extra={['Pending For', (c) => `${c.years} yr`]} />
    </div>
  );
}

/* ---------- Import existing registers from Excel ---------- */
function ImportSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [result, setResult] = useState<{ dryRun: boolean; valid: number; errors: { row: number; message: string }[]; imported: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const r = await post<typeof result>('/litigation/import', { file: file.data, dryRun });
      setResult(r);
      if (!dryRun && r) { toast(`${r.imported} case(s) imported`); qc.invalidateQueries({ queryKey: ['lit'] }); }
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const ready = result?.dryRun && !result.errors.length && result.valid > 0;
  return (
    <LSheet open onClose={onClose} title="Import Cases from Excel" footer={<Button block disabled={!ready} loading={busy} onClick={() => run(false)}><Upload className="size-4" />Import {result?.valid ?? ''} Case(s)</Button>}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600 dark:text-slate-300">Fill the template with your existing litigation register (one case per row), then check it. Case IDs are given automatically.</p>
        <Button variant="secondary" onClick={() => download('/litigation/import/template', 'litigation-import-template.xlsx')}><Download className="size-4" />Download Template</Button>
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border-2 border-dashed border-slate-300 p-3 hover:border-brand-400">
          <Upload className="size-5 text-brand-600" /><span className="text-sm">{file?.name ?? 'Choose the filled Excel file'}</span>
          <input type="file" accept=".xlsx" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setFile({ name: f.name, data: await readB64(f) }); setResult(null); } }} />
        </label>
        <Button block variant="secondary" disabled={!file} loading={busy} onClick={() => run(true)}>Check File</Button>
        {result && (
          <Card className="space-y-2 p-3 text-sm">
            {result.dryRun ? <div><b>{result.valid}</b> case(s) ready · <b className={result.errors.length ? 'text-rose-700' : ''}>{result.errors.length}</b> problem(s)</div> : <div className="text-emerald-700"><b>{result.imported}</b> case(s) imported.</div>}
            {!!result.errors.length && <div className="max-h-60 overflow-auto text-xs">{result.errors.map((e, i) => <div key={i}>Row {e.row}: {e.message}</div>)}</div>}
            {result.dryRun && !!result.errors.length && <p className="text-xs text-slate-500">Correct these rows in the Excel file and check again. Nothing has been saved.</p>}
          </Card>
        )}
        <FormError error={error} />
      </div>
    </LSheet>
  );
}

/* ---------- Admin settings: case types and appeal periods per court ---------- */
function SettingsSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['lit', 'settings'], queryFn: () => get<{ caseTypes: string[]; appealDays: Record<string, number>; khasraOnly: string[]; tehsils: { _id: string; name: string }[]; courts: Meta['courts'] }>('/litigation/settings') });
  const [types, setTypes] = useState<string | null>(null);
  const [days, setDays] = useState<Record<string, string> | null>(null);
  const [ko, setKo] = useState<string[] | null>(null);
  const kOnly = ko ?? data?.khasraOnly ?? [];
  const t = types ?? data?.caseTypes.join('\n') ?? '';
  const d = days ?? Object.fromEntries(Object.entries(data?.appealDays ?? {}).map(([k, v]) => [k, String(v)]));
  const save = async () => {
    await put('/litigation/settings', {
      caseTypes: t.split('\n').map((x) => x.trim()).filter(Boolean),
      khasraOnly: kOnly,
      appealDays: Object.fromEntries(Object.entries(d).filter(([, v]) => v.trim()).map(([k, v]) => [k, Number(v)])),
    });
    qc.invalidateQueries({ queryKey: ['lit'] });
    toast('Litigation settings saved');
    onClose();
  };
  return (
    <LSheet open onClose={onClose} title="Litigation Settings" footer={<Button block onClick={save}>Save</Button>}>
      <div className="space-y-3">
        <Field label="Types of case" hint="One per line">{(id) => <Textarea id={id} rows={8} value={t} onChange={(e) => setTypes(e.target.value)} />}</Field>
        <div>
          <div className="mb-1 text-sm font-medium">Tehsils without murabbas (khasra / killa only)</div>
          <p className="mb-2 text-xs text-slate-500">New cases in these tehsils open with the Khasra Only layout. Others open with Murabba + Killa / Khasra.</p>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {data?.tehsils.map((x) => (
              <label key={x._id} className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-brand-600" checked={kOnly.includes(x._id)} onChange={(e) => setKo(e.target.checked ? [...kOnly, x._id] : kOnly.filter((y) => y !== x._id))} />{x.name.replace(' (test)', '')}</label>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-sm font-medium">Appeal period (days) after a decision, by court</div>
          <p className="mb-2 text-xs text-slate-500">Leave blank where not applicable. Reminders go out 15 and 5 days before the period ends when no appeal decision is recorded.</p>
          {data?.courts.map((g) => (
            <div key={g.group} className="mb-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{g.group}</div>
              {g.items.filter(([k]) => k !== 'other').map(([k, l]) => (
                <div key={k} className="flex items-center justify-between gap-2 py-0.5 text-sm">
                  <span>{l}</span>
                  <Input type="number" min={0} className="w-24" value={d[k] ?? ''} onChange={(e) => setDays({ ...d, [k]: e.target.value })} placeholder="days" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </LSheet>
  );
}

/* ---------- New / edit case ---------- */
const splitNos = (x: string) => x.split(/[,;\n]+/).map((y) => y.trim()).filter(Boolean);
/** Land layout of an existing case: its parcels, or (older entries) the single murabba + khasras. */
function landInit(c?: Case): Pick<FormState, 'landMode' | 'parcels' | 'khasraNos'> {
  const l = c?.land;
  const parcels = l?.parcels?.length ? l.parcels : l?.murabba ? [{ murabba: l.murabba, khasras: l.khasraNos }] : [];
  const withM = parcels.filter((p) => p.murabba);
  return withM.length
    ? { landMode: 'murabba', parcels: withM.map((p) => ({ murabba: p.murabba ?? '', khasras: p.khasras.join(', ') })), khasraNos: '' }
    : { landMode: l?.khasraNos.length ? 'khasra' : 'murabba', parcels: [{ murabba: '', khasras: '' }], khasraNos: (l?.khasraNos ?? []).join(', ') };
}
interface FormState {
  unitId: string; mouzaName: string; caseType: string; caseTypeOther: string; institutedOn: string; court: string; courtOther?: string; bench: string; courtCaseNo: string;
  applicants: string[]; respondents: string[]; kanal: string; marla: string; sarsai: string; landMode: 'murabba' | 'khasra'; parcels: { murabba: string; khasras: string }[]; khasraNos: string; khewat: string; khatauni: string; landSpec: string;
  governmentParty: boolean; nextHearing: string; note: string;
}
function CaseForm({ initial, onClose }: { initial?: Case; onClose: () => void }) {
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [mq, setMq] = useState('');
  const mterm = useDeferredValue(mq);
  const mouzas = useQuery({ queryKey: ['lit', 'mouzas', mterm], queryFn: () => get<{ _id: string; name: string; tehsil?: string; tehsilId?: string }[]>(`/litigation/mouzas?search=${encodeURIComponent(mterm)}`), enabled: !initial });
  const known = meta.data?.caseTypes ?? [];
  const sug = useSuggest().data;
  const [f, setF] = useState<FormState>(() => ({
    unitId: initial?.unitId._id ?? '', mouzaName: initial?.unitId.name ?? '',
    caseType: initial?.caseType ?? '', caseTypeOther: '',
    institutedOn: iso(initial?.institutedOn), court: initial?.court ?? '', courtOther: initial?.courtOther, bench: initial?.bench ?? '', courtCaseNo: initial?.courtCaseNo ?? '',
    applicants: initial?.applicants ?? [''], respondents: initial?.respondents ?? [''],
    kanal: String(initial?.land.kanal ?? ''), marla: String(initial?.land.marla ?? ''), sarsai: String(initial?.land.sarsai ?? ''), ...landInit(initial),
    khewat: initial?.land.khewat ?? '', khatauni: initial?.land.khatauni ?? '', landSpec: initial?.landSpec ?? '', governmentParty: initial?.governmentParty ?? false,
    nextHearing: iso(initial?.nextHearing), note: initial?.note ?? '',
  }));
  const [error, setError] = useState<unknown>(null);
  const [dup, setDup] = useState<{ caseId: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const num = (s: string) => (s.trim() ? Number(s) : undefined);
  const save = async (force = false) => {
    setBusy(true); setError(null);
    const body = {
      ...(initial ? {} : { unitId: f.unitId }),
      caseType: f.caseType === 'Other' ? f.caseTypeOther || 'Other' : f.caseType, institutedOn: f.institutedOn, court: f.court, courtOther: f.courtOther || undefined, bench: f.bench || undefined, courtCaseNo: f.courtCaseNo || undefined,
      applicants: f.applicants.map((x) => x.trim()).filter(Boolean), respondents: f.respondents.map((x) => x.trim()).filter(Boolean),
      land: { kanal: num(f.kanal), marla: num(f.marla), sarsai: num(f.sarsai), parcels: f.landMode === 'murabba' ? f.parcels.map((x) => ({ murabba: x.murabba.trim(), khasras: splitNos(x.khasras) })) : [{ khasras: splitNos(f.khasraNos) }], khewat: f.khewat || undefined, khatauni: f.khatauni || undefined },
      landSpec: f.landSpec || undefined, governmentParty: f.governmentParty, nextHearing: f.nextHearing || null, note: f.note || undefined,
    };
    try {
      const r = initial ? await patch<Case>(`/litigation/${initial._id}`, body) : await post<Case>(`/litigation${force ? '?force=true' : ''}`, body);
      qc.invalidateQueries({ queryKey: ['lit'] });
      toast(initial ? 'Case updated' : `Case ${r.caseId} created`);
      onClose();
      if (!initial) navigate(`/litigation/${r._id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'POSSIBLE_DUPLICATE') setDup(e.body?.error?.details ?? null);
      else setError(e);
    } finally { setBusy(false); }
  };
  return (
    <LSheet open onClose={onClose} title={initial ? `Edit ${initial.caseId}` : 'New Case'} footer={<Button form="case-form" type="submit" block loading={busy}>{initial ? 'Save' : 'Create Case'}</Button>}>
      <form id="case-form" onSubmit={(e: FormEvent) => { e.preventDefault(); if (!initial && !f.unitId) return setError(new Error('Choose the mouza from the list')); if (!f.court) return setError(new Error('Choose the court from the list')); save(); }} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          {!initial && (
            <Field label="Mouza">
              {(id) => <AutoInput id={id} strict required placeholder="Type mouza name…" onQuery={setMq} value={f.unitId}
                options={[...(f.unitId ? [{ value: f.unitId, label: f.mouzaName }] : []), ...(mouzas.data ?? []).filter((m) => m._id !== f.unitId).map((m) => ({ value: m._id, label: m.name, hint: m.tehsil }))]}
                onChange={(v) => setF((x) => { const m = mouzas.data?.find((y) => y._id === v); return { ...x, unitId: v, mouzaName: m?.name ?? x.mouzaName, landMode: m?.tehsilId && meta.data?.khasraOnly.includes(m.tehsilId) ? 'khasra' : 'murabba' }; })} />}
            </Field>
          )}
          <Field label="Type of case">{(id) => <AutoInput id={id} required placeholder="Type or pick…" options={[...new Set([...known, ...(sug?.caseType ?? [])])]} value={f.caseType} onChange={(v) => set('caseType', v)} />}</Field>
          <Field label="Date of institution">{(id) => <Input id={id} type="date" required value={f.institutedOn} onChange={(e) => set('institutedOn', e.target.value)} />}</Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name of the court">{(id) => <CourtSelect id={id} meta={meta.data} value={f.court} other={f.courtOther} onChange={(c, o) => setF((x) => ({ ...x, court: c, courtOther: o }))} />}</Field>
          <Field label="Bench / station">{(id) => <AutoInput id={id} options={sug?.bench ?? []} value={f.bench} onChange={(v) => set('bench', v)} placeholder="e.g. Bahawalpur Bench" />}</Field>
          <Field label="Court case no.">{(id) => <Input id={id} value={f.courtCaseNo} onChange={(e) => set('courtCaseNo', e.target.value)} />}</Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Applicant(s)">{(id) => <Names id={id} value={f.applicants} onChange={(v) => set('applicants', v)} suggestions={sug?.applicants ?? []} />}</Field>
          <Field label="Respondent(s)">{(id) => <Names id={id} value={f.respondents} onChange={(v) => set('respondents', v)} suggestions={sug?.respondents ?? []} />}</Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-brand-600" checked={f.governmentParty} onChange={(e) => set('governmentParty', e.target.checked)} />Government / Board of Revenue is a party</label>
        <div className="rounded-lg border border-slate-300 p-2.5 dark:border-slate-600">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-brand-700">Land</div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-slate-500">How land is recorded in this tehsil</span>
            <Segmented value={f.landMode} onChange={(v) => set('landMode', v)} options={[{ value: 'murabba', label: 'Murabba + Killa / Khasra' }, { value: 'khasra', label: 'Khasra Only' }]} />
          </div>
          {f.landMode === 'murabba' ? (
            <div className="mb-2 space-y-1.5">
              <div className="grid grid-cols-[8rem_1fr_2rem] gap-1.5 text-[12px] font-semibold text-slate-600 dark:text-slate-300"><span>Murabba / Mustateel No.</span><span>Killa / Khasra Nos. (comma separated)</span><span /></div>
              {f.parcels.map((x, i) => (
                <div key={i} className="grid grid-cols-[8rem_1fr_2rem] items-center gap-1.5">
                  <AutoInput dir="auto" options={sug?.['land.parcels.murabba'] ?? []} value={x.murabba} placeholder="e.g. 45" onChange={(v) => set('parcels', f.parcels.map((y, j) => (j === i ? { ...y, murabba: v } : y)))} />
                  <Input value={x.khasras} placeholder="e.g. 12, 13, 18/1" onChange={(e) => set('parcels', f.parcels.map((y, j) => (j === i ? { ...y, khasras: e.target.value } : y)))} />
                  {f.parcels.length > 1 ? <Button type="button" size="sm" variant="ghost" aria-label="Remove murabba" onClick={() => set('parcels', f.parcels.filter((_, j) => j !== i))}><X className="size-4" /></Button> : <span />}
                </div>
              ))}
              <button type="button" className="text-xs font-semibold text-brand-700 hover:underline" onClick={() => set('parcels', [...f.parcels, { murabba: '', khasras: '' }])}>+ Add another murabba</button>
            </div>
          ) : (
            <div className="mb-2"><Field label="Khasra / Killa Nos.">{(id) => <Input id={id} value={f.khasraNos} onChange={(e) => set('khasraNos', e.target.value)} placeholder="e.g. 45/2, 46, 112" />}</Field></div>
          )}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            <Field label="Kanal">{(id) => <Input id={id} type="number" min={0} value={f.kanal} onChange={(e) => set('kanal', e.target.value)} />}</Field>
            <Field label="Marla">{(id) => <Input id={id} type="number" min={0} value={f.marla} onChange={(e) => set('marla', e.target.value)} />}</Field>
            <Field label="Sarsai">{(id) => <Input id={id} type="number" min={0} value={f.sarsai} onChange={(e) => set('sarsai', e.target.value)} />}</Field>
            <Field label="Khewat">{(id) => <Input id={id} value={f.khewat} onChange={(e) => set('khewat', e.target.value)} />}</Field>
            <Field label="Khatauni">{(id) => <Input id={id} value={f.khatauni} onChange={(e) => set('khatauni', e.target.value)} />}</Field>
          </div>
          <div className="mt-2">
            <Field label="Land specification">{(id) => <AutoInput id={id} dir="auto" options={[...new Set([...(sug?.landSpec ?? []), 'State land', 'Private land', 'Evacuee property', 'Nehri', 'Barani', 'Chahi'])]} value={f.landSpec} onChange={(v) => set('landSpec', v)} placeholder="State land, nehri…" />}</Field>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {!initial && <Field label="Next date of hearing">{(id) => <Input id={id} type="date" value={f.nextHearing} onChange={(e) => set('nextHearing', e.target.value)} />}</Field>}
          <div className={initial ? 'sm:col-span-3' : 'sm:col-span-2'}><Field label="Note for information">{(id) => <Textarea id={id} rows={1} dir="auto" value={f.note} onChange={(e) => set('note', e.target.value)} />}</Field></div>
        </div>
        {dup && (
          <Card className="space-y-2 border-l-4 border-amber-500 p-3 text-sm">
            <div>A similar case already exists: <Link to={`/litigation/${dup.id}`} className="font-semibold underline">{dup.caseId}</Link>. Is this a different case?</div>
            <Button type="button" size="sm" variant="secondary" onClick={() => save(true)}>Yes, create a new case</Button>
          </Card>
        )}
        <FormError error={error} />
      </form>
    </LSheet>
  );
}

/* ================================================================== *
 *  Case page
 * ================================================================== */
export function LitigationCasePage() {
  const { id } = useParams();
  const meta = useMeta();
  const caps = useCaps();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['lit', 'case', id];
  const { data, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => get<{ case: Case; courtName: string; tehsil?: string; docs: Doc[]; canEdit: boolean; appealDeadline?: string }>(`/litigation/${id}`) });
  const [sheet, setSheet] = useState<'edit' | 'hearing' | 'decision' | 'stage' | 'doc' | null>(null);
  const [note, setNote] = useState('');
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} retry={refetch} />;
  const { case: c, canEdit, docs, appealDeadline } = data!;
  const refresh = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['lit', 'list'] }); qc.invalidateQueries({ queryKey: ['lit', 'dash'] }); };
  const addNote = async () => { if (!note.trim()) return; await post(`/litigation/${c._id}/notes`, { text: note }); setNote(''); refresh(); };
  const removeHearing = async (h: Hearing) => { if (!confirm('Remove this hearing?')) return; await del(`/litigation/${c._id}/hearings/${h._id}`); refresh(); };
  const removeDoc = async (d: Doc) => { if (!confirm('Remove this document?')) return; await del(`/litigation/${c._id}/docs/${d._id}`); refresh(); toast('Document removed'); };
  const removeCase = async () => { if (!confirm(`Remove case ${c.caseId}? It can be restored by the administrator.`)) return; await del(`/litigation/${c._id}`); qc.invalidateQueries({ queryKey: ['lit'] }); history.back(); };
  const l = c.land;
  const row = (k: string, v: React.ReactNode) => (
    <div className="grid grid-cols-[9rem_1fr] gap-2 border-b border-slate-100 py-1.5 text-sm last:border-0 dark:border-slate-800 sm:grid-cols-[12rem_1fr]">
      <div className="text-slate-500">{k}</div><div className="min-w-0 break-words" dir="auto">{v || '—'}</div>
    </div>
  );
  const days = c.nextHearing && c.status === 'pending' ? Math.ceil((+new Date(c.nextHearing) - Date.now()) / 86_400_000) : null;

  return (
    <>
      <PageHeader title={c.caseId} back="/litigation" subtitle={<span className="flex flex-wrap items-center gap-2"><StatusBadge s={c.status} />{c.stage > 1 && <Badge tone="bg-violet-100 text-violet-800">Stage {c.stage}</Badge>}{c.unitId.name} · {data!.tehsil}</span>}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => download(`/litigation/${c._id}/pdf`, `Case ${c.caseId}.pdf`)}><FileText className="size-4" />Case File PDF</Button>
            {docs.length > 0 && <Button size="sm" variant="secondary" onClick={() => download(`/litigation/${c._id}/zip`, `Case ${c.caseId} documents.zip`)}><Download className="size-4" />Documents ZIP</Button>}
            {canEdit && <Button size="sm" variant="secondary" onClick={() => setSheet('edit')}>Edit</Button>}
            {caps.isAdmin && <Button size="sm" variant="ghost" className="text-rose-600" onClick={removeCase}><Trash2 className="size-4" /></Button>}
          </div>
        } />

      {c.status === 'pending' && (
        <Card className={clsx('mb-3 flex flex-wrap items-center gap-3 p-3', days != null && days < 0 ? 'border-l-4 border-rose-500' : 'border-l-4 border-sky-500')}>
          <Gavel className="size-5 text-slate-500" />
          <div className="flex-1 text-sm">
            <b>Next hearing: {fmt(c.nextHearing)}</b>{days != null && <span className={clsx('ml-2', days < 0 ? 'text-rose-700' : 'text-slate-500')}>{days < 0 ? `${-days} day(s) ago — record the proceedings` : days === 0 ? 'today' : `in ${days} day(s)`}</span>}
            {c.nextAction && <div className="text-xs text-slate-600 dark:text-slate-300">To be done: {c.nextAction}</div>}
          </div>
          {canEdit && <Button size="sm" onClick={() => setSheet('hearing')}><Plus className="size-4" />Record Hearing</Button>}
        </Card>
      )}
      {appealDeadline && c.appeal.filed === 'undecided' && <Card className="mb-3 border-l-4 border-rose-500 p-3 text-sm"><AlarmClock className="mr-1 inline size-4 text-rose-600" />Appeal period ends on <b>{fmt(appealDeadline)}</b>. Record whether an appeal is filed.</Card>}

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <SectionTitle>Case Details</SectionTitle>
          <Card className="px-4 py-2">
            {row('Mouza', c.unitId.name)}
            {row('Type of case', c.caseType)}
            {row('Date of institution', fmt(c.institutedOn))}
            {row('Court', `${data!.courtName}${c.bench ? `, ${c.bench}` : ''}`)}
            {row('Court case no.', c.courtCaseNo)}
            {row('Applicant(s)', c.applicants.join('; '))}
            {row('Respondent(s)', c.respondents.join('; '))}
            {row('Land measuring', [l.kanal ? `${l.kanal} K` : '', l.marla ? `${l.marla} M` : '', l.sarsai ? `${l.sarsai} S` : ''].filter(Boolean).join(' – '))}
            {(l.parcels ?? []).some((p) => p.murabba) ? row('Murabba → Killa / Khasra', (l.parcels ?? []).filter((p) => p.murabba).map((p) => `${p.murabba}: ${p.khasras.join(', ') || '—'}`).join('  |  ')) : l.murabba && row('Mustateel / Murabba', l.murabba)}
            {row('Khasra / Khewat / Khatauni', [((l.parcels ?? []).some((p) => p.murabba) ? (l.parcels ?? []).filter((p) => !p.murabba).flatMap((p) => p.khasras) : l.khasraNos).join(', '), l.khewat, l.khatauni].filter(Boolean).join(' · '))}
            {row('Land specification', c.landSpec)}
            {row('Government a party', c.governmentParty ? 'Yes' : 'No')}
            {row('Last hearing', fmt(c.lastHearing))}
            {row('Proceedings (last date)', c.lastProceedings)}
            {row('Note', c.note)}
          </Card>

          <SectionTitle action={canEdit && <Button size="sm" variant="ghost" onClick={() => setSheet('decision')}>Update</Button>}>Status, Decision & Appeal</SectionTitle>
          <Card className="px-4 py-2">
            {row('Status', <StatusBadge s={c.status} />)}
            {c.status === 'decided' && row('Date of decision', fmt(c.decision?.date))}
            {c.status === 'decided' && row('Decision', [c.decision?.result, c.decision?.summary].filter(Boolean).join(' — '))}
            {row('Appeal', c.appeal.filed === 'yes' ? `Filed — ${courtLabel(meta.data, c.appeal.court, c.appeal.courtOther)}${c.appeal.filedOn ? `, ${fmt(c.appeal.filedOn)}` : ''}${c.appeal.appealNo ? ` (No. ${c.appeal.appealNo})` : ''}` : c.appeal.filed === 'no' ? `Not filed — ${c.appeal.reasonNotFiled}` : 'Not yet decided')}
            {canEdit && c.status === 'decided' && c.appeal.filed === 'yes' && (
              <div className="py-2"><Button size="sm" variant="secondary" onClick={() => setSheet('stage')}><Scale className="size-4" />Continue in Appellate Court</Button><p className="mt-1 text-[11px] text-slate-500">The case keeps the same ID; the appeal becomes stage {c.stage + 1}.</p></div>
            )}
          </Card>
          {!!c.stages.length && (
            <>
              <SectionTitle>Court History</SectionTitle>
              <Card className="divide-y divide-slate-100 dark:divide-slate-800">
                {c.stages.map((s) => <div key={s.stage} className="px-4 py-2 text-sm"><b>Stage {s.stage}:</b> {courtLabel(meta.data, s.court, s.courtOther)}{s.courtCaseNo && ` (${s.courtCaseNo})`}<div className="text-xs text-slate-500">Instituted {fmt(s.institutedOn)} · decided {fmt(s.decidedOn)}{s.result && ` · ${s.result}`}</div></div>)}
                <div className="px-4 py-2 text-sm"><b>Stage {c.stage} (current):</b> {data!.courtName}</div>
              </Card>
            </>
          )}
        </div>

        <div>
          <SectionTitle action={canEdit && c.status === 'pending' && <Button size="sm" variant="ghost" onClick={() => setSheet('hearing')}><Plus className="size-4" />Hearing</Button>}>Hearings ({c.hearings.length})</SectionTitle>
          <Card className="divide-y divide-slate-100 dark:divide-slate-800">
            {!c.hearings.length && <div className="p-4 text-sm text-slate-500">No hearing recorded yet.</div>}
            {[...c.hearings].sort((a, b) => +new Date(b.date) - +new Date(a.date)).map((h) => (
              <div key={h._id} className="px-4 py-2.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <b>{fmt(h.date)}</b>
                  <span className="text-xs text-slate-500">{h.nextDate && `next ${fmt(h.nextDate)}`}{canEdit && <button className="ml-2 text-rose-500" onClick={() => removeHearing(h)}><Trash2 className="inline size-3.5" /></button>}</span>
                </div>
                {h.proceedingsDone && <div dir="auto"><span className="text-slate-500">Proceedings:</span> {h.proceedingsDone}</div>}
                {h.nextAction && <div dir="auto"><span className="text-slate-500">For next date:</span> {h.nextAction}</div>}
                {h.by && <div className="text-[11px] text-slate-400">by {h.by.name}{h.attendedBy && ` · attended by ${h.attendedBy}`}</div>}
              </div>
            ))}
          </Card>

          <SectionTitle action={canEdit && <Button size="sm" variant="ghost" onClick={() => setSheet('doc')}><Upload className="size-4" />Attach</Button>}>Documents ({docs.length})</SectionTitle>
          <Card className="divide-y divide-slate-100 dark:divide-slate-800">
            {!docs.length && <div className="p-4 text-sm text-slate-500">No documents attached yet.</div>}
            {meta.data?.categories.filter((cat) => docs.some((d) => d.category === cat.key)).map((cat) => (
              <div key={cat.key} className="px-4 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{cat.label}</div>
                {docs.filter((d) => d.category === cat.key).map((d) => (
                  <div key={d._id} className="flex items-center gap-2 py-1 text-sm">
                    <FileText className="size-4 shrink-0 text-rose-600" />
                    <button className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => download(`/litigation/${c._id}/docs/${d._id}`, `${c.caseId} ${d.title ?? cat.label}.pdf`)}>{d.title || cat.label}{d.docDate && ` · ${fmt(d.docDate)}`}</button>
                    <span className="shrink-0 text-[11px] text-slate-400">{d.pages ?? '?'} p · {Math.round(d.size / 1024)} KB</span>
                    {canEdit && <button className="text-rose-500" onClick={() => removeDoc(d)}><Trash2 className="size-3.5" /></button>}
                  </div>
                ))}
              </div>
            ))}
          </Card>

          <SectionTitle>Notes</SectionTitle>
          <Card className="space-y-2 p-3">
            {c.notes.map((n, i) => <div key={i} className="text-sm" dir="auto">{n.text}<div className="text-[11px] text-slate-400">{n.by?.name} · {new Date(n.at).toLocaleString()}</div></div>)}
            <div className="flex gap-2"><Input dir="auto" placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)} /><Button variant="secondary" onClick={addNote}>Add</Button></div>
          </Card>
          <p className="mt-2 text-[11px] text-slate-400">History: {c.history.slice(-6).reverse().map((h) => `${h.action} (${h.by?.name ?? ''}, ${new Date(h.at).toLocaleDateString()})`).join(' · ')}</p>
        </div>
      </div>

      {sheet === 'edit' && <CaseForm initial={c} onClose={() => { setSheet(null); refresh(); }} />}
      {sheet === 'hearing' && <HearingSheet c={c} onDone={() => { setSheet(null); refresh(); }} />}
      {sheet === 'decision' && <DecisionSheet c={c} meta={meta.data} onDone={() => { setSheet(null); refresh(); }} />}
      {sheet === 'stage' && <StageSheet c={c} meta={meta.data} onDone={() => { setSheet(null); refresh(); }} />}
      {sheet === 'doc' && <DocSheet c={c} meta={meta.data} onDone={() => { setSheet(null); refresh(); }} />}
    </>
  );
}

function HearingSheet({ c, onDone }: { c: Case; onDone: () => void }) {
  const sug = useSuggest().data;
  const [f, setF] = useState({ date: iso(c.nextHearing) || new Date().toISOString().slice(0, 10), proceedingsDone: '', nextAction: '', nextDate: '', attendedBy: '' });
  const [error, setError] = useState<unknown>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try { await post(`/litigation/${c._id}/hearings`, { ...f, nextDate: f.nextDate || null }); onDone(); } catch (err) { setError(err); }
  };
  return (
    <LSheet open onClose={onDone} title={`Record Hearing · ${c.caseId}`} footer={<Button form="h-form" type="submit" block>Save Hearing</Button>}>
      <form id="h-form" onSubmit={save} className="space-y-3">
        <Field label="Date of hearing">{(id) => <Input id={id} type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
        <Field label="Proceedings of this date">{(id) => <AutoInput id={id} dir="auto" options={sug?.['hearings.proceedingsDone'] ?? []} value={f.proceedingsDone} onChange={(v) => setF({ ...f, proceedingsDone: v })} placeholder="What happened in court…" />}</Field>
        <Field label="Next date of hearing">{(id) => <Input id={id} type="date" value={f.nextDate} onChange={(e) => setF({ ...f, nextDate: e.target.value })} />}</Field>
        <Field label="Proceedings to be done for next date">{(id) => <AutoInput id={id} dir="auto" options={[...new Set([...(sug?.['hearings.nextAction'] ?? []), 'File reply', 'Produce record', 'Arguments', 'Evidence', 'Report of Patwari'])]} value={f.nextAction} onChange={(v) => setF({ ...f, nextAction: v })} placeholder="e.g. File reply, produce record…" />}</Field>
        <Field label="Attended by (optional)">{(id) => <AutoInput id={id} options={sug?.['hearings.attendedBy'] ?? []} value={f.attendedBy} onChange={(v) => setF({ ...f, attendedBy: v })} />}</Field>
        <FormError error={error} />
      </form>
    </LSheet>
  );
}

function DecisionSheet({ c, meta, onDone }: { c: Case; meta?: Meta; onDone: () => void }) {
  const sug = useSuggest().data;
  const [status, setStatus] = useState(c.status);
  const [dec, setDec] = useState({ date: iso(c.decision?.date), result: c.decision?.result ?? '', summary: c.decision?.summary ?? '' });
  const [ap, setAp] = useState({ ...c.appeal, filedOn: iso(c.appeal.filedOn) });
  const [error, setError] = useState<unknown>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await patch(`/litigation/${c._id}`, { status, decision: status === 'decided' ? { ...dec, date: dec.date || null } : undefined, appeal: status === 'decided' ? { ...ap, filedOn: ap.filedOn || null } : { filed: 'undecided' } });
      onDone();
    } catch (err) { setError(err); }
  };
  return (
    <LSheet open onClose={onDone} title="Status, Decision & Appeal" footer={<Button form="d-form" type="submit" block>Save</Button>}>
      <form id="d-form" onSubmit={save} className="space-y-3">
        <Segmented value={status} onChange={setStatus} options={[{ value: 'pending', label: 'Not Decided Yet' }, { value: 'decided', label: 'Decided' }]} />
        {status === 'decided' && (
          <>
            <Field label="Date of decision">{(id) => <Input id={id} type="date" required value={dec.date} onChange={(e) => setDec({ ...dec, date: e.target.value })} />}</Field>
            <Field label="Result">{(id) => <AutoInput id={id} placeholder="Type or pick…" options={[...new Set(['In favour of government', 'Against government', 'In favour of applicant', 'In favour of respondent', 'Dismissed', 'Withdrawn', 'Remanded', ...(sug?.['decision.result'] ?? [])])]} value={dec.result} onChange={(v) => setDec({ ...dec, result: v })} />}</Field>
            <Field label="Summary (optional)">{(id) => <Textarea id={id} rows={2} dir="auto" value={dec.summary} onChange={(e) => setDec({ ...dec, summary: e.target.value })} />}</Field>
            <Field label="Appeal filed?">{() => <Segmented value={ap.filed} onChange={(v) => setAp({ ...ap, filed: v })} options={[{ value: 'undecided', label: 'Not Yet' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />}</Field>
            {ap.filed === 'yes' && (
              <>
                <Field label="Appellate court">{(id) => <CourtSelect id={id} meta={meta} value={ap.court ?? ''} other={ap.courtOther} onChange={(court, other) => setAp({ ...ap, court, courtOther: other })} />}</Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Date filed">{(id) => <Input id={id} type="date" value={ap.filedOn} onChange={(e) => setAp({ ...ap, filedOn: e.target.value })} />}</Field>
                  <Field label="Appeal no.">{(id) => <Input id={id} value={ap.appealNo ?? ''} onChange={(e) => setAp({ ...ap, appealNo: e.target.value })} />}</Field>
                </div>
              </>
            )}
            {ap.filed === 'no' && <Field label="Reason for not filing an appeal">{(id) => <Textarea id={id} rows={2} required dir="auto" value={ap.reasonNotFiled ?? ''} onChange={(e) => setAp({ ...ap, reasonNotFiled: e.target.value })} />}</Field>}
          </>
        )}
        <FormError error={error} />
      </form>
    </LSheet>
  );
}

function StageSheet({ c, meta, onDone }: { c: Case; meta?: Meta; onDone: () => void }) {
  const sug = useSuggest().data;
  const [f, setF] = useState({ court: c.appeal.court ?? '', courtOther: c.appeal.courtOther, courtCaseNo: c.appeal.appealNo ?? '', bench: '', filedOn: iso(c.appeal.filedOn) || new Date().toISOString().slice(0, 10), nextHearing: '' });
  const [error, setError] = useState<unknown>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try { await post(`/litigation/${c._id}/appeal-stage`, { ...f, nextHearing: f.nextHearing || null }); onDone(); } catch (err) { setError(err); }
  };
  return (
    <LSheet open onClose={onDone} title={`Appeal — Stage ${c.stage + 1}`} footer={<Button form="s-form" type="submit" block>Start Appeal Stage</Button>}>
      <form id="s-form" onSubmit={save} className="space-y-3">
        <p className="text-sm text-slate-600 dark:text-slate-300">The decision of the current court is kept in the court history. The case continues under <b>{c.caseId}</b> in the appellate court.</p>
        <Field label="Appellate court">{(id) => <CourtSelect id={id} meta={meta} value={f.court} other={f.courtOther} onChange={(court, other) => setF({ ...f, court, courtOther: other })} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Appeal / case no.">{(id) => <Input id={id} value={f.courtCaseNo} onChange={(e) => setF({ ...f, courtCaseNo: e.target.value })} />}</Field>
          <Field label="Date filed">{(id) => <Input id={id} type="date" required value={f.filedOn} onChange={(e) => setF({ ...f, filedOn: e.target.value })} />}</Field>
        </div>
        <Field label="Bench / station (optional)">{(id) => <AutoInput id={id} options={sug?.bench ?? []} value={f.bench} onChange={(v) => setF({ ...f, bench: v })} />}</Field>
        <Field label="Next hearing (optional)">{(id) => <Input id={id} type="date" value={f.nextHearing} onChange={(e) => setF({ ...f, nextHearing: e.target.value })} />}</Field>
        <FormError error={error} />
      </form>
    </LSheet>
  );
}

/* ---------- Attach: camera pages (compressed on the phone) or a PDF / image file ---------- */
const readB64 = (blob: Blob) => new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.readAsDataURL(blob); });

/** Resize to ≤1600 px, grayscale unless colour is kept, JPEG ~0.6 → about 120–250 KB per page. */
async function compress(file: File, colour: boolean): Promise<{ blob: Blob; url: string }> {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d')!;
  if (!colour) ctx.filter = 'grayscale(1) contrast(1.15)';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((ok) => canvas.toBlob((b) => ok(b!), 'image/jpeg', 0.6));
  return { blob, url: URL.createObjectURL(blob) };
}

function DocSheet({ c, meta, onDone }: { c: Case; meta?: Meta; onDone: () => void }) {
  const toast = useToast();
  const cam = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState('plaint');
  const [title, setTitle] = useState('');
  const [docDate, setDocDate] = useState('');
  const [colour, setColour] = useState(false);
  const [pages, setPages] = useState<{ blob: Blob; url: string }[]>([]);
  const [pdf, setPdf] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const addPhotos = async (files: FileList | null) => {
    if (!files) return;
    const out: { blob: Blob; url: string }[] = [];
    for (const f of Array.from(files)) if (f.type.startsWith('image/')) out.push(await compress(f, colour));
    setPages((p) => [...p, ...out]);
    setPdf(null);
  };
  const move = (i: number, d: -1 | 1) => setPages((p) => { const n = [...p]; const j = i + d; if (j < 0 || j >= n.length) return p; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const total = pdf ? pdf.size : pages.reduce((s, p) => s + p.blob.size, 0);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const files = pdf ? [{ name: pdf.name, mime: 'application/pdf', data: await readB64(pdf) }] : await Promise.all(pages.map(async (p, i) => ({ name: `page-${i + 1}.jpg`, mime: 'image/jpeg', data: await readB64(p.blob) })));
      await post(`/litigation/${c._id}/docs`, { category, title: title || undefined, docDate: docDate || null, files });
      toast('Document attached');
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <LSheet open onClose={onDone} title={`Attach Document · ${c.caseId}`} footer={<Button block disabled={!pages.length && !pdf} loading={busy} onClick={save}><Upload className="size-4" />Attach{pages.length > 1 ? ` (${pages.length} pages)` : ''}</Button>}>
      <div className="space-y-3">
        <Field label="Document">{(id) => <Select id={id} value={category} onChange={(e) => setCategory(e.target.value)}>{meta?.categories.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</Select>}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Title (optional)">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Order dated…" />}</Field>
          <Field label="Date (optional)">{(id) => <Input id={id} type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="secondary" onClick={() => cam.current?.click()}><Camera className="size-4" />Camera / Photos</Button>
          <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg text-sm font-medium ring-1 ring-slate-200 hover:bg-slate-50 dark:ring-slate-700">
            <FileText className="size-4" />PDF File<input type="file" accept="application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setPdf(f); setPages([]); } }} />
          </label>
        </div>
        <input ref={cam} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => { addPhotos(e.target.files); e.target.value = ''; }} />
        <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" className="size-4 accent-brand-600" checked={colour} onChange={(e) => setColour(e.target.checked)} />Keep colour (for maps / coloured documents)</label>
        {pdf && <Card className="flex items-center gap-2 p-3 text-sm"><FileText className="size-4 text-rose-600" />{pdf.name}<span className="ml-auto text-xs text-slate-500">{Math.round(pdf.size / 1024)} KB</span></Card>}
        {!!pages.length && (
          <div>
            <div className="mb-1 text-xs text-slate-500">{pages.length} page(s) · {Math.round(total / 1024)} KB total — take more photos to add pages; arrange the order below</div>
            <div className="grid grid-cols-3 gap-2">
              {pages.map((p, i) => (
                <div key={p.url} className="relative overflow-hidden rounded-lg ring-1 ring-slate-200">
                  <img src={p.url} alt={`Page ${i + 1}`} className="h-28 w-full object-cover" />
                  <div className="absolute inset-x-0 bottom-0 flex justify-between bg-black/55 px-1 text-[11px] text-white">
                    <button onClick={() => move(i, -1)}>◀</button><span>{i + 1}</span><button onClick={() => move(i, 1)}>▶</button>
                  </div>
                  <button className="absolute right-1 top-1 rounded bg-black/55 p-0.5 text-white" onClick={() => setPages((x) => x.filter((_, j) => j !== i))}><X className="size-3" /></button>
                </div>
              ))}
              <button onClick={() => cam.current?.click()} className="grid h-28 place-items-center rounded-lg border-2 border-dashed border-slate-300 text-slate-400"><ImageIcon className="size-6" /></button>
            </div>
          </div>
        )}
        <FormError error={error} />
      </div>
    </LSheet>
  );
}
