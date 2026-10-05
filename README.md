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

## Dials

Every one of these is the creator's choice at launch, signed in the manifest, and off unless chosen (since 2026-10-05).

| Dial | What the engine does |
|---|---|
| Buy-tax refund (`refund.mode`) | Every epoch, before the split, the engine reads the pool vaults' own transactions, finds the buys, works out the tax each buyer paid from the balance changes and pays it back, grossed up for the refund's own tax (`src/refunds.ts`). `holders` pays only buyers still holding everything they bought in the window at the snapshot; `all` pays every buyer. Every refund is in the ledger with the buy it answers. |
| Later recipe (`stages`) | A second set of sinks that takes over at graduation, at a holder count (the last snapshot) or at a market cap. Checked at the start of every epoch, entered in order, never left; the carry file follows the sinks; the epoch record carries the stage and what the check saw (`src/stages.ts`). |
| Minimum holding age (`minAgeHours` on a holder sink) | Tokens count only once their lot has sat in the wallet that long, per lot, for eligibility and for the split (`agedHolder` in `src/rules.ts`). `verify` recomputes it from the published lots. |
| Jackpot (`every` on a lottery rule) | The sink draws every N epochs; between draws its pot stays with the sink (`keptWhy: accruing`, `drawAt` in the record). |
| Locked team share (`vesting`) | The launch locked a slice of the supply through LaunchLab's vesting; when `earns` is set the locked, unclaimed amount counts as held by the creator in every snapshot (`vested` on the row). |
| Referral share (`referralBps`) | The share fee the token page puts on curve trades; the engine only publishes it. |

Pool fees after graduation (`src/fees.ts`): the dev's 0.42% of the pool's volume is fixed. Raydium's program keeps a share of the creator
fee at claim time (5% on tier 9 since 2026-10-01); the split reads the rates at every claim, records them, and gives the dev their 0.42%
out of what arrives.

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

## Layout

`src/` the engine and its API · `test/` the test suite · `scripts/` the scheduler entry point and helpers ·
`engine.example.json`, `.env.example`, `api.env.example` configuration templates.

Source published for verification. All rights reserved.
