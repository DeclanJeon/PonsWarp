/**
 * Registers the app shell service worker and reloads onto new deploys
 * without interrupting an active transfer.
 */

export type AppUpdateOptions = {
  /** Poll interval for registration.update() while idle. */
  updateCheckIntervalMs?: number;
  /** Optional transfer-active guard. When true, defer reload. */
  isTransferActive?: () => boolean;
  /** Service worker URL (defaults to /app-sw.js). */
  scriptUrl?: string;
};

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null =
  null;
let updateTimer: ReturnType<typeof setInterval> | null = null;
let waitingReload = false;

function canUseServiceWorker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator
  );
}

function transferIsActive(options?: AppUpdateOptions): boolean {
  try {
    return options?.isTransferActive?.() === true;
  } catch {
    return false;
  }
}

function reloadWhenSafe(options?: AppUpdateOptions): void {
  if (waitingReload) return;
  waitingReload = true;

  const attempt = () => {
    if (transferIsActive(options)) {
      // Retry shortly after transfer settles.
      setTimeout(attempt, 2000);
      return;
    }
    // One-shot reload onto the new controller.
    window.location.reload();
  };
  attempt();
}

function listenForControllerChange(options?: AppUpdateOptions): void {
  if (!canUseServiceWorker()) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    reloadWhenSafe(options);
  });
}

function watchWaitingWorker(
  registration: ServiceWorkerRegistration,
  options?: AppUpdateOptions
): void {
  const promote = (worker: ServiceWorker | null) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        // New version ready — ask it to activate.
        worker.postMessage({ type: 'SKIP_WAITING' });
        if (!transferIsActive(options)) {
          // controllerchange will reload; also nudge if already controlling.
          reloadWhenSafe(options);
        }
      }
    });
  };

  if (registration.waiting) {
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  }
  promote(registration.installing);
  registration.addEventListener('updatefound', () => {
    promote(registration.installing);
  });
}

/**
 * Register app update SW once. Safe to call multiple times.
 */
export async function registerAppUpdateServiceWorker(
  options: AppUpdateOptions = {}
): Promise<ServiceWorkerRegistration | null> {
  if (!canUseServiceWorker()) return null;
  if (registrationPromise) return registrationPromise;

  listenForControllerChange(options);

  registrationPromise = (async () => {
    try {
      const scriptUrl = options.scriptUrl ?? '/app-sw.js';
      const registration = await navigator.serviceWorker.register(scriptUrl, {
        scope: '/',
        updateViaCache: 'none',
      });
      watchWaitingWorker(registration, options);

      const interval = options.updateCheckIntervalMs ?? DEFAULT_INTERVAL_MS;
      if (updateTimer) clearInterval(updateTimer);
      updateTimer = setInterval(() => {
        if (transferIsActive(options)) return;
        void registration.update().catch(() => undefined);
      }, interval);

      // Eager update check on first boot.
      void registration.update().catch(() => undefined);
      return registration;
    } catch (error) {
      console.warn('[AppUpdate] service worker registration failed', error);
      return null;
    }
  })();

  return registrationPromise;
}

/** Test helper: reset module state. */
export function __resetAppUpdateServiceForTests(): void {
  registrationPromise = null;
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  waitingReload = false;
}
