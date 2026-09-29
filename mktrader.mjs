// One-shot: create <TRADER> as a sub-account of an existing local account
// (funded with FUND NEAR), saving the key to ~/.near-credentials/testnet/.
// Usage: TRADER=mytrader PARENT=myaccount.testnet node mktrader.mjs
// Defaults: TRADER=agent-wallet, PARENT = first account found in CREDS.
import { sha256 } from "@noble/hashes/sha256";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as nearAPI from "near-api-js";

const CREDS = path.join(os.homedir(), ".near-credentials", "testnet");
const RPC = "https://rpc.testnet.fastnear.com";

const locals = fs.existsSync(CREDS)
  ? fs.readdirSync(CREDS).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
  : [];
const PARENT = process.env.PARENT || locals.find((a) => !a.startsWith("agent-wallet.")) || locals[0];
const TRADER = process.env.TRADER
  || (PARENT && PARENT.includes(".") ? `agent-wallet.${PARENT}` : "agent-wallet.testnet");
if (!PARENT) { console.error("no local accounts — fund an account first (see setup)"); process.exit(1); }
const FUND = BigInt(process.env.FUND_NEAR || "1") * 10n ** 24n;

const { KeyPair, transactions, providers, utils } = nearAPI;
const provider = new providers.JsonRpcProvider({ url: RPC });

const parentCreds = JSON.parse(fs.readFileSync(path.join(CREDS, `${PARENT}.json`), "utf8"));
const parentKp = KeyPair.fromString(parentCreds.private_key);

const bal = await provider.query({ request_type: "view_account", account_id: PARENT, finality: "final" });
console.log(`parent ${PARENT} balance:`, Number(bal.amount) / 1e24, "NEAR");
if (BigInt(bal.amount) < FUND + 10n ** 24n) { console.error("parent too poor"); process.exit(1); }

const traderKp = KeyPair.fromRandom("ed25519");
const pkB58 = traderKp.getPublicKey().toString(); // ed25519:...

const accessKey = await provider.query({ request_type: "view_access_key", account_id: PARENT, public_key: parentKp.getPublicKey().toString(), finality: "final" });
const block = await provider.block({ finality: "final" });

const tx = new transactions.Transaction({
  signerId: PARENT,
  publicKey: parentKp.getPublicKey(),
  nonce: BigInt(accessKey.nonce) + 1n,
  blockHash: utils.serialize.base_decode(block.header.hash),
  receiverId: TRADER,
  actions: [
    transactions.createAccount(),
    transactions.addKey(traderKp.getPublicKey(), transactions.fullAccessKey()),
    transactions.transfer(FUND),
  ],
});
const digest = new Uint8Array(sha256(tx.encode()));
const sig = parentKp.sign(digest);
const signedTx = new transactions.SignedTransaction({
  transaction: tx,
  signature: new transactions.Signature({ keyType: tx.publicKey.keyType, data: sig.signature }),
});
const outcome = await provider.sendTransaction(signedTx);
if (typeof outcome.status === "object" && "Failure" in outcome.status) {
  console.error("CREATE FAILED:", JSON.stringify(outcome.status.Failure).slice(0, 400));
  process.exit(1);
}
console.log("created", TRADER, "tx:", outcome.transaction.hash);

fs.mkdirSync(CREDS, { recursive: true });
fs.writeFileSync(path.join(CREDS, `${TRADER}.json`), JSON.stringify({
  account_id: TRADER,
  public_key: pkB58,
  private_key: traderKp.toString(),
}, null, 2));
console.log("key saved:", path.join(CREDS, `${TRADER}.json`));
