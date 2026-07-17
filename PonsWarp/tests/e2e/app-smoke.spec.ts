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
});

test('home selection exposes send methods and receive entry', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByText('HYPER-SPEED')).toBeVisible();
  await page.getByRole('button', { name: /INITIALIZE LINK/i }).click();

  await expect(page.getByRole('button', { name: /SEND NOW/i })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /SEND BY LINK/i })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /RECEIVE/i })).toBeVisible();

  await page.getByRole('button', { name: /SEND BY LINK/i }).click();
  await expect(page.getByText('Free Cloud Drop stores up to')).toBeVisible();
});

test('pricing route is hidden while billing is disabled', async ({ page }) => {
  await page.goto('/pricing');

  await expect(page.getByText('HYPER-SPEED')).toBeVisible();
  await expect(page.getByText('CLOUD DROP PRICING')).toHaveCount(0);
  await expect(page.getByText('100GB Drop Pass')).toHaveCount(0);
});

test('receive view accepts a six character transfer code', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /INITIALIZE LINK/i }).click();
  await page.getByRole('button', { name: /RECEIVE/i }).click();

  await expect(page.getByText(/ENTER/i)).toBeVisible();
  await page.getByPlaceholder('CODE OR LINK').fill('ABC123');
  await expect(page.getByPlaceholder('CODE OR LINK')).toHaveValue('ABC123');
});

test('mobile direct send shows room code immediately for many files', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 667 });
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

  const fixtureDir = testInfo.outputPath('many-files');
  await mkdir(fixtureDir, { recursive: true });
  const files: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    const path = `${fixtureDir}/file-${String(index + 1).padStart(2, '0')}.txt`;
    await writeFile(path, `ponswarp multi-file mobile fixture ${index}\n`);
    files.push(path);
  }

  await page.goto('/');
  await page.getByRole('button', { name: /INITIALIZE LINK/i }).click();
  await page.getByRole('button', { name: /SEND NOW/i }).click();
  await expect(page.getByRole('heading', { name: /DROP FILES/i })).toBeVisible();

  await page.locator('input[type="file"]').first().setInputFiles(files);

  await expect(page.getByText('WARP KEY')).toBeVisible();
  await expect(page.getByText(/Files \(20\)/)).toBeVisible();
  await expect(page.getByText(/Preparing Files/i)).toHaveCount(0);

  const fileSummary = page.locator('p').filter({ hasText: /^Files \(20\)$/ });
  const waitingStatus = page
    .locator('p')
    .filter({ hasText: /^Waiting for connection\.\.\.$/ });
  await expect(fileSummary.first()).toBeVisible();
  await expect(fileSummary.first()).toBeInViewport();
  await expect(waitingStatus.first()).toBeVisible();
});
