/**
 * COOP engine API: metadata hosting for the launch form, token registration (signed manifest +
 * on-chain checks), read-only access to the registry and the payout ledgers, market/holder data for
 * token pages, and an RPC proxy so the public app never depends on a public RPC's limits.
 * Plain node:http, no framework. Binds to 127.0.0.1 by default; Caddy (TLS) in front for the public.
 *
 *   npx tsx src/api.ts   # env: API_PORT, API_HOST, PUBLIC_BASE, SITE_BASE, CORS_ORIGINS, STORE_DIR, PLATFORM_IDS,
 *                        #      OPERATOR_PUBKEY (or OPERATOR_KEYPAIR), PINATA_JWT + IPFS_GATEWAY (optional),
 *                        #      ALLOW_LOCAL_META=1 (dev only: allow uploads when PUBLIC_BASE is a local address), ENGINE_ID
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata, getTransferFeeConfig, unpackMint } from "@solana/spl-token";
import { LAUNCHPAD_PROGRAM, LaunchpadPool, getPdaLaunchpadPoolId } from "@raydium-io/raydium-sdk-v2";
import { loadConfig, registryDir, sinkPayoutMint, type EngineConfig, type TokenConfig } from "./config.js";
import { verifyManifest, saveToken, type Manifest } from "./registry.js";
import { Ledger, type EpochRecord } from "./ledger.js";
import { mintWithheld } from "./sweep.js";
import { tokenAccounts, aggregateByOwner } from "./snapshot.js";
import { verifyEpoch } from "./verify.js";
import { getQuotes, searchAssets, quotesNow } from "./quotes.js";
import { quote as jupQuote } from "./jupiter.js";
import { agedWeight, allocate, isAged, type AgedRule } from "./rules.js";
import type { Rule } from "./config.js";

const PORT = Number(process.env.API_PORT || 8787);
const HOST = process.env.API_HOST || "127.0.0.1";
const PUBLIC_BASE = (process.env.PUBLIC_BASE || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const SITE_BASE = (process.env.SITE_BASE || "http://127.0.0.1:5173").replace(/\/$/, "");
const ORIGINS = (process.env.CORS_ORIGINS || "http://127.0.0.1:5173,http://localhost:5173").split(",").map((s) => s.trim());
const STORE = process.env.STORE_DIR || "store";
const PLATFORM_IDS = (process.env.PLATFORM_IDS || "DEfEVZNPRvQGCpKq19BQ5dpB2hmGVFJ4y1ewPSFz22y5,BWk6ALyW2yj1tud1v7Dr4SQzYGprA6na1xRhiv2tZoNG,Cd3DhizoqEUwMhpHiqF4wcFFocq6QCDZEHU6UvRnJY21").split(",").map((s) => s.trim());
const OPERATOR = process.env.OPERATOR_PUBKEY || (process.env.OPERATOR_KEYPAIR && fs.existsSync(process.env.OPERATOR_KEYPAIR)
  ? new PublicKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.OPERATOR_KEYPAIR, "utf8"))).slice(32)).toBase58()
  : "9dZcuWdTRjStMFNpQGDsSUZvTBkhrGZXxFvNMkjbpYKv");
const PINATA_JWT = process.env.PINATA_JWT;
const IPFS_GATEWAY = (process.env.IPFS_GATEWAY || "https://gateway.pinata.cloud").replace(/\/$/, "");
const ENGINE_ID = process.env.ENGINE_ID || os.hostname();
const LOCAL_BASE = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i.test(PUBLIC_BASE);
const ALLOW_LOCAL_META = process.env.ALLOW_LOCAL_META === "1";
const MAX_BODY = 2_000_000, MAX_IMAGE = 1_000_000;
const RPC_DAILY_CAP = Number(process.env.RPC_DAILY_CAP || 20_000);
const cfgPath = process.env.ENGINE_CONFIG || "engine.config.json";
const CPMM_AUTH = "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL";
const VAULT_AUTH = PublicKey.findProgramAddressSync([Buffer.from("vault_auth_seed")], LAUNCHPAD_PROGRAM)[0].toBase58();
/** JSON-RPC methods the browser app is allowed to relay through /rpc (reads, simulation, sending; nothing heavy). */
const RPC_METHODS = new Set(["getAccountInfo", "getMultipleAccounts", "getBalance", "getLatestBlockhash", "isBlockhashValid", "getEpochInfo", "getSlot", "getBlockHeight",
  "getMinimumBalanceForRentExemption", "getTokenAccountBalance", "getTokenAccountsByOwner", "getTokenSupply", "getTokenLargestAccounts", "simulateTransaction", "sendTransaction",
  "getSignatureStatuses", "getTransaction", "getRecentPrioritizationFees", "getFeeForMessage", "getVersion", "getHealth", "getGenesisHash", "getRecentBlockhash", "getParsedTokenAccountsByOwner"]);

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
const cfg = () => loadConfig(cfgPath); // re-read per request: the registry grows while the server runs
const conn = new Connection(cfg().rpc, "confirmed");

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const json = (res: http.ServerResponse, status: number, body: unknown, cache?: number) => { res.writeHead(status, { "content-type": "application/json", ...(cache ? { "cache-control": `public, max-age=${cache}` } : {}) }); res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v))); };

