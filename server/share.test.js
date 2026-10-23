/**
 * Share links (server/share.js) and proof-of-ownership headers (server/authHeaders.js). No database, no chain.
 *   node --test server/share.test.js
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { cleanShareRef, describePool, describeTrade, registerShareRoutes, sharePage } from "./share.js";
import { authHeadersToQuery } from "./authHeaders.js";

const SELLER = "k:" + "a".repeat(64);
const pools = new Map(), trades = new Map();
const P = (o) => ({ poolId: "pool-1792669069869-h1yqn5", chain: "1", creator: SELLER, side: "SELL", available: 500, locked: 0, min: 5, max: 100, price: 0.0104, currency: "USDT", token: "", agent: "k:agent", state: "OPEN", ...o });
let server, base;
before(async () => {
  const app = express();
  const fakeDb = { query: async (sql) => (sql.includes("pool_details") ? { rows: [{ networks: ["USDT:TRC20"] }] } : { rows: [{ username: "saudi_kda" }] }) };
  registerShareRoutes(app, { getPool: () => fakeDb, readPoolFn: async (r) => pools.get(r) ?? null, readTradeFn: async (r) => trades.get(r) ?? null, publicUrl: "https://marketplace.kadena.ws" });
  app.get("/echo", authHeadersToQuery, (req, res) => res.json(req.query));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
const get = (path, opts) => fetch(`${base}${path}`, { redirect: "manual", ...opts }).then(async (r) => ({ status: r.status, type: r.headers.get("content-type"), text: await r.text(), location: r.headers.get("location") }));

test("references: pool and trade ids, with a chain in front; anything else is refused", () => {
  assert.equal(cleanShareRef("pool-1792669069869-h1yqn5"), "pool-1792669069869-h1yqn5");
  assert.equal(cleanShareRef("2:trade-1792687536807-KQ8MD5"), "2:trade-1792687536807-kq8md5");
  assert.equal(cleanShareRef("1:pool-1792669069869-h1yqn5"), "pool-1792669069869-h1yqn5", "chain 1 is the bare id");
  for (const bad of ["", "pool-1", "<script>", "pool-1792669069869-h1yqn5\"><x", "offer-1791922870560-pnftbc", "../pool-1792669069869-a"]) assert.equal(cleanShareRef(bad), null, bad);
});

test("what a card says: sell, buy, giveaway, instant, closed, a trade", () => {
  assert.deepEqual(describePool(P(), { networks: ["USDT:TRC20"], username: "saudi_kda" }), {
    title: "Selling 500 KDA for USDT by @saudi_kda",
    description: "0.0104 USDT per KDA on TRC20 · 5–100 KDA per trade · auto-release · KDA held in escrow on the Kadena P2P Marketplace.",
  });
  assert.match(describePool(P({ side: "BUY", available: 50000, agent: "" })).title, /^Buying 50,000 KDA for USDT$/);
  assert.match(describePool(P({ price: 0, currency: "FREE", min: 1, max: 1 })).description, /1 KDA each/);
  assert.match(describePool(P({ token: "n_e595.kb-USDC", currency: "kb-USDC" })).description, /instant swap/);
  assert.match(describePool(P({ state: "CLOSED" })).title, /^Closed offer/);
  assert.deepEqual(describeTrade({ amount: 1, payAmount: 0.01044, currency: "kb-USDC", token: "x", price: 0.01044, state: "COMPLETED" }).title, "Trade: 1 KDA for 0.01044 kb-USDC");
});

test("the page: preview tags for Telegram, WhatsApp and X, escaped, then on to the offer", async () => {
  pools.set("pool-1792669069869-h1yqn5", P());
  for (const path of ["/s/pool-1792669069869-h1yqn5", "/api/share/pool-1792669069869-h1yqn5"]) {
    const r = await get(path);
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/html/);
    assert.match(r.text, /<meta property="og:title" content="Selling 500 KDA for USDT by @saudi_kda">/);
    assert.match(r.text, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(r.text, /<meta property="og:url" content="https:\/\/marketplace\.kadena\.ws\/s\/pool-1792669069869-h1yqn5">/);
    assert.match(r.text, /url=\/\?offer=pool-1792669069869-h1yqn5/);
    assert.doesNotMatch(r.text, /T[1-9A-HJ-NP-Za-km-z]{33}/, "no receiving address");
  }
  const html = sharePage({ ref: "pool-1792669069869-h1yqn5", title: `<script>alert(1)</script>"`, description: "a & b", publicUrl: "https://x" });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;/);
  assert.match((await get("/s/2:trade-1792687536807-zzzzzz")).text, /Trade not found/);
  const bad = await get("/s/%3Cscript%3E");
  assert.deepEqual([bad.status, bad.location], [302, "/"]);
});

test("the chain cannot be read: still a working link with a plain card", async () => {
  const app = express();
  registerShareRoutes(app, { readPoolFn: async () => { throw new Error("down"); }, readTradeFn: async () => null });
  const s = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
  const r = await fetch(`http://127.0.0.1:${s.address().port}/s/pool-1792669069869-h1yqn5`).then((x) => x.text());
  s.close();
  assert.match(r, /og:title" content="Kadena P2P Marketplace"/);
  assert.match(r, /url=\/\?offer=pool-1792669069869-h1yqn5/);
});

test("proof of ownership from headers fills the query; the query still wins and still works alone", async () => {
  const h = { "X-Nexus-Wallet": SELLER, "X-Nexus-Key": "a".repeat(64), "X-Nexus-Auth": '{"cmd":"x","sigs":[]}' };
  let r = JSON.parse((await get("/echo?tradeId=t1", { headers: h })).text);
  assert.deepEqual(r, { tradeId: "t1", wallet: SELLER, publicKey: "a".repeat(64), signedCmd: '{"cmd":"x","sigs":[]}' });
  r = JSON.parse((await get(`/echo?wallet=k:other&publicKey=p&signedCmd=s`, { headers: h })).text);
  assert.deepEqual(r, { wallet: "k:other", publicKey: "p", signedCmd: "s" }, "an explicit query is not overridden");
  r = JSON.parse((await get("/echo")).text);
  assert.deepEqual(r, {});
});
