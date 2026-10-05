// Pool fees after graduation: the dev's fixed 0.42% of the volume out of every claim (42/75 of it before Raydium kept a share, 56/95 at
// its 5%), the platform the rest, and the $1 floor below which nothing is claimed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPoolFees, worthForwarding, arriving, DEFAULT_RATES } from "../src/fees.js";

test("under the rates before 2026-10-01 the dev gets 42/75 of a claim, the platform the rest, and not a unit is created or lost", () => {
  for (const claimed of [0n, 1n, 74n, 75n, 4_712_662n, 999_999_999_999n]) {
    const { dev, platform } = splitPoolFees(claimed);
    assert.equal(dev + platform, claimed);
    assert.equal(dev, (claimed * 42n) / 75n);
  }
  assert.deepEqual(splitPoolFees(4_712_662n), { dev: 2_639_090n, platform: 2_073_572n }); // the first graduated pool's claim, as simulated on 2026-10-02
});

test("with Raydium keeping 5% of the creator fee at the claim, the dev still gets exactly 0.42% of the volume and the platform absorbs the cut", () => {
  const rates = { creatorFeeRate: 7500n, shareRate: 50000n }; // tier 9 since 2026-10-01
  const volume = 1_000_000_000_000n; // 1,000,000 USDC of swaps
  const accrued = (volume * 7500n) / 1_000_000n;       // 0.75% accrues in the pool
  const claimed = arriving(accrued, rates);            // 0.7125% leaves it at the claim
  assert.equal(claimed, (volume * 7125n) / 1_000_000n);
  const { dev, platform } = splitPoolFees(claimed, rates);
  assert.equal(dev, (volume * 4200n) / 1_000_000n);    // 0.42% of the volume, as promised
  assert.equal(platform, (volume * 2925n) / 1_000_000n); // 0.2925%, not 0.33%
  assert.equal(dev + platform, claimed);
  // the same split, as a fraction of what arrives: 56/95 (rounded down, never up)
  for (const c of [1n, 95n, 96n, 5_015_871n]) assert.equal(splitPoolFees(c, rates).dev, (c * 56n) / 95n);
});

test("a tier whose creator slice after Raydium's share is under 0.42% gives the dev everything that arrived", () => {
  const { dev, platform } = splitPoolFees(1_000n, { creatorFeeRate: 4000n, shareRate: 0n });
  assert.equal(dev, 1_000n); assert.equal(platform, 0n);
  assert.deepEqual(splitPoolFees(1_000n, { creatorFeeRate: 0n, shareRate: 0n }), { dev: 1_000n, platform: 0n });
  assert.deepEqual(DEFAULT_RATES, { creatorFeeRate: 7500n, shareRate: 0n });
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
