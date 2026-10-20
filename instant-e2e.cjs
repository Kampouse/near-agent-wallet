// Instant lane E2E: browser-equivalent intent signature → worker /publish
const na = require("near-api-js");
const crypto = require("crypto");
const fs = require("fs");

(async () => {
  const ACCT = "xpost-relayer-igyz3fq3.testnet";
  const BAPI = "https://crosspost-relay-bridge.kj95hgdgnn.workers.dev";
  const ik = JSON.parse(fs.readFileSync("/tmp/ik-provision.json", "utf8"));
  const kp = na.KeyPair.fromString(ik.secret);

  const text = "instant lane e2e " + Date.now();
  const room = "crosspost";
  const its = String(Math.floor(Date.now() / 1000));
  const canonical = JSON.stringify({ author: ACCT, text, room, its });
  // hash FIRST, sign the digest (raw-byte signing was the historical bad-sig bug)
  const digest = crypto.createHash("sha256").update(Buffer.from(canonical, "utf8")).digest();
  const sigHex = Buffer.from(kp.sign(digest).signature).toString("hex");

  const r = await fetch(BAPI + "/intent", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ author: ACCT, text, room, its, sig: sigHex, enc: "hex" }),
  }).then((x) => x.json());
  console.log("intent →", JSON.stringify(r).slice(0, 300));

  if (r.txHash) {
    await new Promise((s) => setTimeout(s, 6000));
    const pub = await fetch(BAPI + "/publish", { method: "POST" }).then((x) => x.text());
    console.log("publish →", pub.slice(0, 200));
    const credit = await fetch(BAPI + "/credit?account=" + ACCT).then((x) => x.json());
    console.log("posts_left:", credit.posts_left);
  }
})();
