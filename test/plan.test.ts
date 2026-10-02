// One swap per payout asset per epoch: which sinks share a swap, and how what the swap delivered is split between them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planConversions, splitDelivered } from "../src/plan.js";
import type { Sink } from "../src/config.js";

const TOKEN = "AUEsCrSHz21WmibhBm9UN3Ka7yRxMnxsBcS9Df5uaMfS", SOL = "So11111111111111111111111111111111111111112";
const COOP = "DSZSngBU2VpMKCQSqMJkS3YvT5jYn2EbKWppZY6rZWmk", NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const W = "FUBpgovMNbAJ62J18RSpJ7ZsFSfF1Ti5exAFSDV6BrSH";
const refl = (share: number, payoutMint: string, rule: unknown = { type: "pro-rata" }): Sink => ({ type: "reflections", share, payoutMint, rule: rule as any, minUsd: 10, distribution: "push" });
const token = (sinks: Sink[], quoteMint = SOL) => ({ mint: TOKEN, quoteMint, sinks });
const potsOf = (sinks: Sink[], available: bigint) => sinks.map((s) => (available * BigInt(Math.round(s.share * 1_000_000))) / 1_000_000n);
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

test("a token with one sink converts exactly as before: one swap for the whole pot", () => {
  const sinks: Sink[] = [{ type: "creator", share: 1, wallet: W }];
  const plan = planConversions(token(sinks), [15_308_431_349_200n]);
  assert.deepEqual(plan, [{ mint: SOL, sinks: [0], amount: 15_308_431_349_200n }]);
  assert.deepEqual(splitDelivered(22_217_737n, [15_308_431_349_200n]), [22_217_737n]);
});

test("one of each main option, seven sinks all paying in SOL: six swaps become one, the burn needs none", () => {
  const sinks: Sink[] = [
    { type: "creator", share: 0.1, wallet: W }, { type: "treasury", share: 0.1, wallet: W }, { type: "burn", share: 0.1 },
    refl(0.2, SOL), refl(0.2, SOL, { type: "time-weighted", intervalHours: 24, step: 0.1, cap: 3 }),
    refl(0.2, SOL, { type: "never-sold-bonus", bonusShare: 0.2 }), refl(0.1, SOL, { type: "lottery", winners: 5 }),
  ];
  const pots = potsOf(sinks, 1_000_000_000_000n);
  const plan = planConversions(token(sinks), pots);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].sinks, [0, 1, 3, 4, 5, 6]);
  assert.equal(plan[0].amount, 900_000_000_000n);
});

test("sinks are grouped by the asset they pay in, whatever their type", () => {
  const sinks: Sink[] = [
    { type: "creator", share: 0.2, wallet: W },                       // the quote (NVDAx here)
    { type: "treasury", share: 0.1, wallet: W, asset: COOP },
    { type: "burn", share: 0.1, asset: COOP },                         // buy COOP and burn it
    refl(0.3, NVDAX), refl(0.2, COOP),
    { type: "treasury", share: 0.05, wallet: W, asset: "token" },      // sent as the token: no swap
    refl(0.05, "same"),                                                // paid in the token itself: no swap
  ];
  const pots = potsOf(sinks, 2_000_000n);
  const plan = planConversions(token(sinks, NVDAX), pots);
  assert.deepEqual(plan.map((p) => [p.mint, p.sinks]), [[NVDAX, [0, 3]], [COOP, [1, 2, 4]]]);
  assert.equal(plan[0].amount, pots[0] + pots[3]);
  assert.equal(plan[1].amount, pots[1] + pots[2] + pots[4]);
});

test("a holder sink with no eligible holder converts nothing and leaves the swap to the others; an empty pot is left out", () => {
  const sinks: Sink[] = [{ type: "creator", share: 0.5, wallet: W }, refl(0.5, SOL)];
  assert.deepEqual(planConversions(token(sinks), [500n, 500n], new Set([1])), [{ mint: SOL, sinks: [0], amount: 500n }]);
  assert.deepEqual(planConversions(token(sinks), [0n, 0n]), []);
  assert.deepEqual(planConversions(token(sinks), [0n, 7n]), [{ mint: SOL, sinks: [1], amount: 7n }]);
});

test("the split is proportional to the pots and adds up to exactly what the swap delivered", () => {
  const pots = [100n, 100n, 200n, 200n, 200n, 100n];
  const parts = splitDelivered(176_541_459n, pots);
  // a ninth is 19,615,717.67 and two ninths are 39,231,435.33: rounded down they add up to 3 units less, which go to the first of the largest pots
  assert.deepEqual(parts, [19_615_717n, 19_615_717n, 39_231_438n, 39_231_435n, 39_231_435n, 19_615_717n]);
  assert.equal(sum(parts), 176_541_459n);
});

