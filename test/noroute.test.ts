// Which Jupiter answers mean "keep the pot, try next epoch" rather than "the epoch failed".
import { test } from "node:test";
import assert from "node:assert/strict";
import { isNoRoute } from "../src/epoch.js";

test("no route and amount-too-small answers are kept pots, everything else is a failure", () => {
  assert.equal(isNoRoute(new Error("jupiter quote 400: {\"error\":\"No routes found\",\"errorCode\":\"NO_ROUTES_FOUND\"}")), true);
  assert.equal(isNoRoute(new Error("jupiter quote 400: {\"error\":\"Cannot compute other amount threshold, with amount 1 and slippageBps 100\",\"errorCode\":\"CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD\"}")), true);
  assert.equal(isNoRoute(new Error("jupiter quote 429: Too Many Requests")), false);
  assert.equal(isNoRoute(new Error("swap not landing after 3 attempts")), false);
});
