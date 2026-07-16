import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { basename } from "node:path";

const BASE = process.env.BASE_URL || "http://100.65.42.93:3000";
const SENDER_BASE = process.env.SENDER_BASE_URL || "http://localhost:3000";
const FILE = process.env.TEST_FILE || "/home/declan/Videos/396573_720p.mp4";
const REMOTE_CDP = process.env.REMOTE_CDP || "http://127.0.0.1:9223";
const OUT_DIR = process.env.OUT_DIR || "/tmp/ponswarp-cross-device";
mkdirSync(OUT_DIR, { recursive: true });

const fileStat = statSync(FILE);
const fileName = basename(FILE);
const fileSize = fileStat.size;

function log(...args) {
  console.log("[cross-device]", ...args);
}

function dump(name, obj) {
  writeFileSync(`${OUT_DIR}/${name}.json`, JSON.stringify(obj, null, 2));
}

const report = {
  startedAt: new Date().toISOString(),
  baseUrl: BASE,
  file: { path: FILE, name: fileName, bytes: fileSize },
  phases: [],
  metrics: {},
  architecture: {},
  errors: [],
};

const localBrowser = await chromium.launch({
  headless: true,
  args: ["--disable-web-security", "--use-fake-ui-for-media-stream"],
});
const sender = await (await localBrowser.newContext()).newPage();

let remoteBrowser;
try {
  remoteBrowser = await chromium.connectOverCDP(REMOTE_CDP);
} catch (e) {
  report.errors.push(`CDP connect failed: ${e.message}`);
  dump("report", report);
  console.error("FAILED_CDP", e);
  await localBrowser.close();
  process.exit(2);
}

const remoteContext = remoteBrowser.contexts()[0] || (await remoteBrowser.newContext());
const receiver = remoteContext.pages()[0] || (await remoteContext.newPage());

const senderLogs = [];
const receiverLogs = [];
sender.on("console", (m) => senderLogs.push(`${m.type()}: ${m.text()}`));
receiver.on("console", (m) => receiverLogs.push(`${m.type()}: ${m.text()}`));
sender.on("pageerror", (e) => senderLogs.push(`pageerror: ${e.message}`));
receiver.on("pageerror", (e) => receiverLogs.push(`pageerror: ${e.message}`));

