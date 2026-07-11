import { expect, test } from '@playwright/test';

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