// per-IP limiters: writes 10 per 10 min; rpc 600 per 5 min
const buckets = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now); buckets.set(key, arr);
  return arr.length > max;
}
async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, "body too large (2 MB max)")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new HttpError(400, "body is not JSON")); } });
    req.on("error", reject);
  });
}
const cache = new Map<string, { at: number; data: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttlMs) return c.data as T;
  const data = await fn(); cache.set(key, { at: Date.now(), data }); return data;
}

const MAGIC: [string, string, (b: Buffer) => boolean][] = [
  ["image/png", "png", (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ["image/jpeg", "jpg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", "gif", (b) => b.subarray(0, 4).toString() === "GIF8"],
  ["image/webp", "webp", (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP"],
];
const str = (v: unknown, max: number, name: string, required = false) => {
  if (v === undefined || v === null || v === "") { if (required) throw new HttpError(400, `${name} is required`); return undefined; }
  if (typeof v !== "string" || v.length > max) throw new HttpError(400, `${name} must be a string of at most ${max} characters`);
  return v.trim();
};
/** Pin a file to IPFS through Pinata. Tries the current Files API first (public network), then the legacy pinning API; returns the CID. */
async function pinBytes(buf: Buffer, name: string, mime: string): Promise<string> {
  const fd = new FormData();
  fd.append("file", new Blob([Uint8Array.from(buf)], { type: mime }), name);
  fd.append("network", "public");
  const v3 = await fetch("https://uploads.pinata.cloud/v3/files", { method: "POST", headers: { authorization: `Bearer ${PINATA_JWT}` }, body: fd }).catch(() => null);
  if (v3?.ok) { const j: any = await v3.json(); if (j?.data?.cid) return j.data.cid as string; }
  const fd2 = new FormData();
  fd2.append("file", new Blob([Uint8Array.from(buf)], { type: mime }), name);
  const legacy = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: { authorization: `Bearer ${PINATA_JWT}` }, body: fd2 });
  const j: any = await legacy.json().catch(() => ({}));
  if (!legacy.ok || !j.IpfsHash) throw new HttpError(502, `pinning failed: files api ${v3?.status ?? "unreachable"}, legacy ${legacy.status} ${JSON.stringify(j).slice(0, 160)}`);
  return j.IpfsHash as string;
}

/** Only http(s) URLs with a real host, no credentials; everything else is refused (a bad link is baked into the token forever). */
function cleanUrl(v: string | undefined, name: string): string | undefined {
  if (!v) return undefined;
  let u: URL; try { u = new URL(v); } catch { throw new HttpError(400, `${name} must be a full https:// address`); }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname)) throw new HttpError(400, `${name} must be an https:// address with a real domain`);
  return u.toString();
}
/** X and Telegram links are rebuilt from the handle, so they can only ever point at x.com or t.me. */
function cleanHandleUrl(v: string | undefined, name: "twitter" | "telegram"): string | undefined {
  if (!v) return undefined;
  const m = name === "twitter" ? v.match(/^(?:https?:\/\/(?:www\.)?(?:x|twitter)\.com\/)?@?([A-Za-z0-9_]{1,15})\/?$/) : v.match(/^(?:https?:\/\/(?:www\.)?t\.me\/)?@?([A-Za-z0-9_]{5,32})\/?$/);
  if (!m) throw new HttpError(400, name === "twitter" ? "X handle: 1–15 letters, digits or underscores" : "Telegram: 5–32 letters, digits or underscores");
  return name === "twitter" ? `https://x.com/${m[1]}` : `https://t.me/${m[1]}`;
}

