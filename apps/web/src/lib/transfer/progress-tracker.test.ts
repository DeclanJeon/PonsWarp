import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProgressTracker } from "./progress-tracker.ts";

describe("ProgressTracker", () => {
  it("tracks progress ratio", () => {
    const t = new ProgressTracker(4000);
    t.reset(1000);
    t.setConnectionState("transferring");
    const snap = t.update(250, 250, 2000);
    assert.equal(snap.progress, 0.25);
    assert.equal(snap.transferredBytes, 250);
  });

  it("hides eta until enough samples", () => {
    const t = new ProgressTracker(4000);
    t.reset(10_000_000);
    t.setConnectionState("transferring");
    const snap = t.update(1000, 1000, 100);
    assert.equal(snap.etaSeconds, null);
  });

  it("computes window speed with samples", () => {
    const t = new ProgressTracker(4000);
    t.reset(10_000_000);
    t.setConnectionState("transferring");
    t.update(0, 0, 0);
    t.update(5_000_000, 5_000_000, 1000);
    const snap = t.snapshot(1000);
    assert.ok(snap.currentSpeedBps > 0);
  });
});
