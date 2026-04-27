// shell — per-user wallet (generated once, persisted in localStorage),
// single onboarding flow that funds + verifies before mounting the card.

import { createClient, http, publicActions, walletActions, parseEventLogs } from "https://esm.sh/viem@2.48.4";
import { privateKeyToAccount, generatePrivateKey } from "https://esm.sh/viem@2.48.4/accounts";
import { tempoModerato } from "https://esm.sh/viem@2.48.4/chains";
import { tempoActions } from "https://esm.sh/viem@2.48.4/tempo";
import * as flux from "./flux.js";

// Farcaster Mini App SDK — needed ONLY to dismiss the launch splash via
// sdk.actions.ready(). We don't use FIDs, Warpcast wallet, or any other
// SDK feature (per project_pachi_farcaster_strategy memo). The dynamic
// import is wrapped in try/catch so a CDN failure outside Farcaster
// doesn't break the app for non-FC users.
let fcSdk = null;
import("https://esm.sh/@farcaster/miniapp-sdk@0.2.0").then((m) => {
  fcSdk = m.sdk;
}).catch((err) => {
  console.warn("Farcaster SDK load failed (non-fatal):", err);
});

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
// v3: GameFacet replaced with MAX_BALLS=1000 (was 100) to back the ×1000
//     pill. Bumped via MaxBallsUpgrade.s.sol on 2026-04-26.
export const APP_VERSION = 3;
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
// IMPORTANT: do NOT attach a viem nonceManager here. Tempo's chainConfig
// expects to manage nonces itself: when expiring-nonce mode engages it
// sets `nonce = 0` and `nonceKey = uint256.max`; sequential mode reads
// nonce per-tx from chain. viem's nonceManager interleaves a separate
// sequential counter that ends up serialized into the tx envelope as
// junk, producing "expiring nonce transaction must have nonce == 0"
// rejects from Tempo. See viem/_esm/tempo/chainConfig.js + Transaction.js.
const account = privateKeyToAccount(priv);

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
  // Custom errors — without these viem can only show the raw selector
  // ("...reverted with the following signature: 0x82b42900") which is
  // useless to the user. With them, err.shortMessage / err.metaMessages
  // include the error name + args so we can match on a clean string.
  { type: "error", name: "AlreadyRegistered",   inputs: [] },
  { type: "error", name: "NotRegistered",       inputs: [] },
  { type: "error", name: "CannotInviteSelf",    inputs: [] },
  { type: "error", name: "AllowanceCooldown",
    inputs: [{ name: "secondsRemaining", type: "uint256" }] },
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

// Balls are the currency unit, INTEGER ONLY. 1 ball = 1e6 raw (matches
// PachiUSD's 6 decimals and stake-per-ball). Display always floors to the
// nearest whole ball — fractional dust is invisible to the player and
// reconciles via refreshBalance(). The contract still uses fractional
// payouts internally, but the experience is integer-clean.
const fmtBallsNumber = (raw) => {
  const balls = raw / 1_000_000n;          // BigInt floor division
  return balls.toLocaleString();
};
// Header shows the bare number — the ball glyph lives at the pyramid apex
// (where balls visibly leave/return), not next to the digits. This keeps
// the header chrome quiet and makes the apex ball the focal point of the
// closed loop.
const fmtBallsHTML = (raw) => `<span class="bal-num">${fmtBallsNumber(raw)}</span>`;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Optimistic-balance state. The header reads from `displayedRaw`, which is
// updated optimistically on DROP (instant deduction) and animated upward
// on LAND (per-ball ticks as flux balls arrive). The chain truth is read
// via getBalance() and snapped into displayedRaw by refreshBalance() when
// a round resolves — so any drift between optimistic state and chain
// reality heals at every round boundary.
const PHI_S = 1.6180339887;
let displayedRaw = null;
function renderBalance() {
  if (displayedRaw == null) return;
  const raw = displayedRaw < 0n ? 0n : displayedRaw;
  setBal(fmtBallsHTML(raw));
  // Apex ball scales with balance. Bounded [21, 55] now (was up to 89) —
  // earlier max was crowding the wallet number above and dominating the
  // pyramid apex. Tighter cap reads as part of the pyramid lattice
  // rather than a third UI element.
  const apex = document.querySelector(".pachi-apex");
  if (apex) {
    const balls = Math.max(1, Number(raw) / 1e6);
    const px = Math.min(55, 21 + Math.log(balls) / Math.log(PHI_S) * 2.4);
    apex.style.width  = px + "px";
    apex.style.height = px + "px";
  }
}
function setDisplayedRaw(raw) {
  displayedRaw = raw;
  renderBalance();
}
function optimisticDeduct(raw) {
  if (displayedRaw == null) return;
  displayedRaw -= raw;
  renderBalance();
}
function optimisticAdd(raw) {
  if (displayedRaw == null) return;
  displayedRaw += raw;
  renderBalance();
}

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

