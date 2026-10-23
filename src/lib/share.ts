/**
 * Share links for pools and trades: https://marketplace.kadena.ws/s/<ref>
 *
 * The server answers /s/<ref> with a page that Telegram, WhatsApp and X turn into a preview card (server/share.js),
 * then sends people to /?offer=<ref>, which opens the pool or trade. Without the server route the site's own /s/
 * route does the redirect (no preview card, same result).
 */
import { parseRef, toRef } from "../../shared/v11-chains.js";

/** A pool or trade id as the contract makes them, with an optional "<chain>:" in front. */
const REF = /^(?:(\d{1,2}):)?((?:pool|trade)-\d{6,16}-[a-z0-9]{1,16})$/i;

/** "2:pool-…" stays readable in the address (":" is fine in a path). */
export const refPath = (ref: string) => encodeURIComponent(ref).replace(/%3A/gi, ":");
export const shareUrl = (ref: string, origin = typeof window === "undefined" ? "https://marketplace.kadena.ws" : window.location.origin) =>
  `${origin.replace(/\/$/, "")}/s/${refPath(ref)}`;

/** The pool or trade a pasted link points to (a /s/ link, a ?offer= or ?pool= link, or a bare reference). null if none. */
export function refFromLink(input: string): string | null {
  const s = String(input || "").trim();
  if (!s) return null;
  const tryRef = (x: string | null | undefined) => {
    if (!x) return null;
    let v = x;
    try { v = decodeURIComponent(x); } catch { /* keep as is */ }
    const m = REF.exec(v.trim());
    return m ? toRef(m[1] || "1", m[2].toLowerCase()) : null;
  };
  const fromUrl = (x: string) => {
    try {
      const u = new URL(x.includes("://") ? x : `https://${x}`);
      const m = /\/s\/([^/?#]+)/.exec(u.pathname);
      return tryRef(m?.[1]) ?? tryRef(u.searchParams.get("offer")) ?? tryRef(u.searchParams.get("pool"));
    } catch {
      return null;
    }
  };
  const direct = tryRef(s) ?? (/\s/.test(s) ? null : fromUrl(s));
  if (direct) return direct;
  // the whole shared message pasted ("Selling 500 KDA … https://…/s/pool-…"): use the link inside it
  for (const word of s.split(/\s+/)) {
    const w = word.replace(/^[<("'[]+|[>)"'\].,;!?]+$/g, "");
    const r = tryRef(w) ?? (/\/s\/|[?&](?:offer|pool)=/.test(w) ? fromUrl(w) : null);
    if (r) return r;
  }
  return null;
}

export const isPoolRef = (ref: string) => parseRef(ref).id.startsWith("pool-");

const kda = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
const price = (n: number) => n.toLocaleString("en-US", { maximumSignificantDigits: 6 });

type PoolLike = { side: "SELL" | "BUY"; available: number; min: number; max: number; price: number; currency: string; token: string; state: string };
type TradeLike = { amount: number; payAmount: number; currency: string; token: string; price: number; state: string };

/** What a shared pool says (the link goes after it). */
export function poolShareText(p: PoolLike): { title: string; text: string } {
  const giveaway = !p.token && !(p.price > 0);
  if (p.state !== "OPEN") return { title: `This ${giveaway ? "giveaway" : "offer"} is closed`, text: "Kadena P2P Marketplace (in Linx Wallet):" };
  if (giveaway) return { title: "Free KDA giveaway", text: `Free KDA giveaway: ${kda(p.available)} KDA left, ${p.min === p.max ? `${kda(p.min)} KDA each` : `${kda(p.min)}–${kda(p.max)} KDA per claim`}. Claim it on Kadena P2P Marketplace (in Linx Wallet):` };
  const verb = p.side === "SELL" ? "Selling" : "Buying";
  const title = `${verb} ${kda(p.available)} KDA for ${p.currency}`;
  return { title, text: `${title} at ${price(p.price)} ${p.currency} per KDA (${kda(p.min)}–${kda(p.max)} KDA per trade)${p.token ? ", instant swap" : ""}. KDA held in escrow on Kadena P2P Marketplace (in Linx Wallet):` };
}

/** What a shared trade says. */
export function tradeShareText(t: TradeLike): { title: string; text: string } {
  const giveaway = !t.token && !(t.price > 0);
  const what = giveaway ? `${kda(t.amount)} KDA giveaway claim` : `${kda(t.amount)} KDA for ${price(t.payAmount)} ${t.currency}`;
  return { title: `Trade: ${what}`, text: `Trade on Kadena P2P Marketplace: ${what}. Open it in Linx Wallet:` };
}

/** Links that open each app's share screen with the text and the link filled in. */
export function shareTargets(url: string, text: string) {
  const e = encodeURIComponent;
  return {
    telegram: `https://t.me/share/url?url=${e(url)}&text=${e(text)}`,
    whatsapp: `https://wa.me/?text=${e(`${text} ${url}`)}`,
    x: `https://x.com/intent/post?text=${e(text)}&url=${e(url)}`,
  };
}
