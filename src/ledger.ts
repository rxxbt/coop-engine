/** Append-only JSON ledger per token: holder history (for time-weighted / never-sold rules) and one file per epoch. */
import fs from "node:fs";
import path from "node:path";
import type { Holder } from "./rules.js";

/** A wallet's balance split by age, oldest first. `since` = the time (ms) of the snapshot that first saw these tokens. */
export type StoredLot = { amount: string; since: number };
export type HolderHistory = Record<string, { epochsHeld: number; everSold: boolean; lastAmount: string; lots?: StoredLot[] }>;
/** A published snapshot row; `lots` as [amount, since ms] pairs, present since 2026-09-29. `vested` (since 2026-10-05): the part of `amount`
 *  that is the creator's locked, unclaimed vesting allocation, counted as held because the token's recipe says so. */
export type SnapshotRow = { owner: string; amount: string; epochsHeld: number; everSold: boolean; lots?: [string, number][]; vested?: string };
export type EpochRecord = {
  epoch: number; ranAt: string; dryRun: boolean; mint: string;
  /** Since 2026-10-05: the recipe stage this epoch ran under (0 = the launch recipe) and what the stage check saw; absent = stage 0. */
  stage?: number; stageFacts?: { graduated: boolean; holders: number | null; mcapUsd: number | null };
  /** Since 2026-10-05: the buy-tax refunds of this epoch (src/refunds.ts), taken off the top before the sinks. */
  refunds?: import("./refunds.js").RefundRecord;
  /** `withdrawn` = swept out of the mint by this epoch; `carried` = held by the operator from earlier epochs; `available` = both, what the sinks split.
   *  Records written before 2026-09-29 have neither `carried` nor `available`, and their `withdrawn` is the operator's whole balance. */
  tax: { withheldBefore: string; harvested: number; withdrawn: string; carried?: string; available?: string };
  sinks: unknown[];
  /** Since 2026-09-29: one swap per payout asset per epoch. `sinks` = the sinks that shared it, `amount` = what went in (the token's base
   *  units), `converted` = what it delivered, split between those sinks by pot; `kept` = Jupiter had no route. Absent on older records,
   *  where every sink did its own swap and its signatures are among the sink's own. */
  conversions?: { mint: string; sinks: number[]; amount: string; path?: "direct" | "via-sol"; via?: { mint: string; converted: string }; converted?: string; kept?: string; sigs: string[] }[];
  signatures: string[];
  /** `at` = the snapshot's time: holding time is measured up to it (present since 2026-09-29). */
  snapshot?: { slot: number; at?: string; holders: SnapshotRow[] };
};

const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
/** A wallet that buys at every snapshot would grow a lot per epoch; beyond this the two oldest merge and take the younger age (never the older: no gift). */
const MAX_LOTS = 48;

