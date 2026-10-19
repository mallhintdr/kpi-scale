/**
 * State Land entry table (/state-land/entry): one row per khasra, as in the register.
 *  - choose the mouza once; tehsil follows
 *  - "Add rows": a murabba and its killas (1-25, or 1-5, 8, 12) become rows, taking the other columns from the row above
 *  - "+ Sub" on a row adds the next sub-killa (1, 2, 3 or الف، ب، ج) below it
 *  - ⇣ on a column header fills that column down (to the ticked rows, or all)
 *  - paste a block copied from Excel into any cell; Enter moves down
 *  - Save: good rows are saved, rows with a problem stay, marked red with the reason
 * A draft is kept in this browser until it is saved.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDownToLine, ChevronLeft, Copy, Plus, Save, Trash2, X } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/AppShell';
import { Button, Card, Field, FormError, Input, Segmented, useToast } from '../components/ui';
import { get, post } from '../lib/api';
import { AutoInput } from './Litigation';

interface Meta { owners: string[]; kashtTypes: string[]; possessedBy: [string, string][]; landTypes: string[]; issues: [string, string][]; schemes: string[]; canEnter: boolean }
type Row = Record<ColKey, string> & { _err?: string };
type ColKey = 'khewat' | 'khatauni' | 'murabba' | 'killa' | 'subKilla' | 'kanal' | 'marla' | 'feet' | 'landType' | 'ownerRecord' | 'scheme' | 'cultivation' | 'possessedBy' | 'possessor' | 'issue' | 'issueNote' | 'encumbrance' | 'note';
interface Col { k: ColKey; label: string; w: string; num?: boolean; list?: 'landTypes' | 'owners' | 'schemes' | 'kashtTypes'; select?: 'possessedBy' | 'issues'; fill?: boolean }

const COLS: Col[] = [
  { k: 'khewat', label: 'Khewat', w: 'w-16', fill: true },
  { k: 'khatauni', label: 'Khatauni', w: 'w-16', fill: true },
  { k: 'murabba', label: 'Murabba / Mustateel', w: 'w-16', fill: true },
  { k: 'killa', label: 'Killa', w: 'w-11', num: true },
  { k: 'subKilla', label: 'Sub', w: 'w-11' },
  { k: 'kanal', label: 'K', w: 'w-11', num: true, fill: true },
  { k: 'marla', label: 'M', w: 'w-11', num: true, fill: true },
  { k: 'feet', label: 'Ft', w: 'w-14', num: true, fill: true },
  { k: 'landType', label: 'Type of Land', w: 'w-36', list: 'landTypes', fill: true },
  { k: 'ownerRecord', label: 'Ownership', w: 'w-44', list: 'owners', fill: true },
  { k: 'scheme', label: 'Scheme', w: 'w-32', list: 'schemes', fill: true },
  { k: 'cultivation', label: 'Cultivation (Khana Kasht)', w: 'w-44', list: 'kashtTypes', fill: true },
  { k: 'possessedBy', label: 'Physical Position', w: 'w-36', select: 'possessedBy', fill: true },
  { k: 'possessor', label: 'Possessor Name', w: 'w-32', fill: true },
  { k: 'issue', label: 'Litigation / Encroachment', w: 'w-32', select: 'issues', fill: true },
  { k: 'issueNote', label: 'Litigation / Encroachment Note', w: 'w-40', fill: true },
  { k: 'encumbrance', label: 'Encumbrance', w: 'w-32', fill: true },
  { k: 'note', label: 'Note', w: 'w-40', fill: true },
];
const blankRow = (): Row => Object.fromEntries(COLS.map((c) => [c.k, c.k === 'issue' ? 'none' : ''])) as Row;
const MARLA = 272.25;
const sqft = (r: Row) => ((Number(r.kanal) || 0) * 20 + (Number(r.marla) || 0)) * MARLA + (Number(r.feet) || 0);
const URDU_SUBS = ['الف', 'ب', 'ج', 'د', 'ہ', 'و', 'ز', 'ح', 'ط', 'ی', 'ک', 'ل', 'م', 'ن'];
const subName = (style: 'num' | 'urdu', i: number) => (style === 'urdu' ? URDU_SUBS[i] ?? String(i + 1) : String(i + 1));
/** "1-25" or "1-5, 8, 12" → [1 … 25] (only 1–25). */
const parseKillas = (spec: string) => {
  const out = new Set<number>();
  for (const part of spec.split(/[,\s]+/).filter(Boolean)) {
    const [a, b] = part.split('-').map((x) => parseInt(x, 10));
    if (Number.isNaN(a)) continue;
    for (let k = a; k <= (Number.isNaN(b) ? a : b); k++) if (k >= 1 && k <= 25) out.add(k);
  }
  return [...out].sort((x, y) => x - y);
};
const DRAFT = 'sl-entry-draft';

