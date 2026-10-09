import clsx from 'clsx';
import { useAuth } from '../lib/auth';
import { X, Loader2, Inbox, AlertTriangle, Eye, EyeOff } from 'lucide-react';
import {
  createContext, forwardRef, useCallback, useContext, useEffect, useId, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { BAND, initials, scoreColor } from '../lib/format';
import type { Band } from '../lib/types';

/* ---------- Button ---------- */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-700 shadow-sm',
  secondary: 'bg-white text-slate-800 ring-1 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-700 dark:hover:bg-slate-800',
  ghost: 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
  danger: 'bg-rose-600 text-white hover:bg-rose-700',
};
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; size?: 'sm' | 'md'; block?: boolean }>(
  ({ variant = 'primary', loading, size = 'md', block, className, children, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:opacity-50 disabled:pointer-events-none select-none',
        size === 'md' ? 'h-11 px-4 text-[15px]' : 'h-9 px-3 text-sm',
        block && 'w-full',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  ),
);

export const IconButton = ({ className, label, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) => (
  <button aria-label={label} title={label} className={clsx('grid size-11 place-items-center rounded-xl text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800', className)} {...rest}>
    {children}
  </button>
);

/* ---------- Card ---------- */
export const Card = ({ className, children, onClick }: { className?: string; children: ReactNode; onClick?: () => void }) => (
  <div
    onClick={onClick}
    className={clsx(
      'rounded-xl bg-white shadow-[0_1px_2px_rgba(6,54,27,.06)] ring-1 ring-slate-200/80 dark:bg-slate-900 dark:ring-slate-800',
      onClick && 'cursor-pointer transition active:scale-[0.99] hover:ring-slate-300 dark:hover:ring-slate-700',
      className,
    )}
  >
    {children}
  </div>
);

export const SectionTitle = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="mb-1.5 mt-4 flex items-center justify-between px-0.5 first:mt-0">
    <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{children}</h2>
    {action}
  </div>
);

/* ---------- Forms ---------- */
const inputCls =
  'w-full rounded-xl border-0 bg-white px-3.5 h-11 ring-1 ring-slate-200 placeholder:text-slate-400 focus:ring-2 focus:ring-brand-500 outline-none dark:bg-slate-900 dark:ring-slate-700 disabled:opacity-60';

export const Field = ({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (id: string) => ReactNode }) => {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700 dark:text-slate-300">{label}</label>
      {children(id)}
      {error ? <p className="text-xs text-rose-600">{error}</p> : hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
};
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={clsx(inputCls, className)} {...p} />
));
/** Password input with an inline show/hide toggle. */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(({ className, ...p }, ref) => {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input ref={ref} type={visible ? 'text' : 'password'} className={clsx(inputCls, 'pr-12', className)} autoCapitalize="none" autoCorrect="off" spellCheck={false} {...p} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        title={visible ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
      >
        {visible ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
      </button>
    </div>
  );
});

export const Select = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={clsx(inputCls, 'appearance-none bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 20 20%27 fill=%27%2394a3b8%27%3E%3Cpath d=%27M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z%27/%3E%3C/svg%3E")] bg-[length:20px] bg-[right_10px_center] bg-no-repeat pr-9', className)} {...p}>
    {children}
  </select>
);
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={clsx(inputCls, 'h-auto min-h-24 py-2.5', className)} {...p} />
);
export const FormError = ({ error }: { error?: unknown }) =>
  error ? (
    <div className="flex items-start gap-2 rounded-xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>{(error as Error).message ?? 'Something went wrong'}</span>
    </div>
  ) : null;

/* ---------- Organisation logo ----------
 * Each organisation sets its own logo (light version for the green bars); the platform uses its icon. */
export const OrgLogo = ({ src, className }: { src?: string; className?: string }) => (
  <img
    src={src || '/icon.svg'}
    alt=""
    className={clsx('object-contain', className)}
    onError={(e) => {
      const img = e.currentTarget;
      if (!img.src.endsWith('/icon.svg')) img.src = '/icon.svg';
    }}
  />
);
/** Logo of the signed-in organisation. */
export const GovLogo = ({ className }: { className?: string }) => <OrgLogo src={useAuth().session?.tenant.branding?.logoUrl} className={className} />;

/** Single unit caption, bottom-centre of a card or chart, e.g. "(Rs in Millions)". */
export const UnitCaption = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={clsx('mt-2 text-center text-[10px] font-medium tracking-wide text-slate-400', className)}>{children}</div>
);

