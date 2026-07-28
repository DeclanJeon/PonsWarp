import { describe, expect, it, vi } from 'vitest';
import { PageWakeLock } from './pageWakeLock';

describe('PageWakeLock', () => {
  it('no-ops request when wakeLock API is missing', async () => {
    const prev = (globalThis as { navigator?: unknown }).navigator;
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
    });
    try {
      const lock = new PageWakeLock({ scope: '[Test]' });
      await lock.request();
      expect(lock.isHeld).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: prev,
        configurable: true,
      });
    }
  });

  it('holds and releases a sentinel', async () => {
    const release = vi.fn(async () => {});
    const addEventListener = vi.fn();
    const request = vi.fn(async () => ({
      release,
      addEventListener,
    }));
    const prev = (globalThis as { navigator?: unknown }).navigator;
    Object.defineProperty(globalThis, 'navigator', {
      value: { wakeLock: { request } },
      configurable: true,
    });
    try {
      const info = vi.fn();
      const lock = new PageWakeLock({
        scope: '[SwarmManager]',
        log: { info },
      });
      await lock.request();
      expect(request).toHaveBeenCalledWith('screen');
      expect(lock.isHeld).toBe(true);
      expect(info).toHaveBeenCalled();
      lock.release();
      expect(release).toHaveBeenCalled();
      expect(lock.isHeld).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: prev,
        configurable: true,
      });
    }
  });

  it('invokes onReleased when sentinel fires release', async () => {
    let releaseHandler: (() => void) | undefined;
    const request = vi.fn(async () => ({
      release: vi.fn(async () => {}),
      addEventListener: (_type: 'release', listener: () => void) => {
        releaseHandler = listener;
      },
    }));
    const prev = (globalThis as { navigator?: unknown }).navigator;
    Object.defineProperty(globalThis, 'navigator', {
      value: { wakeLock: { request } },
      configurable: true,
    });
    try {
      const onReleased = vi.fn();
      const lock = new PageWakeLock({
        scope: '[Receiver]',
        onReleased,
      });
      await lock.request();
      expect(releaseHandler).toBeTypeOf('function');
      releaseHandler?.();
      expect(onReleased).toHaveBeenCalledTimes(1);
      expect(lock.isHeld).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: prev,
        configurable: true,
      });
    }
  });
});
