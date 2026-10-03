import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, type Holder } from "../src/rules.js";

const H = (owner: string, amount: bigint, epochsHeld = 0, everSold = false): Holder => ({ owner, amount, epochsHeld, everSold });
const sum = (m: Map<string, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n);

test("pro-rata pays by balance and never exceeds the pot", () => {
  const r = allocate({ type: "pro-rata" }, [H("a", 300n), H("b", 100n), H("c", 0n)], 1_000_000n);
  assert.equal(r.allocations.get("a"), 750_000n);
  assert.equal(r.allocations.get("b"), 250_000n);
  assert.equal(r.allocations.has("c"), false);
  assert.equal(sum(r.allocations) + r.remainder, 1_000_000n);
});

test("threshold and exclusions drop wallets", () => {
  const r = allocate({ type: "pro-rata" }, [H("a", 300n), H("b", 5n), H("pool", 10_000n)], 1000n, { minAmount: 10n, exclude: new Set(["pool"]) });
  assert.deepEqual([...r.allocations.keys()], ["a"]);
  assert.equal(r.eligible, 1);
});

test("splitting a wallet never increases its total payout under pro-rata or time-weighted", () => {
  for (const rule of [{ type: "pro-rata" } as const, { type: "time-weighted", maxEpochs: 4 } as const]) {
    const whole = allocate(rule, [H("w", 1000n, 2), H("x", 1000n, 2)], 1_000_000n).allocations.get("w")!;
    const split = allocate(rule, [H("w1", 500n, 2), H("w2", 500n, 2), H("x", 1000n, 2)], 1_000_000n);
    assert.ok(split.allocations.get("w1")! + split.allocations.get("w2")! <= whole);
  }
});

test("time-weighted favours longer holders and caps at maxEpochs", () => {
  const r = allocate({ type: "time-weighted", maxEpochs: 3 }, [H("new", 100n, 0), H("old", 100n, 2), H("older", 100n, 9)], 600n);
  // weights 1 : 3 : 3 (cap 3) of 600 → 85 / 257 / 257
  assert.equal(r.allocations.get("new"), 85n);
  assert.equal(r.allocations.get("old"), 257n);
  assert.equal(r.allocations.get("older"), 257n);
});

test("never-sold bonus goes only to loyal wallets", () => {
  const r = allocate({ type: "never-sold-bonus", bonusShare: 0.5 }, [H("loyal", 100n, 1, false), H("seller", 100n, 1, true)], 1000n);
  assert.equal(r.allocations.get("loyal"), 750n);
  assert.equal(r.allocations.get("seller"), 250n);
});

test("lottery is deterministic for a seed and pays equal prizes, more than one to the same wallet when it is drawn again", () => {
  const hs = [H("a", 100n), H("b", 900n), H("c", 50n)];
  const r1 = allocate({ type: "lottery", winners: 2 }, hs, 1000n, { seed: "blockhash-1" });
  const r2 = allocate({ type: "lottery", winners: 2 }, hs, 1000n, { seed: "blockhash-1" });
  assert.deepEqual([...r1.allocations.entries()], [...r2.allocations.entries()]);
  assert.equal(sum(r1.allocations), 1000n);
  for (const v of r1.allocations.values()) assert.equal(v % 500n, 0n);
  // one eligible wallet wins every prize: the whole pot
  assert.equal(allocate({ type: "lottery", winners: 5 }, [H("solo", 10n)], 1000n, { seed: "s" }).allocations.get("solo"), 1000n);
});

test("splitting a wallet does not raise its expected lottery winnings (2026-10-03: before, half the supply won ~20% as one wallet, ~45% as five)", () => {
  const others = Array.from({ length: 20 }, (_, i) => H(`o${i}`, 25n));
  const share = (whale: Holder[]) => {
    let won = 0n;
    for (let s = 0; s < 4000; s++) {
      const a = allocate({ type: "lottery", winners: 5 }, [...whale, ...others], 1_000_000n, { seed: `seed-${s}` }).allocations;
      for (const h of whale) won += a.get(h.owner) ?? 0n;
    }
    return Number(won) / 4000 / 1_000_000;
  };
  const one = share([H("w", 500n)]), five = share(Array.from({ length: 5 }, (_, i) => H(`w${i}`, 100n)));
  assert.ok(Math.abs(one - 0.5) < 0.03 && Math.abs(five - 0.5) < 0.03, `one wallet ${one}, five wallets ${five}: both should be ~0.5`);
});
