import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

export type Rule =
  | { type: "pro-rata" }
  | { type: "time-weighted"; maxEpochs: number }          // LEGACY (registered before 2026-09-29): weight = amount × min(epochsHeld + 1, maxEpochs), per wallet
  /** Tokens age: every lot's multiplier = min(1 + step × full holding intervals, cap). Selling anything resets the wallet; tokens bought later
   *  start at 1×. The holding interval is independent of the payout epoch. */
  | { type: "time-weighted"; intervalHours: number; step: number; cap: number }
  | { type: "never-sold-bonus"; bonusShare: number }      // bonusShare of the pot goes only to wallets that never reduced their balance
  | { type: "lottery"; winners: number };                 // `winners` wallets drawn by balance weight, deterministic seed

/**
 * Every sink can pay in any asset Jupiter routes (2026-09-28):
 *  - reflections: `payoutMint` = the quote, any mint, or "same" (the token itself, no swap);
 *  - burn: `asset` absent or "same" burns the token itself; a mint address = buy that asset with the tax and burn it (buyback-and-burn);
 *  - treasury / creator: `asset` "quote" (default; converted first so the token's own tax is paid once, not twice), "token" (send the
 *    token itself), or a mint address = convert to that asset and send it.
 */
export type Sink =
  | { type: "reflections"; share: number; payoutMint: string | "same"; rule: Rule; minAmount?: string; minUsd?: number; distribution: "push" | "claim" }
  | { type: "burn"; share: number; asset?: string }
  | { type: "treasury"; share: number; wallet: string; asset?: string }
  | { type: "creator"; share: number; wallet: string; asset?: string };

export type TokenConfig = {
  mint: string;
  symbol: string;
  quoteMint: string;
  decimals: number;
  exclusions: string[];     // owners never paid: pool vaults, lockers, treasury, dev buy…
  sinks: Sink[];            // shares must sum to 1
  epochHours: number;
  /** Test tokens: kept out of the public list (still reachable by address) and badged on their page. */
  hidden?: boolean;
  /** Filled by the registry when a token is registered from the public launch form. */
  registered?: { at: string; creator: string; platformId: string; launchSig?: string; feeBps: number; manifestSig?: string };
};

export type EngineConfig = {
  rpc: string;
  heliusRpc?: string;
  dataDir: string;
  registryDir?: string;     // one <mint>.json per token registered from the launch form (default "registry")
  slippageBps: number;
  tokens: TokenConfig[];
};

/** One of each main option is already seven sinks (creator, treasury, burn, and holders under each of the four rules); ten leaves room for
 *  variations in the payout asset. Was 6 until 2026-09-29. Widening never rejects an existing registry file. */
export const MAX_SINKS = 10;
export const RULE_TYPES = ["pro-rata", "time-weighted", "never-sold-bonus", "lottery"] as const;
export const SINK_TYPES = ["reflections", "burn", "treasury", "creator"] as const;

export const isKey = (s: unknown) => { try { new PublicKey(String(s)); return typeof s === "string"; } catch { return false; } };
/** The mint a sink pays in: the quote, the token itself, or the asset the dev picked. */
export function sinkPayoutMint(s: Sink, token: { mint: string; quoteMint: string }): string {
  if (s.type === "reflections") return s.payoutMint === "same" ? token.mint : s.payoutMint;
  if (s.type === "burn") return !s.asset || s.asset === "same" ? token.mint : s.asset;
  return !s.asset || s.asset === "quote" ? token.quoteMint : s.asset === "token" ? token.mint : s.asset;
}
const isInt = (n: unknown, lo: number, hi: number) => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;

