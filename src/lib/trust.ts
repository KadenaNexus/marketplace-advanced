/** New-trader limit and terms of use. See server/trust.js. */
import { authProof } from "@/lib/session";
import { authHeaders } from "./authHeaders";

/** Until a wallet has this many completed trades, each trade it creates or accepts is limited to NEW_TRADER_MAX_KDA. */
export const NEW_TRADER_TRADES = 3;
export const NEW_TRADER_MAX_KDA = 500;

export const isNewTrader = (completed: number | undefined) => completed !== undefined && completed < NEW_TRADER_TRADES;
/** Why this amount is not allowed for a wallet with `completed` trades, or null when it is. Unknown counts are not blocked. */
export function newTraderProblem(amountKda: number, completed: number | undefined): string | null {
  if (!isNewTrader(completed) || !(amountKda > NEW_TRADER_MAX_KDA)) return null;
  const left = NEW_TRADER_TRADES - (completed ?? 0);
  return `New traders can trade up to ${NEW_TRADER_MAX_KDA} KDA at a time. Complete ${left} more trade${left === 1 ? "" : "s"} to trade larger amounts.`;
}

/** Completed trades on the chain for each wallet (either side). */
export async function getCompletedCounts(wallets: string[]): Promise<Record<string, number>> {
  const ws = [...new Set(wallets.filter(Boolean))].sort();
  const parts: string[][] = [];
  for (let i = 0; i < ws.length; i += 100) parts.push(ws.slice(i, i + 100)); // the server takes 100 at a time
  const res = await Promise.all(parts.map(async (p) => {
    const r = await fetch(`/api/traders/completed?w=${p.map(encodeURIComponent).join(",")}`);
    if (!r.ok) throw new Error("Could not read completed trades");
    return r.json() as Promise<Record<string, number>>;
  }));
  return Object.assign({}, ...res);
}

type Who = { account: string; publicKey: string };
export interface TermsStatus { version: string; accepted: boolean }

export async function getTerms(w: Who): Promise<TermsStatus> {
  const s = await authProof(w.account, w.publicKey);
  const r = await fetch("/api/terms", { headers: authHeaders(w.account, w.publicKey, s) });
  if (!r.ok) throw new Error("Could not check the terms");
  return r.json();
}

export async function acceptTerms(w: Who, version: string): Promise<void> {
  const signedCmd = await authProof(w.account, w.publicKey);
  const r = await fetch("/api/terms/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: w.account, publicKey: w.publicKey, signedCmd, version }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not save. Try again.");
}
