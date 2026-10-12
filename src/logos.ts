/**
 * Logos served from our own API: GET /logo/<mint>.<ext>. A token's image lives on an IPFS gateway and a pair's logo on whichever host
 * its issuer uses; browsers open few connections per host and the gateway answers slowly, so a list of fifty tokens took several
 * seconds to fill its logo boxes. Each logo is fetched once, kept in <store>/logos and served with a one-year cache header, so the
 * CDN in front of the API and the browser keep it.
 */
import fs from "node:fs";
import path from "node:path";

export const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };
export const MIME: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
const MAX_BYTES = 2_000_000, RETRY_MS = 10 * 60_000, TIMEOUT_MS = 8_000;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The bytes must be what the type says (an HTML error page served as image/png would otherwise be cached as a logo). */
export function looksLike(ext: string, b: Buffer): boolean {
  if (ext === "png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (ext === "jpg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === "gif") return b.subarray(0, 4).toString() === "GIF8";
  if (ext === "webp") return b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP";
  if (ext === "svg") return /<svg[\s>]/i.test(b.subarray(0, 4096).toString("utf8"));
  return false;
}

export class Logos {
  private dir: string;
  private known = new Map<string, string>();      // mint → extension of the cached file
  private failed = new Map<string, number>();     // mint → when a fetch last failed
  private inflight = new Map<string, Promise<string | null>>();
  constructor(store: string) {
    this.dir = path.join(store, "logos"); fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir)) { const m = f.match(/^([1-9A-HJ-NP-Za-km-z]{32,44})\.(png|jpg|gif|webp|svg)$/); if (m) this.known.set(m[1], m[2]); }
  }
  ext(mint: string): string | undefined { return this.known.get(mint); }
  file(mint: string, ext: string): string { return path.join(this.dir, `${mint}.${ext}`); }
  /** The address to publish for a mint whose image is at `src`: ours once the logo is cached, the source until then (a fetch starts in the background). */
  url(publicBase: string, mint: string, src: string | null | undefined): string | null {
    if (!src || !MINT.test(mint)) return src ?? null;
    const e = this.known.get(mint);
    if (e) return `${publicBase}/logo/${mint}.${e}`;
    const f = this.failed.get(mint);
    if (!(f && Date.now() - f < RETRY_MS)) void this.fetch(mint, src);
    return src;
  }
  /** Fetch and store once; resolves to the file's extension, or null when the source is not a usable image. */
  fetch(mint: string, src: string): Promise<string | null> {
    const known = this.known.get(mint); if (known) return Promise.resolve(known);
    let p = this.inflight.get(mint);
    if (!p) {
      p = this.fetchOnce(mint, src).then((e) => { if (e) { this.known.set(mint, e); this.failed.delete(mint); } else this.failed.set(mint, Date.now()); return e; })
        .catch(() => { this.failed.set(mint, Date.now()); return null; }).finally(() => this.inflight.delete(mint));
      this.inflight.set(mint, p);
    }
    return p;
  }
  private async fetchOnce(mint: string, src: string): Promise<string | null> {
    if (!/^https?:\/\//.test(src)) return null;
    const r = await globalThis.fetch(src, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "coop-logos", accept: "image/*" } });
    if (!r.ok) return null;
    const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return null;
    // trust the bytes over the header: gateways answer image/* loosely, and a few hosts send octet-stream
    const ext = EXT[type] && looksLike(EXT[type], buf) ? EXT[type] : ["png", "jpg", "gif", "webp", "svg"].find((e) => looksLike(e, buf));
    if (!ext) return null;
    const f = this.file(mint, ext); fs.writeFileSync(`${f}.tmp`, buf); fs.renameSync(`${f}.tmp`, f);
    return ext;
  }
  /** Fetch a batch, a few at a time, for the prewarm. */
  async prime(items: { mint: string; src: string | null | undefined }[], parallel = 6): Promise<void> {
    const todo = items.filter((i) => i.src && MINT.test(i.mint) && !this.known.has(i.mint) && !(this.failed.has(i.mint) && Date.now() - this.failed.get(i.mint)! < RETRY_MS));
    const seen = new Set<string>(); const queue = todo.filter((i) => !seen.has(i.mint) && seen.add(i.mint));
    const workers = Array.from({ length: Math.min(parallel, queue.length) }, async () => { for (let i = queue.shift(); i; i = queue.shift()) await this.fetch(i.mint, i.src!); });
    await Promise.all(workers);
  }
}
