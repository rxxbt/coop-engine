/**
 * Buy-tax refunds (since 2026-10-05). A Token-2022 transfer fee is charged on every transfer, buys included; nothing on Solana can tax
 * sells only (Raydium's pools refuse transfer hooks). This emulates it: every epoch the engine finds the buys of the epoch (tokens that left
 * the pool's vault into a wallet's token account), works out the tax each buyer paid from the transaction's own balance changes, and pays
 * it back, grossed up so the refund's own tax does not eat into it. The refunds come off the top of what was swept, before the sinks split
 * the rest. Mode `holders`: only buyers still holding everything they bought in the window at the snapshot (a sniper who flips inside the
 * epoch forfeits the tax to the pot); mode `all`: every buyer. Every refund is in the epoch's ledger with the buy it answers.
 * Pure attribution here; the chain reads (signatures, parsed transactions) are small wrappers at the bottom.
 */
import bs58 from "bs58";
import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";

export type Buy = { sig: string; slot: number; owner: string; bought: bigint; fee: bigint };
export type RefundEntry = { owner: string; bought: string; fee: string; refund: string; buys: number };
export type RefundRecord = {
  mode: "holders" | "all"; buys: number; buyers: number;
  /** the tax paid back (before gross-up) and sent (grossed up), and the tax of buyers who did not qualify, in the token's base units */
  fees: string; refunded: string; forfeited: string;
  entries: RefundEntry[];
  /** the newest signature seen per vault: the next epoch starts after it */
  cursors: Record<string, string>;
  sigs: string[];
  /** refunds scaled down to what was swept (should never happen: a buy's tax is in the sweep that follows it) */
  scaled?: boolean;
};

const LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
/** Anchor discriminator of LaunchLab's ClaimVestedToken: a transfer out of the pool's vault that is not a buy. */
const CLAIM_VESTED = [49, 33, 104, 30, 189, 157, 79, 35];

/** Does this transaction claim vested tokens (LaunchLab instruction, top-level or inner)? Those also leave the vault but nobody bought them. */
export function isVestingClaim(tx: ParsedTransactionWithMeta): boolean {
  const all: any[] = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions)];
  for (const ix of all) {
    if (ix?.programId?.toBase58?.() !== LAUNCHLAB || typeof ix.data !== "string") continue;
    try { const d = bs58.decode(ix.data); if (d.length >= 8 && CLAIM_VESTED.every((b, i) => d[i] === b)) return true; } catch { /* not base58 */ }
  }
  return false;
}

/** ceil(amount × bps / 10000): what Token-2022 withholds on a transfer of `amount` (no practical cap on COOP launches). */
export const feeOn = (amount: bigint, bps: number) => (amount * BigInt(bps) + 9999n) / 10000n;
/** The refund to send so that the buyer nets `fee` after the refund's own tax: fee ÷ (1 − bps/10000), rounded up. */
export const grossUp = (fee: bigint, bps: number) => bps >= 10000 ? fee : (fee * 10000n + BigInt(10000 - bps) - 1n) / BigInt(10000 - bps);

/**
 * The buys in one confirmed transaction: for every wallet token account of `mint` whose balance rose while a pool vault's fell, the tokens
 * it received and the tax withheld on them, from the transaction's own pre/post balances (so any route, Jupiter hops included, is read the
 * same way). The vault's outflow minus what the recipients received is the tax; it is shared between recipients by what they received,
 * and never more than the tax the rate implies for each.
 */
export function buysInTx(tx: ParsedTransactionWithMeta, mint: string, vaults: Set<string>, ignoreOwners: Set<string>, feeBps: number): Buy[] {
  if (!tx.meta || tx.meta.err) return [];
  if (isVestingClaim(tx)) return [];
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const bal = (rows: typeof tx.meta.preTokenBalances) => { const m = new Map<number, { owner: string; amount: bigint }>(); for (const b of rows ?? []) if (b.mint === mint) m.set(b.accountIndex, { owner: b.owner ?? "", amount: BigInt(b.uiTokenAmount.amount) }); return m; };
  const pre = bal(tx.meta.preTokenBalances), post = bal(tx.meta.postTokenBalances);
  let vaultOut = 0n;
  const got: { owner: string; delta: bigint }[] = [];
  for (const idx of new Set([...pre.keys(), ...post.keys()])) {
    const a = pre.get(idx)?.amount ?? 0n, b = post.get(idx)?.amount ?? 0n, owner = post.get(idx)?.owner || pre.get(idx)?.owner || "";
    const account = keys[idx];
    if (vaults.has(account)) { if (a > b) vaultOut += a - b; continue; }
    if (b > a && owner && !ignoreOwners.has(owner) && !vaults.has(owner)) got.push({ owner, delta: b - a });
  }
  if (vaultOut <= 0n || !got.length) return [];
  const received = got.reduce((s, g) => s + g.delta, 0n);
  let tax = vaultOut - received;
  if (tax < 0n) tax = 0n;
  const buys: Buy[] = [];
  for (const g of got) {
    let fee = (tax * g.delta) / received;
    const most = feeOn(grossUp(g.delta, feeBps), feeBps); // the tax the rate implies on the transfer that nets `delta`
    if (fee > most) fee = most;
    buys.push({ sig: tx.transaction.signatures[0], slot: tx.slot, owner: g.owner, bought: g.delta, fee });
  }
  return buys;
}

