/**
 * Access rights — the organisation admin gives a person rights on an area (and everything below it),
 * optionally only for some KPIs and until a date. These add to what the person's posts allow.
 */
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { KeyRound, Pencil, Plus, Search, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { PageHeader } from '../../components/AppShell';
import { UnitField } from '../../components/rev';
import { Badge, Button, Card, Empty, ErrorState, Field, Input, Loading, SectionTitle, Sheet } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import { UNIT_LABEL, getOrg, useMeta, type UnitRef } from '../../lib/rev';
import { useSave } from './shared';

export const RIGHTS: { key: string; label: string; hint: string }[] = [
  { key: 'view', label: 'View', hint: 'See performance of this area (matters when viewing is limited to jurisdiction)' },
  { key: 'enter', label: 'Enter figures', hint: 'Enter monthly figures for the KPIs below' },
  { key: 'edit', label: 'Edit verified figures', hint: 'Correct figures that are already verified (they go back for verification)' },
  { key: 'verify', label: 'Verify', hint: 'Verify or return figures and target progress' },
  { key: 'set_targets', label: 'Set annual targets', hint: 'Set annual targets and opening balances' },
  { key: 'assign_targets', label: 'Assign targets', hint: 'Give short-term targets and area drives' },
  { key: 'compare', label: 'Compare areas', hint: 'Use the comparison page' },
  { key: 'manage_registers', label: 'Manage registers', hint: 'Record, edit and delete register items' },
  { key: 'litigation', label: 'Litigation entry', hint: 'Add and update court cases and their documents' },
  { key: 'state_land', label: 'State land entry', hint: 'Add and update state land holdings in the State Land Directory' },
  { key: 'state_land_verify', label: 'State land verification', hint: 'Verify or return state land holdings (first check)' },
  { key: 'state_land_approve', label: 'State land approval', hint: 'Approve verified state land holdings (final check)' },
];
const LABEL = Object.fromEntries(RIGHTS.map((r) => [r.key, r.label]));

interface Grant {
  _id: string; rights: string[]; metrics: string[]; expiresAt?: string | null; note?: string; expired?: boolean; createdAt: string;
  userId: { _id: string; name: string; email: string; designation?: string };
  unitId: { _id: string; name: string; type: string } | null;
  grantedBy?: { name: string };
}
interface UserRow { _id: string; name: string; email: string; designation?: string }

export default function Access() {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Grant | 'new' | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['org', 'access'], queryFn: () => get<Grant[]>('/org/access') });
  const remove = useSave((id: string) => del(`/org/access/${id}`), [['org', 'access']], 'Access removed');
  const term = search.trim().toLowerCase();
  const list = (data ?? []).filter((g) => !term || `${g.userId?.name} ${g.userId?.email} ${g.unitId?.name}`.toLowerCase().includes(term));
  const viewScope = (getOrg() as any)?.access?.viewScope ?? 'organisation';

  return (
    <>
      <PageHeader title="Access rights" subtitle="Give people rights on an area — on top of what their posts allow" actions={<Button size="sm" onClick={() => setEditing('new')}><Plus className="size-4" />Give access</Button>} />

      <Card className="mb-3 flex items-start gap-3 p-3 text-sm">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand-600" />
        <div className="text-slate-600 dark:text-slate-300">
          Rights come from <b>posts</b> (set in Organisation setup) and from the <b>grants</b> below. A grant covers the chosen unit and everything under it.
          Viewing is currently <b>{viewScope === 'jurisdiction' ? 'limited to each person’s jurisdiction and granted areas' : 'open to the whole organisation'}</b> — change it in Organisation setup › General.
        </div>
      </Card>

      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
        <Input className="pl-9" placeholder="Search by person or area…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : !list.length ? (
        <Card><Empty icon={KeyRound} title="No direct grants" body="Everyone works with the rights of their posts. Give access to let someone enter, verify or set targets beyond their posting." /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-separate border-spacing-0 text-[14px]">
            <thead className="bg-brand-700 text-center text-[13.5px] text-white">
              <tr>
                {['Person', 'Area', 'Rights', 'KPIs', 'Until', ''].map((h) => <th key={h} className="border-b border-r border-white/50 px-3 py-2">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {list.map((g) => (
                <tr key={g._id} className={clsx(g.expired && 'opacity-50')}>
                  <td className="border-b border-r border-slate-200 px-3 py-2 dark:border-slate-700">
                    <button className="text-left font-bold hover:underline" onClick={() => setPerson(g.userId._id)}>{g.userId?.name}</button>
                    <div className="text-[12px] text-slate-500">{g.userId?.designation ?? g.userId?.email}</div>
                  </td>
                  <td className="border-b border-r border-slate-200 px-3 py-2 dark:border-slate-700">{g.unitId ? <>{g.unitId.name}<div className="text-[12px] text-slate-500">{UNIT_LABEL[g.unitId.type]} and below</div></> : '—'}</td>
                  <td className="border-b border-r border-slate-200 px-3 py-2 dark:border-slate-700"><div className="flex flex-wrap gap-1">{g.rights.map((r) => <Badge key={r} tone="bg-brand-50 text-brand-800 dark:bg-brand-500/15 dark:text-brand-200">{LABEL[r] ?? r}</Badge>)}</div></td>
                  <td className="border-b border-r border-slate-200 px-3 py-2 text-[13px] dark:border-slate-700">{g.metrics.length ? g.metrics.length === 1 ? g.metrics[0] : `${g.metrics.length} KPIs` : 'All'}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-200 px-3 py-2 text-[13px] dark:border-slate-700">{g.expiresAt ? <><span className="font-semibold">{new Date(g.expiresAt).toLocaleDateString()}</span>{g.expired && <Badge className="ml-1">Expired</Badge>}</> : 'No end'}</td>
                  <td className="whitespace-nowrap border-b border-slate-200 px-2 py-2 text-center dark:border-slate-700">
                    <button className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Edit" onClick={() => setEditing(g)}><Pencil className="size-4" /></button>
                    <button className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title="Remove" onClick={() => confirm(`Remove ${g.userId?.name}'s access to ${g.unitId?.name}?`) && remove.mutate(g._id)}><Trash2 className="size-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {editing && <GrantSheet grant={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {person && <PersonSheet userId={person} onClose={() => setPerson(null)} onAdd={() => { setPerson(null); setEditing('new'); }} />}
    </>
  );
}

function GrantSheet({ grant, onClose }: { grant: Grant | null; onClose: () => void }) {
  const { data: meta } = useMeta();
  const [who, setWho] = useState<UserRow | null>(grant ? grant.userId : null);
  const [unit, setUnit] = useState<UnitRef | null>(grant?.unitId ? (grant.unitId as UnitRef) : null);
  const [rights, setRights] = useState<string[]>(grant?.rights ?? ['enter']);
  const [metrics, setMetrics] = useState<string[]>(grant?.metrics ?? []);
  const [until, setUntil] = useState(grant?.expiresAt ? grant.expiresAt.slice(0, 10) : '');
  const [note, setNote] = useState(grant?.note ?? '');
  const [search, setSearch] = useState('');
  const term = useDeferredValue(search);
  const users = useQuery({ queryKey: ['users', 'access-search', term], queryFn: () => get<{ items: UserRow[] }>(`/users?search=${encodeURIComponent(term)}&limit=15&status=active`), enabled: !who && term.length > 1 });
  const payload = () => ({ unitId: unit?._id, rights, metrics, expiresAt: until ? new Date(`${until}T23:59:59`).toISOString() : null, note: note || undefined });
  const save = useSave(() => (grant ? patch(`/org/access/${grant._id}`, payload()) : post('/org/access', { ...payload(), userId: who!._id })), [['org', 'access']], grant ? 'Access updated' : 'Access given', onClose);
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(undefined); };
  const toggle = (list: string[], set: (v: string[]) => void, k: string) => set(list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);
  const kpiRights = rights.some((r) => ['enter', 'edit', 'verify'].includes(r));

  return (
    <Sheet open onClose={onClose} title={grant ? `Access · ${grant.userId.name}` : 'Give access'}
      footer={<Button form="grant-form" type="submit" block disabled={!who || !unit || !rights.length} loading={save.isPending}>{grant ? 'Save' : 'Give access'}</Button>}>
      <form id="grant-form" onSubmit={submit} className="space-y-2.5">
        <Field label="Person">
          {() => who ? (
            <Card className="flex items-center gap-3 p-3">
              <UserRound className="size-5 text-slate-400" />
              <div className="min-w-0 flex-1"><div className="font-bold">{who.name}</div><div className="truncate text-xs text-slate-500">{who.designation ?? who.email}</div></div>
              {!grant && <Button type="button" size="sm" variant="ghost" onClick={() => setWho(null)}>Change</Button>}
            </Card>
          ) : (
            <div className="space-y-1.5">
              <Input autoFocus placeholder="Search name or email…" value={search} onChange={(e) => setSearch(e.target.value)} />
              {users.data?.items.map((u) => (
                <button type="button" key={u._id} onClick={() => setWho(u)} className="block w-full rounded-lg px-3 py-2 text-left text-sm ring-1 ring-slate-200 hover:bg-brand-50 dark:ring-slate-700">
                  <b>{u.name}</b> <span className="text-xs text-slate-500">{u.designation ?? u.email}</span>
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field label="Area" hint="The right covers this unit and everything below it">{() => <UnitField value={unit} onChange={setUnit} />}</Field>
        <Field label="Rights">
          {() => (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {RIGHTS.map((r) => (
                <label key={r.key} className={clsx('flex cursor-pointer items-start gap-2 rounded-lg p-2 ring-1', rights.includes(r.key) ? 'bg-brand-50 ring-brand-300 dark:bg-brand-500/10' : 'ring-slate-200 dark:ring-slate-700')}>
                  <input type="checkbox" className="mt-0.5 size-4 accent-brand-600" checked={rights.includes(r.key)} onChange={() => toggle(rights, setRights, r.key)} />
                  <span className="text-sm"><b className="font-medium">{r.label}</b><span className="block text-[12px] text-slate-500">{r.hint}</span></span>
                </label>
              ))}
            </div>
          )}
        </Field>
        {kpiRights && (
          <Field label="Only these KPIs" hint="Leave all unselected for every KPI">
            {() => (
              <div className="flex flex-wrap gap-1.5">
                {meta?.heads.map((h) => (
                  <button type="button" key={h.code} onClick={() => toggle(metrics, setMetrics, h.code)}
                    className={clsx('rounded-full px-2.5 py-1 text-xs font-medium ring-1', metrics.includes(h.code) ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700')}>
                    {h.name}
                  </button>
                ))}
              </div>
            )}
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Until (optional)">{(id) => <Input id={id} type="date" value={until} onChange={(e) => setUntil(e.target.value)} />}</Field>
          <Field label="Note (optional)">{(id) => <Input id={id} value={note} placeholder="e.g. Leave cover" onChange={(e) => setNote(e.target.value)} />}</Field>
        </div>
      </form>
    </Sheet>
  );
}

/** Everything one person can do: from their postings and from direct grants. */
function PersonSheet({ userId, onClose, onAdd }: { userId: string; onClose: () => void; onAdd: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['org', 'access', 'user', userId],
    queryFn: () => get<{ user: UserRow & { role: string }; isAdmin: boolean; fromPosts: { post: string; postLabel?: string; unit: { name: string; type: string }; rights: string[]; enters: string[]; verifies: string[] }[]; grants: Grant[] }>(`/org/access/user/${userId}`),
  });
  return (
    <Sheet open onClose={onClose} title={data ? `Rights · ${data.user.name}` : 'Rights'}>
      {isLoading || !data ? <Loading /> : (
        <div className="space-y-2.5">
          {data.isAdmin && <Card className="p-3 text-sm"><Badge tone="bg-amber-100 text-amber-800">Organisation {data.user.role}</Badge> — has every right everywhere.</Card>}
          <SectionTitle>From postings</SectionTitle>
          {!data.fromPosts.length ? <Card className="p-3 text-sm text-slate-500">No current posting.</Card> : data.fromPosts.map((p, i) => (
            <Card key={i} className="space-y-1.5 p-3 text-sm">
              <div><b>{p.postLabel}</b> · {p.unit?.name} <span className="text-xs text-slate-500">({UNIT_LABEL[p.unit?.type]})</span></div>
              <div className="flex flex-wrap gap-1">{p.rights.map((r) => <Badge key={r}>{LABEL[r] ?? r}</Badge>)}</div>
              {p.enters.length > 0 && <div className="text-xs text-slate-500">Enters: {p.enters.join(', ')}</div>}
              {p.verifies.length > 0 && <div className="text-xs text-slate-500">Verifies: {p.verifies.join(', ')}</div>}
            </Card>
          ))}
          <SectionTitle action={<Button size="sm" variant="ghost" onClick={onAdd}><Plus className="size-4" />Give access</Button>}>Direct grants</SectionTitle>
          {!data.grants.length ? <Card className="p-3 text-sm text-slate-500">None.</Card> : data.grants.map((g) => (
            <Card key={g._id} className="space-y-1 p-3 text-sm">
              <div><b>{g.unitId?.name}</b> and below{g.expiresAt && <span className="text-xs text-slate-500"> · until <span className="font-semibold">{new Date(g.expiresAt).toLocaleDateString()}</span></span>}</div>
              <div className="flex flex-wrap gap-1">{g.rights.map((r) => <Badge key={r} tone="bg-brand-50 text-brand-800">{LABEL[r] ?? r}</Badge>)}</div>
              {g.metrics.length > 0 && <div className="text-xs text-slate-500">KPIs: {g.metrics.join(', ')}</div>}
            </Card>
          ))}
        </div>
      )}
    </Sheet>
  );
}
