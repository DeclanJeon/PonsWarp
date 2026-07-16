import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateSessionCode, sanitizeCodeInput } from "./code.ts";

describe("sanitizeCodeInput", () => {
  it("uppercases and strips separators", () => {
    assert.equal(sanitizeCodeInput("a7k-4p2"), "A7K4P2");
    assert.equal(sanitizeCodeInput("384 291"), "384291");
  });

  it("limits to 6 chars", () => {
    assert.equal(sanitizeCodeInput("ABCDEFGH"), "ABCDEF");
  });
});

describe("generateSessionCode", () => {
  it("creates 6 char codes without ambiguous glyphs", () => {
    for (let i = 0; i < 20; i += 1) {
      const code = generateSessionCode();
      assert.equal(code.length, 6);
      assert.match(code, /^[A-Z2-9]+$/);
      assert.doesNotMatch(code, /[OIL01]/);
    }
  });
});
