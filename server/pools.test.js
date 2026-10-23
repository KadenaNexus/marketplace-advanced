/**
 * Escrow v11 pool routes and the per-pool payment details. Needs a Postgres with server/schema.sql applied (CI does this).
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/kadena_nexus node --test server/pools.test.js
 * No chain: pools, trades and the config are injected.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import express from "express";
import { registerPoolRoutes, cleanPoolDetails, legacyPayoutDetails } from "./pools.js";
import { registerPayoutRoutes } from "./payout.js";
import { tradeAsLegacyEscrow, poolsById } from "./chain.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/kadena_nexus" });
const SELLER = "k:" + "a".repeat(64), BUYER = "k:" + "b".repeat(64), OTHER = "k:" + "c".repeat(64), ARB = "k:" + "d".repeat(64), ARB2 = "k:" + "e".repeat(64);
const TRON = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE", EVM = "0x52908400098527886E0F7030069857D2E4169EE7";
const chainPools = new Map(), chainTrades = new Map(), freshTrades = new Map(); // freshTrades: on the chain but not in the cached list yet
const P = (o) => ({ poolId: "pooltest-sell", creator: SELLER, side: "SELL", available: 900, locked: 100, min: 50, max: 500, price: 0.01, currency: "USDT", token: "", payWindow: 1800, agent: "", state: "OPEN", takes: 1, ...o });
const T = (o) => ({ tradeId: "pooltest-trade-1", poolId: "pooltest-sell", seller: SELLER, buyer: BUYER, amount: 100, price: 0.01, currency: "USDT", token: "", payAmount: 1, fee: 0, payWindow: 1800, agent: "", state: "FUNDED", fundedAt: "2026-10-15T10:00:00.000Z", ...o });
let server, base;

const clean = async () => {
  await pool.query("DELETE FROM pool_details WHERE pool_id LIKE 'pooltest-%' OR pool_id LIKE '2:pooltest-%'");
  await pool.query("DELETE FROM trade_txs WHERE offer_id LIKE 'pooltest-%' OR offer_id LIKE '2:pooltest-%'");
  await pool.query("DELETE FROM hidden_offers WHERE offer_id LIKE 'pooltest-%' OR offer_id LIKE '2:pooltest-%'");
  await pool.query("DELETE FROM trade_payouts WHERE offer_id LIKE 'pooltest-%' OR offer_id LIKE '2:pooltest-%'");
};
before(async () => {
  await clean();
  const app = express();
  app.use(express.json());
  // the real server checks a wallet signature; here the wallet in the request is taken as proven
  const requireAuth = (req, from = "body") => { const w = (from === "query" ? req.query : req.body)?.wallet; return w ? { ok: true, wallet: w } : { ok: false, status: 400, error: "Missing wallet" }; };
  const sendAuthError = (res, a) => res.status(a.status).json({ error: a.error });
  registerPoolRoutes(app, {
    getPool: () => pool, requireAuth, sendAuthError,
    // chain 2 has its own config row (here: another arbiter, to see that the pool's chain decides)
    chain: async () => ({ pools: [...chainPools.values()], trades: [...chainTrades.values()], config: { arbiter: ARB, tRelease: 3600 }, configs: { "1": { arbiter: ARB, tRelease: 3600 }, "2": { arbiter: ARB2, tRelease: 3600 } } }),
    readPoolFn: async (id) => chainPools.get(id) ?? null,
    readTradeFn: async (id) => freshTrades.get(id) ?? chainTrades.get(id) ?? null,
  });
  // the legacy payout route, asked with a v11 trade id: resolves from the pool
  registerPayoutRoutes(app, {
    getPool: () => pool, requireAuth, sendAuthError,
    readEscrow: async (id) => { const t = chainTrades.get(id); return t ? tradeAsLegacyEscrow(t, poolsById([...chainPools.values()]), ARB) : null; },
  });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await clean(); await pool.end(); });

const q = (wallet, extra = "") => `wallet=${wallet}&publicKey=x&signedCmd=x${extra}`;
const put = (id, wallet, body) => fetch(`${base}/api/pools/${id}/details`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet, publicKey: "x", signedCmd: "x", ...body }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const getJson = (path) => fetch(`${base}${path}`).then(async (r) => ({ status: r.status, body: await r.json() }));

test("details are validated: known networks, an address that fits each one, notes kept short", () => {
  assert.deepEqual(cleanPoolDetails({ networks: ["USDT:TRC20", "USDC:ERC20", "USDT:TRC20"], payout: { "USDT:TRC20": ` ${TRON} `, "USDC:ERC20": EVM }, notes: " Weekdays only " }),
    { networks: ["USDT:TRC20", "USDC:ERC20"], payout: { "USDT:TRC20": TRON, "USDC:ERC20": EVM }, notes: "Weekdays only" });
  assert.deepEqual(cleanPoolDetails({ networks: [], payout: {} }), { networks: [], payout: {}, notes: "" }, "a token pool or a giveaway needs no network");
  assert.match(cleanPoolDetails({ networks: ["USDT:BEP20"], payout: {} }).error, /Unknown network/);
  assert.match(cleanPoolDetails({ networks: ["USDT:TRC20"], payout: {} }).error, /add the receiving address/);
  assert.match(cleanPoolDetails({ networks: ["USDT:TRC20"], payout: { "USDT:TRC20": EVM } }).error, /does not fit/);
  assert.match(cleanPoolDetails({ networks: ["USDT:ERC20"], payout: { "USDT:ERC20": TRON } }).error, /does not fit/);
  assert.match(cleanPoolDetails({ networks: ["USDT:TRC20"], payout: { "USDT:TRC20": TRON, "USDC:ERC20": EVM } }).error, /not listed/);
  assert.match(cleanPoolDetails({ networks: ["USDT:TRC20"], payout: { "USDT:TRC20": TRON }, notes: "x".repeat(501) }).error, /under 500/);
  assert.ok(cleanPoolDetails({}).error);
});

test("the creator sets the details once the pool is on the chain; everyone sees networks and notes, nobody the addresses", async () => {
  const details = { networks: ["USDT:TRC20", "USDC:ERC20"], payout: { "USDT:TRC20": TRON, "USDC:ERC20": EVM }, notes: "Fast release" };
  assert.equal((await put("pooltest-sell", SELLER, details)).status, 404, "not on the chain yet");
  chainPools.set("pooltest-sell", P());
  assert.equal((await put("pooltest-sell", OTHER, details)).status, 403, "not the creator");
  assert.equal((await put("pooltest-sell", SELLER, { networks: ["USDT:TRC20"], payout: {} })).status, 400);
  let r = await put("pooltest-sell", SELLER, details);
  assert.deepEqual([r.status, r.body.networks, r.body.notes], [200, details.networks, "Fast release"]);
  r = await getJson("/api/pools/pooltest-sell/details");
  assert.deepEqual([r.status, r.body.poolId, r.body.networks, r.body.notes], [200, "pooltest-sell", details.networks, "Fast release"]);
  assert.equal(r.body.payout, undefined, "no addresses in the public answer");
  assert.ok(r.body.updatedAt);
  r = await getJson("/api/pools/pooltest-none/details");
  assert.deepEqual([r.status, r.body.networks, r.body.notes], [200, [], ""], "no row: empty, not an error");
  // a second save replaces
  r = await put("pooltest-sell", SELLER, { networks: ["USDT:ERC20"], payout: { "USDT:ERC20": EVM } });
  assert.deepEqual((await getJson("/api/pools/pooltest-sell/details")).body.networks, ["USDT:ERC20"]);
  await put("pooltest-sell", SELLER, details);
});

test("the addresses: for the creator, a party of a trade on the pool (also one just taken), or the arbiter", async () => {
  const get = (wallet, extra) => getJson(`/api/pools/pooltest-sell/payout?${q(wallet, extra)}`);
  let r = await get(SELLER);
  assert.deepEqual([r.status, r.body.payout, r.body.isMine], [200, { "USDT:TRC20": TRON, "USDC:ERC20": EVM }, true]);
  assert.equal((await get(BUYER)).status, 403, "no trade yet");
  assert.equal((await get(OTHER)).status, 403);
  assert.equal((await get(ARB)).status, 200, "the arbiter");
  // the buyer's take is on the chain but not in the cached list yet: ?tradeId= checks that one trade
  freshTrades.set("pooltest-trade-1", T());
  assert.equal((await get(BUYER)).status, 403, "not in the cached list, no tradeId given");
  assert.equal((await get(BUYER, "&tradeId=pooltest-trade-1")).status, 200);
  assert.equal((await get(OTHER, "&tradeId=pooltest-trade-1")).status, 403, "not a party of that trade");
  assert.equal((await get(BUYER, "&tradeId=pooltest-nope")).status, 403);
  // a round later it is in the cached list
  chainTrades.set("pooltest-trade-1", freshTrades.get("pooltest-trade-1"));
  freshTrades.clear();
  assert.equal((await get(BUYER)).status, 200, "a party of a trade on the pool");
  // a trade that was cancelled or refunded shows the other side nothing any more; a live or finished one does
  for (const state of ["CANCELLED", "REFUNDED"]) {
    chainTrades.set("pooltest-trade-x", T({ tradeId: "pooltest-trade-x", buyer: OTHER, state }));
    assert.equal((await get(OTHER)).status, 403, state);
    assert.equal((await get(OTHER, "&tradeId=pooltest-trade-x")).status, 403, `${state}, asked by trade id`);
  }
  for (const state of ["FUNDED", "PAID", "DISPUTED", "COMPLETED"]) {
    chainTrades.set("pooltest-trade-x", T({ tradeId: "pooltest-trade-x", buyer: OTHER, state }));
    assert.equal((await get(OTHER)).status, 200, state);
  }
  chainTrades.delete("pooltest-trade-x");
  assert.equal((await getJson(`/api/pools/pooltest-none/payout?${q(SELLER)}`)).status, 404);
  assert.equal((await getJson("/api/pools/pooltest-sell/payout")).status, 400, "no wallet");
});

test("GET /api/pools: open pools from the chain with networks, notes and the hidden flag", async () => {
  chainPools.set("pooltest-buy", P({ poolId: "pooltest-buy", creator: BUYER, side: "BUY", currency: "USDC" }));
  chainPools.set("pooltest-closed", P({ poolId: "pooltest-closed", state: "CLOSED" }));
  await pool.query("INSERT INTO hidden_offers (offer_id, hidden_by, reason) VALUES ('pooltest-buy', $1, 'stale')", [ARB]);
  const r = await getJson("/api/pools");
  assert.equal(r.status, 200);
  const mine = r.body.filter((p) => p.poolId.startsWith("pooltest-"));
  assert.deepEqual(mine.map((p) => p.poolId).sort(), ["pooltest-buy", "pooltest-sell"], "closed pools are not listed");
  const sell = mine.find((p) => p.poolId === "pooltest-sell"), buy = mine.find((p) => p.poolId === "pooltest-buy");
  assert.deepEqual([sell.available, sell.min, sell.max, sell.price, sell.currency, sell.networks, sell.notes, sell.hidden], [900, 50, 500, 0.01, "USDT", ["USDT:TRC20", "USDC:ERC20"], "Fast release", null]);
  assert.deepEqual([buy.networks, buy.notes, buy.hidden.reason], [[], "", "stale"]);
  assert.equal(sell.payout, undefined, "never the addresses");
});

test("legacy payout route with a v11 trade id: a SELL trade answers with the pool's addresses for its currency", async () => {
  const getP = (id, wallet) => fetch(`${base}/api/offers/${id}/payout?${q(wallet)}`).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.deepEqual(await legacyPayoutDetails(pool, "pooltest-sell", "USDT"), [{ method: "USDT", value: TRON, network: "TRC20" }]);
  assert.deepEqual(await legacyPayoutDetails(pool, "pooltest-sell", "USDC"), [{ method: "USDC", value: EVM, network: "ERC20" }]);
  assert.deepEqual(await legacyPayoutDetails(pool, "pooltest-none", "USDT"), []);
  let r = await getP("pooltest-trade-1", BUYER);
  assert.deepEqual([r.status, r.body.details, r.body.isMine, r.body.editable, r.body.poolId], [200, [{ method: "USDT", value: TRON, network: "TRC20" }], false, false, "pooltest-sell"]);
  r = await getP("pooltest-trade-1", SELLER);
  assert.deepEqual([r.body.isMine, r.body.editable], [true, false], "set on the pool, not per trade");
  assert.equal((await getP("pooltest-trade-1", OTHER)).status, 403);
  const putP = (id, wallet, details) => fetch(`${base}/api/offers/${id}/payout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet, publicKey: "x", signedCmd: "x", details }) }).then((x) => x.status);
  assert.equal(await putP("pooltest-trade-1", SELLER, [{ method: "USDT", value: TRON, network: "TRC20" }]), 409, "SELL: the pool holds the addresses");
  // BUY pool: the taker (KDA holder) sets where to be paid while the trade is FUNDED; the payer (creator) sees it
  chainTrades.set("pooltest-trade-2", T({ tradeId: "pooltest-trade-2", poolId: "pooltest-buy", currency: "USDC", seller: SELLER, buyer: BUYER }));
  assert.equal(await putP("pooltest-trade-2", BUYER, [{ method: "USDC", value: EVM, network: "ERC20" }]), 403, "the payer cannot");
  assert.equal(await putP("pooltest-trade-2", SELLER, [{ method: "USDC", value: EVM, network: "ERC20" }]), 200);
  r = await getP("pooltest-trade-2", BUYER);
  assert.deepEqual([r.status, r.body.details[0].value, r.body.isMine], [200, EVM, false]);
  chainTrades.set("pooltest-trade-2", T({ tradeId: "pooltest-trade-2", poolId: "pooltest-buy", currency: "USDC", state: "PAID" }));
  assert.equal(await putP("pooltest-trade-2", SELLER, [{ method: "USDC", value: EVM, network: "ERC20" }]), 409, "locked once paid");
});

test("chain 2: the same pool id is another pool, with its own creator, details and arbiter", async () => {
  // on chain 1 "pooltest-sell" is SELLER's (above); on chain 2 the same id is OTHER's kb-USDC pool
  const ref = "2:pooltest-sell";
  chainPools.set(ref, P({ poolId: ref, chain: "2", creator: OTHER, currency: "kb-USDC", token: "n_e595727b657fbbb3b8e362a05a7bb8d12865c1ff.kb-USDC" }));
  assert.equal((await put(encodeURIComponent(ref), SELLER, { networks: [], payout: {}, notes: "x" })).status, 403, "SELLER created the chain-1 pool, not this one");
  let r = await put(encodeURIComponent(ref), OTHER, { networks: [], payout: {}, notes: "Instant kb-USDC" });
  assert.deepEqual([r.status, r.body.poolId], [200, ref]);
  r = await getJson(`/api/pools/${ref}/details`);
  assert.deepEqual([r.body.poolId, r.body.networks, r.body.notes], [ref, [], "Instant kb-USDC"]);
  r = await getJson("/api/pools/pooltest-sell/details");
  assert.deepEqual([r.body.networks, r.body.notes], [["USDT:TRC20", "USDC:ERC20"], "Fast release"], "the chain-1 pool's row is untouched");
  const listed = (await getJson("/api/pools")).body.filter((p) => p.poolId.endsWith("pooltest-sell"));
  assert.deepEqual(listed.map((p) => [p.poolId, p.chain ?? "1", p.creator, p.notes]).sort(), [["2:pooltest-sell", "2", OTHER, "Instant kb-USDC"], ["pooltest-sell", "1", SELLER, "Fast release"]]);
  // payout: the chain-2 pool's creator and chain 2's arbiter; a party of the chain-1 pool is not a party here
  assert.deepEqual((await getJson(`/api/pools/${encodeURIComponent(ref)}/payout?${q(OTHER)}`)).body.isMine, true);
  assert.equal((await getJson(`/api/pools/${encodeURIComponent(ref)}/payout?${q(BUYER)}`)).status, 403, "BUYER's trade is on the chain-1 pool");
  assert.equal((await getJson(`/api/pools/${encodeURIComponent(ref)}/payout?${q(ARB2)}`)).status, 200, "chain 2's arbiter");
  assert.equal((await getJson(`/api/pools/${encodeURIComponent(ref)}/payout?${q(ARB)}`)).status, 403, "chain 1's arbiter is not chain 2's");
  assert.equal((await getJson(`/api/pools/${encodeURIComponent("2:" + "x".repeat(129))}/details`)).status, 400, "the on-chain id is limited to 128 characters");
  assert.equal((await getJson(`/api/pools/${encodeURIComponent("2:" + "x".repeat(128))}/details`)).status, 200);
});

test("GET /api/pools/of/:wallet: the creator's pools, closed ones too (from their details, a recorded create, or a trade), newest first", async () => {
  chainPools.clear(); chainTrades.clear();
  // on the chain: one open pool in the cached list, one closed pool with a trade, two closed pools known only by id
  chainPools.set("pooltest-open", P({ poolId: "pooltest-open", createdAt: "2026-10-20T10:00:00.000Z" }));
  chainPools.set("pooltest-closed-traded", P({ poolId: "pooltest-closed-traded", state: "CLOSED", createdAt: "2026-10-18T10:00:00.000Z" }));
  chainTrades.set("pooltest-t9", T({ tradeId: "pooltest-t9", poolId: "pooltest-closed-traded", state: "COMPLETED" }));
  const fromDetails = P({ poolId: "pooltest-closed-details", state: "CLOSED", createdAt: "2026-10-19T10:00:00.000Z" });
  const fromTx = P({ poolId: "2:pooltest-closed-tx", chain: "2", state: "CLOSED", createdAt: "2026-10-21T10:00:00.000Z" });
  const someoneElses = P({ poolId: "pooltest-other", creator: OTHER, state: "CLOSED" });
  await pool.query("INSERT INTO pool_details (pool_id, creator, networks, payout, notes) VALUES ('pooltest-closed-details', $1, '[\"USDT:TRC20\"]', '{}', 'old')", [SELLER]);
  await pool.query("INSERT INTO trade_txs (request_key, offer_id, fn, sender, status) VALUES ('pooltest-rk1', '2:pooltest-closed-tx', 'create-offer', $1, 'confirmed'), ('pooltest-rk2', 'pooltest-other', 'create-offer', $1, 'confirmed'), ('pooltest-rk3', 'pooltest-pending', 'create-offer', $1, 'pending')", [SELLER]);
  // the cached list holds open pools and pools with trades; the others are read one by one
  chainPools.set("pooltest-closed-details", fromDetails); chainPools.set("2:pooltest-closed-tx", fromTx); chainPools.set("pooltest-other", someoneElses);
  const r = await getJson(`/api/pools/of/${SELLER}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((p) => [p.poolId, p.state]),
    [["2:pooltest-closed-tx", "CLOSED"], ["pooltest-open", "OPEN"], ["pooltest-closed-details", "CLOSED"], ["pooltest-closed-traded", "CLOSED"]],
    "newest first; another wallet's pool and an unconfirmed create are left out");
  assert.deepEqual(r.body.find((p) => p.poolId === "pooltest-closed-details").networks, ["USDT:TRC20"]);
  assert.ok(r.body.every((p) => !("payout" in p)), "no addresses");
  assert.equal((await getJson("/api/pools/of/not-a-wallet")).status, 400);
  assert.deepEqual((await getJson(`/api/pools/of/${BUYER}`)).body, []);
});
