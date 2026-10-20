// near-agent-wallet local signer daemon — signs NEAR testnet txs with keys from ~/.near-credentials.
// Binds 127.0.0.1 only. The browser never sees a private key: it POSTs unsigned
// wallet-selector-style actions here; we sign + broadcast + return the outcome.
import http from "node:http";
import https from "node:https";
import { sha256 } from "@noble/hashes/sha256";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as nearAPI from "near-api-js";

const PORT = 8391;
const NETWORK = "testnet";
const RPC = "https://rpc.testnet.fastnear.com";
const CREDS_DIR = path.join(os.homedir(), ".near-credentials", NETWORK);
const LOG = path.join(import.meta.dirname, "sign.log");
// Policy is env-tunable; defaults are safe for testnet agent testing.
const MAX_DEPOSIT = BigInt(process.env.MAX_DEPOSIT_NEAR || "5") * 10n ** 24n;
const RECEIVER_SUFFIX = process.env.ALLOW_RECEIVER_SUFFIX || "testnet"; // receivers must end with this
const MAINNET_BLOCK = NETWORK === "mainnet" && !process.env.ALLOW_MAINNET;

const { KeyPair, transactions, providers } = nearAPI;
const provider = new providers.JsonRpcProvider({ url: RPC });

let activeAccount = null; // set by /activate (executor signIn)

function log(line) {
  const entry = `${new Date().toISOString()} ${line}`;
  console.log(entry);
  fs.appendFileSync(LOG, entry + "\n");
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Access-Control-Request-Private-Network");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  // https dApps → loopback daemon: Chrome's Private Network Access preflight
  // stalls forever unless this is present on the OPTIONS response.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function json(res, code, body) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function listAccounts() {
  if (!fs.existsSync(CREDS_DIR)) return [];
  return fs.readdirSync(CREDS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(CREDS_DIR, f), "utf8"));
        return { accountId: d.account_id, public_key: d.public_key, file: f };
      } catch { return null; }
    })
    .filter(Boolean);
}

function keyFor(accountId) {
  const f = path.join(CREDS_DIR, `${accountId}.json`);
  if (!fs.existsSync(f)) throw new Error(`no key file for ${accountId}`);
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  return KeyPair.fromString(d.private_key);
}

function checkPolicy(receiverId, actions) {
  if (MAINNET_BLOCK) throw new Error("POLICY: mainnet disabled (set ALLOW_MAINNET=1 to override)");
  if (!receiverId || !receiverId.endsWith(RECEIVER_SUFFIX)) {
    throw new Error(`POLICY: receiver ${receiverId} does not end with ${RECEIVER_SUFFIX}`);
  }
  let total = 0n;
  for (const a of actions) {
    if (a.type !== "FunctionCall") throw new Error(`POLICY: unsupported action ${a.type}`);
    const p = a.params || {};
    if (!p.methodName) throw new Error("POLICY: missing methodName");
    if (typeof p.args !== "object") throw new Error("POLICY: args must be an object");
    if (BigInt(p.gas || "0") > 300_000_000_000_000n) throw new Error("POLICY: gas over 300 Tgas");
    total += BigInt(p.deposit || "0");
  }
  if (total > MAX_DEPOSIT) throw new Error(`POLICY: deposit ${total} exceeds cap ${MAX_DEPOSIT}`);
}

function buildActions(actions) {
  return actions.map((a) => {
    const p = a.params;
    return transactions.functionCall(
      p.methodName,
      p.args,
      BigInt(p.gas),
      BigInt(p.deposit || "0"),
    );
  });
}

async function signAndSend(body) {
  const signerId = body.signerId || activeAccount;
  if (!signerId) throw new Error("no active account (sign in first)");
  if (body.signerId && body.signerId !== activeAccount && body.signerId !== signerId) {
    throw new Error("POLICY: signerId mismatch with active account");
  }
  const receiverId = body.receiverId;
  checkPolicy(receiverId, body.actions || []);
  const kp = keyFor(signerId);
  const pk = kp.getPublicKey();

  // read the optimistic tip: "final" lags just-landed txs by ~2 blocks, so a
  // tx sent right after another one re-derives the consumed nonce and bounces
  const accessKey = await provider.query({
    request_type: "view_access_key", account_id: signerId, public_key: pk.toString(), finality: "optimistic",
  });
  if (accessKey.permission !== "FullAccess") throw new Error("key is not full-access");
  const block = await provider.block({ finality: "optimistic" });

  const buildSigned = (ak, blk) => {
    const tx = new transactions.Transaction({
      signerId,
      publicKey: pk,
      nonce: BigInt(ak.nonce) + 1n,
      blockHash: nearAPI.utils.serialize.base_decode(blk.header.hash),
      receiverId,
      actions: buildActions(body.actions),
    });
    const digest = new Uint8Array(sha256(tx.encode()));
    const sig = kp.sign(digest);
    return new transactions.SignedTransaction({
      transaction: tx,
      signature: new transactions.Signature({ keyType: tx.publicKey.keyType, data: sig.signature }),
    });
  };

  // one retry on a nonce collision — the optimistic tip can still move under
  // us between the query and the send; re-reading it once self-heals
  let outcome;
  for (let attempt = 0; ; attempt++) {
    try {
      outcome = await provider.sendTransaction(attempt === 0 ? buildSigned(accessKey, block) : buildSigned(
        await provider.query({
          request_type: "view_access_key", account_id: signerId, public_key: pk.toString(), finality: "optimistic",
        }),
        await provider.block({ finality: "optimistic" }),
      ));
      break;
    } catch (e) {
      if (attempt === 0 && /nonce/i.test(String(e?.error?.message || e?.message || e))) continue;
      throw e;
    }
  }
  const hash = outcome.transaction.hash;
  const failed = typeof outcome.status === "object" && "Failure" in outcome.status;
  log(`${failed ? "FAIL" : "SENT"} ${signerId} -> ${receiverId} :: ${(body.actions || []).map((a) => a.params?.methodName).join(",")} :: ${hash}`);
  if (failed) {
    const err = JSON.stringify(outcome.status.Failure).slice(0, 300);
    const e = new Error(`tx failed: ${err}`);
    e.outcome = { hash, status: outcome.status };
    throw e;
  }
  return {
    transaction: { hash },
    status: outcome.status,
    transaction_outcome: { outcome: { gas_burnt: outcome.transaction_outcome?.outcome?.gas_burnt } },
    receipts_outcome: (outcome.receipts_outcome || []).map((r) => ({
      id: r.id,
      outcome: {
        executor_id: r.outcome?.executor_id,
        gas_burnt: r.outcome?.gas_burnt,
        logs: r.outcome?.logs || [],
      },
    })),
  };
}

