// Buy-tax refunds: buys are read from a transaction's own balance changes, the tax is grossed up so the buyer nets it, holders mode pays
// only buyers who kept everything they bought, and the total never exceeds what was swept.
import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { buysInTx, feeOn, grossUp, isVestingClaim, planRefunds, totalsByBuyer, type Buy } from "../src/refunds.js";
import { validateToken, type TokenConfig } from "../src/config.js";

const MINT = "DATdVDpE3SzhJWyPSGpUYoCeN6qReTfBMURFJTUMLDQo", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const VAULT = "2BX1czozHk9DM6jzFpKEVriKEqwjqfL4s98KPLVTdfFr", ALICE = "9dZcuWdTRjStMFNpQGDsSUZvTBkhrGZXxFvNMkjbpYKv", BOB = "DjKWgaz5peaDPSdKBEFfQfbsMPgEQmCmCmRiHXrGcZ3c";
const A_ATA = "3zjCXKKCzoKnJJLGQuw1mQMkXKQ32gVjna5fQkm8Tp2p", B_ATA = "HgdXUcPzqJ4w41WEDksUv1NCZRJbjtzynGUMTnrFzqbz";
const LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

/** A parsed transaction with token balances for `mint`: rows = [account, owner, pre, post]. */
function tx(rows: [string, string, bigint, bigint][], opts: { err?: boolean; data?: string; program?: string } = {}): ParsedTransactionWithMeta {
  const keys = rows.map(([account]) => account);
  const bal = (i: number, amount: bigint, owner: string) => ({ accountIndex: i, mint: MINT, owner, uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null, uiAmountString: "" } });
  return {
    slot: 100, blockTime: 1, transaction: { signatures: ["sig1"], message: { accountKeys: keys.map((k) => ({ pubkey: { toBase58: () => k } })), instructions: opts.data ? [{ programId: { toBase58: () => opts.program ?? LAUNCHLAB }, data: opts.data, accounts: [] }] : [] } },
    meta: { err: opts.err ? { x: 1 } : null, fee: 5000, preBalances: [], postBalances: [], innerInstructions: [], preTokenBalances: rows.map(([, o, pre], i) => bal(i, pre, o)), postTokenBalances: rows.map(([, o, , post], i) => bal(i, post, o)) },
  } as unknown as ParsedTransactionWithMeta;
}

test("the tax Token-2022 withholds, and the refund that nets it after its own tax", () => {
  assert.equal(feeOn(1_000_000n, 300), 30_000n);
  assert.equal(feeOn(1n, 300), 1n);              // rounded up, as the program does
  assert.equal(grossUp(30_000n, 300), 30_928n);  // 30,928 − 3% = 30,000.16 → the buyer nets at least the tax paid
  assert.equal(grossUp(0n, 300), 0n);
  assert.equal(grossUp(100n, 0), 100n);
});

test("a buy: tokens leave the vault, the buyer receives them net of the tax, and the tax is attributed to the buyer", () => {
  const buys = buysInTx(tx([[VAULT, "poolAuthority", 1_000_000n, 0n], [A_ATA, ALICE, 0n, 970_000n]]), MINT, new Set([VAULT]), new Set(), 300);
  assert.deepEqual(buys, [{ sig: "sig1", slot: 100, owner: ALICE, bought: 970_000n, fee: 30_000n }]);
});

test("two recipients share the tax by what they received; a failed transaction, a vesting claim and an ignored owner give no buy", () => {
  const rows: [string, string, bigint, bigint][] = [[VAULT, "poolAuthority", 2_000_000n, 0n], [A_ATA, ALICE, 0n, 970_000n], [B_ATA, BOB, 500n, 970_500n]];
  const two = buysInTx(tx(rows), MINT, new Set([VAULT]), new Set(), 300);
  assert.equal(two.length, 2);
  assert.equal(two[0].fee + two[1].fee, 60_000n);
  assert.deepEqual(buysInTx(tx(rows, { err: true }), MINT, new Set([VAULT]), new Set(), 300), []);
  const claim = bs58.encode(Uint8Array.from([49, 33, 104, 30, 189, 157, 79, 35, 0, 0]));
  assert.equal(isVestingClaim(tx(rows, { data: claim })), true);
  assert.deepEqual(buysInTx(tx(rows, { data: claim }), MINT, new Set([VAULT]), new Set(), 300), []);
  assert.equal(isVestingClaim(tx(rows, { data: claim, program: "11111111111111111111111111111111" })), false);
  assert.deepEqual(buysInTx(tx(rows), MINT, new Set([VAULT]), new Set([ALICE, BOB]), 300), []);
  // nothing left the vault (a sell): no buy
  assert.deepEqual(buysInTx(tx([[VAULT, "poolAuthority", 0n, 1_000_000n], [A_ATA, ALICE, 1_000_000n, 0n]]), MINT, new Set([VAULT]), new Set(), 300), []);
});