try {
  log("sender open", `${SENDER_BASE}/send`);
  await sender.goto(`${SENDER_BASE}/send`, { waitUntil: "networkidle", timeout: 60000 });
  await sender.evaluate(() => {
    try {
      sessionStorage.clear();
      localStorage.clear();
    } catch {}
  });
  await sender.reload({ waitUntil: "networkidle" });
  await sender.locator('input[type="file"]').first().setInputFiles(FILE);

  await sender.waitForSelector("text=SHARE THIS CODE", { timeout: 120000 });
  const code = (await sender.locator("p.font-mono").first().innerText())
    .replace(/[^A-Z0-9]/gi, "")
    .slice(0, 6);
  log("room code", code);
  report.metrics.code = code;
  report.phases.push({ t: Date.now(), phase: "room-open", code });

  // capture connection mode if present later
  const receiveUrl = `${BASE}/receive/${code}`;
  log("receiver open", receiveUrl);
  const tConnect0 = Date.now();
  await receiver.goto(receiveUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  // wait for transfer to start / progress
  await Promise.race([
    receiver.waitForSelector("text=RECEIVING", { timeout: 90000 }),
    receiver.waitForSelector("text=RECEIVED", { timeout: 90000 }),
    sender.waitForSelector("text=SENDING", { timeout: 90000 }),
    sender.waitForSelector("text=SENT", { timeout: 90000 }),
  ]);
  report.phases.push({ t: Date.now(), phase: "transfer-visible", connectMs: Date.now() - tConnect0 });

  // poll progress text for throughput samples
  const samples = [];
  const t0 = Date.now();
  let lastBytes = 0;
  for (let i = 0; i < 600; i++) {
    const sText = await sender.locator("body").innerText().catch(() => "");
    const rText = await receiver.locator("body").innerText().catch(() => "");
    const pctMatch = (sText.match(/(\d+(?:\.\d+)?)%/) || rText.match(/(\d+(?:\.\d+)?)%/));
    const speedMatch = (sText.match(/([\d.]+)\s*MB\/s/) || rText.match(/([\d.]+)\s*MB\/s/));
    const pct = pctMatch ? Number(pctMatch[1]) : null;
    const mbpsUi = speedMatch ? Number(speedMatch[1]) * 8 : null; // MB/s -> Mbps approx
    const elapsed = (Date.now() - t0) / 1000;
    const estBytes = pct != null ? (pct / 100) * fileSize : null;
    let instMbps = null;
    if (estBytes != null && samples.length) {
      const prev = samples[samples.length - 1];
      const dB = estBytes - (prev.estBytes || 0);
      const dT = Math.max(elapsed - prev.elapsed, 0.001);
      instMbps = (dB * 8) / dT / 1e6;
    }
    samples.push({ elapsed, pct, mbpsUi, estBytes, instMbps });
    if (sText.includes("SENT") && rText.includes("RECEIVED")) break;
    if (sText.includes("FAILED") || rText.includes("FAILED")) {
      throw new Error(`transfer failed\nS:${sText.slice(0, 400)}\nR:${rText.slice(0, 400)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const t1 = Date.now();
  const durationSec = Math.max((t1 - t0) / 1000, 0.001);
  const avgMbps = (fileSize * 8) / durationSec / 1e6;
  const peakUi = Math.max(...samples.map((s) => s.mbpsUi || 0), 0);
  const peakInst = Math.max(...samples.map((s) => s.instMbps || 0), 0);

  // try read connection mode from debug hook / UI text
  const senderDebug = await sender
    .evaluate(() => window.__ponswarpDebug || null)
    .catch(() => null);
  const receiverDebug = await receiver
    .evaluate(() => window.__ponswarpDebug || null)
    .catch(() => null);
  const finalSender = await sender.locator("body").innerText();
  const finalReceiver = await receiver.locator("body").innerText();
  const mode =
    senderDebug?.connectionMode ||
    receiverDebug?.connectionMode ||
    (/direct/i.test(finalSender + finalReceiver)
      ? "direct-or-labeled"
      : /relay|turn|중계/i.test(finalSender + finalReceiver)
        ? "relay"
        : "unknown");

  report.metrics = {
    ...report.metrics,
    durationSec,
    avgMbps,
    peakUiMbps: peakUi,
    peakInstMbps: peakInst,
    samples: samples.slice(-30),
    sampleCount: samples.length,
    connectionMode: mode,
    senderDebug,
    receiverDebug,
    completed: finalSender.includes("SENT") && finalReceiver.includes("RECEIVED"),
  };
  report.phases.push({ t: Date.now(), phase: "completed", durationSec, avgMbps });
  report.senderFinal = finalSender.slice(0, 500);
  report.receiverFinal = finalReceiver.slice(0, 500);
  report.senderLogs = senderLogs.filter((l) => !l.includes("Download the React") && !l.includes("[HMR]")).slice(-50);
  report.receiverLogs = receiverLogs.filter((l) => !l.includes("Download the React") && !l.includes("[HMR]")).slice(-50);

  dump("report", report);
  dump("samples", samples);
  console.log("TRANSFER_OK", JSON.stringify({ code, durationSec, avgMbps, peakUi, peakInst, mode, fileSize, senderDebug, receiverDebug }, null, 2));
  await localBrowser.close();
  // do not close remote browser fully (owned by chrome process), just disconnect
  await remoteBrowser.close().catch(() => {});
  process.exit(report.metrics.completed ? 0 : 1);
} catch (error) {
  report.errors.push(String(error?.stack || error));
  report.senderLogs = senderLogs.slice(-80);
  report.receiverLogs = receiverLogs.slice(-80);
  try {
    report.senderFinal = (await sender.locator("body").innerText()).slice(0, 800);
  } catch {}
  try {
    report.receiverFinal = (await receiver.locator("body").innerText()).slice(0, 800);
  } catch {}
  dump("report", report);
  console.error("TRANSFER_FAIL", error);
  await localBrowser.close().catch(() => {});
  await remoteBrowser?.close?.().catch(() => {});
  process.exit(1);
}
