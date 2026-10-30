# Turning on auto-release (USDT/USDC)

Auto-release lets the server's **release agent** release a trade's KDA to the buyer as soon as the exact USDT/USDC payment reaches the seller's address.

- **Exact amount:** each trade has its own amount, e.g. 0.530968. The last digits identify the payment.
- **Opt-in:** sellers choose it per pool with the "Auto-release" switch, which is on by default.
- **What the agent can do:** only release a trade to its own buyer. It can't refund, change amounts or send anywhere else.
- **Who can be the agent:** only the one account governance names with `set-agent`.

It needs four things, done once.

## 1. Create the agent key on the server (whoever runs the server)

From the Marketplace folder on the server:

    node server/scripts/new-agent-key.mjs /path/to/the/server/.env

- It writes `AUTO_RELEASE_SECRET=…` into `.env` (file readable only by its owner).
- It prints only the public account `k:…`.
- **Never copy the secret anywhere.** If it leaks, run `set-agent` with an empty string (step 3) and make a new key.

## 2. Fund the agent with gas

Send about **1 KDA on chain 1** to the printed `k:` account. Each release costs well under 0.001 KDA, so 1 KDA covers more than a thousand releases.

## 3. Name the agent in the contract (Saudi.KDA, both governance wallets)

After the v11 deployment, in Chainweaver on **chain 1**, signed by **both** governance keys:

    (free.p2p-escrow-v11.set-agent "k:<the printed account>")

- **Turn it off for everyone:** `(free.p2p-escrow-v11.set-agent "")`. It takes effect at once, open trades included (upgrade of Oct 20): those trades are then released by their seller as usual.

## 4. Payment-watching keys (in the server's `.env`)

| Variable | Needed for | Where to get it |
|---|---|---|
| `ETHERSCAN_API_KEY` | USDT and USDC on Ethereum (ERC20). Without it, only Tron is auto-released. | Free account at etherscan.io → API Keys |
| `TRONGRID_API_KEY` | USDT on Tron (TRC20). It works without a key, but slowly under load, so set one. | Free account at trongrid.io → API keys |

Restart the server. The log should show:

    [auto-release] on: agent k:…, watching USDT:TRC20, USDT:ERC20, USDC:ERC20

## What happens when a payment doesn't match

The watcher only takes the exact amount. Typical causes of a mismatch:

- an exchange withdrawal that took its fee out of the amount or rounded it;
- the bare amount sent without the extra digits;
- the wrong network.

**Paid from an exchange:** the buyer opens "Paying from an exchange?" in the Auto-release box and pastes the
transaction ID (TXID) from the exchange's withdrawal history (`POST /api/v11/trades/:ref/claim-payment`). The server
looks the transfer up on Tron or Ethereum and releases when it is the official token, went to the trade's address,
brought **at least** the trade's amount, was sent inside the trade's window, is confirmed and was never used before,
and when **no other trade with this seller** (open, or closed but still inside its window, with or without
auto-release) could be what it paid for. That last rule stops someone with a trade of their own from claiming another
buyer's payment. This also works after the window passed with no exact payment, as long as the trade is still open.

Otherwise nothing automatic happens; the trade continues the normal way (the buyer taps "I paid", the seller checks
and releases).

## Checks the agent makes before every release

1. **Token:** the official contract (Tron USDT `TR7NHq…`, Ethereum USDT `0xdAC1…`, USDC `0xA0b8…`).
2. **Recipient:** the seller's address as it was when the trade started.
3. **Amount:** exactly the trade's amount (with a transaction ID from the buyer: at least the trade's amount, and no other trade of this seller fits it).
4. **Time:** inside the trade's time window.
5. **Confirmations:** confirmed on Tron, 12 confirmations on Ethereum.
6. **Payment used once:** each payment can release only one trade.
7. **Trade state:** re-read from the chain, the trade is still FUNDED or PAID (never in dispute) and its agent is this server's.
