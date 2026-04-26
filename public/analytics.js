// Analytics — pulls aggregates from the Pachi Diamond's StatsFacet via O(1)
// view calls. No event scanning, no block-range pagination, no RPC limits.
// Adding new metrics = add to LibPachi.Storage + StatsFacet view + render here.

const PACHI_DIAMOND = "0x71e767bf661d6294c88953d640f0fc792a4c5086";

const STATS_ABI = [
  { type: "function", name: "houseStats", stateMutability: "view", inputs: [],
    outputs: [
      { name: "totalPlays",    type: "uint256" },
      { name: "totalBalls",    type: "uint256" },
      { name: "totalWagered",  type: "uint256" },
      { name: "totalPaid",     type: "uint256" },
      { name: "uniqueWallets", type: "uint256" },
    ] },
  { type: "function", name: "playersCount", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "playersBatch", stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "uint256" }],
    outputs: [
      { name: "addrs",   type: "address[]" },
      { name: "plays",   type: "uint256[]" },
      { name: "balls",   type: "uint256[]" },
      { name: "wagered", type: "uint256[]" },
      { name: "paid",    type: "uint256[]" },
    ] },
  { type: "function", name: "appVersion", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint256" }] },
];

const fmtUSD = (raw) => {
  const n = Number(raw) / 1e6;
  if (Math.abs(n) >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const fmtPct  = (n) => `${(n * 100).toFixed(2)}%`;
const fmtAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmtSignedUSD = (raw) => raw >= 0n ? `+${fmtUSD(raw)}` : `−${fmtUSD(-raw)}`;

// Theoretical edge derived from the on-chain MULTS table:
//   sum(C(12,k) * MULTS[k]) / 4096 / 10000 = 0.983922 → edge = 0.016078
// The contract comments call this the "1.618% house edge" (the φ ratio),
// but the actual integer multipliers chosen approximate φ — they land at
// 1.6078%, 1.02 bps short. Showing the dashboard's gap-to-target against
// the TRUE on-chain theoretical (not the rounded φ label) lets the
// operator see noise converge to zero rather than to ~+0.01 pp forever.
const TARGET_EDGE = 0.016078;

export async function render(targetEl, ctx) {
  targetEl.innerHTML = '<div class="analytics-loading">querying chain…</div>';

  let stats, count, batch, version;
  try {
    [stats, count, version] = await Promise.all([
      ctx.client.readContract({ address: PACHI_DIAMOND, abi: STATS_ABI, functionName: "houseStats" }),
      ctx.client.readContract({ address: PACHI_DIAMOND, abi: STATS_ABI, functionName: "playersCount" }),
      ctx.client.readContract({ address: PACHI_DIAMOND, abi: STATS_ABI, functionName: "appVersion" }),
    ]);
  } catch (err) {
    console.error(err);
    targetEl.innerHTML = `<div class="analytics-error">${err.shortMessage || err.message || "query failed"}</div>`;
    return;
  }

  const [totalPlays, totalBalls, totalWagered, totalPaid, uniqueWallets] = stats;

  if (totalPlays === 0n) {
    targetEl.innerHTML = '<div class="analytics-empty">no plays yet — be the first</div>';
    return;
  }

  // Pull all wallets in chunks of 100 — RPC-cheap.
  const players = [];
  const PAGE = 100n;
  for (let from = 0n; from < count; from += PAGE) {
    const to = from + PAGE > count ? count : from + PAGE;
    const [addrs, plays, balls, wagered, paid] = await ctx.client.readContract({
      address: PACHI_DIAMOND, abi: STATS_ABI, functionName: "playersBatch", args: [from, to],
    });
    for (let i = 0; i < addrs.length; i++) {
      players.push({
        addr: addrs[i],
        plays: Number(plays[i]),
        balls: balls[i],
        wagered: wagered[i],
        paid: paid[i],
        net: paid[i] - wagered[i],
        rtp: Number(wagered[i]) > 0 ? Number(paid[i]) / Number(wagered[i]) : 0,
      });
    }
  }
  players.sort((a, b) => Number(b.wagered) - Number(a.wagered));

  const realRtp = Number(totalPaid) / Number(totalWagered);
  const realEdge = 1 - realRtp;
  const edgeDelta = realEdge - TARGET_EDGE;

  targetEl.innerHTML = `
    <div class="stats-grid">
      <div class="stat">
        <div class="stat-label">unique wallets</div>
        <div class="stat-val">${uniqueWallets.toString()}</div>
      </div>
      <div class="stat">
        <div class="stat-label">total plays</div>
        <div class="stat-val">${totalPlays.toLocaleString()}</div>
      </div>
      <div class="stat">
        <div class="stat-label">total balls</div>
        <div class="stat-val">${totalBalls.toLocaleString()}</div>
      </div>
      <div class="stat">
        <div class="stat-label">total wagered</div>
        <div class="stat-val">${fmtUSD(totalWagered)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">total paid</div>
        <div class="stat-val">${fmtUSD(totalPaid)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">house take</div>
        <div class="stat-val">${fmtSignedUSD(totalWagered - totalPaid)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">real RTP</div>
        <div class="stat-val">${fmtPct(realRtp)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">real edge (vs ${fmtPct(TARGET_EDGE)} target)</div>
        <div class="stat-val">${fmtPct(realEdge)} <span style="font-size:11px;opacity:0.6;font-weight:400">(${edgeDelta >= 0 ? '+' : ''}${(edgeDelta * 100).toFixed(2)}pp)</span></div>
      </div>
    </div>
    <table class="players-table">
      <thead>
        <tr>
          <th>wallet</th>
          <th>plays</th>
          <th>balls</th>
          <th>wagered</th>
          <th>paid</th>
          <th>net</th>
          <th>rtp</th>
        </tr>
      </thead>
      <tbody>
        ${players.map(p => `
          <tr>
            <td class="addr">${fmtAddr(p.addr)}</td>
            <td>${p.plays}</td>
            <td>${p.balls.toLocaleString()}</td>
            <td>${fmtUSD(p.wagered)}</td>
            <td>${fmtUSD(p.paid)}</td>
            <td class="${p.net >= 0n ? 'pos' : 'neg'}">${fmtSignedUSD(p.net)}</td>
            <td>${fmtPct(p.rtp)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:21px;font-size:10px;letter-spacing:.18em;text-transform:uppercase;opacity:.85">
      <div style="display:flex;gap:8px">
        <button id="analyticsRefresh" style="background:transparent;border:1px solid var(--ink-line);color:var(--ink);font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.18em;padding:5px 13px;border-radius:5px;cursor:pointer;text-transform:uppercase">refresh</button>
        <button id="analyticsCopy" style="background:transparent;border:1px solid var(--ink-line);color:var(--ink);font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.18em;padding:5px 13px;border-radius:5px;cursor:pointer;text-transform:uppercase">copy json</button>
      </div>
      <span style="opacity:.55">contract v${version.toString()} · ${fmtAddr(PACHI_DIAMOND)}</span>
    </div>
  `;

  targetEl.querySelector("#analyticsRefresh")?.addEventListener("click", () => render(targetEl, ctx));

  // Copy the full analytics payload (house aggregates + per-player rows)
  // as JSON so the operator can paste into chat / a spreadsheet / a tool.
  // BigInts → strings (JSON has no native BigInt). Includes timestamp +
  // contract version so a copied snapshot is self-describing.
  const copyBtn = targetEl.querySelector("#analyticsCopy");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const payload = {
        capturedAt: new Date().toISOString(),
        contract: { address: PACHI_DIAMOND, version: version.toString() },
        house: {
          totalPlays:    totalPlays.toString(),
          totalBalls:    totalBalls.toString(),
          totalWagered:  totalWagered.toString(),
          totalPaid:     totalPaid.toString(),
          uniqueWallets: uniqueWallets.toString(),
          realRTP:       realRtp,
          realEdge:      realEdge,
          targetEdge:    TARGET_EDGE,
          edgeDeltaPP:   edgeDelta * 100,
        },
        players: players.map(p => ({
          addr:    p.addr,
          plays:   p.plays,
          balls:   p.balls.toString(),
          wagered: p.wagered.toString(),
          paid:    p.paid.toString(),
          net:     p.net.toString(),
          rtp:     p.rtp,
        })),
      };
      const json = JSON.stringify(payload, null, 2);
      try {
        await navigator.clipboard.writeText(json);
        copyBtn.textContent = "copied";
        copyBtn.style.color = "var(--gold-pure)";
        setTimeout(() => {
          copyBtn.textContent = "copy json";
          copyBtn.style.color = "";
        }, 1400);
      } catch {
        ctx.toast?.("copy failed");
      }
    });
  }
}
