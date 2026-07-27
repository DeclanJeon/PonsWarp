import React from 'react';
import { LogOut, User } from 'lucide-react';
import { AuthState } from '../services/authService';

interface AccountStatusProps {
  authState: AuthState;
  authLoading: boolean;
  onLogin: () => void;
  onLogout: () => void;
}

const AccountStatus: React.FC<AccountStatusProps> = ({
  authState,
  authLoading,
  onLogin,
  onLogout,
}) => {
  if (authState.authenticated) {
    const email = authState.user?.email || 'Google account';
    return (
      <button
        type="button"
        onClick={onLogout}
        title={`Signed in as ${email}. Click to sign out.`}
        aria-label={`Signed in as ${email}. Click to sign out.`}
        className="flex min-w-0 items-center gap-2 rounded-full border border-cyan-400/25 bg-cyan-500/10 px-3 py-1.5 text-xs font-bold tracking-wider text-cyan-100 transition-colors hover:bg-cyan-500/20"
      >
        <User size={14} className="shrink-0 text-cyan-300" />
        <span className="whitespace-nowrap">Signed in</span>
        <span className="hidden max-w-[150px] truncate font-mono font-medium tracking-normal text-cyan-50/75 sm:inline">
          {email}
        </span>
        <LogOut size={13} className="shrink-0 text-cyan-200/70" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onLogin}
      disabled={authLoading}
      className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold tracking-wider text-gray-300 transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-50"
    >
      <User size={14} className="text-cyan-300" />
      <span>{authLoading ? 'Checking' : 'Sign in'}</span>
    </button>
  );
};

export default AccountStatus;
