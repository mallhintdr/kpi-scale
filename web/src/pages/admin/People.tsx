import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronRight, Plus, Search } from 'lucide-react';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Badge, Button, Card, Empty, ErrorState, Field, Input, Loading, PasswordInput, Select, Sheet } from '../../components/ui';
import { get, patch, post, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { Role, UserRow } from '../../lib/types';
import { clean, useSave } from './shared';

const ROLES: Role[] = ['employee', 'manager', 'admin', 'owner'];

export default function People() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const term = useDeferredValue(search);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['users', term, page],
    queryFn: () => get<{ items: UserRow[]; total: number; limit: number }>(`/users${qs({ search: term, page, limit: 30 })}`),
    placeholderData: keepPreviousData,
  });
  const pages = data ? Math.ceil(data.total / data.limit) : 1;

  return (
    <>
      <PageHeader title="People" subtitle={data && `${data.total} people`} actions={<Button size="sm" onClick={() => setEditing('new')}><Plus className="size-4" />Add</Button>} />
      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input type="search" placeholder="Name, email, code…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="pl-9" />
        </div>
      </div>

      {isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : !data?.items.length ? (
        <Card><Empty title="No people found" /></Card>
      ) : (
        <>
          <Card className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.items.map((u) => (
              <button key={u._id} onClick={() => setEditing(u)} className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-slate-50 dark:active:bg-slate-800">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`truncate font-medium ${u.status === 'disabled' ? 'text-slate-400 line-through' : ''}`}>{u.name}</span>
                    {u.role !== 'employee' && <Badge className="capitalize">{u.role}</Badge>}
                  </div>
                  <div className="truncate text-xs text-slate-500">{u.charges?.length ? u.charges.map((c) => `${c.postLabel}, ${c.unit}`).join(' · ') : <span className="text-amber-600">{u.designation ?? 'Not posted'}</span>}</div>
                </div>
                <ChevronRight className="size-4 text-slate-300" />
              </button>
            ))}
          </Card>
          {pages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <span className="text-sm text-slate-500">Page {page} of {pages}</span>
              <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          )}
        </>
      )}
      {editing && <UserSheet user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function UserSheet({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const { session, can } = useAuth();
  const [f, setF] = useState({
    name: user?.name ?? '',
    email: user?.email ?? '',
    role: user?.role ?? 'employee',
    designation: user?.designation ?? '',
    employeeCode: user?.employeeCode ?? '',
    phone: user?.phone ?? '',
    bps: user?.bps ? String(user.bps) : '',
    password: '',
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const keys = [['users'], ['rev']];
  const save = useSave(
    () => {
      const body = clean({ ...f, bps: f.bps ? Number(f.bps) : null, password: f.password || undefined });
      return user ? patch(`/users/${user._id}`, body) : post('/users', body);
    },
    keys, user ? 'Saved' : 'Person added', onClose,
  );
  const toggle = useSave(() => patch(`/users/${user!._id}`, { status: user!.status === 'disabled' ? 'active' : 'disabled' }), keys, user?.status === 'disabled' ? 'Re-activated' : 'Deactivated', onClose);
  const isSelf = user?._id === session!.user.id;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined);
  };

  return (
    <Sheet open onClose={onClose} title={user ? 'Edit person' : 'Add person'} footer={<Button form="user-form" type="submit" block loading={save.isPending}>Save</Button>}>
      <form id="user-form" onSubmit={submit} className="space-y-4">
        <Field label="Full name">{(id) => <Input id={id} required minLength={2} value={f.name} onChange={set('name')} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" required value={f.email} onChange={set('email')} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Designation">{(id) => <Input id={id} value={f.designation} onChange={set('designation')} />}</Field>
          <Field label="Employee code">{(id) => <Input id={id} value={f.employeeCode} onChange={set('employeeCode')} />}</Field>
        </div>
        <Field label="Phone">{(id) => <Input id={id} type="tel" inputMode="tel" value={f.phone} onChange={set('phone')} />}</Field>
        <Field label="BPS">{(id) => <Input id={id} type="number" inputMode="numeric" min={1} max={22} value={f.bps} onChange={set('bps')} />}</Field>
        <p className="text-xs text-slate-500">Postings (charge of a division, district, tehsil, qanungoi or circle) are managed under Postings.</p>
        <Field label="Role">
          {(id) => (
            <Select id={id} value={f.role} onChange={set('role')} disabled={isSelf}>
              {ROLES.filter((r) => r !== 'owner' || can('owner')).map((r) => <option key={r} value={r} className="capitalize">{r}</option>)}
            </Select>
          )}
        </Field>
        <Field label={user ? 'Reset password (optional)' : 'Initial password'} hint="At least 8 characters with a letter and a number">
          {(id) => <PasswordInput id={id} autoComplete="new-password" required={!user} minLength={8} value={f.password} onChange={set('password')} />}
        </Field>
        {user && !isSelf && (
          <Button type="button" variant={user.status === 'disabled' ? 'secondary' : 'danger'} block loading={toggle.isPending} onClick={() => toggle.mutate(undefined)}>
            {user.status === 'disabled' ? 'Re-activate account' : 'Deactivate account'}
          </Button>
        )}
      </form>
    </Sheet>
  );
}
