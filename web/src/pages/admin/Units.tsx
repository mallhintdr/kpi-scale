/**
 * Hierarchy manager — the organisation admin builds the tree of units level by level
 * (add, rename, re-code, move under another parent, deactivate, delete when empty).
 * Large trees are loaded in one go from a CSV under Bulk import.
 */
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, FolderTree, MoveRight, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/AppShell';
import { Badge, Button, Card, Empty, ErrorState, Field, Input, Loading, Sheet } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import { UNIT_LABEL, UNIT_PLURAL, levelIndex, levels } from '../../lib/rev';
import { useSave } from './shared';

interface UnitRow { _id: string; type: string; name: string; code?: string; parentId?: string | null; active: boolean; children: number; postings: number; levelLabel: string }

export default function Units() {
  const [trail, setTrail] = useState<UnitRow[]>([]);
  const parent = trail[trail.length - 1] ?? null;
  const [search, setSearch] = useState('');
  const term = useDeferredValue(search.trim());
  const key = ['org', 'units', term ? `s:${term}` : parent?._id ?? 'top'];
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => get<UnitRow[]>(term ? `/org/units?search=${encodeURIComponent(term)}` : `/org/units${parent ? `?parentId=${parent._id}` : ''}`),
  });
  const [editing, setEditing] = useState<UnitRow | 'new' | null>(null);
  const [moving, setMoving] = useState<UnitRow | null>(null);
  const remove = useSave((u: UnitRow) => del(`/org/units/${u._id}`), [['org', 'units'], ['rev']], 'Unit deleted');

  const childLevel = parent ? levels()[levelIndex(parent.type) + 1] : levels()[0];
  const lists = term ? 'Search results' : childLevel ? UNIT_PLURAL[childLevel.key] : 'Nothing can sit below this level';

  return (
    <>
      <PageHeader
        title="Hierarchy"
        subtitle={levels().map((l) => l.label).join(' › ')}
        actions={
          <div className="flex gap-2">
            <Link to="/admin/import" className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-brand-700 ring-1 ring-brand-200 hover:bg-brand-50"><Upload className="size-4" />Import CSV</Link>
            {childLevel && !term && <Button size="sm" onClick={() => setEditing('new')}><Plus className="size-4" />Add {UNIT_LABEL[childLevel.key]}</Button>}
          </div>
        }
      />

      <Card className="mb-3 space-y-3 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input className="pl-9" placeholder="Search any unit by name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {!term && (
          <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Path">
            <button className="font-medium text-brand-700 hover:underline" onClick={() => setTrail([])}>Top</button>
            {trail.map((u, i) => (
              <span key={u._id} className="flex items-center gap-1">
                <ChevronRight className="size-3.5 text-slate-400" />
                <button className="font-medium text-brand-700 hover:underline" onClick={() => setTrail(trail.slice(0, i + 1))}>{u.name}</button>
              </span>
            ))}
          </nav>
        )}
      </Card>

      <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{lists}</div>
      {isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : !data?.length ? (
        <Card><Empty icon={FolderTree} title={term ? 'No matching units' : `No ${childLevel ? UNIT_PLURAL[childLevel.key].toLowerCase() : 'units'} yet`} body={childLevel && !term ? 'Add them one by one, or import a CSV for the whole tree.' : undefined} /></Card>
      ) : (
        <Card className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.map((u) => (
            <div key={u._id} className="flex items-center gap-2 px-3 py-2.5">
              <button className="min-w-0 flex-1 text-left" disabled={!u.children && levelIndex(u.type) >= levels().length - 1} onClick={() => { setSearch(''); setTrail(term ? [u] : [...trail, u]); }}>
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{u.name}</span>
                  {u.code && <span className="font-mono text-[11px] text-slate-400">{u.code}</span>}
                  {!u.active && <Badge tone="bg-slate-200 text-slate-600">Inactive</Badge>}
                </div>
                <div className="text-xs text-slate-500">{u.levelLabel} · {u.children} below · {u.postings} posting{u.postings === 1 ? '' : 's'}</div>
              </button>
              <button className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Edit" onClick={() => setEditing(u)}><Pencil className="size-4" /></button>
              {levelIndex(u.type) > 0 && <button className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Move under another parent" onClick={() => setMoving(u)}><MoveRight className="size-4" /></button>}
              <button className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30" title={u.children || u.postings ? 'Has units or postings below' : 'Delete'} disabled={!!u.children || !!u.postings}
                onClick={() => confirm(`Delete ${u.name}?`) && remove.mutate(u)}><Trash2 className="size-4" /></button>
              {(u.children > 0 || levelIndex(u.type) < levels().length - 1) && <ChevronRight className="size-4 text-slate-300" />}
            </div>
          ))}
        </Card>
      )}

      {editing && <UnitSheet unit={editing === 'new' ? null : editing} parent={parent} level={childLevel?.key} onClose={() => setEditing(null)} />}
      {moving && <MoveSheet unit={moving} onClose={() => setMoving(null)} />}
    </>
  );
}

