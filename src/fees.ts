/**
 * Pool fees after graduation (since 2026-10-02). A token launched on a COOP platform account graduates into a Raydium CPMM pool whose
 * recorded creator is the COOP operator (the accounts' platformCpCreator); every swap in that pool pays a 0.75% creator fee into the pool,
 * which only the operator can claim. COOP's promise (docs, landing): 0.42 of the pool's 1.00% goes to the dev, published per token, so the
 * dev gets 42/75 of every claim; the platform's 33/75 goes to the platform fee wallet when one is set, else stays with the operator.
 * Dust safeguard: a pool's fees are claimed only once the dev's share is worth at least MIN_FORWARD_USD; until then they keep accruing in
 * the pool, where only the operator can claim them. One run a day (scripts/run-fees.sh). Every claim and transfer is recorded in
 * data/<mint>/fees.json; data/<mint>/fees-state.json makes a run resumable like an epoch, so a crash never pays anyone twice.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, type TransactionInstruction, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, createCloseAccountInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Raydium, TxVersion, LAUNCHPAD_PROGRAM, LaunchpadPool, getPdaLaunchpadPoolId, CREATE_CPMM_POOL_PROGRAM } from "@raydium-io/raydium-sdk-v2";
import bs58 from "bs58";
import type { EngineConfig } from "./config.js";
import { isStaleBlockhash, jupPrices, landed, pollConfirm } from "./epoch.js";

const SOL = "So11111111111111111111111111111111111111112";
/** The dev's part of the 0.75% creator fee: 0.42 of the pool's 1.00%. */
export const DEV_SHARE = { num: 42n, den: 75n };
export const MIN_FORWARD_USD = Number(process.env.MIN_FORWARD_USD || 1); // an empty setting means the default, never "no floor"
/** The COOP platform accounts (the API's list): only their pools' fees are COOP's to claim and forward. */
export const PLATFORM_IDS = (process.env.PLATFORM_IDS || "DEfEVZNPRvQGCpKq19BQ5dpB2hmGVFJ4y1ewPSFz22y5,BWk6ALyW2yj1tud1v7Dr4SQzYGprA6na1xRhiv2tZoNG,Cd3DhizoqEUwMhpHiqF4wcFFocq6QCDZEHU6UvRnJY21").split(",").map((x) => x.trim());

/** Split a claimed amount: the dev's 42/75, rounded down, and the rest for the platform. Nothing is created or lost. */
export function splitPoolFees(claimed: bigint): { dev: bigint; platform: bigint } {
  const dev = (claimed * DEV_SHARE.num) / DEV_SHARE.den;
  return { dev, platform: claimed - dev };
}
/** Is the dev's share worth sending? A price the feed cannot give means: not yet (the fees stay in the pool, nothing is lost). */
export function worthForwarding(devRaw: bigint, decimals: number, priceUsd: number | undefined, minUsd = MIN_FORWARD_USD): { ok: boolean; usd: number | null } {
  if (!priceUsd || priceUsd <= 0) return { ok: false, usd: null };
  const usd = (Number(devRaw) / 10 ** decimals) * priceUsd;
  return { ok: usd >= minUsd, usd };
}

export type FeeRecord = {
  n: number; at: string; pool: string; quoteMint: string; claimSig: string;
  claimed: { quote: string; token: string };
  dev: { wallet: string; quote: string; token: string; sigs: string[] };
  platform: { wallet: string | null; quote: string; token: string; sigs: string[] };
};
/** One transaction of a run: its signature is saved BEFORE it is sent, so a run that died in between can tell "landed" from "never sent". */
type Sent = { sig: string; lastValidBlockHeight: number; done?: boolean };
type FeeState = { n: number; startedAt: string; pool: string; claim?: Sent; claimed?: { quote: string; token: string }; dev?: Sent; platform?: Sent; finished?: boolean };

export function feeRecords(dataDir: string, mint: string): FeeRecord[] {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, mint, "fees.json"), "utf8")); } catch { return []; }
}

/** What a confirmed transaction moved into `owner`'s token accounts of `mint` (exact, from the transaction's own balances). */
function receivedBy(tx: ParsedTransactionWithMeta, owner: string, mint: string): bigint {
  const sum = (rows: any[] | null | undefined) => (rows ?? []).filter((b) => b.mint === mint && b.owner === owner).reduce((a: bigint, b: any) => a + BigInt(b.uiTokenAmount.amount), 0n);
  const got = sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
  return got > 0n ? got : 0n;
}

export type FeeRunOptions = { dryRun: boolean; operator?: Keypair; operatorPubkey: PublicKey; platformWallet?: PublicKey; only?: string; log?: (s: string) => void };
type Candidate = { mint: string; symbol: string; quoteMint: string; creator: string };

