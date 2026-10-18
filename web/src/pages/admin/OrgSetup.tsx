/**
 * Organisation setup — the organisation admin edits the blueprint: hierarchy, posts & roles, KPIs,
 * scoring, registers, terms and calendar. Changes apply immediately to every screen and score;
 * every saved version is kept and can be restored.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SINGLE_TENANT } from '../../lib/edition';
import clsx from 'clsx';
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, ChevronDown, History, Plus, RotateCcw, Save, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Badge, Button, Card, Empty, ErrorState, Field, Input, Loading, SectionTitle, Select, Sheet, useToast } from '../../components/ui';
import { ApiError, get, post, put } from '../../lib/api';

/* ---------- Blueprint draft types (mirror the server schema) ---------- */
interface Level { key: string; label: string; plural?: string; profile?: string }
interface PostD { key: string; label: string; levels: string[]; single?: boolean; exclusiveWith?: string[]; scored?: boolean; profile?: string; widenTo?: string; oversightAt?: string[]; caps?: string[] }
interface BlockD { key: string; label: string; kind: 'target' | 'arrears' | 'flow' | 'register' | 'tasks' }
interface Metric {
  code: string; name: string; group: string; block: string; unit?: 'money' | 'count' | 'number'; tag?: string; level: string;
  perHolder?: boolean; holderPosts?: string[]; enterPosts: string[]; verifyPosts: string[]; weight?: number; arrears?: boolean; active?: boolean; description?: string;
}
interface Register { key: string; label: string; block: string; levels: string[]; enterPosts: string[]; categories: string[]; amountLabel?: string }
interface Profile { key: string; label: string; weights: Record<string, number> }
interface Draft {
  name: string; industry?: string; levels: Level[]; posts: PostD[]; blocks: BlockD[]; metrics: Metric[]; registers: Register[]; profiles: Profile[];
  tags: { key: string; label: string }[]; bands: { key: string; label: string; min: number }[];
  calendar: { fyStartMonth: number };
  money: { currency?: string; symbol?: string; scale?: number; scaleLabel?: string; decimals?: number };
  terms?: Record<string, string>;
  access?: { viewScope?: 'organisation' | 'jurisdiction' };
}
interface BlueprintRes { version: number; template?: string; updatedAt?: string; doc: Draft | null }
interface Issue { path: string; message: string }

const TABS = [
  { value: 'general', label: 'General' },
  { value: 'levels', label: 'Hierarchy' },
  { value: 'posts', label: 'Posts & roles' },
  { value: 'kpis', label: 'KPIs' },
  { value: 'scoring', label: 'Scoring' },
  { value: 'registers', label: 'Registers' },
] as const;
type Tab = (typeof TABS)[number]['value'];

const CAP_LABEL: Record<string, string> = {
  set_targets: 'Sets annual targets',
  assign_targets: 'Assigns short-term targets',
  compare: 'Compares areas',
  manage_registers: 'Manages registers',
  litigation: 'Enters litigation cases',
  state_land: 'Enters state land holdings',
  state_land_verify: 'Verifies state land holdings',
  state_land_approve: 'Approves state land holdings',
};
const KIND_LABEL: Record<BlockD['kind'], string> = {
  target: 'Target vs achieved',
  arrears: 'Arrears (from target KPIs)',
  flow: 'Workload (pending vs disposed)',
  register: 'Register (items & amounts)',
  tasks: 'Tasks on time',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const toKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'x$1').slice(0, 40) || 'item';
const toCode = (s: string) => toKey(s).toUpperCase();

