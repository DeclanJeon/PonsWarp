import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAppUpdateServiceForTests,
  registerAppUpdateServiceWorker,
} from './appUpdateService';

describe('registerAppUpdateServiceWorker', () => {
  afterEach(() => {
    __resetAppUpdateServiceForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers app-sw.js with updateViaCache none', async () => {
    const registration = {
      installing: null,
      waiting: null,
      active: null,
      update: vi.fn(async () => undefined),
      addEventListener: vi.fn(),
    };
    const register = vi.fn(async () => registration);
    const addEventListener = vi.fn();

    vi.stubGlobal('navigator', {
      serviceWorker: {
        register,
        addEventListener,
        controller: null,
      },
    });

    const result = await registerAppUpdateServiceWorker({
      updateCheckIntervalMs: 60_000,
    });

    expect(result).toBe(registration);
    expect(register).toHaveBeenCalledWith('/app-sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
    expect(addEventListener).toHaveBeenCalledWith(
      'controllerchange',
      expect.any(Function)
    );
  });

  it('defers reload while transfer is active then reloads when idle', async () => {
    const listeners = new Map<string, Function[]>();
    const registration = {
      installing: null,
      waiting: null,
      active: null,
      update: vi.fn(async () => undefined),
      addEventListener: vi.fn(),
    };
    const register = vi.fn(async () => registration);
    const reload = vi.fn();

    vi.stubGlobal('navigator', {
      serviceWorker: {
        register,
        controller: {},
        addEventListener: (type: string, fn: Function) => {
          listeners.set(type, [...(listeners.get(type) ?? []), fn]);
        },
      },
    });
    vi.stubGlobal('window', {
      location: { reload },
    });

    let active = true;
    await registerAppUpdateServiceWorker({
      isTransferActive: () => active,
      updateCheckIntervalMs: 60_000,
    });

    // Fire controllerchange while transferring.
    listeners.get('controllerchange')?.forEach(fn => fn());
    expect(reload).not.toHaveBeenCalled();

    active = false;
    await new Promise(resolve => setTimeout(resolve, 2100));
    expect(reload).toHaveBeenCalled();
  });
});
