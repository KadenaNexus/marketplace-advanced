/**
 * Escrow v11 pools: the market list, and what the server keeps per pool off chain (table pool_details).
 *
 * Price, currency, limits and the window are on the chain. Off chain live the payment networks the creator
 * accepts ("USDT:TRC20" | "USDT:ERC20" | "USDC:ERC20"), the receiving address per network and free-text notes.
 * Addresses are private: shown to the pool's creator, to a buyer or seller of a trade on that pool, and to
 * the arbiter. Who is who is read from the chain, never from the browser.
 * :poolId is a reference (chain.js): "2:pool-…" for a pool on chain 2, the bare id on chain 1; pool_details is keyed
 * by it, so the same id on the two chains has two rows.
 *
 *   GET /api/pools                   -> [pool…]  open pools from the chain + networks, notes, hidden flag (cached ~15 s)
 *   GET /api/pools/of/:wallet        -> [pool…]  that wallet's pools, open and closed, newest first (public, no addresses)
 *   GET /api/pools/:poolId/details   -> { poolId, networks, notes, updatedAt }                 (public, no addresses)
 *   PUT /api/pools/:poolId/details   { wallet, publicKey, signedCmd, networks, payout, notes? } (the creator, once the pool is on the chain)
 *   GET /api/pools/:poolId/payout    (wallet, publicKey, signedCmd[, tradeId] in the query)
 *                                    -> { poolId, networks, payout, notes, isMine }            (creator, a party of a trade on the pool, arbiter)
 */
import { configFor, fetchChain, parseRef, readPool, readTrade } from "./chain.js";
import { createChainCache } from "./trust.js";

const TRC20 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/, ERC20 = /^0x[0-9a-fA-F]{40}$/;
/** network -> address shape (same list as the client's new-offer form) */
export const NETWORKS = { "USDT:TRC20": TRC20, "USDT:ERC20": ERC20, "USDC:ERC20": ERC20 };
const MAX_NOTES = 500;
/** The most pools listed for one creator (newest first). */
export const MAX_MY_POOLS = 100;
/** A trade's other side sees the pool's addresses only while there is, or was, something to pay. */
export const PAYOUT_VISIBLE_STATES = ["FUNDED", "PAID", "DISPUTED", "COMPLETED"];

/** Validate a PUT body. Every listed network needs a fitting address; nothing else is kept. */
export function cleanPoolDetails(body) {
  const raw = body?.networks;
  if (!Array.isArray(raw)) return { error: "networks must be a list" };
  const networks = [...new Set(raw.map((n) => String(n)))];
  for (const n of networks) if (!NETWORKS[n]) return { error: `Unknown network: ${n.slice(0, 20)}` };
  const payout = {};
  const given = body?.payout && typeof body.payout === "object" ? body.payout : {};
  for (const n of networks) {
    const v = String(given[n] ?? "").trim();
    if (!v) return { error: `${n.replace(":", " on ")}: add the receiving address` };
    if (!NETWORKS[n].test(v)) return { error: `${n.replace(":", " on ")}: that address does not fit the network` };
    payout[n] = v;
  }
  for (const k of Object.keys(given)) if (!networks.includes(k)) return { error: `An address for ${String(k).slice(0, 20)} but the network is not listed` };
  const notes = String(body?.notes ?? "").replace(/\r/g, "").trim();
  if (notes.length > MAX_NOTES) return { error: `Keep the notes under ${MAX_NOTES} characters` };
  return { networks, payout, notes };
}

/** The pool's addresses in the legacy payout shape ([{ method, value, network }]) for the given currency, for PayoutCard. */
export async function legacyPayoutDetails(pool, poolId, currency) {
  const r = (await pool.query("SELECT networks, payout FROM pool_details WHERE pool_id = $1", [poolId])).rows[0];
  if (!r) return [];
  return (r.networks || []).filter((n) => !currency || n.startsWith(`${currency}:`)).filter((n) => r.payout?.[n])
    .map((n) => ({ method: n.split(":")[0], value: r.payout[n], network: n.split(":")[1] }));
}