/** POST /upload: { name, symbol, description?, image: data URL, website?, twitter?, telegram? } → { uri, image, hosted } */
async function upload(body: any) {
  if (LOCAL_BASE && !ALLOW_LOCAL_META) throw new HttpError(400, `this API would host the metadata at ${PUBLIC_BASE}, a local address that would be baked into the token forever; use the public API (https://api.coopfam.xyz)`);
  const name = str(body.name, 32, "name", true)!, symbol = str(body.symbol, 10, "symbol", true)!;
  const description = str(body.description, 1000, "description") ?? "";
  const website = cleanUrl(str(body.website, 200, "website"), "website"), twitter = cleanHandleUrl(str(body.twitter, 200, "twitter"), "twitter"), telegram = cleanHandleUrl(str(body.telegram, 200, "telegram"), "telegram");
  const m = typeof body.image === "string" && body.image.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new HttpError(400, "image must be a PNG, JPEG, GIF or WebP data URL");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_IMAGE) throw new HttpError(413, "image must be at most 1 MB");
  const kind = MAGIC.find(([mime, , test]) => mime === m[1] && test(buf));
  if (!kind) throw new HttpError(400, "image bytes do not match the declared type");
  const [mime, ext] = kind;
  const id = createHash("sha256").update(buf).digest("hex").slice(0, 32);
  let imageUrl: string, hosted = "coop server";
  if (PINATA_JWT) {
    imageUrl = `${IPFS_GATEWAY}/ipfs/${await pinBytes(buf, `${id}.${ext}`, mime)}`; hosted = "ipfs";
  } else {
    fs.mkdirSync(path.join(STORE, "img"), { recursive: true });
    fs.writeFileSync(path.join(STORE, "img", `${id}.${ext}`), buf);
    imageUrl = `${PUBLIC_BASE}/img/${id}.${ext}`;
  }
  const meta: Record<string, unknown> = { name, symbol, description, image: imageUrl, properties: { files: [{ uri: imageUrl, type: mime }], category: "image" } };
  if (website) meta.external_url = website;
  const ext2: Record<string, string> = {}; if (website) ext2.website = website; if (twitter) ext2.twitter = twitter; if (telegram) ext2.telegram = telegram;
  if (Object.keys(ext2).length) meta.extensions = ext2;
  const text = JSON.stringify(meta, null, 1);
  let uri: string;
  if (PINATA_JWT) uri = `${IPFS_GATEWAY}/ipfs/${await pinBytes(Buffer.from(text, "utf8"), `${symbol}-metadata.json`, "application/json")}`;
  else {
    const mid = createHash("sha256").update(text).digest("hex").slice(0, 32);
    fs.mkdirSync(path.join(STORE, "meta"), { recursive: true });
    fs.writeFileSync(path.join(STORE, "meta", `${mid}.json`), text);
    uri = `${PUBLIC_BASE}/meta/${mid}.json`;
  }
  return { uri, image: imageUrl, hosted };
}

function publicToken(t: TokenConfig, dataDir: string) {
  const l = new Ledger(dataDir, t.mint);
  const epochs = l.epochs();
  const last = epochs[epochs.length - 1];
  const qi = quotesNow()?.quotes.find((q) => q.mint === t.quoteMint);
  return { mint: t.mint, symbol: t.symbol, quoteMint: t.quoteMint, quote: qi ? { symbol: qi.symbol, decimals: qi.decimals, logo: qi.logo ?? null } : null, decimals: t.decimals, epochHours: t.epochHours, sinks: t.sinks, exclusions: t.exclusions, registered: t.registered ?? null, hidden: !!t.hidden,
    ledger: { epochs: epochs.length, lastRanAt: last?.ranAt ?? null, lastWithdrawn: last?.tax.withdrawn ?? null, unfinishedEpoch: l.unfinishedEpoch() } };
}

