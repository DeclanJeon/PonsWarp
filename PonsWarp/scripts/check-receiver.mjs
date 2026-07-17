import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
page.on('console', m => console.log(`[R] ${m.text().substring(0, 200)}`));

await page.goto('https://warp.ponslink.com', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
await page.locator('button:has-text("INITIALIZE LINK")').click();
await page.waitForTimeout(500);
await page.locator('button:has-text("RECEIVE")').click();
await page.waitForTimeout(1000);
await page.locator('input[placeholder*="CODE" i]').first().fill('P6TYV7');
await page.locator('input[placeholder*="CODE" i]').first().press('Enter');
await page.waitForTimeout(3000);
console.log('=== RECEIVER TEXT ===');
console.log(await page.evaluate(() => document.body.innerText.substring(0, 500)));
await browser.close();
