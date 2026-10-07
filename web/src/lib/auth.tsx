import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { post, refreshSession, setAccessToken, setUnauthorizedHandler } from './api';
import type { Role, Tenant, User } from './types';

interface Session {
  user: User;
  tenant: Tenant;
}
interface AuthCtx {
  session: Session | null;
  loading: boolean;
  setSession: (data: { accessToken: string; user: User; tenant: Tenant }) => void;
  logout: () => Promise<void>;
  can: (min: Role) => boolean;
}

const RANK: Record<Role, number> = { employee: 0, manager: 1, admin: 2, owner: 3 };
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, set] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const setSession = useCallback((d: { accessToken: string; user: User; tenant: Tenant }) => {
    setAccessToken(d.accessToken);
    set({ user: d.user, tenant: d.tenant });
  }, []);

  const clear = useCallback(() => {
    setAccessToken(null);
    set(null);
    qc.clear();
  }, [qc]);

  const logout = useCallback(async () => {
    await post('/auth/logout').catch(() => {});
    clear();
  }, [clear]);

  useEffect(() => {
    setUnauthorizedHandler(clear);
    refreshSession()
      .then((d) => d && setSession(d))
      .finally(() => setLoading(false));
  }, [clear, setSession]);

  const value = useMemo<AuthCtx>(
    () => ({ session, loading, setSession, logout, can: (min) => !!session && RANK[session.user.role] >= RANK[min] }),
    [session, loading, setSession, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
};

export const useMe = () => useAuth().session!;
