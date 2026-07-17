import { useEffect } from 'react';
import { AppMode } from '../types/types';
import { useTransferStore, TransferStatus } from '../store/transferStore';

/** Statuses where reloading/navigating away will break the transfer. */
const PROTECTED_STATUSES = new Set<TransferStatus>([
  'SCANNING',
  'PREPARING',
  'UPLOADING',
  'WAITING',
  'CONNECTING',
  'TRANSFERRING',
  'RECEIVING',
  'REMOTE_PROCESSING',
  'READY_FOR_NEXT',
  'QUEUED',
]);

const SESSION_MODES = new Set<AppMode>([
  AppMode.SENDER,
  AppMode.RECEIVER,
  AppMode.CLOUD_SENDER,
  AppMode.CLOUD_RECEIVER,
]);

export function isTransferSessionActive(
  mode: AppMode,
  status: TransferStatus
): boolean {
  if (!SESSION_MODES.has(mode)) return false;
  return PROTECTED_STATUSES.has(status);
}

/**
 * Prevent accidental navigation/reload while a transfer session is live.
 * Covers beforeunload, browser back, and overscroll-friendly CSS hooks.
 */
export const usePreventNavigation = () => {
  const mode = useTransferStore(s => s.mode);
  const status = useTransferStore(s => s.status);

  useEffect(() => {
    const shouldPrevent = isTransferSessionActive(mode, status);
    const root = document.documentElement;
    if (shouldPrevent) {
      root.classList.add('transfer-active');
    } else {
      root.classList.remove('transfer-active');
    }

    if (!shouldPrevent) {
      return () => {
        root.classList.remove('transfer-active');
      };
    }

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
      return '';
    };

    const handlePopState = () => {
      // Keep the user on the current SPA session instead of dropping to INTRO.
      try {
        const url = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        window.history.pushState({ ponswarpTransferGuard: true }, '', url);
      } catch {
        // ignore
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('popstate', handlePopState);
      root.classList.remove('transfer-active');
    };
  }, [mode, status]);
};
