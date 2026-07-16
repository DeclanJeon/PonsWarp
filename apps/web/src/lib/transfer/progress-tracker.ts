import type { TransferProgress } from "../types";

const EMPTY_PROGRESS: TransferProgress = {
  totalBytes: 0,
  transferredBytes: 0,
  progress: 0,
  currentSpeedBps: 0,
  averageSpeedBps: 0,
  etaSeconds: null,
  currentFileIndex: 0,
  currentFileTransferredBytes: 0,
  currentFileTotalBytes: 0,
  connectionState: "waiting",
};

type Sample = { t: number; bytes: number };

export class ProgressTracker {
  private samples: Sample[] = [];
  private totalBytes = 0;
  private transferredBytes = 0;
  private currentFileIndex = 0;
  private currentFileTransferredBytes = 0;
  private currentFileTotalBytes = 0;
  private startedAt: number | null = null;
  private lastStableEta: number | null = null;
  private connectionState: TransferProgress["connectionState"] = "waiting";
  private readonly windowMs: number;

  constructor(windowMs = 4000) {
    this.windowMs = windowMs;
  }

  reset(totalBytes = 0): void {
    this.samples = [];
    this.totalBytes = totalBytes;
    this.transferredBytes = 0;
    this.currentFileIndex = 0;
    this.currentFileTransferredBytes = 0;
    this.currentFileTotalBytes = 0;
    this.startedAt = null;
    this.lastStableEta = null;
    this.connectionState = "waiting";
  }

  setConnectionState(state: TransferProgress["connectionState"]): void {
    this.connectionState = state;
    if (state === "paused" || state === "reconnecting" || state === "failed") {
      this.lastStableEta = null;
    }
  }

  setTotals(totalBytes: number): void {
    this.totalBytes = totalBytes;
  }

  setCurrentFile(index: number, total: number, transferred = 0): void {
    this.currentFileIndex = index;
    this.currentFileTotalBytes = total;
    this.currentFileTransferredBytes = transferred;
  }

  update(transferredBytes: number, fileTransferred?: number, now = performance.now()): TransferProgress {
    if (this.startedAt == null && transferredBytes > 0) this.startedAt = now;
    this.transferredBytes = transferredBytes;
    if (fileTransferred != null) this.currentFileTransferredBytes = fileTransferred;

    this.samples.push({ t: now, bytes: transferredBytes });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 2 && this.samples[0]!.t < cutoff) {
      this.samples.shift();
    }

    return this.snapshot(now);
  }

  snapshot(now = performance.now()): TransferProgress {
    const progress = this.totalBytes > 0 ? Math.min(1, this.transferredBytes / this.totalBytes) : 0;
    const currentSpeedBps = this.computeWindowSpeed(now);
    const averageSpeedBps = this.computeAverageSpeed(now);
    const etaSeconds = this.computeEta(currentSpeedBps, averageSpeedBps, now);

    return {
      totalBytes: this.totalBytes,
      transferredBytes: this.transferredBytes,
      progress,
      currentSpeedBps,
      averageSpeedBps,
      etaSeconds,
      currentFileIndex: this.currentFileIndex,
      currentFileTransferredBytes: this.currentFileTransferredBytes,
      currentFileTotalBytes: this.currentFileTotalBytes,
      connectionState: this.connectionState,
    };
  }

  private computeWindowSpeed(now: number): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0.05) return 0;
    return Math.max(0, (last.bytes - first.bytes) / dt);
  }

  private computeAverageSpeed(now: number): number {
    if (this.startedAt == null || this.transferredBytes <= 0) return 0;
    const dt = (now - this.startedAt) / 1000;
    if (dt <= 0.2) return 0;
    return this.transferredBytes / dt;
  }

  private computeEta(current: number, average: number, now: number): number | null {
    if (
      this.connectionState === "paused" ||
      this.connectionState === "reconnecting" ||
      this.connectionState === "failed" ||
      this.connectionState === "waiting"
    ) {
      return null;
    }

    const remaining = this.totalBytes - this.transferredBytes;
    if (remaining <= 0) return 0;

    if (this.startedAt == null || now - this.startedAt < 1500 || this.samples.length < 3) {
      return null;
    }

    const speed = current > 0 ? current * 0.7 + average * 0.3 : average;
    if (speed < 1024) {
      this.lastStableEta = null;
      return null;
    }

    const eta = remaining / speed;
    if (this.lastStableEta != null) {
      const delta = Math.abs(eta - this.lastStableEta) / Math.max(this.lastStableEta, 1);
      if (delta > 0.55) {
        this.lastStableEta = eta;
        return null;
      }
    }

    this.lastStableEta = eta;
    return eta;
  }
}

export function createEmptyProgress(): TransferProgress {
  return { ...EMPTY_PROGRESS };
}
