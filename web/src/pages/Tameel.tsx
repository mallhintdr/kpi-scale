/**
 * Tameel / Tasks — information requests in the government's Excel format.
 *   /tameel        list (assignees: what they must fill; admins: everything + New Tameel)
 *   /tameel/:id    instructions, deadline, my sheet(s); admins: progress per unit, review, Excel files
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CalendarClock, Check, ClipboardList, Download, FileSpreadsheet, Pencil, Plus, Save, Send, Trash2, Undo2, Upload, X } from 'lucide-react';
import { Fragment, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../components/AppShell';
import { UnitField } from '../components/rev';
import { Badge, Button, Card, Empty, ErrorState, Field, FormError, Input, Loading, SectionTitle, Select, Sheet, Textarea, useToast } from '../components/ui';
import { del, download, get, patch, post, put } from '../lib/api';
import { getOrg, useCaps, type UnitRef } from '../lib/rev';

interface Col { key: string; label: string }
interface Mine { unitId: string; unitName: string; status: string; rows: number }
interface TameelRow {
  _id: string; title: string; description: string; deadline: string; status: 'open' | 'closed'; columns: Col[]; posts: string[];
  unitId: { _id: string; name: string; type: string } | null; counts: Record<string, number>; mine: Mine[];
}
interface Progress { unitId: string; unitName: string; group?: string; groupId?: string; holders: string[]; status: string; rows: number; submittedAt?: string; returnNote?: string }
interface Detail extends Omit<TameelRow, 'counts' | 'mine'> { admin: boolean; progress: Progress[]; files: { _id: string; groupId: { _id: string; name: string }; name: string; rows: number; builtAt: string }[]; createdBy?: { name: string } }
interface Row { _id: string; values: Record<string, string>; updatedAt?: string }
interface SheetData { tameel: Detail; unit: { _id: string; name: string; type: string }; sheet: { _id: string; status: string; rows: Row[]; returnNote?: string; submittedAt?: string; history: { at: string; action: string; note?: string }[] }; access: 'admin' | 'holder'; canEdit: boolean }

const STATUS: Record<string, { label: string; tone: string }> = {
  'not started': { label: 'Not Started', tone: 'bg-slate-100 text-slate-600' },
  draft: { label: 'In Progress', tone: 'bg-sky-100 text-sky-800' },
  submitted: { label: 'Submitted', tone: 'bg-amber-100 text-amber-800' },
  returned: { label: 'Returned', tone: 'bg-rose-100 text-rose-800' },
  accepted: { label: 'Accepted', tone: 'bg-emerald-100 text-emerald-800' },
};
const StatusBadge = ({ s }: { s: string }) => <Badge tone={STATUS[s]?.tone}>{STATUS[s]?.label ?? s}</Badge>;

function Due({ deadline }: { deadline: string }) {
  const d = new Date(deadline);
  const days = Math.ceil((d.getTime() - Date.now()) / 86_400_000);
  const late = days < 0;
  return (
    <span className={clsx('inline-flex items-center gap-1 text-xs font-medium', late ? 'text-rose-700' : days <= 2 ? 'text-amber-700' : 'text-slate-600')}>
      <CalendarClock className="size-3.5" />Due {d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
      {late ? ` · ${-days} day(s) overdue` : days === 0 ? ' · today' : ` · ${days} day(s) left`}
    </span>
  );
}

/* ================================================================== *
 *  List
 * ================================================================== */
