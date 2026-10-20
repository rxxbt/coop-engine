import { test } from "node:test";
import assert from "node:assert/strict";
import { jupiterRoute } from "../src/epoch.js";
import { NoRouteError, TokenNotRoutedError } from "../src/plan.js";

const SOL = "So11111111111111111111111111111111111111112";
const TOKEN = "F2SjV3gEDzEyxafd6P8uRuqnDkpTkWyD8XZJDrPzCGmY", ASSET = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
/** A stand-in for Jupiter's quote: `routes` lists the pairs it can quote, as "in>out"; anything else has no route. */
const jupiter = (routes: string[]) => async (inMint: string, outMint: string, amount: bigint) => {
  if (!routes.includes(`${inMint}>${outMint}`)) throw new NoRouteError("jupiter quote 400: no route");
  return { outAmount: String(amount * 2n) };
};

test("one swap when Jupiter routes the token straight into the payout asset", async () => {
  assert.deepEqual(await jupiterRoute(jupiter([`${TOKEN}>${ASSET}`]), TOKEN, ASSET, 10n, 100), { path: "direct", out: 20n });
});

test("two swaps through SOL when only that way exists", async () => {
  assert.deepEqual(await jupiterRoute(jupiter([`${TOKEN}>${SOL}`, `${SOL}>${ASSET}`]), TOKEN, ASSET, 10n, 100), { path: "via-sol", out: 20n });
});

test("Jupiter cannot sell the token at all: that is the case the token's own curve can take", async () => {
  await assert.rejects(jupiterRoute(jupiter([`${SOL}>${ASSET}`]), TOKEN, ASSET, 10n, 100), TokenNotRoutedError);
  await assert.rejects(jupiterRoute(jupiter([]), TOKEN, SOL, 10n, 100), TokenNotRoutedError, "paid in SOL: the one quote is the token's own");
});

test("the token sells but the payout asset cannot be bought: a plain no route, not the curve's case", async () => {
  await assert.rejects(jupiterRoute(jupiter([`${TOKEN}>${SOL}`]), TOKEN, ASSET, 10n, 100), (e: unknown) => e instanceof NoRouteError && !(e instanceof TokenNotRoutedError));
});

test("any other failure, such as a rate limit, is passed on untouched", async () => {
  const limited = async () => { throw new Error("jupiter quote 429: Too Many Requests"); };
  await assert.rejects(jupiterRoute(limited, TOKEN, ASSET, 10n, 100), /429/);
});