export class Ledger {
  constructor(private dir: string, private mint: string) { fs.mkdirSync(this.tokenDir, { recursive: true }); }
  get tokenDir() { return path.join(this.dir, this.mint); }
  private historyPath() { return path.join(this.tokenDir, "holders.json"); }
  readHistory(): HolderHistory { try { return JSON.parse(fs.readFileSync(this.historyPath(), "utf8")); } catch { return {}; } }
  lastEpoch(): number {
    const files = fs.existsSync(this.tokenDir) ? fs.readdirSync(this.tokenDir).filter((f) => /^epoch-\d+\.json$/.test(f)) : [];
    return files.reduce((m, f) => Math.max(m, Number(f.match(/\d+/)![0])), 0);
  }
  /** When the last finished epoch ran (from its ledger file), or null before the first one. */
  lastEpochRanAt(): Date | null {
    const n = this.lastEpoch();
    if (!n) return null;
    try { return new Date((JSON.parse(fs.readFileSync(path.join(this.tokenDir, `epoch-${n}.json`), "utf8")) as EpochRecord).ranAt); } catch { return null; }
  }
  /** The last finished epoch's record, or undefined before the first one (or if its file cannot be read). */
  lastRecord(): EpochRecord | undefined {
    const n = this.lastEpoch();
    if (!n) return undefined;
    try { return JSON.parse(fs.readFileSync(path.join(this.tokenDir, `epoch-${n}.json`), "utf8")) as EpochRecord; } catch { return undefined; }
  }
  /** Epoch number of a crashed execute run waiting to be resumed, or null. */
  unfinishedEpoch(): number | null {
    const files = fs.existsSync(this.tokenDir) ? fs.readdirSync(this.tokenDir).filter((f) => /^epoch-\d+\.state\.json$/.test(f)) : [];
    for (const f of files) { try { const st = JSON.parse(fs.readFileSync(path.join(this.tokenDir, f), "utf8")); if (!st.finished) return Number(st.epoch); } catch { /* ignore */ } }
    return null;
  }
  /** Finished epochs, oldest first, as written to the ledger (dry runs excluded). */
  epochs(): EpochRecord[] {
    const files = fs.existsSync(this.tokenDir) ? fs.readdirSync(this.tokenDir).filter((f) => /^epoch-\d+\.json$/.test(f)) : [];
    return files.map((f) => JSON.parse(fs.readFileSync(path.join(this.tokenDir, f), "utf8")) as EpochRecord).sort((a, b) => a.epoch - b.epoch);
  }
  /**
   * Fold a fresh snapshot into history and return Holder rows with epochsHeld / everSold / lots filled in. `at` = the snapshot's time (ms).
   *
   * Lots (2026-09-29): tokens age, wallets do not.
   *  - balance unchanged: every lot keeps ageing;
   *  - balance grew: the old lots keep ageing, the added tokens open a new lot that starts at `at`;
   *  - balance dropped by any amount: the wallet sold, and everything it still holds starts again at `at`;
   *  - wallet gone from the snapshot: no lots; if it returns it starts fresh.
   * A history written before lots existed starts every wallet fresh at the first snapshot after the change.
   */
  applySnapshot(balances: Map<string, bigint>, persist: boolean, at: number = Date.now()): Holder[] {
    const hist = this.readHistory();
    const holders: Holder[] = [];
    for (const [owner, amount] of balances) {
      const prev = hist[owner];
      const everSold = (prev?.everSold ?? false) || (prev ? amount < BigInt(prev.lastAmount) : false);
      const epochsHeld = prev ? prev.epochsHeld + 1 : 0;
      const known = prev?.lots?.length ? prev.lots : null;
      const knownTotal = known ? known.reduce((a, l) => a + BigInt(l.amount), 0n) : 0n;
      let lots: StoredLot[];
      if (!known || amount < knownTotal) lots = [{ amount: amount.toString(), since: at }];
      else if (amount > knownTotal) lots = [...known, { amount: (amount - knownTotal).toString(), since: at }];
      else lots = known;
      while (lots.length > MAX_LOTS) lots = [{ amount: (BigInt(lots[0].amount) + BigInt(lots[1].amount)).toString(), since: Math.max(lots[0].since, lots[1].since) }, ...lots.slice(2)];
      holders.push({ owner, amount, epochsHeld, everSold, lots: lots.map((l) => ({ amount: BigInt(l.amount), since: l.since })) });
      hist[owner] = { epochsHeld, everSold, lastAmount: amount.toString(), lots };
    }
    for (const owner of Object.keys(hist)) if (!balances.has(owner)) { hist[owner].everSold = true; hist[owner].epochsHeld = 0; hist[owner].lastAmount = "0"; hist[owner].lots = []; }
    if (persist) fs.writeFileSync(this.historyPath(), JSON.stringify(hist, null, 1));
    return holders;
  }
  writeEpoch(rec: EpochRecord) {
    const f = path.join(this.tokenDir, `epoch-${rec.epoch}${rec.dryRun ? "-dry" : ""}.json`);
    fs.writeFileSync(f, JSON.stringify(rec, replacer, 1));
    return f;
  }
}
