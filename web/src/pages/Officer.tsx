import { useQuery } from '@tanstack/react-query';
import { Mail, Phone } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/AppShell';
import { FyPicker } from '../components/rev';
import { Avatar, Badge, Card, ErrorState, Loading, Segmented } from '../components/ui';
import { levels } from '../lib/rev';
import { get } from '../lib/api';
import { useFy, type Post } from '../lib/rev';
import { UnitBody, type UnitData } from './UnitView';

interface OfficerData extends UnitData {
  officer: { _id: string; name: string; designation?: string; phone?: string; email?: string; employeeCode?: string };
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
      <PageHeader title={data?.officer.name ?? 'Officer'} subtitle={data?.officer.designation ?? data?.postLabel} back="/staff" actions={<FyPicker />} />
      {isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : data && (
        <div className="space-y-2.5">
          <Card className="p-3 sm:p-4">
            <div className="flex items-center gap-3">
              <Avatar name={data.officer.name} size={44} />
              <div className="min-w-0 flex-1 text-sm text-slate-600 dark:text-slate-300">
                {data.officer.employeeCode && <div className="truncate">Employee Code <b className="text-slate-900 dark:text-white">{data.officer.employeeCode}</b></div>}
                {data.officer.email && <a href={`mailto:${data.officer.email}`} className="flex items-center gap-1.5 truncate hover:underline"><Mail className="size-4 shrink-0 text-sky-600" />{data.officer.email}</a>}
              </div>
              {data.officer.phone && (
                <a href={`tel:${data.officer.phone}`} className="flex h-10 shrink-0 items-center gap-2 rounded-xl px-3 text-sm font-medium text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-50 dark:text-emerald-300 dark:ring-emerald-500/30">
                  <Phone className="size-4 text-emerald-600" />Call
                </a>
              )}
            </div>
            <Postings charges={data.charges} />
          </Card>
          {data.posts.length > 1 && (
            <Segmented value={data.post} onChange={(p) => setParams({ post: p }, { replace: true })} options={data.posts.map((p) => ({ value: p.code, label: p.label }))} />
          )}
          <UnitBody data={data} urlFor={(f) => `/rev/officers/${id}?fy=${f}${post ? `&post=${post}` : ''}`} />
        </div>
      )}
    </>
  );
}

/**
 * Postings as a table: one column per level (Division, District, Tehsil …) and the post. Values shared
 * by consecutive postings are merged into one cell, so nothing is shown twice.
 */
function Postings({ charges }: { charges: OfficerData['charges'] }) {
  if (!charges.length) return null;
  const depth = Math.max(...charges.map((c) => c.path.length));
  const lv = levels();
  // Leave out leading levels that are the same for every posting only when there is a single top unit
  const cols = Array.from({ length: depth }, (_, k) => lv[k]?.label ?? `Level ${k + 1}`);
  const rows = charges.map((c) => [...c.path, ...Array(depth - c.path.length).fill('')]);
  // rowSpan for cell (r, k): merge down while this and all columns to its left match
  const same = (a: number, b: number, k: number) => rows[a].slice(0, k + 1).every((v, i) => v === rows[b][i]);
  const span = (r: number, k: number) => {
    if (r > 0 && same(r - 1, r, k)) return 0;
    let n = 1;
    while (r + n < rows.length && same(r, r + n, k)) n++;
    return n;
  };
  const th = 'border-b border-r border-white/40 px-2 py-1.5 text-left font-semibold';
  const td = 'border-b border-r border-slate-200 px-2 py-1.5 align-top dark:border-slate-700';
  return (
    <div className="mt-3 overflow-x-auto rounded-lg ring-1 ring-slate-200 dark:ring-slate-700">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead className="bg-brand-700 text-[14px] text-white">
          <tr>{cols.map((c) => <th key={c} className={th}>{c}</th>)}<th className="border-b border-white/40 px-2.5 py-1.5 text-left font-semibold">Post</th></tr>
        </thead>
        <tbody>
          {charges.map((c, r) => (
            <tr key={r}>
              {cols.map((_, k) => {
                const n = span(r, k);
                return n ? <td key={k} rowSpan={n} className={`${td} ${k === depth - 1 ? 'font-semibold text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-300'}`}>{rows[r][k] || '—'}</td> : null;
              })}
              <td className="border-b border-slate-200 px-2.5 py-1.5 dark:border-slate-700">
                <span className="font-medium">{c.postLabel}</span>
                {c.chargeType !== 'regular' && <Badge className="ml-1.5">{c.chargeType === 'additional' ? 'Addl. Charge' : 'Look After'}</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
