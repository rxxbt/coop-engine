// Pool fees after graduation: the dev's 42/75 of every claim, the platform's 33/75, and the $1 floor below which nothing is claimed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPoolFees, worthForwarding } from "../src/fees.js";

test("the dev gets 42/75 of a claim, the platform the rest, and not a unit is created or lost", () => {
  for (const claimed of [0n, 1n, 74n, 75n, 4_712_662n, 999_999_999_999n]) {
    const { dev, platform } = splitPoolFees(claimed);
    assert.equal(dev + platform, claimed);
    assert.equal(dev, (claimed * 42n) / 75n);
  }
  assert.deepEqual(splitPoolFees(4_712_662n), { dev: 2_639_090n, platform: 2_073_572n }); // the first graduated pool's claim, as simulated on 2026-10-02
});

test("dust stays in the pool: a dev's share under $1 is not claimed, a share of $1 or more is", () => {
  assert.equal(worthForwarding(999_999n, 6, 1).ok, false);           // 0.999999 USDC
  assert.equal(worthForwarding(1_000_000n, 6, 1).ok, true);          // 1 USDC
  assert.equal(worthForwarding(2_639_090n, 6, 0.9998).ok, true);
  assert.equal(worthForwarding(8_000_000n, 9, 122).ok, false);       // 0.008 SOL ≈ $0.98
  assert.equal(worthForwarding(9_000_000n, 9, 122).ok, true);        // 0.009 SOL ≈ $1.10
});

test("a payout asset the price feed cannot price is not claimed yet", () => {
  assert.deepEqual(worthForwarding(5_000_000n, 6, undefined), { ok: false, usd: null });
  assert.deepEqual(worthForwarding(5_000_000n, 6, 0), { ok: false, usd: null });
});
