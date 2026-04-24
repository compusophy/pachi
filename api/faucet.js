// /api/faucet — calls Tempo Moderato testnet's tempo_fundAddress and waits
// for the funding tx to confirm before returning. Idempotent: if the address
// already has balance, returns immediately without re-funding.
//
// Vercel serverless function (Node runtime).

const RPC = "https://rpc.moderato.tempo.xyz";
const ALPHA_USD = "0x20c0000000000000000000000000000000000001";

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`rpc http ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

async function balanceOf(address) {
  const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  const result = await rpc("eth_call", [{ to: ALPHA_USD, data }, "latest"]);
  return BigInt(result);
}

async function waitForReceipt(hash, deadlineMs) {
  while (Date.now() < deadlineMs) {
    try {
      const r = await rpc("eth_getTransactionReceipt", [hash]);
      if (r && r.blockNumber) return r;
    } catch {}
    await new Promise((res) => setTimeout(res, 400));
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  const body = typeof req.body === "string"
    ? (() => { try { return JSON.parse(req.body || "{}"); } catch { return {}; } })()
    : (req.body || {});
  const address = String(body.address || "");

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: "bad address" });
  }

  // Idempotency: if already funded, skip the faucet call.
  try {
    const bal = await balanceOf(address);
    if (bal > 0n) {
      return res.status(200).json({ ok: true, alreadyFunded: true, balance: bal.toString() });
    }
  } catch (err) {
    // Don't block on the balance check — continue to funding.
  }

  // Fund.
  let txs;
  try {
    txs = await rpc("tempo_fundAddress", [address]);
  } catch (err) {
    return res.status(502).json({ error: "fund rpc failed", detail: String(err).slice(0, 200) });
  }

  // Wait for the last funding tx to land. ~7s budget — leaves headroom under
  // the 10s Vercel function ceiling.
  const deadline = Date.now() + 7000;
  const receipt = await waitForReceipt(txs[txs.length - 1], deadline);

  if (!receipt) {
    // Confirmed enqueue, just hadn't landed in 7s. Frontend will keep polling.
    return res.status(202).json({ ok: true, pending: true, txs });
  }

  return res.status(200).json({ ok: true, txs, blockNumber: receipt.blockNumber });
}
