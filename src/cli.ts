import fs from "node:fs";
import "dotenv/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { tokenAccounts, aggregateByOwner } from "./snapshot.js";
import { withheldOf, mintWithheld } from "./sweep.js";
import { runEpoch } from "./epoch.js";
import { primePrices } from "./jupiter.js";
import { sinkPayoutMint } from "./config.js";
import { Ledger } from "./ledger.js";
import { verifyEpoch } from "./verify.js";
import { runFees } from "./fees.js";

const [cmd, arg, ...rest] = process.argv.slice(2);
const cfgPath = process.env.ENGINE_CONFIG || "engine.config.json";
const cfg = loadConfig(cfgPath);
const usage = "usage: tsx src/cli.ts tokens | withheld <SYMBOL|mint> | snapshot <SYMBOL|mint> | epoch <SYMBOL|mint|--all> [--execute] | verify <SYMBOL|mint> <epoch> | fees [--all|<SYMBOL|mint>] [--execute]";
const execute = process.argv.includes("--execute");
const loadOperator = () => (execute ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.OPERATOR_KEYPAIR!, "utf8")))) : undefined);
/** The operator's public key for dry runs: from OPERATOR_PUBKEY, else the public half of the keypair file, else the known COOP operator. */
const operatorPubkey = () => new PublicKey(process.env.OPERATOR_PUBKEY || (process.env.OPERATOR_KEYPAIR && fs.existsSync(process.env.OPERATOR_KEYPAIR) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.OPERATOR_KEYPAIR, "utf8")))).publicKey.toBase58() : "9dZcuWdTRjStMFNpQGDsSUZvTBkhrGZXxFvNMkjbpYKv"));
const conn = new Connection(cfg.rpc, "confirmed");
const GRACE_MS = 5 * 60_000; // cron jitter: an epoch due at 18:00:00 whose predecessor ran at 12:00:09 still counts as due

if (cmd === "fees") {
  // Once a day (scripts/run-fees.sh): claim the creator fees of graduated pools and forward the dev's share (src/fees.ts). Dry run unless --execute.
  const platformWallet = process.env.PLATFORM_FEE_WALLET ? new PublicKey(process.env.PLATFORM_FEE_WALLET) : undefined;
  const only = arg && !arg.startsWith("--") ? arg : undefined;
  const r = await runFees(cfg, { dryRun: !execute, operator: loadOperator(), operatorPubkey: operatorPubkey(), platformWallet, only });
  console.log(`[fees] ${new Date().toISOString()} forwarded ${r.forwarded.length}, waiting ${r.waiting}, failed ${r.failed.length}${r.forwarded.length ? `: ${r.forwarded.join("; ")}` : ""}`);
  process.exit(r.failed.length ? 1 : 0);
}

if (cmd === "tokens") {
  for (const t of cfg.tokens) {
    const l = new Ledger(cfg.dataDir, t.mint);
    console.log(`${t.symbol.padEnd(8)} ${t.mint} quote ${t.quoteMint.slice(0, 6)} every ${t.epochHours}h sinks ${t.sinks.map((s) => `${s.type}:${s.share}`).join(",")} epochs ${l.lastEpoch()} last ${l.lastEpochRanAt()?.toISOString() ?? "-"}${t.registered ? ` (registered ${t.registered.at.slice(0, 10)} by ${t.registered.creator.slice(0, 6)})` : ""}`);
  }
  process.exit(0);
}

