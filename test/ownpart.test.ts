import { test } from "node:test";
import assert from "node:assert/strict";
import { ownPart, payable } from "../src/epoch.js";

test("a token nobody pays out in counts the operator's whole balance, as before", () => {
  assert.equal(ownPart(1_000n, 100n, 50n, false), 1_000n);
});

test("a token others pay out in counts only its sweep and its own kept pots", () => {
  // a live case on 2026-10-22: 545,190,452,085 of the balance were another token's treasury part, 7,000 the sweep, nothing kept last epoch
  assert.equal(ownPart(545_190_452_085n + 7_000n, 7_000n, 0n, true), 7_000n);
  assert.equal(ownPart(10_000n, 7_000n, 2_000n, true), 9_000n, "its own kept pots count");
});

test("never more than the operator holds", () => {
  assert.equal(ownPart(5_000n, 7_000n, 2_000n, true), 5_000n);
});

test("a payment that is covered goes out whole", () => {
  assert.equal(payable(100n, 100n), 100n);
  assert.equal(payable(100n, 1_000n), 100n);
});

test("a few base units short (rounding) sends what the operator holds", () => {
  // a live case on 2026-10-22: the treasury part was 545,190,452,086, the operator held 545,190,452,085
  assert.equal(payable(545_190_452_086n, 545_190_452_085n), 545_190_452_085n);
  assert.equal(payable(100n, 90n), 90n, "ten short is still rounding");
});

test("more than a few units short is not rounding: the payment goes out as it is and fails loudly", () => {
  assert.equal(payable(100n, 89n), null);
  assert.equal(payable(100n, 0n), null);
});
