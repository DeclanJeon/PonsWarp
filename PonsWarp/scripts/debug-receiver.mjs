#!/usr/bin/env node
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('console', m => console.log(`[R] ${m.text().substring(0, 200)}`));

await page.goto('https://warp.ponslink.com', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// Click INITIALIZE LINK
await page.locator('button:has-text("INITIALIZE LINK")').click();
await page.waitForTimeout(1000);

const afterInit = await page.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim().substring(0, 50));
  return { buttons, text: document.body.innerText.substring(0, 300) };
});
console.log('After INITIALIZE LINK:', JSON.stringify(afterInit, null, 2));

// Click RECEIVE
await page.locator('button:has-text("RECEIVE")').click();
await page.waitForTimeout(1000);

const afterReceive = await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('input')).map(i => ({ placeholder: i.placeholder, type: i.type }));
  const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim().substring(0, 50));
  return { inputs, buttons, text: document.body.innerText.substring(0, 300) };
});
console.log('After RECEIVE:', JSON.stringify(afterReceive, null, 2));

// Type code and press Enter
await page.locator('input').first().fill('TEST');
await page.locator('input').first().press('Enter');
await page.waitForTimeout(2000);

const afterEnter = await page.evaluate(() => {
  return { text: document.body.innerText.substring(0, 500) };
});
console.log('After Enter:', JSON.stringify(afterEnter, null, 2));

await browser.close();
