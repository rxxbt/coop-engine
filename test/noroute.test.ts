// Which Jupiter answers mean "keep the pot, try next epoch" rather than "the epoch failed", and which send errors mean "never sent, send again".
import { test } from "node:test";
import assert from "node:assert/strict";
import { isNoRoute, isStaleBlockhash } from "../src/epoch.js";

test("no route and amount-too-small answers are kept pots, everything else is a failure", () => {
  assert.equal(isNoRoute(new Error("jupiter quote 400: {\"error\":\"No routes found\",\"errorCode\":\"NO_ROUTES_FOUND\"}")), true);
  assert.equal(isNoRoute(new Error("jupiter quote 400: {\"error\":\"Cannot compute other amount threshold, with amount 1 and slippageBps 100\",\"errorCode\":\"CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD\"}")), true);
  assert.equal(isNoRoute(new Error("jupiter quote 429: Too Many Requests")), false);
  assert.equal(isNoRoute(new Error("swap not landing after 3 attempts")), false);
});

test("a preflight that did not know the blockhash is sent again; other send errors are not", () => {
  // the error web3.js raised on 2026-10-02 18:05 UTC
  assert.equal(isStaleBlockhash(new Error("Simulation failed. \nMessage: Transaction simulation failed: Blockhash not found. \nLogs: \n[]. \nCatch the `SendTransactionError` and call `getLogs()` on it for full details.")), true);
  assert.equal(isStaleBlockhash(new Error("Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1.")), false);
  assert.equal(isStaleBlockhash(new Error("transaction failed on-chain: {\"InstructionError\":[0,{\"Custom\":6000}]}")), false);
});
