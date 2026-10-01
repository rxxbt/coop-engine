/**
 * Registration of a token launched from the public form: the creator signs a manifest (the engine
 * config they chose); we verify the signature, then verify on-chain that the pool exists on one of
 * our platform accounts, was created by the signer, and carries a Token-2022 tax the operator can
 * withdraw. Only then does the token join the engine's registry.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { LAUNCHPAD_PROGRAM, LaunchpadPool, getPdaLaunchpadPoolId } from "@raydium-io/raydium-sdk-v2";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { validateToken, type Sink, type TokenConfig } from "./config.js";
import { mintWithheld } from "./sweep.js";

export type Manifest = {
  version: 1;
  mint: string; symbol: string; decimals: number; quoteMint: string; platformId: string; creator: string;
  launchSig?: string;
  sinks: Sink[]; epochHours: number; exclusions: string[];
  createdAt: string;
};

/** Deterministic JSON (sorted keys, no whitespace). The form signs exactly this string; keep console/src/manifest.ts identical. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonical((v as any)[k])).join(",") + "}";
  return JSON.stringify(v);
}

export type VerifyOptions = { platformIds: string[]; operator: string };

export async function verifyManifest(conn: Connection, m: Manifest, signature: string, opts: VerifyOptions): Promise<TokenConfig> {
  if (!m || m.version !== 1) throw new Error("unsupported manifest version");
  const token: TokenConfig = { mint: m.mint, symbol: m.symbol, quoteMint: m.quoteMint, decimals: m.decimals, exclusions: m.exclusions ?? [], sinks: m.sinks, epochHours: m.epochHours };
  validateToken(token);
  if (typeof m.createdAt !== "string" || Math.abs(Date.now() - Date.parse(m.createdAt)) > 24 * 3_600_000) throw new Error("manifest createdAt must be within 24 h of now");
  if (m.launchSig !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{60,120}$/.test(m.launchSig)) throw new Error("launchSig is not a signature");

  // 0. sink wallets must be wallets: either not created yet or owned by the System Program; a mint, token account or program account would swallow every payout
  for (const s of m.sinks) {
    if (s.type !== "treasury" && s.type !== "creator") continue;
    const info = await conn.getAccountInfo(new PublicKey(s.wallet));
    if (info && !info.owner.equals(SystemProgram.programId)) throw new Error(`${s.type} wallet ${s.wallet} is not a wallet: it is an account owned by ${info.owner.toBase58()}`);
  }
  // 1. the creator signed exactly this manifest
  let creator: PublicKey;
  try { creator = new PublicKey(m.creator); } catch { throw new Error("creator is not a valid address"); }
  let sigBytes: Uint8Array;
  try { sigBytes = bs58.decode(signature); } catch { throw new Error("signature is not base58"); }
  if (!nacl.sign.detached.verify(new TextEncoder().encode(canonical(m)), sigBytes, creator.toBytes())) throw new Error("manifest signature does not verify for the creator");

  // 2. the pool exists, on a COOP platform account, created by the signer, for exactly this mint pair
  const mint = new PublicKey(m.mint), quote = new PublicKey(m.quoteMint);
  const poolId = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mint, quote).publicKey;
  const poolInfo = await conn.getAccountInfo(poolId);
  if (!poolInfo) throw new Error("no LaunchLab pool exists for this mint and quote");
  const pool: any = LaunchpadPool.decode(poolInfo.data);
  if (!pool.creator.equals(creator)) throw new Error(`the pool's creator is ${pool.creator.toBase58()}, not the signer`);
  if (!opts.platformIds.includes(pool.platformId.toBase58())) throw new Error("the pool is not on a COOP platform account");
  if (pool.platformId.toBase58() !== m.platformId) throw new Error("platformId does not match the pool");
  if (!pool.mintA.equals(mint) || !pool.mintB.equals(quote)) throw new Error("pool mints do not match the manifest");
  if (pool.mintDecimalsA !== m.decimals) throw new Error(`decimals must be ${pool.mintDecimalsA}`);

  // 3. Token-2022 with a transfer tax the operator can withdraw (otherwise the engine has nothing to do)
  const mintInfo = await conn.getAccountInfo(mint);
  if (!mintInfo || !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("the mint is not a Token-2022 mint with a transfer tax");
  const fee = await mintWithheld(conn, mint);
  if (fee.feeBps <= 0) throw new Error("the mint has no transfer tax");
  if (fee.withdrawAuthority !== opts.operator) throw new Error(`the tax withdraw authority is ${fee.withdrawAuthority}, not the COOP operator`);

  token.registered = { at: new Date().toISOString(), creator: m.creator, platformId: m.platformId, launchSig: m.launchSig, feeBps: fee.feeBps, manifestSig: signature };
  return token;
}

export function saveToken(dir: string, t: TokenConfig): string {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${t.mint}.json`);
  if (fs.existsSync(f)) throw new Error("this mint is already registered");
  fs.writeFileSync(f, JSON.stringify(t, null, 1));
  return f;
}
