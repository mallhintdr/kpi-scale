import { useEffect, useState, type FormEvent } from 'react';
import { DEFAULT_TENANT, SINGLE_TENANT } from '../lib/edition';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Building2, ChevronRight } from 'lucide-react';
import { ApiError, get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Card, Field, FormError, Input, OrgLogo, PasswordInput } from '../components/ui';

const EMAIL_KEY = 'remembered-email';
const ORG_KEY = 'last-org';
const read = (k: string) => {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
};

/** Demo link (/guest): signs the visitor in as the read-only guest account and opens the dashboard. */
export function GuestLogin() {
  const { session, setSession } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    post<any>('/auth/guest', {})
      .then((data) => { try { sessionStorage.setItem('guest', '1'); } catch { /* storage unavailable */ } setSession(data); navigate('/', { replace: true }); })
      .catch(setError);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (session && !error) return null;
  return (
    <div className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-brand-600 to-brand-800 p-4">
      <Card className="w-full max-w-sm space-y-3 p-5 text-center">
        {error ? <><FormError error={error} /><Button block onClick={() => navigate('/login')}>Go to sign-in</Button></> : <p className="text-sm text-slate-600">Opening the demo dashboard…</p>}
      </Card>
    </div>
  );
}

interface Brand { name: string; slug: string; branding: { shortName?: string; tagline?: string; logoUrl?: string } }

/**
 * Sign-in. One domain serves every organisation: /login?org=<slug> (or the organisation last used on
 * this device) shows that organisation's name and logo; otherwise the neutral platform identity.
 */
export default function Login() {
  const { session, setSession } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const slug = SINGLE_TENANT ? DEFAULT_TENANT : params.get('org') ?? read(ORG_KEY);
  const [brand, setBrand] = useState<Brand | null>(null);
  const [form, setForm] = useState({ email: read(EMAIL_KEY), password: '' });
  const [remember, setRemember] = useState(true);
  const [orgs, setOrgs] = useState<{ slug: string; name: string }[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [guest, setGuest] = useState(false);
  useEffect(() => { get<{ guest?: boolean }>('/config').then((c) => setGuest(!!c.guest)).catch(() => {}); }, []);
  useEffect(() => {
    if (!slug) return;
    get<Brand>(`/auth/branding/${encodeURIComponent(slug)}`).then(setBrand).catch(() => setBrand(null));
  }, [slug]);

  if (session) return <Navigate to={session.tenant.isPlatform ? '/platform' : '/'} replace />;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e?: FormEvent, tenantSlug?: string) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await post<any>('/auth/login', { email: form.email, password: form.password, tenantSlug, remember });
      write(EMAIL_KEY, remember ? form.email : null);
      if (!data.tenant.isPlatform) write(ORG_KEY, data.tenant.slug);
      setSession(data);
      navigate(data.tenant.isPlatform ? '/platform' : '/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 300) setOrgs(err.body.organisations);
      else setError(err);
    } finally {
      setBusy(false);
    }
  }

  const tagline = brand?.branding.tagline ?? (brand ? brand.name : 'Performance management');
  const title = brand ? (brand.branding.shortName ?? brand.name) : 'KPI Dashboard';

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-gradient-to-b from-brand-600 to-brand-800 px-4 py-4 pt-safe pb-safe">
      <div className="w-full max-w-sm">
        <div className="mb-4 flex items-center gap-3 text-white">
          <OrgLogo src={brand?.branding.logoUrl} className="size-16 shrink-0" />
          <div className="min-w-0 border-l-2 border-gold-500 pl-3 leading-tight">
            <div className="truncate text-[11px] font-bold uppercase tracking-[0.14em] text-gold-400">{tagline}</div>
            <h1 className="text-lg font-bold">{title}</h1>
            <div className="text-xs text-brand-100">Employee Performance Dashboard</div>
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
            <form onSubmit={(e) => submit(e, brand?.slug)} className="space-y-3">
              <h2 className="text-base font-semibold">Sign in</h2>
              <Field label="Email">{(id) => <Input id={id} type="email" required autoComplete="email" inputMode="email" value={form.email} onChange={set('email')} placeholder="you@example.com" />}</Field>
              <Field label="Password">{(id) => <PasswordInput id={id} required autoComplete="current-password" value={form.password} onChange={set('password')} />}</Field>
              <label className="flex h-9 cursor-pointer select-none items-center gap-2.5 text-sm" title={remember ? 'Stay signed in on this device for 30 days' : 'Sign out when the browser is closed'}>
                <input type="checkbox" className="size-[18px] rounded accent-brand-600" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                Remember me
              </label>
              <FormError error={error} />
              <Button type="submit" block loading={busy}>Sign in</Button>
              {guest && <Button type="button" variant="secondary" block onClick={() => navigate('/guest')}>View Demo as Guest</Button>}
              {brand && !SINGLE_TENANT && (
                <button type="button" className="w-full text-center text-xs text-slate-500 hover:underline" onClick={() => { write(ORG_KEY, null); setBrand(null); navigate('/login', { replace: true }); }}>
                  Not with {brand.name}? Sign in to another organisation
                </button>
              )}
            </form>
          )}
        </div>
        <p className="mt-3 text-center text-[11px] text-brand-100">© {new Date().getFullYear()} {brand?.branding.tagline ?? brand?.name ?? 'KPI Dashboard'}</p>
      </div>
    </div>
  );
}
