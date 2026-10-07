import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Building2, ChevronRight } from 'lucide-react';
import { ApiError, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Card, Field, FormError, GovLogo, Input, PasswordInput, Segmented } from '../components/ui';

const EMAIL_KEY = 'remembered-email';
const readRememberedEmail = () => {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
};
const writeRememberedEmail = (email: string | null) => {
  try {
    if (email) localStorage.setItem(EMAIL_KEY, email);
    else localStorage.removeItem(EMAIL_KEY);
  } catch {
    /* storage unavailable */
  }
};

export default function Login() {
  const { session, setSession } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [form, setForm] = useState({ email: readRememberedEmail(), password: '', name: '', orgName: '' });
  const [remember, setRemember] = useState(true);
  const [orgs, setOrgs] = useState<{ slug: string; name: string }[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to="/" replace />;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e?: FormEvent, tenantSlug?: string) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data =
        mode === 'login'
          ? await post('/auth/login', { email: form.email, password: form.password, tenantSlug, remember })
          : await post('/auth/register-org', form);
      if (mode === 'login') writeRememberedEmail(remember ? form.email : null);
      setSession(data);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 300) setOrgs(err.body.organisations);
      else setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-gradient-to-b from-brand-600 to-brand-800 px-4 py-4 pt-safe pb-safe">
      <div className="w-full max-w-sm">
      <div className="mb-4 flex items-center gap-3 text-white">
        <GovLogo className="size-16 shrink-0" />
        <div className="min-w-0 border-l-2 border-gold-500 pl-3 leading-tight">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-gold-400">Government of the Punjab</div>
          <h1 className="text-lg font-bold">Employee Performance Dashboard</h1>
        </div>
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-xl dark:bg-slate-900">
        {orgs ? (
          <div className="space-y-3">
            <h2 className="text-lg font-semibold">Choose your organisation</h2>
            <p className="text-sm text-slate-500">Your email is linked to more than one organisation.</p>
            {orgs.map((o) => (
              <Card key={o.slug} onClick={() => submit(undefined, o.slug)} className="flex items-center gap-3 p-4">
                <Building2 className="size-5 text-brand-600" />
                <span className="flex-1 font-medium">{o.name}</span>
                <ChevronRight className="size-5 text-slate-400" />
              </Card>
            ))}
            <Button variant="ghost" block onClick={() => setOrgs(null)}>Back</Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <Segmented value={mode} onChange={(m) => { setMode(m); setError(null); }} options={[{ value: 'login', label: 'Sign in' }, { value: 'signup', label: 'Register department' }]} />
            {mode === 'signup' && (
              <>
                <Field label="Organisation name">{(id) => <Input id={id} required minLength={2} value={form.orgName} onChange={set('orgName')} placeholder="e.g. Punjab Police — Lahore Region" />}</Field>
                <Field label="Your name">{(id) => <Input id={id} required minLength={2} autoComplete="name" value={form.name} onChange={set('name')} />}</Field>
              </>
            )}
            <Field label="Email">{(id) => <Input id={id} type="email" required autoComplete="email" inputMode="email" value={form.email} onChange={set('email')} placeholder="you@example.com" />}</Field>
            <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters with a letter and a number' : undefined}>
              {(id) => <PasswordInput id={id} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={set('password')} />}
            </Field>
            {mode === 'login' && (
              <label className="flex h-9 cursor-pointer select-none items-center gap-2.5 text-sm" title={remember ? 'Stay signed in on this device for 30 days' : 'Sign out when the browser is closed'}>
                <input type="checkbox" className="size-[18px] rounded accent-brand-600" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                Remember me
              </label>
            )}
            <FormError error={error} />
            <Button type="submit" block loading={busy}>{mode === 'login' ? 'Sign in' : 'Create organisation'}</Button>
          </form>
        )}
      </div>
      <p className="mt-3 text-center text-[11px] text-brand-100">© {new Date().getFullYear()} Government of the Punjab</p>
      </div>
    </div>
  );
}
