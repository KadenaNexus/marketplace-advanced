/**
 * Trade transaction history: every on-chain step of a trade, for both sides, on any device.
 *
 * After the site sends an escrow transaction it posts the signed command here. The command is checked
 * (its hash must be the request key, it must call the escrow contract on mainnet: v10 on chain 1, v11 on one
 * of V11_CHAINS) and saved as pending; a watcher asks that chain for the result and keeps it only if it
 * succeeded. Nothing here is taken on trust from the browser: the action, the offer and the chain come from the
 * signed command itself. The offer is saved as a reference ("2:trade-…" on chain 2, see chain.js), which is also
 * how the watcher knows which chain to poll.
 *
 *   POST /api/trade-txs              { cmd, requestKey, sigs? } or { cmd, requestKey, wallet, publicKey, signedCmd }
 *   GET  /api/trades/:offerId/txs    -> [{ requestKey, action, fn, sender, status, at }]
 *
 * Proof that the poster is the transaction's sender: the command's own signatures (`sigs`, at least one by the
 * sender's key over the request key), or the usual proof of ownership for a wallet equal to the sender. With
 * TRADE_TXS_REQUIRE_PROOF=1 a post without either is refused; without it (the default, for sites that still post
 * the bare command) it is accepted but, like every post, limited: at most MAX_PENDING_PER_OFFER pending rows per
 * trade and MAX_FOLLOWING transactions followed closely at once.
 */
import { hash as blakeHash, base64UrlDecodeArr, hexToBin, verifySig } from "@kadena/cryptography-utils";
import { chainConfig, parseRef, toRef } from "./chain.js";

export const MAX_PENDING_PER_OFFER = 20;
export const MAX_FOLLOWING = 50;
const requireProof = () => process.env.TRADE_TXS_REQUIRE_PROOF === "1";

const env = (k, d) => (process.env[k] ?? d);
const cfg = () => ({
  contract: `${env("VITE_CONTRACT_NAMESPACE", "free")}.${env("VITE_CONTRACT_MODULE", "p2p-escrow-v10")}`,
  contractV11: `${env("VITE_CONTRACT_NAMESPACE", "free")}.${env("VITE_CONTRACT_MODULE_V11", "p2p-escrow-v11")}`,
  apis: env("ALERTS_CHAIN_API", "https://api.chainweb-community.org,https://chainweb.chaddex.com,https://api.chainweb.com")
    .split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
});

