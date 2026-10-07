import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, ChevronRight, MapPin } from 'lucide-react';
import { useState } from 'react';
import { get } from '../lib/api';
import { BLOCK_LABEL, UNIT_LABEL, useCaps, useFy, type Block, type RevBand, type UnitRef } from '../lib/rev';
import { BandChip, Bullet, Ring } from './charts';
import { Button, Card, Empty, Loading, Select, Sheet } from './ui';

export const RevBandBadge = ({ band, size }: { band: RevBand; size?: 'sm' | 'md' }) => <BandChip band={band} size={size} />;

export function FyPicker() {
  const [fy, setFy, fys] = useFy();
  if (!fys.length) return null;
  return (
    <Select value={fy} onChange={(e) => setFy(e.target.value)} aria-label="Fiscal year" className="h-10 w-auto text-sm">
      {fys.map((f) => <option key={f} value={f}>FY {f}</option>)}
    </Select>
  );
}

/** Progress bar (kept for list rows); pace marker optional. */
export const Bar = ({ value, pace }: { value: number | null; max?: number; pace?: number | null }) => <Bullet value={value} pace={pace} height={8} />;

/** Five score blocks as ring tiles; N/A tiles are dimmed and say why. */
export function BlockBars({ blocks, weights, note = true }: { blocks: Record<Block, number | null>; weights?: Record<Block, number>; note?: boolean }) {
  return (
    <div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-5">
        {(Object.keys(BLOCK_LABEL) as Block[]).map((b) => (
          <div key={b} className={clsx('flex items-center gap-3 rounded-xl p-2.5 ring-1 ring-slate-100 dark:ring-slate-800', blocks[b] == null && 'opacity-60')}>
            <Ring value={blocks[b]} size={52} stroke={5} />
            <div className="min-w-0">
              <div className="text-[13px] font-medium leading-tight text-slate-700 dark:text-slate-200">{BLOCK_LABEL[b]}</div>
              <div className="mt-0.5 text-[11px] text-slate-400">{blocks[b] == null ? 'Not applicable' : weights ? `Weight ${weights[b]}%` : note ? '' : 'Achieved'}</div>
            </div>
          </div>
        ))}
      </div>
      {note && <p className="mt-2 text-[11px] text-slate-400">Blocks marked “Not applicable” are left out; their weight is shared by the others.</p>}
    </div>
  );
}

/** Drill-down territory picker. `accept` limits which unit types can be chosen. */
export function UnitPicker({
  open, onClose, onPick, accept, title = 'Choose a unit', scope = 'browse',
}: { open: boolean; onClose: () => void; onPick: (u: UnitRef) => void; accept?: UnitRef['type'][]; title?: string; scope?: 'browse' | 'work' }) {
  const caps = useCaps();
  const roots = scope === 'work' || !caps.browseRoots.length ? caps.roots : caps.browseRoots;
  const [trail, setTrail] = useState<UnitRef[]>([]);
  const current = trail[trail.length - 1];
  const { data: children, isLoading } = useQuery({
    queryKey: ['rev', 'children', current?._id],
    queryFn: () => get<UnitRef[]>(`/rev/units/${current!._id}/children`),
    enabled: !!current,
  });
  const list = current ? children ?? [] : roots;
  const canPick = (u: UnitRef) => !accept || accept.includes(u.type);
  const pick = (u: UnitRef) => {
    onPick(u);
    setTrail([]);
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="flex flex-wrap items-center gap-1 text-sm">
        <button className="font-medium text-brand-600" onClick={() => setTrail([])}>{scope === 'work' ? 'My jurisdiction' : 'All areas'}</button>
        {trail.map((t, i) => (
          <span key={t._id} className="flex items-center gap-1">
            <ChevronRight className="size-3.5 text-slate-400" />
            <button className="font-medium text-brand-600" onClick={() => setTrail(trail.slice(0, i + 1))}>{t.name}</button>
          </span>
        ))}
      </div>
      {current && canPick(current) && (
        <Button block variant="secondary" onClick={() => pick(current)}><Check className="size-4" />Select {current.name}</Button>
      )}
      {current && isLoading ? <Loading /> : !list.length ? <Empty title="Nothing below this level" /> : (
        <Card className="divide-y divide-slate-100 dark:divide-slate-800">
          {list.map((u) => (
            <div key={u._id} className="flex items-center gap-2 px-3 py-2">
              <MapPin className="size-4 shrink-0 text-slate-400" />
              <button className="min-w-0 flex-1 text-left" onClick={() => (u.type === 'mouza' ? canPick(u) && pick(u) : setTrail([...trail, u]))}>
                <div className="truncate text-sm font-medium">{u.name}</div>
                <div className="text-xs text-slate-500">{UNIT_LABEL[u.type]}</div>
              </button>
              {canPick(u) && <Button size="sm" variant="ghost" onClick={() => pick(u)}>Select</Button>}
              {u.type !== 'mouza' && <ChevronRight className={clsx('size-4 text-slate-300')} />}
            </div>
          ))}
        </Card>
      )}
    </Sheet>
  );
}

/** Button that shows the chosen unit and opens a UnitPicker. */
export function UnitField({ value, onChange, accept, placeholder = 'Choose unit', scope = 'browse' }: { value: UnitRef | null; onChange: (u: UnitRef) => void; accept?: UnitRef['type'][]; placeholder?: string; scope?: 'browse' | 'work' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-11 w-full items-center gap-2 rounded-xl bg-white px-3.5 text-left ring-1 ring-slate-200 hover:ring-slate-300 dark:bg-slate-900 dark:ring-slate-700"
      >
        <MapPin className="size-4 shrink-0 text-brand-600" />
        <span className="min-w-0 flex-1 truncate">{value ? <>{value.name} <span className="text-xs text-slate-500">· {UNIT_LABEL[value.type]}</span></> : <span className="text-slate-400">{placeholder}</span>}</span>
        <ChevronRight className="size-4 text-slate-400" />
      </button>
      <UnitPicker open={open} onClose={() => setOpen(false)} onPick={onChange} accept={accept} scope={scope} />
    </>
  );
}