export default function OrgSetup() {
  const qc = useQueryClient();
  const toast = useToast();
  const bp = useQuery({ queryKey: ['org', 'blueprint'], queryFn: () => get<BlueprintRes>('/org/blueprint') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<Tab>('general');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [note, setNote] = useState('');
  const [history, setHistory] = useState(false);
  const [templates, setTemplates] = useState(false);
  useEffect(() => {
    if (bp.data?.doc && !draft) setDraft(structuredClone(bp.data.doc));
  }, [bp.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => !!draft && !!bp.data?.doc && JSON.stringify(draft) !== JSON.stringify(bp.data.doc), [draft, bp.data]);

  // Live validation (debounced)
  useEffect(() => {
    if (!draft) return;
    const h = setTimeout(() => {
      post<{ ok: boolean; issues: Issue[] }>('/org/blueprint/validate', { doc: draft }).then((r) => setIssues(r.issues)).catch(() => undefined);
    }, 400);
    return () => clearTimeout(h);
  }, [draft]);

  const save = useMutation({
    mutationFn: () => put<{ version: number; warnings: string[] }>('/org/blueprint', { doc: draft, note: note || undefined }),
    onSuccess: (r) => {
      toast(`Saved as version ${r.version}${r.warnings.length ? ` — ${r.warnings[0]}` : ''}`);
      setNote('');
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['org'] });
      qc.invalidateQueries({ queryKey: ['rev'] });
    },
  });
  const saveError = save.error instanceof ApiError ? save.error : null;
  const serverIssues: string[] = Array.isArray(saveError?.body?.error?.details) ? saveError!.body.error.details : [];

  if (bp.isLoading) return <Loading />;
  if (bp.error) return <ErrorState error={bp.error} retry={bp.refetch} />;
  if (!draft) return <Loading />;

  const update = (fn: (d: Draft) => void) => setDraft((d) => {
    const n = structuredClone(d!);
    fn(n);
    return n;
  });
  const tabIssues = (t: Tab) => issues.filter((i) => ({ general: /^(name|calendar|money|terms|bands|tags)/, levels: /^levels/, posts: /^posts/, kpis: /^metrics/, scoring: /^(blocks|profiles)/, registers: /^registers/ })[t].test(i.path)).length;

  return (
    <>
      <PageHeader
        title="Organisation setup"
        subtitle={`Version ${bp.data!.version}${bp.data!.template ? ` · started from "${bp.data!.template.replace(/_/g, ' ')}"` : ''} — hierarchy, posts, KPIs and scoring`}
        actions={
          <div className="flex gap-2">
            {!SINGLE_TENANT && <Button size="sm" variant="secondary" onClick={() => setTemplates(true)}><Wand2 className="size-4" />Templates</Button>}
            <Button size="sm" variant="secondary" onClick={() => setHistory(true)}><History className="size-4" />History</Button>
          </div>
        }
      />

      <div className="mb-3 -mx-1 overflow-x-auto px-1">
        <div className="flex min-w-max gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
          {TABS.map((t) => (
            <button key={t.value} onClick={() => setTab(t.value)}
              className={clsx('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium', tab === t.value ? 'bg-white text-brand-800 shadow-sm dark:bg-slate-900 dark:text-white' : 'text-slate-600 hover:text-slate-900 dark:text-slate-300')}>
              {t.label}
              {tabIssues(t.value) > 0 && <span className="rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">{tabIssues(t.value)}</span>}
            </button>
          ))}
        </div>
      </div>

      {tab === 'general' && <General d={draft} update={update} />}
      {tab === 'levels' && <Levels d={draft} update={update} />}
      {tab === 'posts' && <Posts d={draft} update={update} />}
      {tab === 'kpis' && <Kpis d={draft} update={update} />}
      {tab === 'scoring' && <Scoring d={draft} update={update} />}
      {tab === 'registers' && <Registers d={draft} update={update} />}

      {/* Save bar */}
      <div className="sticky bottom-20 z-20 mt-4 lg:bottom-3">
        <Card className="space-y-2 p-3 shadow-lg ring-2 ring-brand-100 dark:ring-brand-900">
          {issues.length > 0 ? (
            <div className="flex items-start gap-2 text-sm text-rose-700 dark:text-rose-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div>
                <b>{issues.length} problem{issues.length > 1 ? 's' : ''} to fix before saving</b>
                <ul className="mt-0.5 list-disc pl-4 text-xs">{issues.slice(0, 4).map((i) => <li key={i.path + i.message}><code>{i.path}</code>: {i.message}</li>)}</ul>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="size-4" />Configuration is valid{dirty ? ' — unsaved changes' : ''}</div>
          )}
          {saveError && (
            <div className="rounded-lg bg-rose-50 p-2 text-xs text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">
              <b>{saveError.message}</b>
              {serverIssues.length > 0 && <ul className="mt-1 list-disc pl-4">{serverIssues.slice(0, 6).map((x) => <li key={x}>{x}</li>)}</ul>}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Input className="min-w-0 basis-full sm:basis-0 sm:flex-1" placeholder="What changed? (optional note for the history)" value={note} onChange={(e) => setNote(e.target.value)} />
            {dirty && <Button variant="ghost" onClick={() => { setDraft(structuredClone(bp.data!.doc!)); save.reset(); }}><RotateCcw className="size-4" />Discard</Button>}
            <Button disabled={!dirty || issues.length > 0} loading={save.isPending} onClick={() => save.mutate()}><Save className="size-4" />Save &amp; apply</Button>
          </div>
        </Card>
      </div>

      {history && <HistorySheet onClose={() => setHistory(false)} onRestored={() => { setDraft(null); setHistory(false); }} />}
      {templates && <TemplateSheet onClose={() => setTemplates(false)} onPick={(doc) => { setDraft({ ...doc, name: draft.name }); setTemplates(false); toast('Template loaded — review it, then save'); }} />}
    </>
  );
}

type Ed = { d: Draft; update: (fn: (d: Draft) => void) => void };

/* ---------- small building blocks ---------- */
function Item({ title, sub, badges, children, onUp, onDown, onRemove, open: openInit = false }: { title: ReactNode; sub?: ReactNode; badges?: ReactNode; children: ReactNode; onUp?: () => void; onDown?: () => void; onRemove?: () => void; open?: boolean }) {
  const [open, setOpen] = useState(openInit);
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ChevronDown className={clsx('size-4 shrink-0 text-slate-400 transition', !open && '-rotate-90')} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{title}</div>
            {sub && <div className="truncate text-xs text-slate-500">{sub}</div>}
          </div>
        </button>
        <div className="hidden items-center gap-1 sm:flex">{badges}</div>
        {onUp && <button className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Move up" onClick={onUp}><ArrowUp className="size-4" /></button>}
        {onDown && <button className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Move down" onClick={onDown}><ArrowDown className="size-4" /></button>}
        {onRemove && <button className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title="Remove" onClick={() => confirm('Remove this item?') && onRemove()}><Trash2 className="size-4" /></button>}
      </div>
      {open && <div className="grid gap-3 border-t border-slate-100 p-3 sm:grid-cols-2 dark:border-slate-800">{children}</div>}
    </Card>
  );
}

function Chips({ options, value, onChange, empty = 'None' }: { options: { key: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; empty?: string }) {
  if (!options.length) return <div className="text-xs text-slate-400">{empty}</div>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.key);
        return (
          <button key={o.key} type="button" onClick={() => onChange(on ? value.filter((v) => v !== o.key) : [...value, o.key])}
            className={clsx('rounded-full px-2.5 py-1 text-xs font-medium ring-1', on ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 hover:ring-brand-300 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700')}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const Check = ({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) => (
  <label className="flex cursor-pointer items-start gap-2 text-sm">
    <input type="checkbox" className="mt-0.5 size-4 accent-brand-600" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span>{label}{hint && <span className="block text-xs text-slate-500">{hint}</span>}</span>
  </label>
);
const Full = ({ children }: { children: ReactNode }) => <div className="sm:col-span-2">{children}</div>;
const move = <T,>(list: T[], i: number, dir: -1 | 1) => {
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
};

/* ---------- General ---------- */
function General({ d, update }: Ed) {
  const t = d.terms ?? {};
  const term = (k: string, label: string, hint: string) => (
    <Field label={label} hint={hint}>{(id) => <Input id={id} value={t[k] ?? ''} onChange={(e) => update((x) => { x.terms = { ...(x.terms ?? {}), [k]: e.target.value }; })} />}</Field>
  );
  return (
    <div className="space-y-4">
      <Card className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Framework name">{(id) => <Input id={id} value={d.name} onChange={(e) => update((x) => { x.name = e.target.value; })} />}</Field>
        <Field label="Industry">{(id) => <Input id={id} value={d.industry ?? ''} placeholder="e.g. Marketing, HR, Public sector" onChange={(e) => update((x) => { x.industry = e.target.value; })} />}</Field>
        <Field label="Who can view what" hint="Extra areas can be opened to individuals under Access rights">
          {(id) => (
            <Select id={id} value={d.access?.viewScope ?? 'organisation'} onChange={(e) => update((x) => { x.access = { viewScope: e.target.value as 'organisation' | 'jurisdiction' }; })}>
              <option value="organisation">Everyone sees the whole organisation (read-only)</option>
              <option value="jurisdiction">Each person sees only their own jurisdiction</option>
            </Select>
          )}
        </Field>
        <Field label="Financial year starts in" hint="Targets, trends and reports run over this 12-month year">
          {(id) => <Select id={id} value={d.calendar.fyStartMonth} onChange={(e) => update((x) => { x.calendar.fyStartMonth = Number(e.target.value); })}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select>}
        </Field>
      </Card>

      <SectionTitle>Money</SectionTitle>
      <Card className="grid gap-3 p-4 sm:grid-cols-4">
        <Field label="Currency code">{(id) => <Input id={id} value={d.money.currency ?? ''} onChange={(e) => update((x) => { x.money.currency = e.target.value; })} />}</Field>
        <Field label="Symbol">{(id) => <Input id={id} value={d.money.symbol ?? ''} onChange={(e) => update((x) => { x.money.symbol = e.target.value; })} />}</Field>
        <Field label="Show amounts in">
          {(id) => (
            <Select id={id} value={d.money.scale ?? 1e6} onChange={(e) => update((x) => { const v = Number(e.target.value); x.money.scale = v; x.money.scaleLabel = { 1: 'Units', 1000: 'Thousands', 100000: 'Lakhs', 1000000: 'Millions', 10000000: 'Crores', 1000000000: 'Billions' }[v] ?? 'Millions'; })}>
              <option value={1}>Full amounts</option><option value={1000}>Thousands</option><option value={100000}>Lakhs</option><option value={1000000}>Millions</option><option value={10000000}>Crores</option><option value={1000000000}>Billions</option>
            </Select>
          )}
        </Field>
        <Field label="Decimals">{(id) => <Input id={id} type="number" min={0} max={4} value={d.money.decimals ?? 2} onChange={(e) => update((x) => { x.money.decimals = Number(e.target.value); })} />}</Field>
      </Card>

      <SectionTitle>Your organisation's words</SectionTitle>
      <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
        {term('money', 'Money KPIs headline', 'e.g. Revenue, Sales, Collections')}
        {term('achieved', 'Achieved is called', 'e.g. Recovered, Achieved, Sold')}
        {term('flowGroup', 'Workload KPIs headline', 'e.g. Case registers, Requests')}
        {term('disposed', 'Completed work is called', 'e.g. Disposed, Closed')}
        {term('pending', 'Outstanding work is called', 'e.g. Pending, Open')}
        {term('items', 'Workload items (plural)', 'e.g. cases, leads, requests')}
        {term('reference', 'Reference number label', 'e.g. Challan / PSID no., Invoice no.')}
      </Card>

      <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => update((x) => { x.tags.push({ key: `tag_${x.tags.length + 1}`, label: 'New tag' }); })}><Plus className="size-4" />Tag</Button>}>KPI tags (e.g. seasons)</SectionTitle>
      <Card className="space-y-2 p-4">
        {!d.tags.length && <div className="text-sm text-slate-500">No tags. Tags group KPIs for reporting, e.g. Rabi / Kharif crops or quarters.</div>}
        {d.tags.map((t2, i) => (
          <div key={i} className="flex gap-2">
            <Input value={t2.label} onChange={(e) => update((x) => { x.tags[i].label = e.target.value; })} />
            <Input className="w-40 font-mono text-xs" value={t2.key} onChange={(e) => update((x) => { x.tags[i].key = toKey(e.target.value); })} />
            <Button variant="ghost" onClick={() => update((x) => { x.tags.splice(i, 1); })}><Trash2 className="size-4" /></Button>
          </div>
        ))}
      </Card>

      <SectionTitle>Grade bands (score from … upwards)</SectionTitle>
      <Card className="space-y-2 p-4">
        {d.bands.map((b, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input value={b.label} onChange={(e) => update((x) => { x.bands[i].label = e.target.value; })} />
            <Input className="w-24 text-right" type="number" min={0} max={100} value={b.min} onChange={(e) => update((x) => { x.bands[i].min = Number(e.target.value); })} />
            <span className="text-sm text-slate-500">%+</span>
            <Button variant="ghost" disabled={d.bands.length <= 1} onClick={() => update((x) => { x.bands.splice(i, 1); })}><Trash2 className="size-4" /></Button>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => update((x) => { x.bands.push({ key: `band_${x.bands.length + 1}`, label: 'New band', min: 0 }); })}><Plus className="size-4" />Band</Button>
      </Card>
    </div>
  );
}

/* ---------- Hierarchy ---------- */
function Levels({ d, update }: Ed) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-500">From the top of your organisation down. Every unit sits one level below its parent (e.g. Region › Branch › Team). Levels already used by units cannot be removed.</p>
      {d.levels.map((l, i) => (
        <Item key={i} title={<><span className="mr-2 text-xs font-bold text-slate-400">{i + 1}</span>{l.label}</>} sub={`${l.plural ?? `${l.label}s`} · key ${l.key}`}
          onUp={i ? () => update((x) => move(x.levels, i, -1)) : undefined} onDown={i < d.levels.length - 1 ? () => update((x) => move(x.levels, i, 1)) : undefined}
          onRemove={d.levels.length > 1 ? () => update((x) => { x.levels.splice(i, 1); }) : undefined}>
          <Field label="Name (singular)">{(id) => <Input id={id} value={l.label} onChange={(e) => update((x) => { x.levels[i].label = e.target.value; })} />}</Field>
          <Field label="Plural">{(id) => <Input id={id} value={l.plural ?? ''} placeholder={`${l.label}s`} onChange={(e) => update((x) => { x.levels[i].plural = e.target.value || undefined; })} />}</Field>
          <Field label="Key" hint="Used in imports (level column)">{(id) => <Input id={id} className="font-mono text-xs" value={l.key} onChange={(e) => update((x) => { x.levels[i].key = toKey(e.target.value); })} />}</Field>
          <Field label="Scoring profile for areas at this level">
            {(id) => <Select id={id} value={l.profile ?? ''} onChange={(e) => update((x) => { x.levels[i].profile = e.target.value || undefined; })}><option value="">Same as level above</option>{d.profiles.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</Select>}
          </Field>
        </Item>
      ))}
      <Button variant="secondary" onClick={() => update((x) => { const n = x.levels.length + 1; x.levels.push({ key: `level_${n}`, label: `Level ${n}` }); })}><Plus className="size-4" />Add level at the bottom</Button>
    </div>
  );
}

/* ---------- Posts ---------- */
function Posts({ d, update }: Ed) {
  const levelOpts = d.levels.map((l) => ({ key: l.key, label: l.label }));
  const postOpts = (except: string) => d.posts.filter((p) => p.key !== except).map((p) => ({ key: p.key, label: p.label }));
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-500">Posts are the roles people hold through postings. What a post may enter and verify is set on each KPI.</p>
      {d.posts.map((p, i) => (
        <Item key={i} title={p.label} sub={`${p.levels.map((l) => d.levels.find((x) => x.key === l)?.label ?? l).join(', ')} · key ${p.key}`}
          badges={<>{p.scored === false ? <Badge>Data post</Badge> : <Badge tone="bg-brand-50 text-brand-700">Scored</Badge>}{p.single && <Badge>One per unit</Badge>}</>}
          onUp={i ? () => update((x) => move(x.posts, i, -1)) : undefined} onDown={i < d.posts.length - 1 ? () => update((x) => move(x.posts, i, 1)) : undefined}
          onRemove={() => update((x) => { x.posts.splice(i, 1); })}>
          <Field label="Name">{(id) => <Input id={id} value={p.label} onChange={(e) => update((x) => { x.posts[i].label = e.target.value; })} />}</Field>
          <Field label="Key" hint="Used in imports (post column)">{(id) => <Input id={id} className="font-mono text-xs" value={p.key} onChange={(e) => update((x) => { x.posts[i].key = toKey(e.target.value); })} />}</Field>
          <Full><Field label="Posted at level(s)">{() => <Chips options={levelOpts} value={p.levels} onChange={(v) => update((x) => { x.posts[i].levels = v; })} />}</Field></Full>
          <Check label="Scored" hint="Appears in leagues and gets a personal score (untick for clerks / data officers)" checked={p.scored !== false} onChange={(v) => update((x) => { x.posts[i].scored = v; })} />
          <Check label="Only one holder per unit" checked={!!p.single} onChange={(v) => update((x) => { x.posts[i].single = v; })} />
          <Field label="Personal score profile">{(id) => <Select id={id} value={p.profile ?? ''} onChange={(e) => update((x) => { x.posts[i].profile = e.target.value || undefined; })}><option value="">Profile of the level held</option>{d.profiles.map((pr) => <option key={pr.key} value={pr.key}>{pr.label}</option>)}</Select>}</Field>
          <Field label="Sees the whole…" hint="Widen working jurisdiction to an ancestor">{(id) => <Select id={id} value={p.widenTo ?? ''} onChange={(e) => update((x) => { x.posts[i].widenTo = e.target.value || undefined; })}><option value="">Own unit only</option>{d.levels.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}</Select>}</Field>
          <Full><Field label="Can">{() => <Chips options={Object.entries(CAP_LABEL).map(([key, label]) => ({ key, label }))} value={p.caps ?? []} onChange={(v) => update((x) => { x.posts[i].caps = v; })} />}</Field></Full>
          <Full><Field label="Cannot share a unit with" hint="e.g. only one revenue officer per qanungoi">{() => <Chips options={postOpts(p.key)} value={p.exclusiveWith ?? []} onChange={(v) => update((x) => { x.posts[i].exclusiveWith = v; })} />}</Field></Full>
          <Full><Field label="Supervisory only at" hint="Holding this post at these levels is oversight, not the holder's own area">{() => <Chips options={levelOpts} value={p.oversightAt ?? []} onChange={(v) => update((x) => { x.posts[i].oversightAt = v; })} />}</Field></Full>
        </Item>
      ))}
      <Button variant="secondary" onClick={() => update((x) => { const n = x.posts.length + 1; x.posts.push({ key: `post_${n}`, label: `New post ${n}`, levels: [x.levels[x.levels.length - 1].key], scored: true, caps: [], oversightAt: [], exclusiveWith: [] }); })}><Plus className="size-4" />Add post</Button>
    </div>
  );
}

/* ---------- KPIs ---------- */
function Kpis({ d, update }: Ed) {
  const postOpts = d.posts.map((p) => ({ key: p.key, label: p.label }));
  const kpiBlocks = d.blocks.filter((b) => b.kind === 'target' || b.kind === 'flow');
  const groups = [...new Set(d.metrics.map((m) => m.block))];
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-500">Each KPI says where it is recorded, who enters it and who verifies it. A KPI that already has figures cannot be deleted — untick <b>Active</b> to retire it.</p>
      {!kpiBlocks.length && <Card className="p-4 text-sm text-amber-700">Add a "Target" or "Workload" block on the Scoring tab first.</Card>}
      {groups.concat(kpiBlocks.map((b) => b.key).filter((k) => !groups.includes(k))).map((g) => {
        const blk = d.blocks.find((b) => b.key === g);
        const list = d.metrics.map((m, i) => ({ m, i })).filter((x) => x.m.block === g);
        return (
          <div key={g} className="space-y-2">
            <SectionTitle>{blk?.label ?? g} <span className="text-xs font-normal normal-case text-slate-400">· {blk ? KIND_LABEL[blk.kind] : 'unknown block'}</span></SectionTitle>
            {list.map(({ m, i }) => (
              <Item key={i} title={<span className={clsx(m.active === false && 'text-slate-400 line-through')}>{m.name}</span>}
                sub={`${m.code} · ${d.levels.find((l) => l.key === m.level)?.label ?? m.level}${m.perHolder ? ' · per person' : ''} · weight ${m.weight ?? 1}`}
                badges={<>{m.unit === 'money' ? <Badge>Money</Badge> : <Badge>{m.unit ?? 'money'}</Badge>}{m.arrears && <Badge>Arrears</Badge>}{m.active === false && <Badge tone="bg-slate-200 text-slate-600">Retired</Badge>}</>}
                onRemove={() => update((x) => { x.metrics.splice(i, 1); })}>
                <Field label="Name">{(id) => <Input id={id} value={m.name} onChange={(e) => update((x) => { x.metrics[i].name = e.target.value; })} />}</Field>
                <Field label="Code" hint="Used in imports and reports">{(id) => <Input id={id} className="font-mono text-xs" value={m.code} onChange={(e) => update((x) => { x.metrics[i].code = toCode(e.target.value); })} />}</Field>
                <Field label="Group" hint="KPIs in a group are shown together">{(id) => <Input id={id} value={m.group} onChange={(e) => update((x) => { x.metrics[i].group = e.target.value; })} />}</Field>
                <Field label="Block">{(id) => <Select id={id} value={m.block} onChange={(e) => update((x) => { x.metrics[i].block = e.target.value; })}>{kpiBlocks.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}</Select>}</Field>
                <Field label="Measured in">{(id) => <Select id={id} value={m.unit ?? 'money'} onChange={(e) => update((x) => { x.metrics[i].unit = e.target.value as Metric['unit']; })}><option value="money">Money</option><option value="count">Count</option><option value="number">Number (hours, km …)</option></Select>}</Field>
                <Field label="Recorded on">{(id) => <Select id={id} value={m.level} onChange={(e) => update((x) => { x.metrics[i].level = e.target.value; })}>{d.levels.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}</Select>}</Field>
                <Field label="Weight within its block">{(id) => <Input id={id} type="number" min={0} max={1000} value={m.weight ?? 1} onChange={(e) => update((x) => { x.metrics[i].weight = Number(e.target.value); })} />}</Field>
                <Field label="Tag">{(id) => <Select id={id} value={m.tag ?? ''} onChange={(e) => update((x) => { x.metrics[i].tag = e.target.value || undefined; })}><option value="">None</option>{d.tags.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</Select>}</Field>
                <Full><Field label="Entered by">{() => <Chips options={postOpts} value={m.enterPosts} onChange={(v) => update((x) => { x.metrics[i].enterPosts = v; })} />}</Field></Full>
                <Full><Field label="Verified by" hint="Their own entries count at once; others wait for them">{() => <Chips options={postOpts} value={m.verifyPosts} onChange={(v) => update((x) => { x.metrics[i].verifyPosts = v; })} />}</Field></Full>
                <Check label="Recorded per person" hint="Each holder keeps their own figures (e.g. an officer's own register)" checked={!!m.perHolder} onChange={(v) => update((x) => { x.metrics[i].perHolder = v; })} />
                {blk?.kind === 'target' && <Check label="Track arrears" hint="Demand left over from earlier years" checked={!!m.arrears} onChange={(v) => update((x) => { x.metrics[i].arrears = v; })} />}
                {m.perHolder && <Full><Field label="Held by">{() => <Chips options={postOpts} value={m.holderPosts ?? []} onChange={(v) => update((x) => { x.metrics[i].holderPosts = v; })} />}</Field></Full>}
                <Check label="Active" checked={m.active !== false} onChange={(v) => update((x) => { x.metrics[i].active = v; })} />
              </Item>
            ))}
            {blk && (
              <Button size="sm" variant="ghost" onClick={() => update((x) => {
                const n = x.metrics.length + 1;
                x.metrics.push({ code: `KPI_${n}`, name: `New KPI ${n}`, group: blk.label, block: blk.key, unit: blk.kind === 'flow' ? 'count' : 'money', level: x.levels[x.levels.length - 1].key, enterPosts: [], verifyPosts: [], weight: 1, active: true });
              })}><Plus className="size-4" />Add KPI to {blk.label}</Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Scoring: blocks and profiles ---------- */
function Scoring({ d, update }: Ed) {
  return (
    <div className="space-y-4">
      <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => update((x) => { const n = x.blocks.length + 1; x.blocks.push({ key: `block_${n}`, label: `New block ${n}`, kind: 'target' }); })}><Plus className="size-4" />Block</Button>}>Scoring blocks</SectionTitle>
      <div className="space-y-2">
        {d.blocks.map((b, i) => (
          <Card key={i} className="grid gap-2 p-3 sm:grid-cols-[1fr_12rem_10rem_auto] sm:items-end">
            <Field label="Block name">{(id) => <Input id={id} value={b.label} onChange={(e) => update((x) => { x.blocks[i].label = e.target.value; })} />}</Field>
            <Field label="Type">{(id) => <Select id={id} value={b.kind} onChange={(e) => update((x) => { x.blocks[i].kind = e.target.value as BlockD['kind']; })}>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
            <Field label="Key">{(id) => <Input id={id} className="font-mono text-xs" value={b.key} onChange={(e) => update((x) => { const old = x.blocks[i].key; const k = toKey(e.target.value); x.blocks[i].key = k; x.metrics.forEach((m) => { if (m.block === old) m.block = k; }); x.profiles.forEach((p) => { if (old in p.weights) { p.weights[k] = p.weights[old]; delete p.weights[old]; } }); })} />}</Field>
            <Button variant="ghost" onClick={() => confirm('Remove this block?') && update((x) => { x.blocks.splice(i, 1); })}><Trash2 className="size-4" /></Button>
          </Card>
        ))}
      </div>

      <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => update((x) => { const n = x.profiles.length + 1; x.profiles.push({ key: `profile_${n}`, label: `Profile ${n}`, weights: Object.fromEntries(x.blocks.map((b) => [b.key, 0])) }); })}><Plus className="size-4" />Profile</Button>}>
        Weight profiles (each row = 100)
      </SectionTitle>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-brand-700 text-center text-[12.5px] text-white">
            <tr>
              <th className="px-3 py-2">Profile</th>
              {d.blocks.map((b) => <th key={b.key} className="px-2 py-2">{b.label}</th>)}
              <th className="px-3 py-2">Total</th><th />
            </tr>
          </thead>
          <tbody>
            {d.profiles.map((p, i) => {
              const total = d.blocks.reduce((s, b) => s + (p.weights[b.key] ?? 0), 0);
              return (
                <tr key={i} className="border-b border-slate-100 dark:border-slate-800">
                  <td className="px-2 py-1.5"><Input value={p.label} onChange={(e) => update((x) => { x.profiles[i].label = e.target.value; })} /></td>
                  {d.blocks.map((b) => (
                    <td key={b.key} className="px-1 py-1.5"><Input className="w-16 text-center" type="number" min={0} max={100} value={p.weights[b.key] ?? 0} onChange={(e) => update((x) => { x.profiles[i].weights[b.key] = Number(e.target.value); })} /></td>
                  ))}
                  <td className={clsx('px-3 text-center font-bold tabular-nums', total === 100 ? 'text-emerald-600' : 'text-amber-600')}>{total}</td>
                  <td><Button variant="ghost" disabled={d.profiles.length <= 1} onClick={() => update((x) => { x.profiles.splice(i, 1); })}><Trash2 className="size-4" /></Button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <p className="text-xs text-slate-500">A block with no data for someone (e.g. no workload KPIs) is skipped and its weight is shared among the rest, so missing data never inflates or deflates a score. Area-specific overrides are set under Scoring weights.</p>
    </div>
  );
}

/* ---------- Registers ---------- */
function Registers({ d, update }: Ed) {
  const levelOpts = d.levels.map((l) => ({ key: l.key, label: l.label }));
  const postOpts = d.posts.map((p) => ({ key: p.key, label: p.label }));
  const regBlocks = d.blocks.filter((b) => b.kind === 'register');
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-500">Registers hold individual items with an amount and a status — e.g. audit paras, customer complaints, grievances. They are scored in a "Register" block.</p>
      {!regBlocks.length && <Card className="p-4 text-sm text-amber-700">Add a block of type "Register" on the Scoring tab to score registers.</Card>}
      {d.registers.map((r, i) => (
        <Item key={i} title={r.label} sub={`${r.categories.length} categories · ${r.levels.map((l) => d.levels.find((x) => x.key === l)?.label ?? l).join(', ')}`} onRemove={() => update((x) => { x.registers.splice(i, 1); })}>
          <Field label="Name">{(id) => <Input id={id} value={r.label} onChange={(e) => update((x) => { x.registers[i].label = e.target.value; })} />}</Field>
          <Field label="Amount column">{(id) => <Input id={id} value={r.amountLabel ?? ''} placeholder="Amount" onChange={(e) => update((x) => { x.registers[i].amountLabel = e.target.value; })} />}</Field>
          <Field label="Scored in">{(id) => <Select id={id} value={r.block} onChange={(e) => update((x) => { x.registers[i].block = e.target.value; })}>{regBlocks.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}</Select>}</Field>
          <Field label="Key">{(id) => <Input id={id} className="font-mono text-xs" value={r.key} onChange={(e) => update((x) => { x.registers[i].key = toKey(e.target.value); })} />}</Field>
          <Full><Field label="Recorded on">{() => <Chips options={levelOpts} value={r.levels} onChange={(v) => update((x) => { x.registers[i].levels = v; })} />}</Field></Full>
          <Full><Field label="Maintained by">{() => <Chips options={postOpts} value={r.enterPosts} onChange={(v) => update((x) => { x.registers[i].enterPosts = v; })} />}</Field></Full>
          <Full><Field label="Categories (one per line)">{(id) => <textarea id={id} rows={4} className="w-full rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700" value={r.categories.join('\n')} onChange={(e) => update((x) => { x.registers[i].categories = e.target.value.split('\n').map((c) => c.trim()).filter(Boolean); })} />}</Field></Full>
        </Item>
      ))}
      <Button variant="secondary" disabled={!regBlocks.length} onClick={() => update((x) => { const n = x.registers.length + 1; x.registers.push({ key: `register_${n}`, label: `Register ${n}`, block: regBlocks[0].key, levels: [x.levels[x.levels.length - 1].key], enterPosts: [], categories: ['General'], amountLabel: 'Amount' }); })}><Plus className="size-4" />Add register</Button>
    </div>
  );
}

/* ---------- History & templates ---------- */
function HistorySheet({ onClose, onRestored }: { onClose: () => void; onRestored: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const h = useQuery({ queryKey: ['org', 'blueprint', 'history'], queryFn: () => get<{ version: number; note?: string; createdAt: string; updatedBy?: { name: string } }[]>('/org/blueprint/history') });
  const restore = useMutation({
    mutationFn: (v: number) => post(`/org/blueprint/rollback/${v}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['org'] }); qc.invalidateQueries({ queryKey: ['rev'] }); toast('Version restored'); onRestored(); },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title="Version history">
      {h.isLoading ? <Loading /> : !h.data?.length ? <Empty title="No history yet" /> : (
        <div className="space-y-2">
          {h.data.map((v, i) => (
            <Card key={v.version} className="flex items-center gap-3 p-3">
              <div className="grid size-9 place-items-center rounded-lg bg-brand-50 text-sm font-bold text-brand-700">v{v.version}</div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{v.note ?? 'Saved'}</div>
                <div className="text-xs text-slate-500">{new Date(v.createdAt).toLocaleString()}{v.updatedBy && ` · ${v.updatedBy.name}`}</div>
              </div>
              {i > 0 && <Button size="sm" variant="secondary" loading={restore.isPending && restore.variables === v.version} onClick={() => confirm(`Restore version ${v.version}? It becomes a new version; nothing is lost.`) && restore.mutate(v.version)}>Restore</Button>}
              {i === 0 && <Badge tone="bg-emerald-100 text-emerald-800">Current</Badge>}
            </Card>
          ))}
        </div>
      )}
    </Sheet>
  );
}

function TemplateSheet({ onClose, onPick }: { onClose: () => void; onPick: (doc: Draft) => void }) {
  const t = useQuery({ queryKey: ['org', 'templates'], queryFn: () => get<{ key: string; label: string; category: string; description: string; blueprint: Draft }[]>('/org/templates') });
  return (
    <Sheet open onClose={onClose} title="Start from a template">
      <p className="mb-3 text-sm text-slate-500">Loads the template into the editor. Nothing changes until you save, and items your data still uses cannot be removed.</p>
      {t.isLoading ? <Loading /> : (
        <div className="space-y-2">
          {[...new Set(t.data?.map((x) => x.category))].map((cat) => <div key={cat} className="space-y-2"><div className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{cat}</div>
          {t.data?.filter((x) => x.category === cat).map((x) => (
            <Card key={x.key} className="p-3" onClick={() => confirm(`Replace the editor contents with "${x.label}"?`) && onPick(structuredClone(x.blueprint))}>
              <div className="font-medium">{x.label}</div>
              <div className="text-xs text-slate-500">{x.description}</div>
              <div className="mt-1 text-[11px] text-slate-400">{x.blueprint.levels.map((l) => l.label).join(' › ')} · {x.blueprint.metrics.length} KPIs</div>
            </Card>
          ))}</div>)}
        </div>
      )}
    </Sheet>
  );
}

