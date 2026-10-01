/**
 * Holder snapshot for a Token-2022 mint. Prefers Helius DAS (getTokenAccounts, paged); falls back
 * to getProgramAccounts on the Token-2022 program, which public RPCs often refuse.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export type TokenAccountRow = { address: string; owner: string; amount: bigint };

async function dasTokenAccounts(heliusRpc: string, mint: string): Promise<TokenAccountRow[]> {
  const rows: TokenAccountRow[] = [];
  let page = 1;
  for (;;) {
    const res = await fetch(heliusRpc, {
      method: "POST", headers: { "content-type": "application/json" },
      // zero-balance accounts are included: a wallet that sold everything can still hold withheld tax from the transfers it received, and the
      // sweep must see it (holders are unaffected: aggregateByOwner drops zero balances)
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "getTokenAccounts", params: { mint, page, limit: 1000, displayOptions: { showZeroBalance: true } } }),
    });
    const j = (await res.json()) as any;
    if (j.error) throw new Error(`DAS error: ${JSON.stringify(j.error)}`);
    const accs: any[] = j.result?.token_accounts ?? [];
    for (const a of accs) rows.push({ address: a.address, owner: a.owner, amount: BigInt(a.amount ?? 0) });
    if (accs.length < 1000) break;
    page++;
  }
  return rows;
}

async function gpaTokenAccounts(conn: Connection, mint: string): Promise<TokenAccountRow[]> {
  const accs = await conn.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: mint } }],
    dataSlice: { offset: 32, length: 40 }, // owner (32) + amount (8)
  });
  return accs.map((a) => ({
    address: a.pubkey.toBase58(),
    owner: new PublicKey(a.account.data.subarray(0, 32)).toBase58(),
    amount: a.account.data.readBigUInt64LE(32),
  })).filter((r) => r.amount > 0n);
}

/** Fallback for RPCs that refuse getProgramAccounts: the 20 largest accounts (enough for a test token, NOT for a real holder base). */
async function largestTokenAccounts(conn: Connection, mint: string): Promise<TokenAccountRow[]> {
  const largest = await conn.getTokenLargestAccounts(new PublicKey(mint));
  const addrs = largest.value.map((v) => v.address);
  const infos = await conn.getMultipleAccountsInfo(addrs);
  const rows: TokenAccountRow[] = [];
  infos.forEach((info, i) => {
    if (!info) return;
    rows.push({ address: addrs[i].toBase58(), owner: new PublicKey(info.data.subarray(32, 64)).toBase58(), amount: info.data.readBigUInt64LE(64) });
  });
  return rows.filter((r) => r.amount > 0n);
}

export async function tokenAccounts(conn: Connection, mint: string, heliusRpc?: string): Promise<TokenAccountRow[]> {
  if (heliusRpc) return dasTokenAccounts(heliusRpc, mint);
  try { return await gpaTokenAccounts(conn, mint); }
  catch (e) {
    console.warn(`[snapshot] getProgramAccounts refused (${String(e).slice(0, 80)}); falling back to the 20 largest accounts`);
    return largestTokenAccounts(conn, mint);
  }
}

/** Aggregate token accounts per owner, dropping excluded owners. */
export function aggregateByOwner(rows: TokenAccountRow[], exclude: Set<string>): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const r of rows) {
    if (exclude.has(r.owner) || r.amount === 0n) continue;
    m.set(r.owner, (m.get(r.owner) ?? 0n) + r.amount);
  }
  return m;
}
