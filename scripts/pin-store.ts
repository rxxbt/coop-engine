/** Pin every file in the local metadata store to IPFS (Pinata Files API, public network) as a backup of the API-served
 *  URIs already baked into tokens. Writes store/pins.json (file → CID). Run on the server: npx tsx scripts/pin-store.ts */
import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";
config({ path: ".env" }); config({ path: "api.env" });
const JWT = process.env.PINATA_JWT; const STORE = process.env.STORE_DIR || "store";
if (!JWT) { console.error("PINATA_JWT not set"); process.exit(1); }
const pinsPath = path.join(STORE, "pins.json");
const pins: Record<string, string> = fs.existsSync(pinsPath) ? JSON.parse(fs.readFileSync(pinsPath, "utf8")) : {};
const mime: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", json: "application/json" };
for (const sub of ["img", "meta"]) {
  const dir = path.join(STORE, sub);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    const key = `${sub}/${f}`;
    if (pins[key]) { console.log("already pinned", key, pins[key]); continue; }
    const buf = fs.readFileSync(path.join(dir, f));
    const fd = new FormData(); fd.append("file", new Blob([Uint8Array.from(buf)], { type: mime[f.split(".").pop()!] || "application/octet-stream" }), f); fd.append("network", "public");
    const r = await fetch("https://uploads.pinata.cloud/v3/files", { method: "POST", headers: { authorization: `Bearer ${JWT}` }, body: fd });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j?.data?.cid) { console.error("FAILED", key, r.status, JSON.stringify(j).slice(0, 160)); continue; }
    pins[key] = j.data.cid; console.log("pinned", key, "→", j.data.cid);
    fs.writeFileSync(pinsPath, JSON.stringify(pins, null, 1));
  }
}
console.log(`${Object.keys(pins).length} files pinned; map in ${pinsPath}`);
