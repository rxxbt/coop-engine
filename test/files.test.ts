import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CID, FileStore, kindOf } from "../src/files.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7c6a1c70000000049454e44ae426082", "hex");
const META = Buffer.from(JSON.stringify({ name: "Test", symbol: "TEST", image: "https://api.coopfam.xyz/ipfs/bafkreifplv5e4u7z2apxr3s3ggjopf2gxrnzgu5ub7hy4vlxuhrxyn6aky" }));
const CID1 = "bafkreifplv5e4u7z2apxr3s3ggjopf2gxrnzgu5ub7hy4vlxuhrxyn6aky", CID0 = "QmQr3Fz4h1etNsF7oLGMRHiCzhB5y9a7GjyodnF7zLHK1g";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coop-files-"));
const answer = (status: number, body: Buffer) => (async () => new Response(new Uint8Array(body), { status })) as unknown as typeof fetch;

test("only CIDs pass: both versions, nothing that could leave the folder", () => {
  assert.ok(CID.test(CID1)); assert.ok(CID.test(CID0));
  for (const bad of ["../etc/passwd", `${CID1}/x`, CID1.toUpperCase(), "bafk", "", "Qm123"]) assert.equal(CID.test(bad), false, bad);
});

test("a file is judged by its bytes: images and JSON are kept, anything else is not", () => {
  assert.deepEqual(kindOf(PNG), { ext: "png", type: "image/png" });
  assert.deepEqual(kindOf(META), { ext: "json", type: "application/json" });
  assert.equal(kindOf(Buffer.from("<svg onload=alert(1)>")), null);
  assert.equal(kindOf(Buffer.alloc(0)), null);
});

test("a pinned file is kept under its CID and served from our own address", () => {
  const s = new FileStore(tmp(), "https://api.coopfam.xyz");
  assert.equal(s.url(CID1), `https://api.coopfam.xyz/ipfs/${CID1}`);
  assert.equal(s.find(CID1), null);
  s.put(CID1, PNG);
  const f = s.find(CID1)!;
  assert.equal(f.type, "image/png");
  assert.deepEqual(fs.readFileSync(f.file), PNG);
  assert.throws(() => s.put("../x", PNG));
  assert.throws(() => s.put(CID0, Buffer.from("not an image")));
});

test("a CID missing here is asked once from the platform's own gateway and kept", async () => {
  let asked = 0;
  const s = new FileStore(tmp(), "https://api.coopfam.xyz", "https://gw.example", (async (u: string) => { asked++; assert.equal(u, `https://gw.example/ipfs/${CID1}`); return new Response(new Uint8Array(PNG)); }) as unknown as typeof fetch);
  const [a, b] = await Promise.all([s.get(CID1), s.get(CID1)]);
  assert.equal(a?.type, "image/png"); assert.equal(b?.type, "image/png");
  assert.equal(asked, 1);
  await s.get(CID1);
  assert.equal(asked, 1, "the kept copy answers from now on");
});

test("a CID the gateway refuses is a 404, and is not asked again for a minute", async () => {
  let asked = 0;
  const s = new FileStore(tmp(), "https://api.coopfam.xyz", "https://gw.example", (async () => { asked++; return new Response("forbidden", { status: 403 }); }) as unknown as typeof fetch);
  assert.equal(await s.get(CID0), null);
  assert.equal(await s.get(CID0), null);
  assert.equal(asked, 1);
});

test("without a gateway a missing CID is simply not found; a gateway answer that is not an image or JSON is not kept", async () => {
  assert.equal(await new FileStore(tmp(), "https://api.coopfam.xyz").get(CID1), null);
  const s = new FileStore(tmp(), "https://api.coopfam.xyz", "https://gw.example", answer(200, Buffer.from("<html>hi</html>")));
  assert.equal(await s.get(CID1), null);
  assert.equal(s.find(CID1), null);
});

test("our own addresses are read from the store, any other address is left to the network", async () => {
  const s = new FileStore(tmp(), "https://api.coopfam.xyz");
  s.put(CID1, META);
  assert.deepEqual(await s.readOwn(`https://api.coopfam.xyz/ipfs/${CID1}`), META);
  assert.equal(await s.readOwn(`https://purple.example/ipfs/${CID1}`), null);
  assert.equal(await s.readOwn(`https://api.coopfam.xyz/ipfs/${CID0}`), null);
});
