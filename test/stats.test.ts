// GET /stats: the landing page's counters. Public tokens only, creator wallets counted once, and only finished epoch records count
// (not state files, not dry runs, not the holder history).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { countStats } from "../src/stats.js";

test("stats count public tokens, distinct creators and finished epochs only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coop-stats-"));
  const mk = (mint: string, files: string[]) => { fs.mkdirSync(path.join(dir, mint)); for (const f of files) fs.writeFileSync(path.join(dir, mint, f), "{}"); };
  mk("A", ["epoch-1.json", "epoch-2.json", "epoch-3.state.json", "epoch-4-dry.json", "history.json", "carry.json"]);
  mk("B", ["epoch-1.json"]);
  mk("H", ["epoch-1.json", "epoch-2.json"]);
  const tokens = [
    { mint: "A", registered: { creator: "c1" } },
    { mint: "B", registered: { creator: "c1" } },
    { mint: "C" },                                        // registered by hand, no epoch directory yet
    { mint: "H", hidden: true, registered: { creator: "c9" } }, // a hidden test token counts nowhere
  ] as any[];
  const s = countStats({ tokens, dataDir: dir }, 593);
  assert.deepEqual({ tokens: s.tokens, creators: s.creators, epochs: s.epochs, quotes: s.quotes }, { tokens: 3, creators: 1, epochs: 3, quotes: 593 });
  assert.ok(!Number.isNaN(Date.parse(s.at)));
  fs.rmSync(dir, { recursive: true, force: true });
});
