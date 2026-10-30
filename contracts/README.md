# Contracts

| Path | What it is |
|---|---|
| `p2p-escrow-v11.pact` | **The advanced Marketplace escrow (v11).** Pool offers with a min/max per trade, trades start funded, instant Kadena-token settlement, USDT/USDC flows with agent release, fee, pause, events. Deployed on **chains 1 and 2** (same code, same governance) on 2026-10-19; see `deployed/p2p-escrow-v11.pact`. |
| `test/p2p-escrow-v11.repl` | Tests for v11 (Pact 5.4). Run `contracts/test/run.sh`. |
| `test/vendor/` | `coin`, `fungible-v2`, `fungible-xchain-v1` as on mainnet, for the tests only. |
| `deployed/p2p-escrow-v11.pact` | Copy of what is live as `free.p2p-escrow-v11` on mainnet01, chains 1 and 2, with both request keys. Verified identical on chain on 2026-10-19. |
| `deployed/p2p-escrow-v10.pact` | Copy of what is live as `free.p2p-escrow-v10` on mainnet01, chain 1. Verified identical to the on-chain module on 2026-10-15 (module explorer vs this file). Reference only; v10 keeps running for its open trades and history. |
| `../p2p-escrow.pact` | The v10 working copy inherited from the public marketplace repo. Kept until the site is fully on v11. |
| `drafts/` | Old drafts. Not used. |

## v11 at a glance

| | v10 (live) | v11 |
|---|---|---|
| Offer | one fixed amount, one buyer | a pool with min/max per trade, many buyers at once |
| Steps for a sell offer | accept → deposit (1 h) → pay → mark paid → release | take (already funded) → pay → release (agent or seller) |
| Instant settlement | no | yes, any Kadena token (kb-USDC, kb-ETH, FLUX, BRO…) via `take-and-settle` |
| Payment window | fixed 4 h | per offer, 15 min to 24 h |
| Who can release | seller, arbiter | seller, or the platform's release agent if the offer chose it (governance sets that one account with `set-agent`; offers can name no other); arbiter only in a dispute (with a split) |
| Buyer cancel | no | yes, before paying |
| Fee | none | basis points, hard cap 1%, **0 at launch**; per-trade snapshot |
| Pause | no | yes; never blocks releases, refunds or withdrawals |
| Events | no | every offer and trade step |
| Reputation | on chain | on chain (trades, successes, disputes, cancels, volume); the site adds v10 history |
| Chain | 1 | 1 and 2 (the currency decides; see below) |

## Chains

v11 runs on **chain 1 and chain 2**: the same file, deployed twice, with the same governance keyset and the same
arbiter and fee account. Each chain has its own tables, so a pool or trade is identified by (chain, id); the site and
server write that as `2:<id>` for chain 2 and the bare id for chain 1 (`docs/v11-site-spec.md`, "Chains"). The currency
decides the chain (`shared/v11-chains.js`):

- chain 1: USDT and USDC (paid outside Kadena), BRO (`n_582fed11af00dc626812cd7890bb88e72067f28c.bro`), FLUX (`runonflux.flux`)
- chain 2: kb-USDC, kb-ETH, kb-USDT (`n_e595727b657fbbb3b8e362a05a7bb8d12865c1ff.kb-…`)

The contract itself has nothing chain-specific (no chain id, no cross-chain step, no dependency on v10), so it needs
no change for this: `take-and-settle` transfers whichever token module the pool names, on the chain the transaction
runs on, and reads the token's own `precision`.

## Deployment (not done yet)

**Step by step for the governance wallets (Chainweaver), with a dry run against mainnet: [`DEPLOY-v11.md`](DEPLOY-v11.md).** The ready-to-paste transaction (contract + tables + config) is `deploy/deploy-v11.pact`.

1. Governance keyset `free.p2p-escrow-v11-gov`: the same two Chainweaver wallets that deployed v10, `keys-all`.
   A keyset is defined per chain: define it on chain 1 and on chain 2.
2. Deploy `p2p-escrow-v11.pact` on mainnet01 **chain 1 and chain 2** with `gov-keyset` in the transaction data, then
   run once on each chain:
   `(create-table free.p2p-escrow-v11.config)` `(… offers)` `(… trades)` `(… reputation)`
   `(free.p2p-escrow-v11.init-config "<arbiter k: account>" "<fee k: account>")` (the same accounts on both chains;
   the arbiter and fee accounts need a coin account on each chain).
3. Copy the deployed file to `deployed/p2p-escrow-v11.pact` and add the request keys (one per chain) and date here.
4. Point the site at v11 (`VITE_CONTRACT_MODULE=p2p-escrow-v11`); v10 stays readable for history. `V11_CHAINS`
   (server) and `VITE_V11_CHAINS` (site) default to `1,2`; set them to `1` while chain 2 is not deployed (the readers
   also treat a chain without the contract as empty).

Deployed versions
- v10: `free.p2p-escrow-v10`, chain 1. Deployed by Saudi.KDA (two Chainweaver wallets as governance), April 2026.
- v11: not yet (planned: chains 1 and 2).

## Notes for review

- Every KDA movement is listed at the top of `p2p-escrow-v11.pact`. Vaults are principal accounts guarded by `OFFER_VAULT` / `TRADE_VAULT`, which only this module can acquire (`contracts/test` checks that).
- `take-and-settle` verifies the token module by name (`(format "{}" [token])` against the offer's stored module name); the buyer signs the token's own `TRANSFER` capability.
- An offer with `available` 0 stays `OPEN` so its creator can top it up; the site hides offers with less than their minimum left.
- A buyer can open a dispute at any time before completion. The arbiter can act only on disputed trades.
- Pact managed capabilities: one `coin.TRANSFER` per (sender, receiver) per transaction, which the code respects (see `pay-from-trade`).
