// Which Jupiter answers mean "keep the pot, try next epoch" rather than "the epoch failed", and which send errors mean "never sent, send again".
import { test } from "node:test";
import assert from "node:assert/strict";
import { isNoRoute, isStaleBlockhash, lamportsWorth } from "../src/epoch.js";

test("no route and amount-too-small answers are kept pots, everything else is a failure", () => {
  assert.equal(isNoRoute(new Error("jupiter quote 400: {\"error\":\"No routes found\",\"errorCode\":\"NO_ROUTES_FOUND\"}")), true);
  assert.equal(isNoRoute(new Error("jupiter quote 400: {\"error\":\"Cannot compute other amount threshold, with amount 1 and slippageBps 100\",\"errorCode\":\"CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD\"}")), true);
  assert.equal(isNoRoute(new Error("jupiter quote 400: {\"error\":\"The token So11111111111111111111111111111111111111112 is not tradable\",\"errorCode\":\"TOKEN_NOT_TRADABLE\"}")), true);
  assert.equal(isNoRoute(new Error("jupiter quote 429: Too Many Requests")), false);
  assert.equal(isNoRoute(new Error("swap not landing after 3 attempts")), false);
});

test("a preflight that did not know the blockhash is sent again; other send errors are not", () => {
  // the error web3.js raised on 2026-10-02 18:05 UTC
  assert.equal(isStaleBlockhash(new Error("Simulation failed. \nMessage: Transaction simulation failed: Blockhash not found. \nLogs: \n[]. \nCatch the `SendTransactionError` and call `getLogs()` on it for full details.")), true);
  assert.equal(isStaleBlockhash(new Error("Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1.")), false);
  assert.equal(isStaleBlockhash(new Error("transaction failed on-chain: {\"InstructionError\":[0,{\"Custom\":6000}]}")), false);
});

test("a pot Jupiter cannot route is valued at the token's own price: dust stays quiet, real money still alerts", () => {
  // 2026-10-20: 7,659.498396 tokens of a dead curve token at $0.0000031937 with SOL at $104: about 235,000 lamports, under the 2,000,000 a swap needs
  const dust = lamportsWorth(7_659_498_396n, 6, 3.193724758209686e-6, 104);
  assert.ok(dust > 230_000n && dust < 240_000n, String(dust));
  assert.ok(dust < 2_000_000n);
  // 5,000,000 tokens at the same price: about $16, far above the floor
  assert.ok(lamportsWorth(5_000_000_000_000n, 6, 3.193724758209686e-6, 104) > 2_000_000n);
  // no price, no valuation: 0 here, and the caller keeps the no-route alert because it never got both prices
  assert.equal(lamportsWorth(1_000_000n, 6, 0, 104), 0n);
});