test("the tax attributed never exceeds what the rate implies, even when part of the outflow went somewhere the balances do not show", () => {
  const buys = buysInTx(tx([[VAULT, "poolAuthority", 5_000_000n, 0n], [A_ATA, ALICE, 0n, 970_000n]]), MINT, new Set([VAULT]), new Set(), 300);
  assert.equal(buys[0].fee, feeOn(grossUp(970_000n, 300), 300)); // 30,000, not 4,030,000
  assert.ok(buys[0].fee <= 30_001n && buys[0].fee >= 30_000n);
});

test("holders mode refunds only buyers still holding everything they bought; all mode refunds every buyer; totals add up", () => {
  const buys: Buy[] = [
    { sig: "a", slot: 1, owner: ALICE, bought: 970_000n, fee: 30_000n }, { sig: "b", slot: 2, owner: ALICE, bought: 970_000n, fee: 30_000n },
    { sig: "c", slot: 3, owner: BOB, bought: 1_940_000n, fee: 60_000n },
  ];
  assert.deepEqual([...totalsByBuyer(buys).entries()].map(([o, t]) => [o, t.bought, t.fee, t.buys]), [[ALICE, 1_940_000n, 60_000n, 2], [BOB, 1_940_000n, 60_000n, 1]]);
  // Alice kept everything, Bob sold a little
  const balances = new Map([[ALICE, 1_940_000n], [BOB, 1_939_999n]]);
  const h = planRefunds(buys, "holders", balances, 300, 10_000_000n);
  assert.deepEqual(h.entries.map((e) => [e.owner, e.fee, e.refund, e.buys]), [[ALICE, "60000", grossUp(60_000n, 300).toString(), 2]]);
  assert.equal(h.fees, 60_000n); assert.equal(h.forfeited, 60_000n); assert.equal(h.scaled, false);
  const a = planRefunds(buys, "all", balances, 300, 10_000_000n);
  assert.equal(a.entries.length, 2); assert.equal(a.forfeited, 0n); assert.equal(a.refunded, grossUp(60_000n, 300) * 2n);
  // a buyer absent from the snapshot (sold everything) is refunded in all mode only
  const gone = planRefunds(buys, "holders", new Map([[ALICE, 1_940_000n]]), 300, 10_000_000n);
  assert.equal(gone.entries.length, 1);
});

test("refunds never exceed what was swept: scaled down and flagged", () => {
  const buys: Buy[] = [{ sig: "a", slot: 1, owner: ALICE, bought: 970_000n, fee: 30_000n }, { sig: "c", slot: 3, owner: BOB, bought: 970_000n, fee: 30_000n }];
  const r = planRefunds(buys, "all", new Map(), 300, 40_000n);
  assert.equal(r.scaled, true);
  assert.ok(r.refunded <= 40_000n && r.refunded >= 39_998n);
  assert.deepEqual(planRefunds([], "all", new Map(), 300, 0n), { entries: [], fees: 0n, refunded: 0n, forfeited: 0n, scaled: false });
});

test("validation: refund mode is holders or all", () => {
  const base: TokenConfig = { mint: MINT, symbol: "T", quoteMint: USDC, decimals: 6, exclusions: [], epochHours: 1, sinks: [{ type: "burn", share: 1 }] };
  validateToken({ ...base, refund: { mode: "holders" } }); validateToken({ ...base, refund: { mode: "all" } });
  assert.throws(() => validateToken({ ...base, refund: { mode: "some" } as any }), /refund mode/);
});