/** Registered tokens whose LaunchLab pool has migrated (status 2), plus graduated tokens on the COOP accounts that were never registered
 *  (a launch without a tax has nothing to register, and its dev is owed the same share), found through Raydium's launch list. */
async function graduated(conn: Connection, cfg: EngineConfig, platformIds: string[], log: (s: string) => void): Promise<Candidate[]> {
  const out: Candidate[] = [], seen = new Set<string>();
  const check = async (mint: string, quoteMint: string, symbol: string) => {
    if (seen.has(mint)) return; seen.add(mint);
    const info = await conn.getAccountInfo(getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, new PublicKey(mint), new PublicKey(quoteMint)).publicKey).catch(() => null);
    if (!info) return;
    const p: any = LaunchpadPool.decode(info.data);
    if (p.status !== 2 || !platformIds.includes(p.platformId.toBase58())) return;
    out.push({ mint, symbol, quoteMint, creator: p.creator.toBase58() });
  };
  for (const t of cfg.tokens) await check(t.mint, t.quoteMint, t.symbol);
  for (const id of platformIds) {
    try {
      const r: any = await fetch(`https://launch-mint-v1.raydium.io/get/list?platformId=${id}&sort=new&size=100&mintType=default&includeNsfw=true`, { signal: AbortSignal.timeout(20_000) }).then((x) => x.json());
      for (const row of r?.data?.rows ?? []) if (Number(row.finishingRate) >= 100 && row.mint && row.mintB?.address) await check(row.mint, row.mintB.address, String(row.symbol ?? row.mint.slice(0, 6)));
    } catch (e) { log(`  [fees] Raydium's launch list for ${id.slice(0, 6)}… unavailable (${String((e as any)?.message ?? e).slice(0, 60)}); registered tokens only`); }
  }
  return out;
}

