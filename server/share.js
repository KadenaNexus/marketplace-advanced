/**
 * Share links for pools and trades: https://marketplace.kadena.ws/s/<ref>
 *
 * Telegram, WhatsApp and X read a link's page without running its JavaScript, so this route answers with a small
 * HTML page whose Open Graph tags describe the pool or trade (amount, price, currency, state), then sends people on
 * to the Marketplace with ?offer=<ref>, which opens that pool or trade. Everything shown is public on the chain;
 * receiving addresses and anything private are never in it.
 *
 *   GET /s/:ref          the share page (nginx sends /s/ here; without that the site's own /s/ route redirects)
 *   GET /api/share/:ref  the same page under /api/, which every server already routes here
 *
 * :ref is a pool or trade reference: "pool-…" / "trade-…" on chain 1, "2:pool-…" on chain 2 (chain.js).
 */
import { readPool, readTrade, toRef, parseRef } from "./chain.js";

const REF = /^(?:(\d{1,2}):)?((?:pool|trade)-\d{6,16}-[a-z0-9]{1,16})$/i;
const OG_IMAGE = "https://kadena.ws/og/og-marketplace.jpg";
const SITE = "Kadena P2P Marketplace";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const kda = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 4 });
const price = (n) => Number(n || 0).toLocaleString("en-US", { maximumSignificantDigits: 6 });
/** A free pool: no token, price 0. */
const isGiveaway = (p) => !p.token && !(Number(p.price) > 0);
const STATE = { FUNDED: "In progress", PAID: "Paid, waiting for release", DISPUTED: "In dispute", COMPLETED: "Completed", SPLIT: "Settled by the arbiter", REFUNDED: "Refunded", CANCELLED: "Cancelled" };

/** "pool-…" / "2:pool-…" with only the characters ids use; null for anything else. */
export function cleanShareRef(raw) {
  const m = REF.exec(String(raw || "").trim());
  if (!m) return null;
  return toRef(m[1] || "1", m[2].toLowerCase());
}

/** Title and description for a pool (as read from the chain, plus the server's networks). */
export function describePool(p, { networks = [], username = "" } = {}) {
  const giveaway = isGiveaway(p);
  const instant = !!p.token;
  const by = username ? ` by @${username}` : "";
  if (p.state !== "OPEN") return { title: `Closed offer${by}`, description: `This ${giveaway ? "giveaway" : "offer"} is closed. See what's open on the ${SITE}.` };
  if (giveaway) return { title: `Free KDA giveaway${by}`, description: `${kda(p.available)} KDA left, ${p.min === p.max ? `${kda(p.min)} KDA each` : `${kda(p.min)}–${kda(p.max)} KDA per claim`}. Claim it in Linx Wallet on the ${SITE}.` };
  const verb = p.side === "SELL" ? "Selling" : "Buying";
  const nets = networks.length ? ` on ${networks.map((n) => n.split(":")[1]).join(" or ")}` : "";
  const how = instant ? " · instant swap" : p.agent ? " · auto-release" : "";
  return {
    title: `${verb} ${kda(p.available)} KDA for ${p.currency}${by}`,
    description: `${price(p.price)} ${p.currency} per KDA${nets} · ${kda(p.min)}–${kda(p.max)} KDA per trade${how} · KDA held in escrow on the ${SITE}.`,
  };
}

/** Title and description for a trade. */
export function describeTrade(t) {
  const giveaway = !t.token && !(t.price > 0);
  const what = giveaway ? `${kda(t.amount)} KDA giveaway claim` : `${kda(t.amount)} KDA for ${price(t.payAmount)} ${t.currency}`;
  return { title: `Trade: ${what}`, description: `${STATE[t.state] ?? t.state} · on the ${SITE}, with the KDA held in escrow on Kadena.` };
}

export function sharePage({ ref, title, description, publicUrl }) {
  const base = String(publicUrl || "https://marketplace.kadena.ws").replace(/\/$/, "");
  const shareUrl = `${base}/s/${encodeURIComponent(ref)}`;
  const target = `/?offer=${encodeURIComponent(ref)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${SITE}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(shareUrl)}">
<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@KadenaNexus">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${OG_IMAGE}">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
</head>
<body style="font-family:system-ui,sans-serif;padding:24px">
<p><a href="${esc(target)}">${esc(title)}</a></p>
<script>location.replace(${JSON.stringify(target)});</script>
</body>
</html>`;
}

export function registerShareRoutes(app, { getPool, readPoolFn = readPool, readTradeFn = readTrade, publicUrl = process.env.ALERTS_PUBLIC_URL || "https://marketplace.kadena.ws" } = {}) {
  const page = async (req, res) => {
    const ref = cleanShareRef(req.params.ref);
    const send = (t) => {
      res.set("Cache-Control", "public, max-age=60");
      res.type("html").send(sharePage({ ref: ref ?? "", publicUrl, ...t }));
    };
    if (!ref) return res.redirect(302, "/");
    const { id } = parseRef(ref);
    try {
      if (id.startsWith("pool-")) {
        const p = await readPoolFn(ref);
        if (!p) return send({ title: "Offer not found", description: `This offer is not on the ${SITE}.` });
        let networks = [], username = "";
        const db = getPool?.();
        if (db) {
          const [d, u] = await Promise.all([
            db.query("SELECT networks FROM pool_details WHERE pool_id = $1", [ref]).catch(() => ({ rows: [] })),
            db.query("SELECT username FROM profiles WHERE wallet = $1", [p.creator]).catch(() => ({ rows: [] })),
          ]);
          networks = d.rows[0]?.networks || [];
          username = u.rows[0]?.username || "";
        }
        return send(describePool(p, { networks, username }));
      }
      const t = await readTradeFn(ref);
      if (!t) return send({ title: "Trade not found", description: `This trade is not on the ${SITE}.` });
      return send(describeTrade(t));
    } catch {
      // the chain could not be read: still a working link, with a plain card
      return send({ title: SITE, description: "Trade KDA person to person, with the coins held in escrow. Open it in Linx Wallet." });
    }
  };
  app.get("/s/:ref", page);
  app.get("/api/share/:ref", page);
}
