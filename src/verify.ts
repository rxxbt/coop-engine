/** Recompute a published epoch's allocations from its snapshot, rule and lottery seed, and compare with what was recorded. */
import type { EpochRecord } from "./ledger.js";
import { sinksAt, type TokenConfig } from "./config.js";
import { allocate, type Holder } from "./rules.js";

export type VerifyResult = { epoch: number; ok: boolean | null; sinks: { index: number; type: string; ok: boolean | null; reason?: string; recomputed?: number; recorded?: number }[] };

export function verifyEpoch(rec: EpochRecord, token: TokenConfig): VerifyResult {
  if (!rec.snapshot) return { epoch: rec.epoch, ok: null, sinks: [{ index: -1, type: "epoch", ok: null, reason: "no snapshot published for this epoch (before 2026-09-26)" }] };
  const holders: Holder[] = rec.snapshot.holders.map((h) => ({ owner: h.owner, amount: BigInt(h.amount), epochsHeld: h.epochsHeld, everSold: h.everSold, lots: h.lots?.map(([a, s]) => ({ amount: BigInt(a), since: s })) }));
  // holding time is measured up to the snapshot's own time, published with it
  const at = Date.parse(rec.snapshot.at ?? rec.ranAt);
  // the recipe the epoch ran under: its stage is in the record (since 2026-10-05), earlier records ran the launch recipe
  const sinksCfg = sinksAt(token, rec.stage);
  const sinks = (rec.sinks as any[]).map((s, i) => {
    if (s.type !== "reflections") return { index: i, type: s.type, ok: true as boolean | null, reason: "no rule to check" };
    const cfg: any = sinksCfg[i];
    if (!cfg || cfg.type !== "reflections") return { index: i, type: s.type, ok: null, reason: "sink config not found" };
    if (!s.allocations && !s.entries) return { index: i, type: s.type, ok: null, reason: s.kept ? (s.keptWhy === "accruing" ? "jackpot accruing, no draw this epoch" : "nothing to allocate (no eligible holder)") : "no allocations recorded" };
    const recorded = new Map<string, bigint>((s.allocations ?? s.entries).map((e: any) => [e.owner, BigInt(e.amount)]));
    const seed = s.lottery?.blockhash;
    if (cfg.rule.type === "lottery" && !seed) return { index: i, type: s.type, ok: null, reason: "lottery epoch without a published seed" };
    const alloc = allocate(cfg.rule, holders, BigInt(s.pot), { minAmount: s.minAmount ? BigInt(s.minAmount) : cfg.minAmount ? BigInt(cfg.minAmount) : 0n, seed, at, minAgeMs: cfg.minAgeHours ? cfg.minAgeHours * 3_600_000 : undefined });
    let ok = alloc.allocations.size === recorded.size;
    for (const [o, a] of alloc.allocations) if (recorded.get(o) !== a) ok = false;
    return { index: i, type: s.type, ok, recomputed: alloc.allocations.size, recorded: recorded.size, reason: ok ? undefined : "recomputed allocations differ from the record" };
  });
  const checkable = sinks.filter((x) => x.ok !== null);
  return { epoch: rec.epoch, ok: checkable.length ? checkable.every((x) => x.ok) : null, sinks };
}
