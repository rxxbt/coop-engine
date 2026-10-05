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
  /** `winners` equal prizes, each drawn by balance weight (one wallet can win several), deterministic seed. `every` (since 2026-10-05): draw
   *  every N epochs; between draws the pot accrues with the sink (a jackpot). Absent or 1 = every epoch. */
  | { type: "lottery"; winners: number; every?: number };

/**
 * Every sink can pay in any asset Jupiter routes (2026-09-28):
 *  - reflections: `payoutMint` = the quote, any mint, or "same" (the token itself, no swap);
 *  - burn: `asset` absent or "same" burns the token itself; a mint address = buy that asset with the tax and burn it (buyback-and-burn);
 *  - treasury / creator: `asset` "quote" (default; converted first so the token's own tax is paid once, not twice), "token" (send the
 *    token itself), or a mint address = convert to that asset and send it.
 * A reflections sink's `minAgeHours` (since 2026-10-05): tokens count only once they have sat in the wallet that long (per lot, so a
 * sniper who flips inside the window is paid nothing and splitting wallets gains nothing); absent or 0 = at once.
 */
export type Sink =
  | { type: "reflections"; share: number; payoutMint: string | "same"; rule: Rule; minAmount?: string; minUsd?: number; minAgeHours?: number; distribution: "push" | "claim" }
  | { type: "burn"; share: number; asset?: string }
  | { type: "treasury"; share: number; wallet: string; asset?: string }
  | { type: "creator"; share: number; wallet: string; asset?: string };

/** When a later stage of the recipe starts (since 2026-10-05): at graduation, once the snapshot counts that many holders, or once the
 *  token's market cap (price × supply, in dollars) reaches the amount. Stages are checked in order and never go back. */
export type StageWhen = { type: "graduation" } | { type: "holders"; count: number } | { type: "mcap"; usd: number };
export type Stage = { when: StageWhen; sinks: Sink[] };

