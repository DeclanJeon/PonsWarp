import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBytes, formatCodeDisplay, formatEta, formatPercent, formatSpeed } from "./bytes.ts";

describe("formatBytes", () => {
  it("formats zero and bytes", () => {
    assert.equal(formatBytes(0), "0B");
    assert.equal(formatBytes(512), "512B");
  });

  it("formats larger units", () => {
    assert.equal(formatBytes(1024), "1KB");
    assert.match(formatBytes(1.84 * 1024 ** 3), /1\.84GB/);
  });
});

describe("formatSpeed", () => {
  it("appends /s", () => {
    assert.equal(formatSpeed(0), "0B/s");
    assert.match(formatSpeed(11.2 * 1024 * 1024), /MB\/s/);
  });
});

describe("formatEta", () => {
  it("handles unstable and short eta", () => {
    assert.equal(formatEta(null), "남은 시간을 계산하고 있습니다");
    assert.equal(formatEta(0.2), "거의 완료");
    assert.match(formatEta(52), /52초/);
  });
});

describe("formatPercent", () => {
  it("clamps and formats", () => {
    assert.equal(formatPercent(0), "0%");
    assert.equal(formatPercent(0.68), "68%");
  });
});

describe("formatCodeDisplay", () => {
  it("groups code", () => {
    assert.equal(formatCodeDisplay("A7K4P2"), "A7K 4P2");
  });
});
