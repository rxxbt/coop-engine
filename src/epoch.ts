/**
 * One epoch for one token, resumable.
 *   sweep withheld tax → withdraw to operator → split the operator's token balance across sinks →
 *   convert via Jupiter where needed → snapshot → rule → pay (push) or publish a root (claim) → ledger.
 * Execute mode persists data/<mint>/epoch-N.state.json after every step, so a crashed run resumes
 * at the step it died on and never pays a recipient twice. Dry run computes everything and signs nothing.
 */
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, createBurnCheckedInstruction, unpackMint, unpackAccount,
} from "@solana/spl-token";
import { sinkPayoutMint, type EngineConfig, type TokenConfig, type Sink } from "./config.js";
import { tokenAccounts, aggregateByOwner } from "./snapshot.js";
import { withheldOf, harvestInstructions, mintWithheld, withdrawFromMintInstruction } from "./sweep.js";
import { allocate, type Holder } from "./rules.js";
import { NoRouteError, TooSmallError, formPots, keptBySink, runConversions, shareOf, type ConversionProgress, type ConversionState } from "./plan.js";
import { balanceTree, toHex } from "./merkle.js";
import { quote, swapTransaction } from "./jupiter.js";
import { LAUNCHPAD_PROGRAM, LaunchpadPool, getPdaLaunchpadPoolId } from "@raydium-io/raydium-sdk-v2";
import { Ledger, type SnapshotRow } from "./ledger.js";

const LAUNCHLAB = new PublicKey("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");
const CPMM_AUTH = "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const ATA_RENT = 2_039_280n;
const RENT_MIN = 890_880n; // lamports a system account must hold; a transfer that leaves less is rejected
/** A pot worth less than this is not swapped: it stays with its sinks and joins the next epoch's pot until it is worth a swap (since
 *  2026-10-02). Every swap costs the operator a network fee and a priority fee, and a route through a token the operator has no account
 *  for opens one (0.0015 SOL, refundable), which a dust pot cannot cover: on 2026-10-01 a pot worth 0.00034 SOL delivered nothing. */
const MIN_SWAP_LAMPORTS = BigInt(process.env.MIN_SWAP_LAMPORTS ?? "2000000"); // 0.002 SOL
/** Why a sink's pot was kept for the next epoch instead of paid; published with the sink's record. */
type KeptWhy = "no route" | "too small" | "no eligible holder";

