/**
 * A launch's files on COOP's own address (since 2026-10-17). The image and the metadata of a new token are still pinned to IPFS through
 * Pinata, and a copy of each is kept here under its CID. The address written into the token is `<public base>/ipfs/<cid>` on COOP's own
 * domain, so where the bytes are kept can change later (another pinning service, an object store, this disk) without breaking any token.
 * Why: the free public IPFS gateways (ipfs.io, dweb.link, w3s.link) refuse apps since September 2026, and a gateway on a provider's own
 * domain ties every token to that provider's account forever. The `/ipfs/<cid>` path keeps the address readable as IPFS, so an app that
 * resolves IPFS paths itself can still fetch the file from the network while it stays pinned.
 * Only files COOP pinned are served. A CID that is not here is asked once from the configured gateway, which must be the platform's own
 * dedicated gateway (it answers for its own account's files only), and kept; anything else is a 404. This is not an open gateway.
 * Tokens launched before this change keep their gateway addresses; nothing here touches them.
 */
import fs from "node:fs";
import path from "node:path";

/** A CID as Pinata returns them: version 0 (`Qm…`, base58) or version 1 in base32 (`bafk…`, `bafy…`). Nothing else reaches the disk. */
export const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})$/;
/** Only what a launch pins is ever kept: its image and its metadata. */
const KINDS: { ext: string; type: string; test: (b: Buffer) => boolean }[] = [
  { ext: "png", type: "image/png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: "jpg", type: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", type: "image/gif", test: (b) => b.subarray(0, 4).toString() === "GIF8" },
  { ext: "webp", type: "image/webp", test: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
  { ext: "json", type: "application/json", test: (b) => { try { const v = JSON.parse(b.toString("utf8")); return !!v && typeof v === "object"; } catch { return false; } } },
];
export const MAX_FILE_BYTES = 2_000_000;
const MISS_MS = 60_000, TIMEOUT_MS = 15_000;

export type StoredFile = { file: string; ext: string; type: string };
/** What a file is, judged by its bytes: an image COOP accepts, a JSON document, or nothing that is kept. */
export function kindOf(buf: Buffer): { ext: string; type: string } | null {
  const k = buf.length > 0 && buf.length <= MAX_FILE_BYTES ? KINDS.find((x) => x.test(buf)) : undefined;
  return k ? { ext: k.ext, type: k.type } : null;
}

export class FileStore {
  readonly dir: string;
  /** CIDs the gateway did not have, with the time it was asked: not asked again for a minute. */
  private misses = new Map<string, number>();
  private inflight = new Map<string, Promise<StoredFile | null>>();
  /** `store` = the API's store folder; `publicBase` = the address written into tokens (https://api.coopfam.xyz in production);
   *  `gateway` = the platform's own dedicated gateway, asked for a CID missing here (none: missing files are a 404). */
  constructor(store: string, readonly publicBase: string, readonly gateway?: string, private fetcher: typeof fetch = (...a) => globalThis.fetch(...a)) {
    this.dir = path.join(store, "ipfs");
  }
  url(cid: string): string { return `${this.publicBase}/ipfs/${cid}`; }
  /** The kept copy of a CID, or null. */
  find(cid: string): StoredFile | null {
    if (!CID.test(cid)) return null;
    for (const k of KINDS) { const file = path.join(this.dir, `${cid}.${k.ext}`); if (fs.existsSync(file)) return { file, ext: k.ext, type: k.type }; }
    return null;
  }
  /** Keep the bytes a launch just pinned under `cid`, written through a temporary file so that no reader ever sees half of one. */
  put(cid: string, buf: Buffer): StoredFile {
    if (!CID.test(cid)) throw new Error(`not a CID: ${cid}`);
    const k = kindOf(buf);
    if (!k) throw new Error("only PNG, JPEG, GIF and WebP images and JSON documents are kept");
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${cid}.${k.ext}`), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file);
    this.misses.delete(cid);
    return { file, ext: k.ext, type: k.type };
  }
  /** A CID from here, or else from the platform's own gateway, kept on the way. Null: not ours, or the gateway cannot give it now. */
  get(cid: string): Promise<StoredFile | null> {
    const have = this.find(cid);
    if (have) return Promise.resolve(have);
    if (!CID.test(cid) || !this.gateway) return Promise.resolve(null);
    const missed = this.misses.get(cid);
    if (missed && Date.now() - missed < MISS_MS) return Promise.resolve(null);
    let p = this.inflight.get(cid);
    if (!p) {
      p = this.fromGateway(cid).finally(() => this.inflight.delete(cid));
      this.inflight.set(cid, p);
    }
    return p;
  }
  private async fromGateway(cid: string): Promise<StoredFile | null> {
    try {
      const r = await this.fetcher(`${this.gateway}/ipfs/${cid}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); if (kindOf(buf)) return this.put(cid, buf); }
    } catch { /* the gateway is unreachable: a miss like any other */ }
    this.misses.set(cid, Date.now());
    return null;
  }
  /** The bytes behind an address on our own `/ipfs/` path, read here instead of over the network; null for any other address. */
  async readOwn(url: string): Promise<Buffer | null> {
    const prefix = `${this.publicBase}/ipfs/`;
    if (!url.startsWith(prefix)) return null;
    const f = await this.get(url.slice(prefix.length));
    return f ? fs.readFileSync(f.file) : null;
  }
}
