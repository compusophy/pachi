// Pachi Monte Carlo simulator
// Replicates Pachi.sol's payout logic exactly (popcount-of-12-random-bits → slot
// → multiplier table → sum → payout = stake_per_ball × totalBps / 10_000).
//
// Run: node sim/pachi-sim.mjs

import crypto from "node:crypto";

const MULTS = [850000, 110000, 30000, 16000, 5000, 12000, 1086,
               12000, 5000, 16000, 30000, 110000, 850000];

const C12 = [1, 12, 66, 220, 495, 792, 924, 792, 495, 220, 66, 12, 1]; // C(12,k)
const TOTAL = 4096;

// ── theoretical (closed-form) ─────────────────────────────────────────────
function theoreticalStats() {
  let evBps = 0;
  let varBps = 0;
  for (let k = 0; k < 13; k++) {
    const p = C12[k] / TOTAL;
    evBps  += p * MULTS[k];
    varBps += p * MULTS[k] * MULTS[k];
  }
  varBps -= evBps * evBps;
  const rtp   = evBps / 10_000;
  const stdev = Math.sqrt(varBps) / 10_000;
  return { rtp, stdev };
}

// ── simulation ────────────────────────────────────────────────────────────
function ballSlot() {
  // 12 random bits → popcount → slot index 0..12
  const r = crypto.randomInt(0, TOTAL);
  let c = 0;
  for (let i = 0; i < 12; i++) if ((r >> i) & 1) c++;
  return c;
}

function simulate(n, plays) {
  const stake = 1n;       // $1 / ball, scaled units
  const SCALE = 10_000n;  // bps denominator
  let totalStaked = 0n;
  let totalPaid   = 0n;
  let positive    = 0;
  let breakeven   = 0;
  let maxWinUnits = 0n;
  const slotHits  = new Array(13).fill(0);
  // Tier histogram (per-play multiplier)
  const tiers = { lose: 0, smallWin: 0, bigWin: 0, jackpot: 0, megaJackpot: 0 };

  for (let p = 0; p < plays; p++) {
    let totalBps = 0n;
    for (let i = 0; i < n; i++) {
      const s = ballSlot();
      slotHits[s]++;
      totalBps += BigInt(MULTS[s]);
    }
    const stakeRaw  = stake * BigInt(n);
    const payoutRaw = (stake * totalBps) / SCALE;
    totalStaked += stakeRaw;
    totalPaid   += payoutRaw;
    if (payoutRaw > maxWinUnits) maxWinUnits = payoutRaw;
    if (payoutRaw > stakeRaw)        positive++;
    else if (payoutRaw === stakeRaw) breakeven++;

    const playMult = Number(totalBps) / 10_000 / n; // avg per-ball mult
    if      (playMult >= 50)  tiers.megaJackpot++;
    else if (playMult >= 10)  tiers.jackpot++;
    else if (playMult >= 2)   tiers.bigWin++;
    else if (playMult > 1)    tiers.smallWin++;
    else                      tiers.lose++;
  }

  return {
    n, plays,
    totalStaked: Number(totalStaked),
    totalPaid:   Number(totalPaid),
    rtp:         Number(totalPaid) / Number(totalStaked),
    pctProfit:   positive / plays,
    pctBreak:    breakeven / plays,
    pctLoss:     1 - (positive + breakeven) / plays,
    maxWinUSD:   Number(maxWinUnits),
    slotHits,
    tiers,
  };
}

// ── bankroll bust sim — how long does $1000 last? ─────────────────────────
function bankrollSim(startBank, n, trials, maxPlays = 200_000) {
  const ruined = []; // plays until balance < n*$1
  const survived = [];
  const ending = [];

  for (let t = 0; t < trials; t++) {
    let bal = startBank;
    let plays = 0;
    while (bal >= n && plays < maxPlays) {
      bal -= n;
      let totalBps = 0;
      for (let i = 0; i < n; i++) totalBps += MULTS[ballSlot()];
      bal += totalBps / 10_000;
      plays++;
    }
    ending.push(bal);
    if (bal < n) ruined.push(plays); else survived.push(plays);
  }

  ruined.sort((a, b) => a - b);
  ending.sort((a, b) => a - b);
  const median = (arr) => arr.length ? arr[Math.floor(arr.length / 2)] : NaN;
  const pct    = (arr, p) => arr.length ? arr[Math.floor(arr.length * p)] : NaN;

  return {
    startBank, n, trials, maxPlays,
    ruinRate:       ruined.length / trials,
    medianRuinPlay: median(ruined),
    p10RuinPlay:    pct(ruined, 0.1),
    p90RuinPlay:    pct(ruined, 0.9),
    medianEnd:      median(ending),
    p10End:         pct(ending, 0.1),
    p90End:         pct(ending, 0.9),
  };
}