/** Token-2022 metadata lives in the mint itself (LaunchLab uses the metadata extension, not a Metaplex account); the URI's JSON adds description, image and links. */
async function metadata(t: TokenConfig) {
  return cached(`meta:${t.mint}`, 10 * 60_000, async () => {
    const tm = await getTokenMetadata(conn, new PublicKey(t.mint), "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);
    if (!tm) return null;
    let j: any = null;
    if (/^https?:\/\//.test(tm.uri)) { try { const r = await fetch(tm.uri, { signal: AbortSignal.timeout(6000) }); if (r.ok) j = await r.json(); } catch { /* unreachable URI */ } }
    return { name: tm.name, symbol: tm.symbol, uri: tm.uri, uriLocal: /^https?:\/\/(localhost|127\.|10\.|192\.168\.)/.test(tm.uri),
      description: j?.description ?? null, image: j?.image ?? null, website: j?.external_url ?? j?.extensions?.website ?? null, twitter: j?.extensions?.twitter ?? null, telegram: j?.extensions?.telegram ?? null };
  });
}
const poolIdOf = (t: TokenConfig) => getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, new PublicKey(t.mint), new PublicKey(t.quoteMint)).publicKey;
/** Price, market cap, liquidity and progress from the pool's constant-product state (virtual + real reserves) and the quote's dollar price from the quote menu, so pages have numbers before any indexer does. */
function curveState(t: TokenConfig, data: Buffer) {
  const p: any = LaunchpadPool.decode(data);
  const raised = BigInt(p.realB.toString()), raise = BigInt(p.totalFundRaisingB.toString()), sold = BigInt(p.realA.toString()), totalSell = BigInt(p.totalSellA.toString());
  const vA = Number(p.virtualA.toString()) / 10 ** p.mintDecimalsA, vB = Number(p.virtualB.toString()) / 10 ** p.mintDecimalsB;
  const rA = Number(sold) / 10 ** p.mintDecimalsA, rB = Number(raised) / 10 ** p.mintDecimalsB;
  const priceQuote = vA - rA > 0 ? (vB + rB) / (vA - rA) : null;
  const supplyTokens = Number(p.supply.toString()) / 10 ** p.mintDecimalsA;
  const quoteUsd = quotesNow()?.quotes.find((q) => q.mint === t.quoteMint)?.price ?? null;
  return { status: p.status as number, raised: raised.toString(), raise: raise.toString(), sold: sold.toString(), totalSell: totalSell.toString(), supply: p.supply.toString(), quoteDecimals: p.mintDecimalsB as number,
    progressPct: raise > 0n ? Number((raised * 10000n) / raise) / 100 : 0, soldPct: totalSell > 0n ? Number((sold * 10000n) / totalSell) / 100 : 0,
    virtualA: p.virtualA.toString(), virtualB: p.virtualB.toString(),
    priceQuote, quoteUsd, priceUsd: priceQuote !== null && quoteUsd ? priceQuote * quoteUsd : null,
    mcapQuote: priceQuote !== null ? priceQuote * supplyTokens : null, mcapUsd: priceQuote !== null && quoteUsd ? priceQuote * supplyTokens * quoteUsd : null,
    liquidityUsd: quoteUsd ? rB * quoteUsd : null };
}
/** Curve state from the pool account plus GeckoTerminal's market data (it indexes LaunchLab curve pools; 30 s cache). */
async function market(t: TokenConfig) {
  return cached(`market:${t.mint}`, 30_000, async () => {
    const poolId = poolIdOf(t);
    const [poolInfo, gecko] = await Promise.all([
      conn.getAccountInfo(poolId),
      fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolId.toBase58()}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<any>,
    ]);
    const curve = poolInfo ? curveState(t, poolInfo.data) : null;
    const a = gecko?.data?.attributes;
    return { pool: poolId.toBase58(), curve, fetchedAt: new Date().toISOString(),
      gecko: a ? { priceUsd: a.base_token_price_usd, priceNative: a.base_token_price_native_currency, quoteUsd: a.quote_token_price_usd, fdvUsd: a.fdv_usd, reserveUsd: a.reserve_in_usd, volume: a.volume_usd, priceChange: a.price_change_percentage, txns: a.transactions, createdAt: a.pool_created_at } : null };
  });
}
/** The mint's total supply (1B for launches from the form; read from the chain so the percentages below are of the real supply). */
const mintSupply = (mint: string) => cached(`supply:${mint}`, 10 * 60_000, async () => BigInt((await conn.getTokenSupply(new PublicKey(mint))).value.amount));
/** What an epoch swept out of the mint and what it carried in from earlier epochs. Records written before 2026-09-29 stored the operator's
 *  whole balance as `withdrawn`, so after a kept pot the same tax read as swept again; for those the split is rebuilt from `withheldBefore`. */
function sweptOf(e: EpochRecord): { swept: string; carried: string } {
  const t = e.tax;
  if (t.available !== undefined) return { swept: t.withdrawn, carried: t.carried ?? "0" };
  const w = BigInt(t.withdrawn ?? "0"), before = BigInt(t.withheldBefore ?? "0");
  if (t.harvested === 0 && w > before) return { swept: before.toString(), carried: (w - before).toString() };
  return { swept: w.toString(), carried: "0" };
}
/** A payout asset's own transfer tax, if it is a Token-2022 mint with one (COOP: 300 bps). The form tells the dev that payouts in it arrive net of that tax. */
const assetInfo = (mint: string) => cached(`assetinfo:${mint}`, 10 * 60_000, async () => {
  const pk = new PublicKey(mint);
  const info = await conn.getAccountInfo(pk);
  if (!info) throw new HttpError(404, "no such mint");
  let transferFeeBps = 0;
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    try {
      const fee = getTransferFeeConfig(unpackMint(pk, info, TOKEN_2022_PROGRAM_ID));
      if (fee) { const epoch = BigInt((await conn.getEpochInfo()).epoch); transferFeeBps = (epoch >= fee.newerTransferFee.epoch ? fee.newerTransferFee : fee.olderTransferFee).transferFeeBasisPoints; }
    } catch { /* not a mint we can read: no tax known */ }
  }
  return { mint, program: info.owner.toBase58(), transferFeeBps };
});
/** The list page: every public token with its name and image, tax, curve state and the names of the assets its sinks pay in, newest first.
 *  One cached payload (30 s), one batched pool read, so the page never fans out into a request per token. */
