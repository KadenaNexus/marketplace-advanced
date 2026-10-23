/**
 * Off-chain data the server keeps per pool (docs/v11-site-spec.md): the payment networks a pool accepts, the
 * creator's receiving address per network (shown to a buyer only after they took a slice), notes, and the
 * admin's hidden flag. Every reader here treats a 404 (server without these routes yet) as "nothing known".
 */
import type { Pool } from "./v11";
import { authHeaders } from "./authHeaders";

export interface PoolDetails { networks: string[]; notes: string }
/** A pool as the server lists it: chain fields plus its off-chain details. */
export type PoolListing = Pool & PoolDetails & { hidden: boolean };

type Auth = { wallet: string; publicKey: string; signedCmd: unknown };
const proof = (s: unknown) => (typeof s === "string" ? s : JSON.stringify(s));
const errorOf = async (r: Response, fallback: string) => (await r.json().catch(() => ({}))).error || fallback;

/** GET /api/pools: null when the server does not serve pools yet (the market then reads the chain only). */
export async function getPoolsIndex(): Promise<PoolListing[] | null> {
  try {
    const r = await fetch("/api/pools");
    if (r.status === 404) return null;
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d) ? d : null;
  } catch { return null; }
}

/** GET /api/pools/of/:wallet: that wallet's pools, closed ones included (the chain lists open pools only). [] when unknown. */
export async function getPoolsOf(wallet: string): Promise<PoolListing[]> {
  try {
    const r = await fetch(`/api/pools/of/${encodeURIComponent(wallet)}`);
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d.map((p) => ({ ...p, hidden: !!p.hidden })) : [];
  } catch { return []; }
}

/** GET /api/pools/:id/details: the networks and notes (public). Null when unknown. */
export async function getPoolDetails(poolId: string): Promise<PoolDetails | null> {
  try {
    const r = await fetch(`/api/pools/${encodeURIComponent(poolId)}/details`);
    if (!r.ok) return null;
    const d = await r.json();
    return { networks: Array.isArray(d?.networks) ? d.networks.map(String) : [], notes: typeof d?.notes === "string" ? d.notes : "" };
  } catch { return null; }
}

/** PUT /api/pools/:id/details (the creator): networks, the receiving address per network, notes. */
export async function putPoolDetails(poolId: string, body: { networks: string[]; payout: Record<string, string>; notes: string }, a: Auth): Promise<void> {
  const r = await fetch(`/api/pools/${encodeURIComponent(poolId)}/details`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...a, ...body }),
  });
  if (!r.ok) throw new Error(await errorOf(r, "Could not save the pool's payment details"));
}

/**
 * GET /api/pools/:id/payout: the receiving address per network. The server answers only the creator and the
 * parties of a trade on this pool; null when not allowed or not known. Pass `tradeId` for a trade taken a moment
 * ago: the server's cached chain read (15 s) may not list it yet, and with the id it checks that one trade on the
 * chain instead of answering 403.
 */
export async function getPoolPayout(poolId: string, a: Auth, tradeId?: string): Promise<Record<string, string> | null> {
  const q = tradeId ? `?${new URLSearchParams({ tradeId })}` : "";
  const r = await fetch(`/api/pools/${encodeURIComponent(poolId)}/payout${q}`, { headers: authHeaders(a.wallet, a.publicKey, a.signedCmd) });
  if (r.status === 403 || r.status === 404) return null;
  if (!r.ok) throw new Error(await errorOf(r, "Could not load the payment details"));
  const d = await r.json();
  const p = d?.payout;
  return p && typeof p === "object" ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)])) : null;
}

/**
 * The network a buyer chose when taking a slice of a pool with several networks. The chain does not record it,
 * so it is kept on this device for the trade's payment instructions.
 */
const NET_KEY = (tradeId: string) => `nx-trade-network:${tradeId}`;
export function rememberTradeNetwork(tradeId: string, network: string) { try { localStorage.setItem(NET_KEY(tradeId), network); } catch { /* ignore */ } }
export function tradeNetwork(tradeId: string): string | null { try { return localStorage.getItem(NET_KEY(tradeId)); } catch { return null; } }
