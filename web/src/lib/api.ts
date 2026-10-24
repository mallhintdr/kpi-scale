/** Thin fetch wrapper: in-memory access token, silent refresh via httpOnly cookie, typed errors. */

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public body?: any) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onUnauthorized: () => void = () => {};

export const setAccessToken = (t: string | null) => (accessToken = t);
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

/**
 * One refresh at a time: the refresh token rotates on use, so two parallel calls (app start-up twice in
 * development, several expired requests at once) would make the second fail and sign the user out —
 * landing them on Home instead of the page they opened. Callers share the request in flight.
 */
let inflight: Promise<any | null> | null = null;
export function refreshSession(): Promise<any | null> {
  inflight ??= (async () => {
    const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    accessToken = data.accessToken;
    return data;
  })().finally(() => setTimeout(() => (inflight = null), 0));
  return inflight;
}

async function tryRefresh() {
  refreshing ??= refreshSession().then((d) => !!d).finally(() => (refreshing = null));
  return refreshing;
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`/api${path}`, { ...init, headers, body, credentials: 'include' });

  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await tryRefresh()) return api<T>(path, init, false);
    onUnauthorized();
    throw new ApiError(401, 'Session expired', 'UNAUTHORIZED');
  }
  if (res.status === 204) return undefined as T;
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const err = (data as any)?.error;
    throw new ApiError(res.status, err?.message ?? 'Request failed', err?.code, data);
  }
  return data as T;
}

export const get = <T = any>(path: string) => api<T>(path);
export const post = <T = any>(path: string, json?: unknown) => api<T>(path, { method: 'POST', json: json ?? {} });
export const put = <T = any>(path: string, json: unknown) => api<T>(path, { method: 'PUT', json });
export const patch =<T = any>(path: string, json: unknown) => api<T>(path, { method: 'PATCH', json });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

export const qs = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

/** Download an authenticated file (e.g. CSV export). */
export async function download(path: string, filename: string, retry = true): Promise<void> {
  const res = await fetch(`/api${path}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, credentials: 'include' });
  if (res.status === 401 && retry) {
    if (await tryRefresh()) return download(path, filename, false);
    onUnauthorized();
    throw new ApiError(401, 'Session expired', 'UNAUTHORIZED');
  }
  if (!res.ok) throw new ApiError(res.status, 'Download failed');
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
