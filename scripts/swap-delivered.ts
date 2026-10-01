/**
 * What did a swap deliver to the operator? Reads the confirmed transaction exactly as the engine does after a conversion.
 *   npx tsx scripts/swap-delivered.ts <signature> <outMint> [operatorPubkey]
 * Read-only. Useful to check the engine's RPC can read swap results, and to audit any conversion in a ledger.
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import { swapDelivered } from "../src/epoch.js";

const [sig, outMint, op] = process.argv.slice(2);
if (!sig || !outMint) { console.error("usage: tsx scripts/swap-delivered.ts <signature> <outMint> [operatorPubkey]"); process.exit(1); }
const cfg = loadConfig(process.env.ENGINE_CONFIG || "engine.config.json");
const conn = new Connection(cfg.rpc, "confirmed");
const got = await swapDelivered(conn, sig, new PublicKey(op || "9dZcuWdTRjStMFNpQGDsSUZvTBkhrGZXxFvNMkjbpYKv"), outMint);
console.log(got === null ? "not readable" : `delivered ${got} base units of ${outMint}`);
