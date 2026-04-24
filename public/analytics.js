// Analytics — pulls Played events from the Pachi contract, aggregates real
// metrics (RTP, house edge, per-wallet table) and renders into a target
// element. No data is faked; everything is computed from on-chain logs.

const PACHI_ADDR  = "0xbc42C1a7815098BA4321B7bc1Bce0137Fd055E56";
// Block the current Pachi was deployed at — Tempo Moderato RPC rejects
// `fromBlock: "earliest"` on getLogs, and we want to skip irrelevant history
// either way. Update this whenever the contract is redeployed.
const DEPLOY_BLOCK = 14440175n;
// Conservative window for chunked getLogs — Tempo's RPC tolerates ranges up
// to ~10k blocks; keep some headroom.
const CHUNK_SIZE   = 5000n;
const PLAYED_EVENT_ABI = [
  { type: "event", name: "Played", inputs: [
    { indexed: true,  name: "player",       type: "address" },
    { indexed: false, name: "stakePerBall", type: "uint256" },
    { indexed: false, name: "nBalls",       type: "uint256" },
    { indexed: false, name: "paths",        type: "uint256[]" },
    { indexed: false, name: "ballMults",    type: "uint256[]" },
    { indexed: false, name: "totalBps",     type: "uint256" },
    { indexed: false, name: "payout",       type: "uint256" },
    { indexed: false, name: "nonce",        type: "uint256" },
  ]},
];

const fmtUSD = (raw) => {
  const n = Number(raw) / 1e6;
  if (Math.abs(n) >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const fmtPct = (n) => `${(n * 100).toFixed(2)}%`;
const fmtAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmtSignedUSD = (raw) => {
  if (raw >= 0n) return `+${fmtUSD(raw)}`;
  return `−${fmtUSD(-raw)}`;
};

export async function render(targetEl, ctx) {
  targetEl.innerHTML = '<div class="analytics-loading">querying chain…</div>';

  let events;
  try {
    events = await ctx.client.getContractEvents({
      address: PACHI_ADDR,
      abi: PLAYED_EVENT_ABI,
      eventName: "Played",
      fromBlock: "earliest",
      toBlock: "latest",
    });
  } catch (err) {
    console.error(err);
    targetEl.innerHTML = `<div class="analytics-error">${err.shortMessage || err.message || "query failed"}</div>`;
    return;
  }

  if (events.length === 0) {
    targetEl.innerHTML = '<div class="analytics-empty">no plays yet — be the first</div>';
    return;
  }

  // Aggregate
  const players = new Map();
  let totalBalls = 0n;
  let totalWageredRaw = 0n;
  let totalPaidRaw = 0n;

  for (const ev of events) {
    const { player, nBalls, stakePerBall, payout } = ev.args;
    const wagered = stakePerBall * nBalls;
    totalBalls += nBalls;
    totalWageredRaw += wagered;
    totalPaidRaw += payout;

    if (!players.has(player)) {
      players.set(player, { plays: 0, balls: 0n, wagered: 0n, paid: 0n });
    }
    const p = players.get(player);
    p.plays++;
    p.balls += nBalls;
    p.wagered += wagered;
    p.paid += payout;
  }

  const realRtp = Number(totalPaidRaw) / Number(totalWageredRaw);
  const realEdge = 1 - realRtp;

  const playerRows = [...players.entries()]
    .map(([addr, p]) => ({
      addr, ...p,
      net: p.paid - p.wagered,
      rtp: Number(p.wagered) > 0 ? Number(p.paid) / Number(p.wagered) : 0,
    }))
    .sort((a, b) => Number(b.wagered) - Number(a.wagered));

  // Theoretical edge for comparison: 1.618% (calibrated multiplier table).
  // We expose the delta so the dev can spot bias from physics drift / unstuck
  // kicks / etc. Players never see this surface — it's gated behind the logo.
  const theoreticalEdge = 0.01618;
  const edgeDelta = realEdge - theoreticalEdge;

  targetEl.innerHTML = `
    <div class="stats-grid">
      <div class="stat">
        <div class="stat-label">unique wallets</div>
        <div class="stat-val">${players.size}</div>
      </div>
      <div class="stat">
        <div class="stat-label">total plays</div>
        <div class="stat-val">${events.length.toLocaleString()}</div>
      </div>
      <div class="stat">
        <div class="stat-label">total balls</div>
        <div class="stat-val">${totalBalls.toLocaleString()}</div>
      </div>
      <div class="stat">
        <div class="stat-label">total wagered</div>
        <div class="stat-val">${fmtUSD(totalWageredRaw)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">total paid</div>
        <div class="stat-val">${fmtUSD(totalPaidRaw)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">house take</div>
        <div class="stat-val">${fmtSignedUSD(totalWageredRaw - totalPaidRaw)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">real RTP</div>
        <div class="stat-val">${fmtPct(realRtp)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">real edge (vs 1.618% target)</div>
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
        ${playerRows.map(p => `
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
  `;
}
