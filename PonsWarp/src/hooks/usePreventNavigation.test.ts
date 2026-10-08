import { describe, expect, it, beforeEach, vi } from 'vitest';
import { AppMode } from '../types/types';
import { useTransferStore } from '../store/transferStore';
import {
  isTransferSessionActive,
  isCurrentTransferSessionActive,
  confirmLeaveTransferSession,
  leaveTransferSessionIfConfirmed,
} from './usePreventNavigation';

describe('isTransferSessionActive', () => {
  it('protects live transfer statuses in session modes', () => {
    expect(isTransferSessionActive(AppMode.SENDER, 'TRANSFERRING')).toBe(true);
    expect(isTransferSessionActive(AppMode.RECEIVER, 'RECEIVING')).toBe(true);
    expect(isTransferSessionActive(AppMode.SENDER, 'WAITING')).toBe(true);
    expect(isTransferSessionActive(AppMode.CLOUD_SENDER, 'UPLOADING')).toBe(
      true
    );
    expect(isTransferSessionActive(AppMode.CLOUD_RECEIVER, 'SCANNING')).toBe(
      true
    );
  });

  it('allows idle/done and non-session modes', () => {
    expect(isTransferSessionActive(AppMode.SENDER, 'IDLE')).toBe(false);
    expect(isTransferSessionActive(AppMode.SENDER, 'DONE')).toBe(false);
    expect(isTransferSessionActive(AppMode.INTRO, 'TRANSFERRING')).toBe(false);
    expect(isTransferSessionActive(AppMode.SELECTION, 'RECEIVING')).toBe(false);
  });
});

describe('leaveTransferSessionIfConfirmed', () => {
  beforeEach(() => {
    useTransferStore.getState().reset();
    useTransferStore.setState({
      mode: AppMode.SENDER,
      status: 'TRANSFERRING',
    });
    vi.restoreAllMocks();
  });

  it('blocks leave when user cancels confirm', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onLeave = vi.fn();
    expect(leaveTransferSessionIfConfirmed(onLeave)).toBe(false);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('clears the completed session state only after leave is confirmed', () => {
    useTransferStore.setState({ roomId: 'ABC123', progress: { progress: 75, speed: 123, bytesTransferred: 75, totalBytes: 100 } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    leaveTransferSessionIfConfirmed(() => useTransferStore.getState().setMode(AppMode.SELECTION));
    const state = useTransferStore.getState();
    expect(state.mode).toBe(AppMode.SELECTION);
    expect(state.status).toBe('IDLE');
    expect(state.roomId).toBeNull();
    expect(state.progress).toEqual({ progress: 0, speed: 0, bytesTransferred: 0, totalBytes: 0 });
  });

  it('allows leave without confirm when session is idle', () => {
    useTransferStore.setState({ mode: AppMode.SENDER, status: 'IDLE' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onLeave = vi.fn();
    expect(leaveTransferSessionIfConfirmed(onLeave)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('reads current store for isCurrentTransferSessionActive', () => {
    useTransferStore.setState({ mode: AppMode.RECEIVER, status: 'RECEIVING' });
    expect(isCurrentTransferSessionActive()).toBe(true);
    useTransferStore.setState({ mode: AppMode.RECEIVER, status: 'DONE' });
    expect(isCurrentTransferSessionActive()).toBe(false);
  });

  it('confirmLeaveTransferSession returns false when cancelled', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(confirmLeaveTransferSession()).toBe(false);
  });
});
