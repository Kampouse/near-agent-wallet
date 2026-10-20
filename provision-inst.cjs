// Provision instant lane for xpost-relayer-igyz3fq3.testnet:
// keygen → daemon-signed add_credit(0.1N) → confirm_topup → check /credit
const http = require("http");
const na = require("near-api-js");
const fs = require("fs");

function post(path, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: 8391, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (x) => { let b = ""; x.on("data", (c) => b += c); x.on("end", () => res(JSON.parse(b))); });
    r.on("error", rej); r.write(data); r.end();
  });
}

(async () => {
  const ACCT = "xpost-relayer-igyz3fq3.testnet";
  const CONTRACT = "xcross-v3.anon372340656.testnet";
  const kp = na.KeyPair.fromRandom("ed25519");
  const pk = kp.getPublicKey().toString();
  const pkhex = Buffer.from(kp.getPublicKey().data).toString("hex");
  fs.writeFileSync("/tmp/ik-provision.json", JSON.stringify({ account: ACCT, secret: kp.toString(), pk }, null, 2));

  console.log("signing add_credit with 0.1N…");
  const r = await post("/sign", {
    signerId: ACCT, receiverId: CONTRACT,
    actions: [{ type: "FunctionCall", params: {
      methodName: "add_credit",
      args: { pubkey: pk, pkhex },
      gas: "120000000000000", deposit: "100000000000000000000000" } }],
  });
  if (!r.transaction) { console.log("ADD_CREDIT FAILED:", JSON.stringify(r).slice(0, 400)); process.exit(1); }
  console.log("add_credit tx:", r.transaction.hash, JSON.stringify(r.status).slice(0, 80));

  // confirm with the worker
  let conf = null;
  for (let i = 0; i < 8 && !conf; i++) {
    await new Promise((s) => setTimeout(s, 2000));
    const res = await fetch("https://crosspost-relay-bridge.kj95hgdgnn.workers.dev/confirm_topup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash: r.transaction.hash, author: ACCT }),
    }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
    console.log("confirm attempt", i + 1, ":", JSON.stringify(res).slice(0, 200));
    if (res && res.credited) conf = res;
  }
  const credit = await fetch("https://crosspost-relay-bridge.kj95hgdgnn.workers.dev/credit?account=" + ACCT).then((x) => x.json());
  console.log("CREDIT NOW:", JSON.stringify(credit));
})();