/** One buyer's totals over the epoch's buys. */
export function totalsByBuyer(buys: Buy[]): Map<string, { bought: bigint; fee: bigint; buys: number }> {
  const m = new Map<string, { bought: bigint; fee: bigint; buys: number }>();
  for (const b of buys) { const t = m.get(b.owner) ?? { bought: 0n, fee: 0n, buys: 0 }; t.bought += b.bought; t.fee += b.fee; t.buys++; m.set(b.owner, t); }
  return m;
}

/**
 * Who is refunded what. `balances` = the epoch's snapshot (wallet → balance): in `holders` mode a buyer qualifies only when they still hold at
 * least everything they bought in the window; selling any of it forfeits the whole refund to the pot. `available` caps the total: refunds are
 * scaled down to fit, which should never happen (a buy's tax is in the sweep that follows it) and is flagged when it does.
 */
export function planRefunds(buys: Buy[], mode: "holders" | "all", balances: Map<string, bigint>, feeBps: number, available: bigint): { entries: RefundEntry[]; fees: bigint; refunded: bigint; forfeited: bigint; scaled: boolean } {
  const entries: RefundEntry[] = [];
  let fees = 0n, forfeited = 0n;
  for (const [owner, t] of totalsByBuyer(buys)) {
    if (t.fee <= 0n) continue;
    const holds = (balances.get(owner) ?? 0n) >= t.bought;
    if (mode === "holders" && !holds) { forfeited += t.fee; continue; }
    fees += t.fee;
    entries.push({ owner, bought: t.bought.toString(), fee: t.fee.toString(), refund: grossUp(t.fee, feeBps).toString(), buys: t.buys });
  }
  let refunded = entries.reduce((s, e) => s + BigInt(e.refund), 0n), scaled = false;
  if (refunded > available && refunded > 0n) {
    scaled = true;
    for (const e of entries) e.refund = ((BigInt(e.refund) * available) / refunded).toString();
    refunded = entries.reduce((s, e) => s + BigInt(e.refund), 0n);
  }
  entries.sort((a, b) => (BigInt(b.refund) > BigInt(a.refund) ? 1 : -1));
  return { entries, fees, refunded, forfeited, scaled };
}

/** Signatures that touched `address` after `until` (exclusive) and not before `sinceMs`, oldest first; failed transactions left out. */
export async function signaturesSince(conn: Connection, address: PublicKey, until: string | undefined, sinceMs: number, maxPages = 20): Promise<{ sig: string; slot: number }[]> {
  const out: { sig: string; slot: number }[] = [];
  let before: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const rows = await conn.getSignaturesForAddress(address, { until, before, limit: 1000 }, "confirmed");
    if (!rows.length) break;
    let stop = false;
    for (const r of rows) {
      if (r.blockTime && r.blockTime * 1000 < sinceMs) { stop = true; break; }
      if (!r.err) out.push({ sig: r.signature, slot: r.slot });
    }
    if (stop || rows.length < 1000) break;
    before = rows[rows.length - 1].signature;
  }
  return out.reverse();
}

/** The buys behind a list of signatures (parsed in batches of 50; a transaction the RPC cannot return yet is skipped and found on the next pass). */
export async function buysOf(conn: Connection, sigs: string[], mint: string, vaults: Set<string>, ignoreOwners: Set<string>, feeBps: number): Promise<Buy[]> {
  const buys: Buy[] = [];
  for (let i = 0; i < sigs.length; i += 50) {
    const batch = sigs.slice(i, i + 50);
    const txs = await conn.getParsedTransactions(batch, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
    txs.forEach((tx) => { if (tx) buys.push(...buysInTx(tx, mint, vaults, ignoreOwners, feeBps)); });
  }
  return buys;
}
