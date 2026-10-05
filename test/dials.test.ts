// The dials of 2026-10-05: a minimum holding age on any rule, a jackpot lottery, the vesting and referral fields' validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, agedHolder, type Holder } from "../src/rules.js";
import { validateToken, type TokenConfig } from "../src/config.js";
import { verifyEpoch } from "../src/verify.js";

const H = 3_600_000, T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", MINT = "DATdVDpE3SzhJWyPSGpUYoCeN6qReTfBMURFJTUMLDQo";
const holder = (owner: string, lots: [bigint, number][]): Holder => ({ owner, amount: lots.reduce((a, [x]) => a + x, 0n), epochsHeld: 0, everSold: false, lots: lots.map(([amount, since]) => ({ amount, since })) });

test("minimum holding age: only lots old enough count, per lot, for eligibility and for the split", () => {
  const at = T0 + 4 * H, minAgeMs = 3 * H;
  const sniper = holder("sniper", [[1_000n, T0 + 3.5 * H]]);            // bought 30 minutes ago
  const stayer = holder("stayer", [[1_000n, T0]]);                        // held 4 hours
  const topped = holder("topped", [[100n, T0], [900n, T0 + 3.5 * H]]);   // 100 old tokens, 900 fresh
  assert.equal(agedHolder(sniper, minAgeMs, at).amount, 0n);
  assert.equal(agedHolder(stayer, minAgeMs, at).amount, 1_000n);
  assert.equal(agedHolder(topped, minAgeMs, at).amount, 100n);
  const r = allocate({ type: "pro-rata" }, [sniper, stayer, topped], 1_100_000n, { at, minAgeMs });
  assert.equal(r.eligible, 2);
  assert.equal(r.allocations.has("sniper"), false);
  assert.equal(r.allocations.get("stayer"), 1_000_000n);
  assert.equal(r.allocations.get("topped"), 100_000n);
  // exactly at the age the lot counts; a minute before it does not
  assert.equal(agedHolder(stayer, 4 * H, at).amount, 1_000n);
  assert.equal(agedHolder(stayer, 4 * H + 60_000, at).amount, 0n);
});

test("minimum holding age: a snapshot row without lots (before 2026-09-29) counts whole; 0 or absent changes nothing", () => {
  const old: Holder = { owner: "old", amount: 500n, epochsHeld: 3, everSold: false };
  assert.equal(agedHolder(old, 3 * H, T0).amount, 500n);
  const h = holder("h", [[500n, T0]]);
  assert.equal(agedHolder(h, 0, T0 + H).amount, 500n);
  assert.equal(agedHolder(h, undefined, T0 + H).amount, 500n);
});

test("minimum holding age: splitting a wallet or moving tokens never raises the payout (moved tokens are fresh lots)", () => {
  const at = T0 + 10 * H, minAgeMs = 6 * H;
  const whole = allocate({ type: "pro-rata" }, [holder("w", [[1_000n, T0]]), holder("x", [[1_000n, T0]])], 1_000_000n, { at, minAgeMs }).allocations.get("w")!;
  const split = allocate({ type: "pro-rata" }, [holder("w1", [[500n, T0]]), holder("w2", [[500n, at - H]]), holder("x", [[1_000n, T0]])], 1_000_000n, { at, minAgeMs });
  assert.ok((split.allocations.get("w1") ?? 0n) + (split.allocations.get("w2") ?? 0n) < whole);
});

test("minimum holding age under the other rules: holding-time weights only the old lots, the lottery draws only among them", () => {
  const at = T0 + 30 * H, minAgeMs = 24 * H;
  const old = holder("old", [[1_000n, T0]]), fresh = holder("fresh", [[1_000_000n, at - H]]);
  const tw = allocate({ type: "time-weighted", intervalHours: 6, step: 0.5, cap: 3 }, [old, fresh], 1_000_000n, { at, minAgeMs });
  assert.deepEqual([...tw.allocations.keys()], ["old"]);
  const lot = allocate({ type: "lottery", winners: 3 }, [old, fresh], 1_000_000n, { at, minAgeMs, seed: "s" });
  assert.deepEqual([...lot.allocations.keys()], ["old"]);
  const ns = allocate({ type: "never-sold-bonus", bonusShare: 1 }, [old, fresh], 1_000_000n, { at, minAgeMs });
  assert.deepEqual([...ns.allocations.keys()], ["old"]);
});

