/**
 * Token-2022 transfer-fee sweep.
 *  1. harvest: move withheld fees from holder token accounts to the mint (PERMISSIONLESS — anyone can call)
 *  2. withdraw: move the mint's withheld balance to the operator's token account (withdraw authority only)
 */
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, createHarvestWithheldTokensToMintInstruction, createWithdrawWithheldTokensFromMintInstruction,
  getTransferFeeAmount, getTransferFeeConfig, unpackAccount, unpackMint,
} from "@solana/spl-token";

export type WithheldRow = { address: PublicKey; withheld: bigint };

/** Decode withheld amounts for a list of token accounts (batched getMultipleAccounts). */
export async function withheldOf(conn: Connection, addresses: string[]): Promise<WithheldRow[]> {
  const out: WithheldRow[] = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100).map((a) => new PublicKey(a));
    const infos = await conn.getMultipleAccountsInfo(batch);
    infos.forEach((info, k) => {
      if (!info) return;
      try {
        const acc = unpackAccount(batch[k], info, TOKEN_2022_PROGRAM_ID);
        const fee = getTransferFeeAmount(acc);
        if (fee && fee.withheldAmount > 0n) out.push({ address: batch[k], withheld: fee.withheldAmount });
      } catch { /* not a token-2022 account */ }
    });
  }
  return out;
}

export function harvestInstructions(mint: PublicKey, accounts: PublicKey[], perIx = 20): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  for (let i = 0; i < accounts.length; i += perIx) {
    ixs.push(createHarvestWithheldTokensToMintInstruction(mint, accounts.slice(i, i + perIx), TOKEN_2022_PROGRAM_ID));
  }
  return ixs;
}

export async function mintWithheld(conn: Connection, mint: PublicKey): Promise<{ withheld: bigint; feeBps: number; withdrawAuthority: string | null }> {
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error("mint not found");
  const m = unpackMint(mint, info, TOKEN_2022_PROGRAM_ID);
  const cfg = getTransferFeeConfig(m);
  if (!cfg) throw new Error("mint has no transfer fee config");
  return { withheld: cfg.withheldAmount, feeBps: cfg.newerTransferFee.transferFeeBasisPoints, withdrawAuthority: cfg.withdrawWithheldAuthority?.toBase58() ?? null };
}

export function withdrawFromMintInstruction(mint: PublicKey, destinationTokenAccount: PublicKey, authority: PublicKey): TransactionInstruction {
  return createWithdrawWithheldTokensFromMintInstruction(mint, destinationTokenAccount, authority, [], TOKEN_2022_PROGRAM_ID);
}
