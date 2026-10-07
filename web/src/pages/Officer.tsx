import { useQuery } from '@tanstack/react-query';
import { MapPin, Phone } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/AppShell';
import { FyPicker } from '../components/rev';
import { Avatar, Badge, Card, ErrorState, Loading, Segmented } from '../components/ui';
import { get } from '../lib/api';
import { useFy, type Post } from '../lib/rev';
import { UnitBody, type UnitData } from './UnitView';

interface OfficerData extends UnitData {
  officer: { _id: string; name: string; designation?: string; bps?: number; phone?: string; email: string; employeeCode?: string };
  post: Post;
  postLabel: string;
  posts: { code: Post; label: string }[];
  charges: { post: string; postLabel: string; chargeType: string; unit: { _id: string; name: string; type: string }; path: string[] }[];
}

export default function Officer() {
  const { id } = useParams();
  const [fy] = useFy();
  const [params, setParams] = useSearchParams();
  const post = params.get('post') ?? '';
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['rev', 'officer', id, fy, post],
    queryFn: () => get<OfficerData>(`/rev/officers/${id}?fy=${fy}${post ? `&post=${post}` : ''}`),
    enabled: !!fy,
  });

  return (
    <>
      <PageHeader title={data?.officer.name ?? 'Officer'} subtitle={data && `${data.postLabel}${data.officer.bps ? ` · BPS-${data.officer.bps}` : ''}`} back="/staff" actions={<FyPicker />} />
      {isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : data && (
        <div className="space-y-4">
          <Card className="flex flex-wrap items-center gap-4 p-4">
            <Avatar name={data.officer.name} size={52} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap gap-1.5">
                {data.charges.map((c, i) => (
                  <Badge key={i} tone="bg-brand-50 text-brand-800 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/10 dark:text-brand-200 dark:ring-brand-500/30">
                    <MapPin className="mr-1 size-3" />{c.unit.name}{c.chargeType !== 'regular' && ' · addl.'}
                  </Badge>
                ))}
              </div>
              <div className="mt-1.5 truncate text-xs text-slate-500">{data.charges[0]?.path.slice(0, -1).join(' › ')}</div>
              <div className="mt-0.5 text-xs text-slate-400">{data.officer.employeeCode} · {data.officer.email}</div>
            </div>
            {data.officer.phone && (
              <a href={`tel:${data.officer.phone}`} className="flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-medium text-brand-700 ring-1 ring-brand-200 hover:bg-brand-50">
                <Phone className="size-4" />Call
              </a>
            )}
          </Card>
          {data.posts.length > 1 && (
            <Segmented value={data.post} onChange={(p) => setParams({ post: p }, { replace: true })} options={data.posts.map((p) => ({ value: p.code, label: p.label }))} />
          )}
          <UnitBody data={data} />
        </div>
      )}
    </>
  );
}