async function tokenList(c: EngineConfig) {
  return cached("tokens:list", 30_000, async () => {
    const list = c.tokens.filter((t) => !t.hidden);
    const [metas, pools, menu] = await Promise.all([
      Promise.all(list.map((t) => metadata(t).catch(() => null))),
      list.length ? conn.getMultipleAccountsInfo(list.map(poolIdOf)) : Promise.resolve([] as (import("@solana/web3.js").AccountInfo<Buffer> | null)[]),
      getQuotes(conn, c.dataDir).then((q) => q.quotes).catch(() => quotesNow()?.quotes ?? []),
    ]);
    const assets: Record<string, { symbol: string; decimals: number }> = {};
    const wanted = new Set(list.flatMap((t) => [t.quoteMint, ...t.sinks.map((k) => sinkPayoutMint(k, t)).filter((m) => m !== t.mint)]));
    for (const m of wanted) {
      const q = menu.find((x) => x.mint === m);
      if (q) { assets[m] = { symbol: q.symbol, decimals: q.decimals }; continue; }
      const hit = (await searchAssets(m).catch(() => []))[0];
      if (hit && hit.mint === m) assets[m] = { symbol: hit.symbol, decimals: hit.decimals };
    }
    const tokens = list.map((t, i) => {
      const m = metas[i], info = pools[i];
      let curve: ReturnType<typeof curveState> | null = null;
      try { curve = info ? curveState(t, info.data) : null; } catch { /* a pool that does not decode is shown without numbers */ }
      return { ...publicToken(t, c.dataDir), name: m?.name ?? null, image: m?.image ?? null, description: m?.description ?? null, taxBps: t.registered?.feeBps ?? null,
        curve: curve ? { status: curve.status, progressPct: curve.progressPct, priceUsd: curve.priceUsd, mcapUsd: curve.mcapUsd, liquidityUsd: curve.liquidityUsd } : null };
    }).sort((a, b) => (b.registered?.at ?? "").localeCompare(a.registered?.at ?? ""));
    return { tokens, assets };
  });
}
/** Holder count and top 10 from a live snapshot (program vaults and the operator excluded; 5 min cache).
 *  Percentages are of the TOTAL SUPPLY, as explorers show them. Until 2026-09-28 they were of the sum held by wallets, which excludes the
 *  curve vault's 80–100% and made a 1.5% holder read as 56% (the first outside creator caught it). */
async function holders(t: TokenConfig, c: EngineConfig) {
  return cached(`holders:${t.mint}`, 5 * 60_000, async () => {
    const [rows, supply] = await Promise.all([tokenAccounts(conn, t.mint, c.heliusRpc), mintSupply(t.mint)]);
    const m = aggregateByOwner(rows, new Set([CPMM_AUTH, VAULT_AUTH, OPERATOR]));
    const total = [...m.values()].reduce((a, b) => a + b, 0n);
    const top = [...m.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 10).map(([owner, amount]) => ({ owner, amount: amount.toString(), pct: supply > 0n ? Number((amount * 10000n) / supply) / 100 : 0 }));
    return { count: m.size, total: total.toString(), supply: supply.toString(), top, at: new Date().toISOString() };
  });
}

