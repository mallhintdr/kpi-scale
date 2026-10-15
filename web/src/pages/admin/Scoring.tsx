import { useQuery } from '@tanstack/react-query';
import { RotateCcw, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { UnitField } from '../../components/rev';
import { Badge, Button, Card, ErrorState, Field, FormError, Loading, SectionTitle } from '../../components/ui';
import { del, get, put } from '../../lib/api';
import { BLOCK_LABEL, UNIT_LABEL, parentLevels, useMeta, type Block, type UnitRef } from '../../lib/rev';
import { useSave } from './shared';

interface Cfg { profiles: Record<string, Record<Block, number>>; heads: Record<string, number>; sourceUnitId: string | null }
interface CfgResponse { effective: Cfg; inherited: Cfg | null; hasOverride: boolean; profiles: { key: string; label: string }[]; blocks: { key: string; label: string }[] }

export default function Scoring() {
  const [scope, setScope] = useState<UnitRef | null>(null);
  const { data: meta } = useMeta();
  const key = ['rev', 'score-config', scope?._id ?? 'default'];
  const { data, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => get<CfgResponse>(`/rev/score-config${scope ? `?scopeUnitId=${scope._id}` : ''}`) });
  const [cfg, setCfg] = useState<Cfg | null>(null);
  useEffect(() => setCfg(data ? structuredClone(data.effective) : null), [data]);

  const save = useSave(() => put('/rev/score-config', { scopeUnitId: scope?._id ?? null, blocks: cfg!.profiles, heads: cfg!.heads }), [['rev']], 'Scoring weights saved');
  const reset = useSave(() => del(`/rev/score-config?scopeUnitId=${scope!._id}`), [['rev']], 'Override removed — inherits from above');

  const setBlock = (lvl: string, b: Block, v: string) => setCfg((c) => c && { ...c, profiles: { ...c.profiles, [lvl]: { ...c.profiles[lvl], [b]: Math.max(0, Math.min(100, Number(v) || 0)) } } });
  const setHead = (code: string, v: string) => setCfg((c) => c && { ...c, heads: { ...c.heads, [code]: Math.max(0, Math.min(1000, Number(v) || 0)) } });
  const cell = 'h-10 w-16 rounded-lg bg-white px-2 text-right tabular-nums ring-1 ring-slate-200 focus:ring-2 focus:ring-brand-500 outline-none dark:bg-slate-900 dark:ring-slate-700';

  return (
    <>
      <PageHeader title="Scoring weights" subtitle="Organisation default, or an override for any area" />
      <Card className="mb-4 space-y-3 p-4">
        <Field label="Applies to">
          {() => (
            <div className="flex gap-2">
              <div className="flex-1"><UnitField value={scope} onChange={setScope} accept={parentLevels()} placeholder="Organisation default" /></div>
              {scope && <Button variant="ghost" onClick={() => setScope(null)}>Default</Button>}
            </div>
          )}
        </Field>
        {data && scope && (
          <div className="text-sm">
            {data.hasOverride ? <Badge tone="bg-brand-100 text-brand-800">Custom weights for this {UNIT_LABEL[scope.type].toLowerCase()}</Badge> : <Badge>Inherited — saving creates an override</Badge>}
          </div>
        )}
      </Card>

      {isLoading || !cfg ? (error ? <ErrorState error={error} retry={refetch} /> : <Loading />) : (
        <>
          <SectionTitle>Block weights by profile (each row = 100)</SectionTitle>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr className="border-b border-slate-100 dark:border-slate-800">
                  <th className="px-4 py-2.5 font-medium">Profile</th>
                  {data!.blocks.map((b) => <th key={b.key} className="px-2 py-2.5 text-center font-medium">{b.label}</th>)}
                  <th className="px-4 py-2.5 text-center font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data!.profiles.map(({ key: lvl, label }) => {
                  const total = data!.blocks.reduce((s, b) => s + (cfg.profiles[lvl]?.[b.key] ?? 0), 0);
                  return (
                    <tr key={lvl}>
                      <td className="px-4 py-2 font-medium">{label}</td>
                      {data!.blocks.map((b) => (
                        <td key={b.key} className="px-2 py-2 text-center"><input type="number" inputMode="numeric" min={0} max={100} className={cell} value={cfg.profiles[lvl]?.[b.key] ?? 0} onChange={(e) => setBlock(lvl, b.key, e.target.value)} /></td>
                      ))}
                      <td className={`px-4 py-2 text-center font-bold tabular-nums ${total === 100 ? 'text-emerald-600' : 'text-rose-600'}`}>{total}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          <SectionTitle>KPI weights (relative, within their block)</SectionTitle>
          <Card className="grid gap-x-6 gap-y-1 p-4 sm:grid-cols-2">
            {meta?.heads.map((h) => (
              <div key={h.code} className="flex items-center justify-between gap-3 py-1">
                <span className="text-sm">{h.name} <span className="text-[11px] text-slate-400">{BLOCK_LABEL[h.block]}</span></span>
                <input type="number" inputMode="numeric" min={0} max={1000} className={cell} value={cfg.heads[h.code] ?? 0} onChange={(e) => setHead(h.code, e.target.value)} />
              </div>
            ))}
          </Card>

          <div className="mt-4 space-y-3">
            <FormError error={save.error} />
            <div className="flex gap-2">
              {scope && data!.hasOverride && <Button variant="secondary" loading={reset.isPending} onClick={() => confirm('Remove this override and inherit weights from above?') && reset.mutate(undefined)}><RotateCcw className="size-4" />Remove override</Button>}
              <Button className="flex-1" loading={save.isPending} onClick={() => save.mutate(undefined)}><Save className="size-4" />Save weights</Button>
            </div>
            <p className="text-xs text-slate-500">Scores update immediately everywhere — dashboards, league tables and officer scores are calculated live from these weights.</p>
          </div>
        </>
      )}
    </>
  );
}
