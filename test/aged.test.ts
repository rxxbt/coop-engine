// Holding-time weighted rule with the dev's three dials (interval, step, cap), and the holder history that ages tokens, not wallets.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allocate, lotMultiplier, agedWeight, type AgedRule, type Holder } from "../src/rules.js";
import { Ledger } from "../src/ledger.js";
import { validateToken, type TokenConfig } from "../src/config.js";

const H = 3_600_000, T0 = Date.UTC(2026, 8, 29, 12, 0, 0);
const rule: AgedRule = { type: "time-weighted", intervalHours: 24, step: 0.1, cap: 3 };
const holder = (owner: string, lots: [bigint, number][]): Holder => ({ owner, amount: lots.reduce((a, [x]) => a + x, 0n), epochsHeld: 0, everSold: false, lots: lots.map(([amount, since]) => ({ amount, since })) });
const tmpLedger = () => new Ledger(fs.mkdtempSync(path.join(os.tmpdir(), "coop-ledger-")), "TESTMINT");

test("no free first interval: a lot starts at 1× and earns its first step only after a full interval", () => {
  assert.equal(lotMultiplier(rule, T0, T0), 100n);
  assert.equal(lotMultiplier(rule, T0, T0 + 24 * H - 1), 100n);
  assert.equal(lotMultiplier(rule, T0, T0 + 24 * H), 110n);
  assert.equal(lotMultiplier(rule, T0, T0 + 5 * 24 * H + 3 * H), 150n);
});

test("the multiplier stops at the cap", () => {
  assert.equal(lotMultiplier(rule, T0, T0 + 20 * 24 * H), 300n);
  assert.equal(lotMultiplier(rule, T0, T0 + 400 * 24 * H), 300n);
  const fast: AgedRule = { type: "time-weighted", intervalHours: 6, step: 1, cap: 10 };
  assert.equal(lotMultiplier(fast, T0, T0 + 6 * H), 200n);
  assert.equal(lotMultiplier(fast, T0, T0 + 9 * 6 * H), 1000n);
  assert.equal(lotMultiplier(fast, T0, T0 + 50 * 6 * H), 1000n);
});

test("the holding interval is independent of the payout epoch: hourly snapshots, daily steps", () => {
  const at = T0 + 47 * H; // 47 hourly payouts later, still only one full 24 h interval
  assert.equal(lotMultiplier(rule, T0, at), 110n);
});

test("tokens age, not wallets: buying into an old wallet earns nothing extra on the new tokens", () => {
  const at = T0 + 20 * 24 * H;
  const old = holder("old", [[1_000n, T0]]);                              // held 20 days: 3×
  const topped = holder("topped", [[10n, T0], [990n, at]]);               // parked 10 tokens for 20 days, bought 990 a moment ago
  const fresh = holder("fresh", [[1_000n, at]]);
  assert.equal(agedWeight(rule, old, at), 1_000n * 300n);
  assert.equal(agedWeight(rule, topped, at), 10n * 300n + 990n * 100n);
  const r = allocate(rule, [old, topped, fresh], 1_000_000n, { at });
  assert.ok(r.allocations.get("old")! > r.allocations.get("topped")!);
  // the parked 10 tokens are worth 20 extra token-weights, nothing more
  assert.equal(agedWeight(rule, topped, at) - agedWeight(rule, fresh, at), 10n * 200n);
});

test("splitting a wallet never increases its payout: the tokens moved start at 1× and the sender is reset", () => {
  const at = T0 + 10 * 24 * H;
  const whole = allocate(rule, [holder("w", [[1_000n, T0]]), holder("x", [[1_000n, T0]])], 1_000_000n, { at }).allocations.get("w")!;
  const split = allocate(rule, [holder("w1", [[500n, at]]), holder("w2", [[500n, at]]), holder("x", [[1_000n, T0]])], 1_000_000n, { at });
  assert.ok(split.allocations.get("w1")! + split.allocations.get("w2")! < whole);
});

test("history: holding keeps ageing, buying opens a new lot, selling anything resets the wallet", () => {
  const l = tmpLedger();
  let [a] = l.applySnapshot(new Map([["a", 1_000n]]), true, T0);
  assert.deepEqual(a.lots, [{ amount: 1_000n, since: T0 }]);
  [a] = l.applySnapshot(new Map([["a", 1_000n]]), true, T0 + H);                // unchanged: same lot, same start
  assert.deepEqual(a.lots, [{ amount: 1_000n, since: T0 }]);
  [a] = l.applySnapshot(new Map([["a", 1_500n]]), true, T0 + 2 * H);            // bought 500: old lot untouched, new lot starts now
  assert.deepEqual(a.lots, [{ amount: 1_000n, since: T0 }, { amount: 500n, since: T0 + 2 * H }]);
  [a] = l.applySnapshot(new Map([["a", 1_499n]]), true, T0 + 3 * H);            // sold 1 token: everything starts again
  assert.deepEqual(a.lots, [{ amount: 1_499n, since: T0 + 3 * H }]);
  assert.equal(a.everSold, true);
});