test("the split never creates or loses a unit, for awkward amounts too", () => {
  for (const delivered of [0n, 1n, 2n, 3n, 7n, 999n, 1_000_003n, 18_446_744_073_709_551_615n]) {
    for (const pots of [[1n], [1n, 1n], [1n, 2n, 3n], [333n, 333n, 334n], [10n ** 15n, 1n], [5n, 0n, 5n]]) {
      const parts = splitDelivered(delivered, pots);
      assert.equal(sum(parts), delivered, `${delivered} over ${pots}`);
      assert.ok(parts.every((p) => p >= 0n));
      pots.forEach((p, i) => { if (p === 0n) assert.equal(parts[i], 0n); });
    }
  }
  assert.deepEqual(splitDelivered(100n, [0n, 0n]), [0n, 0n]);   // no pots: nothing to hand out
});

test("splitting one swap between sinks gives each sink what its own swap of the same price would have given", () => {
  // price: 1,000 token units buy 1 unit of the asset, whatever the size
  const pots = [250_000n, 250_000n, 500_000n];
  const together = splitDelivered(1_000n, pots);
  assert.deepEqual(together, [250n, 250n, 500n]);
});

// ---- the conversion stage of an epoch, with a swap that is counted instead of sent ----
import { runConversions, NoRouteError, TooSmallError, type ConversionProgress, type ConversionState } from "../src/plan.js";

type St = { sinks: { done: boolean; pot: string; converted?: string; swapSig?: string; path?: string; via?: unknown; sigs: string[] }[]; conversions?: ConversionState[] };
const SEVEN: Sink[] = [
  { type: "creator", share: 0.1, wallet: W }, { type: "treasury", share: 0.1, wallet: W }, { type: "burn", share: 0.1 },
  refl(0.2, SOL), refl(0.2, SOL, { type: "time-weighted", intervalHours: 24, step: 0.1, cap: 3 }),
  refl(0.2, SOL, { type: "never-sold-bonus", bonusShare: 0.2 }), refl(0.1, SOL, { type: "lottery", winners: 5 }),
];
const fresh = (sinks: Sink[], available: bigint): St => ({ sinks: potsOf(sinks, available).map((p) => ({ done: false, pot: p.toString(), sigs: [] })) });
/** A stand-in for the engine's convert(): 1,000 token units buy 1 unit of any asset. Like the real one it records what arrived and
 *  answers from that record when asked again, so `swaps` counts only swaps that were really sent. */
function swapper(opts: { noRoute?: string[]; failOn?: string; tooSmall?: string[] } = {}) {
  const sent: { amount: bigint; outMint: string }[] = [];
  const convert = async (amount: bigint, outMint: string, p: ConversionProgress) => {
    if (p.converted) return BigInt(p.converted);
    if (opts.noRoute?.includes(outMint)) throw new NoRouteError("NO_ROUTES_FOUND");
    if (opts.tooSmall?.includes(outMint)) throw new TooSmallError(342_385n, 2_000_000n);
    if (opts.failOn === outMint) throw new Error("rpc timeout");
    sent.push({ amount, outMint });
    p.swapSig = `sig${sent.length}`; p.sigs.push(p.swapSig); p.converted = (amount / 1000n).toString();
    return amount / 1000n;
  };
  return { sent, convert };
}
const run = (tk: { mint: string; quoteMint: string; sinks: Sink[] }, state: St, s: ReturnType<typeof swapper>, skip = new Set<number>(), dryRun = false, lines: string[] = []) => {
  let saves = 0;
  return runConversions({ token: { ...tk, symbol: "T" }, state, skip, convert: s.convert, save: () => { saves++; }, log: (l) => { lines.push(l); }, dryRun }).then((parts) => ({ parts, saves }));
};

test("epoch: seven sinks, six of them paying in SOL, send ONE swap and share what it delivered to the unit", async () => {
  const state = fresh(SEVEN, 1_000_000_000_000n), s = swapper();
  const { parts } = await run(token(SEVEN), state, s);
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0], { amount: 900_000_000_000n, outMint: SOL });
  assert.deepEqual([...parts.keys()], [0, 1, 3, 4, 5, 6]);           // the burn (sink 2) burns the token itself: no swap, no part
  assert.equal(sum([...parts.values()].map((v) => v!)), 900_000_000n);
  assert.deepEqual([...parts.values()], [100_000_000n, 100_000_000n, 200_000_000n, 200_000_000n, 200_000_000n, 100_000_000n]);
  assert.deepEqual(state.sinks.map((x) => x.converted), ["100000000", "100000000", undefined, "200000000", "200000000", "200000000", "100000000"]);
  assert.deepEqual(state.conversions!.map((c) => [c.mint, c.sinks, c.amount, c.converted, c.sigs]), [[SOL, [0, 1, 3, 4, 5, 6], "900000000000", "900000000", ["sig1"]]]);
});