test("verify recomputes an epoch under the sink's minimum holding age and under the recipe stage it ran in", () => {
  const at = T0 + 4 * H;
  const token: TokenConfig = { mint: MINT, symbol: "T", quoteMint: USDC, decimals: 6, exclusions: [], epochHours: 1,
    sinks: [{ type: "reflections", share: 1, payoutMint: USDC, rule: { type: "pro-rata" }, minUsd: 2, minAgeHours: 3, distribution: "push" }],
    stages: [{ when: { type: "graduation" }, sinks: [{ type: "reflections", share: 1, payoutMint: USDC, rule: { type: "pro-rata" }, minUsd: 2, distribution: "push" }] }] };
  const snapshot = { slot: 1, at: new Date(at).toISOString(), holders: [{ owner: "sniper", amount: "1000", epochsHeld: 0, everSold: false, lots: [["1000", T0 + 3.5 * H]] as [string, number][] }, { owner: "stayer", amount: "1000", epochsHeld: 0, everSold: false, lots: [["1000", T0]] as [string, number][] }] };
  const stage0 = { epoch: 1, ranAt: snapshot.at, dryRun: false, mint: MINT, tax: { withheldBefore: "0", harvested: 0, withdrawn: "0" }, signatures: [], snapshot,
    sinks: [{ type: "reflections", pot: "1000000", minAmount: "0", allocations: [{ owner: "stayer", amount: "1000000" }] }] };
  assert.equal(verifyEpoch(stage0 as any, token).ok, true);
  // the same allocations claimed under stage 1 (no age) would be wrong: the sniper should have been paid too
  assert.equal(verifyEpoch({ ...stage0, stage: 1 } as any, token).ok, false);
  const stage1 = { ...stage0, stage: 1, sinks: [{ type: "reflections", pot: "1000000", minAmount: "0", allocations: [{ owner: "sniper", amount: "500000" }, { owner: "stayer", amount: "500000" }] }] };
  assert.equal(verifyEpoch(stage1 as any, token).ok, true);
});

test("validation of the new dials: minimum age, jackpot interval, vesting, referral", () => {
  const base: TokenConfig = { mint: MINT, symbol: "T", quoteMint: USDC, decimals: 6, exclusions: [], epochHours: 1,
    sinks: [{ type: "reflections", share: 1, payoutMint: USDC, rule: { type: "lottery", winners: 5, every: 24 }, minUsd: 2, minAgeHours: 6, distribution: "push" }] };
  validateToken(base);
  assert.throws(() => validateToken({ ...base, sinks: [{ ...(base.sinks[0] as any), minAgeHours: 1.5 }] }), /minAgeHours/);
  assert.throws(() => validateToken({ ...base, sinks: [{ ...(base.sinks[0] as any), minAgeHours: 169 }] }), /minAgeHours/);
  assert.throws(() => validateToken({ ...base, sinks: [{ ...(base.sinks[0] as any), rule: { type: "lottery", winners: 5, every: 0 } }] }), /lottery every/);
  validateToken({ ...base, vesting: { share: 0.05, cliffDays: 30, unlockDays: 90, earns: true } });
  assert.throws(() => validateToken({ ...base, vesting: { share: 0.9, cliffDays: 30, unlockDays: 90, earns: true } }), /vesting share/);
  assert.throws(() => validateToken({ ...base, vesting: { share: 0.05, cliffDays: 400, unlockDays: 90, earns: true } }), /vesting cliff/);
  assert.throws(() => validateToken({ ...base, vesting: { share: 0.05, cliffDays: 30, unlockDays: 90, earns: "yes" as any } }), /earns/);
  validateToken({ ...base, referralBps: 100 });
  assert.throws(() => validateToken({ ...base, referralBps: 101 }), /referralBps/);
  assert.throws(() => validateToken({ ...base, referralBps: 0.5 }), /referralBps/);
});