test("history: a wallet that leaves the snapshot and returns starts fresh; a dry run changes nothing on disk", () => {
  const l = tmpLedger();
  l.applySnapshot(new Map([["a", 1_000n]]), true, T0);
  l.applySnapshot(new Map(), true, T0 + H);                                       // sold everything
  const [back] = l.applySnapshot(new Map([["a", 1_000n]]), true, T0 + 2 * H);
  assert.deepEqual(back.lots, [{ amount: 1_000n, since: T0 + 2 * H }]);
  const before = JSON.stringify(l.readHistory());
  l.applySnapshot(new Map([["a", 5n]]), false, T0 + 3 * H);
  assert.equal(JSON.stringify(l.readHistory()), before);
});

test("history written before lots existed starts every wallet at 1× on the first snapshot after the change", () => {
  const l = tmpLedger();
  fs.writeFileSync(path.join(l.tokenDir, "holders.json"), JSON.stringify({ a: { epochsHeld: 7, everSold: false, lastAmount: "1000" } }));
  const [a] = l.applySnapshot(new Map([["a", 1_000n]]), true, T0);
  assert.deepEqual(a.lots, [{ amount: 1_000n, since: T0 }]);
  assert.equal(a.epochsHeld, 8); // the legacy counter keeps counting for tokens on the old rule
});

test("the legacy rule still reads per-wallet epochs, so tokens registered before the change pay as before", () => {
  const hs: Holder[] = [{ owner: "new", amount: 100n, epochsHeld: 0, everSold: false }, { owner: "old", amount: 100n, epochsHeld: 9, everSold: false }];
  const r = allocate({ type: "time-weighted", maxEpochs: 3 }, hs, 400n);
  assert.equal(r.allocations.get("new"), 100n);
  assert.equal(r.allocations.get("old"), 300n);
});

test("validation: the three dials have bounds, and legacy configs stay valid", () => {
  const base = (r: unknown): TokenConfig => ({ mint: "So11111111111111111111111111111111111111112", symbol: "T", quoteMint: "So11111111111111111111111111111111111111112", decimals: 6, exclusions: [], epochHours: 1,
    sinks: [{ type: "reflections", share: 1, payoutMint: "same", rule: r as any, distribution: "push" }] });
  validateToken(base({ type: "time-weighted", intervalHours: 24, step: 0.1, cap: 3 }));
  validateToken(base({ type: "time-weighted", intervalHours: 6, step: 0.01, cap: 1.1 }));
  validateToken(base({ type: "time-weighted", intervalHours: 12, step: 1, cap: 10 }));
  validateToken(base({ type: "time-weighted", maxEpochs: 4 }));
  assert.throws(() => validateToken(base({ type: "time-weighted", intervalHours: 1, step: 0.1, cap: 3 })));
  assert.throws(() => validateToken(base({ type: "time-weighted", intervalHours: 24, step: 0, cap: 3 })));
  assert.throws(() => validateToken(base({ type: "time-weighted", intervalHours: 24, step: 1.5, cap: 3 })));
  assert.throws(() => validateToken(base({ type: "time-weighted", intervalHours: 24, step: 0.1, cap: 11 })));
  assert.throws(() => validateToken(base({ type: "time-weighted", intervalHours: 24, step: 0.1, cap: 1 })));
});

test("a token can carry one of each main option, seven sinks, and up to ten", () => {
  const W = "FUBpgovMNbAJ62J18RSpJ7ZsFSfF1Ti5exAFSDV6BrSH", SOL = "So11111111111111111111111111111111111111112";
  const refl = (rule: unknown, share: number) => ({ type: "reflections", share, payoutMint: SOL, rule, minUsd: 10, distribution: "push" });
  const seven = [
    { type: "creator", share: 0.1, wallet: W }, { type: "treasury", share: 0.1, wallet: W }, { type: "burn", share: 0.1 },
    refl({ type: "pro-rata" }, 0.2), refl({ type: "time-weighted", intervalHours: 24, step: 0.1, cap: 3 }, 0.2),
    refl({ type: "never-sold-bonus", bonusShare: 0.2 }, 0.2), refl({ type: "lottery", winners: 5 }, 0.1),
  ];
  const token = (sinks: unknown[]): TokenConfig => ({ mint: SOL, symbol: "T", quoteMint: SOL, decimals: 6, exclusions: [], epochHours: 1, sinks: sinks as any });
  validateToken(token(seven));
  validateToken(token(Array.from({ length: 10 }, () => ({ type: "burn", share: 0.1 }))));
  assert.throws(() => validateToken(token(Array.from({ length: 11 }, () => ({ type: "burn", share: 1 / 11 })))));
});
