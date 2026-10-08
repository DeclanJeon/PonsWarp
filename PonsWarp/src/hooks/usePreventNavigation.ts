import { useEffect, useRef } from 'react';
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
  if (SESSION_MODES.has(useTransferStore.getState().mode)) {
    useTransferStore.getState().reset();
  }
  onLeave();
  return true;
}


/**
 * Prevent accidental navigation/reload while a transfer session is live.
 * Covers beforeunload, browser back, desktop reload shortcuts, and
 * overscroll-friendly CSS hooks. In-app leave actions should call
 * leaveTransferSessionIfConfirmed().
 */
export const usePreventNavigation = () => {
  const shouldPrevent = useTransferStore(state => isTransferSessionActive(state.mode, state.status));
  const isRestoringHistoryRef = useRef(false);

  useEffect(() => {
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

    const sessionUrl = window.location.href;
    const originalState = window.history.state;
    // Seed a history entry so the first Back stays inside the transfer UI.
    try {
      window.history.pushState(
        { ponswarpTransferGuard: true },
        '',
        sessionUrl
      );
    } catch {
      // ignore
    }

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = TRANSFER_RELOAD_MESSAGE;
      return TRANSFER_RELOAD_MESSAGE;
    };

    const handlePopState = (event: PopStateEvent) => {
      event.stopImmediatePropagation();
      if (confirmLeaveTransferSession()) {
        useTransferStore.getState().reset();
        useTransferStore.getState().setMode(AppMode.SELECTION);
        window.history.replaceState(originalState, '', '/');
        return;
      }
      // Back consumed the guard entry. Restore it, not the popped route.
      window.history.pushState({ ponswarpTransferGuard: true }, '', sessionUrl);
      toast.warning('Transfer in progress. Staying on this page.');
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
        window.removeEventListener('beforeunload', handleBeforeUnload);
        window.location.reload();
      } else {
        toast.warning('Transfer in progress. Reload cancelled.');
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('popstate', handlePopState, true);
    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('popstate', handlePopState, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      root.classList.remove('transfer-active');
      delete root.dataset.transferLock;
      if (window.history.state?.ponswarpTransferGuard) {
        isRestoringHistoryRef.current = true;
        const restoreUrl = window.location.href;
        const restoreHistory = (event: PopStateEvent) => {
          event.stopImmediatePropagation();
          window.history.replaceState(originalState, '', restoreUrl);
          isRestoringHistoryRef.current = false;
        };
        window.addEventListener('popstate', restoreHistory, { capture: true, once: true });
        window.history.back();
      }
    };
  }, [shouldPrevent]);
  return isRestoringHistoryRef;
};
