import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = join(tmpdir(), "warpspace-e2e");
mkdirSync(OUT, { recursive: true });

function log(...args) {
  console.log("[e2e]", ...args);
}

async function dump(page, name) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  log("screenshot", path);
  const text = await page.locator("body").innerText().catch(() => "");
  writeFileSync(join(OUT, `${name}.txt`), text);
  return text;
}

const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--disable-web-security"],
});

const senderCtx = await browser.newContext();
const receiverCtx = await browser.newContext();
const sender = await senderCtx.newPage();
const receiver = await receiverCtx.newPage();

sender.on("console", (m) => log("sender-console", m.type(), m.text()));
receiver.on("console", (m) => log("receiver-console", m.type(), m.text()));
sender.on("pageerror", (e) => log("sender-error", e.message));
receiver.on("pageerror", (e) => log("receiver-error", e.message));

try {
  log("open sender /send");
  await sender.goto(`${BASE}/send`, { waitUntil: "networkidle" });
  await dump(sender, "01-sender-idle");

  // Upload a small file via the hidden input
  const payload = Buffer.from(`hello-warpspace-${Date.now()}\n`);
  await sender.locator('input[type="file"]').first().setInputFiles({
    name: "hello.txt",
    mimeType: "text/plain",
    buffer: payload,
  });

  log("waiting for warp key");
  await sender.waitForSelector("text=WARP GATE OPEN", { timeout: 20000 });
  await dump(sender, "02-sender-room");

  // Extract 6-char room code from monospaced key display
  const codeText = await sender.locator("p.font-mono").first().innerText();
  const code = codeText.replace(/[^A-Z0-9]/gi, "").slice(0, 6);
  log("room code", code, "raw", codeText);
  if (code.length !== 6) throw new Error(`invalid code: ${codeText}`);

  log("open receiver", `${BASE}/receive/${code}`);
  await receiver.goto(`${BASE}/receive/${code}`, { waitUntil: "networkidle" });
  await dump(receiver, "03-receiver-join");

  // Wait for either consent or transfer UI
  const consentOrProgress = await Promise.race([
    receiver
      .waitForSelector("text=INCOMING TRANSMISSION", { timeout: 25000 })
      .then(() => "consent"),
    receiver
      .waitForSelector("text=RECEIVING WARP", { timeout: 25000 })
      .then(() => "receiving"),
    receiver
      .waitForSelector("text=SEARCHING FREQUENCY", { timeout: 25000 })
      .then(() => "searching"),
    sender
      .waitForSelector("text=WARPING DATA", { timeout: 25000 })
      .then(() => "sender-transfer"),
  ]).catch(async (err) => {
    await dump(sender, "fail-sender");
    await dump(receiver, "fail-receiver");
    throw err;
  });
  log("phase", consentOrProgress);
  await dump(sender, "04-sender-after-join");
  await dump(receiver, "04-receiver-after-join");

  if (consentOrProgress === "consent" || (await receiver.getByText("START DOWNLOAD").count()) > 0) {
    log("click START DOWNLOAD");
    await receiver.getByRole("button", { name: /START DOWNLOAD/i }).click();
  }

  // Wait for completion on either side
  const done = await Promise.race([
    sender.waitForSelector("text=TRANSFER COMPLETE", { timeout: 45000 }).then(() => "sender-done"),
    receiver.waitForSelector("text=DOWNLOAD COMPLETE", { timeout: 45000 }).then(() => "receiver-done"),
    sender.waitForSelector("text=WARPING DATA", { timeout: 45000 }).then(async () => {
      // if transferring, wait more for complete
      await sender.waitForSelector("text=TRANSFER COMPLETE", { timeout: 45000 });
      return "sender-done-late";
    }),
  ]).catch(async (err) => {
    await dump(sender, "fail-sender-final");
    await dump(receiver, "fail-receiver-final");
    const s = await sender.locator("body").innerText();
    const r = await receiver.locator("body").innerText();
    log("sender body\n", s.slice(0, 1500));
    log("receiver body\n", r.slice(0, 1500));
    throw err;
  });

  log("result", done);
  await dump(sender, "05-sender-final");
  await dump(receiver, "05-receiver-final");
  console.log("E2E_OK", done, code);
  await browser.close();
  process.exit(0);
} catch (error) {
  console.error("E2E_FAIL", error);
  await dump(sender, "error-sender").catch(() => {});
  await dump(receiver, "error-receiver").catch(() => {});
  await browser.close().catch(() => {});
  process.exit(1);
}
