/**
 * A launch's files on COOP's own address (since 2026-10-17). The launch form uploads the token's image and its metadata JSON; the API keeps
 * both in its store under the first 32 hex characters of their SHA-256 and writes `<public base>/img/<name>` and `<public base>/meta/<name>`
 * into the token. Nothing goes to a third party: the files depend on COOP's domain and server only, and the nightly backup copies them off
 * the server. A name is the hash of the bytes, so a file never changes once written.
 * Until 2026-10-17 every launch pinned both files to IPFS through Pinata, and those tokens carry the address of COOP's Pinata gateway for
 * good: that gateway must keep serving them.
 *
 * Also here: every token's metadata JSON, read once per address and kept. A token's metadata address never changes, IPFS content never
 * changes and COOP's own files never change, so such a JSON is fetched once and kept on disk; any other address is read again once a day.
 * Until 2026-10-17 the API read every token's JSON again every 10 minutes from COOP's Pinata gateway, about 7,000 requests a day.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", json: "application/json" };
/** The names the API writes and serves: 32 hex characters of the content's hash and the extension. Nothing else is ever opened. */
export const NAMES = { img: /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/, meta: /^[a-f0-9]{32}\.json$/ } as const;
export type Folder = keyof typeof NAMES;

/** Keep `buf` in `<store>/<folder>/` under the hash of its bytes, written through a temporary file; returns the file's name. */
export function keepFile(store: string, folder: Folder, buf: Buffer, ext: string): string {
  const name = `${createHash("sha256").update(buf).digest("hex").slice(0, 32)}.${ext}`;
  if (!NAMES[folder].test(name)) throw new Error(`not a ${folder} file name: ${name}`);
  const dir = path.join(store, folder), file = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file); }
  return name;
}

/** The kept file behind an address on our own `/img/` or `/meta/` path, or null: another host, a malformed name, or nothing kept. */
export function ownFile(store: string, publicBase: string, url: string): string | null {
  for (const folder of Object.keys(NAMES) as Folder[]) {
    const prefix = `${publicBase}/${folder}/`;
    if (!url.startsWith(prefix)) continue;
    const name = url.slice(prefix.length);
    if (!NAMES[folder].test(name)) return null;
    const file = path.join(store, folder, name);
    return fs.existsSync(file) ? file : null;
  }
  return null;
}

/** An address whose content cannot change: an IPFS path (`/ipfs/<cid>` on any gateway) or a file on COOP's own address. */
export function immutableAddress(uri: string, publicBase: string): boolean {
  if (/\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})(?:[/?#]|$)/.test(uri)) return true;
  return uri.startsWith(`${publicBase}/meta/`) || uri.startsWith(`${publicBase}/img/`);
}

type Opts = { fetcher?: typeof fetch; ttlMs?: number; timeoutMs?: number; now?: () => number; log?: (s: string) => void };

/** Token metadata JSON by address: our own files from the store, unchangeable addresses fetched once and kept on disk, any other address
 *  kept for a day. A failed read is not kept: the next call asks again, and a stale copy stands meanwhile. */
export class MetaJsonCache {
  private mem = new Map<string, { at: number; json: unknown }>();
  private inflight = new Map<string, Promise<unknown | null>>();
  constructor(private store: string, private publicBase: string, private opts: Opts = {}) {}
  private keptPath(uri: string) { return path.join(this.store, "metajson", `${createHash("sha256").update(uri).digest("hex")}.json`); }
  get(uri: string): Promise<unknown | null> {
    const now = (this.opts.now ?? Date.now)();
    const m = this.mem.get(uri), fixed = immutableAddress(uri, this.publicBase);
    if (m && (fixed || now - m.at < (this.opts.ttlMs ?? 24 * 3_600_000))) return Promise.resolve(m.json);
    let p = this.inflight.get(uri);
    if (!p) { p = this.load(uri, fixed, now, m?.json ?? null).finally(() => this.inflight.delete(uri)); this.inflight.set(uri, p); }
    return p;
  }
  private keep(uri: string, json: unknown, now: number): unknown { this.mem.set(uri, { at: now, json }); return json; }
  private async load(uri: string, fixed: boolean, now: number, stale: unknown | null): Promise<unknown | null> {
    const own = ownFile(this.store, this.publicBase, uri);
    if (own) { try { return this.keep(uri, JSON.parse(fs.readFileSync(own, "utf8")), now); } catch { return null; } }
    if (fixed) { try { return this.keep(uri, JSON.parse(fs.readFileSync(this.keptPath(uri), "utf8")), now); } catch { /* not kept yet */ } }
    if (!/^https?:\/\//.test(uri)) return null;
    try {
      const r = await (this.opts.fetcher ?? globalThis.fetch)(uri, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 6000) });
      if (!r.ok) return stale;
      const json = await r.json();
      if (!json || typeof json !== "object") return stale;
      if (fixed) { const f = this.keptPath(uri); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(`${f}.tmp`, JSON.stringify(json)); fs.renameSync(`${f}.tmp`, f); }
      this.opts.log?.(`metadata read ${fixed ? "once and kept" : "(read again in a day)"}: ${uri}`);
      return this.keep(uri, json, now);
    } catch { return stale; }
  }
}
