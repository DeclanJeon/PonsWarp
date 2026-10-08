import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const GB = 1024 * 1024 * 1024;

const cloudPlansFixture = {
  directP2p: {
    label: 'Free Direct Send',
    unlimited: true,
    priceKrw: 0,
  },
  free: {
    sku: 'free_cloud_10gb_24h',
    label: 'PonsWarp Free',
    priceKrw: 0,
    maxTotalBytes: 10 * GB,
    maxFileBytes: 10 * GB,
    retentionSeconds: 24 * 60 * 60,
    available: true,
  },
  passes: [
    {
      sku: 'drop_100gb_3d',
      label: '100GB Drop Pass',
      priceKrw: 1900,
      maxTotalBytes: 100 * GB,
      maxFileBytes: 100 * GB,
      retentionSeconds: 3 * 24 * 60 * 60,
      downloadLimit: 10,
      available: false,
    },
  ],
  pro: {
    sku: 'pro_monthly',
    label: 'Pro Monthly',
    priceKrw: 9900,
    maxTotalBytes: 1024 * GB,
    maxFileBytes: 1024 * GB,
    retentionSeconds: 7 * 24 * 60 * 60,
    downloadLimit: 50,
    available: false,
  },
  checkoutEnabled: false,
  paymentProviders: ['lemonsqueezy', 'paypal'],
  defaultPaymentProvider: 'lemonsqueezy',
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/cloud-plans', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(cloudPlansFixture),
    });
  });
  await page.addInitScript(() => {
    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onclose:
        | ((event: { code: number; reason: string }) => void)
        | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(_url: string) {
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          this.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'Connected',
                payload: { socket_id: 'sender-test' },
              }),
            })
          );
        }, 0);
      }

      send(raw: string) {
        const message = JSON.parse(raw) as { type?: string };
        if (message.type !== 'RequestTurnConfig') return;
        window.setTimeout(() => {
          this.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'TurnConfig',
                payload: {
                  success: true,
                  data: {
                    ice_servers: [],
                    turn_server_status: {
                      primary: { connected: true },
                      fallback: [],
                    },
                    ttl: 600,
                    timestamp: Date.now(),
                  },
                },
              }),
            })
          );
        }, 0);
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.({ code: 1000, reason: '' });
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: MockWebSocket,
    });
  });
});

test('home selection exposes send methods and receive entry', async ({
  page,
}) => {
  await page.goto('/');

  await page.getByRole('button', { name: /Start sharing/i }).click();

  await expect(page.getByRole('button', { name: /SEND NOW/i })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /SEND BY LINK/i })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /RECEIVE/i })).toBeVisible();

  await page.getByRole('button', { name: /SEND BY LINK/i }).click();
  await expect(page.locator('input[type="file"]').first()).toBeEnabled();
});

test('pricing route is hidden while billing is disabled', async ({ page }) => {
  await page.goto('/pricing');

  await expect(page.getByText('CLOUD DROP PRICING')).toHaveCount(0);
  await expect(page.getByText('100GB Drop Pass')).toHaveCount(0);
});

test('receive form rejects malformed shared links submitted with Enter', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Start sharing/i }).click();
  await page.getByRole('button', { name: /RECEIVE/i }).click();
  const input = page.getByLabel('Room code, drop code, or shared link');
  await input.fill('https://warp.ponslink.com/receive/ABC123/extra');
  await input.press('Enter');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toBeFocused();
  await expect(page).toHaveURL('/');
});

test('mobile direct send shows room code immediately for many files', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 667 });

  const fixtureDir = testInfo.outputPath('many-files');
  await mkdir(fixtureDir, { recursive: true });
  const files: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    const path = `${fixtureDir}/file-${String(index + 1).padStart(2, '0')}.txt`;
    await writeFile(path, `ponswarp multi-file mobile fixture ${index}\n`);
    files.push(path);
  }

  await page.goto('/');
  await page.getByRole('button', { name: /Start sharing/i }).click();
  await page.getByRole('button', { name: /SEND NOW/i }).click();
  await expect(page.getByRole('heading', { name: /DROP FILES/i })).toBeVisible();

  await page.locator('input[type="file"]').first().setInputFiles(files);

  await expect(page.getByRole('button', { name: 'Copy room code' })).toBeVisible();
  await expect(page.getByText(/Files \(20\)/)).toBeVisible();

  const fileSummary = page.locator('p').filter({ hasText: /^Files \(20\)$/ });
  await expect(page.getByLabel('Share link')).toBeInViewport();
  await fileSummary.first().scrollIntoViewIfNeeded();
  await expect(fileSummary.first()).toBeInViewport();
});

