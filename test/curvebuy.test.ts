import { test } from "node:test";
import assert from "node:assert/strict";
import { curveBuyLegs, platformCurve } from "../src/epoch.js";
import { NoRouteError } from "../src/plan.js";

const SOL = "So11111111111111111111111111111111111111112";
const TOKEN = "BSJUs7qza1fRVA8GdcbxpZWX6n7UK1PdKPzYN425yvRM", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ASSET = "2Pk5wVPa8jTm9m9QuNuqFDG98bZB4QJAX49iHu6vetM8", GLDX = "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re";
/** A stand-in for Jupiter's quote: `routes` lists the pairs it can quote, as "in>out"; anything else has no route. */
const jupiter = (routes: string[]) => async (inMint: string, outMint: string, amount: bigint) => {
  if (!routes.includes(`${inMint}>${outMint}`)) throw new NoRouteError("jupiter quote 400: no route");
  return { outAmount: String(amount * 2n) };
};
const plan = { token: TOKEN, tokenQuote: USDC, asset: ASSET, assetQuote: GLDX, amount: 10n, quoteUnit: 1_000_000n, slippageBps: 100 };
const steps = (r: { legs: { kind: string; in: string; out: string }[] }) => r.legs.map((l) => [l.kind, l.in, l.out]);

test("the token sells: Jupiter brings it to the asset's quote, then the asset is bought on its own curve", async () => {
  const r = await curveBuyLegs(jupiter([`${TOKEN}>${GLDX}`]), { ...plan, tokenSells: true });
  assert.deepEqual(steps(r), [["jupiter", TOKEN, GLDX], ["buy-curve", GLDX, ASSET]]);
  assert.equal(r.out, 20n); assert.equal(r.outIn, GLDX);
});

test("two Jupiter swaps through SOL when only that way reaches the asset's quote", async () => {
  const r = await curveBuyLegs(jupiter([`${TOKEN}>${SOL}`, `${SOL}>${GLDX}`]), { ...plan, tokenSells: true });
  assert.deepEqual(steps(r), [["jupiter", TOKEN, SOL], ["jupiter", SOL, GLDX], ["buy-curve", GLDX, ASSET]]);
  assert.equal(r.outIn, SOL, "valued in lamports");
});

test("an asset on a SOL curve: the token is sold for SOL, then the asset bought", async () => {
  const r = await curveBuyLegs(jupiter([`${TOKEN}>${SOL}`]), { ...plan, tokenSells: true, assetQuote: SOL });
  assert.deepEqual(steps(r), [["jupiter", TOKEN, SOL], ["buy-curve", SOL, ASSET]]);
});

test("Jupiter dropped the token too: sold on its own curve, the pair's quote swapped into the asset's quote, then the purchase", async () => {
  const r = await curveBuyLegs(jupiter([`${USDC}>${GLDX}`]), { ...plan, tokenSells: false });
  assert.deepEqual(steps(r), [["sell-curve", TOKEN, USDC], ["jupiter", USDC, GLDX], ["buy-curve", GLDX, ASSET]]);
  assert.equal(r.out, null, "a curve sale is valued by the token's own price, not by a quote");
});

test("the same quote asset on both curves: no Jupiter step at all", async () => {
  const r = await curveBuyLegs(jupiter([]), { ...plan, tokenSells: false, tokenQuote: GLDX });
  assert.deepEqual(steps(r), [["sell-curve", TOKEN, GLDX], ["buy-curve", GLDX, ASSET]]);
});

test("the asset's quote cannot be reached: no route, nothing planned", async () => {
  await assert.rejects(curveBuyLegs(jupiter([`${TOKEN}>${SOL}`]), { ...plan, tokenSells: true }), NoRouteError);
  await assert.rejects(curveBuyLegs(jupiter([]), { ...plan, tokenSells: false }), NoRouteError);
});

test("any other failure, such as a rate limit, is passed on untouched", async () => {
  const limited = async () => { throw new Error("jupiter quote 429: Too Many Requests"); };
  await assert.rejects(curveBuyLegs(limited, { ...plan, tokenSells: true }), /429/);
  await assert.rejects(curveBuyLegs(limited, { ...plan, tokenSells: false }), /429/);
});

test("only a token launched on the platform's own accounts, still on its curve, is bought on its curve", () => {
  const ours = ["DEfEVZNPRvQGCpKq19BQ5dpB2hmGVFJ4y1ewPSFz22y5", "BWk6ALyW2yj1tud1v7Dr4SQzYGprA6na1xRhiv2tZoNG"];
  assert.equal(platformCurve({ mintA: ASSET, status: 0, platformId: ours[0] }, ASSET, ours), true);
  assert.equal(platformCurve({ mintA: ASSET, status: 0, platformId: "another-platform" }, ASSET, ours), false, "a token launched elsewhere is left as it is");
  assert.equal(platformCurve({ mintA: ASSET, status: 1, platformId: ours[1] }, ASSET, ours), false, "a curve that has closed");
  assert.equal(platformCurve({ mintA: TOKEN, status: 0, platformId: ours[0] }, ASSET, ours), false, "another mint's pool");
});