// ── output helpers ────────────────────────────────────────────────────────
const fmtPct = (x) => (x * 100).toFixed(3) + "%";
const fmtUSD = (x) => "$" + Number(x).toLocaleString();

function rule(label) {
  const line = "─".repeat(64);
  console.log(`\n${line}\n  ${label}\n${line}`);
}

// ── run ───────────────────────────────────────────────────────────────────
console.log("PACHI Monte Carlo — verifying expected value and return\n");

rule("Theoretical (closed-form)");
const theo = theoreticalStats();
console.log(`  Per-ball RTP:    ${fmtPct(theo.rtp)}`);
console.log(`  House edge:      ${fmtPct(1 - theo.rtp)}`);
console.log(`  Per-ball stdev:  ${theo.stdev.toFixed(3)}× stake`);
console.log(`  Per-play stdev (n=10):  ${(theo.stdev / Math.sqrt(10)).toFixed(3)}× per-ball stake`);
console.log(`  Per-play stdev (n=100): ${(theo.stdev / Math.sqrt(100)).toFixed(3)}× per-ball stake`);

rule("Slot distribution (1,000,000 ball samples)");
console.log("  Slot  Mult       Theoretical    Observed     Δ");
const calib = simulate(1, 1_000_000);
for (let s = 0; s < 13; s++) {
  const theoP = C12[s] / TOTAL;
  const obs   = calib.slotHits[s] / 1_000_000;
  const delta = ((obs - theoP) / theoP * 100).toFixed(2);
  console.log(`  ${String(s).padStart(2)}    ${(MULTS[s]/10000+"×").padEnd(8)}   ${(theoP*100).toFixed(4).padStart(8)}%   ${(obs*100).toFixed(4).padStart(8)}%   ${delta.padStart(6)}%`);
}

rule("RTP by ball-count mode");
console.log("  n     plays         total staked    total paid       RTP        % profit  % break  % loss     max win");
for (const { n, plays } of [{ n: 1, plays: 200_000 }, { n: 10, plays: 50_000 }, { n: 100, plays: 5_000 }]) {
  const r = simulate(n, plays);
  console.log(
    `  ${String(n).padStart(3)}   ${plays.toLocaleString().padStart(8)}   ` +
    `${fmtUSD(r.totalStaked).padStart(12)}    ${fmtUSD(r.totalPaid).padStart(12)}   ` +
    `${fmtPct(r.rtp).padStart(8)}   ${fmtPct(r.pctProfit).padStart(7)}   ${fmtPct(r.pctBreak).padStart(6)}   ${fmtPct(r.pctLoss).padStart(7)}   ${fmtUSD(r.maxWinUSD).padStart(8)}`
  );
}

rule("Outcome tier distribution");
console.log("  n     lose      small win   big win    jackpot   mega-jackpot");
console.log("                  (>1×)       (≥2×)      (≥10×)    (≥50×)");
for (const { n, plays } of [{ n: 1, plays: 200_000 }, { n: 10, plays: 50_000 }, { n: 100, plays: 5_000 }]) {
  const r = simulate(n, plays);
  const t = r.tiers;
  console.log(
    `  ${String(n).padStart(3)}   ${fmtPct(t.lose/plays).padStart(7)}   ${fmtPct(t.smallWin/plays).padStart(7)}     ${fmtPct(t.bigWin/plays).padStart(7)}    ${fmtPct(t.jackpot/plays).padStart(7)}   ${fmtPct(t.megaJackpot/plays).padStart(7)}`
  );
}

rule("Bankroll-bust simulation: $1000 starting, until balance < n");
console.log("  n     trials   ruin rate   median plays to ruin (P10 / P90)   median end balance (P10 / P90)");
for (const cfg of [{ n: 1, trials: 1000, maxPlays: 100_000 },
                   { n: 10, trials: 1000, maxPlays: 50_000 },
                   { n: 100, trials: 500, maxPlays: 10_000 }]) {
  const r = bankrollSim(1000, cfg.n, cfg.trials, cfg.maxPlays);
  console.log(
    `  ${String(cfg.n).padStart(3)}   ${String(cfg.trials).padStart(6)}   ${fmtPct(r.ruinRate).padStart(8)}    ${String(Math.round(r.medianRuinPlay || 0)).padStart(6)}    (${Math.round(r.p10RuinPlay || 0)} / ${Math.round(r.p90RuinPlay || 0)})${" ".repeat(Math.max(0, 12 - String(r.p10RuinPlay).length - String(r.p90RuinPlay).length))}   ${fmtUSD(Math.round(r.medianEnd))}    (${fmtUSD(Math.round(r.p10End))} / ${fmtUSD(Math.round(r.p90End))})`
  );
}

rule("Done");
