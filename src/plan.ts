/**
 * The conversion plan of one epoch: the sinks that need the tax converted, grouped by the asset they pay in, so every asset is bought
 * with ONE swap per epoch and what that swap delivers is split between the sinks that share it. Until 2026-09-29 every sink did its own
 * swap: a token with four holder sinks paying in SOL sold its tax four times an hour, each time a quarter of the pot, and the smaller a
 * slice, the sooner it falls below what Jupiter routes. Pure functions: no chain access, no side effects.
 */
import { sinkPayoutMint, type TokenConfig } from "./config.js";

export type ConversionPlan = { mint: string; sinks: number[]; amount: bigint };

/** The sinks that convert, grouped by payout asset, in the order the assets first appear among the sinks.
 *  `pots` = every sink's pot in the token's base units; `skip` = sinks that convert nothing this epoch (already finished, or a holder
 *  sink with no eligible holder). A sink that pays in the token itself needs no swap and is in no group. */
export function planConversions(token: Pick<TokenConfig, "mint" | "quoteMint" | "sinks">, pots: bigint[], skip: Set<number> = new Set()): ConversionPlan[] {
  const byMint = new Map<string, ConversionPlan>();
  token.sinks.forEach((s, i) => {
    const out = sinkPayoutMint(s, token);
    if (out === token.mint || skip.has(i) || !((pots[i] ?? 0n) > 0n)) return;
    const g = byMint.get(out) ?? { mint: out, sinks: [], amount: 0n };
    g.sinks.push(i); g.amount += pots[i];
    byMint.set(out, g);
  });
  return [...byMint.values()];
}

/** Split what a swap delivered between the sinks that paid for it, in proportion to their pots. Whole base units only; the few units
 *  lost to rounding go to the largest pot (the first one on a tie), so the parts always add up to exactly what was delivered. */
export function splitDelivered(delivered: bigint, pots: bigint[]): bigint[] {
  const total = pots.reduce((a, b) => a + b, 0n);
  if (total <= 0n || delivered <= 0n) return pots.map(() => 0n);
  const parts = pots.map((p) => (delivered * p) / total);
  let top = 0;
  pots.forEach((p, i) => { if (p > pots[top]) top = i; });
  parts[top] += delivered - parts.reduce((a, b) => a + b, 0n);
  return parts;
}

/** A share of an amount, in whole base units (shares are kept to six decimals, as everywhere in the engine). */
export function shareOf(total: bigint, share: number): bigint { return (total * BigInt(Math.round(share * 1_000_000))) / 1_000_000n; }

/** What every sink kept in the last finished epoch, in the token's base units: a pot Jupiter had no route for, or a holder sink's pot
 *  with nobody eligible. Read from that epoch's ledger record, so anyone can recompute the next epoch's pots from what was published. */
export function keptBySink(last: { sinks: unknown[] } | undefined, sinks: number): bigint[] {
  return Array.from({ length: sinks }, (_, i) => {
    const k = (last?.sinks?.[i] as { kept?: unknown } | undefined)?.kept;
    try { return k === undefined || k === null || k === "" ? 0n : BigInt(k as string); } catch { return 0n; }
  });
}

/**
 * Every sink's pot for this epoch: its share of the tax swept since the last epoch, plus whatever that same sink kept then.
 * A kept pot stays with its own sink (design rule since 2026-09-29: no sink spends another sink's money). Until then the
 * operator's whole balance was split by the shares again every epoch, so with creator 50% / holders 50% and nobody eligible, half of
 * the holders' kept pot went to the creator an epoch later.
 * `available` = everything the operator holds after the sweep. Should the kept amounts ever exceed it, they are scaled down to fit.
 */
export function formPots(available: bigint, shares: number[], kept: bigint[]): { pot: bigint; keptIn: bigint }[] {
  let mine = shares.map((_, i) => (kept[i] ?? 0n) > 0n ? kept[i] : 0n);
  let earmarked = mine.reduce((a, b) => a + b, 0n);
  if (earmarked > available) { mine = mine.map((k) => (k * available) / earmarked); earmarked = mine.reduce((a, b) => a + b, 0n); }
  const fresh = available - earmarked;
  return shares.map((s, i) => ({ pot: shareOf(fresh, s) + mine[i], keptIn: mine[i] }));
}

