import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MetaJsonCache, NAMES, immutableAddress, keepFile, ownFile } from "../src/launchfiles.js";

const BASE = "https://api.coopfam.xyz";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7c6a1c70000000049454e44ae426082", "hex");
const IPFS = "https://gw.example/ipfs/bafkreifplv5e4u7z2apxr3s3ggjopf2gxrnzgu5ub7hy4vlxuhrxyn6aky";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coop-launchfiles-"));
const counting = (body: unknown, status = 200) => { const f = Object.assign(async () => { f.calls++; return new Response(JSON.stringify(body), { status }); }, { calls: 0 }); return f; };

test("a launch's file is kept under the hash of its bytes, once", () => {
  const store = tmp();
  const a = keepFile(store, "img", PNG, "png"), b = keepFile(store, "img", PNG, "png");
  assert.equal(a, b);
  assert.match(a, NAMES.img);
  assert.deepEqual(fs.readFileSync(path.join(store, "img", a)), PNG);
  assert.deepEqual(fs.readdirSync(path.join(store, "img")), [a], "no temporary file is left behind");
  assert.throws(() => keepFile(store, "meta", PNG, "png"), "a metadata name must end in .json");
});

test("our own addresses map to kept files; other hosts, odd names and missing files do not", () => {
  const store = tmp();
  const name = keepFile(store, "meta", Buffer.from('{"name":"T"}'), "json");
  assert.equal(ownFile(store, BASE, `${BASE}/meta/${name}`), path.join(store, "meta", name));
  assert.equal(ownFile(store, BASE, `https://other.example/meta/${name}`), null);
  assert.equal(ownFile(store, BASE, `${BASE}/meta/../registry/x.json`), null);
  assert.equal(ownFile(store, BASE, `${BASE}/meta/${"0".repeat(32)}.json`), null);
});

test("IPFS paths and our own files cannot change; any other address can", () => {
  assert.ok(immutableAddress(IPFS, BASE));
  assert.ok(immutableAddress("https://purple.example.mypinata.cloud/ipfs/QmQr3Fz4h1etNsF7oLGMRHiCzhB5y9a7GjyodnF7zLHK1g", BASE));
  assert.ok(immutableAddress(`${BASE}/meta/${"a".repeat(32)}.json`, BASE));
  assert.equal(immutableAddress("https://dev.example/token.json", BASE), false);
  assert.equal(immutableAddress("https://gw.example/ipfs/not-a-cid", BASE), false);
});

test("an IPFS metadata address is fetched once, then read from memory, and after a restart from disk", async () => {
  const store = tmp(), f = counting({ name: "Old token", image: "x" });
  const c1 = new MetaJsonCache(store, BASE, { fetcher: f as unknown as typeof fetch });
  assert.deepEqual(await c1.get(IPFS), { name: "Old token", image: "x" });
  await Promise.all([c1.get(IPFS), c1.get(IPFS)]);
  assert.equal(f.calls, 1);
  const c2 = new MetaJsonCache(store, BASE, { fetcher: f as unknown as typeof fetch });
  assert.deepEqual(await c2.get(IPFS), { name: "Old token", image: "x" });
  assert.equal(f.calls, 1, "a restarted API reads the kept copy, not the gateway");
});

test("our own metadata is read from the store without any request", async () => {
  const store = tmp(), f = counting({});
  const name = keepFile(store, "meta", Buffer.from('{"name":"New token"}'), "json");
  assert.deepEqual(await new MetaJsonCache(store, BASE, { fetcher: f as unknown as typeof fetch }).get(`${BASE}/meta/${name}`), { name: "New token" });
  assert.equal(f.calls, 0);
});

test("another address is read again after a day, and a failed read keeps the last good copy", async () => {
  let now = 0, ok = true;
  const f = Object.assign(async () => { f.calls++; return ok ? new Response(JSON.stringify({ n: f.calls })) : new Response("down", { status: 503 }); }, { calls: 0 });
  const c = new MetaJsonCache(tmp(), BASE, { fetcher: f as unknown as typeof fetch, now: () => now });
  assert.deepEqual(await c.get("https://dev.example/token.json"), { n: 1 });
  now = 23 * 3_600_000; assert.deepEqual(await c.get("https://dev.example/token.json"), { n: 1 });
  now = 25 * 3_600_000; assert.deepEqual(await c.get("https://dev.example/token.json"), { n: 2 });
  ok = false; now = 50 * 3_600_000; assert.deepEqual(await c.get("https://dev.example/token.json"), { n: 2 });
});

test("a first read that fails is not kept: the next call asks again", async () => {
  let ok = false;
  const f = Object.assign(async () => { f.calls++; return ok ? new Response('{"name":"Back"}') : new Response("down", { status: 502 }); }, { calls: 0 });
  const c = new MetaJsonCache(tmp(), BASE, { fetcher: f as unknown as typeof fetch });
  assert.equal(await c.get(IPFS), null);
  ok = true;
  assert.deepEqual(await c.get(IPFS), { name: "Back" });
  assert.equal(f.calls, 2);
});
