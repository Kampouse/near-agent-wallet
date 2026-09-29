# near-agent-wallet

Local-keys NEAR wallet for **browser dApps driven by AI agents**. It appears in
[@hot-labs/near-connect](https://github.com/hot-dao/near-selector)'s wallet modal
as "Local Keys (agent)" and signs transactions with keys on **your machine** —
no extension, no redirect, no human confirmation popup. The daemon's policy is
the only gate, which is exactly what you want when an agent is doing the driving.

```
browser dApp ── near-connect ── sandboxed executor ──(127.0.0.1:8391)── signer daemon ── NEAR RPC
      ▲                                                                            (keys never leave)
      └──────────── tx hash + real fill comes back into the UI ────────────────────┘
```

## Quick start

```bash
git clone <this-repo> && cd near-agent-wallet
npm install
npm run setup          # finds (or tells you how to create) a testnet account
TRADER=<account>.testnet npm start   # binds 127.0.0.1:8391, NEVER exposes keys
```

Then in your dApp (any app using `@hot-labs/near-connect`):

```ts
import { NearConnector } from "@hot-labs/near-connect";

const connector = new NearConnector({ network: "testnet", features: { testnet: true } });
await connector.registerWallet({
  id: "local-keys",
  name: "Local Keys (agent)",
  description: "Signs with keys on this machine via the local agent wallet daemon",
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
});
```

Now "Local Keys (agent)" shows up in the connect modal next to Meteor/Ledger.
Your agent clicks it (or you do), and `connect()` resolves signed-in — the daemon
answers `signIn()` with the `TRADER` account automatically.

## Using it as an agent

The whole flow is DOM + HTTP, no confirmation step anywhere:

1. open the dApp, click its connect button, click the "Local Keys (agent)" row
   (DOM-selectable: `.hot-connector-popup` → row whose text matches the name).
2. drive the dApp UI normally. Each trade/call ends with the REAL outcome in the
   page: tx hash + parsed fill from the contract's `pool_trade` event.
3. verify independently over RPC if you want on-chain proof:

```bash
curl -s -X POST https://rpc.testnet.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"x","method":"EXPERIMENTAL_tx_status","params":["<HASH>","<SIGNER>"]}'
```

Every signature is logged to `sign.log` (timestamp, signer → receiver, method, tx hash).

## Policy (the safety model)

- daemon binds **127.0.0.1 only** — unreachable from outside the machine
- browser/iframe **never sees a private key**; it POSTs unsigned actions
- receivers must end with `ALLOW_RECEIVER_SUFFIX` (default `testnet`)
- per-tx deposit cap `MAX_DEPOSIT_NEAR` (default 5 Ⓝ)
- mainnet disabled unless `ALLOW_MAINNET=1`
- every signature logged

Tune at start: `MAX_DEPOSIT_NEAR=0.5 ALLOW_RECEIVER_SUFFIX=myapp.testnet npm start`

## Files

| file | what it is |
|---|---|
| `daemon.mjs` | loopback signer daemon (Node, near-api-js). Serves `/executor.js`, `/health`, `/active`, `/activate`, `/sign` |
| `executor.js` | runs inside near-connect's sandboxed iframe; delegates everything to the daemon |
| `setup.mjs` | `npm run setup` — locate/create a testnet account, print the wiring |
| `mktrader.mjs` | optional: create a fresh sub-account trader funded by an existing local key |

## Requirements / limits

- Node 18+, testnet account with a local key (`~/.near-credentials/testnet/<account>.json`)
- same machine as the browser (loopback transport)
- testnet-first; mainnet possible but deliberately switched off by default
- near-connect dApps only (wallet-selector apps would need a WalletConnect transport — not included)
