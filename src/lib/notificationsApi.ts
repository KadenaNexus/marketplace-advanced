import { authHeaders } from "./authHeaders";
// Trade notifications feed and Web Push (server/notifications.js). Same-origin /api like the other APIs.
// A wallet's feed and a device tied to a wallet need that wallet's proof (server/session.js), like every other
// authenticated read: wallet, publicKey and signedCmd (a session token or a fresh signature).
export type Who = { account: string; publicKey: string; signedCmd: unknown };
const proofText = (s: unknown) => (typeof s === "string" ? s : JSON.stringify(s));

const base = (): string => {
  const v = import.meta.env?.VITE_PROFILE_API;
  return typeof v === "string" && v.trim() ? v.trim().replace(/\/$/, "") : "";
};

export type FeedItem = {
  id: number;
  kind: string;                 // accepted | funded | paid | completed | disputed | refunded | closed | due-* | expired-* | message | new_offer
  scope: "trade" | "offer";
  offerId: string | null;
  title: string;
  body: string;
  urgent: boolean;
  createdAt: string;
  open?: boolean;               // new offers: still open to accept
};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(base() + path, init);
  let data: unknown = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error((data as { error?: string } | null)?.error || `HTTP ${r.status}`);
  return data as T;
}

/** The feed for a signed-in wallet, or (null) the new-offer items only. */
export const fetchFeed = (who?: Who | null) => {
  return json<{ enabled: boolean; items: FeedItem[] }>("/api/notifications", who ? { headers: authHeaders(who.account, who.publicKey, proofText(who.signedCmd)) } : undefined);
};
export const getPushKey = () => json<{ enabled: boolean; publicKey?: string }>("/api/push/key");
/** Tie this device to a wallet (with its proof), or (null) to the new-offer notifications only. */
export const savePushSubscription = (subscription: PushSubscriptionJSON, who: Who | null, trades: boolean, offers: boolean) =>
  json<{ ok: true }>("/api/push/subscribe", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription, trades, offers, ...(who ? { wallet: who.account, publicKey: who.publicKey, signedCmd: who.signedCmd } : { wallet: null }) }),
  });
export const removePushSubscription = (endpoint: string) =>
  json<{ ok: true }>("/api/push/unsubscribe", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint }),
  });