test('protected download survives denied storage and refreshes with its in-memory token', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 515 });
  await page.addInitScript(() => {
    for (const method of ['getItem', 'setItem'] as const) {
      const original = Storage.prototype[method];
      Object.defineProperty(Storage.prototype, method, {
        configurable: true,
        value(this: Storage, key: string, ...args: string[]) {
          if (key.startsWith('ponswarpCloudDownloadSession:')) throw new DOMException('Storage denied', 'SecurityError');
          return Reflect.apply(original, this, [key, ...args]);
        },
      });
    }
  });
  const accessRequests: Record<string, string>[] = [];
  await page.route('**/api/cloud-share/protected-1234', async route => {
    const access = JSON.parse(route.request().postData() || '{}') as Record<string, string>;
    accessRequests.push(access);
    if (access.password !== 'correct' && access.downloadSessionToken !== 'access-test') {
      await route.fulfill({ status: 403, json: { error: access.password ? 'Invalid password' : 'Password required' } });
      return;
    }
    await route.fulfill({ json: {
      shareId: 'protected-1234', rootName: 'Protected download', totalSize: 20, totalFiles: 1,
      createdAt: 1700000000, expiresAt: 1900000000, secondsUntilExpiry: 86000,
      completed: access.downloadSessionToken === 'access-test', requiresPassword: true,
      downloadSessionToken: 'access-test',
      files: [{ id: 'a', name: 'a.txt', path: 'a.txt', size: 20, contentType: 'text/plain' }],
    } });
  });
  await page.goto('/cloud/protected-1234');
  const password = page.getByLabel('Share password');
  await password.fill('wrong');
  await password.press('Enter');
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await password.fill('correct');
  await password.press('Enter');
  await expect(page.getByRole('heading', { name: 'Protected download' })).toBeFocused();
  await expect(page.getByRole('button', { name: /Download a.txt/ })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Download a.txt' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByRole('link', { name: 'Download a.txt' })).toHaveAttribute('href', /token=access-test/);
  expect(accessRequests.at(-1)).toEqual({ downloadSessionToken: 'access-test' });
});

test('live share copies link and room code separately and selects the link when clipboard access is denied', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('button', { name: /Start sharing/i }).click();
  await page.getByRole('button', { name: /SEND NOW/i }).click();
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'sample.txt', mimeType: 'text/plain', buffer: Buffer.from('clipboard QA'),
  });
  const linkInput = page.getByLabel('Share link');
  const link = await linkInput.inputValue();
  await linkInput.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Copy room code' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^[A-Z0-9]{6}$/);
  const code = await page.evaluate(() => navigator.clipboard.readText());
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  expect(link).toContain(`/receive/${code}`);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { async writeText() { throw new DOMException('Permission denied', 'NotAllowedError'); } },
    });
  });
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(linkInput).toBeFocused();
  expect(await linkInput.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, link.length]);
  await expect(page.getByRole('status').filter({ hasText: /copy.*manually/i })).toBeVisible();
});

test('leaving a live receive deep link does not reopen it during history restoration', async ({ page }) => {
  await page.goto('/receive/ABC123');
  const cancel = page.getByRole('button', { name: /Cancel transfer/i });
  await expect(cancel).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss());
  await cancel.click();
  await expect(page).toHaveURL('/receive/ABC123');
  await expect(cancel).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await Promise.all([
    page.evaluate(() => new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true, capture: true }))),
    cancel.click(),
  ]);
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('button', { name: /Send now/i })).toBeVisible();
  await expect(cancel).toHaveCount(0);
});

test('changing reduced motion without reloading stops and resumes the decorative canvas', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  const fingerprint = () => canvas.evaluate(async (element: HTMLCanvasElement) => {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(element.toDataURL()));
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  });
  const waitForFrames = (count: number) => page.evaluate(frames => new Promise<void>(resolve => {
    const tick = () => {
      if (--frames <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), count);

  const moving = await fingerprint();
  await expect.poll(fingerprint).not.toBe(moving);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await waitForFrames(2);
  const stopped = await fingerprint();
  await waitForFrames(10);
  expect(await fingerprint()).toBe(stopped);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await waitForFrames(2);
  const resumed = await fingerprint();
  await expect.poll(fingerprint).not.toBe(resumed);
});
