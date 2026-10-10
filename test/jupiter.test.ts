// Jupiter access: the key header and host, the pace that spaces calls out, the retry on 429, and the price cache that turns a run's many
// lookups into a few batched requests (and remembers a miss, so a fresh curve token is not asked about twice).
process.env.JUP_API_KEY = "test-key"; process.env.JUP_RPS = "20"; process.env.JUP_RETRY_MS = "5"; process.env.JUP_PRICE_TTL_MS = "60000";
import { test } from "node:test";
import assert from "node:assert/strict";
const jup = await import("../src/jupiter.js");

type Call = { url: string; headers: Record<string, string> };
function stub(handler: (url: string, n: number) => { status: number; body?: unknown; headers?: Record<string, string> }): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    const r = handler(String(url), calls.length);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers ?? {} });
  }) as any;
  return calls;
}

test("with a key every call goes to api.jup.ag with the x-api-key header", async () => {
  const calls = stub(() => ({ status: 200 }));
  const r = await jup.jupFetch(`${jup.PRICE_API}?ids=x`);
  assert.equal(r.status, 200);
  assert.equal(calls[0].headers["x-api-key"], "test-key");
  assert.match(calls[0].url, /^https:\/\/api\.jup\.ag\/price\/v3\?/);
  assert.match(jup.SWAP_API, /^https:\/\/api\.jup\.ag\/swap\/v1$/);
  assert.match(jup.TOKENS_API, /^https:\/\/api\.jup\.ag\/tokens\/v2$/);
});

test("calls started at once go out spaced by the pace", async () => {
  stub(() => ({ status: 200 }));
  const t0 = Date.now();
  await Promise.all([1, 2, 3, 4].map(() => jup.jupFetch("https://api.jup.ag/x")));
  const dt = Date.now() - t0;
  assert.ok(dt >= 3 * 52 - 5, `four calls at 20 a second took ${dt} ms`);
});

test("a 429 is retried after retry-after and the next answer is returned", async () => {
  const calls = stub((_, n) => (n === 1 ? { status: 429, headers: { "retry-after": "1" } } : { status: 200 }));
  const r = await jup.jupFetch("https://api.jup.ag/y");
  assert.equal(r.status, 200); assert.equal(calls.length, 2);
});

test("prices: one batched request per 50 mints, then the cache answers, and a miss is remembered", async () => {
  jup.forgetPrices();
  const ids = Array.from({ length: 60 }, (_, i) => `mint${i}`);
  const calls = stub((url) => { const body: any = {}; for (const id of new URL(url).searchParams.get("ids")!.split(",")) body[id] = { usdPrice: 2 }; return { status: 200, body }; });
  const p = await jup.jupPrices(ids);
  assert.equal(Object.keys(p).length, 60); assert.equal(calls.length, 2);
  await jup.jupPrices(ids.slice(0, 10)); assert.equal(calls.length, 2, "served from the cache");
  const misses = stub(() => ({ status: 200, body: {} }));
  assert.deepEqual(await jup.jupPrices(["unknown"]), {}); assert.equal(misses.length, 1);
  assert.deepEqual(await jup.jupPrices(["unknown"]), {}); assert.equal(misses.length, 1, "the miss is remembered");
});
