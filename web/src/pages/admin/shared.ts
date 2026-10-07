import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../components/ui';

/** Mutation that toasts and invalidates the given query keys on success. */
export function useSave<V>(fn: (v: V) => Promise<unknown>, keys: string[][], msg: string, after?: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      toast(msg);
      after?.();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
}

/** Turn empty strings into null so optional ids/fields aren't sent as "" */
export const clean = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === '' ? null : v])) as T;
