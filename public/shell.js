// shell — per-user wallet (generated once, persisted in localStorage),
// single onboarding flow that funds + verifies before mounting the card.

import { createClient, http, publicActions, walletActions, parseEventLogs } from "https://esm.sh/viem@2.48.4";
import { privateKeyToAccount, generatePrivateKey } from "https://esm.sh/viem@2.48.4/accounts";
import { nonceManager } from "https://esm.sh/viem@2.48.4/nonce";
import { tempoModerato } from "https://esm.sh/viem@2.48.4/chains";
import { tempoActions } from "https://esm.sh/viem@2.48.4/tempo";

export const TOKEN = "0x20c0000000000000000000000000000000000001"; // AlphaUSD, 6 dec
const KEY_STORAGE = "pachi:burnerKey:v1";

let priv = localStorage.getItem(KEY_STORAGE);
if (!priv) {
  priv = generatePrivateKey();
  localStorage.setItem(KEY_STORAGE, priv);
}
// nonceManager: shared across page lifetime, fetches from chain on first use,
// then increments locally for back-to-back writes. Without this, a fresh load
// races stale state and the first tx gets "nonce too low".
const account = privateKeyToAccount(priv, { nonceManager });

const client = createClient({
  account,
  chain: tempoModerato.extend({ feeToken: TOKEN }),
  transport: http(),
})
  .extend(publicActions)
  .extend(walletActions)
  .extend(tempoActions());

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
];

const stage = document.getElementById("stage");
const balEl = document.getElementById("bal");

const fmtUSD = (raw) =>
  `$${(Number(raw) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function getBalance() {
  return client.readContract({
    address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
  });
}

function setBal(text, opts = {}) {
  balEl.textContent = text;
  balEl.style.cursor = opts.clickable ? "pointer" : "";
}

function toast(msg, ms = 2400) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 200);
  }, ms);
}

// Single-flight onboarding. If already funded (returning visitor), no API
// call. Otherwise: POST /api/faucet (which now waits for the funding tx to
// confirm before responding), then poll the chain until the balance shows up.
let onboarding = null;
async function onboard() {
  if (onboarding) return onboarding;
  onboarding = (async () => {
    try {
      // Already funded? (cached wallet, returning visitor, or refresh after fund)
      let bal = await getBalance();
      if (bal > 0n) {
        setBal(fmtUSD(bal));
        return true;
      }

      setBal("loading…");

      const r = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: account.address }),
      });

      // 200 (synchronously confirmed), 202 (pending — keep polling), or error.
      if (!r.ok && r.status !== 202) {
        const txt = await r.text().catch(() => "");
        throw new Error(`faucet ${r.status}${txt ? ": " + txt.slice(0, 100) : ""}`);
      }

      // Server already waited for the receipt on 200, but the RPC view can lag
      // a beat. On 202, the tx is pending. Poll until the balance is visible.
      for (let i = 0; i < 24; i++) {
        bal = await getBalance();
        if (bal > 0n) {
          setBal(fmtUSD(bal));
          return true;
        }
        await sleep(500);
      }
      throw new Error("funding didn't land in time");
    } catch (err) {
      console.error("onboard failed:", err);
      setBal("tap to retry", { clickable: true });
      toast(err.shortMessage || err.message || "onboarding failed");
      return false;
    } finally {
      onboarding = null;
    }
  })();
  return onboarding;
}

balEl.addEventListener("click", () => {
  if (balEl.textContent === "tap to retry") onboard();
});

const ctx = {
  client, account, parseEventLogs, toast,
  refreshBalance: async () => {
    try { setBal(fmtUSD(await getBalance())); } catch {}
  },
};

(async () => {
  const ok = await onboard();
  if (!ok) return;  // user can tap balance to retry

  const slot = document.createElement("div");
  slot.style.cssText = "position:absolute;inset:0;";
  stage.appendChild(slot);
  const mod = await import("./cards/pachi.js");
  mod.mount(slot, ctx);

  setInterval(() => ctx.refreshBalance(), 4000);
})();