if (cmd === "epoch" && arg === "--all") {
  // one or two price requests for the whole run instead of two per token: every token's mint, quote and payout assets go into the cache first
  await primePrices(["So11111111111111111111111111111111111111112", ...cfg.tokens.flatMap((t) => [t.mint, t.quoteMint, ...[...t.sinks, ...(t.stages ?? []).flatMap((st: any) => st.sinks ?? [])].map((s) => sinkPayoutMint(s, t))])]);
  // Scheduler for cron: run every token whose interval has elapsed (or whose last execute run crashed), one after another.
  const operator = loadOperator();
  let failed = 0, ran = 0;
  // A rejection nobody awaited (a library's internal retry, a socket) must not kill the run for the tokens still to come: log it, count it, go on.
  process.on("unhandledRejection", (e: any) => { failed++; console.error(`[engine] unhandled rejection, run continues: ${e?.message || e}`); });
  for (const t of cfg.tokens) {
    const ledger = new Ledger(cfg.dataDir, t.mint);
    const unfinished = execute ? ledger.unfinishedEpoch() : null;
    const last = ledger.lastEpochRanAt();
    const due = unfinished !== null || !last || Date.now() - last.getTime() >= t.epochHours * 3_600_000 - GRACE_MS;
    if (!due) { console.log(`[${t.symbol}] not due (last epoch ${last!.toISOString()}, every ${t.epochHours} h)`); continue; }
    try { await runEpoch(cfg, t, { dryRun: !execute, operator, operatorPubkey: operatorPubkey() }); ran++; }
    catch (e: any) { failed++; console.error(`[${t.symbol}] FAILED: ${e?.message || e}`); }
    await new Promise((r) => setTimeout(r, 1500)); // a breath between tokens, to stay under the RPC's rate limit
  }
  // The operator pays every epoch's fees and the rent of every new token account; run-epochs.sh turns a LOW BALANCE line into an alert.
  const LOW = Number(process.env.OPERATOR_LOW_SOL || 0.05), CRITICAL = Number(process.env.OPERATOR_CRITICAL_SOL || 0.02);
  const opk = operator?.publicKey ?? operatorPubkey();
  const sol = await conn.getBalance(opk).then((l) => l / 1e9).catch(() => null);
  if (sol !== null) console.log(`[operator] ${opk.toBase58()} holds ${sol.toFixed(4)} SOL${sol < CRITICAL ? ` CRITICAL LOW BALANCE (under ${CRITICAL} SOL): payouts are about to fail, top it up now` : sol < LOW ? ` LOW BALANCE (under ${LOW} SOL): top it up, it pays every epoch's fees and the rent of new token accounts` : ""}`);
  console.log(`[all] ${new Date().toISOString()} ran ${ran}, failed ${failed}, tokens ${cfg.tokens.length}`);
  process.exit(failed ? 1 : 0);
}

const token = cfg.tokens.find((t) => t.symbol === arg || t.mint === arg);
if (!cmd || !token) { console.error(usage); process.exit(1); }

if (cmd === "withheld") {
  const rows = await tokenAccounts(conn, token.mint, cfg.heliusRpc);
  const w = await withheldOf(conn, rows.map((r) => r.address));
  const m = await mintWithheld(conn, new PublicKey(token.mint));
  console.log(`accounts ${rows.length}; withheld in accounts ${w.reduce((a, r) => a + r.withheld, 0n)} across ${w.length}; in mint ${m.withheld}; tax ${m.feeBps} bps; authority ${m.withdrawAuthority}`);
} else if (cmd === "snapshot") {
  const rows = await tokenAccounts(conn, token.mint, cfg.heliusRpc);
  const bal = aggregateByOwner(rows, new Set(token.exclusions));
  const sorted = [...bal.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1));
  const total = sorted.reduce((a, r) => a + r[1], 0n);
  console.log(`holders ${sorted.length}, total ${total}`);
  for (const [o, a] of sorted.slice(0, 15)) console.log(`  ${o} ${a} (${(Number(a * 10000n / total) / 100).toFixed(2)}%)`);
} else if (cmd === "epoch") {
  await runEpoch(cfg, token, { dryRun: !execute, operator: loadOperator(), operatorPubkey: operatorPubkey() });
} else if (cmd === "verify") {
  const n = Number(rest[0]);
  const recs = new Ledger(cfg.dataDir, token.mint).epochs().filter((e) => !n || e.epoch === n);
  for (const e of recs) { const v = verifyEpoch(e, token); console.log(`epoch ${e.epoch}: ${v.ok === null ? "not verifiable" : v.ok ? "OK" : "MISMATCH"}`, v.sinks.map((x) => `${x.index}:${x.type}=${x.ok === null ? `n/a (${x.reason})` : x.ok ? "ok" : "MISMATCH"}`).join(" ")); }
} else { console.error(usage); process.exit(1); }
void rest;
