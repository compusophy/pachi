// /api/faucet — calls Tempo Moderato testnet's tempo_fundAddress for a player
// address. Rate-limits per IP (best-effort, in-memory) so casual crawlers don't
// drain the testnet faucet via this proxy.
//
// Vercel serverless function (Node runtime).

const RPC = "https://rpc.moderato.tempo.xyz";
const COOLDOWN_MS = 60_000;          // one fund per IP per minute
const MAX_PER_DAY = 6;               // best-effort soft cap per IP per day

// In-memory state — resets on cold start, fine for testnet.
const seen = new Map(); // ip → { last: ms, dayStart: ms, dayCount: n }

function getIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  // Vercel parses JSON body for us when content-type is application/json.
  const body = req.body && typeof req.body === "object"
    ? req.body
    : (() => { try { return JSON.parse(req.body || "{}"); } catch { return {}; } })();
  const address = (body.address || "").toString();

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: "bad address" });
  }

  const ip = getIp(req);
  const now = Date.now();
  const rec = seen.get(ip) || { last: 0, dayStart: now, dayCount: 0 };

  if (now - rec.dayStart > 24 * 60 * 60 * 1000) {
    rec.dayStart = now;
    rec.dayCount = 0;
  }
  if (now - rec.last < COOLDOWN_MS) {
    return res.status(429).json({ error: "cooldown", retryInSec: Math.ceil((COOLDOWN_MS - (now - rec.last)) / 1000) });
  }
  if (rec.dayCount >= MAX_PER_DAY) {
    return res.status(429).json({ error: "daily cap" });
  }

  let upstream;
  try {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tempo_fundAddress", params: [address] }),
    });
    upstream = await r.json();
  } catch (err) {
    return res.status(502).json({ error: "rpc unreachable", detail: String(err).slice(0, 120) });
  }

  if (upstream.error) {
    return res.status(502).json({ error: "rpc error", detail: upstream.error });
  }

  rec.last = now;
  rec.dayCount += 1;
  seen.set(ip, rec);

  return res.status(200).json({ ok: true, txs: upstream.result });
}