export function registerPoolRoutes(app, { getPool, requireAuth, sendAuthError, chain = createChainCache({ fetchOffers: fetchChain, freshMs: 15 * 1000 }), readPoolFn = readPool, readTradeFn = readTrade }) {
  // a reference: the on-chain id (1–128 characters, the contract's limit) with an optional "<chain>:" in front
  const okId = (ref) => { if (typeof ref !== "string") return false; const { id } = parseRef(ref); return id.length > 0 && id.length <= 128; };
  const auth = (req, res, from) => {
    const a = requireAuth(req, from);
    if (!a.ok) { sendAuthError(res, a); return null; }
    if ((from === "query" ? req.query : req.body)?.wallet !== a.wallet) { res.status(400).json({ error: "Wallet must match authenticated wallet" }); return null; }
    return a.wallet;
  };
  const chainDown = (res) => res.status(503).json({ error: "Could not read the chain right now" });

  app.get("/api/pools", async (_req, res) => {
    let c;
    try { c = await chain(); } catch { return chainDown(res); }
    const open = c.pools.filter((p) => p.state === "OPEN");
    const ids = open.map((p) => p.poolId);
    const db = getPool();
    const [det, hid] = await Promise.all([
      ids.length ? db.query("SELECT pool_id, networks, notes FROM pool_details WHERE pool_id = ANY($1)", [ids]) : { rows: [] },
      ids.length ? db.query("SELECT offer_id, reason, hidden_at FROM hidden_offers WHERE offer_id = ANY($1)", [ids]) : { rows: [] },
    ]);
    const d = new Map(det.rows.map((x) => [x.pool_id, x])), h = new Map(hid.rows.map((x) => [x.offer_id, x]));
    res.set("Cache-Control", "public, max-age=15");
    return res.json(open.map((p) => ({
      ...p, networks: d.get(p.poolId)?.networks || [], notes: d.get(p.poolId)?.notes || "",
      hidden: h.has(p.poolId) ? { reason: h.get(p.poolId).reason, hiddenAt: h.get(p.poolId).hidden_at } : null,
    })));
  });

  // A creator's pools, closed ones included (the chain lists open pools only): pools with trades from the cached
  // read, plus pools this server knows were created by the wallet (their details, or a create-offer it recorded).
  // Public, like everything on the chain; no addresses.
  app.get("/api/pools/of/:wallet", async (req, res) => {
    const w = String(req.params.wallet || "");
    if (!/^[a-z]:[A-Za-z0-9_.:-]{3,250}$/.test(w)) return res.status(400).json({ error: "Bad wallet" });
    let c;
    try { c = await chain(); } catch { return chainDown(res); }
    const db = getPool();
    const [det, txs] = await Promise.all([
      db.query("SELECT pool_id FROM pool_details WHERE creator = $1 ORDER BY created_at DESC LIMIT $2", [w, MAX_MY_POOLS]),
      db.query("SELECT DISTINCT offer_id FROM trade_txs WHERE sender = $1 AND fn = 'create-offer' AND status = 'confirmed' LIMIT $2", [w, MAX_MY_POOLS]).catch(() => ({ rows: [] })),
    ]);
    const byId = new Map(c.pools.filter((p) => p.creator === w).map((p) => [p.poolId, p]));
    const extra = [...new Set([...det.rows.map((r) => r.pool_id), ...txs.rows.map((r) => r.offer_id)])]
      .filter((id) => okId(id) && !byId.has(id) && parseRef(id).id.startsWith("pool-")).slice(0, MAX_MY_POOLS);
    for (const id of extra) {
      let p; try { p = await readPoolFn(id); } catch { continue; }
      if (p && p.creator === w) byId.set(p.poolId, p);
    }
    const all = [...byId.values()].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).slice(0, MAX_MY_POOLS);
    const ids = all.map((p) => p.poolId);
    const d = ids.length ? (await db.query("SELECT pool_id, networks, notes FROM pool_details WHERE pool_id = ANY($1)", [ids])).rows : [];
    const dm = new Map(d.map((x) => [x.pool_id, x]));
    res.set("Cache-Control", "no-store");
    return res.json(all.map((p) => ({ ...p, networks: dm.get(p.poolId)?.networks || [], notes: dm.get(p.poolId)?.notes || "", hidden: null })));
  });

  app.get("/api/pools/:poolId/details", async (req, res) => {
    const id = req.params.poolId;
    if (!okId(id)) return res.status(400).json({ error: "Bad pool id" });
    const r = (await getPool().query("SELECT networks, notes, updated_at FROM pool_details WHERE pool_id = $1", [id])).rows[0];
    res.set("Cache-Control", "no-store");
    return res.json({ poolId: id, networks: r?.networks || [], notes: r?.notes || "", updatedAt: r?.updated_at || null });
  });

  app.put("/api/pools/:poolId/details", async (req, res) => {
    const w = auth(req, res, "body"); if (!w) return;
    const id = req.params.poolId;
    if (!okId(id)) return res.status(400).json({ error: "Bad pool id" });
    const c = cleanPoolDetails(req.body);
    if (c.error) return res.status(400).json({ error: c.error });
    let p;
    try { p = await readPoolFn(id); } catch { return chainDown(res); }
    // the pool must already be on the chain: that is the only proof of who created it
    if (!p) return res.status(404).json({ error: "Pool not found on the chain yet. Save the details once the pool is confirmed." });
    if (p.creator !== w) return res.status(403).json({ error: "Only the creator of this pool can set its payment details" });
    await getPool().query(
      `INSERT INTO pool_details (pool_id, creator, networks, payout, notes) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (pool_id) DO UPDATE SET networks = EXCLUDED.networks, payout = EXCLUDED.payout, notes = EXCLUDED.notes, updated_at = now()`,
      [id, w, JSON.stringify(c.networks), JSON.stringify(c.payout), c.notes]);
    return res.json({ ok: true, poolId: id, networks: c.networks, notes: c.notes });
  });

  app.get("/api/pools/:poolId/payout", async (req, res) => {
    const w = auth(req, res, "query"); if (!w) return;
    const id = req.params.poolId;
    if (!okId(id)) return res.status(400).json({ error: "Bad pool id" });
    let c, p;
    try {
      c = await chain();
      p = c.pools.find((x) => x.poolId === id) || await readPoolFn(id);
    } catch { return chainDown(res); }
    if (!p) return res.status(404).json({ error: "Pool not found" });
    const isMine = p.creator === w;
    // a party of a trade on this pool, while that trade is live or done (not one that was cancelled or refunded)
    const partyOf = (t) => !!t && t.poolId === id && (t.buyer === w || t.seller === w) && PAYOUT_VISIBLE_STATES.includes(t.state);
    let party = c.trades.some(partyOf);
    const tradeId = typeof req.query.tradeId === "string" ? req.query.tradeId : "";
    if (!party && !isMine && okId(tradeId)) {
      // a take from a moment ago may not be in the cached read yet: check that one trade on the chain
      let t; try { t = await readTradeFn(tradeId); } catch { return chainDown(res); }
      party = partyOf(t);
    }
    if (!isMine && !party && w !== configFor(c, p.chain).arbiter) return res.status(403).json({ error: "Payment details are shown to the two sides of a trade on this offer" });
    const r = (await getPool().query("SELECT networks, payout, notes, updated_at FROM pool_details WHERE pool_id = $1", [id])).rows[0];
    res.set("Cache-Control", "no-store");
    return res.json({ poolId: id, networks: r?.networks || [], payout: r?.payout || {}, notes: r?.notes || "", updatedAt: r?.updated_at || null, isMine });
  });
}
