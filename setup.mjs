// One-shot setup: make sure a usable account exists, then tell the user what to do.
// - If ~/.near-credentials/testnet/<ACCOUNT>.json exists: use it (no key changes).
// - Else: create <AGENT>-wallet.testnet as a sub-account of an existing funded local
//   account if one exists, else print the faucet link and exit.
// Never prints private key material.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const NETWORK = "testnet";
const CREDS_DIR = path.join(os.homedir(), ".near-credentials", NETWORK);
const WANT = (process.env.AGENT || "agent") + "-wallet.testnet";

const accounts = fs.existsSync(CREDS_DIR)
  ? fs.readdirSync(CREDS_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
  : [];

console.log(`near-agent-wallet setup (network: ${NETWORK})`);
console.log(`key dir: ${CREDS_DIR}`);

const MANIFEST = {
  id: "local-keys",
  name: "Local Keys (agent)",
  description: "Signs with keys on this machine via the local agent wallet daemon (loopback, no extension)",
  icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%230a0c10'/><text x='16' y='22' font-size='16' text-anchor='middle' fill='%233dd68c' font-family='monospace'>k</text></svg>",
  website: "http://localhost:5174",
  version: "1.0.0",
  type: "sandbox",
  platform: [],
  executor: "http://127.0.0.1:8391/executor.js",
  permissions: { storage: true, allowsOpen: ["http://127.0.0.1:8391"] },
  features: {
    signMessage: false,
    signTransaction: true,
    signAndSendTransaction: true,
    signAndSendTransactions: true,
    signInWithoutAddKey: true,
    signInAndSignMessage: false,
    signInWithFunctionCallKey: false,
    signDelegateActions: false,
    mainnet: false,
    testnet: true,
  },
};

if (accounts.length === 0) {
  console.log(`
No local keys found. Two options:

  1. If you use near CLI:      near create-account ${WANT} --useFaucet --networkId testnet
                               cp ~/.near-credentials/testnet/${WANT}.json ${CREDS_DIR}/ 2>/dev/null || true
  2. Fund an existing account: grab testnet NEAR from https://near-faucet.io and place
                               the key file at ${CREDS_DIR}/<account>.json

Then re-run: npm run setup`);
  process.exit(1);
}

console.log(`found accounts: ${accounts.join(", ")}`);
console.log(`
Next:

  1. start the daemon:   npm start
  2. pick a default:     TRADER=${accounts[0]} npm start   (or POST /activate later)
  3. in any @hot-labs/near-connect dApp, register the wallet:

       connector.registerWallet(MANIFEST);   // see below for the object

  4. connect in the browser as your agent (no human confirmation step exists —
     the daemon's policy is the only gate).`);

console.log("\nmanifest to register in your dApp:\n");
console.log(JSON.stringify(MANIFEST, null, 2));

