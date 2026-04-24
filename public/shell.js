// shell — per-user wallet (generated once, persisted in localStorage),
// auto-funds via /api/faucet on first load, mounts the active card.

import { createClient, http, publicActions, walletActions, parseEventLogs } from "https://esm.sh/viem@2.48.4";
import { privateKeyToAccount, generatePrivateKey } from "https://esm.sh/viem@2.48.4/accounts";
import { tempoModerato } from "https://esm.sh/viem@2.48.4/chains";
import { tempoActions } from "https://esm.sh/viem@2.48.4/tempo";

export const TOKEN = "0x20c0000000000000000000000000000000000001"; // AlphaUSD, 6 dec
const KEY_STORAGE = "pachi:burnerKey:v1";

// Per-user burner key — generated once on first visit, persisted in localStorage.
let priv = localStorage.getItem(KEY_STORAGE);
if (!priv) {
  priv = generatePrivateKey();
  localStorage.setItem(KEY_STORAGE, priv);
}
const account = privateKeyToAccount(priv);

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

async function getBalance() {
  return client.readContract({
    address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
  });
}

async function refreshBalance() {
  try {
    balEl.textContent = fmtUSD(await getBalance());
  } catch {
    balEl.textContent = "rpc err";
  }
}

function toast(msg, ms = 2200) {
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

// First-load: if balance is 0, ask /api/faucet to fund this address.
async function ensureFunded() {
  const b = await getBalance();
  if (b > 0n) return;
  try {
    balEl.textContent = "funding…";
    const r = await fetch("/api/faucet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: account.address }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`faucet ${r.status}: ${txt.slice(0, 80)}`);
    }
    // Faucet RPC returns immediately but funding tx needs a block — poll briefly.
    for (let i = 0; i < 8; i++) {
      await new Promise((res) => setTimeout(res, 600));
      if ((await getBalance()) > 0n) break;
    }
  } catch (err) {
    toast(`faucet failed: ${err.message}`);
  }
}

const ctx = { client, account, parseEventLogs, refreshBalance, toast };

(async () => {
  await refreshBalance();
  await ensureFunded();
  await refreshBalance();

  const slot = document.createElement("div");
  slot.style.cssText = "position:absolute;inset:0;";
  stage.appendChild(slot);
  const mod = await import("./cards/pachi.js");
  mod.mount(slot, ctx);

  setInterval(refreshBalance, 4000);
})();
