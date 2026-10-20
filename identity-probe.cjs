// Identity probe: instant post as kampy.testnet via relayer — whose npub comes out?
const http = require("http");
const na = require("near-api-js");
const crypto = require("crypto");
const fs = require("fs");

function post(path, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: 8391, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (x) => { let b = ""; x.on("data", (c) => b += c); x.on("end", () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
    r.on("error", rej); r.write(data); r.end();
  });
}
const BAPI = "https://crosspost-relay-bridge.kj95hgdgnn.workers.dev";
const view = async (method, args) => {
  const res = await fetch("https://rpc.testnet.fastnear.com", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "query", params: { request_type: "call_function", finality: "final", account_id: "xcross-v3.anon372340656.testnet", method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }) });
  const j = await res.json();
  return new TextDecoder().decode(new Uint8Array(j.result.result));
};

(async () => {
  const ACCT = "kampy.testnet";
  // 1) fresh intent key, re-link on-chain (1 yocto — credit exists)
  const kp = na.KeyPair.fromRandom("ed25519");
  const pk = kp.getPublicKey().toString();
  const pkhex = Buffer.from(kp.getPublicKey().data).toString("hex");
  const r = await post("/sign", { signerId: ACCT, receiverId: "xcross-v3.anon372340656.testnet",
    actions: [{ type: "FunctionCall", params: { methodName: "add_credit", args: { pubkey: pk, pkhex },
      gas: "120000000000000", deposit: "1" } }] });
  console.log("re-link:", r.transaction ? r.transaction.hash : JSON.stringify(r).slice(0, 300));
  await new Promise((s) => setTimeout(s, 3000));
  const credit = await fetch(BAPI + "/credit?account=" + ACCT).then((x) => x.json());
  console.log("intent_pk now:", credit.intent_pk, "| matches:", credit.intent_pk === pk);

  // 2) sign intent as kampy (browser-identical: sha256(canonical) then sig)
  const text = "identity probe " + Date.now();
  const room = "crosspost";
  const its = String(Math.floor(Date.now() / 1000));
  const canonical = JSON.stringify({ author: ACCT, text, room, its });
  const digest = crypto.createHash("sha256").update(Buffer.from(canonical, "utf8")).digest();
  const sigHex = Buffer.from(kp.sign(digest).signature).toString("hex");
  const ir = await fetch(BAPI + "/intent", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ author: ACCT, text, room, its, sig: sigHex, enc: "hex" }) }).then((x) => x.json());
  console.log("intent:", JSON.stringify(ir).slice(0, 260));

  // 3) wait for TEE, read `last` for the event id
  let last = "";
  for (let i = 0; i < 25 && !last.includes("|OK|"); i++) {
    await new Promise((s) => setTimeout(s, 2000));
    try { last = await view("last", {}); } catch {}
    if (last.split("|")[2] && last !== "") break;
  }
  console.log("last:", last);
  const evId = last.split("|")[2];
  if (!evId || evId.length !== 64) { console.log("no event id yet"); return; }

  // 4) fetch the event → whose pubkey?
  await new Promise((s) => setTimeout(s, 4000));
  const WebSocket = require("ws");
  const ws = new WebSocket("wss://nos.lol");
  ws.on("open", () => ws.send(JSON.stringify(["REQ", "v", { ids: [evId] }])));
  ws.on("message", (d) => {
    const m = JSON.parse(d);
    if (m[0] === "EVENT") {
      console.log("EVENT pk:", m[2].pubkey);
      console.log(m[2].pubkey.startsWith("d65c4699") ? "✅ kampy identity (d65c4699…)" : "❌ WRONG IDENTITY (relayer-derived)");
      ws.close(); process.exit(0);
    }
  });
  setTimeout(() => { console.log("event not on relay yet (id:", evId + ")"); process.exit(0); }, 9000);
})();
