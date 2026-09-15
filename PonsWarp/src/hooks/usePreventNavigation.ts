import { useEffect } from 'react';
import { AppMode } from '../types/types';
import { useTransferStore, TransferStatus } from '../store/transferStore';
import { toast } from '../store/toastStore';

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

export const TRANSFER_LEAVE_MESSAGE =
  'A file transfer is in progress. Leaving now will abort the transfer. Continue?';

export const TRANSFER_RELOAD_MESSAGE =
  'A file transfer is in progress. Reloading will abort the transfer. Continue?';

export function isTransferSessionActive(
  mode: AppMode,
  status: TransferStatus
): boolean {
  if (!SESSION_MODES.has(mode)) return false;
  return PROTECTED_STATUSES.has(status);
}

export function isCurrentTransferSessionActive(): boolean {
  const { mode, status } = useTransferStore.getState();
  return isTransferSessionActive(mode, status);
}

/**
 * Browser confirm before leaving an active transfer session.
 * Returns true when leave is allowed (no session, or user confirmed).
 */
export function confirmLeaveTransferSession(
  message: string = TRANSFER_LEAVE_MESSAGE
): boolean {
  if (!isCurrentTransferSessionActive()) return true;
  try {
    return window.confirm(message);
  } catch {
    // If confirm is unavailable, keep the session safe.
    return false;
  }
}

/**
 * Run `onLeave` only when the session is idle or the user confirms abort.
 */
export function leaveTransferSessionIfConfirmed(
  onLeave: () => void,
  message: string = TRANSFER_LEAVE_MESSAGE
): boolean {
  if (!confirmLeaveTransferSession(message)) {
    toast.warning('Transfer in progress. Staying on this page.');
    return false;
  }
  onLeave();
  return true;
}

function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/**
 * Prevent accidental navigation/reload while a transfer session is live.
 * Covers beforeunload, browser back, desktop reload shortcuts, and
 * overscroll-friendly CSS hooks. In-app leave actions should call
 * leaveTransferSessionIfConfirmed().
 */
export const usePreventNavigation = () => {
  const mode = useTransferStore(s => s.mode);
  const status = useTransferStore(s => s.status);

  useEffect(() => {
    const shouldPrevent = isTransferSessionActive(mode, status);
    const root = document.documentElement;

    if (shouldPrevent) {
      root.classList.add('transfer-active');
      root.dataset.transferLock = '1';
    } else {
      root.classList.remove('transfer-active');
      delete root.dataset.transferLock;
    }

    if (!shouldPrevent) {
      return () => {
        root.classList.remove('transfer-active');
        delete root.dataset.transferLock;
      };
    }

    // Seed a history entry so the first Back stays inside the transfer UI.
    try {
      window.history.pushState(
        { ponswarpTransferGuard: true },
        '',
        currentUrl()
      );
    } catch {
      // ignore
    }

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = TRANSFER_RELOAD_MESSAGE;
      return TRANSFER_RELOAD_MESSAGE;
    };

    const handlePopState = () => {
      // History already moved; pin the user back onto the transfer surface.
      try {
        window.history.pushState(
          { ponswarpTransferGuard: true },
          '',
          currentUrl()
        );
      } catch {
        // ignore
      }
      toast.warning('Back navigation is disabled during a transfer.');
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const isReload =
        key === 'f5' ||
        ((e.ctrlKey || e.metaKey) && key === 'r') ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'r');
      if (!isReload) return;

      // Desktop browsers still honor preventDefault for common reload chords.
      e.preventDefault();
      e.stopPropagation();
      if (confirmLeaveTransferSession(TRANSFER_RELOAD_MESSAGE)) {
        window.location.reload();
      } else {
        toast.warning('Transfer in progress. Reload cancelled.');
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('popstate', handlePopState);
    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('keydown', handleKeyDown, true);
      root.classList.remove('transfer-active');
      delete root.dataset.transferLock;
    };
  }, [mode, status]);
};