const EXECUTOR = fs.readFileSync(path.join(import.meta.dirname, "executor.js"), "utf8");

// Serve a dApp front-end from the loopback origin so browser network isolation
// (public-https pages can't reach loopback daemons in modern Chrome) never
// blocks agent mode. The page is fetched live from APP_URL and cached 60s —
// deploy the dApp normally, agent mode always gets the current build.
const APP_URL = process.env.APP_URL || "https://crosspost-relay-bridge.kj95hgdgnn.workers.dev/";
let appCache = { at: 0, body: "" };
async function serveApp(res) {
  const now = Date.now();
  if (!appCache.body || now - appCache.at > 60000) {
    const r = await fetch(APP_URL);
    appCache = { at: now, body: await r.text() };
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(appCache.body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/app")) {
    return serveApp(res);
  }

  try {
    if (req.method === "GET" && url.pathname === "/executor.js") {
      cors(res);
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(EXECUTOR);
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, network: NETWORK, accounts: listAccounts().length, active: activeAccount });
    }
    if (req.method === "GET" && url.pathname === "/accounts") {
      return json(res, 200, { accounts: listAccounts() });
    }
    if (req.method === "GET" && url.pathname === "/active") {
      const acct = listAccounts().find((a) => a.accountId === activeAccount);
      return json(res, 200, acct ? { accountId: acct.accountId, publicKey: acct.public_key } : {});
    }
    if (req.method === "POST" && url.pathname === "/activate") {
      const b = await readBody(req);
      const acct = listAccounts().find((a) => a.accountId === b.accountId);
      if (!acct) throw new Error("unknown account");
      activeAccount = acct.accountId;
      log(`ACTIVATE ${activeAccount}`);
      return json(res, 200, { ok: true, accountId: activeAccount });
    }
    if (req.method === "POST" && url.pathname === "/deactivate") {
      log(`DEACTIVATE ${activeAccount}`);
      activeAccount = null;
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/sign") {
      const b = await readBody(req);
      const result = await signAndSend(b);
      return json(res, 200, result);
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    log(`ERR ${url.pathname} :: ${String(e.message || e).slice(0, 200)}`);
    return json(res, 400, { error: String(e.message || e).slice(0, 300) });
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) reject(new Error("body too large")); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}

const PREFERRED = process.env.TRADER;
activeAccount = null;
{
  const accs = listAccounts();
  const pick = accs.find((a) => a.accountId === PREFERRED) || accs[0];
  activeAccount = pick ? pick.accountId : null;
}

// HTTPS loopback on :8392 — production (https) pages can't embed http iframes
// (mixed content), so the sandbox wallet must also be reachable over TLS.
try {
  const tlsCerts = {
    key: fs.readFileSync("/Users/asil/.config/local-daemon-tls/daemon-key.pem"),
    cert: fs.readFileSync("/Users/asil/.config/local-daemon-tls/daemon.pem"),
  };
  const httpsServer = https.createServer(tlsCerts, (req, res) => server.emit("request", req, res));
  httpsServer.listen(8392, "127.0.0.1", () => {
    log("https loopback listening on https://127.0.0.1:8392");
    console.log("https://127.0.0.1:8392 (loopback TLS for https dApps)");
  });
} catch (e) {
  console.warn("no https loopback:", e.message);
}

server.listen(PORT, "127.0.0.1", () => {
  log(`daemon up on http://127.0.0.1:${PORT} (network=${NETWORK}, active=${activeAccount || "none"}, accounts=${listAccounts().map((a) => a.accountId).join(",") || "none"})`);
});
