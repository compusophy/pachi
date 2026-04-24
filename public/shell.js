// shell — per-user wallet (generated once, persisted in localStorage),
// single onboarding flow that funds + verifies before mounting the card.

import { createClient, http, publicActions, walletActions, parseEventLogs } from "https://esm.sh/viem@2.48.4";
import { privateKeyToAccount, generatePrivateKey } from "https://esm.sh/viem@2.48.4/accounts";
import { nonceManager } from "https://esm.sh/viem@2.48.4/nonce";
import { tempoModerato } from "https://esm.sh/viem@2.48.4/chains";
import { tempoActions } from "https://esm.sh/viem@2.48.4/tempo";

// AlphaUSD pays gas (Tempo's fee-token system requires a system stable;
// PachiUSD is NOT a valid fee token). Topped up free from the faucet.
export const ALPHA_USD = "0x20c0000000000000000000000000000000000001";
// PachiUSD is the GAME stake — what's approved + transferred for play().
// Minted to registered users via OnboardingFacet.
export const PACHI_USD = "0x576da0a989d574a3f9568007daceea919db6c53b";
// Pachi diamond — stable address across all future facet upgrades.
export const PACHI_DIAMOND = "0x71e767bf661d6294c88953d640f0fc792a4c5086";
// MUST match diamond's appVersion. Bump after any breaking facet upgrade.
// See memory: project_pachi_versioning. Order: contract first, client second.
export const APP_VERSION = 2;
const KEY_STORAGE = "pachi:burnerKey:v1";

// `TOKEN` left exported for back-compat with cards/pachi.js — points at the
// game stake token (PachiUSD), which is what the card approves + spends.
// Gas is paid in AlphaUSD, set on the chain config below.
export const TOKEN = PACHI_USD;

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
  // Gas is paid in AlphaUSD (a system fee token). PachiUSD is the game
  // stake, NOT a valid fee token — using it here gets "invalid fee token"
  // reverts on every tx.
  chain: tempoModerato.extend({ feeToken: ALPHA_USD }),
  transport: http(),
})
  .extend(publicActions)
  .extend(walletActions)
  .extend(tempoActions());

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
];

