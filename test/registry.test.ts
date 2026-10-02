// Registration waits for a pool its RPC cannot see yet (2026-10-02: a launch was refused "no pool" 3 s after it landed).
import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { canonical, verifyManifest, type Manifest } from "../src/registry.js";

const COOP_PLATFORM = "DEfEVZNPRvQGCpKq19BQ5dpB2hmGVFJ4y1ewPSFz22y5", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
function signed() {
  const dev = Keypair.generate(), mint = Keypair.generate().publicKey.toBase58();
  const manifest: Manifest = { version: 1, mint, symbol: "T", decimals: 6, quoteMint: USDC, platformId: COOP_PLATFORM, creator: dev.publicKey.toBase58(),
    sinks: [{ type: "creator", share: 1, wallet: dev.publicKey.toBase58() }], epochHours: 1, exclusions: [], createdAt: new Date().toISOString() } as Manifest;
  return { manifest, signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(canonical(manifest)), dev.secretKey)) };
}
/** A connection on which no account exists (no pool will ever show up); counts the lookups. */
function emptyChain() { const asked: string[] = []; return { asked, conn: { getAccountInfo: async (k: PublicKey) => { asked.push(k.toBase58()); return null; } } as unknown as Connection }; }

test("a pool that never shows up is looked for again, then refused as before", async () => {
  const { manifest, signature } = signed(), chain = emptyChain();
  await assert.rejects(verifyManifest(chain.conn, manifest, signature, { platformIds: [COOP_PLATFORM], operator: COOP_PLATFORM, poolWait: { tries: 3, ms: 5 } }), /no LaunchLab pool exists/);
  const pool = chain.asked[chain.asked.length - 1];
  assert.equal(chain.asked.filter((k) => k === pool).length, 4); // the first look plus three more
});

test("a bad signature is refused before any waiting", async () => {
  const { manifest } = signed(), chain = emptyChain();
  const other = bs58.encode(nacl.sign.detached(new TextEncoder().encode("something else"), Keypair.generate().secretKey));
  await assert.rejects(verifyManifest(chain.conn, manifest, other, { platformIds: [COOP_PLATFORM], operator: COOP_PLATFORM, poolWait: { tries: 3, ms: 5 } }), /signature does not verify/);
  assert.equal(chain.asked.length, 1); // only the creator wallet check ran
});
