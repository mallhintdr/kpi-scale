import { useSyncExternalStore } from 'react';

/**
 * View mode:
 *  - 'performance' (default): plain achievement — % of target achieved and amounts recovered.
 *  - 'kpi': weighted KPI evaluation — composite scores, blocks, bands and score rankings.
 * Remembered per device.
 */
export type ViewMode = 'performance' | 'kpi';

const KEY = 'view-mode';
const listeners = new Set<() => void>();

const read = (): ViewMode => {
  try {
    return localStorage.getItem(KEY) === 'kpi' ? 'kpi' : 'performance';
  } catch {
    return 'performance';
  }
};
let current: ViewMode = read();

export function setViewMode(m: ViewMode) {
  current = m;
  try {
    localStorage.setItem(KEY, m);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

export function useViewMode(): [ViewMode, (m: ViewMode) => void] {
  const mode = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => 'performance' as ViewMode,
  );
  return [mode, setViewMode];
}

/** Achievement % (0–100) of a target, or null when there is no target. */
export const achievement = (done: number, of: number) => (of > 0 ? Math.min(100, (done / of) * 100) : null);
