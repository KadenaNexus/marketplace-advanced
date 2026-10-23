/**
 * Trade transaction history tests. Needs a Postgres with server/schema.sql applied (CI does this).
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/kadena_nexus node --test server/tradeTxs.test.js
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { hash, genKeyPair, signHash } from "@kadena/cryptography-utils";
import { parseEscrowCall, recordTradeTx, settlePending, listTradeTxs, followTx, signedBySender, followingCount, MAX_PENDING_PER_OFFER } from "./tradeTxs.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/kadena_nexus" });
const OFFER = "offer-test-tradetxs";
const SELLER = "k:" + "a".repeat(64);
const BUYER = "k:" + "b".repeat(64);
const clean = () => pool.query("DELETE FROM trade_txs WHERE offer_id LIKE 'offer-test-%' OR offer_id LIKE '2:offer-test-%'");

let n = 0;
const cmdFor = (code, sender, extra = {}) => JSON.stringify({
  networkId: "mainnet01",
  payload: { exec: { code, data: {} } },
  signers: [],
  meta: { chainId: "1", sender, gasLimit: 3000, gasPrice: 1e-8, ttl: 600, creationTime: 1760000000 + n },
  nonce: `t${n++}`,
  ...extra,
});
const send = async (code, sender, extra) => { const cmd = cmdFor(code, sender, extra); const requestKey = hash(cmd); return { cmd, requestKey, r: await recordTradeTx(pool, { cmd, requestKey }) }; };

before(clean);
after(async () => { await clean(); await pool.end(); });

test("reads the escrow call from a signed command", () => {
  assert.deepEqual(parseEscrowCall(cmdFor(`(free.p2p-escrow-v10.accept-offer "${OFFER}" "${BUYER}")`, BUYER)), { fn: "accept-offer", offerId: OFFER, sender: BUYER, chain: "1" });
  assert.equal(parseEscrowCall(cmdFor(`(coin.transfer "${BUYER}" "${SELLER}" 1.0)`, BUYER)), null, "not the escrow");
  assert.equal(parseEscrowCall(cmdFor(`(free.p2p-escrow-v10.get-escrow "${OFFER}")`, BUYER)), null, "a read is not a step");
  assert.equal(parseEscrowCall(cmdFor(`(free.p2p-escrow-v10.deposit "${OFFER}")`, SELLER, { networkId: "testnet04" })), null, "other network");
  assert.equal(parseEscrowCall("not json"), null);
  // escrow v11: pools and trades, the first string is the pool or trade id
  assert.deepEqual(parseEscrowCall(cmdFor(`(free.p2p-escrow-v11.take-offer "trade-1-abc" "pool-1-xyz" "${BUYER}" 100.0)`, BUYER)), { fn: "take-offer", offerId: "trade-1-abc", sender: BUYER, chain: "1" });
  assert.deepEqual(parseEscrowCall(cmdFor(`(free.p2p-escrow-v11.create-offer "pool-1-xyz" "${SELLER}" "SELL" 1000.0 50.0 500.0 0.01 "USDT" "" 1800 free.p2p-escrow-v11.EPOCH "")`, SELLER)).offerId, "pool-1-xyz");
  for (const fn of ["top-up", "withdraw", "update-offer", "close-offer", "take-and-settle", "mark-paid", "release", "cancel", "timeout-refund", "open-dispute", "resolve"]) {
    assert.equal(parseEscrowCall(cmdFor(`(free.p2p-escrow-v11.${fn} "x-1" 1.0)`, SELLER))?.fn, fn, fn);
  }
  assert.equal(parseEscrowCall(cmdFor(`(free.p2p-escrow-v11.get-offer "pool-1")`, SELLER)), null, "a read is not a step");
  assert.equal(parseEscrowCall(cmdFor(`(free.p2p-escrow-v11.release "x-1")`, SELLER), "free.p2p-escrow-v10"), null, "only the modules asked for");
});

test("a free transaction (paid by the gas station): the id comes from the data, the wallet from the signer's ACCOUNT_AUTH", () => {
  const key = "b".repeat(64), STATION = "u:free.p2p-escrow-v11-gas.gas-payer-guard:abc";
  const free = (code, data, signers) => JSON.stringify({ networkId: "mainnet01", payload: { exec: { code, data } }, signers, meta: { chainId: "1", sender: STATION }, nonce: `f${n++}` });
  const auth = [{ pubKey: key, clist: [{ name: "free.p2p-escrow-v11-gas.GAS_PAYER", args: [BUYER, { int: 2000 }, { decimal: "0.00000001" }] }, { name: "free.p2p-escrow-v11.ACCOUNT_AUTH", args: [BUYER] }] }];
  const TAKE = '(free.p2p-escrow-v11.take-offer (read-msg "trade") (read-msg "offer") (read-msg "taker") (read-decimal "amount"))';
  assert.deepEqual(parseEscrowCall(free(TAKE, { trade: "trade-1-abc", offer: "pool-1-xyz" }, auth)), { fn: "take-offer", offerId: "trade-1-abc", sender: BUYER, chain: "1" });
  assert.deepEqual(parseEscrowCall(free('(free.p2p-escrow-v11.mark-paid (read-msg "trade"))', { trade: "trade-1-abc" }, auth))?.fn, "mark-paid");
  assert.equal(parseEscrowCall(free(TAKE, {}, auth)), null, "no trade in the data");
  assert.equal(parseEscrowCall(free(TAKE, { trade: 'x"y' }, auth)), null);
  // an ACCOUNT_AUTH for another key's account is not taken as the sender
  const other = [{ pubKey: "c".repeat(64), clist: [{ name: "free.p2p-escrow-v11.ACCOUNT_AUTH", args: [BUYER] }] }];
  assert.equal(parseEscrowCall(free(TAKE, { trade: "trade-1-abc" }, other)).sender, "");
});

test("v11 on chain 2: the step is saved under the chain-2 reference; v10 and unknown chains are refused", () => {
  const on = (chain) => ({ meta: { chainId: chain, sender: BUYER, gasLimit: 3000, gasPrice: 1e-8, ttl: 600, creationTime: 1760000000 } });
  assert.deepEqual(parseEscrowCall(cmdFor(`(free.p2p-escrow-v11.take-and-settle "trade-1-abc" "pool-1-xyz" "${BUYER}" 10.0 n_e595727b657fbbb3b8e362a05a7bb8d12865c1ff.kb-ETH 0.000045)`, BUYER, on("2"))),
    { fn: "take-and-settle", offerId: "2:trade-1-abc", sender: BUYER, chain: "2" });
  assert.equal(parseEscrowCall(cmdFor(`(free.p2p-escrow-v10.accept-offer "${OFFER}" "${BUYER}")`, BUYER, on("2"))), null, "v10 is on chain 1 only");
  assert.equal(parseEscrowCall(cmdFor(`(free.p2p-escrow-v11.release "trade-1-abc")`, BUYER, on("3"))), null, "v11 is not on chain 3");
  assert.equal(parseEscrowCall(cmdFor(`(free.p2p-escrow-v11.release "trade-1-abc")`, BUYER, on("2")), undefined, ["1"]), null, "V11_CHAINS=1 only");
});

test("the same trade id on chains 1 and 2: two histories, each settled by asking its own chain", async () => {
  const id = "offer-test-twochains";
  const on2 = { meta: { chainId: "2", sender: BUYER, gasLimit: 3000, gasPrice: 1e-8, ttl: 600, creationTime: 1760000001 } };
  const one = await send(`(free.p2p-escrow-v11.mark-paid "${id}")`, BUYER);
  const two = await send(`(free.p2p-escrow-v11.mark-paid "${id}")`, BUYER, on2);
  assert.deepEqual([one.r.offerId, two.r.offerId], [id, `2:${id}`]);
  const asked = {};
  await settlePending(pool, async (keys, chain) => {
    asked[chain] = keys.filter((k) => k === one.requestKey || k === two.requestKey);
    return Object.fromEntries(keys.map((k) => [k, { status: k === two.requestKey ? "failure" : "success", blockTime: new Date() }]));
  });
  assert.deepEqual(asked["1"], [one.requestKey], "chain 1 is asked about the chain-1 step only");
  assert.deepEqual(asked["2"], [two.requestKey], "chain 2 is asked about the chain-2 step only");
  assert.deepEqual((await listTradeTxs(pool, id)).map((t) => t.status), ["confirmed"]);
  assert.deepEqual(await listTradeTxs(pool, `2:${id}`), [], "the failed chain-2 step is not listed, and not mixed into chain 1");
});

test("records steps, refuses a command that does not match its key, settles with the chain result", async () => {
  const a = await send(`(free.p2p-escrow-v10.create-offer "${OFFER}" "${SELLER}" 25.00000000 "SELL")`, SELLER);
  const b = await send(`(free.p2p-escrow-v10.accept-offer "${OFFER}" "${BUYER}")`, BUYER);
  const c = await send(`(free.p2p-escrow-v10.deposit "${OFFER}")`, SELLER);
  assert.ok(a.r.ok && b.r.ok && c.r.ok);
  assert.equal((await recordTradeTx(pool, { cmd: a.cmd, requestKey: b.requestKey })).error, "The command does not match the request key");
  assert.ok((await recordTradeTx(pool, { cmd: cmdFor(`(coin.transfer "a" "b" 1.0)`, SELLER), requestKey: "x".repeat(43) })).error);
  // the same step posted twice is kept once
  assert.ok((await recordTradeTx(pool, { cmd: a.cmd, requestKey: a.requestKey })).ok);

  let list = await listTradeTxs(pool, OFFER);
  assert.deepEqual(list.map((t) => [t.action, t.status]), [["Create offer", "pending"], ["Accept", "pending"], ["Deposit", "pending"]]);

  const t0 = Date.parse("2026-10-13T10:00:00Z") * 1000; // chain block time is in microseconds
  const poll = async (keys) => ({
    [a.requestKey]: { status: "success", blockTime: new Date(t0 / 1000) },
    [b.requestKey]: { status: "success", blockTime: new Date(t0 / 1000 + 60000) },
    [c.requestKey]: { status: "failure", blockTime: new Date(t0 / 1000 + 120000) },
    ...Object.fromEntries(keys.filter((k) => ![a, b, c].some((x) => x.requestKey === k)).map((k) => [k, { status: "success", blockTime: null }])),
  });
  await settlePending(pool, poll);
  list = await listTradeTxs(pool, OFFER);
  assert.deepEqual(list.map((t) => [t.action, t.status, t.sender]), [["Create offer", "confirmed", SELLER], ["Accept", "confirmed", BUYER]], "a failed step is not listed");
  assert.equal(new Date(list[1].at).toISOString(), "2026-10-13T10:01:00.000Z");
});

test("a step the chain never confirms stops being checked after 30 minutes", async () => {
  const d = await send(`(free.p2p-escrow-v10.mark-paid "offer-test-old")`, BUYER);
  await pool.query("UPDATE trade_txs SET created_at = NOW() - INTERVAL '31 minutes' WHERE request_key = $1", [d.requestKey]);
  let asked = [];
  await settlePending(pool, async (keys) => { asked = keys; return {}; });
  assert.ok(!asked.includes(d.requestKey));
  assert.deepEqual(await listTradeTxs(pool, "offer-test-old"), []);
});

test("a just-sent step is followed closely and announced once it is confirmed", async () => {
  const e = await send(`(free.p2p-escrow-v10.release "offer-test-follow")`, SELLER);
  let polls = 0;
  const poll = async (keys) => (++polls < 3 ? {} : Object.fromEntries(keys.map((k) => [k, { status: "success", blockTime: new Date() }])));
  const seen = [];
  await new Promise((resolve) => {
    followTx(() => pool, e.requestKey, (x) => { seen.push(x); resolve(); }, { everyMs: 30, poll });
    setTimeout(resolve, 3000);
  });
  assert.deepEqual(seen.map((x) => [x.offerId, x.fn, x.ok]), [["offer-test-follow", "release", true]]);
  assert.ok(polls >= 3);
  assert.deepEqual((await listTradeTxs(pool, "offer-test-follow")).map((t) => t.status), ["confirmed"]);
});

test("proof of the sender: the command's own signature, or the signed-in wallet; a stranger's signature is refused", async () => {
  const kp = genKeyPair(), me = `k:${kp.publicKey}`, other = genKeyPair();
  const cmd = cmdFor(`(free.p2p-escrow-v10.mark-paid "offer-test-proof")`, me, { signers: [{ pubKey: kp.publicKey, clist: [] }] });
  const requestKey = hash(cmd);
  const mine = signHash(requestKey, kp).sig, theirs = signHash(requestKey, other).sig;
  assert.equal(signedBySender(cmd, requestKey, [{ sig: mine, pubKey: kp.publicKey }], me), true);
  assert.equal(signedBySender(cmd, requestKey, [{ sig: mine }], me), true, "no pubKey in the signature: the command's signer at that position");
  assert.equal(signedBySender(cmd, requestKey, [{ signature: mine, pubKey: kp.publicKey }], me), true, "Ecko's field name");
  assert.equal(signedBySender(cmd, requestKey, [{ sig: theirs, pubKey: other.publicKey }], me), false, "signed by someone else");
  assert.equal(signedBySender(cmd, requestKey, [{ sig: theirs, pubKey: kp.publicKey }], me), false, "a wrong signature under the right key");
  assert.equal(signedBySender(cmd, requestKey, [], me), false);
  assert.equal(signedBySender(cmd, requestKey, [{ sig: mine, pubKey: kp.publicKey }], ""), false, "no k: sender");
  // the record: with signatures, with the wallet's proof, or (not strict) bare
  assert.deepEqual((await recordTradeTx(pool, { cmd, requestKey, sigs: [{ sig: theirs, pubKey: other.publicKey }] })), { error: "The signatures are not the sender's", status: 403 });
  assert.equal((await recordTradeTx(pool, { cmd, requestKey, sigs: [{ sig: mine }] }, { strict: true })).ok, true);
  assert.equal((await recordTradeTx(pool, { cmd, requestKey }, { proven: me, strict: true })).ok, true);
  assert.equal((await recordTradeTx(pool, { cmd, requestKey }, { proven: BUYER, strict: true })).status, 403, "signed in as another wallet");
  assert.equal((await recordTradeTx(pool, { cmd, requestKey }, { strict: true })).status, 403, "strict: no proof at all");
  assert.equal((await recordTradeTx(pool, { cmd, requestKey }, { strict: false })).ok, true, "not strict: the bare command is still taken");
  assert.equal(process.env.TRADE_TXS_REQUIRE_PROOF, undefined, "the default is not strict");
  await pool.query("DELETE FROM trade_txs WHERE request_key = $1", [requestKey]);
});

test("a trade keeps at most a few unconfirmed steps, and only so many are followed closely at once", async () => {
  const id = "offer-test-cap";
  for (let i = 0; i < MAX_PENDING_PER_OFFER; i++) assert.equal((await send(`(free.p2p-escrow-v10.mark-paid "${id}")`, BUYER)).r.ok, true);
  const over = await send(`(free.p2p-escrow-v10.mark-paid "${id}")`, BUYER);
  assert.deepEqual(over.r, { error: "Too many unconfirmed transactions for this trade right now", status: 429 });
  const first = (await pool.query("SELECT request_key FROM trade_txs WHERE offer_id = $1 ORDER BY created_at LIMIT 1", [id])).rows[0].request_key;
  assert.equal((await recordTradeTx(pool, { cmd: null, requestKey: first })).error, "Invalid transaction");
  await pool.query("UPDATE trade_txs SET status = 'ok' WHERE offer_id = $1", [id]);
  assert.equal((await send(`(free.p2p-escrow-v10.release "${id}")`, SELLER)).r.ok, true, "confirmed steps do not count");
  // following: a never-answering poll keeps each one in the set until its time is up
  const never = async () => ({});
  const before = followingCount();
  const keys = [];
  for (let i = 0; i < 3; i++) { const t = await send(`(free.p2p-escrow-v10.mark-paid "offer-test-follow-cap-${i}")`, BUYER); keys.push(t.requestKey); }
  assert.equal(followTx(() => pool, keys[0], () => {}, { everyMs: 50, forMs: 200, poll: never, max: before + 2 }), true);
  assert.equal(followTx(() => pool, keys[1], () => {}, { everyMs: 50, forMs: 200, poll: never, max: before + 2 }), true);
  assert.equal(followTx(() => pool, keys[1], () => {}, { everyMs: 50, forMs: 200, poll: never, max: before + 2 }), true, "already followed");
  assert.equal(followTx(() => pool, keys[2], () => {}, { everyMs: 50, forMs: 200, poll: never, max: before + 2 }), false, "full: left to the 15 s watcher");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(followingCount(), before, "all let go after their time");
});