/** Jupiter has no route, not even through SOL (dust, or a payout asset with no market yet). Not a failure: the pots stay with the operator
 *  and roll into the next epoch. */
export class NoRouteError extends Error {}

/** What a conversion persists, so a crashed run resumes at the swap it died on. `path` = one direct Jupiter swap, or two swaps through SOL
 *  when Jupiter finds no direct route; decided once per epoch. `noRoute` = not even through SOL. */
export type ConversionProgress = { swapSig?: string; converted?: string; path?: "direct" | "via-sol"; via?: { swapSig?: string; converted?: string; mint: string }; sigs: string[]; noRoute?: boolean };
/** One swap per payout asset per epoch: `sinks` = the sinks that pay in `mint` and share the swap, `amount` = their pots together, in the
 *  token's base units. */
export type ConversionState = ConversionProgress & { mint: string; sinks: number[]; amount: string };
type SinkProgress = { done: boolean; pot: string; converted?: string; swapSig?: string; path?: string; via?: unknown };

export type ConversionRun = {
  token: Pick<TokenConfig, "mint" | "quoteMint" | "sinks" | "symbol">;
  /** The epoch's state: read and written in place, saved through `save`. */
  state: { sinks: SinkProgress[]; conversions?: ConversionState[] };
  /** Sinks that convert nothing this epoch: already finished, or a holder sink with no eligible holder. */
  skip: Set<number>;
  /** Swap `amount` of the token into `outMint` and return what arrived. It keeps its own progress in `progress`, returns the recorded
   *  amount when the swap already happened, and throws NoRouteError when Jupiter has no route. */
  convert: (amount: bigint, outMint: string, progress: ConversionProgress) => Promise<bigint>;
  save: () => void;
  log: (s: string) => void;
  dryRun: boolean;
};

/**
 * Run the epoch's swaps, one per payout asset, and return every sink's part of what its asset's swap delivered (null = no route, the pot
 * is kept). The plan is made once per epoch and saved with the state, so a resumed run swaps nothing twice. An epoch the engine began
 * before 2026-09-29 converted sink by sink: it has swap progress on its sinks and no plan, gets none here, and its sinks finish on their
 * own (the returned map is empty).
 */
export async function runConversions(r: ConversionRun): Promise<Map<number, bigint | null>> {
  const { state, token } = r;
  const pots = state.sinks.map((s) => BigInt(s.pot));
  const sinkBySink = !state.conversions && state.sinks.some((s) => s.swapSig || s.converted || s.path || s.via);
  if (!state.conversions && !sinkBySink) {
    state.conversions = planConversions(token, pots, r.skip).map((p) => ({ mint: p.mint, sinks: p.sinks, amount: p.amount.toString(), sigs: [] }));
    r.save();
  }
  const parts = new Map<number, bigint | null>();
  for (const c of state.conversions ?? []) {
    if (c.sinks.every((i) => state.sinks[i].done)) continue;
    let out: bigint | null = null;
    if (!c.noRoute) {
      if (c.sinks.length > 1) r.log(`  one swap for sinks ${c.sinks.join(", ")}: ${c.amount} ${token.symbol} → ${c.mint.slice(0, 6)}…`);
      try { out = await r.convert(BigInt(c.amount), c.mint, c); }
      catch (e) {
        if (!(e instanceof NoRouteError)) throw e;
        r.log(`  Jupiter has no route for ${c.amount} ${token.symbol} → ${c.mint.slice(0, 6)}…; kept for the next epoch`);
        c.noRoute = true; r.save();
      }
    }
    const split = out === null ? null : splitDelivered(out, c.sinks.map((i) => pots[i]));
    c.sinks.forEach((i, k) => { parts.set(i, split ? split[k] : null); if (split) state.sinks[i].converted = split[k].toString(); });
    if (r.dryRun && out !== null) c.converted = out.toString(); // a dry run records what Jupiter quoted
    r.save();
  }
  return parts;
}