type Carry = Record<string, string>; // owner → lamports owed but too small to deliver yet
function loadCarry(dir: string): Carry { try { return JSON.parse(fs.readFileSync(path.join(dir, "carry.json"), "utf8")); } catch { return {}; } }
function saveCarry(dir: string, c: Carry) { writeAtomic(path.join(dir, "carry.json"), JSON.stringify(c, null, 1)); }
/** Write through a temporary file and a rename, so a run that dies mid-write leaves the old file whole, never half of the new one. */
function writeAtomic(file: string, data: string) { fs.writeFileSync(`${file}.tmp`, data); fs.renameSync(`${file}.tmp`, file); }
/** Split native-SOL payouts into deliverable now vs deferred (recipient would end below the rent minimum). */
const PRICE_API = process.env.JUP_PRICE_API || "https://lite-api.jup.ag/price/v3";
/** A first payout to a wallet with no token account must be worth at least this much (and twice the account's rent) before the operator funds the account. */
const MIN_FIRST_PAYOUT_USD = 1;
export async function jupPrices(ids: string[]): Promise<Record<string, number>> {
  const r = await fetch(`${PRICE_API}?ids=${ids.join(",")}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`price ${r.status}`);
  const j: any = await r.json(); const out: Record<string, number> = {};
  for (const id of ids) { const row = j?.[id] ?? j?.data?.[id]; const p = Number(row?.usdPrice ?? row?.price); if (p > 0) out[id] = p; }
  return out;
}
/** Lamports per base unit of the payout mint plus SOL's dollar price, from Jupiter's price feed (null if it cannot be priced right now). */
async function payoutValueInLamports(mint: string, decimals: number, log: (s: string) => void): Promise<{ lamportsPerUnit: number; solUsd: number } | null> {
  const SOL = "So11111111111111111111111111111111111111112";
  try {
    const p = await jupPrices([mint, SOL]);
    if (!p[mint] || !p[SOL]) return null;
    return { lamportsPerUnit: (p[mint] / 10 ** decimals) / (p[SOL] / 1e9), solUsd: p[SOL] };
  } catch (e) { log(`  payout price unavailable: ${String((e as any)?.message ?? e).slice(0, 80)}`); return null; }
}
/** What `amount` base units of `mint` are worth in lamports at Jupiter's price; null when the feed has no price for it right now. */
async function lamportsOf(conn: Connection, mint: string, amount: bigint, log: (s: string) => void): Promise<bigint | null> {
  const { decimals } = await mintProgramAndDecimals(conn, new PublicKey(mint));
  const v = await payoutValueInLamports(mint, decimals, log);
  return v ? BigInt(Math.floor(Number(amount) * v.lamportsPerUnit)) : null;
}
/** The token's dollar price at epoch time: Jupiter's feed, else the curve's own state (virtual + real reserves) times the quote's dollar price. */
async function tokenPriceUsd(conn: Connection, token: TokenConfig, log: (s: string) => void): Promise<number | null> {
  try {
    const p = await jupPrices([token.mint, token.quoteMint]).catch(() => ({} as Record<string, number>));
    if (p[token.mint]) return p[token.mint];
    if (!p[token.quoteMint]) return null;
    const info = await conn.getAccountInfo(getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, new PublicKey(token.mint), new PublicKey(token.quoteMint)).publicKey);
    if (!info) return null;
    const pool: any = LaunchpadPool.decode(info.data);
    const vA = Number(pool.virtualA.toString()) / 10 ** pool.mintDecimalsA, vB = Number(pool.virtualB.toString()) / 10 ** pool.mintDecimalsB;
    const rA = Number(pool.realA.toString()) / 10 ** pool.mintDecimalsA, rB = Number(pool.realB.toString()) / 10 ** pool.mintDecimalsB;
    const priceQuote = vA - rA > 0 ? (vB + rB) / (vA - rA) : 0;
    return priceQuote > 0 ? priceQuote * p[token.quoteMint] : null;
  } catch (e) { log(`  token price unavailable: ${String((e as any)?.message ?? e).slice(0, 80)}`); return null; }
}
/** What cannot be delivered this epoch goes pro-rata to the holders who are paid; if nobody can be paid it rolls into the next epoch's pot. Nothing is kept. */
function redistribute(now: [string, bigint][], defer: [string, bigint][]): { paid: [string, bigint][]; moved: bigint; rolled: bigint } {
  const total = defer.reduce((a, [, v]) => a + v, 0n);
  if (total === 0n) return { paid: now, moved: 0n, rolled: 0n };
  if (!now.length) return { paid: [], moved: 0n, rolled: total };
  const base = now.reduce((a, [, v]) => a + v, 0n);
  let given = 0n;
  const paid: [string, bigint][] = now.map(([o, v]) => { const add = base > 0n ? (total * v) / base : total / BigInt(now.length); given += add; return [o, v + add]; });
  paid[0] = [paid[0][0], paid[0][1] + (total - given)];
  return { paid, moved: total, rolled: 0n };
}
async function deliverable(conn: Connection, items: [string, bigint][]): Promise<{ now: [string, bigint][]; defer: [string, bigint][] }> {
  const now: [string, bigint][] = [], defer: [string, bigint][] = [];
  for (let i = 0; i < items.length; i += 100) {
    const batch = items.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(batch.map(([o]) => new PublicKey(o)));
    batch.forEach(([o, a], k) => { const bal = BigInt(infos[k]?.lamports ?? 0); (bal + a >= RENT_MIN ? now : defer).push([o, a]); });
  }
  return { now, defer };
}

export type RunOptions = { dryRun: boolean; operator?: Keypair; operatorPubkey?: PublicKey; seed?: string; log?: (s: string) => void };

/** One Jupiter swap's persisted progress: the signature and its expiry are written before sending, the delivered amount after confirmation. */
type LegState = { swapSig?: string; lastValidBlockHeight?: number; converted?: string };
/** A conversion's persisted progress, and one swap per payout asset per epoch (since 2026-09-29): see src/plan.ts. */
type ConvProgress = ConversionProgress;
type ConvState = ConversionState;
type SinkState = { done: boolean; pot: string; /** the part of `pot` this sink kept in the last epoch and brought along */ keptIn?: string; sigs: string[]; minAmount?: string; tokenPriceUsd?: number; swapSig?: string; quoteBefore?: string; converted?: string; noRoute?: boolean; keptWhy?: KeptWhy;
  /** Only in epochs the engine began before 2026-09-29, when every sink converted on its own: the sink's own conversion progress. */
  path?: "direct" | "via-sol"; via?: LegState & { mint: string }; allocations?: [string, string][]; paidBatches?: number; root?: string; note?: string; carriedIn?: string; remainder?: string; kept?: string; lottery?: { slot: number; blockhash: string };
  /** The sink's payment in flight (for a holder sink: batch number `paidBatches`), persisted before it is sent and cleared in the same save
   *  that records it as paid: a resumed run settles it before building anything (since 2026-10-03). */
  pending?: Sent;
  /** A holder sink's final pay list (after first-payout deferrals and their redistribution), frozen before the first batch is sent, with
   *  what it took from and gave back to the carry file; `carryDone` once the carry file has it. */
  payList?: [string, string][]; redistributed?: string; rolled?: string; consumed?: string[]; newAtas?: number; carryDone?: boolean };
export type { SnapshotRow } from "./ledger.js";
type EpochState = { epoch: number; mint: string; startedAt: string; sweep: { done: boolean; sigs: string[]; withheldBefore: string; available?: string; heldBefore?: string; swept?: string }; sinks: SinkState[]; conversions?: ConvState[]; finished?: boolean; snapshot?: { slot: number; at?: string; holders: SnapshotRow[] } };
/** A blockhash produced at least `minAhead` slots after the snapshot: unknown when the snapshot was taken, public afterwards, so a lottery seeded by it is unpredictable and verifiable. */
async function seedAfter(conn: Connection, snapshotSlot: number, minAhead = 10): Promise<{ slot: number; blockhash: string }> {
  for (;;) {
    const r = await conn.getLatestBlockhashAndContext("confirmed");
    if (r.context.slot >= snapshotSlot + minAhead) return { slot: r.context.slot, blockhash: r.value.blockhash };
    await new Promise((res) => setTimeout(res, 2000));
  }
}


async function mintProgramAndDecimals(conn: Connection, mint: PublicKey) {
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
  const program = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  return { program, decimals: unpackMint(mint, info, program).decimals };
}
async function tokenBalance(conn: Connection, ata: PublicKey, program: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(ata);
  if (!info) return 0n;
  return unpackAccount(ata, info, program).amount;
}
/** A transaction the engine signed: its signature and the block height its blockhash is valid to. Every payment's is persisted BEFORE it
 *  is sent (since 2026-10-03; until then only after it confirmed, so a run that died in between could have sent the same payment again on
 *  its next run: it never happened, every operator transaction since 2026-09-24 is in a record). */
export type Sent = { sig: string; lastValidBlockHeight: number };
/** Blocks past a blockhash's expiry before "not found" counts as "never landed": the node answering the status may lag the one that
 *  gave the block height. */
const EXPIRY_MARGIN = 30;
/** How long the engine waits on the chain: between two status polls, for one transaction at most, after a refused send. Tests shorten it. */
export const timing = { pollMs: 1500, waitMs: 120_000, staleMs: 2000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What became of a sent transaction: "landed"; "failed" (an on-chain error: it moved nothing); "expired" (its blockhash expired, past the
 *  margin, and the chain has no such transaction: it can never land); null while it is still neither after `waitMs`. An RPC error is
 *  thrown, never read as an answer. Needs an RPC that keeps transaction history (the engine's does: older statuses come back "finalized"). */
export async function fate(conn: Connection, s: Sent, waitMs = timing.waitMs): Promise<"landed" | "failed" | "expired" | null> {
  const status = async () => (await conn.getSignatureStatuses([s.sig], { searchTransactionHistory: true })).value[0];
  const t0 = Date.now();
  for (;;) {
    const st = await status();
    if (st?.err) return "failed";
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return "landed";
    if ((await conn.getBlockHeight("confirmed")) > s.lastValidBlockHeight + EXPIRY_MARGIN) {
      // past the margin: one more look at the status, and at the transaction itself, before calling it gone
      const again = await status();
      if (again?.err) return "failed";
      if (again?.confirmationStatus === "confirmed" || again?.confirmationStatus === "finalized") return "landed";
      if (again) return null; // only "processed": on a fork that may or may not confirm
      const tx = await conn.getTransaction(s.sig, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
      return tx ? (tx.meta?.err ? "failed" : "landed") : "expired";
    }
    if (Date.now() - t0 >= waitMs) return null;
    await sleep(timing.pollMs);
  }
}

/** A payment an earlier attempt or an earlier run sent: its signature if it landed (the payment is made, nothing is sent again); undefined
 *  when it can be forgotten (failed on-chain or expired without landing: nothing moved, build it afresh). Throws while it is neither: the
 *  next run settles it again. */
export async function landed(conn: Connection, s: Sent | undefined, log: (s: string) => void): Promise<string | undefined> {
  if (!s) return undefined;
  const f = await fate(conn, s);
  if (f === "landed") { log(`  resume: ${s.sig} landed earlier; not sent again`); return s.sig; }
  if (f === null) throw new Error(`transaction ${s.sig} is neither confirmed nor expired; the epoch resumes on the next run`);
  log(`  resume: ${s.sig.slice(0, 12)}… ${f === "failed" ? "failed on-chain (it moved nothing)" : "expired without landing"}; building it again`);
  return undefined;
}

/** Send `ixs` as ONE transaction, exactly once: sign it with a fresh blockhash, hand it to `keep` (which persists it) BEFORE sending, then
 *  send and wait by polling (HTTP only: web3.js's sendAndConfirmTransaction opens a websocket whose 429 escaped every try/catch until
 *  2026-10-01). Sent again only when the last attempt provably cannot land; any other outcome throws with the attempt still persisted, so
 *  the next run settles it with `landed` before building anything. */
export async function sendOnce(conn: Connection, ixs: TransactionInstruction[], signer: Keypair, keep: (s: Sent) => void, log: (s: string) => void): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: signer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    tx.sign(signer);
    const s: Sent = { sig: bs58.encode(tx.signature!), lastValidBlockHeight };
    keep(s);
    // no maxRetries: the RPC re-broadcasts until the transaction lands or its blockhash expires. Capped at 3 (2026-10-01 → 10-04), 9.1 of
    // every 100 transactions expired unsent and needed a second one (0.6 before), and three in a row failed an epoch on 2026-10-04.
    try { await conn.sendRawTransaction(tx.serialize()); }
    catch (e) {
      // the node that checked the transaction did not know its blockhash yet: it was refused before being sent, so sending again is safe
      if (isStaleBlockhash(e) && attempt < 3) { log(`  the RPC did not know the blockhash yet (nothing sent); sending again (attempt ${attempt + 1} of 3)`); await sleep(timing.staleMs); continue; }
      throw e;
    }
    if (await pollConfirm(conn, s.sig, lastValidBlockHeight, log)) return s.sig; // throws when it failed on-chain
    const f = await fate(conn, s);
    if (f === "landed") return s.sig;
    if (f === "failed") throw new Error(`transaction failed on-chain (tx ${s.sig})`);
    if (f === null) throw new Error(`transaction ${s.sig} not confirmed in time; the epoch resumes on the next run`);
    if (attempt >= 3) throw new Error(`transaction not landing after 3 attempts (last ${s.sig}); the epoch resumes on the next run`);
    log(`  ${s.sig.slice(0, 12)}… expired without inclusion; sending again (attempt ${attempt + 1} of 3)`);
  }
}

/** Send instructions in batches, each exactly once within this run (the sweep: withdrawing withheld tax twice moves nothing twice). */
export async function sendAll(conn: Connection, ixs: TransactionInstruction[], perTx: number, signer: Keypair, log: (s: string) => void): Promise<string[]> {
  const sigs: string[] = [];
  for (let i = 0; i < ixs.length; i += perTx) { const sig = await sendOnce(conn, ixs.slice(i, i + perTx), signer, () => {}, log); sigs.push(sig); log(`  sent ${sig}`); }
  return sigs;
}
// NoRouteError (src/plan.ts): Jupiter has no route (dust, or a payout mint with no market yet). Not a failure: the pot stays with the operator
// and rolls into the next epoch.
// Jupiter's two ways of saying "nothing to swap here": no route at all, and an amount too small to quote (a dust pot with no direct
// route whose SOL leg is worth 1 lamport: the second quote answers CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD).
// Both mean: keep the pot, try again next epoch.
/** "Blockhash not found" from a send's preflight: the RPC node that simulated the transaction was behind the one that gave the blockhash.
 *  The transaction was refused before it was sent (2026-10-02: one test token's epoch failed on it, the only time since 2026-09-25). */
export const isStaleBlockhash = (e: unknown) => /blockhash not found/i.test(String((e as any)?.message ?? e));
export const isNoRoute = (e: unknown) => /no routes? found|NO_ROUTES_FOUND|could not find any route|CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD|Cannot compute other amount threshold/i.test(String((e as any)?.message ?? e));
async function quoteOrNoRoute(...args: Parameters<typeof quote>) { try { return await quote(...args); } catch (e) { if (isNoRoute(e)) throw new NoRouteError(String((e as any)?.message ?? e)); throw e; } }

/** Poll for confirmation instead of waiting on a WebSocket subscription; false once the blockhash expired without inclusion (then a re-send cannot double-execute). */
export async function pollConfirm(conn: Connection, sig: string, lastValidBlockHeight: number | undefined, log: (s: string) => void): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timing.waitMs) {
    const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    if (st?.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(st.err)} (tx ${sig})`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return true;
    if (lastValidBlockHeight && (await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) { log(`  ${sig.slice(0, 12)}…: blockhash expired without inclusion`); return false; }
    await sleep(timing.pollMs);
  }
  return false;
}

/** What a confirmed swap delivered to the operator, read from the transaction itself: exact, net of the output asset's own transfer tax, and
 *  independent of anything else moving the operator's balances (other tokens' epochs run in the same hour). For SOL the network fee is added
 *  back, so the pot is not charged for it; a result of zero or less (rent for a route's intermediate account exceeded a dust pot) counts as 0.
 *  null = the transaction is confirmed but not readable yet. */
export async function swapDelivered(conn: Connection, sig: string, operator: PublicKey, outMint: string): Promise<bigint | null> {
  for (let i = 0; i < 16; i++) {
    const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }).catch(() => null);
    if (tx?.meta) {
      if (tx.meta.err) throw new Error(`swap ${sig} failed on-chain: ${JSON.stringify(tx.meta.err)}`);
      const me = operator.toBase58();
      let got: bigint;
      if (outMint === SOL_MINT) {
        const k = tx.transaction.message.accountKeys.findIndex((a) => a.pubkey.toBase58() === me);
        if (k < 0) throw new Error(`swap ${sig}: the operator is not in the transaction`);
        got = BigInt(tx.meta.postBalances[k]) - BigInt(tx.meta.preBalances[k]) + BigInt(tx.meta.fee);
      } else {
        const bal = (rows: typeof tx.meta.preTokenBalances) => (rows ?? []).filter((b) => b.mint === outMint && b.owner === me).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
        got = bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances);
      }
      return got > 0n ? got : 0n;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/** One Jupiter swap by the operator, resumable: the signature is persisted before sending and the delivered amount is read from the confirmed transaction. */
async function swapLeg(conn: Connection, cfg: EngineConfig, opts: RunOptions, inMint: string, inLabel: string, outMint: string, amount: bigint, leg: LegState, sigs: string[], save: () => void, log: (s: string) => void): Promise<bigint> {
  if (leg.converted) return BigInt(leg.converted);
  const operatorPk = opts.operator?.publicKey ?? PublicKey.default;
  const settle = async (sig: string) => {
    const got = await swapDelivered(conn, sig, operatorPk, outMint);
    if (got === null) throw new Error(`swap ${sig} is confirmed but not readable yet; the epoch resumes on the next run`);
    leg.converted = got.toString(); if (!sigs.includes(sig)) sigs.push(sig); save();
    return got;
  };
  if (leg.swapSig && !opts.dryRun) {
    // a swap an earlier run sent is settled first (one from before 2026-10-03 has no recorded expiry: hours old, it counts as expired)
    const prev = await landed(conn, { sig: leg.swapSig, lastValidBlockHeight: leg.lastValidBlockHeight ?? 0 }, log);
    if (prev) { const got = await settle(prev); log(`  resume: swap ${prev} delivered ${got}`); return got; }
  }
  const q = await quoteOrNoRoute(inMint, outMint, amount, cfg.slippageBps);
  log(`  swap ${amount} ${inLabel} → ${q.outAmount} of ${outMint.slice(0, 6)}… (impact ${q.priceImpactPct}%)`);
  if (opts.dryRun) return BigInt(q.outAmount);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const qq = attempt === 1 ? q : await quoteOrNoRoute(inMint, outMint, amount, cfg.slippageBps);
    const { vtx, lastValidBlockHeight } = await swapTransaction(qq, operatorPk.toBase58());
    vtx.sign([opts.operator!]);
    // persisted before sending, like every payment; Jupiter's blockhash is at most a few blocks old, so +300 is a safe stand-in for its expiry
    const s: Sent = { sig: bs58.encode(vtx.signatures[0]), lastValidBlockHeight: lastValidBlockHeight ?? (await conn.getBlockHeight("confirmed")) + 300 };
    leg.swapSig = s.sig; leg.lastValidBlockHeight = s.lastValidBlockHeight; save();
    try { await conn.sendTransaction(vtx); } // re-broadcast by the RPC until it lands or expires, like every payment (see sendOnce)
    catch (e) { if (isStaleBlockhash(e) && attempt < 3) { log(`  the RPC did not know the swap's blockhash yet (nothing sent); re-quoting (attempt ${attempt + 1} of 3)`); continue; } throw e; }
    const f = (await pollConfirm(conn, s.sig, s.lastValidBlockHeight, log)) ? "landed" : await fate(conn, s);
    if (f === "landed") { const got = await settle(s.sig); log(`  swap sent ${s.sig}, delivered ${got}`); return got; }
    if (f === "failed") throw new Error(`swap ${s.sig} failed on-chain; the epoch resumes on the next run`);
    // re-quoted only once the last swap provably cannot land: two swaps of one pot would spend another sink's tokens
    if (f === null) throw new Error(`swap ${s.sig} is neither confirmed nor expired; the epoch resumes on the next run`);
    if (attempt < 3) log(`  swap ${s.sig.slice(0, 12)}… was not included; re-quoting (attempt ${attempt + 1} of 3)`);
  }
  throw new Error(`swap not landing after 3 attempts (last ${leg.swapSig}); the epoch resumes on the next run`);
}

