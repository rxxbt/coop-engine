/**
 * Staged recipes (since 2026-10-05): a token's sinks can change when a condition is met: at graduation, once the snapshot counts N holders,
 * or once the market cap reaches a dollar amount. Stages are checked in order at the start of every epoch and never go back; the stage a
 * token is in is kept in data/<mint>/stage.json and written into every epoch record, with the facts the check saw, so anyone can recompute
 * which recipe an epoch ran under. Pure functions here; the chain reads are in src/epoch.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { sinkPayoutMint, type Sink, type StageWhen, type TokenConfig } from "./config.js";

/** What a stage check sees: whether the LaunchLab pool has migrated, the last published snapshot's holder count, the market cap now. */
export type StageFacts = { graduated: boolean; holders: number | null; mcapUsd: number | null };
export type StageState = { stage: number; reachedAt: string; facts: StageFacts };

export function met(when: StageWhen, f: StageFacts): boolean {
  if (when.type === "graduation") return f.graduated;
  if (when.type === "holders") return f.holders !== null && f.holders >= when.count;
  return f.mcapUsd !== null && f.mcapUsd >= when.usd;
}
/** The stage after this check: every next stage whose condition holds is entered, in order; a stage once reached is never left. */
export function nextStage(current: number, stages: TokenConfig["stages"], f: StageFacts): number {
  let s = Math.max(0, current);
  while (stages && s < stages.length && met(stages[s].when, f)) s++;
  return s;
}
export function whenText(when: StageWhen): string {
  if (when.type === "graduation") return "at graduation";
  if (when.type === "holders") return `once ${when.count.toLocaleString("en-US")} wallets hold the token`;
  return `once the market cap reaches $${when.usd.toLocaleString("en-US")}`;
}

export function readStage(dir: string): StageState | null { try { return JSON.parse(fs.readFileSync(path.join(dir, "stage.json"), "utf8")); } catch { return null; } }
export function writeStage(dir: string, s: StageState) { const f = path.join(dir, "stage.json"); fs.writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 1)); fs.renameSync(`${f}.tmp`, f); }

type Carry = Record<string, string>;
/**
 * The carry file after a stage change. Its keys name sinks by index (`_pot:i` = a holder sink's unallocated payout-asset remainder,
 * `_sink:i` = SOL a treasury/creator sink could not deliver), and the indices mean something else in the new recipe. A pot moves to the
 * first new holder sink that pays the same asset, or waits under `_parked:<mint>` until one exists; deferred SOL goes back to its wallet's
 * own key, which any sink for that wallet picks up. Per-wallet carries (plain owner keys, `owner@mint`) are untouched.
 */
export function rekeyCarry(carry: Carry, oldSinks: Sink[], newSinks: Sink[], token: { mint: string; quoteMint: string }): Carry {
  const out: Carry = {};
  const add = (k: string, v: bigint) => { if (v > 0n) out[k] = (BigInt(out[k] ?? "0") + v).toString(); };
  const holderSinkFor = (mint: string) => newSinks.findIndex((s) => s.type === "reflections" && sinkPayoutMint(s, token) === mint);
  for (const [k, v] of Object.entries(carry)) {
    const n = BigInt(v || "0");
    const pot = k.match(/^_pot:(\d+)$/), sink = k.match(/^_sink:(\d+)$/), parked = k.match(/^_parked:(.+)$/);
    if (pot) {
      const old = oldSinks[Number(pot[1])];
      const mint = old && old.type === "reflections" ? sinkPayoutMint(old, token) : null;
      if (!mint) { add(k, n); continue; } // a key the old recipe does not explain: left as it is
      const j = holderSinkFor(mint);
      add(j >= 0 ? `_pot:${j}` : `_parked:${mint}`, n);
    } else if (sink) {
      const old = oldSinks[Number(sink[1])];
      if (old && (old.type === "treasury" || old.type === "creator")) add(old.wallet, n); else add(k, n);
    } else if (parked) {
      const j = holderSinkFor(parked[1]);
      add(j >= 0 ? `_pot:${j}` : k, n);
    } else add(k, n);
  }
  return out;
}
/** A parked pot (from a stage change) joins the first holder sink that pays its asset, as soon as one exists. */
export function absorbParked(carry: Carry, sinks: Sink[], token: { mint: string; quoteMint: string }): Carry {
  return rekeyCarry(carry, sinks, sinks, token);
}
