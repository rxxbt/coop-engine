/**
 * Payout rules. Pure functions over a holder snapshot: no chain access, no side effects,
 * so every epoch's allocation can be recomputed and audited from the published snapshot.
 *
 * Design principle (see project sheet): per-token payout must never RISE as wallets get
 * smaller (Sybil-splittable). Every rule here is size-neutral or rewards time/cost.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import type { Rule } from "./config.js";

/** Tokens a wallet has held since `since` (the time of the snapshot that first saw them) without the wallet's balance ever dropping. */
export type Lot = { amount: bigint; since: number };
export type Holder = {
  owner: string;
  amount: bigint;        // token balance at snapshot (base units)
  epochsHeld: number;    // consecutive epochs the wallet has been in the snapshot (0 = first time); used by the legacy time-weighted rule
  everSold: boolean;     // balance ever decreased between two snapshots
  lots?: Lot[];          // the balance split by age, oldest first; absent on snapshots published before 2026-09-29
};

export type Allocation = { allocations: Map<string, bigint>; remainder: bigint; eligible: number };

/** `at` = the snapshot's time in ms: holding time is measured up to it. */
export type AllocateOptions = { minAmount?: bigint; exclude?: Set<string>; seed?: string; at?: number };

export type AgedRule = Extract<Rule, { type: "time-weighted"; intervalHours: number }>;
export const isAged = (r: Rule): r is AgedRule => r.type === "time-weighted" && "intervalHours" in r;

/** The multiplier, in hundredths, of tokens first seen at `since`: 1× plus one step per FULL holding interval, up to the cap.
 *  A lot seen for the first time in this snapshot has held for zero intervals, so there is no free first step. */
export function lotMultiplier(rule: AgedRule, since: number, at: number): bigint {
  const n = BigInt(Math.max(0, Math.floor((at - since) / (rule.intervalHours * 3_600_000))));
  const m = 100n + BigInt(Math.round(rule.step * 100)) * n, cap = BigInt(Math.round(rule.cap * 100));
  return m > cap ? cap : m;
}
/** A holder's weight in hundredths of a token: every lot times its own multiplier. Tokens age, wallets do not, so buying into an old
 *  wallet earns nothing extra on the new tokens. Anything the lots do not account for counts at 1×. */
export function agedWeight(rule: AgedRule, h: Holder, at: number): bigint {
  let w = 0n, seen = 0n;
  for (const l of h.lots ?? []) {
    const part = seen + l.amount > h.amount ? h.amount - seen : l.amount; // never weigh more than the balance
    if (part <= 0n) break;
    w += part * lotMultiplier(rule, l.since, at); seen += part;
  }
  if (h.amount > seen) w += (h.amount - seen) * 100n;
  return w;
}

function proRataSplit(pot: bigint, weights: Map<string, bigint>): Map<string, bigint> {
  const out = new Map<string, bigint>();
  let sum = 0n;
  for (const w of weights.values()) sum += w;
  if (sum === 0n) return out;
  for (const [owner, w] of weights) {
    const a = (pot * w) / sum;
    if (a > 0n) out.set(owner, a);
  }
  return out;
}

function merge(into: Map<string, bigint>, from: Map<string, bigint>) {
  for (const [k, v] of from) into.set(k, (into.get(k) ?? 0n) + v);
}

export function allocate(rule: Rule, holders: Holder[], pot: bigint, opts: AllocateOptions = {}): Allocation {
  const min = opts.minAmount ?? 0n;
  const ex = opts.exclude ?? new Set<string>();
  const eligible = holders.filter((h) => h.amount >= min && h.amount > 0n && !ex.has(h.owner));
  const allocations = new Map<string, bigint>();

  if (eligible.length === 0 || pot <= 0n) return { allocations, remainder: pot, eligible: 0 };

  switch (rule.type) {
    case "pro-rata": {
      merge(allocations, proRataSplit(pot, new Map(eligible.map((h) => [h.owner, h.amount]))));
      break;
    }
    case "time-weighted": {
      if (isAged(rule)) {
        // since 2026-09-29: the dev sets the holding interval, the step per interval and the cap; selling anything resets the wallet (ledger.ts)
        const at = opts.at ?? Date.now();
        merge(allocations, proRataSplit(pot, new Map(eligible.map((h) => [h.owner, agedWeight(rule, h, at)] as [string, bigint]))));
        break;
      }
      // legacy (tokens registered before 2026-09-29): weight = balance × epochs held in a row, per wallet, capped
      const cap = BigInt(Math.max(1, rule.maxEpochs));
      const weights = new Map(eligible.map((h) => {
        const mult = BigInt(h.epochsHeld + 1) < cap ? BigInt(h.epochsHeld + 1) : cap;
        return [h.owner, h.amount * mult] as [string, bigint];
      }));
      merge(allocations, proRataSplit(pot, weights));
      break;
    }
    case "never-sold-bonus": {
      const bonusPot = BigInt(Math.floor(rule.bonusShare * 1e6)) * pot / 1_000_000n;
      const basePot = pot - bonusPot;
      merge(allocations, proRataSplit(basePot, new Map(eligible.map((h) => [h.owner, h.amount]))));
      const loyal = eligible.filter((h) => !h.everSold);
      if (loyal.length > 0) merge(allocations, proRataSplit(bonusPot, new Map(loyal.map((h) => [h.owner, h.amount]))));
      else merge(allocations, proRataSplit(bonusPot, new Map(eligible.map((h) => [h.owner, h.amount])))); // nobody loyal: fall back to pro-rata
      break;
    }
    case "lottery": {
      // `winners` equal prizes, each drawn on its own by balance weight from every eligible holder, so one wallet can win more than one:
      // every wallet's expected share is its share of the balance, however it is split. (Until 2026-10-03 a wallet could win at most once,
      // and with 5 prizes a holder of half the supply got about 20% of the pot as one wallet and about 45% split into five.)
      // Deterministic: prize i is drawn with sha256(`${seed}:${i}`), the seed being a blockhash published with the result.
      const seed = opts.seed ?? "";
      const total = eligible.reduce((a, h) => a + h.amount, 0n);
      const each = pot / BigInt(rule.winners);
      for (let i = 0; i < rule.winners && each > 0n; i++) {
        const digest = sha256(new TextEncoder().encode(`${seed}:${i}`));
        let r = 0n;
        for (const b of digest.subarray(0, 16)) r = (r << 8n) | BigInt(b);
        let pick = r % total, idx = 0;
        while (pick >= eligible[idx].amount) { pick -= eligible[idx].amount; idx++; }
        allocations.set(eligible[idx].owner, (allocations.get(eligible[idx].owner) ?? 0n) + each);
      }
      break;
    }
  }

  let paid = 0n;
  for (const v of allocations.values()) paid += v;
  return { allocations, remainder: pot - paid, eligible: eligible.length };
}
