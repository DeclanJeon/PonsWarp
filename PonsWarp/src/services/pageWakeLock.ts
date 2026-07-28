/**
 * Shared Screen Wake Lock helper for sender/receiver transfer paths.
 * Behavior-preserving extraction from SwarmManager / ReceiverService.
 */

export type WakeLockLike = {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener?: (
    type: 'release',
    listener: () => void
  ) => void;
};

export type PageWakeLockLog = {
  info?: (scope: string, message: string, ...args: unknown[]) => void;
  debug?: (scope: string, message: string, ...args: unknown[]) => void;
};

export type PageWakeLockOptions = {
  /** Log scope tag, e.g. '[SwarmManager]' or '[Receiver]'. */
  scope: string;
  log?: PageWakeLockLog;
  /**
   * Called when the OS releases the lock while still needed.
   * Receiver re-requests while transfer is active; sender historically no-ops.
   */
  onReleased?: () => void;
};

/**
 * Owns a single WakeLockSentinel and mirrors the previous class-private helpers.
 */
export class PageWakeLock {
  private sentinel: WakeLockLike | null = null;
  private readonly scope: string;
  private readonly log: PageWakeLockLog;
  private readonly onReleased?: () => void;

  constructor(options: PageWakeLockOptions) {
    this.scope = options.scope;
    this.log = options.log ?? {};
    this.onReleased = options.onReleased;
  }

  get isHeld(): boolean {
    return this.sentinel != null;
  }

  async request(): Promise<void> {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    try {
      const nav = navigator as Navigator & {
        wakeLock: { request: (type: 'screen') => Promise<WakeLockLike> };
      };
      this.sentinel = await nav.wakeLock.request('screen');
      this.log.info?.(this.scope, '🔒 Wake Lock acquired');
      this.sentinel.addEventListener?.('release', () => {
        // Sender historically logged release; receiver only nulls + maybe re-arm.
        if (this.scope.includes('SwarmManager')) {
          this.log.info?.(this.scope, '🔓 Wake Lock released');
        }
        this.sentinel = null;
        this.onReleased?.();
      });
    } catch (e) {
      this.log.debug?.(this.scope, 'Wake Lock not available:', e);
    }
  }

  release(): void {
    if (this.sentinel) {
      this.sentinel.release().catch(() => {});
      this.sentinel = null;
    }
  }
}