// Invite codes: hand-distributed by operator. URL form is /invite/<code>.
// On first hit we capture the code, persist it (so a refresh mid-onboarding
// doesn't lose it), and rewrite the URL back to "/" so the share link doesn't
// stick around in the address bar. Redemption fires once after onboarding.
const INVITE_CODE_KEY = "pachi:inviteCode:v1";
const INVITE_REDEEMED_KEY = "pachi:inviteRedeemed:v1";

function captureInviteFromURL() {
  try {
    const m = location.pathname.match(/^\/invite\/([A-Za-z0-9_\-]{1,64})\/?$/);
    if (!m) return;
    const code = m[1];
    if (!localStorage.getItem(INVITE_REDEEMED_KEY)) {
      localStorage.setItem(INVITE_CODE_KEY, code);
    }
    history.replaceState(null, "", "/");
  } catch {}
}
captureInviteFromURL();

async function redeemPendingInvite() {
  const code = localStorage.getItem(INVITE_CODE_KEY);
  if (!code) return;
  if (localStorage.getItem(INVITE_REDEEMED_KEY)) {
    localStorage.removeItem(INVITE_CODE_KEY);
    return;
  }
  try {
    const r = await fetch("/api/redeem-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, address: account.address }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // 409 = already redeemed; treat as a soft success so we stop retrying.
      if (r.status === 409) {
        localStorage.setItem(INVITE_REDEEMED_KEY, "1");
        localStorage.removeItem(INVITE_CODE_KEY);
        return;
      }
      throw new Error(j.error || `redeem ${r.status}`);
    }
    localStorage.setItem(INVITE_REDEEMED_KEY, "1");
    localStorage.removeItem(INVITE_CODE_KEY);
    // Brief grace window so the transfer is reflected on next balance read.
    for (let i = 0; i < 8; i++) {
      await sleep(400);
      const bal = await getBalance().catch(() => null);
      if (bal != null) { setDisplayedRaw(bal); break; }
    }
    if (j.amount) toast(`+${Number(j.amount).toLocaleString()} ● invite`);
  } catch (err) {
    console.warn("invite redeem failed:", err);
    // Leave the code in storage so a manual reload can retry.
  }
}

function setBal(html, opts = {}) {
  balEl.innerHTML = html;
  balEl.style.cursor = opts.clickable ? "pointer" : "";
}

function toast(msg, ms = 2400, opts = {}) {
  const el = document.createElement("div");
  el.className = "toast";
  if (opts.severity === "error") el.classList.add("error");
  // Optional copyable payload — when present, the toast shows a "copy"
  // button that dumps the full error blob to the clipboard so the user
  // can paste back to triage. Used for tx reverts where the public toast
  // text is a one-liner but the underlying error has the actual reason
  // buried in shortMessage / metaMessages / cause.
  if (opts.copyText) {
    const txt = document.createElement("span");
    txt.textContent = msg;
    el.appendChild(txt);
    const btn = document.createElement("button");
    btn.className = "toast-copy";
    btn.type = "button";
    btn.textContent = "copy";
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(opts.copyText);
        btn.textContent = "copied";
        setTimeout(() => { btn.textContent = "copy"; }, 1400);
      } catch {
        btn.textContent = "failed";
      }
    });
    el.appendChild(btn);
  } else {
    el.textContent = msg;
  }
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  // Errors with copy buttons stay until tapped — so the user can copy
  // them. Auto-dismiss only when no copy button.
  if (!opts.copyText) {
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 200);
    }, ms);
  } else {
    // Click anywhere on the toast (other than copy btn) dismisses it.
    el.addEventListener("click", () => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 200);
    });
  }
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
      setDisplayedRaw(bal);
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
    try { setDisplayedRaw(await getBalance()); } catch {}
  },
  optimisticDeduct,
  optimisticAdd,
  flux,
  // Returns the apex ball's center in viewport coords. The apex ball is
  // the visual source/destination for ALL DROP+LAND flux animations.
  // Header just holds the digit count — the ball lives where balls
  // physically leave and return, at the pyramid apex.
  walletAnchor: () => {
    const apex = document.querySelector(".pachi-apex");
    return flux.anchorOf(apex) || flux.anchorOf(balEl);
  },
  // Brief springy scale pulse on the apex ball. Called by LAND each time
  // a ball arrives so the user sees the apex physically react.
  pulseWallet: () => {
    const apex = document.querySelector(".pachi-apex");
    if (!apex) return;
    apex.classList.add("pulse");
    if (apex._pulseT) clearTimeout(apex._pulseT);
    apex._pulseT = setTimeout(() => apex.classList.remove("pulse"), 180);
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
  setCogMenu(false);
});