/** Throws a plain-English reason. Used by the engine at load time and by the API before it registers a token. Treats the input as untrusted. */
export function validateToken(t: TokenConfig): void {
  const who = typeof t?.symbol === "string" ? t.symbol : "token";
  if (!isKey(t?.mint)) throw new Error(`${who}: mint is not a valid address`);
  if (!isKey(t.quoteMint)) throw new Error(`${who}: quoteMint is not a valid address`);
  if (typeof t.symbol !== "string" || !/^[A-Za-z0-9._-]{1,16}$/.test(t.symbol)) throw new Error("symbol must be 1–16 letters, digits, dots, underscores or dashes");
  if (!isInt(t.decimals, 0, 12)) throw new Error(`${who}: decimals must be an integer 0–12`);
  if (!isInt(t.epochHours, 1, 168)) throw new Error(`${who}: epochHours must be an integer 1–168`);
  if (!Array.isArray(t.exclusions) || t.exclusions.length > 50 || t.exclusions.some((x) => !isKey(x))) throw new Error(`${who}: exclusions must be up to 50 valid addresses`);
  if (!Array.isArray(t.sinks) || t.sinks.length === 0 || t.sinks.length > MAX_SINKS) throw new Error(`${who}: 1–${MAX_SINKS} sinks required`);
  const sum = t.sinks.reduce((a, s) => a + (typeof s?.share === "number" ? s.share : NaN), 0);
  if (!(Math.abs(sum - 1) <= 1e-9)) throw new Error(`${who}: sink shares sum to ${sum}, expected 1`);
  for (const s of t.sinks) {
    if (!SINK_TYPES.includes(s.type)) throw new Error(`${who}: unknown sink type ${String((s as any)?.type)}`);
    if (!(s.share > 0 && s.share <= 1)) throw new Error(`${who}: every sink share must be in (0, 1]`);
    if (s.type === "reflections") {
      if (s.payoutMint !== "same" && !isKey(s.payoutMint)) throw new Error(`${who}: payoutMint must be "same" or a valid mint`);
      if (s.minUsd !== undefined && !(typeof s.minUsd === "number" && Number.isFinite(s.minUsd) && s.minUsd >= 0 && s.minUsd <= 1e6)) throw new Error(`${who}: minUsd must be a number between 0 and 1,000,000`);
      if (s.distribution !== "push" && s.distribution !== "claim") throw new Error(`${who}: distribution must be push or claim`);
      if (s.minAmount !== undefined && !(typeof s.minAmount === "string" && /^\d{1,30}$/.test(s.minAmount))) throw new Error(`${who}: minAmount must be a base-unit integer string`);
      const r = s.rule;
      if (!r || !RULE_TYPES.includes(r.type)) throw new Error(`${who}: unknown rule ${String((r as any)?.type)}`);
      if (r.type === "time-weighted") {
        if ("intervalHours" in r) {
          const inRange = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo - 1e-9 && v <= hi + 1e-9;
          if (![6, 12, 24].includes(r.intervalHours)) throw new Error(`${who}: time-weighted intervalHours must be 6, 12 or 24`);
          if (!inRange(r.step, 0.01, 1)) throw new Error(`${who}: time-weighted step must be between 0.01 and 1`);
          if (!inRange(r.cap, 1.1, 10)) throw new Error(`${who}: time-weighted cap must be between 1.1 and 10`);
        } else if (!isInt(r.maxEpochs, 1, 1000)) throw new Error(`${who}: time-weighted maxEpochs must be an integer 1–1000`);
      }
      if (r.type === "never-sold-bonus" && !(typeof r.bonusShare === "number" && r.bonusShare >= 0 && r.bonusShare <= 1)) throw new Error("bonusShare must be 0..1");
      if (r.type === "lottery" && !isInt(r.winners, 1, 1000)) throw new Error(`${who}: lottery winners must be an integer 1–1000`);
    }
    if (s.type === "burn" && s.asset !== undefined && s.asset !== "same" && !isKey(s.asset)) throw new Error(`${who}: burn asset must be "same" or a valid mint`);
    if (s.type === "treasury" || s.type === "creator") {
      if (!isKey(s.wallet)) throw new Error(`${who}: ${s.type} wallet is not a valid address`);
      if (s.asset !== undefined && s.asset !== "quote" && s.asset !== "token" && !isKey(s.asset)) throw new Error(`${who}: ${s.type} asset must be quote, token or a valid mint`);
    }
  }
}

export function registryDir(cfg: EngineConfig): string { return cfg.registryDir ?? "registry"; }

/** Tokens registered from the launch form: one JSON file per mint, validated on load. */
export function loadRegistry(dir: string): TokenConfig[] {
  if (!fs.existsSync(dir)) return [];
  // one broken or outdated registry file must never take the whole engine down (a new validation rule
  // must not be able to reject files written under older rules); it is logged and skipped instead
  const out: TokenConfig[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try { const t = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as TokenConfig; validateToken(t); out.push(t); }
    catch (e) { console.error(`registry: skipping ${f}: ${(e as Error).message}`); }
  }
  return out;
}

export function loadConfig(file: string): EngineConfig {
  const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as EngineConfig;
  cfg.rpc = process.env.RPC_URL || cfg.rpc;
  cfg.heliusRpc = process.env.HELIUS_RPC || cfg.heliusRpc;
  for (const t of cfg.tokens) validateToken(t); // the hand-written engine.config.json must be right; a registry file may not be
  for (const t of loadRegistry(registryDir(cfg))) if (!cfg.tokens.some((x) => x.mint === t.mint)) cfg.tokens.push(t);
  return cfg;
}
