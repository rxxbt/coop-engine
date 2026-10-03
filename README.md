# COOP engine

The payout engine behind [coopfam.xyz](https://coopfam.xyz). A token launched on COOP carries a transfer tax (a Token-2022
transfer fee). Every epoch this engine collects that tax, converts it, and pays it out the way the token's creator set at
launch: to holders, to a treasury, to the creator, or into a burn. It then publishes a ledger of the epoch: the holder
snapshot the rules ran on, every allocation, every amount and every transaction signature.

This repository is the code the live engine runs. Every published epoch can be recomputed from its own ledger with
`verify`, and every payout checked on-chain against the signatures in it.

## What an epoch does

1. **Sweep** the tax withheld in the mint and in holders' token accounts (`src/sweep.ts`).
2. **Snapshot** the holders, leaving out the pool, the operator, treasury wallets and any wallet the creator excluded
   (`src/snapshot.ts`).
3. **Split** what was swept across the token's sinks by their shares. A pot a sink could not pay last time stays with that
   sink and joins its next pot (`src/plan.ts`).
4. **Convert** through Jupiter: one swap per payout asset per epoch, shared by the sinks that pay in it and split between
   them to the unit. No route, or an amount too small to swap, keeps the pot for the next epoch.
5. **Pay**: holders by the sink's rule (`src/rules.ts`), a treasury or the creator by transfer, a burn by burning.
6. **Publish** the epoch record and keep a resumable state file, so a run that stops halfway picks up where it left off
   and nothing is paid twice: every payment, burn and swap is written down with its signature before it is sent, and a
   resumed run first asks the chain whether it landed (`src/ledger.ts`, `src/epoch.ts`).

## Sinks and rules

A token has up to ten sinks whose shares add up to 100%: `reflections` (paid to holders, in the pair asset, the token
itself or any asset Jupiter routes), `treasury`, `creator` and `burn`. Each holder sink follows one rule:

| Rule | Who is paid |
|---|---|
| `pro-rata` | every eligible holder, by balance |
| `time-weighted` | every eligible holder, by balance × a multiplier that grows with holding time; selling anything resets the wallet |
| `never-sold-bonus` | only wallets that never sold, by balance; all eligible holders in an epoch where none qualifies |
| `lottery` | a number of equal prizes, each drawn by balance weight (one wallet can win more than one, so splitting a wallet gains nothing), seeded by a blockhash taken after the snapshot |

The rules are pure functions over the published snapshot; the tests check, among other things, that splitting a wallet
never increases its payout.

## Verify an epoch yourself

```bash
npm install
cp .env.example .env                      # an RPC endpoint is enough for reading
npx tsx src/cli.ts verify <mint> <epoch>  # recomputes the allocations from the published snapshot
```

The ledgers are served at `https://api.coopfam.xyz/ledger/<mint>/<epoch>` and shown on every token page.

## Run it

```bash
cp engine.example.json engine.config.json
npx tsx src/cli.ts tokens                     # every token the engine knows
npx tsx src/cli.ts epoch <mint>               # dry run: quotes, allocations, nothing sent
npx tsx src/cli.ts epoch <mint> --execute     # signs with the operator key
npx tsx src/cli.ts epoch --all --execute      # the scheduler: every token whose epoch is due
npx tsx src/cli.ts fees --all                 # dry run: graduated pools' creator fees, what would be forwarded
npm test
```

`scripts/run-epochs.sh` is the hourly entry point: it runs the scheduler and alerts the operator when an epoch fails,
when a pot above dust could not be converted, or when the operator wallet runs low. `src/api.ts` serves the registry, the
ledgers and the launch form's helpers.

## How it is operated

The engine is an operator-run service. One operator key holds each token's transfer-fee authority: it is what lets the
engine sweep the tax, and it signs every payout. What that key does every epoch is exactly this code, and the record of it
is public. Tokens register by a message their creator signs before launch; the engine accepts a registration only when the
pool exists on a COOP platform account, was created by the signer, and its tax can be withdrawn by the operator
(`src/registry.ts`).

## After graduation

A token that completes its curve migrates into a Raydium CPMM pool whose recorded creator is the operator. Every swap there pays a
0.75% creator fee into the pool. Once a day `scripts/run-fees.sh` claims those fees for every graduated token on a COOP platform account
and sends the token's creator 42/75 of each claim (0.42 of the pool's 1.00%); the rest goes to the platform's fee wallet. A pool's fees
are claimed only once the creator's share is worth at least $1; until then they keep accruing in the pool. Every claim and transfer is
recorded per token and served with the token's ledger (`src/fees.ts`).

## Layout

`src/` the engine and its API · `test/` the test suite · `scripts/` the scheduler entry point and helpers ·
`engine.example.json`, `.env.example`, `api.env.example` configuration templates.

Source published for verification. All rights reserved.
