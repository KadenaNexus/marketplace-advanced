/**
 * Auto-release (server/autoRelease.js): for a USDT/USDC trade whose offer chose the platform's release agent, the
 * buyer sends the trade's amount plus a few micro-units that identify the payment, and the server's agent releases
 * the KDA on chain when exactly that arrives at the seller's address. Every reader here treats an error or a 404
 * (a server without these routes) as "off".
 */
import { networkLabel, paymentNetwork } from "./markets";
import { authHeaders } from "./authHeaders";

export interface AutoReleaseInfo {
  enabled: boolean;
  /** the server's agent account; the site only offers auto-release when it equals the chain's config agent */
  agent: string;
  /** network ids the server watches, e.g. ["USDT:TRC20"] */
  networks: string[];
}

export type AutoStatus = "watching" | "matched" | "releasing" | "released" | "manual" | "expired";
export interface TradeAuto {
  enabled: boolean;
  reason?: string | null;
  /** exactly what to send, e.g. "0.533017" */
  amount?: string;
  payAmount?: string;
  currency?: string;
  /** the receiving address per watched network (a snapshot taken when the trade started) */
  networks?: { id: string; address: string }[];
  /** networks of this currency the server does not watch */
  notWatched?: string[];
  status?: AutoStatus;
  matchedTx?: string | null;
  matchedNetwork?: string | null;
  releaseRequestKey?: string | null;
  /** networks (with the seller's address) where a buyer who paid from an exchange can give the transaction ID */
  byTxid?: { id: string; address: string }[];
}

const OFF: AutoReleaseInfo = { enabled: false, agent: "", networks: [] };
type Auth = { wallet: string; publicKey: string; signedCmd: unknown };
const proof = (s: unknown) => (typeof s === "string" ? s : JSON.stringify(s));

/** GET /api/v11/auto-release (public) */
export async function getAutoReleaseInfo(): Promise<AutoReleaseInfo> {
  try {
    const r = await fetch("/api/v11/auto-release");
    if (!r.ok) return OFF;
    const d = await r.json();
    return { enabled: d?.enabled === true, agent: String(d?.agent ?? ""), networks: Array.isArray(d?.networks) ? d.networks.map(String) : [] };
  } catch { return OFF; }
}

/** GET /api/v11/trades/:ref/auto (the two sides and the arbiter). null when not allowed or not served. */
export async function getTradeAuto(tradeRef: string, a: Auth): Promise<TradeAuto | null> {
  const r = await fetch(`/api/v11/trades/${encodeURIComponent(tradeRef)}/auto`, { headers: authHeaders(a.wallet, a.publicKey, a.signedCmd) });
  if (r.status === 403 || r.status === 404) return null;
  if (!r.ok) throw new Error("Could not load auto-release");
  return (await r.json()) as TradeAuto;
}

export interface IncomingCheck {
  /** false: nothing could be looked at (not a USDT/USDC trade, not unpaid, or the watcher is off) */
  checked: boolean;
  reason?: string | null;
  /** networks the server could not reach this time */
  failed?: string[];
  /** a payment of at least the trade's amount arrived: the take-back button is held */
  hold?: boolean;
  payments: { network: string; txid: string; amount: string; at: string; covers: boolean }[];
}
/**
 * GET /api/v11/trades/:ref/incoming (the seller and the arbiter): payments of the trade's currency that reached the
 * seller's address since the trade started. null when the server cannot tell (old server, error).
 */
export async function getIncoming(tradeRef: string, a: Auth): Promise<IncomingCheck | null> {
  try {
    const r = await fetch(`/api/v11/trades/${encodeURIComponent(tradeRef)}/incoming`, { headers: authHeaders(a.wallet, a.publicKey, a.signedCmd) });
    if (!r.ok) return null;
    const d = await r.json();
    return { checked: d?.checked === true, reason: d?.reason ?? null, failed: Array.isArray(d?.failed) ? d.failed : [], hold: d?.hold === true, payments: Array.isArray(d?.payments) ? d.payments : [] };
  } catch { return null; }
}

/**
 * POST /api/v11/trades/:ref/claim-payment (the buyer): paid from an exchange, so the amount is not the exact one; the
 * server checks the transaction ID and releases when it fits this trade and no other. `error` says why not.
 */
export async function claimPayment(tradeRef: string, network: string, txid: string, a: Auth): Promise<{ ok: true; auto: TradeAuto } | { ok: false; error: string }> {
  try {
    const r = await fetch(`/api/v11/trades/${encodeURIComponent(tradeRef)}/claim-payment`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: a.wallet, publicKey: a.publicKey, signedCmd: proof(a.signedCmd), network, txid }),
    });
    const d = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, auto: d as TradeAuto } : { ok: false, error: String(d?.error || "Could not check the payment") };
  } catch { return { ok: false, error: "Could not reach the server. Try again." }; }
}

/** The trade is on the automatic path (watching, found, releasing or done). */
export const isAutoActive = (a: TradeAuto | null | undefined): a is TradeAuto & { amount: string } =>
  !!a?.enabled && !!a.amount && !!a.status && ["watching", "matched", "releasing", "released"].includes(a.status);

/** "USDT on Tron (TRC20)" for each watched network of `currency`, joined: for the line next to the switch. */
export function watchedText(currency: string, watched: string[]): string {
  const mine = watched.filter((n) => n.startsWith(`${currency}:`));
  if (!mine.length) return "";
  return mine.map((n) => paymentNetwork(n)?.label ?? networkLabel(n)).join(" and ");
}

/**
 * What auto-release means for someone about to take a pool. On a SELL pool the taker pays; on a BUY pool the taker
 * holds the KDA, and it is their KDA the agent releases when the payment reaches their address.
 */
export function autoPoolNote(side: "SELL" | "BUY", currency: string): string {
  return side === "SELL"
    ? `Auto-release: when your exact ${currency} payment reaches the seller's address, the KDA is released to you automatically.`
    : `Auto-release: when the buyer's exact ${currency} payment reaches your address, your KDA is released to them automatically. You can also release it yourself.`;
}

/** Explorer link for a matched payment. */
export function paymentTxUrl(network: string | null | undefined, tx: string): string | null {
  if (!network || !tx) return null;
  if (network.endsWith(":TRC20")) return `https://tronscan.org/#/transaction/${encodeURIComponent(tx)}`;
  if (network.endsWith(":ERC20")) return `https://etherscan.io/tx/${encodeURIComponent(tx)}`;
  return null;
}