test("epoch: a run that crashed after the swap resumes without swapping again and hands out the same parts", async () => {
  const state = fresh(SEVEN, 1_000_000_000_000n), s = swapper();
  const first = await run(token(SEVEN), state, s);
  // the crash: the swap is recorded, two sinks were paid, the parts of the others were never written
  const resumed: St = JSON.parse(JSON.stringify(state));
  resumed.sinks.forEach((x, i) => { if (i === 0 || i === 1) x.done = true; else delete x.converted; });
  const second = await run(token(SEVEN), resumed, s);
  assert.equal(s.sent.length, 1);
  assert.deepEqual([...second.parts.entries()], [...first.parts.entries()]);
  assert.deepEqual(resumed.sinks.map((x) => x.converted), state.sinks.map((x) => x.converted));
});

test("epoch: a run that crashed before the swap was confirmed keeps the plan it saved", async () => {
  const state = fresh(SEVEN, 1_000_000_000_000n);
  await assert.rejects(run(token(SEVEN), state, swapper({ failOn: SOL })), /rpc timeout/);
  assert.deepEqual(state.conversions!.map((c) => [c.sinks, c.amount, c.converted]), [[[0, 1, 3, 4, 5, 6], "900000000000", undefined]]);
  const s = swapper();
  const { parts } = await run(token(SEVEN), JSON.parse(JSON.stringify(state)), s, new Set([3, 4, 5, 6])); // a different skip set must not change a saved plan
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].amount, 900_000_000_000n);
  assert.equal(parts.size, 6);
});

test("epoch: every asset gets its own swap, and a holder sink with nobody to pay stays out of it", async () => {
  const sinks: Sink[] = [{ type: "creator", share: 0.25, wallet: W }, { type: "treasury", share: 0.25, wallet: W, asset: COOP }, refl(0.25, COOP), refl(0.25, NVDAX)];
  const state = fresh(sinks, 4_000_000n), s = swapper();
  const { parts } = await run(token(sinks, NVDAX), state, s, new Set([2]));   // sink 2: no eligible holder
  assert.deepEqual(s.sent, [{ amount: 2_000_000n, outMint: NVDAX }, { amount: 1_000_000n, outMint: COOP }]);
  assert.deepEqual([...parts.entries()], [[0, 1_000n], [3, 1_000n], [1, 1_000n]]);
  assert.equal(parts.has(2), false);
  assert.equal(state.sinks[2].converted, undefined);
});

test("epoch: no route keeps the pots of every sink in that asset, pays the others, and is not asked again on resume", async () => {
  const sinks: Sink[] = [{ type: "creator", share: 0.5, wallet: W }, { type: "treasury", share: 0.3, wallet: W, asset: COOP }, { type: "burn", share: 0.2, asset: COOP }];
  const state = fresh(sinks, 1_000_000n), s = swapper({ noRoute: [COOP] });
  const { parts } = await run(token(sinks), state, s);
  assert.deepEqual([...parts.entries()], [[0, 500n], [1, null], [2, null]]);
  assert.equal(state.conversions![1].noRoute, true);
  const again = await run(token(sinks), JSON.parse(JSON.stringify(state)), swapper());   // a route exists now, but this epoch already decided
  assert.deepEqual([...again.parts.entries()], [[0, 500n], [1, null], [2, null]]);
});

