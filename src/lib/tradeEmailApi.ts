/** Trade emails for the connected wallet. See server/tradeEmails.js. */
import { authProof } from "@/lib/session";
import { authHeaders } from "./authHeaders";

export interface TradeEmailStatus { available: boolean; email: string | null; pending: string | null; confirmed: boolean; on: boolean }
type Who = { account: string; publicKey: string };
const proofOf = async (w: Who) => { const s = await authProof(w.account, w.publicKey); return typeof s === "string" ? s : JSON.stringify(s); };

export async function getTradeEmail(w: Who): Promise<TradeEmailStatus> {
  const r = await fetch("/api/trade-email", { headers: authHeaders(w.account, w.publicKey, await proofOf(w)) });
  if (!r.ok) throw new Error("Could not load your email settings");
  return r.json();
}

async function post(path: string, w: Who, body: Record<string, unknown> = {}) {
  const signedCmd = await authProof(w.account, w.publicKey);
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet: w.account, publicKey: w.publicKey, signedCmd, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Something went wrong. Try again.");
  return j as { ok: boolean; confirmed?: boolean };
}
export const setTradeEmail = (w: Who, email: string, lang: string) => post("/api/trade-email", w, { email, lang });