export type TokenConfig = {
  mint: string;
  symbol: string;
  quoteMint: string;
  decimals: number;
  exclusions: string[];     // owners never paid: pool vaults, lockers, treasury, dev buy…
  sinks: Sink[];            // shares must sum to 1; the recipe of stage 0
  epochHours: number;
  /** Later recipes (since 2026-10-05): stage k = `stages[k-1]`, reached when its condition holds after every earlier stage was reached. */
  stages?: Stage[];
  /** Buy-tax refund (since 2026-10-05): the tax withheld on transfers out of the pool's vaults (buys) is paid back every epoch, grossed up
   *  for the refund's own tax: `holders` = only to buyers still holding everything they bought in the window at the snapshot; `all` = to
   *  every buyer. The refunds come off the top, before the sinks split the rest. */
  refund?: { mode: "holders" | "all" };
  /** The launch locked `share` of the supply for the creator through LaunchLab's vesting (cliff, then a linear unlock, both after graduation).
   *  `earns` = the locked, unclaimed tokens count as held by the creator in every snapshot (since 2026-10-05). */
  vesting?: { share: number; cliffDays: number; unlockDays: number; earns: boolean };
  /** The share fee (basis points, 0–100) the token page puts on curve trades for whoever brought the buyer, paid by Raydium's program on
   *  top of the curve fee. The engine only publishes it (since 2026-10-05). */
  referralBps?: number;
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
/** A recipe can change up to three times: at graduation, and at two milestones. */
export const MAX_STAGES = 3;
/** The longest a holder sink can ask tokens to sit before they count, and the longest a jackpot can accrue, in hours and epochs. */
export const MAX_MIN_AGE_HOURS = 168, MAX_LOTTERY_EVERY = 168;
/** The most of the supply a launch may lock for the creator: LaunchLab's own cap on the SOL pair (the pair's config decides; the form reads it). */
export const MAX_VESTING_SHARE = 0.8;
/** LaunchLab's cap on the share fee: 10,000 millionths = 1% = 100 bps. */
export const MAX_REFERRAL_BPS = 100;
export const RULE_TYPES = ["pro-rata", "time-weighted", "never-sold-bonus", "lottery"] as const;
export const SINK_TYPES = ["reflections", "burn", "treasury", "creator"] as const;

export const isKey = (s: unknown) => { try { new PublicKey(String(s)); return typeof s === "string"; } catch { return false; } };
/** The mint a sink pays in: the quote, the token itself, or the asset the dev picked. */
export function sinkPayoutMint(s: Sink, token: { mint: string; quoteMint: string }): string {
  if (s.type === "reflections") return s.payoutMint === "same" ? token.mint : s.payoutMint;
  if (s.type === "burn") return !s.asset || s.asset === "same" ? token.mint : s.asset;
  return !s.asset || s.asset === "quote" ? token.quoteMint : s.asset === "token" ? token.mint : s.asset;
}
/** The sinks of a token's stage: 0 = the launch recipe, k = `stages[k-1]`. A stage beyond the list falls back to the last one. */
export function sinksAt(t: Pick<TokenConfig, "sinks" | "stages">, stage: number | undefined): Sink[] {
  if (!stage || stage <= 0 || !t.stages?.length) return t.sinks;
  return (t.stages[Math.min(stage, t.stages.length) - 1] ?? t.stages[t.stages.length - 1]).sinks;
}
const isInt = (n: unknown, lo: number, hi: number) => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;
const inRange = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo - 1e-9 && v <= hi + 1e-9;

/** One recipe: 1–MAX_SINKS sinks whose shares sum to 1, every field in range. */
export function validateSinks(who: string, sinks: unknown): void {
  if (!Array.isArray(sinks) || sinks.length === 0 || sinks.length > MAX_SINKS) throw new Error(`${who}: 1–${MAX_SINKS} sinks required`);
  const sum = sinks.reduce((a, s) => a + (typeof s?.share === "number" ? s.share : NaN), 0);
  if (!(Math.abs(sum - 1) <= 1e-9)) throw new Error(`${who}: sink shares sum to ${sum}, expected 1`);
  for (const s of sinks as Sink[]) {
    if (!SINK_TYPES.includes(s.type)) throw new Error(`${who}: unknown sink type ${String((s as any)?.type)}`);
    if (!(s.share > 0 && s.share <= 1)) throw new Error(`${who}: every sink share must be in (0, 1]`);
    if (s.type === "reflections") {
      if (s.payoutMint !== "same" && !isKey(s.payoutMint)) throw new Error(`${who}: payoutMint must be "same" or a valid mint`);
      if (s.minUsd !== undefined && !(typeof s.minUsd === "number" && Number.isFinite(s.minUsd) && s.minUsd >= 0 && s.minUsd <= 1e6)) throw new Error(`${who}: minUsd must be a number between 0 and 1,000,000`);
      if (s.minAgeHours !== undefined && !isInt(s.minAgeHours, 0, MAX_MIN_AGE_HOURS)) throw new Error(`${who}: minAgeHours must be a whole number of hours, 0–${MAX_MIN_AGE_HOURS}`);
      if (s.distribution !== "push" && s.distribution !== "claim") throw new Error(`${who}: distribution must be push or claim`);
      if (s.minAmount !== undefined && !(typeof s.minAmount === "string" && /^\d{1,30}$/.test(s.minAmount))) throw new Error(`${who}: minAmount must be a base-unit integer string`);
      const r = s.rule;
      if (!r || !RULE_TYPES.includes(r.type)) throw new Error(`${who}: unknown rule ${String((r as any)?.type)}`);
      if (r.type === "time-weighted") {
        if ("intervalHours" in r) {
          if (![6, 12, 24].includes(r.intervalHours)) throw new Error(`${who}: time-weighted intervalHours must be 6, 12 or 24`);
          if (!inRange(r.step, 0.01, 1)) throw new Error(`${who}: time-weighted step must be between 0.01 and 1`);
          if (!inRange(r.cap, 1.1, 10)) throw new Error(`${who}: time-weighted cap must be between 1.1 and 10`);
        } else if (!isInt(r.maxEpochs, 1, 1000)) throw new Error(`${who}: time-weighted maxEpochs must be an integer 1–1000`);
      }
      if (r.type === "never-sold-bonus" && !(typeof r.bonusShare === "number" && r.bonusShare >= 0 && r.bonusShare <= 1)) throw new Error("bonusShare must be 0..1");
      if (r.type === "lottery") {
        if (!isInt(r.winners, 1, 1000)) throw new Error(`${who}: lottery winners must be an integer 1–1000`);
        if (r.every !== undefined && !isInt(r.every, 1, MAX_LOTTERY_EVERY)) throw new Error(`${who}: lottery every must be a whole number of epochs, 1–${MAX_LOTTERY_EVERY}`);
      }
    }
    if (s.type === "burn" && s.asset !== undefined && s.asset !== "same" && !isKey(s.asset)) throw new Error(`${who}: burn asset must be "same" or a valid mint`);
    if (s.type === "treasury" || s.type === "creator") {
      if (!isKey(s.wallet)) throw new Error(`${who}: ${s.type} wallet is not a valid address`);
      if (s.asset !== undefined && s.asset !== "quote" && s.asset !== "token" && !isKey(s.asset)) throw new Error(`${who}: ${s.type} asset must be quote, token or a valid mint`);
    }
  }
}

/** Throws a plain-English reason. Used by the engine at load time and by the API before it registers a token. Treats the input as untrusted. */
export function validateToken(t: TokenConfig): void {
  const who = typeof t?.symbol === "string" ? t.symbol : "token";
  if (!isKey(t?.mint)) throw new Error(`${who}: mint is not a valid address`);
  if (!isKey(t.quoteMint)) throw new Error(`${who}: quoteMint is not a valid address`);
  if (typeof t.symbol !== "string" || !/^[A-Za-z0-9._-]{1,16}$/.test(t.symbol)) throw new Error("symbol must be 1–16 letters, digits, dots, underscores or dashes");
  if (!isInt(t.decimals, 0, 12)) throw new Error(`${who}: decimals must be an integer 0–12`);
  if (!isInt(t.epochHours, 1, 168)) throw new Error(`${who}: epochHours must be an integer 1–168`);
  if (!Array.isArray(t.exclusions) || t.exclusions.length > 50 || t.exclusions.some((x) => !isKey(x))) throw new Error(`${who}: exclusions must be up to 50 valid addresses`);
  validateSinks(who, t.sinks);
  if (t.stages !== undefined) {
    if (!Array.isArray(t.stages) || t.stages.length > MAX_STAGES) throw new Error(`${who}: up to ${MAX_STAGES} stages`);
    t.stages.forEach((st, k) => {
      const w = st?.when as StageWhen;
      if (!w || !["graduation", "holders", "mcap"].includes(w.type)) throw new Error(`${who}: stage ${k + 1} needs a condition: graduation, holders or mcap`);
      if (w.type === "holders" && !isInt(w.count, 2, 1_000_000)) throw new Error(`${who}: stage ${k + 1}: holders count must be a whole number, 2–1,000,000`);
      if (w.type === "mcap" && !inRange(w.usd, 1000, 1e9)) throw new Error(`${who}: stage ${k + 1}: market cap must be between $1,000 and $1,000,000,000`);
      validateSinks(`${who} stage ${k + 1}`, st.sinks);
    });
  }
  if (t.refund !== undefined && !(t.refund && (t.refund.mode === "holders" || t.refund.mode === "all"))) throw new Error(`${who}: refund mode must be holders or all`);
  if (t.vesting !== undefined) {
    const v = t.vesting;
    if (!v || !inRange(v.share, 0.0001, MAX_VESTING_SHARE)) throw new Error(`${who}: vesting share must be between 0.01% and ${MAX_VESTING_SHARE * 100}% of the supply`);
    if (!inRange(v.cliffDays, 0, 365) || !inRange(v.unlockDays, 0, 730)) throw new Error(`${who}: vesting cliff 0–365 days, unlock period 0–730 days`);
    if (typeof v.earns !== "boolean") throw new Error(`${who}: vesting earns must be true or false`);
  }
  if (t.referralBps !== undefined && !isInt(t.referralBps, 0, MAX_REFERRAL_BPS)) throw new Error(`${who}: referralBps must be a whole number, 0–${MAX_REFERRAL_BPS}`);
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