test("epoch: a pot too small to swap keeps the pots of every sink in that asset, records its worth, and is not worded as a missing route", async () => {
  const sinks: Sink[] = [{ type: "creator", share: 0.5, wallet: W }, { type: "treasury", share: 0.3, wallet: W, asset: COOP }, { type: "burn", share: 0.2, asset: COOP }];
  const state = fresh(sinks, 1_000_000n), s = swapper({ tooSmall: [COOP] }), lines: string[] = [];
  const { parts } = await run(token(sinks), state, s, new Set(), false, lines);
  assert.deepEqual([...parts.entries()], [[0, 500n], [1, null], [2, null]]);   // the SOL swap goes ahead, the COOP pots wait
  assert.equal(s.sent.length, 1);
  assert.equal(state.conversions![1].noRoute, true);
  assert.equal(state.conversions![1].tooSmall, "342385");
  assert.equal(state.conversions![0].tooSmall, undefined);
  // scripts/run-epochs.sh alerts on "has no route for <amount>": dust must never match it
  assert.equal(lines.some((l) => /has no route for [0-9]+ /.test(l)), false);
  assert.ok(lines.some((l) => /500000 T → DSZSng… is too small to swap \(worth 342385 lamports, under the 2000000 a swap needs\); kept for the next epoch/.test(l)));
  const again = await run(token(sinks), JSON.parse(JSON.stringify(state)), swapper());   // worth a swap now, but this epoch already decided
  assert.deepEqual([...again.parts.entries()], [[0, 500n], [1, null], [2, null]]);
});

test("pots: what was too small to swap stays with its sink and is swapped once the pots have added up", async () => {
  const sinks: Sink[] = [{ type: "creator", share: 0.5, wallet: W, asset: COOP }, refl(0.5, SOL)];
  const first = fresh(sinks, 1_000_000n);
  await run(token(sinks), first, swapper({ tooSmall: [COOP] }));
  // the epoch's record keeps the creator's pot (src/epoch.ts writes kept: pot); the next epoch brings it along on top of its share
  const kept = keptBySink({ sinks: [{ kept: first.sinks[0].pot }, {}] }, 2);
  const pots = formPots(1_000_000n + kept[0], [0.5, 0.5], kept);
  assert.deepEqual(pots.map((p) => p.pot), [1_000_000n, 500_000n]);
  assert.deepEqual(pots.map((p) => p.keptIn), [500_000n, 0n]);
});

test("epoch: an epoch the older engine began, with swap progress on its sinks, gets no plan and no shared swap", async () => {
  const sinks: Sink[] = [{ type: "creator", share: 0.5, wallet: W }, { type: "treasury", share: 0.5, wallet: W }];
  const state: St = { sinks: [{ done: true, pot: "500", converted: "7", swapSig: "old1", sigs: ["old1", "pay1"] }, { done: false, pot: "500", swapSig: "old2", sigs: ["old2"] }] };
  const s = swapper();
  const { parts, saves } = await run(token(sinks), state, s);
  assert.equal(parts.size, 0);
  assert.equal(s.sent.length, 0);
  assert.equal(state.conversions, undefined);
  assert.equal(saves, 0);
});

test("epoch: a token that converts nothing (burn only) plans no swap", async () => {
  const sinks: Sink[] = [{ type: "burn", share: 1 }];
  const state = fresh(sinks, 1_000n), s = swapper();
  const { parts } = await run(token(sinks), state, s);
  assert.equal(parts.size, 0);
  assert.deepEqual(state.conversions, []);
  assert.equal(s.sent.length, 0);
});

test("epoch: a dry run records what was quoted, sink by sink", async () => {
  const state = fresh(SEVEN, 1_000_000_000_000n);
  const quoted = async (amount: bigint) => amount / 1000n;    // a dry run's convert returns the quote and records nothing
  const parts = await runConversions({ token: { ...token(SEVEN), symbol: "T" }, state, skip: new Set(), convert: quoted, save: () => {}, log: () => {}, dryRun: true });
  assert.equal(state.conversions![0].converted, "900000000");
  assert.equal(sum([...parts.values()].map((v) => v!)), 900_000_000n);
});

// ---- a kept pot stays with its own sink (design rule since 2026-09-29) ----
import { formPots, keptBySink, shareOf } from "../src/plan.js";
import { Ledger as L2 } from "../src/ledger.js";
import fs2 from "node:fs";
import os2 from "node:os";
import path2 from "node:path";

test("pots: with nothing kept, every sink gets its share of what is available, as before", () => {
  const shares = [0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 0.1];
  const pots = formPots(1_000_000_000_000n, shares, shares.map(() => 0n));
  assert.deepEqual(pots.map((p) => p.pot), shares.map((s) => shareOf(1_000_000_000_000n, s)));
  assert.ok(pots.every((p) => p.keptIn === 0n));
  assert.deepEqual(formPots(15_308_431_349_200n, [1], []).map((p) => p.pot), [15_308_431_349_200n]);   // one sink, no record yet
});

