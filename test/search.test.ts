// Asset lookups: a ticker is matched without regard to case, an address is sent to Jupiter exactly as it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchTerms } from "../src/quotes.js";

test("a ticker or a name is asked in lower case, a leading $ and spaces are dropped", () => {
  assert.deepEqual(searchTerms("COOP"), { ask: "coop", key: "coop", address: false });
  assert.deepEqual(searchTerms(" $Coop "), { ask: "coop", key: "coop", address: false });
  assert.deepEqual(searchTerms("Rocket Lab"), { ask: "rocket lab", key: "rocket lab", address: false });
});

test("an address keeps its case: lower-cased, Jupiter finds nothing and every ecosystem page reads 'unknown to Jupiter'", () => {
  // lookups by address: RKLB, NOK, Bonk and COOP
  for (const mint of ["RKLBnAXGqv31iZomqsuAWkQm1aqC7JwwvbCfzGdqAhz", "N7Q5fYX7YRnDQksfdBKnoUb3awm92n7QNAD35X3Rq1X", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "2Pk5wVPa8jTm9m9QuNuqFDG98bZB4QJAX49iHu6vetM8", "So11111111111111111111111111111111111111112"]) {
    const t = searchTerms(` ${mint} `);
    assert.equal(t.ask, mint);
    assert.equal(t.key, mint);
    assert.equal(t.address, true);
    assert.notEqual(t.ask, mint.toLowerCase());
  }
});

test("text that only looks long is still a name, not an address", () => {
  assert.equal(searchTerms("God, Coins, Family").address, false);                       // spaces and commas
  assert.equal(searchTerms("O0Il".repeat(10)).address, false);                          // characters no address contains
  assert.equal(searchTerms("RKLBnAXGqv31iZomqsuAWkQm1aqC7").address, false);            // too short
});