/* ---------- Bits ---------- */
export const Badge = ({ children, tone = 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300', className }: { children: ReactNode; tone?: string; className?: string }) => (
  <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', tone, className)}>{children}</span>
);
export const BandBadge = ({ band }: { band: Band }) => <Badge tone={BAND[band].tone}>{BAND[band].label}</Badge>;

const AVATAR_TONES = ['bg-green-100 text-green-800', 'bg-emerald-100 text-emerald-700', 'bg-amber-100 text-amber-700', 'bg-rose-100 text-rose-700', 'bg-sky-100 text-sky-700', 'bg-violet-100 text-violet-700'];
export const Avatar = ({ name, size = 40 }: { name: string; size?: number }) => {
  const tone = AVATAR_TONES[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_TONES.length];
  return (
    <div className={clsx('grid shrink-0 place-items-center rounded-full font-semibold', tone)} style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {initials(name)}
    </div>
  );
};

export const Progress = ({ value, max = 100 }: { value: number | null; max?: number }) => (
  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
    <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(100, ((value ?? 0) / max) * 100)}%`, background: scoreColor(value) }} />
  </div>
);

export const ScoreRing = ({ value, size = 112, stroke = 10, label }: { value: number | null; size?: number; stroke?: number; label?: string }) => {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.min(100, value ?? 0) / 100;
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-slate-100 dark:stroke-slate-800" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} stroke={scoreColor(value)} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} className="transition-[stroke-dashoffset] duration-700" />
      </svg>
      <div className="absolute text-center">
        <div className="text-2xl font-bold tabular-nums" style={{ fontSize: size * 0.22 }}>{value == null ? '—' : Math.round(value)}</div>
        {label && <div className="text-[11px] text-slate-500">{label}</div>}
      </div>
    </div>
  );
};

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={clsx('size-6 animate-spin text-brand-600', className)} />;

export const Loading = () => (
  <div className="space-y-3">
    {[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-slate-200/60 dark:bg-slate-800/60" />)}
  </div>
);

export const Empty = ({ title, body, action, icon: Icon = Inbox }: { title: string; body?: string; action?: ReactNode; icon?: typeof Inbox }) => (
  <div className="flex flex-col items-center px-6 py-12 text-center">
    <div className="mb-3 grid size-14 place-items-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-slate-800"><Icon className="size-7" /></div>
    <p className="font-semibold">{title}</p>
    {body && <p className="mt-1 max-w-xs text-sm text-slate-500">{body}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export const ErrorState = ({ error, retry }: { error: unknown; retry?: () => void }) => (
  <Empty icon={AlertTriangle} title="Couldn't load this" body={(error as Error)?.message} action={retry && <Button variant="secondary" onClick={retry}>Try again</Button>} />
);

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="flex rounded-xl bg-slate-100 p-1 dark:bg-slate-800/80" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx('flex-1 rounded-lg px-3 py-2 text-sm font-medium transition', value === o.value ? 'bg-white shadow-sm dark:bg-slate-900' : 'text-slate-500')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Sheet: bottom sheet on mobile, centred dialog on desktop ---------- */
export function Sheet({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={title}>
      <div className="animate-fade absolute inset-0 bg-slate-950/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className="animate-sheet relative flex max-h-[92dvh] w-full flex-col rounded-t-3xl bg-white shadow-2xl sm:max-w-lg sm:rounded-3xl dark:bg-slate-900">
        <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-slate-200 sm:hidden dark:bg-slate-700" />
        <div className="flex items-center justify-between px-5 pb-2 pt-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose} className="-mr-2"><X className="size-5" /></IconButton>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 pb-4">{children}</div>
        {footer && <div className="pb-safe border-t border-slate-100 px-5 pt-3 dark:border-slate-800"><div className="pb-3">{footer}</div></div>}
      </div>
    </div>,
    document.body,
  );
}

/* ---------- Toasts ---------- */
const ToastCtx = createContext<(msg: string, tone?: 'ok' | 'error') => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; msg: string; tone: 'ok' | 'error' }[]>([]);
  const push = useCallback((msg: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 p-4 pt-safe" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={clsx('animate-fade rounded-xl px-4 py-3 text-sm font-medium shadow-lg', t.tone === 'ok' ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'bg-rose-600 text-white')}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