const APPVERSION_ABI = [
  { type: "function", name: "appVersion", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
];

const ONBOARDING_ABI = [
  { type: "function", name: "register", stateMutability: "nonpayable",
    inputs: [{ name: "inviter", type: "address" }], outputs: [] },
  { type: "function", name: "claimDailyAllowance", stateMutability: "nonpayable",
    inputs: [], outputs: [] },
  { type: "function", name: "isRegistered", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "nextAllowanceAt", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

const stage      = document.getElementById("stage");
const balEl      = document.getElementById("bal");
const versionEl  = document.getElementById("version");
const staleEl    = document.getElementById("staleModal");
const staleClient = document.getElementById("staleClient");
const staleLatest = document.getElementById("staleLatest");
const staleRefresh = document.getElementById("staleRefresh");

if (versionEl) versionEl.textContent = `v${APP_VERSION}`;
if (staleClient) staleClient.textContent = String(APP_VERSION);

const fmtUSD = (raw) =>
  `$${(Number(raw) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Game balance = PachiUSD (what you play with). AlphaUSD is only for gas
// and is checked separately during onboarding.
async function getBalance() {
  return client.readContract({
    address: PACHI_USD, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
  });
}

async function getAlphaBalance() {
  return client.readContract({
    address: ALPHA_USD, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
  });
}

async function isRegistered() {
  return client.readContract({
    address: PACHI_DIAMOND, abi: ONBOARDING_ABI, functionName: "isRegistered",
    args: [account.address],
  });
}

// Optional inviter from query string: ?inviter=0xABCD...
function parseInviterFromURL() {
  try {
    const u = new URLSearchParams(location.search);
    const inv = u.get("inviter");
    if (inv && /^0x[0-9a-fA-F]{40}$/.test(inv)) return inv;
  } catch {}
  return "0x0000000000000000000000000000000000000000";
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

// Three-step onboarding (single-flight, idempotent):
//   1. Faucet AlphaUSD via /api/faucet (so the wallet can pay gas).
//   2. Register on the diamond via OnboardingFacet.register(inviter).
//      Mints $1000 PachiUSD starter to the wallet.
//   3. Display PachiUSD balance.
// All steps short-circuit if already done (returning visitor, refresh, etc.)
let onboarding = null;
async function onboard() {
  if (onboarding) return onboarding;
  onboarding = (async () => {
    try {
      // Step 1 — AlphaUSD for gas
      let alpha = await getAlphaBalance();
      if (alpha === 0n) {
        setBal("loading…");
        const r = await fetch("/api/faucet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: account.address }),
        });
        if (!r.ok && r.status !== 202) {
          const txt = await r.text().catch(() => "");
          throw new Error(`faucet ${r.status}${txt ? ": " + txt.slice(0, 100) : ""}`);
        }
        // Poll until the funding tx confirms RPC-side
        for (let i = 0; i < 24; i++) {
          alpha = await getAlphaBalance();
          if (alpha > 0n) break;
          await sleep(500);
        }
        if (alpha === 0n) throw new Error("gas funding didn't land");
      }

      // Step 2 — Register on the diamond if not already
      const registered = await isRegistered().catch(() => false);
      if (!registered) {
        setBal("registering…");
        const inviter = parseInviterFromURL();
        try {
          const hash = await client.writeContract({
            address: PACHI_DIAMOND, abi: ONBOARDING_ABI,
            functionName: "register", args: [inviter],
          });
          await client.waitForTransactionReceipt({ hash });
        } catch (err) {
          // If the on-chain call says "already registered" we're fine — proceed.
          const msg = (err.shortMessage || err.message || "").toLowerCase();
          if (!msg.includes("already")) throw err;
        }
      }

      // Step 3 — Show PachiUSD balance
      let bal = await getBalance();
      // Tiny grace window in case the register tx just landed
      for (let i = 0; bal === 0n && i < 6; i++) {
        await sleep(400);
        bal = await getBalance();
      }
      setBal(fmtUSD(bal));
      return true;
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

// Per-action contract version pre-flight.
//   - mismatch is STICKY (modal stays up; never overwritten)
//   - match is cached for VERSION_RECHECK_MS so rapid plays don't hammer RPC
//   - RPC failures fail OPEN if we previously matched (so a transient hiccup
//     doesn't block legitimate play), fail OPEN on first call too
//
// Without the cache window, a tab held open across an upgrade would never
// notice the new appVersion — the previous bug was caching match forever.
const VERSION_RECHECK_MS = 60_000;
let versionDecision = null;        // null | true | false
let lastVersionCheck = 0;
async function checkVersion() {
  if (versionDecision === false) return false;                      // sticky mismatch
  if (versionDecision === true && Date.now() - lastVersionCheck < VERSION_RECHECK_MS) {
    return true;                                                    // recent match — skip RPC
  }
  try {
    const onchain = await client.readContract({
      address: PACHI_DIAMOND, abi: APPVERSION_ABI, functionName: "appVersion",
    });
    const onchainN = Number(onchain);
    versionDecision = onchainN === APP_VERSION;
    lastVersionCheck = Date.now();
    if (!versionDecision) {
      if (staleLatest) staleLatest.textContent = String(onchainN);
      if (staleEl) staleEl.classList.add("show");
    }
  } catch (err) {
    console.warn("version check failed (failing open):", err);
    if (versionDecision === null) versionDecision = true;
  }
  return versionDecision;
}

if (staleRefresh) staleRefresh.addEventListener("click", () => location.reload());

const ctx = {
  client, account, parseEventLogs, toast, checkVersion,
  refreshBalance: async () => {
    try { setBal(fmtUSD(await getBalance())); } catch {}
  },
};

// === Logo dropdown + modal wiring ===
const logoEl     = document.getElementById("logo");
const menuEl     = document.getElementById("logoMenu");
const modalEl    = document.getElementById("modal");
const modalBody  = document.getElementById("modalBody");
const modalTitle = document.getElementById("modalTitle");
const modalClose = document.getElementById("modalClose");

function setMenu(open) {
  menuEl.classList.toggle("show", open);
  logoEl.setAttribute("aria-expanded", open ? "true" : "false");
}
logoEl.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenu(!menuEl.classList.contains("show"));
});
document.addEventListener("click", () => setMenu(false));

function openModal(title) {
  modalTitle.textContent = title;
  modalBody.innerHTML = "";
  modalEl.classList.add("show");
  modalEl.setAttribute("aria-hidden", "false");
}
function closeModal() {
  modalEl.classList.remove("show");
  modalEl.setAttribute("aria-hidden", "true");
}
modalClose.addEventListener("click", closeModal);
modalEl.addEventListener("click", (e) => { if (e.target === modalEl) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

async function claimDaily() {
  if (!(await checkVersion())) return;
  try {
    toast("claiming daily…");
    const hash = await client.writeContract({
      address: PACHI_DIAMOND, abi: ONBOARDING_ABI, functionName: "claimDailyAllowance",
    });
    await client.waitForTransactionReceipt({ hash });
    setBal(fmtUSD(await getBalance()));
    toast("+$1,000 PACHI claimed");
  } catch (err) {
    const msg = err.shortMessage || err.message || "claim failed";
    if (msg.toLowerCase().includes("cooldown") || msg.toLowerCase().includes("allowancecooldown")) {
      toast("daily already claimed — try again tomorrow");
    } else if (msg.toLowerCase().includes("notregistered")) {
      toast("register first (will happen automatically next reload)");
    } else {
      toast(msg);
    }
  }
}

menuEl.addEventListener("click", async (e) => {
  const action = e.target.dataset?.action;
  if (!action) return;
  setMenu(false);
  if (action === "analytics") {
    openModal("analytics");
    const mod = await import("./analytics.js");
    mod.render(modalBody, ctx);
  } else if (action === "claim") {
    claimDaily();
  }
});

(async () => {
  const ok = await onboard();
  if (!ok) return;  // user can tap balance to retry

  const slot = document.createElement("div");
  slot.style.cssText = "position:absolute;inset:0;";
  stage.appendChild(slot);
  const mod = await import("./cards/pachi.js");
  mod.mount(slot, ctx);

  // No background polling — balance refresh is event-driven (after tx
  // confirms). Polling spoiled the round outcome by updating the HUD
  // before the balls visually landed. The card calls ctx.refreshBalance()
  // in finishRound(); claim-daily calls it after its tx; onboarding
  // calls it once at startup. That's enough.
})();
