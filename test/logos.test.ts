// Logos served from our own store: fetched once, bytes checked against the type, the published address switches to ours once cached.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Logos, looksLike } from "../src/logos.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const MINT = "2Pk5wVPa8jTm9m9QuNuqFDG98bZB4QJAX49iHu6vetM8", QUOTE = "So11111111111111111111111111111111111111112";
const stub = (handler: (url: string) => { status: number; type: string; body: Buffer | string }) => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: any) => { calls.push(String(url)); const r = handler(String(url)); return new Response(r.body as any, { status: r.status, headers: { "content-type": r.type } }); }) as any;
  return calls;
};

test("bytes are checked against the type", () => {
  assert.ok(looksLike("png", PNG)); assert.ok(!looksLike("jpg", PNG)); assert.ok(looksLike("svg", Buffer.from("<svg xmlns='x'></svg>"))); assert.ok(!looksLike("png", Buffer.from("<html>")));
});

test("a logo is fetched once, stored by mint, and the published address becomes ours", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coop-logos-"));
  const calls = stub(() => ({ status: 200, type: "image/png", body: PNG }));
  const l = new Logos(dir);
  assert.equal(l.url("https://api.example", MINT, "https://gateway/ipfs/abc"), "https://gateway/ipfs/abc", "the source until the fetch lands");
  assert.equal(await l.fetch(MINT, "https://gateway/ipfs/abc"), "png");
  assert.ok(fs.existsSync(path.join(dir, "logos", `${MINT}.png`)));
  assert.equal(l.url("https://api.example", MINT, "https://gateway/ipfs/abc"), `https://api.example/logo/${MINT}.png`);
  await l.fetch(MINT, "https://gateway/ipfs/abc");
  assert.equal(calls.length, 1, "fetched once");
  const again = new Logos(dir); assert.equal(again.ext(MINT), "png", "found on disk after a restart");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an error page sent as an image is refused and the failure is remembered", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coop-logos-"));
  const calls = stub(() => ({ status: 200, type: "image/png", body: "<html>gateway error</html>" }));
  const l = new Logos(dir);
  assert.equal(await l.fetch(QUOTE, "https://host/x.png"), null);
  assert.equal(l.url("https://api.example", QUOTE, "https://host/x.png"), "https://host/x.png");
  assert.equal(calls.length, 1, "not retried at once");
  assert.equal(fs.readdirSync(path.join(dir, "logos")).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("prime fetches a batch and skips what it has", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coop-logos-"));
  const calls = stub(() => ({ status: 200, type: "application/octet-stream", body: PNG }));
  const l = new Logos(dir);
  await l.prime([{ mint: MINT, src: "https://a/1" }, { mint: QUOTE, src: "https://a/2" }, { mint: MINT, src: "https://a/1" }, { mint: "not-a-mint", src: "https://a/3" }, { mint: QUOTE, src: null }]);
  assert.equal(calls.length, 2); assert.equal(l.ext(MINT), "png", "the bytes decide the type when the header is vague"); assert.equal(l.ext(QUOTE), "png");
  fs.rmSync(dir, { recursive: true, force: true });
});
