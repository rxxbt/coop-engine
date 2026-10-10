/**
 * Jupiter's APIs in one place: swap quotes and transactions, the price feed and the token search. One hostname, one API key, one pace
 * and one retry policy for every call the engine and the API make.
 *
 * Keyless (no JUP_API_KEY): lite-api.jup.ag, which Jupiter caps at 0.5 requests per second (30 a minute) since October 2026; an hourly run
 * over fifty tokens used to ask two or three times per token and hit the cap. With a key: api.jup.ag with the x-api-key header; the free
 * plan allows 1 request per second, paid plans more (JUP_RPS sets the pace). Prices are cached for five minutes and fetched in batches of
 * up to 50 mints, so a run asks a handful of times instead of once per token and per pot.
 */
import { VersionedTransaction } from "@solana/web3.js";

const KEY = (process.env.JUP_API_KEY || "").trim();
const HOST = (process.env.JUP_HOST || (KEY ? "https://api.jup.ag" : "https://lite-api.jup.ag")).replace(/\/$/, "");
export const SWAP_API = process.env.JUP_API || `${HOST}/swap/v1`;
export const PRICE_API = process.env.JUP_PRICE_API || `${HOST}/price/v3`;
export const TOKENS_API = process.env.JUP_TOKENS_API || `${HOST}/tokens/v2`;
/** Requests per second the engine allows itself, 5% under Jupiter's cap for the tier. */
export const RPS = Number(process.env.JUP_RPS) > 0 ? Number(process.env.JUP_RPS) : KEY ? 1 : 0.5;
const SPACING_MS = Math.ceil((1000 / RPS) * 1.05);
const RETRY_UNIT_MS = Number(process.env.JUP_RETRY_MS) > 0 ? Number(process.env.JUP_RETRY_MS) : 1000; // tests shorten the waits
const PRICE_TTL_MS = Number(process.env.JUP_PRICE_TTL_MS) > 0 ? Number(process.env.JUP_PRICE_TTL_MS) : 5 * 60_000;
export const keyed = () => KEY !== "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nextSlot = 0;
/** Reserve the next send time: calls go out SPACING_MS apart however many are started at once. */
async function slot(): Promise<void> {
  const now = Date.now(); const at = Math.max(now, nextSlot); nextSlot = at + SPACING_MS;
  if (at > now) await sleep(at - now);
}

/** fetch for Jupiter: paced, keyed, retried on 429 (honouring retry-after) and on 5xx. Returns the last answer when the retries are used up,
 *  so the caller can report its status. Jupiter's lite tier also answers 5xx for a valid request now and then (seen: "Missing token program"
 *  on a Token-2022 mint) and 429 when asked too often (a run over many tokens; seen 2026-09-29 and again 2026-10-09). */
export async function jupFetch(url: string, init: RequestInit = {}, tries = 4): Promise<Response> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string> | undefined) ?? {}), ...(KEY ? { "x-api-key": KEY } : {}) };
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    await slot();
    let wait = 1.5 * (i + 1) * RETRY_UNIT_MS;
    try {
      const r = await globalThis.fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(20_000) });
      if ((r.status < 500 && r.status !== 429) || i === tries - 1) return r;
      if (r.status === 429) wait = Math.min(15 * RETRY_UNIT_MS, (Number(r.headers.get("retry-after")) || 4 * (i + 1)) * RETRY_UNIT_MS);
      last = new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    } catch (e) { last = e; }
    await sleep(wait);
  }
  throw last;
}

export type Quote = { inputMint: string; outputMint: string; inAmount: string; outAmount: string; priceImpactPct: string; routePlan: unknown[]; [k: string]: unknown };

export async function quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<Quote> {
  const u = `${SWAP_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  const r = await jupFetch(u);
  if (!r.ok) throw new Error(`jupiter quote ${r.status}: ${await r.text()}`);
  return (await r.json()) as Quote;
}

/** The swap transaction plus the block height its blockhash is valid to, so the caller can tell "still pending" from "expired, safe to re-send". A capped high priority fee: a swap sent with "auto" can be dropped under load. */
export async function swapTransaction(q: Quote, userPublicKey: string): Promise<{ vtx: VersionedTransaction; lastValidBlockHeight?: number }> {
  const r = await jupFetch(`${SWAP_API}/swap`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: "high" } } }),
  });
  if (!r.ok) throw new Error(`jupiter swap ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { swapTransaction: string; lastValidBlockHeight?: number };
  return { vtx: VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, "base64")), lastValidBlockHeight: j.lastValidBlockHeight };
}

/** Dollar prices from Jupiter's feed, cached for five minutes (a miss is remembered too, so a fresh curve token is not asked about twice
 *  in one run); mints not yet cached are fetched in batches of 50. Throws only when a batch request itself fails. */
const priceCache = new Map<string, { at: number; usd: number }>();
export async function jupPrices(ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}; const want: string[] = []; const now = Date.now();
  for (const id of new Set(ids)) {
    const c = priceCache.get(id);
    if (c && now - c.at < PRICE_TTL_MS) { if (c.usd > 0) out[id] = c.usd; } else want.push(id);
  }
  for (let i = 0; i < want.length; i += 50) {
    const batch = want.slice(i, i + 50);
    const r = await jupFetch(`${PRICE_API}?ids=${batch.join(",")}`);
    if (!r.ok) throw new Error(`price ${r.status}`);
    const j: any = await r.json();
    for (const id of batch) {
      const row = j?.[id] ?? j?.data?.[id]; const p = Number(row?.usdPrice ?? row?.price);
      priceCache.set(id, { at: now, usd: p > 0 ? p : 0 }); if (p > 0) out[id] = p;
    }
  }
  return out;
}
/** Warm the cache for a whole run: the scheduler passes every token's mint, quote and payout assets, two or three requests in all. */
export async function primePrices(ids: string[]): Promise<void> { try { await jupPrices(ids); } catch { /* each lookup retries on its own */ } }
export function forgetPrices(): void { priceCache.clear(); }
