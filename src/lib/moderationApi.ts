/** Hiding forgotten open offers from the market (arbiter only). See server/offerModeration.js. */
import { authProof } from "@/lib/session";
import { authHeaders } from "./authHeaders";

type Who = { account: string; publicKey: string };
export type HideReason = "expired" | "inactive" | "stale" | "other";
export interface HiddenOffer { offerId: string; reason: HideReason; hiddenAt: string }
export interface AdminOpenOffer {
  offerId: string; code: string; side: "BUY" | "SELL"; amount: number; creator: string;
  price: number | null; currency: string | null; createdAt: string | null; creatorLastActive: string | null;
  hidden: { reason: HideReason; hiddenAt: string } | null;
}

const proof = async (w: Who) => { const s = await authProof(w.account, w.publicKey); return typeof s === "string" ? s : JSON.stringify(s); };

export async function getHiddenOffers(): Promise<HiddenOffer[]> {
  const r = await fetch("/api/hidden-offers");
  if (!r.ok) throw new Error("Could not load hidden offers");
  return r.json();
}

export async function getAdminOpenOffers(w: Who): Promise<AdminOpenOffer[]> {
  const r = await fetch("/api/admin/open-offers", { headers: authHeaders(w.account, w.publicKey, await proof(w)) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not load open offers");
  return r.json();
}

async function send(method: "POST" | "DELETE", offerId: string, w: Who, body: Record<string, unknown> = {}) {
  const signedCmd = await authProof(w.account, w.publicKey);
  const r = await fetch(`/api/offers/${encodeURIComponent(offerId)}/hide`, {
    method, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: w.account, publicKey: w.publicKey, signedCmd, ...body }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Something went wrong");
}
export const hideOffer = (offerId: string, reason: HideReason, w: Who) => send("POST", offerId, w, { reason });
export const unhideOffer = (offerId: string, w: Who) => send("DELETE", offerId, w);

/** The creator lists an offer that expired again (the listing period starts over). */
export async function relistOffer(offerId: string, w: Who): Promise<void> {
  const signedCmd = await authProof(w.account, w.publicKey);
  const r = await fetch(`/api/offers/${encodeURIComponent(offerId)}/relist`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: w.account, publicKey: w.publicKey, signedCmd }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not list it again");
}
