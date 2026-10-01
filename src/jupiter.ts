/** Jupiter swap API (lite tier, no key). Used to convert swept tax into the payout asset. */
import { VersionedTransaction } from "@solana/web3.js";

const BASE = process.env.JUP_API || "https://lite-api.jup.ag/swap/v1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Jupiter's lite tier occasionally answers 5xx for a valid request (seen: "Missing token program" on a Token-2022 mint), and 429 when it
 *  is asked too often (a run over many tokens; seen 2026-09-29 after a series of dry runs). Retry with backoff, longer after a 429. */
async function fetchRetry(url: string, init?: RequestInit, tries = 4): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    let wait = 1500 * (i + 1);
    try {
      const r = await fetch(url, init);
      if ((r.status < 500 && r.status !== 429) || i === tries - 1) return r;
      if (r.status === 429) wait = Math.min(15_000, (Number(r.headers.get("retry-after")) || 4 * (i + 1)) * 1000);
      last = new Error(`${r.status}: ${await r.text()}`);
    } catch (e) { last = e; }
    await sleep(wait);
  }
  throw last;
}

export type Quote = { inputMint: string; outputMint: string; inAmount: string; outAmount: string; priceImpactPct: string; routePlan: unknown[]; [k: string]: unknown };

export async function quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<Quote> {
  const u = `${BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  const r = await fetchRetry(u);
  if (!r.ok) throw new Error(`jupiter quote ${r.status}: ${await r.text()}`);
  return (await r.json()) as Quote;
}

/** The swap transaction plus the block height its blockhash is valid to, so the caller can tell "still pending" from "expired, safe to re-send". A capped high priority fee: a swap sent with "auto" can be dropped under load. */
export async function swapTransaction(q: Quote, userPublicKey: string): Promise<{ vtx: VersionedTransaction; lastValidBlockHeight?: number }> {
  const r = await fetchRetry(`${BASE}/swap`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: "high" } } }),
  });
  if (!r.ok) throw new Error(`jupiter swap ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { swapTransaction: string; lastValidBlockHeight?: number };
  return { vtx: VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, "base64")), lastValidBlockHeight: j.lastValidBlockHeight };
}
