/**
 * Bulk import — hierarchy, people and postings from CSV. Always validates first (dry run) and shows
 * every problem by row; the real import runs as a background job and can be re-run safely
 * (rows match on code / email).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, FileUp, Loader2, Play, ShieldCheck, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Badge, Button, Card, Field, FormError, PasswordInput, SectionTitle, Segmented, useToast } from '../../components/ui';
import { get, post } from '../../lib/api';
import { getOrg, levels } from '../../lib/rev';

type Kind = 'units' | 'users' | 'charges';
interface Run { _id: string; kind: Kind; dryRun: boolean; status: 'queued' | 'running' | 'done' | 'failed'; total: number; created: number; updated: number; errors?: { row: number; message: string }[]; createdAt: string; createdBy?: { name: string } }

const KINDS: { value: Kind; label: string; help: string }[] = [
  { value: 'units', label: '1 · Hierarchy', help: 'Columns: level, name, code, parent_code. List parents before children; the top level has no parent_code.' },
  { value: 'users', label: '2 · People', help: 'Columns: name, email, role (employee / manager / admin), designation, employee_code, phone, password. Leave password empty to use the default below.' },
  { value: 'charges', label: '3 · Postings', help: 'Columns: email, unit_code, post, charge_type (regular / additional / look_after), from (YYYY-MM-DD). Posts and levels must match your organisation setup.' },
];

/** A ready-to-fill CSV using this organisation's own levels and posts. */
function sample(kind: Kind) {
  const ls = levels();
  const posts = getOrg()?.posts ?? [];
  if (kind === 'units') {
    const rows = ['level,name,code,parent_code'];
    let parent = '';
    ls.slice(0, 4).forEach((l, i) => {
      const code = `${l.key.slice(0, 3).toUpperCase()}-1`;
      rows.push(`${l.key},Example ${l.label},${code},${i ? parent : ''}`);
      parent = code;
    });
    return rows.join('\n');
  }
  if (kind === 'users') return 'name,email,role,designation,employee_code,phone,password\nAyesha Khan,ayesha@example.org,employee,Officer,EMP-001,0300-0000000,\nBilal Ahmad,bilal@example.org,admin,Data Manager,EMP-002,,';
  const p = posts.find((x) => x.scored) ?? posts[0];
  return `email,unit_code,post,charge_type,from\nayesha@example.org,${(p?.levels[0] ?? 'unit').slice(0, 3).toUpperCase()}-1,${p?.key ?? 'post'},regular,${new Date().toISOString().slice(0, 10)}`;
}

const downloadText = (name: string, text: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
};

