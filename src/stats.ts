/**
 * Counters for the landing page (GET /stats): public tokens, distinct creator wallets, published epochs and the size of the quote menu.
 * Cheap on purpose: one directory listing per token and no JSON parsing, so the API can answer it from a short cache for every visitor.
 */
import fs from "node:fs";
import path from "node:path";
import type { EngineConfig } from "./config.js";

export type Stats = { tokens: number; creators: number; epochs: number; quotes: number; at: string };

export function countStats(c: Pick<EngineConfig, "tokens" | "dataDir">, quotes: number): Stats {
  const list = c.tokens.filter((t) => !t.hidden);
  const creators = new Set(list.map((t) => t.registered?.creator).filter((x): x is string => !!x));
  let epochs = 0;
  for (const t of list) {
    let files: string[] = [];
    try { files = fs.readdirSync(path.join(c.dataDir, t.mint)); } catch { /* no epoch yet */ }
    epochs += files.filter((f) => /^epoch-\d+\.json$/.test(f)).length; // finished records only: not state files, not dry runs
  }
  return { tokens: list.length, creators: creators.size, epochs, quotes, at: new Date().toISOString() };
}
