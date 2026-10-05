// Staged recipes: stages are entered in order when their condition holds, never left, and the carry file follows the sinks across a change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { met, nextStage, rekeyCarry, absorbParked, whenText } from "../src/stages.js";
import { sinksAt, validateToken, type Sink, type TokenConfig } from "../src/config.js";

const SOL = "So11111111111111111111111111111111111111112", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const W = "9dZcuWdTRjStMFNpQGDsSUZvTBkhrGZXxFvNMkjbpYKv", W2 = "DjKWgaz5peaDPSdKBEFfQfbsMPgEQmCmCmRiHXrGcZ3c";
const holders = (payoutMint: string, share = 1): Sink => ({ type: "reflections", share, payoutMint, rule: { type: "pro-rata" }, minUsd: 10, distribution: "push" });
const token = { mint: "DATdVDpE3SzhJWyPSGpUYoCeN6qReTfBMURFJTUMLDQo", quoteMint: USDC };

test("conditions: graduation, a holder count from the last snapshot, a market cap in dollars", () => {
  assert.equal(met({ type: "graduation" }, { graduated: true, holders: null, mcapUsd: null }), true);
  assert.equal(met({ type: "graduation" }, { graduated: false, holders: 9999, mcapUsd: 1e9 }), false);
  assert.equal(met({ type: "holders", count: 100 }, { graduated: false, holders: 100, mcapUsd: null }), true);
  assert.equal(met({ type: "holders", count: 100 }, { graduated: false, holders: 99, mcapUsd: null }), false);
  assert.equal(met({ type: "holders", count: 100 }, { graduated: false, holders: null, mcapUsd: null }), false); // no snapshot yet: not met
  assert.equal(met({ type: "mcap", usd: 50_000 }, { graduated: false, holders: null, mcapUsd: 50_000 }), true);
  assert.equal(met({ type: "mcap", usd: 50_000 }, { graduated: false, holders: null, mcapUsd: null }), false); // no price: not met
});

test("stages are entered in order: a later milestone does not skip an earlier one, and two met at once are both entered", () => {
  const stages: TokenConfig["stages"] = [{ when: { type: "graduation" }, sinks: [holders(USDC)] }, { when: { type: "holders", count: 500 }, sinks: [holders(SOL)] }];
  assert.equal(nextStage(0, stages, { graduated: false, holders: 1000, mcapUsd: null }), 0); // holders met, graduation not: still stage 0
  assert.equal(nextStage(0, stages, { graduated: true, holders: 10, mcapUsd: null }), 1);
  assert.equal(nextStage(0, stages, { graduated: true, holders: 500, mcapUsd: null }), 2);
  assert.equal(nextStage(1, stages, { graduated: false, holders: 500, mcapUsd: null }), 2); // graduation is not re-checked once stage 1 was reached
  assert.equal(nextStage(2, stages, { graduated: false, holders: 0, mcapUsd: null }), 2);   // never back
  assert.equal(nextStage(0, undefined, { graduated: true, holders: 1, mcapUsd: null }), 0);
  assert.equal(whenText(stages[1].when), "once 500 wallets hold the token");
});

test("sinksAt: stage 0 is the launch recipe, k is stages[k-1], beyond the list the last stage", () => {
  const t = { sinks: [holders(USDC)], stages: [{ when: { type: "graduation" as const }, sinks: [holders(SOL)] }] };
  assert.equal((sinksAt(t, 0)[0] as any).payoutMint, USDC);
  assert.equal((sinksAt(t, 1)[0] as any).payoutMint, SOL);
  assert.equal((sinksAt(t, 7)[0] as any).payoutMint, SOL);
  assert.equal((sinksAt({ sinks: [holders(USDC)] }, 3)[0] as any).payoutMint, USDC);
});

test("the carry file follows a change of recipe: pots move to a sink paying the same asset, deferred SOL goes back to its wallet, the rest parks", () => {
  const oldSinks: Sink[] = [holders(SOL, 0.5), { type: "creator", share: 0.5, wallet: W, asset: "quote" }];
  const newSinks: Sink[] = [{ type: "treasury", share: 0.3, wallet: W2 }, holders(USDC, 0.2), holders(SOL, 0.5)];
  const carry = { "_pot:0": "1000", "_sink:1": "777", "someOwner": "5", "owner@mint": "9" };
  const re = rekeyCarry(carry, oldSinks, newSinks, token);
  assert.deepEqual(re, { "_pot:2": "1000", [W]: "777", someOwner: "5", "owner@mint": "9" });
  // no sink pays the old asset any more: the pot parks under its mint and joins the first sink that pays it later
  const parked = rekeyCarry({ "_pot:0": "1000" }, oldSinks, [holders(USDC)], token);
  assert.deepEqual(parked, { [`_parked:${SOL}`]: "1000" });
  assert.deepEqual(absorbParked(parked, [holders(USDC), holders(SOL)], token), { "_pot:1": "1000" });
  assert.deepEqual(absorbParked(parked, [holders(USDC)], token), parked);
});

test("validation: up to three stages, each a full recipe with a condition in range", () => {
  const base: TokenConfig = { mint: token.mint, symbol: "T", quoteMint: USDC, decimals: 6, exclusions: [], epochHours: 1, sinks: [holders(USDC)] };
  validateToken({ ...base, stages: [{ when: { type: "graduation" }, sinks: [holders(SOL)] }, { when: { type: "holders", count: 50 }, sinks: [holders(SOL)] }, { when: { type: "mcap", usd: 100_000 }, sinks: [holders(SOL)] }] });
  assert.throws(() => validateToken({ ...base, stages: Array(4).fill({ when: { type: "graduation" }, sinks: [holders(SOL)] }) }), /up to 3 stages/);
  assert.throws(() => validateToken({ ...base, stages: [{ when: { type: "holders", count: 1 }, sinks: [holders(SOL)] }] }), /holders count/);
  assert.throws(() => validateToken({ ...base, stages: [{ when: { type: "mcap", usd: 10 }, sinks: [holders(SOL)] }] }), /market cap/);
  assert.throws(() => validateToken({ ...base, stages: [{ when: { type: "graduation" }, sinks: [holders(SOL, 0.5)] }] }), /sum to 0.5/);
  assert.throws(() => validateToken({ ...base, stages: [{ when: { type: "later" } as any, sinks: [holders(SOL)] }] }), /needs a condition/);
});