/** Convert `amount` of the token into the quote/payout asset. One direct Jupiter swap when a route exists; otherwise two swaps through SOL.
 *  Why: a token fresh on a LaunchLab curve → a small payout asset such as COOP is more hops than Jupiter searches (NO_ROUTES_FOUND), while
 *  token → SOL and SOL → asset both route. NoRouteError means that even the two-swap path does not exist. */
async function convert(conn: Connection, token: TokenConfig, cfg: EngineConfig, amount: bigint, outMint: string, opts: RunOptions, st: ConvProgress, save: () => void, log: (s: string) => void): Promise<bigint> {
  if (st.converted) return BigInt(st.converted);
  if (!st.path) {
    let path: "direct" | "via-sol", worth: bigint | null; // what the pot would fetch, in lamports (null: Jupiter's feed has no price right now)
    try {
      const q = await quoteOrNoRoute(token.mint, outMint, amount, cfg.slippageBps); path = "direct";
      worth = outMint === SOL_MINT ? BigInt(q.outAmount) : await lamportsOf(conn, outMint, BigInt(q.outAmount), log);
    } catch (e) {
      if (!(e instanceof NoRouteError) || outMint === SOL_MINT) throw e;
      const first = await quoteOrNoRoute(token.mint, SOL_MINT, amount, cfg.slippageBps);   // NoRouteError here: the token itself cannot be sold
      await quoteOrNoRoute(SOL_MINT, outMint, BigInt(first.outAmount), cfg.slippageBps);    // NoRouteError here: the asset cannot be bought
      path = "via-sol"; worth = BigInt(first.outAmount);
    }
    // nothing is sent yet: a pot below the floor is kept whole for the next epoch (a price the feed cannot give never blocks a swap)
    if (worth !== null && worth < MIN_SWAP_LAMPORTS) throw new TooSmallError(worth, MIN_SWAP_LAMPORTS);
    if (path === "via-sol") log(`  no direct route ${token.symbol} → ${outMint.slice(0, 6)}…; converting through SOL`);
    st.path = path; save();
  }
  if (st.path === "direct") return swapLeg(conn, cfg, opts, token.mint, token.symbol, outMint, amount, st, st.sigs, save, log);
  st.via ??= { mint: SOL_MINT };
  const sol = await swapLeg(conn, cfg, opts, token.mint, token.symbol, SOL_MINT, amount, st.via, st.sigs, save, log);
  if (sol === 0n) { st.converted = "0"; save(); return 0n; }
  return swapLeg(conn, cfg, opts, SOL_MINT, "lamports", outMint, sol, st, st.sigs, save, log);
}

