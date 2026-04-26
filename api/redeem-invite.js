// /api/redeem-invite — claim a hand-distributed invite code, transferring
// PachiUSD from a server-held treasury wallet to the invitee. Codes are
// expected to be 1:1 with recipients (operator distributes uniquely); we do
// not yet track redemptions, so a leaked code is the operator's problem to
// rotate. Acceptable for testnet; revisit before mainnet.
//
// Required Vercel env vars
// ────────────────────────
// INVITE_TREASURY_KEY  hex-prefixed (0x…) private key. The wallet must hold
//                      AlphaUSD (gas) and a PachiUSD float minted by the
//                      diamond owner. Top up periodically.
// INVITE_CODES         JSON map of { "<code>": <whole-balls-amount>, … }.
//                      Example: {"alice-2026":5000,"bob-vip":50000}.
//                      Whole balls; multiplied by 1e6 (PachiUSD decimals).
//
// Optional
// ────────
// INVITE_DAILY_BUDGET  whole-balls cap per address per UTC day (enforced via
//                      a coarse balance check — left as a TODO; right now we
//                      rely on operator distribution discipline).

import { createClient, http, publicActions, walletActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { tempoActions } from "viem/tempo";

const ALPHA_USD = "0x20c0000000000000000000000000000000000001";
const PACHI_USD = "0x576da0a989d574a3f9568007daceea919db6c53b";

const ERC20_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
];

function loadCodeTable() {
  const raw = process.env.INVITE_CODES;
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    return obj;
  } catch {
    return null;
  }
}

let cachedClient = null;
function getClient() {
  if (cachedClient) return cachedClient;
  const key = process.env.INVITE_TREASURY_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("treasury key not configured");
  }
  const account = privateKeyToAccount(key);
  cachedClient = createClient({
    account,
    chain: tempoModerato.extend({ feeToken: ALPHA_USD }),
    transport: http(),
  })
    .extend(publicActions)
    .extend(walletActions)
    .extend(tempoActions());
  return cachedClient;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  const body = typeof req.body === "string"
    ? (() => { try { return JSON.parse(req.body || "{}"); } catch { return {}; } })()
    : (req.body || {});

  const code = String(body.code || "").trim();
  const address = String(body.address || "").trim();

  if (!/^[A-Za-z0-9_\-]{1,64}$/.test(code)) {
    return res.status(400).json({ error: "bad code" });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: "bad address" });
  }

  const table = loadCodeTable();
  if (!table) {
    return res.status(503).json({ error: "invites not configured" });
  }
  const wholeBalls = table[code];
  if (typeof wholeBalls !== "number" || wholeBalls <= 0) {
    return res.status(404).json({ error: "unknown code" });
  }

  let client;
  try {
    client = getClient();
  } catch (err) {
    return res.status(503).json({ error: String(err.message || err).slice(0, 120) });
  }

  // 6-decimal token → multiply by 1e6 to get raw amount.
  const amountRaw = BigInt(Math.round(wholeBalls)) * 1_000_000n;

  try {
    const hash = await client.writeContract({
      address: PACHI_USD,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [address, amountRaw],
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    return res.status(200).json({
      ok: true,
      amount: wholeBalls,
      tx: hash,
      block: receipt.blockNumber?.toString(),
    });
  } catch (err) {
    const msg = String(err.shortMessage || err.message || err).slice(0, 200);
    // Treasury out of PachiUSD or out of gas — surface a 503 so the client
    // can retry on next reload (we leave the code in localStorage by default).
    if (/insufficient|balance|fee/i.test(msg)) {
      return res.status(503).json({ error: msg });
    }
    return res.status(502).json({ error: msg });
  }
}
