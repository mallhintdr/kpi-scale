import { useQuery } from '@tanstack/react-query';
import { Plus, Search, UserMinus } from 'lucide-react';
import { useDeferredValue, useEffect, useState, type FormEvent } from 'react';
import { PageHeader } from '../../components/AppShell';
import { UnitField } from '../../components/rev';
import { Badge, Button, Card, Empty, ErrorState, Field, FormError, Input, Loading, SectionTitle, Select, Sheet } from '../../components/ui';
import { get, post } from '../../lib/api';
import { fmtDate } from '../../lib/format';
import { UNIT_LABEL, getOrg, useCaps, useMeta, type Post, type UnitRef } from '../../lib/rev';
import type { UserRow } from '../../lib/types';
import { useSave } from './shared';

interface ChargeRow { _id: string; post: Post; postLabel: string; chargeType: string; from: string; to?: string; active: boolean; userId: { _id: string; name: string; designation?: string; bps?: number } }

const postsFor = (level: string): Post[] => (getOrg()?.posts ?? []).filter((p) => p.levels.includes(level)).map((p) => p.key);

export default function Postings() {
  const caps = useCaps();
  const [unit, setUnit] = useState<UnitRef | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (!unit && caps.roots[0]) setUnit(caps.roots[0]);
  }, [caps.roots, unit]);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['rev', 'charges', unit?._id], queryFn: () => get<ChargeRow[]>(`/rev/charges?unitId=${unit!._id}`), enabled: !!unit });
  const end = useSave((id: string) => post(`/rev/charges/${id}/end`), [['rev']], 'Charge ended');
  const active = data?.filter((c) => c.active) ?? [];
  const past = data?.filter((c) => !c.active) ?? [];

  return (
    <>
      <PageHeader title="Postings" subtitle="Who holds charge of each unit" actions={unit && postsFor(unit.type).length > 0 && <Button size="sm" onClick={() => setAdding(true)}><Plus className="size-4" />Post officer</Button>} />
      <div className="mb-3"><UnitField value={unit} onChange={setUnit} scope="work" /></div>
      {isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : (
        <>
          <SectionTitle>Current · {unit && UNIT_LABEL[unit.type]}</SectionTitle>
          {!active.length ? <Card><Empty title="Vacant" body="No officer currently holds charge here." /></Card> : (
            <Card className="divide-y divide-slate-100 dark:divide-slate-800">
              {active.map((c) => (
                <div key={c._id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-bold">{c.userId.name}{c.userId.bps && <span className="ml-1 text-xs text-slate-400">BPS-{c.userId.bps}</span>}</div>
                    <div className="text-xs text-slate-500">{c.postLabel} · since <span className="font-semibold">{fmtDate(c.from, { day: 'numeric', month: 'short', year: 'numeric' })}</span></div>
                  </div>
                  {c.chargeType !== 'regular' && <Badge>{c.chargeType === 'additional' ? 'Addl. charge' : 'Look after'}</Badge>}
                  <Button size="sm" variant="ghost" onClick={() => confirm(`End ${c.userId.name}'s charge as ${c.postLabel}?`) && end.mutate(c._id)}><UserMinus className="size-4" /></Button>
                </div>
              ))}
            </Card>
          )}
          {past.length > 0 && (
            <>
              <SectionTitle>History</SectionTitle>
              <Card className="divide-y divide-slate-100 dark:divide-slate-800">
                {past.map((c) => (
                  <div key={c._id} className="px-4 py-2 text-sm text-slate-500">
                    {c.userId.name} · {c.postLabel} · <span className="font-semibold">{fmtDate(c.from)}</span> – <span className="font-semibold">{fmtDate(c.to)}</span>
                  </div>
                ))}
              </Card>
            </>
          )}
        </>
      )}
      {adding && unit && <PostSheet unit={unit} onClose={() => setAdding(false)} />}
    </>
  );
}

function PostSheet({ unit, onClose }: { unit: UnitRef; onClose: () => void }) {
  const { data: meta } = useMeta();
  const posts = postsFor(unit.type);
  const [postCode, setPost] = useState<Post>(posts[0]);
  const [chargeType, setChargeType] = useState('regular');
  const [search, setSearch] = useState('');
  const term = useDeferredValue(search);
  const [who, setWho] = useState<UserRow | null>(null);
  const users = useQuery({ queryKey: ['users', 'post-search', term], queryFn: () => get<{ items: UserRow[] }>(`/users?search=${encodeURIComponent(term)}&limit=20&status=active`), enabled: term.length > 1 });
  const save = useSave(() => post('/rev/charges', { userId: who!._id, unitId: unit._id, post: postCode, chargeType }), [['rev']], 'Officer posted', onClose);
  const label = (p: Post) => meta?.posts.find((x) => x.key === p)?.label ?? p;
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(undefined); };
  return (
    <Sheet open onClose={onClose} title={`Post to ${unit.name}`} footer={<Button form="post-form" type="submit" block disabled={!who} loading={save.isPending}>Post officer</Button>}>
      <form id="post-form" onSubmit={submit} className="space-y-2.5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Post">{(id) => <Select id={id} value={postCode} onChange={(e) => setPost(e.target.value as Post)}>{posts.map((p) => <option key={p} value={p}>{label(p)}</option>)}</Select>}</Field>
          <Field label="Charge">{(id) => <Select id={id} value={chargeType} onChange={(e) => setChargeType(e.target.value)}><option value="regular">Regular</option><option value="additional">Additional charge</option><option value="look_after">Look after</option></Select>}</Field>
        </div>
        {who ? (
          <Card className="flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1"><div className="font-bold">{who.name}</div><div className="text-xs text-slate-500">{who.designation} · {who.email}</div></div>
            <Button type="button" size="sm" variant="ghost" onClick={() => setWho(null)}>Change</Button>
          </Card>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input placeholder="Search officer by name, email or code" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
            </div>
            {users.data?.items.length ? (
              <Card className="max-h-60 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
                {users.data.items.map((u) => (
                  <button type="button" key={u._id} onClick={() => setWho(u)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
                    <div className="min-w-0"><div className="truncate text-sm font-bold">{u.name}</div><div className="truncate text-xs text-slate-500">{u.designation} · {u.email}</div></div>
                  </button>
                ))}
              </Card>
            ) : term.length > 1 && !users.isLoading ? <p className="text-sm text-slate-500">No match. Add the officer under People first.</p> : null}
          </div>
        )}
        <FormError error={save.error} />
      </form>
    </Sheet>
  );
}