export default function Import() {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>('units');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [defaultPassword, setDefaultPassword] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const run = useQuery({
    queryKey: ['org', 'import', runId],
    queryFn: () => get<Run>(`/org/imports/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data && ['done', 'failed'].includes(q.state.data.status) ? false : 800),
  });
  const history = useQuery({ queryKey: ['org', 'imports'], queryFn: () => get<Run[]>('/org/imports') });
  const r = run.data;
  const finished = r && ['done', 'failed'].includes(r.status);
  useEffect(() => {
    if (finished && r && !r.dryRun) {
      qc.invalidateQueries({ queryKey: ['org'] });
      qc.invalidateQueries({ queryKey: ['rev'] });
      qc.invalidateQueries({ queryKey: ['users'] });
      if (r.status === 'done') toast(`Imported: ${r.created} created, ${r.updated} updated`);
    }
    // Intentional: fire once when a run finishes, not on every poll of `r`.
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await post<Run>('/org/imports', { kind, csv, dryRun, defaultPassword: kind === 'users' && defaultPassword ? defaultPassword : undefined });
      setRunId(res._id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFileName(f.name);
    setCsv(await f.text());
    setRunId(null);
  };
  const validated = r?.dryRun && r.status === 'done' && !(r.errors?.length);
  const rows = csv.trim() ? csv.trim().split(/\r?\n/).length - 1 : 0;

  return (
    <>
      <PageHeader title="Bulk import" subtitle="Load your hierarchy, people and postings from CSV files — in this order" />
      <div className="mb-3"><Segmented value={kind} onChange={(k) => { setKind(k); setCsv(''); setFileName(''); setRunId(null); }} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} /></div>

      <Card className="space-y-2.5 p-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">{KINDS.find((k) => k.value === kind)!.help}</p>
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">
            <FileUp className="size-4" />{fileName || 'Choose CSV file'}
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <Button variant="secondary" onClick={() => downloadText(`${kind}-template.csv`, sample(kind))}><Download className="size-4" />Template</Button>
        </div>
        <Field label={`Or paste CSV${rows ? ` · ${rows} row${rows === 1 ? '' : 's'}` : ''}`}>
          {(id) => <textarea id={id} rows={6} spellCheck={false} className="w-full rounded-lg bg-white px-3 py-2 font-mono text-xs ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500 dark:bg-slate-900 dark:ring-slate-700" value={csv} onChange={(e) => { setCsv(e.target.value); setRunId(null); }} placeholder={sample(kind)} />}
        </Field>
        {kind === 'users' && (
          <Field label="Default password for rows without one" hint="At least 8 characters; ask people to change it after first sign-in">
            {(id) => <PasswordInput id={id} value={defaultPassword} onChange={(e) => setDefaultPassword(e.target.value)} />}
          </Field>
        )}
        <FormError error={error} />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={!rows} loading={busy && !validated} onClick={() => start(true)}><ShieldCheck className="size-4" />Check (dry run)</Button>
          <Button disabled={!validated} loading={busy && !!validated} onClick={() => confirm(`Import ${r?.total} rows now?`) && start(false)}><Play className="size-4" />Import</Button>
        </div>
        {!validated && rows > 0 && <p className="text-xs text-slate-500">Run the check first — the Import button unlocks when every row is valid.</p>}
      </Card>

      {r && (
        <>
          <SectionTitle>{r.dryRun ? 'Check result' : 'Import result'}</SectionTitle>
          <Card className="space-y-2 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              {!finished ? <Loader2 className="size-4 animate-spin text-brand-600" /> : r.status === 'done' && !r.errors?.length ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-rose-600" />}
              {!finished ? `Working… ${r.total} rows` : r.status === 'failed' ? 'Failed' : `${r.created} ${r.dryRun ? 'to create' : 'created'} · ${r.updated} ${r.dryRun ? 'to update' : 'updated'} · ${r.errors?.length ?? 0} problem${r.errors?.length === 1 ? '' : 's'}`}
            </div>
            {!!r.errors?.length && (
              <div className="max-h-72 overflow-auto rounded-lg ring-1 ring-rose-200 dark:ring-rose-500/30">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-rose-50 text-center text-[13px] text-rose-900 dark:bg-rose-500/15 dark:text-rose-100"><tr><th className="w-16 px-2 py-1.5">Row</th><th className="px-2 py-1.5 text-left">Problem</th></tr></thead>
                  <tbody>{r.errors.map((e, i) => <tr key={i} className="border-t border-rose-100 dark:border-rose-500/20"><td className="px-2 py-1 text-center tabular-nums">{e.row || '—'}</td><td className="px-2 py-1">{e.message}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <SectionTitle>Recent imports</SectionTitle>
      <Card className="divide-y divide-slate-100 dark:divide-slate-800">
        {!history.data?.length ? <div className="p-4 text-sm text-slate-500">None yet.</div> : history.data.slice(0, 10).map((h) => (
          <div key={h._id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <Badge>{h.kind}</Badge>
            <span className="flex-1 truncate">{h.dryRun ? 'Check' : 'Import'} · {h.total} rows · {h.created} created, {h.updated} updated</span>
            <span className="text-xs text-slate-500"><span className="font-semibold">{new Date(h.createdAt).toLocaleString()}</span></span>
            <Badge tone={h.status === 'done' ? 'bg-emerald-100 text-emerald-800' : h.status === 'failed' ? 'bg-rose-100 text-rose-800' : undefined}>{h.status}</Badge>
          </div>
        ))}
      </Card>
    </>
  );
}
