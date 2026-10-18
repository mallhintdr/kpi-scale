import { StrictMode, Suspense, lazy, useEffect, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from './components/AppShell';
import { Card, Empty, Spinner, ToastProvider } from './components/ui';
import { AuthProvider, useAuth } from './lib/auth';
import { ApiError } from './lib/api';
import { SINGLE_TENANT } from './lib/edition';
import { useCaps } from './lib/rev';
import { installPrintFit } from './lib/print';
import './index.css';

const Login = lazy(() => import('./pages/Login'));
const GuestLogin = lazy(() => import('./pages/Login').then((m) => ({ default: m.GuestLogin })));
const Home = lazy(() => import('./pages/Home'));
const UnitView = lazy(() => import('./pages/UnitView'));
const League = lazy(() => import('./pages/League'));
const Staff = lazy(() => import('./pages/Staff'));
const Officer = lazy(() => import('./pages/Officer'));
const Reports = lazy(() => import('./pages/Reports'));
const Compare = lazy(() => import('./pages/Compare'));
const Assigned = lazy(() => import('./pages/Assigned'));
const Entry = lazy(() => import('./pages/Entry'));
const Verify = lazy(() => import('./pages/Verify'));
const Targets = lazy(() => import('./pages/Targets'));
const AuditParas = lazy(() => import('./pages/AuditParas'));
const Tasks = lazy(() => import('./pages/Tasks'));
const Notifications = lazy(() => import('./pages/Notifications'));
const More = lazy(() => import('./pages/More'));
const Profile = lazy(() => import('./pages/Profile'));
const AdminPeople = lazy(() => import('./pages/admin/People'));
const AdminPostings = lazy(() => import('./pages/admin/Postings'));
const AdminScoring = lazy(() => import('./pages/admin/Scoring'));
const AdminOrg = lazy(() => import('./pages/admin/OrgSetup'));
const AdminUnits = lazy(() => import('./pages/admin/Units'));
const AdminImport = lazy(() => import('./pages/admin/Import'));
const Platform = lazy(() => import('./pages/platform/Platform'));
const Trends = lazy(() => import('./pages/Trends'));
const LitigationList = lazy(() => import('./pages/Litigation').then((x) => ({ default: x.LitigationList })));
const LitigationCasePage = lazy(() => import('./pages/Litigation').then((x) => ({ default: x.LitigationCasePage })));
const TameelList = lazy(() => import('./pages/Tameel').then((x) => ({ default: x.TameelList })));
const TameelDetail = lazy(() => import('./pages/Tameel').then((x) => ({ default: x.TameelDetail })));
const AdminAccess = lazy(() => import('./pages/admin/Access'));
const AdminWhatsApp = lazy(() => import('./pages/admin/WhatsApp'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
    },
  },
});

const FullScreen = () => (
  <div className="grid min-h-dvh place-items-center"><Spinner /></div>
);

function Protected({ children, admin, platform }: { children: ReactNode; admin?: boolean; platform?: boolean }) {
  const { session, loading, can } = useAuth();
  if (loading) return <FullScreen />;
  if (!session) return <Navigate to="/login" replace />;
  // Super-admins live in the platform console; organisation users never see it
  if (!!session.tenant.isPlatform !== !!platform) return <Navigate to={session.tenant.isPlatform ? '/platform' : '/'} replace />;
  if (admin && !can('admin')) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** /explore → the officer's own jurisdiction */
function Explore() {
  const caps = useCaps();
  if (!caps.loaded) return <div className="py-16 text-center"><Spinner /></div>;
  if (!caps.roots.length) return <Card className="mt-6"><Empty title="No posting assigned" /></Card>;
  return <Navigate to={`/units/${caps.roots[0]._id}`} replace />;
}

/** Each organisation's data (and its blueprint) is cached per signed-in user: drop it all when that changes. */
function CacheReset() {
  const { session } = useAuth();
  const who = session ? `${session.tenant.id}|${session.user.id}` : '';
  const prev = useRef(who);
  useEffect(() => {
    if (prev.current && prev.current !== who) queryClient.clear();
    prev.current = who;
  }, [who]);
  return null;
}

installPrintFit();

function App() {
  return (
    <Suspense fallback={<FullScreen />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/guest" element={<GuestLogin />} />
        {!SINGLE_TENANT && <Route path="/platform" element={<Protected platform><Platform /></Protected>} />}
        <Route element={<Protected><AppShell /></Protected>}>
          <Route index element={<Home />} />
          <Route path="explore" element={<Explore />} />
          <Route path="units/:id" element={<UnitView />} />
          <Route path="league" element={<League />} />
          <Route path="trends" element={<Trends />} />
          <Route path="tameel" element={<TameelList />} />
          <Route path="litigation" element={<LitigationList />} />
          <Route path="litigation/:id" element={<LitigationCasePage />} />
          <Route path="tameel/:id" element={<TameelDetail />} />
          <Route path="staff" element={<Staff />} />
          <Route path="officers/:id" element={<Officer />} />
          <Route path="reports" element={<Reports />} />
          <Route path="compare" element={<Compare />} />
          <Route path="assigned" element={<Assigned />} />
          <Route path="entry" element={<Entry />} />
          <Route path="verify" element={<Verify />} />
          <Route path="targets" element={<Targets />} />
          <Route path="audit-paras" element={<AuditParas />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="more" element={<More />} />
          <Route path="profile" element={<Profile />} />
          <Route path="admin/people" element={<Protected admin><AdminPeople /></Protected>} />
          <Route path="admin/postings" element={<Protected admin><AdminPostings /></Protected>} />
          <Route path="admin/scoring" element={<Protected admin><AdminScoring /></Protected>} />
          <Route path="admin/org" element={<Protected admin><AdminOrg /></Protected>} />
          <Route path="admin/units" element={<Protected admin><AdminUnits /></Protected>} />
          <Route path="admin/import" element={<Protected admin><AdminImport /></Protected>} />
          <Route path="admin/access" element={<Protected admin><AdminAccess /></Protected>} />
          <Route path="admin/whatsapp" element={<Protected admin><AdminWhatsApp /></Protected>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <CacheReset />
            <App />
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
