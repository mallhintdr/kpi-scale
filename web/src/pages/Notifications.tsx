import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/AppShell';
import { Button, Card, Empty, ErrorState, Loading } from '../components/ui';
import { get, post } from '../lib/api';
import { timeAgo } from '../lib/format';
import type { Notification } from '../lib/types';

export default function Notifications() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['notifications', 'list'], queryFn: () => get<Notification[]>('/notifications') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const readAll = useMutation({ mutationFn: () => post('/notifications/read-all'), onSuccess: refresh });
  const open = async (n: Notification) => {
    if (!n.readAt) post(`/notifications/${n._id}/read`).then(refresh);
    if (n.link) navigate(n.link);
  };
  const hasUnread = data?.some((n) => !n.readAt);

  return (
    <>
      <PageHeader title="Alerts" actions={hasUnread && <Button variant="ghost" size="sm" onClick={() => readAll.mutate()}><CheckCheck className="size-4" />Mark all read</Button>} />
      {isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : !data?.length ? (
        <Card><Empty icon={Bell} title="No notifications" body="Updates about your targets and reviews will show up here." /></Card>
      ) : (
        <Card className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.map((n) => (
            <button key={n._id} onClick={() => open(n)} className="flex w-full items-start gap-3 px-4 py-3.5 text-left active:bg-slate-50 dark:active:bg-slate-800">
              <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-brand-600'}`} />
              <div className="min-w-0 flex-1">
                <div className={`text-sm ${n.readAt ? 'text-slate-600 dark:text-slate-400' : 'font-semibold'}`}>{n.title}</div>
                {n.body && <div className="mt-0.5 text-sm text-slate-500">{n.body}</div>}
                <div className="mt-1 text-xs text-slate-400">{timeAgo(n.createdAt)}</div>
              </div>
            </button>
          ))}
        </Card>
      )}
    </>
  );
}
