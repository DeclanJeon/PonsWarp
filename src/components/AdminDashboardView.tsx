import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CloudUpload,
  CreditCard,
  Database,
  Loader2,
  ShieldCheck,
  User,
  Users,
} from 'lucide-react';
import { AuthState } from '../services/authService';
import {
  AdminMeResponse,
  AdminOverviewResponse,
  getAdminMe,
  getAdminOverview,
} from '../services/adminService';
import { formatBytes } from '../utils/fileUtils';

interface AdminDashboardViewProps {
  authState: AuthState;
  authLoading: boolean;
  onLogin: () => void;
}

const emptyOverview: AdminOverviewResponse = {
  totalUsers: 0,
  activeSubscriptions: 0,
  activeDropPasses: 0,
  activeCloudShares: 0,
  storedCloudBytes: 0,
  billingEvents: 0,
};

const AdminDashboardView: React.FC<AdminDashboardViewProps> = ({
  authState,
  authLoading,
  onLogin,
}) => {
  const [admin, setAdmin] = useState<AdminMeResponse | null>(null);
  const [overview, setOverview] =
    useState<AdminOverviewResponse>(emptyOverview);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (authLoading) return;
    if (!authState.authenticated) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    Promise.all([getAdminMe(), getAdminOverview()])
      .then(([adminResponse, overviewResponse]) => {
        if (cancelled) return;
        setAdmin(adminResponse);
        setOverview(overviewResponse);
      })
      .catch(loadError => {
        if (cancelled) return;
        setAdmin(null);
        setError(loadError?.message || 'Admin access failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authLoading, authState.authenticated]);

  if (authLoading || loading) {
    return (
      <AdminFrame>
        <div className="flex min-h-[360px] items-center justify-center rounded-2xl border border-white/10 bg-black/45">
          <div className="flex items-center gap-3 text-gray-300">
            <Loader2 className="h-5 w-5 animate-spin text-cyan-300" />
            <span className="text-sm font-bold tracking-wider">
              Loading admin console
            </span>
          </div>
        </div>
      </AdminFrame>
    );
  }

  if (!authState.authenticated) {
    return (
      <AdminFrame>
        <AccessPanel
          icon={User}
          title="관리자 로그인이 필요합니다"
          body="관리자 대시보드는 Google 로그인 후 별도 관리자 권한이 있는 계정만 접근할 수 있습니다."
          actionLabel="CONTINUE WITH GOOGLE"
          onAction={onLogin}
        />
      </AdminFrame>
    );
  }

  if (error || !admin) {
    return (
      <AdminFrame>
        <AccessPanel
          icon={AlertTriangle}
          title="관리자 권한이 없습니다"
          body={error || '현재 계정은 관리자 allowlist 또는 admin_members에 등록되어 있지 않습니다.'}
        />
      </AdminFrame>
    );
  }

  return (
    <AdminFrame>
      <div className="mb-5 flex flex-col gap-4 rounded-2xl border border-cyan-400/20 bg-black/50 p-5 backdrop-blur-xl md:flex-row md:items-end md:justify-between">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-400/25 bg-cyan-500/10 px-3 py-1">
            <ShieldCheck className="h-4 w-4 text-cyan-300" />
            <span className="text-[10px] font-bold tracking-[0.2em] text-cyan-200">
              ADMIN CONSOLE
            </span>
          </div>
          <h2 className="brand-font text-3xl font-black text-white md:text-5xl">
            Operations dashboard
          </h2>
          <p className="mt-2 text-sm text-gray-400">
            {admin.user.email} · {admin.admin.role} · {admin.admin.status}
          </p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-xs text-gray-400">
          MVP is read-only. Takedown, refund, and replay actions require audit
          logging first.
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          icon={Users}
          label="total users"
          value={overview.totalUsers.toLocaleString('ko-KR')}
        />
        <MetricCard
          icon={CreditCard}
          label="active subscriptions"
          value={overview.activeSubscriptions.toLocaleString('ko-KR')}
        />
        <MetricCard
          icon={BarChart3}
          label="active drop passes"
          value={overview.activeDropPasses.toLocaleString('ko-KR')}
        />
        <MetricCard
          icon={CloudUpload}
          label="active cloud drops"
          value={overview.activeCloudShares.toLocaleString('ko-KR')}
        />
        <MetricCard
          icon={Database}
          label="stored cloud bytes"
          value={formatBytes(overview.storedCloudBytes)}
        />
        <MetricCard
          icon={ShieldCheck}
          label="billing events"
          value={overview.billingEvents.toLocaleString('ko-KR')}
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {['Users', 'Cloud Drops', 'Billing'].map(title => (
          <div
            key={title}
            className="rounded-2xl border border-white/10 bg-gray-950/60 p-5"
          >
            <p className="text-lg font-bold text-white">{title}</p>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              Read-only list and search views will be added after the admin
              access foundation is verified in production-like auth flows.
            </p>
          </div>
        ))}
      </div>
    </AdminFrame>
  );
};

const AdminFrame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="relative h-full w-full px-4 pb-10 pt-28 md:pt-32">
    <div className="mx-auto h-full max-w-6xl overflow-y-auto pb-16">
      {children}
    </div>
  </div>
);

const AccessPanel: React.FC<{
  icon: React.ElementType;
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}> = ({ icon: Icon, title, body, actionLabel, onAction }) => (
  <div className="mx-auto flex min-h-[360px] max-w-xl flex-col items-center justify-center rounded-2xl border border-white/10 bg-black/55 p-6 text-center backdrop-blur-xl">
    <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-400/25 bg-cyan-500/10">
      <Icon className="h-7 w-7 text-cyan-300" />
    </div>
    <h2 className="text-2xl font-black text-white">{title}</h2>
    <p className="mt-3 text-sm leading-relaxed text-gray-400">{body}</p>
    {actionLabel && onAction && (
      <button
        type="button"
        onClick={onAction}
        className="mt-6 rounded-full border border-cyan-400/35 bg-cyan-500/15 px-5 py-3 text-xs font-bold tracking-wider text-cyan-100 hover:bg-cyan-500/25"
      >
        {actionLabel}
      </button>
    )}
  </div>
);

const MetricCard: React.FC<{
  icon: React.ElementType;
  label: string;
  value: string;
}> = ({ icon: Icon, label, value }) => (
  <div className="rounded-2xl border border-white/10 bg-black/45 p-5 backdrop-blur-xl">
    <div className="mb-4 flex items-center justify-between gap-3">
      <p className="text-xs font-bold uppercase tracking-[0.2em] text-gray-500">
        {label}
      </p>
      <Icon className="h-5 w-5 text-cyan-300" />
    </div>
    <p className="text-3xl font-black text-white">{value}</p>
  </div>
);

export default AdminDashboardView;