/** What the epoch swept out of the mint, what it carried in from earlier epochs (kept pots), and what the sinks had to work with.
 *  Until 2026-09-29 `withdrawn` held the operator's whole balance, so an epoch after a kept pot read as if the same tax had been swept again. */
function taxRecord(state: EpochState, harvested: number, available: bigint, dryRun: boolean) {
  if (dryRun) return { withheldBefore: state.sweep.withheldBefore, harvested, withdrawn: "0", carried: "0", available: available.toString() };
  const avail = BigInt(state.sweep.available ?? "0"), before = BigInt(state.sweep.withheldBefore);
  let swept = state.sweep.swept !== undefined ? BigInt(state.sweep.swept) : before; // a sweep done by an older engine recorded only withheldBefore
  if (swept > avail) swept = avail;
  return { withheldBefore: state.sweep.withheldBefore, harvested, withdrawn: swept.toString(), carried: (avail - swept).toString(), available: avail.toString() };
}

export async function runEpoch(cfg: EngineConfig, token: TokenConfig, opts: RunOptions) {
  const log = opts.log ?? console.log;
  const conn = new Connection(cfg.rpc, "confirmed");
  const mint = new PublicKey(token.mint);
  // the operator is excluded from reflections in dry runs too, else its swept-but-unpaid tokens show up as a holder
  const operatorPk = opts.operator?.publicKey ?? opts.operatorPubkey ?? PublicKey.default;
  const ledger = new Ledger(cfg.dataDir, token.mint);
  const dir = ledger.tokenDir;

  // resume or start
  const stateFiles = fs.readdirSync(dir).filter((f) => /^epoch-\d+\.state\.json$/.test(f)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  let state: EpochState | null = null;
  if (!opts.dryRun && stateFiles.length) {
    const last = JSON.parse(fs.readFileSync(path.join(dir, stateFiles[stateFiles.length - 1]), "utf8")) as EpochState;
    if (!last.finished) { state = last; log(`[${token.symbol}] RESUMING epoch ${state.epoch} (state file)`); }
  }
  const epoch = state?.epoch ?? ledger.lastEpoch() + 1;
  const mintState = await mintWithheld(conn, mint);
  if (!state) state = { epoch, mint: token.mint, startedAt: new Date().toISOString(), sweep: { done: false, sigs: [], withheldBefore: mintState.withheld.toString() }, sinks: [] };
  const statePath = path.join(dir, `epoch-${epoch}.state.json`);
  const save = () => { if (!opts.dryRun) writeAtomic(statePath, JSON.stringify(state, null, 1)); };
  /** Persists a sink's payment the moment it is signed, before it is sent (see sendOnce). */
  const keep = (st: SinkState) => (s: Sent) => { st.pending = s; save(); };
  /** Send one transaction of sink `st`'s payment, exactly once. The caller records the signature and clears `st.pending` in one save. */
  const pay = async (st: SinkState, ixs: TransactionInstruction[]) => { const sig = await sendOnce(conn, ixs, opts.operator!, keep(st), log); log(`  sent ${sig}`); return sig; };
  log(`[${token.symbol}] epoch ${epoch} ${opts.dryRun ? "DRY RUN" : "EXECUTE"} operator=${operatorPk.toBase58()}`);

  // 1. accounts, withheld, sweep
  const rows = await tokenAccounts(conn, token.mint, cfg.heliusRpc);
  const withheldRows = await withheldOf(conn, rows.map((r) => r.address));
  const inAccounts = withheldRows.reduce((a, r) => a + r.withheld, 0n);
  log(`  token accounts ${rows.length}, withheld in accounts ${inAccounts} (${withheldRows.length} accts), in mint ${mintState.withheld}, tax ${mintState.feeBps} bps, authority ${mintState.withdrawAuthority}`);
  const operatorTokenAta = getAssociatedTokenAddressSync(mint, operatorPk, true, TOKEN_2022_PROGRAM_ID);
  // dry-run estimate: what a sweep would bring in plus what the operator already holds from earlier epochs (kept pots), as an execute run would see it
  let available = mintState.withheld + inAccounts + (opts.dryRun ? await tokenBalance(conn, operatorTokenAta, TOKEN_2022_PROGRAM_ID).catch(() => 0n) : 0n);
  if (!opts.dryRun) {
    if (!opts.operator) throw new Error("operator keypair required to execute");
    if (mintState.withdrawAuthority !== operatorPk.toBase58()) throw new Error(`operator is not the withdraw authority (${mintState.withdrawAuthority})`);
    if (!state.sweep.done) {
      // what the operator already holds was carried in from earlier epochs (kept pots); it is not swept by this one
      state.sweep.heldBefore = (await tokenBalance(conn, operatorTokenAta, TOKEN_2022_PROGRAM_ID)).toString();
      const harvestIxs = harvestInstructions(mint, withheldRows.map((r) => r.address));
      if (harvestIxs.length) state.sweep.sigs.push(...(await sendAll(conn, harvestIxs, 1, opts.operator, log)));
      const after = await mintWithheld(conn, mint);
      state.sweep.swept = after.withheld.toString(); // exactly what the withdraw below moves out of the mint
      // nothing to withdraw and the operator's account for the token exists: no transaction. Until 2026-10-04 every epoch sent one anyway
      // (the account creation, a no-op): 527 of the operator's 552 transactions in the 24 hours before, and one of them failed an epoch.
      if (after.withheld > 0n || !(await conn.getAccountInfo(operatorTokenAta))) {
        const ixs: TransactionInstruction[] = [createAssociatedTokenAccountIdempotentInstruction(operatorPk, operatorTokenAta, operatorPk, mint, TOKEN_2022_PROGRAM_ID)];
        if (after.withheld > 0n) ixs.push(withdrawFromMintInstruction(mint, operatorTokenAta, operatorPk));
        state.sweep.sigs.push(...(await sendAll(conn, ixs, 2, opts.operator, log)));
      }
      state.sweep.done = true; save();
    }
    // source of truth after a sweep: whatever the operator holds (includes leftovers of any earlier failed run).
    // The balance read can lag the withdraw by a slot or two (seen 2026-09-26: tax withdrawn, balance read 0,
    // epoch recorded as empty), so poll until it covers what was swept and never pin an epoch to a stale zero.
    if (state.sweep.available && state.sweep.available !== "0") available = BigInt(state.sweep.available);
    else {
      const expected = BigInt(state.sweep.withheldBefore ?? "0");
      available = await tokenBalance(conn, operatorTokenAta, TOKEN_2022_PROGRAM_ID);
      for (let i = 0; i < 12 && available < expected; i++) { await new Promise((r) => setTimeout(r, 1500)); available = await tokenBalance(conn, operatorTokenAta, TOKEN_2022_PROGRAM_ID); }
      if (expected > 0n && available === 0n) throw new Error(`swept ${expected} but the operator's balance still reads 0 after 18 s; leaving the epoch unfinished so the next run resumes here`);
      if (available < expected) log(`  note: balance ${available} is below the ${expected} swept (fees or a lagging node); using the balance`);
      state.sweep.available = available.toString(); save();
    }
  }
  log(`  available for sinks: ${available}`);

  // 2. holders (sink wallets and program vaults never receive reflections)
  // Treasury sink wallets never receive reflections (a treasury must not farm its own tax); the creator sink wallet is an ordinary holder.
  const treasuryWallets = token.sinks.flatMap((s) => (s.type === "treasury" ? [s.wallet] : []));
  const exclude = new Set<string>([...token.exclusions, ...treasuryWallets, operatorPk.toBase58(), CPMM_AUTH, PublicKey.findProgramAddressSync([Buffer.from("vault_auth_seed")], LAUNCHLAB)[0].toBase58()]);
  let holders: Holder[];
  if (state.snapshot) {
    // a resumed run works on the snapshot the epoch already published: the same holders, the same ages, the same allocations
    holders = state.snapshot.holders.map((h) => ({ owner: h.owner, amount: BigInt(h.amount), epochsHeld: h.epochsHeld, everSold: h.everSold, lots: h.lots?.map(([a, s]) => ({ amount: BigInt(a), since: s })) }));
  } else {
    // the snapshot is published first and the holder history advanced after it, so a crash in between can never count an epoch twice
    const at = Date.now(), balances = aggregateByOwner(rows, exclude);
    holders = ledger.applySnapshot(balances, false, at);
    state.snapshot = { slot: await conn.getSlot("confirmed"), at: new Date(at).toISOString(),
      holders: holders.map((h) => ({ owner: h.owner, amount: h.amount.toString(), epochsHeld: h.epochsHeld, everSold: h.everSold, lots: h.lots?.map((l) => [l.amount.toString(), l.since] as [string, number]) })) };
    save();
    if (!opts.dryRun) ledger.applySnapshot(balances, true, at);
  }
  const snapshotAt = Date.parse(state.snapshot.at ?? state.startedAt);
  log(`  snapshot slot ${state.snapshot.slot}: ${state.snapshot.holders.length} holders`);

  // 3. pots: every sink's share of the tax swept since the last epoch, plus what that sink itself kept then (src/plan.ts)
  const ep: EpochState = state;
  if (ep.sinks.length === 0) {
    const last = ledger.lastRecord();
    if (!last && ledger.lastEpoch() > 0) log(`  note: the last epoch's record cannot be read; the pots are formed without what the sinks kept then`);
    const formed = formPots(available, token.sinks.map((s) => s.share), keptBySink(last, token.sinks.length));
    formed.forEach((f, i) => {
      ep.sinks[i] = { done: false, pot: f.pot.toString(), keptIn: f.keptIn > 0n ? f.keptIn.toString() : undefined, sigs: [] };
      if (f.keptIn > 0n) log(`  sink ${i} ${token.sinks[i].type}: ${f.keptIn} ${token.symbol} it kept in the last epoch stay with it`);
    });
  } else {
    // an epoch the engine began before 2026-09-29 made its pots one sink at a time, each a share of everything available
    token.sinks.forEach((s, i) => { if (!ep.sinks[i]) ep.sinks[i] = { done: false, pot: shareOf(available, s.share).toString(), sigs: [] }; });
  }
  const pots = ep.sinks.map((s) => BigInt(s.pot));

  // 4. holder sinks: the minimum holding in base units, and how many holders are eligible (a sink with nobody to pay converts nothing)
  const minimums = new Map<number, { minAmount: bigint; tokenUsd: number | null; eligible: number }>();
  let priced: { usd: number | null } | undefined; // the token's price is asked once per run and shared by the holder sinks
  for (let i = 0; i < token.sinks.length; i++) {
    const sink = token.sinks[i], st = ep.sinks[i];
    if (sink.type !== "reflections" || st.done || pots[i] === 0n) continue;
    let minAmount = sink.minAmount ? BigInt(sink.minAmount) : 0n; let tokenUsd: number | null = null;
    if (sink.minUsd !== undefined && sink.minUsd > 0) {
      if (st.minAmount) { minAmount = BigInt(st.minAmount); tokenUsd = st.tokenPriceUsd ?? null; } // resumed run: the minimum this epoch already priced
      else {
        priced ??= { usd: await tokenPriceUsd(conn, token, log) };
        tokenUsd = priced.usd;
        if (tokenUsd && tokenUsd > 0) { minAmount = BigInt(Math.ceil((sink.minUsd / tokenUsd) * 10 ** token.decimals)); log(`  minimum holding $${sink.minUsd} = ${minAmount} base units at $${tokenUsd.toPrecision(4)} per ${token.symbol}`); }
        else log(`  minimum holding: token price unknown this epoch; using ${minAmount} base units`);
        st.minAmount = minAmount.toString(); st.tokenPriceUsd = tokenUsd ?? undefined; save();
      }
    }
    minimums.set(i, { minAmount, tokenUsd, eligible: holders.filter((h) => h.amount >= minAmount && h.amount > 0n && !exclude.has(h.owner)).length });
  }

  // 5. conversions: every payout asset is bought with ONE swap per epoch, shared by the sinks that pay in it (src/plan.ts).
  // Per sink: its part of what its asset's swap delivered; null = Jupiter has no route, the pot is kept.
  const skip = new Set<number>();
  token.sinks.forEach((s, i) => { if (ep.sinks[i].done || (s.type === "reflections" && minimums.get(i)?.eligible === 0)) skip.add(i); });
  const parts = await runConversions({ token, state: ep, skip, save, log, dryRun: opts.dryRun,
    convert: (amount, outMint, progress) => convert(conn, token, cfg, amount, outMint, opts, progress, save, log) });
  /** A sink's part of its asset's swap. A sink no swap was planned for converts on its own, as every sink did until 2026-09-29. */
  const partOf = async (i: number, outMint: string): Promise<bigint | null> => {
    const got = parts.get(i);
    if (got !== undefined) return got;
    if (ep.sinks[i].noRoute) return null;
    try { return await convert(conn, token, cfg, pots[i], outMint, opts, ep.sinks[i], save, log); }
    catch (e) {
      if (!(e instanceof NoRouteError)) throw e;
      if (e instanceof TooSmallError) { log(`  ${pots[i]} ${token.symbol} → ${outMint.slice(0, 6)}… is too small to swap (${e.message}); kept for the next epoch`); ep.sinks[i].keptWhy = "too small"; }
      else log(`  Jupiter has no route for ${pots[i]} ${token.symbol} → ${outMint.slice(0, 6)}…; kept for the next epoch`);
      ep.sinks[i].noRoute = true; save();
      return null;
    }
  };
  /** Why sink i got no part of a swap: its asset's swap was too small this epoch, or Jupiter had no route. */
  const keptWhy = (i: number): KeptWhy => ep.sinks[i].keptWhy ?? (ep.conversions?.find((c) => c.sinks.includes(i))?.tooSmall !== undefined ? "too small" : "no route");
  const keptText = (why: KeptWhy, outMint: string) => (why === "too small" ? "too small to swap yet" : `no route to ${outMint.slice(0, 6)}…`);

  // 6. sinks
  const records: unknown[] = [];
  for (let i = 0; i < token.sinks.length; i++) {
    const sink = token.sinks[i] as Sink;
    const st = state.sinks[i];
    const pot = pots[i];
    if (st.done) {
      log(`  sink ${i} ${sink.type}: done earlier (${st.sigs.length} txs)`);
      // Record what the earlier run did, from its persisted state, so the ledger reads the same as an uninterrupted epoch.
      const why = st.kept ? st.keptWhy : undefined;
      // a holder sink publishes what it actually paid (its frozen pay list) and what its allocation can be recomputed from, as it would have unresumed
      if (sink.type === "reflections") records.push({ type: "reflections", mode: sink.distribution, rule: sink.rule, payoutMint: sink.payoutMint === "same" ? token.mint : sink.payoutMint,
        pot: st.kept ? "0" : (BigInt(st.converted ?? pot.toString()) + BigInt(st.carriedIn ?? "0")).toString(), paid: (st.payList ?? st.allocations)?.length ?? 0,
        redistributed: st.redistributed, minAmount: st.minAmount, minUsd: sink.minUsd, tokenPriceUsd: st.tokenPriceUsd,
        entries: (st.payList ?? st.allocations ?? []).map(([owner, amount]) => ({ owner, amount })), allocations: st.allocations?.map(([owner, amount]) => ({ owner, amount })),
        lottery: st.lottery, carriedIn: st.carriedIn, remainder: st.remainder, root: st.root, kept: st.kept, keptWhy: why, keptIn: st.keptIn, resumed: true, sigs: st.sigs });
      else if (sink.type === "burn") records.push({ type: "burn", pot, asset: sink.asset && sink.asset !== "same" ? sink.asset : undefined, converted: st.converted, kept: st.kept, keptWhy: why, resumed: true, sigs: st.sigs });
      else { const pm = sinkPayoutMint(sink, token); records.push({ type: sink.type, wallet: sink.wallet, pot, asset: pm === token.mint ? "token" : pm === token.quoteMint ? "quote" : pm, payoutMint: pm, converted: st.converted, kept: st.kept, keptWhy: why, deferred: st.note?.startsWith("deferred") ? st.note.slice(9) : undefined, resumed: true, sigs: st.sigs }); }
      continue;
    }
    if (pot === 0n) { st.done = true; save(); records.push({ type: sink.type, pot: "0" }); continue; }

    if (sink.type === "burn") {
      const burnMint = sinkPayoutMint(sink, token);
      // a burn an earlier run sent for this sink is settled first: landed = burned, nothing is burned twice
      const earlier = opts.dryRun ? undefined : await landed(conn, st.pending, log);
      const burned = (sig: string | undefined) => { if (sig) st.sigs.push(sig); st.pending = undefined; st.done = true; save(); };
      if (burnMint === token.mint) {
        // the tax is collected in the token itself, so burning it is a buyback-and-burn with the buy already done
        const ix = createBurnCheckedInstruction(operatorTokenAta, mint, operatorPk, pot, token.decimals, [], TOKEN_2022_PROGRAM_ID);
        burned(earlier ?? (opts.dryRun ? undefined : await pay(st, [ix])));
        records.push({ type: "burn", pot, sigs: st.sigs }); log(`  burn ${pot}`); continue;
      }
      // buy another asset with the tax and burn that (e.g. a community's token); SOL has no burn instruction, so it is refused at registration
      if (burnMint === SOL_MINT) throw new Error(`sink ${i}: SOL cannot be burned; pick a token to buy and burn`);
      const bought = await partOf(i, burnMint);
      if (bought === null) {
        const why = keptWhy(i);
        log(`  burn: ${pot} ${token.symbol} kept for the next epoch (${keptText(why, burnMint)})`);
        st.note = `${why}; kept for next epoch`; st.kept = pot.toString(); st.keptWhy = why; st.done = true; save();
        records.push({ type: "burn", pot: "0", asset: burnMint, kept: pot, keptWhy: why, sigs: [] }); continue;
      }
      const bPk = new PublicKey(burnMint); const { program, decimals } = await mintProgramAndDecimals(conn, bPk);
      const ix = createBurnCheckedInstruction(getAssociatedTokenAddressSync(bPk, operatorPk, true, program), bPk, operatorPk, bought, decimals, [], program);
      burned(earlier ?? (!opts.dryRun && bought > 0n ? await pay(st, [ix]) : undefined));
      records.push({ type: "burn", pot, asset: burnMint, converted: bought, sigs: st.sigs });
      log(`  burn: bought ${bought} of ${burnMint.slice(0, 6)}… with ${pot} ${token.symbol} and burned it`); continue;
    }

    if (sink.type === "treasury" || sink.type === "creator") {
      const dest = new PublicKey(sink.wallet);
      const outMint = sinkPayoutMint(sink, token); // the quote (default), the token itself, or the asset the dev picked
      const asset = outMint === token.mint ? "token" : outMint === token.quoteMint ? "quote" : outMint;
      const native = outMint === SOL_MINT, carryKey = `_sink:${i}`;
      // a payment an earlier run sent for this sink is settled before anything is worked out again: landed = paid, nothing is sent twice
      let sig = opts.dryRun ? undefined : await landed(conn, st.pending, log);
      if (!sig && outMint === token.mint) {
        const destAta = getAssociatedTokenAddressSync(mint, dest, true, TOKEN_2022_PROGRAM_ID);
        const ixs = [createAssociatedTokenAccountIdempotentInstruction(operatorPk, destAta, dest, mint, TOKEN_2022_PROGRAM_ID),
          createTransferCheckedInstruction(operatorTokenAta, mint, destAta, operatorPk, pot, token.decimals, [], TOKEN_2022_PROGRAM_ID)];
        if (!opts.dryRun) sig = await pay(st, ixs);
        log(`  ${sink.type} → ${sink.wallet} ${pot} ${token.symbol} (token; the token's own tax applies once more)`);
      } else if (!sig) {
        const out = await partOf(i, outMint);
        if (out === null) {
          const why = keptWhy(i);
          log(`  ${sink.type}: ${pot} ${token.symbol} kept for the next epoch (${keptText(why, outMint)})`);
          st.note = `${why}; kept for next epoch`; st.kept = pot.toString(); st.keptWhy = why; st.done = true; save();
          records.push({ type: sink.type, wallet: sink.wallet, pot: "0", asset, payoutMint: outMint, kept: pot, keptWhy: why, sigs: [] }); continue;
        }
        const ixs: TransactionInstruction[] = [];
        let sending = out; // what leaves the operator: the sink's part, plus for SOL anything deferred in earlier epochs
        if (native) {
          const carry = loadCarry(dir);
          const owed = out + BigInt(carry[carryKey] ?? carry[sink.wallet] ?? "0");
          const { now, defer } = await deliverable(conn, [[sink.wallet, owed]]);
          if (defer.length) {
            log(`  ${sink.type} → ${sink.wallet}: ${owed} lamports deferred (wallet would stay below the rent minimum; fund it with ~0.01 SOL)`);
            if (!opts.dryRun) { delete carry[sink.wallet]; carry[carryKey] = owed.toString(); saveCarry(dir, carry); }
            st.note = `deferred ${owed}`; st.done = true; save(); records.push({ type: sink.type, wallet: sink.wallet, pot, asset, payoutMint: outMint, converted: st.converted, deferred: owed }); continue;
          }
          sending = now[0][1];
          ixs.push(SystemProgram.transfer({ fromPubkey: operatorPk, toPubkey: dest, lamports: sending }));
        } else {
          // any SPL or Token-2022 asset: into the wallet's token account for it (created by the operator if missing)
          const oPk = new PublicKey(outMint); const { program, decimals } = await mintProgramAndDecimals(conn, oPk);
          const destAta = getAssociatedTokenAddressSync(oPk, dest, true, program);
          ixs.push(createAssociatedTokenAccountIdempotentInstruction(operatorPk, destAta, dest, oPk, program),
            createTransferCheckedInstruction(getAssociatedTokenAddressSync(oPk, operatorPk, true, program), oPk, destAta, operatorPk, out, decimals, [], program));
        }
        if (!opts.dryRun && sending > 0n) sig = await pay(st, ixs);
        log(`  ${sink.type} → ${sink.wallet} ${out} of ${asset === "quote" ? "quote" : `${outMint.slice(0, 6)}…`}`);
      }
      // paid: SOL deferred in earlier epochs went out with this payment, so it is struck off now, never before the payment has landed
      // (until 2026-10-03 it was struck off before sending, and a send that failed lost it from the books)
      if (native && !opts.dryRun) { const c = loadCarry(dir); if (c[carryKey] || c[sink.wallet]) { delete c[carryKey]; delete c[sink.wallet]; saveCarry(dir, c); } }
      if (sig) st.sigs.push(sig);
      st.pending = undefined; st.done = true; save(); records.push({ type: sink.type, wallet: sink.wallet, pot, asset, payoutMint: outMint, converted: st.converted, sigs: st.sigs }); continue;
    }

    // reflections (the minimum holding and the number of eligible holders were settled in step 4, before the swaps)
    const { minAmount, tokenUsd, eligible: eligibleNow } = minimums.get(i)!;
    const payoutKey = sink.payoutMint === "same" ? token.mint : sink.payoutMint;
    let payoutMint = mint, payoutProgram = TOKEN_2022_PROGRAM_ID, payoutDecimals = token.decimals, payoutPot = pot;
    // Nobody eligible (e.g. the only holder is a sink wallet): do not convert; the tokens stay with the operator and flow into the next epoch's total.
    if (eligibleNow === 0 && !st.converted && !st.allocations && !st.swapSig) {
      log(`  reflections: no eligible holder this epoch; ${pot} ${token.symbol} kept for the next epoch`);
      st.note = "no eligible holders; kept for next epoch"; st.kept = pot.toString(); st.keptWhy = "no eligible holder"; st.done = true; save();
      records.push({ type: "reflections", mode: sink.distribution, rule: sink.rule, payoutMint: payoutKey, pot: "0", paid: 0, entries: [], kept: pot, keptWhy: "no eligible holder", sigs: [] });
      continue;
    }
    if (sink.payoutMint !== "same") {
      payoutMint = new PublicKey(sink.payoutMint);
      if (sink.payoutMint !== SOL_MINT) ({ program: payoutProgram, decimals: payoutDecimals } = await mintProgramAndDecimals(conn, payoutMint));
      const got = await partOf(i, sink.payoutMint);
      if (got === null) {
        const why = keptWhy(i);
        log(`  reflections: ${pot} ${token.symbol} kept for the next epoch (${keptText(why, sink.payoutMint)})`);
        st.note = `${why}; kept for next epoch`; st.kept = pot.toString(); st.keptWhy = why; st.done = true; save();
        records.push({ type: "reflections", mode: sink.distribution, rule: sink.rule, payoutMint: payoutKey, pot: "0", paid: 0, entries: [], kept: pot, keptWhy: why, sigs: [] });
        continue;
      }
      payoutPot = got;
    }
    if (!st.allocations) {
      // anything an earlier epoch could not allocate (rounding remainder, or a pot with no eligible holder) joins this pot
      const carry = loadCarry(dir);
      const carriedIn = BigInt(carry[`_pot:${i}`] ?? "0");
      const totalPot = payoutPot + carriedIn;
      if (sink.rule.type === "lottery" && !st.lottery) { st.lottery = await seedAfter(conn, state.snapshot!.slot); save(); log(`  lottery seed: blockhash ${st.lottery.blockhash} of slot ${st.lottery.slot} (snapshot slot ${state.snapshot!.slot})`); }
      const alloc = allocate(sink.rule, holders, totalPot, { minAmount, exclude, seed: st.lottery?.blockhash ?? opts.seed ?? `${token.mint}:${epoch}`, at: snapshotAt });
      st.allocations = [...alloc.allocations.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).map(([o, a]) => [o, a.toString()]);
      st.carriedIn = carriedIn.toString(); st.remainder = alloc.remainder.toString();
      st.note = `rule=${sink.rule.type} eligible=${alloc.eligible} remainder=${alloc.remainder}${carriedIn ? ` carriedIn=${carriedIn}` : ""}`;
      save(); // the carry file learns the new remainder only after this (applyCarry), so a run that dies in between still finds what it carried in
    }
    /** The carry file, once per epoch and sink: what the sink consumed is struck off and its pot carry becomes this epoch's remainder plus
     *  anything rolled over. Setting rather than adding, after the state that says so is saved, makes a repeat after a crash harmless. */
    const applyCarry = () => {
      if (opts.dryRun || st.carryDone) return;
      const c = loadCarry(dir);
      for (const k of st.consumed ?? []) delete c[k];
      c[`_pot:${i}`] = (BigInt(st.remainder ?? "0") + BigInt(st.rolled ?? "0")).toString();
      saveCarry(dir, c); st.carryDone = true; save();
    };
    const recipients = st.allocations.map(([o, a]) => [o, BigInt(a)] as [string, bigint]);
    payoutPot = payoutPot + BigInt(st.carriedIn ?? "0");
    log(`  reflections ${st.note} paid=${recipients.length} pot=${payoutPot}`);

    if (sink.distribution === "claim") {
      const { tree, leaves } = balanceTree(recipients.map(([o, a]) => ({ account: new PublicKey(o).toBytes(), amount: a })));
      applyCarry();
      st.root = toHex(tree.root); st.done = true; save();
      records.push({ type: "reflections", mode: "claim", rule: sink.rule, payoutMint: payoutMint.toBase58(), pot: payoutPot, root: st.root, minAmount: minAmount.toString(), minUsd: sink.minUsd, tokenPriceUsd: tokenUsd ?? undefined, lottery: st.lottery,
        entries: recipients.map(([owner, amount], k) => ({ index: k, owner, amount, proof: tree.proof(leaves[k].leaf).map(toHex) })) });
      log(`  merkle root ${st.root} (${recipients.length} leaves) — distributor funding is v1`); continue;
    }

    const nativeSol = payoutMint.toBase58() === SOL_MINT;
    const perTx = nativeSol ? 20 : 12;
    // Who is paid what is worked out ONCE and frozen with the state before the first batch is sent: a resumed run pays exactly this list,
    // in exactly these batches, whatever changed on-chain since. (Until 2026-10-03 a resumed run worked it out again from the chain and the
    // carry file, which the first attempt had already changed, so a price or balance move could shift the batches it skipped.)
    if (!st.payList) {
      const carry = loadCarry(dir);
      const merged = new Map<string, bigint>(recipients);
      let now: [string, bigint][] = [], defer: [string, bigint][] = [], reason = "";
      const consumed: string[] = [];
      if (nativeSol) {
        // per-wallet carries from before 2026-09-28 join their wallet's payout once; a wallet below the rent minimum cannot receive SOL
        for (const [o, v] of Object.entries(carry)) if (!o.startsWith("_") && !o.includes("@")) { merged.set(o, (merged.get(o) ?? 0n) + BigInt(v)); consumed.push(o); }
        ({ now, defer } = await deliverable(conn, [...merged.entries()]));
        reason = "recipient wallet below Solana's rent minimum";
      } else {
        // a first-time recipient needs a token account (~0.002 SOL of the operator's SOL): funded only when the payout is worth at least $1 and twice that rent
        const mintKey = payoutMint.toBase58(), suffix = `@${mintKey}`;
        for (const [k, v] of Object.entries(carry)) if (k.endsWith(suffix)) { const o = k.slice(0, -suffix.length); merged.set(o, (merged.get(o) ?? 0n) + BigInt(v)); consumed.push(k); }
        const owners = [...merged.keys()];
        const exists = new Set<string>();
        for (let i2 = 0; i2 < owners.length; i2 += 100) {
          const batch = owners.slice(i2, i2 + 100);
          const infos = await conn.getMultipleAccountsInfo(batch.map((o) => getAssociatedTokenAddressSync(payoutMint, new PublicKey(o), true, payoutProgram)));
          infos.forEach((inf, k) => { if (inf) exists.add(batch[k]); });
        }
        const priced = await payoutValueInLamports(mintKey, payoutDecimals, log);
        const minFirst = Math.max(Number(ATA_RENT) * 2, priced ? (MIN_FIRST_PAYOUT_USD / priced.solUsd) * 1e9 : 0);
        for (const [o, v] of merged) {
          if (exists.has(o)) { now.push([o, v]); continue; }
          const worth = priced ? Number(v) * priced.lamportsPerUnit : 0;
          (worth >= minFirst ? now : defer).push([o, v]);
        }
        st.newAtas = now.filter(([o]) => !exists.has(o)).length;
        reason = `a new token account (${Number(ATA_RENT) / 1e9} SOL) is not funded for a first payout under $${MIN_FIRST_PAYOUT_USD}${priced ? "" : "; payout price unknown this epoch"}`;
      }
      const { paid, moved, rolled } = redistribute(now, defer);
      if (defer.length) log(`  ${defer.length} payouts not deliverable (${reason}): ${moved > 0n ? `${moved} redistributed pro-rata to the ${paid.length} holders paid this epoch` : `${rolled} rolled into the next epoch's pot`}`);
      st.payList = paid.map(([o, a]) => [o, a.toString()]); st.redistributed = moved.toString(); st.rolled = rolled.toString(); st.consumed = consumed;
      save();
    }
    applyCarry();
    const payList = st.payList.map(([o, a]) => [o, BigInt(a)] as [string, bigint]);
    const ixs: TransactionInstruction[] = [];
    for (const [owner, amount] of payList) {
      const dest = new PublicKey(owner);
      if (nativeSol) ixs.push(SystemProgram.transfer({ fromPubkey: operatorPk, toPubkey: dest, lamports: amount }));
      else {
        const ata = getAssociatedTokenAddressSync(payoutMint, dest, true, payoutProgram);
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(operatorPk, ata, dest, payoutMint, payoutProgram),
          createTransferCheckedInstruction(getAssociatedTokenAddressSync(payoutMint, operatorPk, true, payoutProgram), payoutMint, ata, operatorPk, amount, payoutDecimals, [], payoutProgram));
      }
    }
    const batches = Math.ceil(ixs.length / perTx);
    log(`  push${nativeSol ? " (native SOL)" : ""}: ${payList.length} transfers in ${batches} txs${st.paidBatches ? ` (resuming after ${st.paidBatches} paid batches)` : ""}; worst-case ATA rent ${Number(ATA_RENT * BigInt(st.newAtas ?? 0)) / 1e9} SOL`);
    if (!opts.dryRun) {
      // the batch an earlier run had in flight (always batch number `paidBatches`) is settled first: landed = paid, not sent again
      const earlier = await landed(conn, st.pending, log);
      if (earlier) { st.sigs.push(earlier); st.paidBatches = (st.paidBatches ?? 0) + 1; }
      st.pending = undefined; save();
      for (let b = st.paidBatches ?? 0; b < batches; b++) {
        const sig = await pay(st, ixs.slice(b * perTx, (b + 1) * perTx));
        st.sigs.push(sig); st.paidBatches = b + 1; st.pending = undefined; save();
      }
    }
    st.done = true; save();
    records.push({ type: "reflections", mode: "push", rule: sink.rule, payoutMint: payoutMint.toBase58(), pot: payoutPot, paid: payList.length, redistributed: BigInt(st.redistributed ?? "0"), minAmount: minAmount.toString(), minUsd: sink.minUsd, tokenPriceUsd: tokenUsd ?? undefined, entries: payList.map(([owner, amount]) => ({ owner, amount })), allocations: st.allocations.map(([owner, amount]) => ({ owner, amount })), lottery: st.lottery, carriedIn: st.carriedIn, remainder: st.remainder, sigs: st.sigs });
  }

  // every record says what its sink brought along from the last epoch, so the pots can be recomputed from the published ledger
  records.forEach((r, i) => { if (ep.sinks[i]?.keptIn && r && typeof r === "object") (r as { keptIn?: string }).keptIn = ep.sinks[i].keptIn; });
  // the record is written before the state is marked finished: a run that dies in between resumes, finds every sink done and writes the
  // same record again (the other order could leave a finished epoch with no record, and the next run would start the same number afresh)
  const file = ledger.writeEpoch({
    epoch, ranAt: new Date().toISOString(), dryRun: opts.dryRun, mint: token.mint,
    tax: taxRecord(state, withheldRows.length, available, opts.dryRun),
    sinks: records,
    // the swaps of the epoch, one per payout asset: which sinks shared it, what went in and what came out (each sink's `converted` is its part)
    conversions: (ep.conversions ?? []).map((c) => ({ mint: c.mint, sinks: c.sinks, amount: c.amount, path: c.path, via: c.via?.converted ? { mint: c.via.mint, converted: c.via.converted } : undefined, converted: c.converted, kept: c.noRoute ? c.amount : undefined, tooSmall: c.tooSmall, sigs: c.sigs })),
    signatures: [...new Set([...state.sweep.sigs, ...(ep.conversions ?? []).flatMap((c) => c.sigs), ...state.sinks.flatMap((s) => s.sigs)])],
    snapshot: state.snapshot,
  });
  state.finished = true; save();
  log(`  ledger → ${file}`);
  return { epoch, available, file };
}