export function TameelList() {
  const caps = useCaps();
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['tameel'], queryFn: () => get<TameelRow[]>('/tameel') });
  return (
    <>
      <PageHeader title="Tameel / Tasks" subtitle="Information requested in the prescribed format" actions={caps.isAdmin && <Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" />New Tameel</Button>} />
      {isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : !data?.length ? (
        <Card><Empty icon={ClipboardList} title="No Tameel" body={caps.isAdmin ? 'Upload the Excel format received from the government to request the information.' : 'Nothing is pending for you.'} /></Card>
      ) : (
        <div className="grid gap-2 lg:grid-cols-2">
          {data.map((t) => (
            <Link key={t._id} to={`/tameel/${t._id}`}>
              <Card className={clsx('h-full p-4 transition hover:ring-brand-200', t.status === 'closed' && 'opacity-60')}>
                <div className="flex items-start gap-3">
                  <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700"><FileSpreadsheet className="size-5" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{t.title}</div>
                    <Due deadline={t.deadline} />
                    <p className="mt-1 line-clamp-2 text-xs text-slate-600 dark:text-slate-300">{t.description}</p>
                  </div>
                  {t.status === 'closed' && <Badge>Closed</Badge>}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                  {caps.isAdmin ? (
                    <>
                      <span className="text-slate-500">{t.unitId?.name} · {t.columns.length} columns ·</span>
                      <Badge tone={STATUS.submitted.tone}>{t.counts.submitted ?? 0} submitted</Badge>
                      <Badge tone={STATUS.accepted.tone}>{t.counts.accepted ?? 0} accepted</Badge>
                      {!!t.counts.returned && <Badge tone={STATUS.returned.tone}>{t.counts.returned} returned</Badge>}
                    </>
                  ) : t.mine.map((m) => <span key={m.unitId} className="flex items-center gap-1">{m.unitName}: <StatusBadge s={m.status} /></span>)}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
      {creating && <CreateSheet onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const caps = useCaps();
  const posts = getOrg()?.posts ?? [];
  const levels = getOrg()?.levels ?? [];
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [cols, setCols] = useState<Col[]>([]);
  const [info, setInfo] = useState<string>('');
  const [f, setF] = useState({ title: '', description: '', deadline: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), posts: ['patwari'].filter((p) => posts.some((x) => x.key === p)), groupLevel: levels.some((l) => l.key === 'tehsil') ? 'tehsil' : levels[1]?.key ?? '' });
  const [area, setArea] = useState<UnitRef | null>(caps.browseRoots[0] ?? null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const onFile = async (fl?: File) => {
    if (!fl) return;
    setError(null);
    const data = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.readAsDataURL(fl); });
    try {
      const res = await post<{ columns: Col[]; sheet: string; dataRows: number }>('/tameel/parse', { file: data, name: fl.name });
      setFile({ name: fl.name, data });
      setCols(res.columns);
      setInfo(`Sheet "${res.sheet}": ${res.columns.length} columns found.${res.dataRows ? ' Only the header row is used — staff fill in the rows.' : ''}`);
      if (!f.title) setF((x) => ({ ...x, title: fl.name.replace(/\.xlsx?$/i, '') }));
    } catch (e) {
      setError(e);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await post<{ _id: string }>('/tameel', { ...f, deadline: new Date(`${f.deadline}T23:59:59`).toISOString(), columns: cols, unitId: area?._id, sourceFile: file?.name });
      qc.invalidateQueries({ queryKey: ['tameel'] });
      toast('Tameel issued — everyone concerned has been notified');
      navigate(`/tameel/${t._id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title="New Tameel" footer={<Button form="tameel-form" type="submit" block disabled={!cols.length || !area || !f.posts.length} loading={busy}><Send className="size-4" />Issue Tameel</Button>}>
      <form id="tameel-form" onSubmit={submit} className="space-y-4">
        <Field label="Excel format (.xlsx)">
          {() => (
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border-2 border-dashed border-slate-300 p-3 hover:border-brand-400">
              <Upload className="size-5 text-brand-600" />
              <span className="text-sm">{file?.name ?? 'Choose the Excel file received'}</span>
              <input type="file" accept=".xlsx" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
          )}
        </Field>
        {info && <p className="text-xs text-slate-500">{info}</p>}
        {cols.length > 0 && (
          <Field label="Columns" hint="Rename or remove columns if needed">
            {() => (
              <div className="space-y-1.5">
                {cols.map((c, i) => (
                  <div key={c.key} className="flex gap-1.5">
                    <span className="grid w-8 place-items-center text-xs text-slate-400">{i + 1}</span>
                    <Input value={c.label} onChange={(e) => setCols(cols.map((x) => (x.key === c.key ? { ...x, label: e.target.value } : x)))} />
                    <Button type="button" variant="ghost" onClick={() => setCols(cols.filter((x) => x.key !== c.key))}><X className="size-4" /></Button>
                  </div>
                ))}
              </div>
            )}
          </Field>
        )}
        <Field label="Title">{(id) => <Input id={id} required minLength={3} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. State land under encroachment" />}</Field>
        <Field label="Description / instructions" hint="Shown to everyone who must fill it in">{(id) => <Textarea id={id} required minLength={10} rows={5} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="What information is required, in what units, any references…" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Deadline">{(id) => <Input id={id} type="date" required value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} />}</Field>
          <Field label="Combine files by">{(id) => <Select id={id} value={f.groupLevel} onChange={(e) => setF({ ...f, groupLevel: e.target.value })}>{levels.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}</Select>}</Field>
        </div>
        <Field label="Area" hint="Everyone holding the posts below inside this area must submit">{() => <UnitField value={area} onChange={setArea} />}</Field>
        <Field label="To be filled by">
          {() => (
            <div className="flex flex-wrap gap-1.5">
              {posts.map((p) => (
                <button type="button" key={p.key} onClick={() => setF({ ...f, posts: f.posts.includes(p.key) ? f.posts.filter((x) => x !== p.key) : [...f.posts, p.key] })}
                  className={clsx('rounded-full px-2.5 py-1 text-xs font-medium ring-1', f.posts.includes(p.key) ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 dark:bg-slate-900')}>{p.label}</button>
              ))}
            </div>
          )}
        </Field>
        <FormError error={error} />
      </form>
    </Sheet>
  );
}

/* ================================================================== *
 *  Detail
 * ================================================================== */
export function TameelDetail() {
  const { id } = useParams();
  const [openUnit, setOpenUnit] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['tameel', id], queryFn: () => get<Detail>(`/tameel/${id}`) });
  const toast = useToast();
  const qc = useQueryClient();
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} retry={refetch} />;
  const t = data!;
  const mine = t.admin ? [] : t.progress;
  const unit = openUnit ?? (mine.length === 1 ? mine[0].unitId : null);
  const close = async () => {
    await patch(`/tameel/${t._id}`, { status: t.status === 'open' ? 'closed' : 'open' });
    qc.invalidateQueries({ queryKey: ['tameel'] });
    toast(t.status === 'open' ? 'Tameel closed' : 'Tameel reopened');
  };
  const remove = async () => {
    if (!confirm(`Delete "${t.title}" and every submission? This cannot be undone.`)) return;
    await del(`/tameel/${t._id}`);
    qc.invalidateQueries({ queryKey: ['tameel'] });
    history.back();
  };
  const totals = t.progress.reduce((a, p) => ({ ...a, [p.status]: (a[p.status] ?? 0) + 1 }), {} as Record<string, number>);

  return (
    <>
      <PageHeader title={t.title} back="/tameel" subtitle={<Due deadline={t.deadline} />}
        actions={t.admin && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => download(`/tameel/${t._id}/export`, `${t.title} - all.xlsx`)}><Download className="size-4" />All (Excel)</Button>
            <Button size="sm" variant="ghost" onClick={close}>{t.status === 'open' ? 'Close' : 'Reopen'}</Button>
            <Button size="sm" variant="ghost" className="text-rose-600" onClick={remove}><Trash2 className="size-4" /></Button>
          </div>
        )} />

      <Card className="mb-3 border-l-4 border-gold-500 p-4">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Instructions</div>
        <p className="whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100">{t.description}</p>
        <div className="mt-2 text-xs text-slate-500">{t.unitId?.name} · {t.columns.length} columns{t.createdBy && ` · issued by ${t.createdBy.name}`}{t.status === 'closed' && ' · CLOSED'}</div>
      </Card>

      {t.admin && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {['not started', 'draft', 'submitted', 'returned', 'accepted'].map((s) => (
              <Card key={s} className="p-3"><div className="text-xl font-bold tabular-nums">{totals[s] ?? 0}</div><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{STATUS[s].label}</div></Card>
            ))}
          </div>
          {!!t.files.length && (
            <>
              <SectionTitle>Combined Excel Files (Kept on the Server)</SectionTitle>
              <Card className="mb-3 divide-y divide-slate-100 dark:divide-slate-800">
                {t.files.map((f) => (
                  <div key={f._id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <FileSpreadsheet className="size-5 text-emerald-600" />
                    <div className="min-w-0 flex-1"><b>{f.groupId?.name}</b><div className="text-xs text-slate-500">{f.rows} rows · updated {new Date(f.builtAt).toLocaleString()}</div></div>
                    <Button size="sm" variant="secondary" onClick={() => download(`/tameel/${t._id}/files/${f.groupId._id}`, f.name)}><Download className="size-4" />Excel</Button>
                  </div>
                ))}
              </Card>
            </>
          )}
          <SectionTitle>Submissions</SectionTitle>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-separate border-spacing-0 text-[13px]">
              <thead className="bg-brand-700 text-center text-[12.5px] text-white">
                <tr>{['#', 'Group', 'Unit', 'Filled By', 'Rows', 'Status', 'Submitted', ''].map((h) => <th key={h} className="border-b border-r border-white/50 px-3 py-2">{h}</th>)}</tr>
              </thead>
              <tbody>
                {t.progress.map((p, i) => (
                  <tr key={p.unitId} className={clsx('cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60', unit === p.unitId && 'bg-amber-50')} onClick={() => setOpenUnit(p.unitId)}>
                    <td className="border-b border-r border-slate-200 px-2 py-1.5 text-center text-xs text-slate-500">{i + 1}</td>
                    <td className="border-b border-r border-slate-200 px-3 py-1.5">{p.group}</td>
                    <td className="border-b border-r border-slate-200 px-3 py-1.5 font-medium">{p.unitName}</td>
                    <td className="border-b border-r border-slate-200 px-3 py-1.5 text-xs">{p.holders.join(', ') || <span className="text-amber-600">Vacant</span>}</td>
                    <td className="border-b border-r border-slate-200 px-3 py-1.5 text-center tabular-nums">{p.rows}</td>
                    <td className="border-b border-r border-slate-200 px-3 py-1.5 text-center"><StatusBadge s={p.status} /></td>
                    <td className="border-b border-r border-slate-200 px-3 py-1.5 text-center text-xs">{p.submittedAt ? new Date(p.submittedAt).toLocaleString() : '—'}</td>
                    <td className="border-b border-slate-200 px-2 py-1.5 text-center"><Pencil className="mx-auto size-4 text-slate-400" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {!t.admin && mine.length > 1 && (
        <Card className="mb-3 flex flex-wrap gap-2 p-3">
          {mine.map((m) => (
            <Button key={m.unitId} size="sm" variant={unit === m.unitId ? 'primary' : 'secondary'} onClick={() => setOpenUnit(m.unitId)}>{m.unitName} <StatusBadge s={m.status} /></Button>
          ))}
        </Card>
      )}
      {unit && <SheetEditor tameelId={t._id} unitId={unit} key={unit} />}
    </>
  );
}

/* ---------- One unit's sheet: rows with Edit / Save / Delete ---------- */
function SheetEditor({ tameelId, unitId }: { tameelId: string; unitId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['tameel', tameelId, 'sheet', unitId];
  const { data, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => get<SheetData>(`/tameel/${tameelId}/sheet/${unitId}`) });
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} retry={refetch} />;
  const { tameel: t, sheet, canEdit, access, unit } = data!;
  const refresh = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['tameel', tameelId] }); qc.invalidateQueries({ queryKey: ['tameel'] }); };
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try { await fn(); toast(msg); refresh(); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const startEdit = (r?: Row) => { setEditing(r?._id ?? 'new'); setDraft(r ? { ...r.values } : {}); };
  const saveRow = () => act(async () => { await put(`/tameel/${tameelId}/sheet/${unitId}/rows${editing === 'new' ? '' : `/${editing}`}`, { values: draft }); setEditing(null); }, 'Row saved');
  const delRow = (r: Row) => confirm('Delete this row?') && act(() => del(`/tameel/${tameelId}/sheet/${unitId}/rows/${r._id}`), 'Row deleted');
  const submit = () => confirm(`Submit ${sheet.rows.length} row(s) for ${unit.name}? You cannot change them after submitting unless the administrator returns the sheet.`) && act(() => post(`/tameel/${tameelId}/sheet/${unitId}/submit`), 'Submitted — thank you');
  const review = (action: 'return' | 'accept') => {
    const note = action === 'return' ? prompt('What needs to be corrected? (sent to the patwari)') : undefined;
    if (action === 'return' && !note) return;
    act(() => post(`/tameel/${tameelId}/sheet/${unitId}/review`, { action, note }), action === 'return' ? 'Returned for correction' : 'Accepted');
  };
  const cell = 'border-b border-r border-slate-200 px-2 py-1.5 align-top dark:border-slate-700';
  const editRow = (
    <tr className="bg-amber-50 dark:bg-amber-500/10">
      <td className={clsx(cell, 'text-center text-xs text-slate-500')}>{editing === 'new' ? 'New' : ''}</td>
      {t.columns.map((c) => <td key={c.key} className={cell}><Input className="min-w-[8rem]" value={draft[c.key] ?? ''} onChange={(e) => setDraft({ ...draft, [c.key]: e.target.value })} /></td>)}
      <td className={clsx(cell, 'whitespace-nowrap')}>
        <div className="flex gap-1"><Button size="sm" loading={busy} onClick={saveRow}><Save className="size-4" />Save</Button><Button size="sm" variant="ghost" onClick={() => setEditing(null)}><X className="size-4" /></Button></div>
      </td>
    </tr>
  );

  return (
    <>
      <SectionTitle action={<StatusBadge s={sheet.status} />}>{unit.name} · {sheet.rows.length} Row{sheet.rows.length === 1 ? '' : 's'}</SectionTitle>
      {sheet.status === 'returned' && sheet.returnNote && (
        <Card className="mb-2 border-l-4 border-rose-500 p-3 text-sm"><b className="text-rose-700">Returned for correction:</b> {sheet.returnNote}</Card>
      )}
      <Card className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="bg-brand-700 text-center text-[12.5px] text-white">
            <tr>
              <th className="w-10 border-b border-r border-white/50 px-2 py-2">#</th>
              {t.columns.map((c) => <th key={c.key} className="border-b border-r border-white/50 px-3 py-2">{c.label}</th>)}
              <th className="w-36 border-b border-white/50 px-2 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((r, i) => editing === r._id ? <Fragment key={r._id}>{editRow}</Fragment> : (
              <tr key={r._id}>
                <td className={clsx(cell, 'text-center text-xs text-slate-500')}>{i + 1}</td>
                {t.columns.map((c) => <td key={c.key} className={clsx(cell, 'text-center')}>{r.values[c.key] || <span className="text-slate-300">—</span>}</td>)}
                <td className={clsx(cell, 'whitespace-nowrap text-center')}>
                  {canEdit ? (
                    <div className="flex justify-center gap-1">
                      <Button size="sm" variant="secondary" onClick={() => startEdit(r)} disabled={!!editing}><Pencil className="size-4" />Edit</Button>
                      <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => delRow(r)} disabled={!!editing}><Trash2 className="size-4" /></Button>
                    </div>
                  ) : <span className="text-xs text-slate-400">Locked</span>}
                </td>
              </tr>
            ))}
            {editing === 'new' && editRow}
            {!sheet.rows.length && editing !== 'new' && <tr><td colSpan={t.columns.length + 2} className="p-6 text-center text-sm text-slate-500">No rows yet{canEdit ? ' — click Add Row' : ''}.</td></tr>}
          </tbody>
        </table>
      </Card>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canEdit && <Button variant="secondary" disabled={!!editing} onClick={() => startEdit()}><Plus className="size-4" />Add Row</Button>}
        <Button variant="ghost" onClick={() => download(`/tameel/${tameelId}/export?unitId=${unitId}`, `${t.title} - ${unit.name}.xlsx`)}><Download className="size-4" />Excel</Button>
        <div className="flex-1" />
        {access === 'holder' && canEdit && <Button disabled={!sheet.rows.length || !!editing} loading={busy} onClick={submit}><Send className="size-4" />Submit</Button>}
        {access === 'admin' && sheet.status !== 'not started' && (
          <>
            <Button variant="secondary" disabled={busy} onClick={() => review('return')}><Undo2 className="size-4" />Return to Patwari</Button>
            {sheet.status !== 'accepted' && <Button disabled={busy || !sheet.rows.length} onClick={() => review('accept')}><Check className="size-4" />Accept</Button>}
          </>
        )}
      </div>
      {!!sheet.history.length && (
        <p className="mt-2 text-xs text-slate-500">History: {sheet.history.map((h) => `${h.action} ${new Date(h.at).toLocaleString()}${h.note ? ` (“${h.note}”)` : ''}`).join(' · ')}</p>
      )}
    </>
  );
}