// === Settings cog dropdown ===
// Top-right; dropdown shows the burner wallet address (truncated) with a
// copy button, plus dummy IMPORT / EXPORT buttons. Future: real import +
// multi-wallet management. For now the buttons just toast that the feature
// isn't ready — keeping the affordance visible signals "more is coming"
// without overpromising.
const cogEl     = document.getElementById("cog");
const cogMenuEl = document.getElementById("cogMenu");
const cogAddrEl = document.getElementById("cogAddrText");
const cogCopyEl = document.getElementById("cogCopy");

function setCogMenu(open) {
  cogMenuEl.classList.toggle("show", open);
  cogEl.setAttribute("aria-expanded", open ? "true" : "false");
}
function fmtAddrShort(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
cogAddrEl.textContent = fmtAddrShort(account.address);
cogAddrEl.title = account.address;

cogEl.addEventListener("click", (e) => {
  e.stopPropagation();
  setCogMenu(!cogMenuEl.classList.contains("show"));
  setMenu(false);
});

cogCopyEl.addEventListener("click", async (e) => {
  e.stopPropagation();
  try {
    await navigator.clipboard.writeText(account.address);
    cogCopyEl.classList.add("copied");
    setTimeout(() => cogCopyEl.classList.remove("copied"), 1200);
    toast("address copied");
  } catch {
    toast("copy failed");
  }
});

// Sound mute — persisted across sessions. window.PACHI_SOUND_MUTED is
// the live value the card reads in applySoundMute(); the toggle event
// notifies the card so it can update Tone.Destination.mute without a
// reload. localStorage stores the same flag so the preference sticks
// across page loads.
const SOUND_MUTE_KEY = "pachi:soundMute:v1";
window.PACHI_SOUND_MUTED = localStorage.getItem(SOUND_MUTE_KEY) === "1";
const cogSoundEl = document.getElementById("cogSound");
function renderSoundLabel() {
  if (cogSoundEl) cogSoundEl.textContent = window.PACHI_SOUND_MUTED ? "SOUND: OFF" : "SOUND: ON";
}
renderSoundLabel();

cogMenuEl.addEventListener("click", (e) => {
  const action = e.target.closest("[data-action]")?.dataset?.action;
  if (!action) return;
  if (action === "sound") {
    // Toggle in place — keep the menu open so the user sees the label
    // flip ON ↔ OFF, but eat the document-click that would close it.
    e.stopPropagation();
    window.PACHI_SOUND_MUTED = !window.PACHI_SOUND_MUTED;
    localStorage.setItem(SOUND_MUTE_KEY, window.PACHI_SOUND_MUTED ? "1" : "0");
    renderSoundLabel();
    window.dispatchEvent(new CustomEvent("pachi:soundtoggle", {
      detail: { muted: window.PACHI_SOUND_MUTED },
    }));
    return;
  }
  setCogMenu(false);
  // IMPORT / EXPORT are scaffolded but intentionally inert — see comment
  // above. Replace these toasts with real flows when multi-wallet ships.
  if (action === "import") toast("import not wired up yet");
  if (action === "export") toast("export not wired up yet");
});

document.addEventListener("click", () => { setMenu(false); setCogMenu(false); });

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

// Format a future timestamp as a friendly relative duration ("4h 21m").
function fmtRelTime(seconds) {
  if (seconds <= 0) return "now";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

async function claimDaily() {
  if (!(await checkVersion())) return;
  // Pre-flight the cooldown view BEFORE submitting a tx that will just
  // revert with AllowanceCooldown(secondsRemaining). Read-only,
  // free, surfaces a clean "try again in 4h 21m" instead of a raw
  // selector signature.
  try {
    const nextAt = await client.readContract({
      address: PACHI_DIAMOND, abi: ONBOARDING_ABI,
      functionName: "nextAllowanceAt", args: [account.address],
    });
    if (nextAt > 0n) {
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const remain = nextAt > nowSec ? Number(nextAt - nowSec) : 0;
      toast(`daily already claimed — try again in ${fmtRelTime(remain)}`);
      return;
    }
  } catch (err) {
    console.warn("nextAllowanceAt pre-check failed (continuing):", err);
  }

  try {
    toast("claiming daily…");
    const hash = await client.writeContract({
      address: PACHI_DIAMOND, abi: ONBOARDING_ABI, functionName: "claimDailyAllowance",
      gas: 300_000n,    // see pachi.js gas budget rationale — Tempo's
                        // estimator under-shoots on cold-storage hits.
    });
    await client.waitForTransactionReceipt({ hash });
    setDisplayedRaw(await getBalance());
    toast("+1,000 ● claimed");
  } catch (err) {
    // viem decodes the contract's custom errors (now that ONBOARDING_ABI
    // declares them) and puts the name + args in shortMessage. Build the
    // same diagnostic blob shape the play() error path uses so we can
    // match on it consistently.
    const blob = [
      err.shortMessage || "",
      err.message || "",
      err.details || "",
      (err.metaMessages || []).join(" "),
      err.cause?.shortMessage || "",
      err.cause?.message || "",
    ].join(" ");
    let userMsg;
    if (/AllowanceCooldown/i.test(blob)) {
      // Cooldown args may be parseable from cause.data, but the
      // pre-flight above already covers the common path. This catches
      // races (claim attempt mid-cooldown).
      userMsg = "daily already claimed — try again tomorrow";
    } else if (/NotRegistered/i.test(blob)) {
      userMsg = "register first (will happen automatically next reload)";
    } else if (/AlreadyRegistered/i.test(blob)) {
      userMsg = "already registered";
    } else if (/insufficient/i.test(blob)) {
      userMsg = "not enough gas (AlphaUSD) — refresh to top up";
    } else if (/revert/i.test(blob)) {
      userMsg = "claim failed — copy details to debug";
    } else {
      userMsg = (err.shortMessage || err.message || "claim failed").slice(0, 80);
    }
    toast(userMsg, 5200, { severity: "error", copyText:
      `=== claimDaily error ===\n${new Date().toISOString()}\nwallet: ${account.address}\n\n${blob}\n\n${err.stack || ""}`
    });
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
  } else if (action === "brandkit") {
    openModal("brand kit");
    const mod = await import("./brandkit.js");
    mod.render(modalBody, ctx);
  } else if (action === "claim") {
    claimDaily();
  }
});

// Dismiss the Farcaster Mini App splash. Must be called regardless of
// whether onboarding succeeds — otherwise FC clients trap users on the
// splash image forever (even if the visible app is in a "tap to retry"
// state). The dynamic import races a 3s timeout. Outside Farcaster the
// call is a no-op.
async function dismissSplashWhenReady() {
  for (let i = 0; i < 30 && !fcSdk; i++) await sleep(100);
  try { await fcSdk?.actions?.ready?.(); } catch (err) {
    console.warn("sdk.ready failed:", err);
  }
}

(async () => {
  // Mount the flux overlay early so animations have somewhere to land before
  // the card finishes booting (e.g. invite redemption could trigger one).
  flux.mount();

  const ok = await onboard();
  if (!ok) {
    // Even on failure, dismiss the FC splash so the user can see the
    // "tap to retry" state and recover.
    dismissSplashWhenReady();
    return;
  }

  // Fire-and-forget: don't block the card mount on the redeem RPC. Balance
  // updates itself once the transfer lands, so the user sees the bonus add.
  redeemPendingInvite();

  const slot = document.createElement("div");
  slot.style.cssText = "position:absolute;inset:0;";
  stage.appendChild(slot);
  const mod = await import("./cards/pachi.js");
  mod.mount(slot, ctx);

  // The apex ball didn't exist when onboard called renderBalance, so it
  // never got sized. Re-render now that the card's DOM is in place — this
  // applies the log-scaled apex diameter for the current balance.
  renderBalance();

  // Dismiss the FC splash now that the card is interactive.
  dismissSplashWhenReady();

  // No background polling — balance refresh is event-driven (after tx
  // confirms). Polling spoiled the round outcome by updating the HUD
  // before the balls visually landed. The card calls ctx.refreshBalance()
  // in finishRound(); claim-daily calls it after its tx; onboarding
  // calls it once at startup. That's enough.
})();