export default function StateLandEntry() {
  const qc = useQueryClient();
  const toast = useToast();
  const meta = useQuery({ queryKey: ['sl', 'meta'], queryFn: () => get<Meta>('/state-land/meta'), staleTime: 300_000 });
  const m = meta.data;
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem(DRAFT) ?? 'null'); } catch { return null; } }, []);
  const [mouza, setMouza] = useState<{ id: string; name: string; tehsil?: string }>(saved?.mouza ?? { id: '', name: '' });
  const [rows, setRows] = useState<Row[]>(saved?.rows?.length ? saved.rows : [blankRow()]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [style, setStyle] = useState<'num' | 'urdu'>(saved?.style ?? 'num');
  const [gen, setGen] = useState({ murabba: '', killas: '1-25', khewat: '', khatauni: '' });
  const [mq, setMq] = useState('');
  const mterm = useDeferredValue(mq);
  const mouzas = useQuery({ queryKey: ['sl', 'mouzas', mterm], queryFn: () => get<{ _id: string; name: string; tehsil?: string }[]>(`/state-land/mouzas?search=${encodeURIComponent(mterm)}`) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Keep a draft in this browser until it is saved
  useEffect(() => { try { localStorage.setItem(DRAFT, JSON.stringify({ mouza, rows, style })); } catch { /* storage unavailable */ } }, [mouza, rows, style]);

  const total = rows.reduce((s, r) => s + sqft(r), 0);
  const filled = rows.filter((r) => r.murabba || r.killa).length;
  const setCell = (i: number, k: ColKey, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v, _err: undefined } : r)));
  const targets = () => (sel.size ? [...sel] : rows.map((_, i) => i));

  /** Murabba + killas → rows (other columns copied from the last row). */
  const addRows = () => {
    const ks = parseKillas(gen.killas);
    if (!gen.murabba.trim() || !ks.length) return toast('Enter the murabba no. and killas, e.g. 1-25 or 1-5, 8', 'error');
    const lastRow = [...rows].reverse().find((r) => r.murabba || r.killa) ?? blankRow();
    const base = { ...lastRow, _err: undefined, subKilla: '', kanal: lastRow.kanal || '8', marla: lastRow.marla, feet: lastRow.feet, khewat: gen.khewat || lastRow.khewat, khatauni: gen.khatauni || lastRow.khatauni };
    const fresh = ks.map((k) => ({ ...base, murabba: gen.murabba.trim(), killa: String(k) }));
    setRows((rs) => [...rs.filter((r) => r.murabba || r.killa || r.ownerRecord), ...fresh]);
    setGen({ ...gen, murabba: '' });
  };
  /** Next sub-killa of this row's killa, inserted below it. */
  const addSub = (i: number) => setRows((rs) => {
    const r = rs[i];
    const same = rs.filter((x) => x.murabba === r.murabba && x.killa === r.killa);
    const used = new Set(same.map((x) => x.subKilla).filter(Boolean));
    const next = () => { let n = 0; while (used.has(subName(style, n))) n++; const v = subName(style, n); used.add(v); return v; };
    const out = [...rs];
    if (!r.subKilla) out[i] = { ...r, subKilla: next(), kanal: '', marla: '', feet: '' };
    const lastOfKilla = out.reduce((a, x, j) => (x.murabba === r.murabba && x.killa === r.killa ? j : a), i);
    out.splice(lastOfKilla + 1, 0, { ...out[i], subKilla: next(), kanal: '', marla: '', feet: '', _err: undefined });
    return out;
  });
  const fillDown = (k: ColKey) => {
    const t = targets();
    const v = rows[t[0]]?.[k] ?? '';
    setRows((rs) => rs.map((r, j) => (t.includes(j) ? { ...r, [k]: v } : r)));
    toast(`${COLS.find((c) => c.k === k)?.label} filled into ${t.length} row(s)`);
  };
  const duplicate = (i: number) => setRows((rs) => [...rs.slice(0, i + 1), { ...rs[i], killa: '', subKilla: '', _err: undefined }, ...rs.slice(i + 1)]);
  const removeRows = (idx: number[]) => { setRows((rs) => { const left = rs.filter((_, j) => !idx.includes(j)); return left.length ? left : [blankRow()]; }); setSel(new Set()); };

  /** Paste a block copied from Excel, starting at the cell pasted into. */
  const onPaste = (e: ClipboardEvent<HTMLElement>, r0: number, c0: number) => {
    const text = e.clipboardData.getData('text');
    if (!/[\t\n]/.test(text)) return;
    e.preventDefault();
    const lines = text.replace(/\r/g, '').split('\n').filter((l, i, a) => l.length || i < a.length - 1);
    setRows((rs) => {
      const out = [...rs];
      lines.forEach((line, i) => {
        const cells = line.split('\t');
        const ri = r0 + i;
        while (out.length <= ri) out.push(blankRow());
        const row = { ...out[ri], _err: undefined };
        cells.forEach((v, j) => {
          const col = COLS[c0 + j];
          if (!col) return;
          let val = v.trim();
          if (col.select === 'possessedBy') val = m?.possessedBy.find(([k, l]) => k === val || l.toLowerCase() === val.toLowerCase())?.[0] ?? val;
          if (col.select === 'issues') val = m?.issues.find(([k, l]) => k === val || l.toLowerCase() === val.toLowerCase())?.[0] ?? (val ? 'none' : 'none');
          (row as any)[col.k] = val;
        });
        out[ri] = row;
      });
      return out;
    });
    toast(`${lines.length} row(s) pasted`);
  };
  const onKey = (e: KeyboardEvent<HTMLElement>, r: number, c: number) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (r === rows.length - 1) setRows((rs) => [...rs, { ...blankRow(), murabba: rs[r].murabba, khewat: rs[r].khewat, khatauni: rs[r].khatauni }]);
    setTimeout(() => (document.querySelector(`[data-cell="${r + 1}-${c}"]`) as HTMLElement | null)?.focus(), 0);
  };

  const save = async () => {
    setError(null);
    if (!mouza.id) return setError(new Error('Choose the mouza first'));
    const idx = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.murabba || r.killa || r.ownerRecord);
    if (!idx.length) return setError(new Error('Add at least one row'));
    setBusy(true);
    try {
      const payload = idx.map(({ r }) => ({
        khewat: r.khewat || undefined, khatauni: r.khatauni || undefined, murabba: r.murabba, killa: Number(r.killa), subKilla: r.subKilla,
        area: { kanal: r.kanal ? Number(r.kanal) : undefined, marla: r.marla ? Number(r.marla) : undefined, feet: r.feet ? Number(r.feet) : undefined },
        landType: r.landType, ownerRecord: r.ownerRecord, scheme: r.scheme || undefined, cultivation: r.cultivation, possessedBy: r.possessedBy, possessor: r.possessor || undefined,
        issue: r.issue || 'none', issueNote: r.issueNote || undefined, encumbrance: r.encumbrance || undefined, note: r.note || undefined,
      }));
      const res = await fetchRows(mouza.id, payload);
      const savedIdx = new Set(res.savedRows.map((j) => idx[j].i));
      const errs = new Map(res.errors.map((e) => [idx[e.row].i, e.message]));
      setRows((rs) => { const left = rs.map((r, i) => ({ ...r, _err: errs.get(i) })).filter((_, i) => !savedIdx.has(i)); return left.length ? left : [blankRow()]; });
      setSel(new Set());
      qc.invalidateQueries({ queryKey: ['sl'] });
      toast(res.created ? `${res.created} khasra(s) saved · ${res.acres.toFixed(2)} acres${res.errors.length ? ` · ${res.errors.length} row(s) need correction (red)` : ''}` : `Nothing saved — ${res.errors.length} row(s) need correction (red)`, res.created ? 'ok' : 'error');
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const listOf = (c: Col) => (c.list ? m?.[c.list] ?? [] : []);
  return (
    <>
      <PageHeader title="Enter State Land" subtitle="One row per khasra, as in the register — paste from Excel, fill down, add murabbas in one go" actions={
        <Link to="/state-land"><Button size="sm" variant="ghost"><ChevronLeft className="size-4" />Directory</Button></Link>
      } />
      <Card className="mb-2 grid gap-3 p-3 lg:grid-cols-[minmax(16rem,1fr)_auto]">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Mouza">{(id) => <AutoInput id={id} strict placeholder="Type mouza name…" onQuery={setMq} value={mouza.id}
            options={[...(mouza.id ? [{ value: mouza.id, label: mouza.name, hint: mouza.tehsil }] : []), ...(mouzas.data ?? []).filter((x) => x._id !== mouza.id).map((x) => ({ value: x._id, label: x.name, hint: x.tehsil }))]}
            onChange={(v) => { const x = mouzas.data?.find((y) => y._id === v); setMouza({ id: v, name: x?.name ?? mouza.name, tehsil: x?.tehsil ?? mouza.tehsil }); }} />}</Field>
          <div className="pb-2 text-sm text-slate-600 dark:text-slate-300">Tehsil: <b>{mouza.tehsil ?? '—'}</b></div>
        </div>
        <div className="flex flex-wrap items-end gap-2 rounded-lg bg-brand-50 p-2 dark:bg-brand-900/30">
          <Field label="Murabba / Mustateel">{(id) => <Input id={id} className="!w-24" value={gen.murabba} onChange={(e) => setGen({ ...gen, murabba: e.target.value })} placeholder="45" onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addRows())} />}</Field>
          <Field label="Killas">{(id) => <Input id={id} className="!w-32" value={gen.killas} onChange={(e) => setGen({ ...gen, killas: e.target.value })} placeholder="1-25 or 1-5, 8" />}</Field>
          <Field label="Khewat">{(id) => <Input id={id} className="!w-20" value={gen.khewat} onChange={(e) => setGen({ ...gen, khewat: e.target.value })} placeholder="as above" />}</Field>
          <Field label="Khatauni">{(id) => <Input id={id} className="!w-20" value={gen.khatauni} onChange={(e) => setGen({ ...gen, khatauni: e.target.value })} placeholder="as above" />}</Field>
          <Button onClick={addRows}><Plus className="size-4" />Add Rows</Button>
        </div>
      </Card>

      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm print:hidden">
        <span className="text-slate-600 dark:text-slate-300"><b>{filled}</b> row(s) · <b>{(total / 43_560).toFixed(2)}</b> acres</span>
        <span className="flex items-center gap-1.5 text-xs">Sub-killa: <Segmented value={style} onChange={setStyle} options={[{ value: 'num', label: '1, 2, 3' }, { value: 'urdu', label: <span className="whitespace-nowrap" dir="rtl">الف، ب، ج</span> }]} /></span>
        <Button size="sm" variant="secondary" onClick={() => setRows((rs) => [...rs, { ...blankRow(), murabba: rs[rs.length - 1]?.murabba ?? '', khewat: rs[rs.length - 1]?.khewat ?? '', khatauni: rs[rs.length - 1]?.khatauni ?? '' }])}><Plus className="size-4" />Row</Button>
        {sel.size > 0 && <Button size="sm" variant="secondary" onClick={() => removeRows([...sel])}><Trash2 className="size-4" />Delete {sel.size} selected</Button>}
        <Button size="sm" variant="ghost" onClick={() => { if (confirm('Clear the whole table?')) { setRows([blankRow()]); setSel(new Set()); } }}><X className="size-4" />Clear</Button>
        <span className="text-xs text-slate-500">⇣ fills a column down {sel.size ? `to the ${sel.size} ticked rows` : 'to all rows'} · paste from Excel into any cell · Enter = next row</span>
        <Button className="ml-auto" loading={busy} onClick={save}><Save className="size-4" />{filled ? `Save ${filled} ${filled === 1 ? 'Row' : 'Rows'}` : 'Save'}</Button>
      </div>
      <FormError error={error} />

      {COLS.filter((c) => c.list).map((c) => <datalist key={c.k} id={`dl-${c.k}`}>{listOf(c).map((x) => <option key={x} value={x} />)}</datalist>)}
      <Card className="overflow-x-auto">
        <table className="border-separate border-spacing-0 text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-brand-700 text-center text-[11.5px] text-white">
            <tr>
              <th className="sticky left-0 z-20 border-b border-r border-white/50 bg-brand-700 px-2 py-1.5">Khasra</th>
              <th className="border-b border-r border-white/50 px-1 py-1.5"><input type="checkbox" className="size-4 accent-white" aria-label="Select all" checked={sel.size === rows.length && rows.length > 0} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((_, i) => i)) : new Set())} /></th>
              <th className="border-b border-r border-white/50 px-1 py-1.5">#</th>
              {COLS.map((c) => (
                <th key={c.k} className="border-b border-r border-white/50 px-1 py-1.5 font-semibold leading-tight">
                  <div className="flex items-center justify-center gap-0.5">
                    <span>{c.label}</span>
                    {c.fill && <button type="button" title={`Fill ${c.label} down`} onClick={() => fillDown(c.k)} className="rounded p-0.5 text-white/80 hover:bg-white/20 hover:text-white"><ArrowDownToLine className="size-3" /></button>}
                  </div>
                </th>
              ))}
              <th className="border-b border-white/50 px-1 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={clsx(r._err && 'bg-rose-50 dark:bg-rose-950/30', sel.has(i) && 'bg-brand-50 dark:bg-brand-900/30', r.subKilla && 'text-slate-700')} title={r._err}>
                <td className={clsx('sticky left-0 z-10 whitespace-nowrap border-b border-r border-slate-300 px-2 font-mono text-[12px] font-semibold dark:border-slate-600', r._err ? 'bg-rose-50 text-rose-800 dark:bg-rose-950' : 'bg-white dark:bg-slate-900')} dir="ltr">{r.murabba || r.killa ? <>{r.murabba || '?'}/{r.killa || '?'}{r.subKilla && <>/<span dir="auto">{r.subKilla}</span></>}</> : <span className="text-slate-300">—</span>}</td>
                <td className="border-b border-r border-slate-200 px-1 text-center dark:border-slate-700"><input type="checkbox" className="size-4 accent-brand-600" checked={sel.has(i)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })} /></td>
                <td className={clsx('border-b border-r border-slate-200 px-1 text-center text-[11px] text-slate-500 dark:border-slate-700', r._err && 'font-bold text-rose-700')}>{i + 1}</td>
                {COLS.map((c, ci) => (
                  <td key={c.k} className="border-b border-r border-slate-200 p-0.5 dark:border-slate-700">
                    {c.select ? (
                      <select data-cell={`${i}-${ci}`} value={r[c.k]} onChange={(e) => setCell(i, c.k, e.target.value)} onKeyDown={(e) => onKey(e, i, ci)}
                        className={clsx('h-7 rounded bg-transparent px-0.5 text-[12px] outline-none ring-1 ring-transparent focus:bg-white focus:ring-brand-500 dark:focus:bg-slate-900', c.w, c.k === 'issue' && r.issue !== 'none' && 'font-semibold text-rose-700')}>
                        {c.select === 'possessedBy' && <option value="">—</option>}
                        {(m?.[c.select] ?? []).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    ) : (
                      <input data-cell={`${i}-${ci}`} value={r[c.k]} list={c.list ? `dl-${c.k}` : undefined} inputMode={c.num ? 'decimal' : undefined} dir={c.num ? 'ltr' : 'auto'}
                        onChange={(e) => setCell(i, c.k, c.num ? e.target.value.replace(/[^0-9.]/g, '') : c.k === 'subKilla' ? e.target.value.replace(/[^\p{L}\p{N}\p{M}-]/gu, '') : e.target.value)}
                        onPaste={(e) => onPaste(e, i, ci)} onKeyDown={(e) => onKey(e, i, ci)}
                        className={clsx('h-7 rounded bg-transparent px-1 text-[12.5px] outline-none ring-1 ring-transparent focus:bg-white focus:ring-brand-500 dark:focus:bg-slate-900', c.w, c.num && 'text-center tabular-nums')} />
                    )}
                  </td>
                ))}
                <td className="whitespace-nowrap border-b border-slate-200 px-1 text-[11px] dark:border-slate-700">
                  <button type="button" className="font-semibold text-brand-700 hover:underline disabled:opacity-40" disabled={!r.killa} onClick={() => addSub(i)} title="Add the next sub-killa of this killa">+ Sub</button>
                  <button type="button" className="ml-1.5 text-slate-400 hover:text-brand-700" onClick={() => duplicate(i)} title="Copy this row below"><Copy className="inline size-3.5" /></button>
                  <button type="button" className="ml-1.5 text-slate-400 hover:text-rose-600" onClick={() => removeRows([i])} title="Remove row"><X className="inline size-3.5" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {rows.some((r) => r._err) && (
        <Card className="mt-2 border-l-4 border-rose-500 p-3 text-sm">
          <b>Rows to correct:</b>
          <ul className="mt-1 list-inside list-disc text-xs">{rows.map((r, i) => r._err && <li key={i}>Row {i + 1} ({r.murabba}/{r.killa}{r.subKilla && `/${r.subKilla}`}): {r._err}</li>)}</ul>
        </Card>
      )}
      <p className="mt-2 text-xs text-slate-500">
        Columns with a list (type of land, ownership, scheme, cultivation) suggest the standard names — pick one, or type something else when it is written differently.
        Litigation / encroachment = "Encroachment" records the land as in unauthorised possession. Each saved khasra goes to the Girdawar for verification; acquisition, lease dates and documents can be added on its own page.
      </p>
    </>
  );
}

type SaveResult = { created: number; acres: number; savedRows: number[]; errors: { row: number; message: string }[] };
const fetchRows = (unitId: string, rows: unknown[]): Promise<SaveResult> =>
  post<SaveResult>('/state-land/rows', { unitId, rows }).catch(async (e: any) => {
    // A 400 with per-row errors still carries the details
    if (e?.body?.errors) return e.body;
    throw e;
  });