export async function runFees(cfg: EngineConfig, opts: FeeRunOptions, platformIds: string[] = PLATFORM_IDS): Promise<{ forwarded: string[]; waiting: number; failed: string[] }> {
  const log = opts.log ?? console.log;
  const conn = new Connection(cfg.heliusRpc || cfg.rpc, "confirmed");
  const me = opts.operator?.publicKey ?? opts.operatorPubkey;
  const raydium = await Raydium.load({ connection: conn, owner: opts.operator ?? me, disableFeatureCheck: true, disableLoadToken: true });
  const forwarded: string[] = [], failed: string[] = []; let waiting = 0;
  const tokens = (await graduated(conn, cfg, platformIds, log)).filter((t) => !opts.only || t.mint === opts.only || t.symbol === opts.only);
  log(`[fees] ${tokens.length} graduated token(s) on COOP accounts`);
  for (const t of tokens) {
    const tag = `[fees ${t.symbol}]`;
    // one token's trouble (Raydium's API down, a stuck transaction) never stops the others; the run exits non-zero so the cron alerts
    try {
    const pools: any = await raydium.api.fetchPoolByMints({ mint1: t.mint });
    const poolInfo = (pools?.data ?? []).find((p: any) => p.programId === CREATE_CPMM_POOL_PROGRAM.toBase58() && [p.mintA?.address, p.mintB?.address].includes(t.quoteMint));
    if (!poolInfo) { log(`${tag} no CPMM pool found for the pair yet`); continue; }
    const rpc: any = await raydium.cpmm.getRpcPoolInfo(poolInfo.id);
    if (!rpc.poolCreator?.equals?.(me)) { log(`${tag} pool ${poolInfo.id} records ${rpc.poolCreator?.toBase58?.()} as creator, not the operator: nothing to claim`); continue; }
    const quoteIsA = poolInfo.mintA.address === t.quoteMint;
    const qInfo = quoteIsA ? poolInfo.mintA : poolInfo.mintB, tInfo = quoteIsA ? poolInfo.mintB : poolInfo.mintA;
    const accruedQ = BigInt((quoteIsA ? rpc.creatorFeesMintA : rpc.creatorFeesMintB)?.toString() ?? "0");
    const accruedT = BigInt((quoteIsA ? rpc.creatorFeesMintB : rpc.creatorFeesMintA)?.toString() ?? "0");
    const dir = path.join(cfg.dataDir, t.mint); fs.mkdirSync(dir, { recursive: true });
    const statePath = path.join(dir, "fees-state.json");
    let state: FeeState | null = null;
    try { const s = JSON.parse(fs.readFileSync(statePath, "utf8")) as FeeState; if (!s.finished) state = s; } catch { /* none */ }
    if (!state) {
      const devQ = splitPoolFees(accruedQ).dev;
      const prices = await jupPrices([t.quoteMint]).catch(() => ({} as Record<string, number>));
      const w = worthForwarding(devQ, qInfo.decimals, prices[t.quoteMint]);
      const show = (raw: bigint, d: number) => (Number(raw) / 10 ** d).toLocaleString("en-US", { maximumFractionDigits: d });
      log(`${tag} pool ${poolInfo.id}: accrued ${show(accruedQ, qInfo.decimals)} ${qInfo.symbol}${accruedT > 0n ? ` + ${show(accruedT, tInfo.decimals)} ${tInfo.symbol}` : ""}; dev's share ${show(devQ, qInfo.decimals)} ${qInfo.symbol} = ${w.usd === null ? "price unknown" : `$${w.usd.toFixed(2)}`}`);
      if (!w.ok) { log(`${tag} waiting: the dev's share is below $${MIN_FORWARD_USD}${w.usd === null ? " or cannot be priced" : ""}; the fees keep accruing in the pool`); waiting++; continue; }
      const splitQ = splitPoolFees(accruedQ), splitT = splitPoolFees(accruedT);
      if (opts.dryRun) {
        log(`${tag} DRY RUN would claim and send the dev ${t.creator} ${show(splitQ.dev, qInfo.decimals)} ${qInfo.symbol}${splitT.dev > 0n ? ` + ${show(splitT.dev, tInfo.decimals)} ${tInfo.symbol}` : ""}; platform share ${show(splitQ.platform, qInfo.decimals)} ${qInfo.symbol} ${opts.platformWallet ? `to ${opts.platformWallet.toBase58()}` : "stays with the operator"}`);
        forwarded.push(`${t.symbol} (dry) ${show(splitQ.dev, qInfo.decimals)} ${qInfo.symbol}`);
        continue;
      }
      state = { n: feeRecords(cfg.dataDir, t.mint).length + 1, startedAt: new Date().toISOString(), pool: poolInfo.id };
    }
    const st: FeeState = state;
    const save = () => fs.writeFileSync(statePath, JSON.stringify(st, null, 1));
    if (!opts.operator) throw new Error("operator keypair required to execute");
    const operator = opts.operator;
    /** Send `build()`'s transaction once: sign with a fresh blockhash, save the signature, then send and wait. On a resumed run a saved
     *  signature is checked first: landed = done; failed on-chain or expired without landing = built and sent again; still pending = stop. */
    const once = async (slot: "claim" | "dev" | "platform", build: () => Promise<VersionedTransaction | Transaction>): Promise<string> => {
      const prev = st[slot];
      if (prev?.done) return prev.sig;
      if (prev) {
        // settled as every epoch payment is (src/epoch.ts): an RPC error stops the run instead of reading as "failed on-chain", which until
        // 2026-10-03 could send a forwarding again that had landed
        const sig = await landed(conn, prev, log);
        if (sig) { prev.done = true; save(); return sig; }
      }
      let sig = "", lastValidBlockHeight = 0;
      for (let attempt = 1; ; attempt++) {
        const tx = await build();
        const bh = await conn.getLatestBlockhash("confirmed"); lastValidBlockHeight = bh.lastValidBlockHeight;
        let raw: Uint8Array;
        if (tx instanceof VersionedTransaction) { tx.message.recentBlockhash = bh.blockhash; tx.sign([operator]); raw = tx.serialize(); sig = bs58.encode(tx.signatures[0]); }
        else { tx.recentBlockhash = bh.blockhash; tx.feePayer = operator.publicKey; tx.sign(operator); raw = tx.serialize(); sig = bs58.encode(tx.signature!); }
        st[slot] = { sig, lastValidBlockHeight }; save();
        try { await conn.sendRawTransaction(raw); break; } // re-broadcast by the RPC until it lands or expires (see sendOnce in src/epoch.ts)
        catch (e) { if (isStaleBlockhash(e) && attempt < 3) { log(`${tag} ${slot}: the RPC did not know the blockhash yet (nothing sent); sending again`); await new Promise((r) => setTimeout(r, 2000)); continue; } throw e; }
      }
      if (!(await pollConfirm(conn, sig, lastValidBlockHeight, log))) throw new Error(`${tag} ${slot} ${sig} not confirmed in time; the next run resumes here`);
      st[slot]!.done = true; save();
      return sig;
    };

    // 1. claim: the creator fees of both sides move from the pool into the operator's token accounts
    if (!st.claimed) {
      const sig = await once("claim", async () => (await raydium.cpmm.collectCreatorFees({ poolInfo, txVersion: TxVersion.V0 }) as { transaction: VersionedTransaction }).transaction);
      let tx: ParsedTransactionWithMeta | null = null;
      for (let i = 0; i < 16 && !tx?.meta; i++) { tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }).catch(() => null); if (!tx?.meta) await new Promise((r) => setTimeout(r, 1500)); }
      if (!tx?.meta) throw new Error(`${tag} claim ${sig} confirmed but not readable yet; the next run resumes here`);
      st.claimed = { quote: receivedBy(tx, me.toBase58(), t.quoteMint).toString(), token: receivedBy(tx, me.toBase58(), t.mint).toString() };
      save();
      log(`${tag} claimed ${st.claimed.quote} ${qInfo.symbol} base units${st.claimed.token !== "0" ? ` + ${st.claimed.token} ${tInfo.symbol}` : ""} (${sig})`);
    }

    // 2. forward: the dev's 42/75 of what was claimed, then the platform's 33/75 to its wallet when one is set (each its own transaction)
    const q = splitPoolFees(BigInt(st.claimed.quote)), tk = splitPoolFees(BigInt(st.claimed.token));
    const transfers = (to: PublicKey, quoteAmount: bigint, tokenAmount: bigint, unwrap: boolean): TransactionInstruction[] => {
      const ixs: TransactionInstruction[] = [];
      // SOL arrives as wrapped SOL: the first transfer unwraps the operator's wSOL account, so the dev and the platform get plain SOL
      if (unwrap) ixs.push(createCloseAccountInstruction(getAssociatedTokenAddressSync(new PublicKey(SOL), me, true, TOKEN_PROGRAM_ID), me, me, [], TOKEN_PROGRAM_ID));
      const send = (mint: string, program: string, decimals: number, amount: bigint) => {
        if (amount <= 0n) return;
        if (mint === SOL) { ixs.push(SystemProgram.transfer({ fromPubkey: me, toPubkey: to, lamports: amount })); return; }
        const prog = new PublicKey(program), m = new PublicKey(mint), dest = getAssociatedTokenAddressSync(m, to, true, prog);
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(me, dest, to, m, prog), createTransferCheckedInstruction(getAssociatedTokenAddressSync(m, me, true, prog), m, dest, me, amount, decimals, [], prog));
      };
      send(t.quoteMint, qInfo.programId, qInfo.decimals, quoteAmount);
      send(t.mint, tInfo.programId, tInfo.decimals, tokenAmount);
      return ixs;
    };
    const unwrapFirst = t.quoteMint === SOL && BigInt(st.claimed.quote) > 0n;
    const devIxs = transfers(new PublicKey(t.creator), q.dev, tk.dev, unwrapFirst);
    if (devIxs.length) await once("dev", async () => new Transaction().add(...devIxs));
    if (opts.platformWallet) {
      const platIxs = transfers(opts.platformWallet, q.platform, tk.platform, false);
      if (platIxs.length) await once("platform", async () => new Transaction().add(...platIxs));
    }
    const rec: FeeRecord = {
      n: st.n, at: new Date().toISOString(), pool: st.pool, quoteMint: t.quoteMint, claimSig: st.claim!.sig, claimed: st.claimed,
      dev: { wallet: t.creator, quote: q.dev.toString(), token: tk.dev.toString(), sigs: st.dev ? [st.dev.sig] : [] },
      platform: { wallet: opts.platformWallet?.toBase58() ?? null, quote: q.platform.toString(), token: tk.platform.toString(), sigs: st.platform ? [st.platform.sig] : [] },
    };
    // a run that died after writing the record but before marking itself finished must not publish the same forwarding twice
    const all = feeRecords(cfg.dataDir, t.mint);
    if (!all.some((r) => r.claimSig === rec.claimSig)) { all.push(rec); fs.writeFileSync(path.join(dir, "fees.json"), JSON.stringify(all, null, 1)); }
    st.finished = true; save();
    const human = (Number(q.dev) / 10 ** qInfo.decimals).toLocaleString("en-US", { maximumFractionDigits: qInfo.decimals });
    log(`${tag} forwarded ${human} ${qInfo.symbol} to the dev ${t.creator} (${rec.dev.sigs.join(", ")})${opts.platformWallet ? `; platform share to ${opts.platformWallet.toBase58()}` : "; platform share stays with the operator"}`);
    forwarded.push(`${t.symbol}: ${human} ${qInfo.symbol} to the dev`);
    } catch (e: any) { const m = String(e?.message ?? e).slice(0, 300); log(`${tag} FAILED: ${m}`); failed.push(`${t.symbol}: ${m}`); }
  }
  return { forwarded, waiting, failed };
}