function UnitSheet({ unit, parent, level, onClose }: { unit: UnitRow | null; parent: UnitRow | null; level?: string; onClose: () => void }) {
  const [f, setF] = useState({ name: unit?.name ?? '', code: unit?.code ?? '', active: unit?.active ?? true });
  const save = useSave(
    () => (unit ? patch(`/org/units/${unit._id}`, { name: f.name, code: f.code || undefined, active: f.active }) : post('/org/units', { name: f.name, code: f.code || undefined, parentId: parent?._id ?? null })),
    [['org', 'units'], ['rev']],
    unit ? 'Unit updated' : 'Unit added',
    onClose,
  );
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(undefined); };
  return (
    <Sheet open onClose={onClose} title={unit ? `Edit ${unit.name}` : `New ${UNIT_LABEL[level ?? '']}${parent ? ` in ${parent.name}` : ''}`}
      footer={<Button form="unit-form" type="submit" block loading={save.isPending}>{unit ? 'Save' : 'Add'}</Button>}>
      <form id="unit-form" onSubmit={submit} className="space-y-4">
        <Field label="Name">{(id) => <Input id={id} required autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Code" hint="Unique; used to match rows in CSV imports">{(id) => <Input id={id} className="font-mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />}</Field>
        {unit && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-brand-600" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
            Active (inactive units keep their history but are hidden from new work)
          </label>
        )}
      </form>
    </Sheet>
  );
}

function MoveSheet({ unit, onClose }: { unit: UnitRow; onClose: () => void }) {
  const parentLevel = levels()[levelIndex(unit.type) - 1];
  const [search, setSearch] = useState('');
  const term = useDeferredValue(search.trim());
  const options = useQuery({ queryKey: ['org', 'units', 'move', term], queryFn: () => get<UnitRow[]>(`/org/units?search=${encodeURIComponent(term)}`), enabled: term.length > 1 });
  const move = useSave((parentId: string) => post(`/org/units/${unit._id}/move`, { parentId }), [['org', 'units'], ['rev']], `${unit.name} moved`, onClose);
  return (
    <Sheet open onClose={onClose} title={`Move ${unit.name}`}>
      <p className="mb-3 text-sm text-slate-500">Choose the new {UNIT_LABEL[parentLevel?.key ?? ''].toLowerCase()}. Everything below {unit.name}, and all its recorded figures, move with it.</p>
      <Input autoFocus placeholder={`Search ${UNIT_PLURAL[parentLevel?.key ?? ''].toLowerCase()}…`} value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="mt-3 space-y-1.5">
        {options.data?.filter((u) => u.type === parentLevel?.key && u._id !== unit.parentId).map((u) => (
          <Card key={u._id} className="flex items-center justify-between gap-2 p-3">
            <span className="font-medium">{u.name}</span>
            <Button size="sm" loading={move.isPending} onClick={() => move.mutate(u._id)}>Move here</Button>
          </Card>
        ))}
      </div>
    </Sheet>
  );
}
