/**
 * Platform console (super-admin only): create organisations from templates — each with fully
 * separate data — create their first administrator, and suspend / reactivate them.
 * Everything inside an organisation is then configured by that organisation's own admin.
 */
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Building2, Copy, LogOut, Plus, Search, ShieldOff, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Empty, ErrorState, Field, Input, Loading, OrgLogo, PasswordInput, Select, Sheet, Spinner, useToast } from '../../components/ui';
import { get, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useSave } from '../admin/shared';

interface TenantRow {
  _id: string; name: string; slug: string; status: 'active' | 'suspended'; plan: string; industry?: string; createdAt: string;
  limits?: { maxUsers?: number; maxUnits?: number };
  stats: { users: number; units: number; postings: number; entries: number };
  blueprint: { version: number; name?: string; kpis: number } | null;
}
interface Template { key: string; label: string; category: string; description: string; levels: string[]; kpis: number }

export default function Platform() {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['platform', 'tenants'], queryFn: () => get<TenantRow[]>('/platform/tenants') });
  const [creating, setCreating] = useState(false);
  const [admins, setAdmins] = useState<TenantRow | null>(null);
  const [search, setSearch] = useState('');
  const toast = useToast();
  const setStatus = useSave((v: { id: string; status: string }) => patch(`/platform/tenants/${v.id}`, { status: v.status }), [['platform']], 'Organisation updated');
  const list = (data ?? []).filter((t) => !search || `${t.name} ${t.slug} ${t.industry ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const totals = (data ?? []).reduce((a, t) => ({ orgs: a.orgs + 1, active: a.active + (t.status === 'active' ? 1 : 0), users: a.users + t.stats.users, units: a.units + t.stats.units }), { orgs: 0, active: 0, users: 0, units: 0 });

  return (
    <div className="min-h-dvh bg-slate-50 dark:bg-slate-950">
      <header className="pt-safe sticky top-0 z-30 border-b-[3px] border-gold-500 bg-brand-700 text-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-3">
          <OrgLogo className="size-9" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-gold-400">Platform console</div>
            <div className="truncate text-sm font-semibold">KPI Dashboard · {session?.user.name}</div>
          </div>
          <button className="grid size-10 place-items-center rounded-lg hover:bg-white/15" title="Sign out" onClick={() => logout().then(() => navigate('/login'))}><LogOut className="size-[18px]" /></button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-3 py-4">
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { l: 'Organisations', v: totals.orgs },
            { l: 'Active', v: totals.active },
            { l: 'People', v: totals.users.toLocaleString() },
            { l: 'Units', v: totals.units.toLocaleString() },
          ].map((s) => (
            <Card key={s.l} className="p-3">
              <div className="text-2xl font-bold tabular-nums">{s.v}</div>
              <div className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">{s.l}</div>
            </Card>
          ))}
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input className="pl-9" placeholder="Search organisations…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Button onClick={() => setCreating(true)}><Plus className="size-4" />New organisation</Button>
        </div>

        {isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : !list.length ? (
          <Card><Empty icon={Building2} title="No organisations yet" body="Create one from a template; its administrator then sets up the hierarchy, posts and KPIs." /></Card>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {list.map((t) => (
              <Card key={t._id} className={clsx('p-4', t.status === 'suspended' && 'opacity-70')}>
                <div className="flex items-start gap-3">
                  <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-500/15"><Building2 className="size-5" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{t.name}</div>
                    <div className="truncate text-xs text-slate-500">{t.industry ?? '—'} · {t.slug} · since <span className="font-semibold">{new Date(t.createdAt).toLocaleDateString()}</span></div>
                  </div>
                  <Badge tone={t.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}>{t.status}</Badge>
                </div>
                <div className="mt-3 grid grid-cols-4 gap-1 text-center">
                  {[['People', t.stats.users], ['Units', t.stats.units], ['Postings', t.stats.postings], ['Entries', t.stats.entries]].map(([l, v]) => (
                    <div key={l as string} className="rounded-lg bg-slate-50 py-1.5 dark:bg-slate-800"><div className="text-sm font-bold tabular-nums">{(v as number).toLocaleString()}</div><div className="text-[11px] uppercase tracking-wide text-slate-500">{l}</div></div>
                  ))}
                </div>
                <div className="mt-2 text-xs text-slate-500">{t.blueprint ? `Setup v${t.blueprint.version} · ${t.blueprint.kpis} KPIs` : 'Not configured'} · plan {t.plan}{t.limits?.maxUsers ? ` · up to ${t.limits.maxUsers.toLocaleString()} people` : ''}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setAdmins(t)}><Users className="size-4" />Admins</Button>
                  <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard?.writeText(`${location.origin}/login?org=${t.slug}`); toast('Sign-in link copied'); }}><Copy className="size-4" />Sign-in link</Button>
                  {t.status === 'active' ? (
                    <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => confirm(`Suspend ${t.name}? Everyone in it is signed out.`) && setStatus.mutate({ id: t._id, status: 'suspended' })}><ShieldOff className="size-4" />Suspend</Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: t._id, status: 'active' })}><ShieldCheck className="size-4" />Reactivate</Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </main>

      {creating && <CreateSheet onClose={() => setCreating(false)} />}
      {admins && <AdminsSheet tenant={admins} onClose={() => setAdmins(null)} />}
    </div>
  );
}

function CreateSheet({ onClose }: { onClose: () => void }) {
  const templates = useQuery({ queryKey: ['platform', 'templates'], queryFn: () => get<Template[]>('/platform/templates') });
  const [f, setF] = useState({ name: '', slug: '', industry: '', template: 'blank', plan: 'pro', maxUsers: '', adminName: '', adminEmail: '', adminPassword: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const save = useSave(
    () => post('/platform/tenants', {
      name: f.name, slug: f.slug || undefined, industry: f.industry || undefined, template: f.template, plan: f.plan,
      maxUsers: f.maxUsers ? Number(f.maxUsers) : undefined,
      admin: { name: f.adminName, email: f.adminEmail, password: f.adminPassword },
    }),
    [['platform']], 'Organisation created', onClose,
  );
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(undefined); };
  const tpl = templates.data?.find((t) => t.key === f.template);
  return (
    <Sheet open onClose={onClose} title="New organisation" footer={<Button form="org-form" type="submit" block loading={save.isPending}>Create organisation</Button>}>
      <form id="org-form" onSubmit={submit} className="space-y-2.5">
        <Field label="Organisation name">{(id) => <Input id={id} required minLength={2} value={f.name} onChange={set('name')} placeholder="e.g. Acme Marketing (Pvt) Ltd" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Short id (optional)" hint="Used in its sign-in link">{(id) => <Input id={id} pattern="[a-z0-9-]{2,40}" value={f.slug} onChange={set('slug')} placeholder="acme" />}</Field>
          <Field label="Industry">{(id) => <Input id={id} value={f.industry} onChange={set('industry')} placeholder="Marketing" />}</Field>
        </div>
        <Field label="Start from template" hint="The organisation's admin can change everything afterwards">
          {(id) => templates.isLoading ? <Spinner /> : (
            <Select id={id} value={f.template} onChange={set('template')}>
              {[...new Set(templates.data?.map((t) => t.category))].map((c) => (
                <optgroup key={c} label={c}>{templates.data?.filter((t) => t.category === c).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</optgroup>
              ))}
            </Select>
          )}
        </Field>
        {tpl && <Card className="p-3 text-xs text-slate-600 dark:text-slate-300">{tpl.description}<div className="mt-1 text-slate-400">{tpl.levels.join(' › ')} · {tpl.kpis} KPIs</div></Card>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Plan">{(id) => <Select id={id} value={f.plan} onChange={set('plan')}><option value="free">Free</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></Select>}</Field>
          <Field label="Max people (optional)">{(id) => <Input id={id} type="number" min={1} value={f.maxUsers} onChange={set('maxUsers')} placeholder="5000" />}</Field>
        </div>
        <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><UserPlus className="size-4" />First administrator</div>
          <div className="space-y-2.5">
            <Field label="Name">{(id) => <Input id={id} required minLength={2} value={f.adminName} onChange={set('adminName')} />}</Field>
            <Field label="Email">{(id) => <Input id={id} type="email" required value={f.adminEmail} onChange={set('adminEmail')} />}</Field>
            <Field label="Temporary password" hint="8+ characters with a letter and a number">{(id) => <PasswordInput id={id} required minLength={8} value={f.adminPassword} onChange={set('adminPassword')} />}</Field>
          </div>
        </div>
      </form>
    </Sheet>
  );
}

function AdminsSheet({ tenant, onClose }: { tenant: TenantRow; onClose: () => void }) {
  const list = useQuery({ queryKey: ['platform', 'admins', tenant._id], queryFn: () => get<{ _id: string; name: string; email: string; role: string; status: string; lastLoginAt?: string }[]>(`/platform/tenants/${tenant._id}/admins`) });
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const add = useSave(() => post(`/platform/tenants/${tenant._id}/admins`, f), [['platform']], 'Administrator added', () => setF({ name: '', email: '', password: '' }));
  return (
    <Sheet open onClose={onClose} title={`Administrators · ${tenant.name}`}>
      {list.isLoading ? <Loading /> : (
        <Card className="mb-3 divide-y divide-slate-100 dark:divide-slate-800">
          {list.data?.map((a) => (
            <div key={a._id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{a.name}</div><div className="truncate text-xs text-slate-500">{a.email}</div></div>
              <Badge>{a.role}</Badge>
              <span className="text-[12px] text-slate-400">{a.lastLoginAt ? `seen ${new Date(a.lastLoginAt).toLocaleDateString()}` : 'never signed in'}</span>
            </div>
          ))}
        </Card>
      )}
      <form onSubmit={(e) => { e.preventDefault(); add.mutate(undefined); }} className="space-y-2.5">
        <div className="text-sm font-semibold">Add administrator</div>
        <Input required minLength={2} placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input required type="email" placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <PasswordInput required minLength={8} placeholder="Temporary password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <Button type="submit" block loading={add.isPending}><UserPlus className="size-4" />Add</Button>
      </form>
    </Sheet>
  );
}
