// Every payment is sent exactly once, across runs: its signature is persisted before it is sent, and a resumed run settles it before
// building anything. These tests play a run that dies at each moment that matters against a simulated chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { Connection, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { fate, landed, sendOnce, timing, type Sent } from "../src/epoch.js";

timing.pollMs = 1; timing.waitMs = 300; timing.staleMs = 1;

type Outcome = "land" | "drop" | "stale" | "fail" | "land-unseen";
/** A chain that lands, drops, refuses or fails each send as told, and advances `step` blocks every time anyone asks for the height. */
function chain(outcomes: Outcome[], step = 10) {
  const c = { height: 1000, sends: [] as string[], landed: new Map<string, { err: unknown }>(), unseen: new Set<string>(), statusDown: false };
  const conn = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: c.height + 150 }),
    getBlockHeight: async () => (c.height += step),
    sendRawTransaction: async (raw: Uint8Array) => {
      const sig = bs58.encode(Transaction.from(raw).signature!);
      const o = outcomes[c.sends.length] ?? "drop";
      if (o === "stale") { outcomes.splice(c.sends.length, 1); throw new Error("Simulation failed. \nMessage: Transaction simulation failed: Blockhash not found."); }
      c.sends.push(sig);
      if (o === "land" || o === "land-unseen") c.landed.set(sig, { err: null });
      if (o === "land-unseen") c.unseen.add(sig); // landed, but the status lookup never shows it (a lagging node); the transaction itself is there
      if (o === "fail") c.landed.set(sig, { err: { InstructionError: [0, { Custom: 1 }] } });
      return sig;
    },
    getSignatureStatuses: async ([sig]: string[]) => {
      if (c.statusDown) throw new Error("fetch failed");
      const l = c.landed.get(sig);
      return { value: [l && !c.unseen.has(sig) ? { err: l.err, confirmationStatus: "finalized" } : null] };
    },
    getTransaction: async (sig: string) => { const l = c.landed.get(sig); return l ? { meta: { err: l.err } } : null; },
  };
  return { c, conn: conn as unknown as Connection };
}
const signer = Keypair.generate();
const ix = () => [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1000 })];
const quiet = () => {};
/** What a run persists: the pending payment of one sink, written through `keep` like the epoch's state file. */
const store = () => { const s: { pending?: Sent; writes: Sent[] } = { writes: [] }; return { s, keep: (p: Sent) => { s.pending = p; s.writes.push(p); } }; };

test("the signature is persisted before the transaction is sent", async () => {
  const { c, conn } = chain(["land"]);
  const { s, keep } = store();
  const sig = await sendOnce(conn, ix(), signer, (p) => { assert.equal(c.sends.length, 0, "persisted before sending"); keep(p); }, quiet);
  assert.equal(sig, c.sends[0]); assert.equal(s.pending?.sig, sig);
});

test("a run that dies after sending: the next run finds the payment landed and sends nothing", async () => {
  const { c, conn } = chain(["land"]);
  const { s, keep } = store();
  c.statusDown = true; // the payment goes out, then the RPC fails and the run stops before it could see the confirmation
  await assert.rejects(sendOnce(conn, ix(), signer, keep, quiet), /fetch failed/);
  assert.equal(c.sends.length, 1); assert.ok(c.landed.has(s.pending!.sig));
  c.statusDown = false; // next run
  const sig = await landed(conn, s.pending, quiet);
  assert.equal(sig, s.pending!.sig);
  assert.equal(c.sends.length, 1, "not sent a second time");
});

test("an RPC error while settling stops the run; it is never read as a failed payment", async () => {
  const { c, conn } = chain(["land"]);
  const { s, keep } = store();
  await sendOnce(conn, ix(), signer, keep, quiet);
  c.statusDown = true;
  await assert.rejects(landed(conn, s.pending, quiet), /fetch failed/);
});

test("a payment that never landed is forgotten only once its blockhash expired past the margin, then built again", async () => {
  const { c, conn } = chain(["drop", "land"], 5);
  const pending: Sent = { sig: bs58.encode(Buffer.alloc(64, 7)), lastValidBlockHeight: c.height + 10 };
  assert.equal(await landed(conn, pending, quiet), undefined);
  assert.ok(c.height > pending.lastValidBlockHeight + 30, "waited past the margin");
  const { keep } = store();
  await sendOnce(conn, ix(), signer, keep, quiet);
  assert.equal([...c.landed.keys()].length, 1, "exactly one payment landed");
});

test("a payment still in flight stops the run instead of being sent again", async () => {
  const { conn } = chain([], 0); // the height never moves: neither confirmed nor expired
  const pending: Sent = { sig: bs58.encode(Buffer.alloc(64, 9)), lastValidBlockHeight: 2000 };
  await assert.rejects(landed(conn, pending, quiet), /neither confirmed nor expired/);
});

test("a payment that failed on-chain moved nothing and is built again", async () => {
  const { c, conn } = chain(["fail"]);
  const { s, keep } = store();
  await assert.rejects(sendOnce(conn, ix(), signer, keep, quiet), /failed on-chain/);
  assert.equal(await landed(conn, s.pending, quiet), undefined);
  assert.equal(c.sends.length, 1);
});

test("in one run: an attempt that expired is sent again, and only one ever lands", async () => {
  const { c, conn } = chain(["drop", "land"]);
  const { s, keep } = store();
  const sig = await sendOnce(conn, ix(), signer, keep, quiet);
  assert.equal(c.sends.length, 2); assert.equal(sig, c.sends[1]); assert.equal(s.writes.length, 2);
  assert.equal([...c.landed.keys()].length, 1);
});

test("a send the RPC refused before sending (stale blockhash) is simply sent again", async () => {
  const { c, conn } = chain(["stale", "land"]);
  const { keep } = store();
  const sig = await sendOnce(conn, ix(), signer, keep, quiet);
  assert.equal(c.sends.length, 1); assert.equal(sig, c.sends[0]);
});

test("landed but invisible to the status lookup: the transaction itself is found, nothing is sent again", async () => {
  const { c, conn } = chain(["land-unseen"]);
  const { s, keep } = store();
  const sig = await sendOnce(conn, ix(), signer, keep, quiet);
  assert.equal(sig, s.pending!.sig); assert.equal(c.sends.length, 1);
  assert.equal(await fate(conn, s.pending!), "landed");
});
