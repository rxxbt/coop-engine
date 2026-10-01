import { test } from "node:test";
import assert from "node:assert/strict";
import { MerkleTree, toLeaf, balanceTree, toHex } from "../src/merkle.js";

const acct = (n: number) => { const b = new Uint8Array(32); b[31] = n; return b; };

test("leaf is keccak(index LE || account || amount LE) — deterministic", () => {
  const a = toLeaf(0, acct(1), 100n), b = toLeaf(0, acct(1), 100n), c = toLeaf(1, acct(1), 100n);
  assert.equal(toHex(a), toHex(b));
  assert.notEqual(toHex(a), toHex(c));
  assert.equal(a.length, 32);
});

test("proofs verify against the root and fail when tampered", () => {
  const entries = [1, 2, 3, 4, 5].map((n) => ({ account: acct(n), amount: BigInt(n) * 1000n }));
  const { tree, leaves } = balanceTree(entries);
  for (const l of leaves) assert.ok(MerkleTree.verify(tree.proof(l.leaf), tree.root, l.leaf));
  const fake = toLeaf(0, acct(1), 999n);
  assert.equal(MerkleTree.verify(tree.proof(leaves[0].leaf), tree.root, fake), false);
});

test("single-leaf tree root equals the leaf; odd counts carry the last node", () => {
  const one = balanceTree([{ account: acct(7), amount: 1n }]);
  assert.equal(toHex(one.tree.root), toHex(one.leaves[0].leaf));
  const three = balanceTree([1, 2, 3].map((n) => ({ account: acct(n), amount: 1n })));
  assert.equal(three.tree.layers.length, 3);
});
