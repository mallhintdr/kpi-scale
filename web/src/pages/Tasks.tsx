import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, Search } from 'lucide-react';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/AppShell';
import { Badge, Button, Card, Empty, ErrorState, Field, FormError, Input, Loading, Segmented, Select, Sheet, Textarea, useToast } from '../components/ui';
import { get, post } from '../lib/api';
import { fmtDate, toDateInput } from '../lib/format';
import { useCaps } from '../lib/rev';
import { useSave } from './admin/shared';

interface Task {
  _id: string; title: string; details?: string; dueDate: string; priority: 'normal' | 'high' | 'urgent'; status: 'open' | 'done'; completedAt?: string; completionNote?: string;
  assigneeId: { _id: string; name: string; designation?: string }; assignedBy: { _id: string; name: string; designation?: string }; unitId: { name: string };
}
const PRIORITY: Record<Task['priority'], string> = { normal: '', high: 'bg-amber-100 text-amber-800', urgent: 'bg-rose-100 text-rose-800' };

export default function Tasks() {
  const caps = useCaps();
  const [params, setParams] = useSearchParams();
  const box = (params.get('box') as 'mine' | 'assigned') ?? 'mine';
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['rev', 'tasks', box], queryFn: () => get<Task[]>(`/rev/tasks?box=${box}`) });
  const canAssign = caps.isOfficer;

  return (
    <>
      <PageHeader title="Tasks" actions={canAssign && <Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" />Assign</Button>} />
      {canAssign && (
        <div className="mb-4"><Segmented value={box} onChange={(b) => setParams({ box: b }, { replace: true })} options={[{ value: 'mine', label: 'Assigned to me' }, { value: 'assigned', label: 'Assigned by me' }]} /></div>
      )}
      {isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : !data?.length ? (
        <Card><Empty icon={CheckCircle2} title="No tasks" /></Card>
      ) : (
        <div className="space-y-2.5">{data.map((t) => <TaskCard key={t._id} t={t} box={box} />)}</div>
      )}
      {creating && <NewTask onClose={() => setCreating(false)} />}
    </>
  );
}

function TaskCard({ t, box }: { t: Task; box: 'mine' | 'assigned' }) {
  const qc = useQueryClient();
  const toast = useToast();
  const overdue = t.status === 'open' && new Date(t.dueDate) < new Date();
  const late = t.status === 'done' && t.completedAt && new Date(t.completedAt) > new Date(t.dueDate);
  const done = useMutation({
    mutationFn: (note?: string) => post(`/rev/tasks/${t._id}/complete`, { note }),
    onSuccess: () => { toast('Marked complete'); qc.invalidateQueries({ queryKey: ['rev'] }); },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const person = box === 'mine' ? t.assignedBy : t.assigneeId;
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{t.title}</span>
            {t.priority !== 'normal' && <Badge tone={PRIORITY[t.priority]} className="capitalize">{t.priority}</Badge>}
          </div>
          <div className="text-xs text-slate-500">{box === 'mine' ? 'From' : 'To'} {person.name}{person.designation && `, ${person.designation}`} · {t.unitId?.name}</div>
          {t.details && <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t.details}</p>}
          <div className="mt-1.5 text-xs">
            {t.status === 'done'
              ? <span className={late ? 'text-amber-600' : 'text-emerald-600'}>Completed {fmtDate(t.completedAt)}{late ? ' (late)' : ' on time'}</span>
              : <span className={overdue ? 'font-semibold text-rose-600' : 'text-slate-500'}>Due {fmtDate(t.dueDate, { day: 'numeric', month: 'short', year: 'numeric' })}{overdue && ' · overdue'}</span>}
          </div>
        </div>
      </div>
      {box === 'mine' && t.status === 'open' && (
        <Button size="sm" variant="secondary" block className="mt-3" loading={done.isPending} onClick={() => { const n = prompt('Completion note (optional)'); if (n !== null) done.mutate(n || undefined); }}>
          <CheckCircle2 className="size-4" />Mark complete
        </Button>
      )}
    </Card>
  );
}

interface Assignee { userId: string; name: string; post: string; postLabel: string; unitId: string; unitName: string }

function NewTask({ onClose }: { onClose: () => void }) {
  const [search, setSearch] = useState('');
  const term = useDeferredValue(search);
  const { data: people = [], isLoading } = useQuery({ queryKey: ['rev', 'assignees', term], queryFn: () => get<Assignee[]>(`/rev/tasks/assignees?search=${encodeURIComponent(term)}`) });
  const [who, setWho] = useState<Assignee | null>(null);
  const [f, setF] = useState({ title: '', details: '', dueDate: toDateInput(new Date(Date.now() + 7 * 86400000)), priority: 'normal' });
  const save = useSave(() => post('/rev/tasks', { ...f, details: f.details || undefined, assigneeId: who!.userId, unitId: who!.unitId }), [['rev', 'tasks']], 'Task assigned', onClose);
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(undefined); };
  return (
    <Sheet open onClose={onClose} title="Assign a task" footer={<Button form="task-form" type="submit" block disabled={!who} loading={save.isPending}>Assign</Button>}>
      <form id="task-form" onSubmit={submit} className="space-y-4">
        {who ? (
          <Card className="flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1"><div className="font-medium">{who.name}</div><div className="text-xs text-slate-500">{who.postLabel} · {who.unitName}</div></div>
            <Button type="button" size="sm" variant="ghost" onClick={() => setWho(null)}>Change</Button>
          </Card>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input autoFocus placeholder="Search officer or unit" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
            </div>
            <Card className="max-h-64 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
              {isLoading ? <div className="p-4"><Loading /></div> : people.map((p) => (
                <button type="button" key={`${p.userId}${p.unitId}`} onClick={() => setWho(p)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
                  <div className="min-w-0"><div className="truncate text-sm font-medium">{p.name}</div><div className="truncate text-xs text-slate-500">{p.postLabel} · {p.unitName}</div></div>
                </button>
              ))}
            </Card>
          </div>
        )}
        <Field label="Task">{(id) => <Input id={id} required minLength={3} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</Field>
        <Field label="Details">{(id) => <Textarea id={id} rows={2} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Due date">{(id) => <Input id={id} type="date" required min={toDateInput()} value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />}</Field>
          <Field label="Priority">{(id) => <Select id={id} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></Select>}</Field>
        </div>
        <FormError error={save.error} />
      </form>
    </Sheet>
  );
}