/** Contract function -> what people see (v10 and v11 names; the first string argument is the offer, pool or trade id). */
export const ACTIONS = {
  "create-offer": "Create offer",
  "accept-offer": "Accept",
  "deposit": "Deposit",
  "mark-paid": "Mark paid",
  "release": "Release",
  "refund": "Refund",
  "close-offer": "Close offer",
  "delete-offer": "Delete offer",
  "cancel-accepted-offer": "Cancel",
  "timeout-accepted-close": "Closed: deposit time ran out",
  "timeout-funded-refund": "Refund: payment time ran out",
  "timeout-paid-dispute": "Dispute: release time ran out",
  // v11
  "top-up": "Top up",
  "withdraw": "Withdraw",
  "update-offer": "Edit offer",
  "take-offer": "Take",
  "take-and-settle": "Swap",
  "cancel": "Cancel",
  "timeout-refund": "Refund: payment time ran out",
  "open-dispute": "Open dispute",
  "resolve": "Resolved by the arbiter",
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The escrow call in a signed command, or null when it is something else. `contract` = one module name or a list.
 * v10 is only on chain 1; v11 on any chain in V11_CHAINS. `offerId` is the reference on that chain.
 */
export function parseEscrowCall(cmd, contract = [cfg().contract, cfg().contractV11], v11Chains = chainConfig().chains) {
  let c;
  try { c = JSON.parse(cmd); } catch { return null; }
  if (c?.networkId !== "mainnet01" && c?.networkId !== env("TRADE_TXS_NETWORK", "mainnet01")) return null;
  const chain = String(c?.meta?.chainId ?? "");
  const code = c?.payload?.exec?.code;
  if (typeof code !== "string" || code.length > 4000) return null;
  const modules = (Array.isArray(contract) ? contract : [contract]).map(escapeRe).join("|");
  let m = code.match(new RegExp(`\\(\\s*(${modules})\\.([a-z-]+)\\s+"([^"]{1,255})"`));
  if (!m) {
    // a free transaction (gas station, contract revision 3): the id comes from the data, "(… (read-msg \"trade\") …)"
    const r = code.match(new RegExp(`^\\(\\s*(${modules})\\.([a-z-]+)\\s+\\(read-msg\\s+"trade"\\)`));
    const id = c?.payload?.exec?.data?.trade;
    if (r && typeof id === "string" && id.length >= 1 && id.length <= 255 && !id.includes('"')) m = [r[0], r[1], r[2], id];
  }
  if (!m || !ACTIONS[m[2]]) return null;
  const isV11 = m[1] === cfg().contractV11;
  if (!(chain === "1" || (isV11 && v11Chains.includes(chain)))) return null;
  // the wallet that acted: the sender, or for a free transaction (paid by the station) the account it authorized
  const isK = (a) => typeof a === "string" && /^k:[0-9a-f]{64}$/i.test(a);
  let sender = isK(c.meta?.sender) ? c.meta.sender : "";
  if (!sender) {
    for (const sg of Array.isArray(c.signers) ? c.signers : []) {
      const auth = (Array.isArray(sg?.clist) ? sg.clist : []).find((x) => /\.ACCOUNT_AUTH$/.test(String(x?.name)));
      if (auth && isK(auth.args?.[0]) && auth.args[0].slice(2).toLowerCase() === String(sg.pubKey || "").toLowerCase()) { sender = auth.args[0]; break; }
    }
  }
  return { fn: m[2], offerId: toRef(chain, m[3]), sender, chain };
}

/**
 * Is one of `sigs` the sender's signature over the request key? A signature without pubKey (some wallets omit
 * it) is taken as the command's signer at the same position.
 */
export function signedBySender(cmd, requestKey, sigs, sender) {
  if (!Array.isArray(sigs) || !/^k:[0-9a-f]{64}$/i.test(sender || "")) return false;
  const key = sender.slice(2).toLowerCase();
  let signers = [];
  try { signers = JSON.parse(cmd)?.signers || []; } catch { return false; }
  let msg;
  try { msg = base64UrlDecodeArr(requestKey); } catch { return false; }
  return sigs.slice(0, 20).some((s, i) => {
    const sig = s && (s.sig ?? s.signature);
    const pub = String((s && s.pubKey) || signers[i]?.pubKey || "").toLowerCase();
    if (typeof sig !== "string" || pub !== key) return false;
    try { return verifySig(msg, hexToBin(sig), hexToBin(pub)); } catch { return false; }
  });
}

/**
 * Save a just-sent escrow transaction as pending. `proven`: a wallet whose proof of ownership the route already
 * checked (null when none was sent). Returns { ok } or { error, status? }.
 */
export async function recordTradeTx(pool, { cmd, requestKey, sigs }, { proven = null, strict = requireProof() } = {}) {
  if (typeof cmd !== "string" || cmd.length > 20000 || typeof requestKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(requestKey)) {
    return { error: "Invalid transaction" };
  }
  if (blakeHash(cmd) !== requestKey) return { error: "The command does not match the request key" };
  const call = parseEscrowCall(cmd);
  if (!call) return { error: "Not a marketplace escrow transaction" };
  if (sigs != null && !signedBySender(cmd, requestKey, sigs, call.sender)) return { error: "The signatures are not the sender's", status: 403 };
  const proof = (sigs != null) || (!!proven && proven === call.sender);
  if (strict && !proof) return { error: "Proof that you sent this transaction is required", status: 403 };
  const pending = await pool.query(`SELECT count(*)::int AS n FROM trade_txs WHERE offer_id = $1 AND status = 'pending' AND request_key <> $2`, [call.offerId, requestKey]);
  if (pending.rows[0].n >= MAX_PENDING_PER_OFFER) return { error: "Too many unconfirmed transactions for this trade right now", status: 429 };
  await pool.query(
    `INSERT INTO trade_txs (request_key, offer_id, fn, sender) VALUES ($1, $2, $3, $4) ON CONFLICT (request_key) DO NOTHING`,
    [requestKey, call.offerId, call.fn, call.sender]
  );
  return { ok: true, offerId: call.offerId, fn: call.fn };
}

/** Results for request keys from `chain`: { key: { status: "success"|"failure", blockTime } } (missing = not mined yet). */
export async function pollChain(keys, chain = "1") {
  let last;
  for (const base of cfg().apis) {
    try {
      const r = await fetch(`${base}/chainweb/0.0/mainnet01/chain/${encodeURIComponent(chain)}/pact/api/v1/poll`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestKeys: keys }), signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${base}`);
      const d = await r.json();
      const out = {};
      for (const [k, v] of Object.entries(d || {})) {
        const t = Number(v?.metaData?.blockTime);
        out[k] = { status: v?.result?.status === "success" ? "success" : "failure", blockTime: Number.isFinite(t) && t > 0 ? new Date(t / 1000) : null };
      }
      return out;
    } catch (e) { last = e; }
  }
  throw last || new Error("No chain API configured");
}

/** One pass: settle pending transactions from the last 30 minutes; give up on older ones. */
export async function settlePending(pool, poll = pollChain, onSettled = () => {}, keys = null) {
  await pool.query(`UPDATE trade_txs SET status = 'unknown' WHERE status = 'pending' AND created_at < NOW() - INTERVAL '30 minutes'`);
  const { rows } = keys
    ? await pool.query(`SELECT request_key, offer_id, fn FROM trade_txs WHERE status = 'pending' AND request_key = ANY($1)`, [keys])
    : await pool.query(`SELECT request_key, offer_id, fn FROM trade_txs WHERE status = 'pending' ORDER BY created_at LIMIT 50`);
  if (!rows.length) return 0;
  // ask each chain about its own transactions (the offer reference says which chain: "2:…" or chain 1)
  const byChain = new Map();
  for (const r of rows) { const ch = parseRef(r.offer_id).chain; byChain.set(ch, [...(byChain.get(ch) || []), r.request_key]); }
  const res = {};
  for (const [ch, ks] of byChain) Object.assign(res, await poll(ks, ch));
  let n = 0;
  for (const [key, v] of Object.entries(res)) {
    const upd = await pool.query(`UPDATE trade_txs SET status = $2, block_time = $3 WHERE request_key = $1 AND status = 'pending' RETURNING offer_id, fn, status`, [key, v.status === "success" ? "ok" : "failed", v.blockTime]);
    if (upd.rows[0]) { n++; try { onSettled({ requestKey: key, offerId: upd.rows[0].offer_id, fn: upd.rows[0].fn, ok: upd.rows[0].status === "ok" }); } catch { /* ignore */ } }
  }
  return n;
}

/**
 * Watch one just-sent transaction closely (every 3 s, up to 4 minutes), so the other side hears about the
 * step within seconds of the block, not at the next 15 s round. At most MAX_FOLLOWING at once; the rest are
 * settled by the 15 s watcher. Returns whether it is being followed.
 */
const following = new Set();
export const followingCount = () => following.size;
export function followTx(getPool, requestKey, onSettled, { everyMs = 3000, forMs = 4 * 60 * 1000, poll = pollChain, max = MAX_FOLLOWING } = {}) {
  if (following.has(requestKey)) return true;
  if (following.size >= max) return false;
  following.add(requestKey);
  const until = Date.now() + forMs;
  const step = async () => {
    const pool = getPool();
    let n = 0;
    try { if (pool) n = await settlePending(pool, poll, onSettled, [requestKey]); } catch { /* try again */ }
    const still = pool ? (await pool.query(`SELECT 1 FROM trade_txs WHERE request_key = $1 AND status = 'pending'`, [requestKey]).catch(() => ({ rows: [] }))).rows.length : 0;
    if (n || !still || Date.now() > until) { following.delete(requestKey); return; }
    setTimeout(step, everyMs).unref?.();
  };
  setTimeout(step, everyMs).unref?.();
  return true;
}

export async function listTradeTxs(pool, offerId) {
  const { rows } = await pool.query(
    `SELECT request_key, fn, sender, status, COALESCE(block_time, created_at) AS at
       FROM trade_txs WHERE offer_id = $1 AND status IN ('ok', 'pending')
      ORDER BY COALESCE(block_time, created_at) ASC, created_at ASC`,
    [offerId]
  );
  return rows.map((r) => ({ requestKey: r.request_key, fn: r.fn, action: ACTIONS[r.fn] || r.fn, sender: r.sender, status: r.status === "ok" ? "confirmed" : "pending", at: r.at }));
}

export function registerTradeTxRoutes(app, getPool, { onSettled = () => {}, requireAuth = null, sendAuthError = null } = {}) {
  app.post("/api/trade-txs", async (req, res) => {
    const pool = getPool();
    if (!pool) return res.status(503).json({ error: "Database not ready" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    let proven = null;
    if (requireAuth && (body.wallet != null || body.signedCmd != null)) {
      const a = requireAuth(req, "body");
      if (!a.ok) return sendAuthError ? sendAuthError(res, a) : res.status(a.status).json({ error: a.error });
      proven = a.wallet;
    }
    try {
      const r = await recordTradeTx(pool, body, { proven });
      if (r.error) return res.status(r.status || 400).json({ error: r.error });
      followTx(getPool, body.requestKey, onSettled);
      return res.json(r);
    } catch (e) {
      console.error("POST /api/trade-txs", e);
      return res.status(500).json({ error: "Database error" });
    }
  });
  app.get("/api/trades/:offerId/txs", async (req, res) => {
    const pool = getPool();
    if (!pool) return res.status(503).json({ error: "Database not ready" });
    const offerId = String(req.params.offerId || "");
    if (!offerId || offerId.length > 255) return res.status(400).json({ error: "Invalid offer" });
    try {
      // settle anything still pending for this trade first, so a fresh step shows as confirmed quickly
      const pending = await pool.query(`SELECT 1 FROM trade_txs WHERE offer_id = $1 AND status = 'pending' LIMIT 1`, [offerId]);
      if (pending.rows.length) await settlePending(pool, pollChain, onSettled).catch(() => {});
      return res.json(await listTradeTxs(pool, offerId));
    } catch (e) {
      console.error("GET /api/trades/:offerId/txs", e);
      return res.status(500).json({ error: "Database error" });
    }
  });
}

export function startTradeTxWatcher(getPool, everyMs = 15000, onSettled = () => {}) {
  const tick = async () => {
    const pool = getPool();
    if (pool) await settlePending(pool, pollChain, onSettled).catch((e) => console.warn("[trade-txs]", e.message));
  };
  const t = setInterval(tick, everyMs);
  t.unref?.();
  return t;
}