test("pots: creator 50 / holders 50, nobody eligible in the first epoch: the holders' kept half stays the holders'", () => {
  // epoch 1: 1,000 swept, the creator is paid 500, the holders' 500 are kept. Epoch 2: 600 swept, so the operator holds 1,100.
  const pots = formPots(1_100n, [0.5, 0.5], [0n, 500n]);
  assert.deepEqual(pots, [{ pot: 300n, keptIn: 0n }, { pot: 800n, keptIn: 500n }]);
  // before the change both sinks got 550: the creator took 250 of what the holders had been owed
  assert.deepEqual([shareOf(1_100n, 0.5), shareOf(1_100n, 0.5)], [550n, 550n]);
});

test("pots: what is kept epoch after epoch keeps adding up for the same sink, and nothing is created or lost", () => {
  let kept = [0n, 0n, 0n];
  const shares = [0.5, 0.3, 0.2];
  let held = 0n, paidTo0 = 0n;
  for (const swept of [1_000n, 600n, 40n, 9_999n]) {
    held += swept;
    const pots = formPots(held, shares, kept);
    assert.ok(pots.reduce((a, p) => a + p.pot, 0n) <= held);
    assert.ok(held - pots.reduce((a, p) => a + p.pot, 0n) < 3n);      // only rounding units stay unassigned
    assert.deepEqual(pots.map((p) => p.keptIn), kept);
    paidTo0 += pots[0].pot; held -= pots[0].pot;                        // sink 0 pays every epoch, sinks 1 and 2 keep theirs
    kept = [0n, pots[1].pot, pots[2].pot];
  }
  assert.equal(paidTo0, shareOf(1_000n, 0.5) + shareOf(600n, 0.5) + shareOf(40n, 0.5) + shareOf(9_999n, 0.5));   // exactly half of what was swept, never more
});

test("pots: kept amounts larger than what the operator holds are scaled down to fit", () => {
  const pots = formPots(100n, [0.5, 0.5], [0n, 400n]);
  assert.deepEqual(pots, [{ pot: 0n, keptIn: 0n }, { pot: 100n, keptIn: 100n }]);
  const two = formPots(90n, [0.2, 0.4, 0.4], [0n, 100n, 200n]);
  assert.deepEqual(two.map((p) => p.keptIn), [0n, 30n, 60n]);
  assert.equal(two.reduce((a, p) => a + p.pot, 0n), 90n);
});

test("pots: what a sink kept is read from the last epoch's published record", () => {
  const rec = { sinks: [{ type: "creator", pot: "500", converted: "7" }, { type: "reflections", pot: "0", kept: "500" }, { type: "burn", pot: "0", kept: 12n }, { type: "treasury", pot: "0", kept: "not a number" }] };
  assert.deepEqual(keptBySink(rec, 4), [0n, 500n, 12n, 0n]);
  assert.deepEqual(keptBySink(undefined, 2), [0n, 0n]);
  assert.deepEqual(keptBySink({ sinks: [] }, 3), [0n, 0n, 0n]);
  // through the ledger itself: the record of the last finished epoch, dry runs ignored
  const l = new L2(fs2.mkdtempSync(path2.join(os2.tmpdir(), "coop-kept-")), "TESTMINT");
  assert.equal(l.lastRecord(), undefined);
  l.writeEpoch({ epoch: 1, ranAt: "2026-09-29T15:05:00.000Z", dryRun: false, mint: "TESTMINT", tax: { withheldBefore: "1000", harvested: 0, withdrawn: "1000" }, sinks: [{ type: "creator", pot: 500n }, { type: "reflections", pot: "0", kept: 500n }], signatures: [] });
  l.writeEpoch({ epoch: 2, ranAt: "2026-09-29T16:05:00.000Z", dryRun: true, mint: "TESTMINT", tax: { withheldBefore: "600", harvested: 0, withdrawn: "0" }, sinks: [{ type: "creator", pot: 1n }, { type: "reflections", pot: "0", kept: 1n }], signatures: [] });
  assert.deepEqual(keptBySink(l.lastRecord(), 2), [0n, 500n]);
});

test("pots and swaps together: a sink's kept tokens are sold with its share, in the one swap of its asset", async () => {
  const sinks: Sink[] = [{ type: "creator", share: 0.5, wallet: W }, refl(0.5, SOL)];
  const pots = formPots(1_100_000n, sinks.map((x) => x.share), [0n, 500_000n]);
  const state: St = { sinks: pots.map((p) => ({ done: false, pot: p.pot.toString(), sigs: [] })) };
  const s = swapper();
  const { parts } = await run(token(sinks), state, s);
  assert.deepEqual(s.sent, [{ amount: 1_100_000n, outMint: SOL }]);
  assert.deepEqual([...parts.entries()], [[0, 300n], [1, 800n]]);
});
