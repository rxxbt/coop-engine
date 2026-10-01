/**
 * Quote-asset menu for the launch form and the token-search proxy for payout assets.
 *
 * A LaunchLab pool can be quoted in any mint that has a program-wide GlobalConfig (curve 0, index 0). Raydium's delegate
 * creates those configs (569 on 2026-09-26) and every platform can use every one of
 * them, so the menu is read from the chain (getProgramAccounts on the config size) and enriched from Jupiter's token API
 * (symbol, name, logo, liquidity, price, holders, tags). Cached one hour in memory and in <dataDir>/quotes.json; a stale
 * list is served while the next build runs in the background.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { LAUNCHPAD_PROGRAM, LaunchpadConfig } from "@raydium-io/raydium-sdk-v2";

const SOL = "So11111111111111111111111111111111111111112";
const TOKENS_API = process.env.JUP_TOKENS_API || "https://lite-api.jup.ag/tokens/v2";
const TTL_MS = 60 * 60_000;

export type QuoteGroup = "solana" | "stable" | "lst" | "stocks" | "commodities" | "leverage" | "other";
export type QuoteInfo = {
  mint: string; symbol: string; name: string; logo?: string; decimals: number; program: string;
  group: QuoteGroup; tags: string[]; verified: boolean; liquidity?: number; price?: number; holders?: number;
  configId: string;
  epoch: number;      // the Solana epoch the config was created in (Raydium creates them in batches)
  minRaise: string;   // the config's minimum raise, raw units
  raise85?: string;   // the raise worth 85 SOL at build time, raw units (Raydium's default sizing)
};
export type QuoteList = { generatedAt: string; solPrice?: number; count: number; quotes: QuoteInfo[] };
export type AssetInfo = {
  mint: string; symbol: string; name: string; logo?: string; decimals: number; program: string; verified: boolean; tags: string[];
  liquidity?: number; price?: number; holders?: number;
};

type JupToken = { id: string; symbol?: string; name?: string; icon?: string; decimals?: number; tokenProgram?: string; tags?: string[]; isVerified?: boolean; liquidity?: number; usdPrice?: number; holderCount?: number };

/** Jupiter token search: a symbol, a name, or up to 100 comma-separated mints. */
async function jupSearch(query: string): Promise<JupToken[]> {
  const r = await fetch(`${TOKENS_API}/search?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`jupiter tokens ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

function groupOf(mint: string, t: JupToken | undefined): QuoteGroup {
  if (mint === SOL) return "solana";
  const tags = t?.tags ?? [], sym = (t?.symbol ?? "").toUpperCase(), price = t?.usdPrice ?? 0;
  if (tags.includes("lst") || tags.includes("original-lst")) return "lst";
  if (/^X(SOL|BTC|ETH|HYPE|BNB)$/.test(sym)) return "leverage";
  if (tags.includes("commodities") || (/^(GLDX|GLD|GOLD|XAU|XAUT|XAUT0|PAXG|SILVER|SLVX|XAG)$/.test(sym) && (tags.includes("rwa") || tags.includes("stocks") || tags.includes("xstocks")))) return "commodities";
  if (tags.includes("stocks") || tags.includes("xstocks") || tags.includes("prestocks")) return "stocks";
  if (t?.isVerified && /USD|DAI|EUR|CHF|GBP|CAD|AUD/.test(sym) && price > 0.5 && price < 2) return "stable";
  return "other";
}

export async function buildQuoteList(conn: Connection): Promise<QuoteList> {
  const accs = await conn.getProgramAccounts(LAUNCHPAD_PROGRAM, { filters: [{ dataSize: LaunchpadConfig.span }] });
  const byMint = new Map<string, { configId: string; minRaise: string; epoch: number }>();
  let other = 0;
  for (const a of accs) {
    const d = LaunchpadConfig.decode(a.account.data);
    if (d.curveType !== 0 || d.index !== 0) { other++; continue; } // the form and the engine use curve 0, index 0
    byMint.set(d.mintB.toBase58(), { configId: a.pubkey.toBase58(), minRaise: d.minFundRaisingB.toString(), epoch: Number(d.epoch.toString()) });
  }
  const mints = [...byMint.keys()];
  const jup = new Map<string, JupToken>();
  for (let i = 0; i < mints.length; i += 100) {
    const batch = mints.slice(i, i + 100);
    try { for (const t of await jupSearch(batch.join(","))) jup.set(t.id, t); }
    catch (e) { console.log(`quotes: jupiter batch ${i / 100} failed: ${String(e)}`); }
  }
  // decimals and token program for mints Jupiter does not know
  const unknown = mints.filter((m) => jup.get(m)?.decimals === undefined || !jup.get(m)?.tokenProgram);
  const chain = new Map<string, { decimals: number; program: string }>();
  for (let i = 0; i < unknown.length; i += 100) {
    const batch = unknown.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(batch.map((m) => new PublicKey(m)));
    infos.forEach((info, k) => { if (info && info.data.length >= 45) chain.set(batch[k], { decimals: info.data.readUInt8(44), program: info.owner.toBase58() }); });
  }
  const solPrice = jup.get(SOL)?.usdPrice;
  const quotes: QuoteInfo[] = [];
  for (const m of mints) {
    const t = jup.get(m), c = chain.get(m), cfg = byMint.get(m)!;
    const decimals = t?.decimals ?? c?.decimals, program = t?.tokenProgram ?? c?.program;
    if (decimals === undefined || !program) continue; // no mint account: nothing could be launched on it
    const price = t?.usdPrice;
    let raise85: string | undefined;
    if (solPrice && price && price > 0) { const raw = Math.round((85 * solPrice / price) * 10 ** decimals); if (Number.isFinite(raw) && raw > 0) raise85 = BigInt(raw).toString(); }
    quotes.push({
      mint: m, symbol: t?.symbol ?? "?", name: t?.name ?? `unknown token ${m.slice(0, 4)}…${m.slice(-4)}`, logo: t?.icon, decimals, program,
      group: groupOf(m, t), tags: t?.tags ?? [], verified: !!t?.isVerified, liquidity: t?.liquidity, price, holders: t?.holderCount,
      configId: cfg.configId, epoch: cfg.epoch, minRaise: cfg.minRaise, raise85,
    });
  }
  quotes.sort((a, b) => (b.liquidity ?? -1) - (a.liquidity ?? -1));
  console.log(`quotes: ${accs.length} configs on-chain, ${byMint.size} at curve 0/index 0 (${other} other), ${quotes.length} listed, Jupiter knows ${jup.size}`);
  return { generatedAt: new Date().toISOString(), solPrice, count: quotes.length, quotes };
}

let mem: QuoteList | null = null;
/** The cached menu without waiting (null before the first build). */
export function quotesNow(): QuoteList | null { return mem; }
let building: Promise<QuoteList> | null = null;

/** The cached menu; rebuilt in the background once it is an hour old. */
export async function getQuotes(conn: Connection, dataDir: string): Promise<QuoteList> {
  const file = path.join(dataDir, "quotes.json");
  if (!mem && fs.existsSync(file)) { try { mem = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* rebuild below */ } }
  const stale = !mem || Date.now() - Date.parse(mem.generatedAt) > TTL_MS;
  if (stale && !building) {
    building = buildQuoteList(conn)
      .then((l) => { const prev = mem; mem = l; fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(l)); announceNew(prev, l, dataDir).catch((e) => console.log(`quotes: announce failed: ${String(e)}`)); return l; })
      .catch((e) => { console.log(`quotes: build failed: ${String(e)}`); if (mem) return mem; throw e; })
      .finally(() => { building = null; });
  }
  if (mem) return mem;
  return building!;
}

/** Raydium creates quote configs in batches; when the hourly rebuild finds new ones, log them and send the operator a Telegram note,
 *  so new pairs on LaunchLab can be announced as available on COOP the day they appear. Bot credentials come from an env file
 *  on the server (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID), never from the repository. */
async function announceNew(prev: QuoteList | null, cur: QuoteList, dataDir: string) {
  if (!prev) return; // first build after a restart: nothing to compare against
  const seen = new Set(prev.quotes.map((q) => q.mint));
  const added = cur.quotes.filter((q) => !seen.has(q.mint));
  if (!added.length) return;
  fs.appendFileSync(path.join(dataDir, "quotes-added.jsonl"), added.map((q) => JSON.stringify({ at: cur.generatedAt, mint: q.mint, symbol: q.symbol, name: q.name, epoch: q.epoch, liquidity: q.liquidity, holders: q.holders })).join("\n") + "\n");
  console.log(`quotes: ${added.length} new config(s): ${added.map((q) => q.symbol).join(", ")}`);
  const envFile = process.env.TELEGRAM_ENV || "telegram.env";
  const env: Record<string, string> = { ...process.env } as any;
  if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, "utf8").split("\n")) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, ""); }
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  const fmt = (n?: number) => (n === undefined ? "?" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`);
  const lines = added.slice(0, 10).map((q) => `• ${q.symbol} (${q.name}) — liquidity ${fmt(q.liquidity)}, holders ${q.holders ?? "?"}, ${q.verified ? "verified" : "unverified"} — ${q.mint}`);
  const first = added[0];
  const draft = `New pair on Raydium LaunchLab: $${first.symbol}.\nLaunch against it on COOP today, and pay holders in it, or in anything else Jupiter routes. 0% platform fee.\ncoopfam.xyz/app`;
  const text = `COOP · ${added.length} new quote config(s) on LaunchLab (Raydium created them):\n${lines.join("\n")}\n\nDraft post:\n${draft}`;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }) });
}

const searchCache = new Map<string, { at: number; rows: AssetInfo[] }>();
/** Tickers whose first search result is fixed: ticker (lower case) → mint. */
const PINNED: Record<string, string> = { coop: "DSZSngBU2VpMKCQSqMJkS3YvT5jYn2EbKWppZY6rZWmk" };

/** What to ask Jupiter, and what to rank and cache by. A ticker or a name is matched without regard to case. An ADDRESS is case-sensitive
 *  and goes to Jupiter exactly as given: in lower case it finds nothing. A lookup by address must therefore never be
 *  lower-cased. */
export function searchTerms(q: string): { ask: string; key: string; address: boolean } {
  const text = q.trim().replace(/^\$/, "");
  const address = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);
  return address ? { ask: text, key: text, address } : { ask: text.toLowerCase(), key: text.toLowerCase(), address };
}

/** Payout-asset search (any token Jupiter can route): top 20 matches for a symbol, a name or a mint. Cached 5 minutes per query.
 *  Ranking: an exact ticker match first (so a small token is found by its own ticker: "COOP" used to sink to 11th under twenty
 *  Cooper-somethings), then tickers starting with the query, then the rest; liquidity decides inside each tier, because lookalikes
 *  exist for every popular symbol and the liquid one is the real one. A leading $ is ignored. */
export async function searchAssets(q: string): Promise<AssetInfo[]> {
  const { ask, key, address } = searchTerms(q);
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.rows;
  // Our own token comes first for its own ticker: same-ticker tokens exist for every name (on 2026-09-29 three other "COOP"s outranked ours
  // on liquidity), and a dev who picks the wrong one routes their tax into a stranger's token.
  const pinned = PINNED[key];
  const tier = (t: JupToken) => { if (t.id === pinned) return -1; const s = (t.symbol ?? "").toLowerCase(); return s === key ? 0 : s.startsWith(key) ? 1 : 2; };
  const found = await jupSearch(ask);
  if (pinned && !found.some((t) => t.id === pinned)) found.push(...(await jupSearch(pinned).catch(() => [] as JupToken[])));
  let rows: AssetInfo[] = found
    .filter((t) => t.decimals !== undefined && t.tokenProgram)
    .sort((a, b) => tier(a) - tier(b) || (b.liquidity ?? 0) - (a.liquidity ?? 0))
    .slice(0, 20)
    .map((t) => ({ mint: t.id, symbol: t.symbol ?? "?", name: t.name ?? "", logo: t.icon, decimals: t.decimals!, program: t.tokenProgram!, verified: !!t.isVerified, tags: t.tags ?? [], liquidity: t.liquidity, price: t.usdPrice, holders: t.holderCount }));
  // an address Jupiter's search does not answer for, but which is on the pair menu: the menu knows its name, logo and numbers
  if (address && !rows.length) {
    const m = mem?.quotes.find((x) => x.mint === ask);
    if (m) rows = [{ mint: m.mint, symbol: m.symbol, name: m.name, logo: m.logo, decimals: m.decimals, program: m.program, verified: m.verified, tags: m.tags, liquidity: m.liquidity, price: m.price, holders: m.holders }];
  }
  if (searchCache.size > 500) searchCache.clear();
  searchCache.set(key, { at: Date.now(), rows });
  return rows;
}

// CLI check: npx tsx src/quotes.ts
if (process.argv[1] && /quotes\.ts$/.test(process.argv[1])) {
  const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const l = await buildQuoteList(conn);
  const groups: Record<string, number> = {};
  for (const q of l.quotes) groups[q.group] = (groups[q.group] ?? 0) + 1;
  console.log(JSON.stringify({ count: l.count, solPrice: l.solPrice, groups }));
  for (const q of l.quotes.slice(0, 10)) console.log(`  ${q.symbol.padEnd(8)} ${q.name.slice(0, 24).padEnd(24)} ${q.group.padEnd(11)} liq ${Math.round(q.liquidity ?? 0)} raise85 ${q.raise85 ? (Number(q.raise85) / 10 ** q.decimals).toPrecision(4) : "-"} dec ${q.decimals}`);
  for (const g of ["stable", "lst", "stocks", "commodities", "leverage"] as const) console.log(`  ${g}: ${l.quotes.filter((q) => q.group === g).map((q) => q.symbol).join(" ")}`);
  console.log(`  unknown to Jupiter: ${l.quotes.filter((q) => q.symbol === "?").length}`);
}
