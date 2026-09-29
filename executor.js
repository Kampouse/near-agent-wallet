// kampy local-keys wallet executor — runs inside near-connect's sandboxed iframe.
// Signs NOTHING here: delegates to the local daemon (http://127.0.0.1:8391).
// RPC + broadcast also happen daemon-side; this file is a thin bridge.
const DAEMON = "http://127.0.0.1:8391";
const NETWORK = "testnet";

async function api(path, opts) {
  const res = await fetch(DAEMON + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `daemon ${res.status}`);
  return data;
}

function assertTestnet(params) {
  const net = params && params.network;
  if (net && net !== NETWORK) throw new Error(`only ${NETWORK} supported`);
}

const wallet = {
  manifest: null, // injected by window.selector.ready()

  async signIn(params) {
    assertTestnet(params);
    const active = await api("/active");
    if (!active.accountId) {
      throw new Error("no trader account active in daemon — start daemon with TRADER=<account>");
    }
    await window.selector.storage.set(`kampy:account:${NETWORK}`, active.accountId);
    return [{ accountId: active.accountId, publicKey: active.publicKey }];
  },

  async signInAndSignMessage(params) {
    const accounts = await this.signIn(params);
    // message signing is out of scope for the trading daemon
    throw new Error("signInAndSignMessage not supported by kampy local keys");
  },

  async signOut(params) {
    assertTestnet(params);
    await window.selector.storage.remove(`kampy:account:${NETWORK}`);
    await api("/deactivate", { method: "POST", body: "{}" }).catch(() => {});
  },

  async getAccounts(params) {
    assertTestnet(params);
    const acct = await window.selector.storage.get(`kampy:account:${NETWORK}`);
    if (acct) return [{ accountId: acct }];
    const active = await api("/active");
    return active.accountId ? [{ accountId: active.accountId }] : [];
  },

  async signAndSendTransaction(params) {
    assertTestnet(params);
    const acct = await window.selector.storage.get(`kampy:account:${NETWORK}`);
    const signerId = (params.signerId || (acct ? acct : (await this.getAccounts())[0]?.accountId));
    if (!signerId) throw new Error("not signed in");
    const result = await api("/sign", {
      method: "POST",
      body: JSON.stringify({
        signerId,
        receiverId: params.receiverId,
        actions: params.actions,
      }),
    });
    return result;
  },

  async signAndSendTransactions(params) {
    assertTestnet(params);
    const out = [];
    for (const tx of params.transactions || []) {
      out.push(await this.signAndSendTransaction({ ...tx, network: params.network }));
    }
    return out;
  },

  async signMessage() {
    throw new Error("signMessage not supported by kampy local keys");
  },

  async signDelegateActions() {
    throw new Error("signDelegateActions not supported by kampy local keys");
  },
};

window.selector.ready(wallet);
