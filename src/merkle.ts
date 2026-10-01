/**
 * Merkle tree compatible with saber-hq/merkle-distributor (program MRKGLMizK9XSTaD1d1jbVkdHZbQVCSnPpYiTw9aKQv8):
 *   leaf  = keccak256(index u64 LE || account 32 bytes || amount u64 LE)
 *   node  = keccak256(sorted(a, b) concatenated); leaves sorted and de-duplicated; odd node carried up.
 * Lets holders CLAIM their allocation instead of the engine paying rent for every push.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";

function le64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
export function toLeaf(index: number, account: Uint8Array, amount: bigint): Uint8Array {
  if (account.length !== 32) throw new Error("account must be 32 bytes");
  return keccak_256(concat(le64(BigInt(index)), account, le64(amount)));
}
function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  return compareBytes(a, b) <= 0 ? keccak_256(concat(a, b)) : keccak_256(concat(b, a));
}
export function toHex(b: Uint8Array): string { return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); }

export class MerkleTree {
  readonly layers: Uint8Array[][];
  constructor(leaves: Uint8Array[]) {
    const sorted = [...leaves].sort(compareBytes).filter((el, i, arr) => i === 0 || compareBytes(el, arr[i - 1]) !== 0);
    if (sorted.length === 0) throw new Error("empty tree");
    const layers = [sorted];
    while (layers[layers.length - 1].length > 1) {
      const prev = layers[layers.length - 1];
      const next: Uint8Array[] = [];
      for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
      layers.push(next);
    }
    this.layers = layers;
  }
  get root(): Uint8Array { return this.layers[this.layers.length - 1][0]; }
  proof(leaf: Uint8Array): Uint8Array[] {
    let idx = this.layers[0].findIndex((el) => compareBytes(el, leaf) === 0);
    if (idx < 0) throw new Error("leaf not in tree");
    const proof: Uint8Array[] = [];
    for (let l = 0; l < this.layers.length - 1; l++) {
      const layer = this.layers[l];
      const pair = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (pair < layer.length) proof.push(layer[pair]);
      idx = Math.floor(idx / 2);
    }
    return proof;
  }
  static verify(proof: Uint8Array[], root: Uint8Array, leaf: Uint8Array): boolean {
    let h = leaf;
    for (const p of proof) h = hashPair(h, p);
    return compareBytes(h, root) === 0;
  }
}

export type BalanceEntry = { account: Uint8Array; amount: bigint };
export function balanceTree(entries: BalanceEntry[]): { tree: MerkleTree; leaves: { index: number; leaf: Uint8Array }[] } {
  const leaves = entries.map((e, index) => ({ index, leaf: toLeaf(index, e.account, e.amount) }));
  return { tree: new MerkleTree(leaves.map((l) => l.leaf)), leaves };
}
