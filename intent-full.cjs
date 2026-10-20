// Relink kampy (persisted this time) → intent → capture FULL worker response
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

(async () => {
  const ACCT = "kampy.testnet";
  const kp = na.KeyPair.fromRandom("ed25519");
  const pk = kp.getPublicKey().toString();
  fs.writeFileSync("/tmp/ik-kampy.json", JSON.stringify({ account: ACCT, secret: kp.toString(), pk }, null, 2));
  const pkhex = Buffer.from(kp.getPublicKey().data).toString("hex");
  const rl = await post("/sign", { signerId: ACCT, receiverId: "xcross-v3.anon372340656.testnet",
    actions: [{ type: "FunctionCall", params: { methodName: "add_credit", args: { pubkey: pk, pkhex },
      gas: "120000000000000", deposit: "1" } }] });
  console.log("relink:", rl.transaction ? rl.transaction.hash : JSON.stringify(rl).slice(0, 200));
  await new Promise((s) => setTimeout(s, 3000));

  const text = "full intent probe " + Date.now();
  const room = "crosspost";
  const its = String(Math.floor(Date.now() / 1000));
  const canonical = JSON.stringify({ author: ACCT, text, room, its });
  const digest = crypto.createHash("sha256").update(Buffer.from(canonical, "utf8")).digest();
  const sigHex = Buffer.from(kp.sign(digest).signature).toString("hex");
  const t0 = Date.now();
  const r = await fetch(BAPI + "/intent", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ author: ACCT, text, room, its, sig: sigHex, enc: "hex" }) }).then((x) => x.text());
  console.log("took", ((Date.now() - t0) / 1000).toFixed(1) + "s");
  console.log("FULL RESPONSE:");
  try { console.log(JSON.stringify(JSON.parse(r), null, 1).slice(0, 3000)); } catch { console.log(r.slice(0, 3000)); }
})();