/** Rule playground: how each rule would split a nominal 1 SOL pot over the token's holders right now (same exclusions and history as the engine; nothing persisted). */
async function preview(t: TokenConfig, c: EngineConfig) {
  return cached(`preview:${t.mint}`, 60_000, async () => {
    const rows = await tokenAccounts(conn, t.mint, c.heliusRpc);
    const treasuryWallets = t.sinks.flatMap((s) => (s.type === "treasury" ? [s.wallet] : []));
    const balances = aggregateByOwner(rows, new Set([...t.exclusions, ...treasuryWallets, OPERATOR, CPMM_AUTH, VAULT_AUTH]));
    const at = Date.now();
    const holders = new Ledger(c.dataDir, t.mint).applySnapshot(balances, false, at);
    const supply = await mintSupply(t.mint); // the balance column is a share of the total supply; the rule columns are shares of the pot
    const { context, value } = await conn.getLatestBlockhashAndContext("confirmed");
    const pot = 1_000_000_000n;
    // the holding-time column uses the token's own dials when it has them, else the form's defaults (24 h, +0.10×, cap 3×)
    const own = t.sinks.flatMap((s) => (s.type === "reflections" && isAged(s.rule) ? [s.rule] : []))[0];
    const aged: AgedRule = own ?? { type: "time-weighted", intervalHours: 24, step: 0.1, cap: 3 };
    const rules: { label: string; rule: Rule }[] = [
      { label: "pro-rata", rule: { type: "pro-rata" } },
      { label: `holding-time weighted, +${aged.step.toFixed(2)}× per ${aged.intervalHours} h, cap ${aged.cap.toFixed(2)}×`, rule: aged },
      { label: "never-sold bonus", rule: { type: "never-sold-bonus", bonusShare: 1 } }, // the whole pot to never-sold wallets, as the form registers it since 2026-09-29
      { label: "balance-weighted lottery, 5 winners", rule: { type: "lottery", winners: 5 } },
    ];
    const pctOf = (a: bigint, of: bigint) => (of > 0n ? Number((a * 10000n) / of) / 100 : 0);
    return {
      pot: pot.toString(), potLabel: "1 SOL", slot: context.slot, seed: value.blockhash, holderCount: holders.length, supply: supply.toString(),
      // `multiplier` = the wallet's effective holding-time multiplier right now (its lots averaged by size)
      holders: holders.sort((a, b) => (b.amount > a.amount ? 1 : -1)).slice(0, 25).map((h) => ({ owner: h.owner, amount: h.amount.toString(), pct: pctOf(h.amount, supply), epochsHeld: h.epochsHeld, everSold: h.everSold,
        multiplier: h.amount > 0n ? Number((agedWeight(aged, h, at) * 100n) / h.amount) / 10000 : 1 })),
      rules: rules.map(({ label, rule }) => { const a = allocate(rule, holders, pot, { seed: value.blockhash, at }); return { label, type: rule.type, eligible: a.eligible, allocations: [...a.allocations.entries()].sort((x, y) => (y[1] > x[1] ? 1 : -1)).slice(0, 25).map(([owner, amount]) => ({ owner, amount: amount.toString(), pct: pctOf(amount, pot) })) }; }),
    };
  });
}

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || "/", PUBLIC_BASE);
  const parts = url.pathname.split("/").filter(Boolean);
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "?";
  if (req.method === "GET" && parts.length === 1 && parts[0] === "health") return json(res, 200, { ok: true, engine: ENGINE_ID, local: LOCAL_BASE, operator: OPERATOR, platforms: PLATFORM_IDS, hosted: PINATA_JWT ? "ipfs" : "coop server", publicBase: PUBLIC_BASE });
  if (req.method === "POST" && parts.length === 1 && parts[0] === "rpc") {
    // browsers always send Origin on this cross-origin POST; bots must at least know to fake it, and per-IP plus daily caps protect the upstream quota
    const origin = req.headers.origin;
    if (!origin || !ORIGINS.includes(origin)) throw new HttpError(403, "the RPC relay serves the COOP app only");
    if (limited(`rpc:${ip}`, 300, 5 * 60_000)) throw new HttpError(429, "too many RPC requests; slow down");
    if (limited(`rpc:day:${new Date().toISOString().slice(0, 10)}`, RPC_DAILY_CAP, 24 * 3_600_000)) throw new HttpError(429, "the relay's daily budget is used up; try later");
    const body = await readBody(req);
    for (const call of Array.isArray(body) ? body : [body]) if (!call || typeof call.method !== "string" || !RPC_METHODS.has(call.method)) throw new HttpError(403, `RPC method not allowed: ${call?.method}`);
    const up = await fetch(cfg().rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(25_000) });
    const text = await up.text();
    res.writeHead(up.status, { "content-type": "application/json" }); return res.end(text);
  }
  if (req.method === "GET" && (parts[0] === "img" || parts[0] === "meta") && parts.length === 2) {
    if (!/^[a-f0-9]{32}\.(png|jpg|gif|webp|json)$/.test(parts[1])) throw new HttpError(404, "not found");
    const f = path.join(STORE, parts[0], parts[1]);
    if (!fs.existsSync(f)) throw new HttpError(404, "not found");
    const ext = parts[1].split(".").pop()!;
    const type = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", json: "application/json" }[ext]!;
    res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=31536000, immutable" });
    return fs.createReadStream(f).pipe(res);
  }
  if (req.method === "GET" && parts.length === 1 && parts[0] === "quotes") return json(res, 200, await getQuotes(conn, cfg().dataDir), 300);
  if (req.method === "GET" && (parts[0] === "communities" || parts[0] === "community")) {
    // curated profiles behind the ecosystem pages: engine/communities.json, edited by hand when a community joins
    let profiles: any[] = [];
    try { profiles = JSON.parse(fs.readFileSync(path.join(path.dirname(cfgPath), "communities.json"), "utf8")).profiles ?? []; } catch { /* no file yet */ }
    if (parts.length === 1) return json(res, 200, { profiles }, 120);
    const p = profiles.find((x) => x.mint === parts[1]);
    if (!p) throw new HttpError(404, "no profile for this token yet");
    return json(res, 200, p, 120);
  }
  if (req.method === "GET" && parts.length === 2 && parts[0] === "assetinfo") {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(parts[1])) throw new HttpError(400, "not a mint address");
    if (limited(`assetinfo:${ip}`, 120, 60_000)) throw new HttpError(429, "too many requests; slow down");
    return json(res, 200, await assetInfo(parts[1]), 600);
  }
  if (req.method === "GET" && parts.length === 1 && parts[0] === "assets") {
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length < 1 || q.length > 64 || !/^[\w .$\-]+$/.test(q)) throw new HttpError(400, "q: 1 to 64 plain characters");
    if (limited(`assets:${ip}`, 60, 60_000)) throw new HttpError(429, "too many searches; slow down");
    return json(res, 200, { assets: await searchAssets(q) }, 60);
  }
  if (req.method === "GET" && (parts[0] === "tokens" || parts[0] === "market" || parts[0] === "holders" || parts[0] === "ledger" || parts[0] === "preview" || parts[0] === "verify")) {
    const c = cfg();
    if (parts[0] === "tokens" && parts.length === 1) return json(res, 200, await tokenList(c), 30);
    const t = c.tokens.find((x) => x.mint === parts[1]);
    if (!t) throw new HttpError(404, "unknown token");
    if (parts[0] === "market") return json(res, 200, await market(t), 20);
    if (parts[0] === "holders") return json(res, 200, await holders(t, c), 120);
    if (parts[0] === "preview") return json(res, 200, await preview(t, c), 30);
    if (parts[0] === "verify" && parts.length === 3) {
      if (!/^\d{1,6}$/.test(parts[2])) throw new HttpError(404, "no such epoch");
      const f = path.join(c.dataDir, t.mint, `epoch-${Number(parts[2])}.json`);
      if (!fs.existsSync(f)) throw new HttpError(404, "no such epoch");
      return json(res, 200, verifyEpoch(JSON.parse(fs.readFileSync(f, "utf8")), t), 300);
    }
    if (parts[0] === "ledger" && parts.length === 3) {
      if (!/^\d{1,6}$/.test(parts[2])) throw new HttpError(404, "no such epoch");
      const f = path.join(c.dataDir, t.mint, `epoch-${Number(parts[2])}.json`);
      if (!fs.existsSync(f)) throw new HttpError(404, "no such epoch");
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
      return fs.createReadStream(f).pipe(res);
    }
    const l = new Ledger(c.dataDir, t.mint);
    const [fee, meta] = await Promise.all([mintWithheld(conn, new PublicKey(t.mint)).catch(() => null), metadata(t)]);
    const assets: Record<string, { symbol: string; decimals: number }> = {};
    try {
      const wanted = [t.quoteMint, ...t.sinks.map((k) => sinkPayoutMint(k, t)).filter((m) => m !== t.mint)]; // the quote plus every sink's payout asset
      const menu = (await getQuotes(conn, c.dataDir)).quotes;
      for (const m of new Set(wanted)) {
        const q = menu.find((x) => x.mint === m);
        if (q) { assets[m] = { symbol: q.symbol, decimals: q.decimals }; continue; }
        const hit = (await searchAssets(m).catch(() => []))[0];
        if (hit && hit.mint === m) assets[m] = { symbol: hit.symbol, decimals: hit.decimals };
      }
    } catch { /* names are a nicety; the page falls back to short mints */ }
    return json(res, 200, { ...publicToken(t, c.dataDir), engine: ENGINE_ID, metadata: meta, assets, tax: fee ? { bps: fee.feeBps, withheldNow: fee.withheld.toString(), authority: fee.withdrawAuthority } : null,
      epochs: l.epochs().map((e) => ({ epoch: e.epoch, ranAt: e.ranAt, withdrawn: e.tax.withdrawn, ...sweptOf(e), signatures: e.signatures, snapshotSlot: e.snapshot?.slot ?? null, holders: e.snapshot?.holders.length ?? null, verified: verifyEpoch(e, t).ok,
        sinks: (e.sinks as any[]).map((s) => ({ type: s.type, mode: s.mode, rule: s.rule?.type, payoutMint: s.payoutMint, wallet: s.wallet, asset: s.asset, pot: s.pot, converted: s.converted, paid: s.paid, deferred: s.deferred, entries: s.entries?.length, paidAmount: Array.isArray(s.entries) ? s.entries.reduce((a: bigint, e: any) => a + BigInt(e.amount ?? 0), 0n).toString() : undefined, root: s.root, resumed: s.resumed, patched: s.patched, kept: s.kept, keptWhy: s.keptWhy, keptIn: s.keptIn, lottery: s.lottery })) })) });
  }
  if (req.method === "POST" && parts.length === 1 && (parts[0] === "upload" || parts[0] === "register")) {
    // uploads and registrations count apart (10 each per IP per 10 minutes): a dev who retried a few launches, an upload each, must still be
    // able to register the one that went through
    if (limited(`${parts[0]}:${ip}`, 10, 10 * 60_000)) throw new HttpError(429, "too many requests; try again in ten minutes");
    const body = await readBody(req);
    if (parts[0] === "upload") { const r = await upload(body); log(`upload ${r.uri} (${ip})`); return json(res, 200, r); }
    const c = cfg();
    const manifest = body.manifest as Manifest, signature = body.signature;
    if (!manifest || typeof signature !== "string") throw new HttpError(400, "manifest and signature are required");
    let token: TokenConfig;
    try { token = await verifyManifest(conn, manifest, signature, { platformIds: PLATFORM_IDS, operator: OPERATOR }); }
    catch (e: any) { throw new HttpError(400, e?.message || String(e)); }
    // since 2026-09-30 the form signs the manifest BEFORE the launch (so the launch approval is the dev's last step) and sends the launch
    // signature beside it, unsigned: it is a pointer for the record, the pool itself was verified above
    if (token.registered && !token.registered.launchSig && typeof body.launchSig === "string" && /^[1-9A-HJ-NP-Za-km-z]{60,120}$/.test(body.launchSig)) token.registered.launchSig = body.launchSig;
    if (c.tokens.some((x) => x.mint === token.mint)) throw new HttpError(409, "this mint is already registered");
    // minimum holding is a dollar amount ; floor $2, so dust wallets are never in the snapshot
    for (const s of token.sinks) if (s.type === "reflections" && !(typeof s.minUsd === "number" && s.minUsd >= 2)) throw new HttpError(400, "every reflections sink needs a minimum holding of at least $2 (minUsd)");
    // SOL has no burn instruction; a burn sink buys and burns a token, or burns the launched token itself
    for (const s of token.sinks) if (s.type === "burn" && s.asset === "So11111111111111111111111111111111111111112") throw new HttpError(400, "a burn sink cannot burn SOL; pick a token to buy and burn, or burn the token itself");
    // every payout asset must be buyable: the engine converts directly or through SOL, so Jupiter has to route SOL → asset. Only a clear
    // "no route" refuses the registration; if Jupiter cannot be asked right now the registration goes through (the form checked too).
    for (const s of token.sinks) {
      const asset = sinkPayoutMint(s, token);
      if (asset === token.mint || asset === token.quoteMint || asset === "So11111111111111111111111111111111111111112") continue;
      try { await jupQuote("So11111111111111111111111111111111111111112", asset, 10_000_000n, 100); }
      catch (e: any) { if (/no routes? found|NO_ROUTES_FOUND|could not find any route/i.test(String(e?.message ?? e))) throw new HttpError(400, `Jupiter cannot buy the payout asset ${asset} with SOL, so the engine could not pay in it; pick another asset`); log(`register: route check for ${asset} skipped (${String(e?.message ?? e).slice(0, 80)})`); }
    }
    const file = saveToken(registryDir(c), token);
    log(`registered ${token.symbol} ${token.mint} by ${token.registered?.creator} → ${file} (${ip})`);
    return json(res, 200, { ok: true, mint: token.mint, engine: ENGINE_ID, local: LOCAL_BASE, tokenUrl: `${SITE_BASE}/#/t/${token.mint}`,
      note: LOCAL_BASE ? `registered with a LOCAL engine (${ENGINE_ID}) only; the production engine will not run it` : `The engine (${ENGINE_ID}) runs this token's first epoch within the hour and then every ${token.epochHours} h.` });
  }
  throw new HttpError(404, "not found");
}

http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) { res.setHeader("access-control-allow-origin", origin); res.setHeader("vary", "origin"); res.setHeader("access-control-allow-headers", "content-type, solana-client"); res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS"); }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  // uptime monitors and link checkers ask with HEAD: answer it like GET (Node sends the headers and drops the body)
  if (req.method === "HEAD") req.method = "GET";
  try { await route(req, res); }
  catch (e: any) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) log(`ERROR ${req.method} ${req.url}: ${e?.stack || e}`);
    json(res, status, { error: e?.message || "internal error" });
  }
}).listen(PORT, HOST, () => log(`COOP api ${ENGINE_ID} listening on http://${HOST}:${PORT} (public base ${PUBLIC_BASE}${LOCAL_BASE ? " [LOCAL]" : ""}, store ${STORE}, hosting ${PINATA_JWT ? "ipfs" : "local"}, operator ${OPERATOR})`));
