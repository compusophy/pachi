// Run N plays of K balls against the deployed Pachi via raw RPC, then
// aggregate the Played events and compute real on-chain RTP.

import crypto from "node:crypto";

const RPC   = "https://rpc.moderato.tempo.xyz";
const PACHI = "0xbc42C1a7815098BA4321B7bc1Bce0137Fd055E56";
const TOKEN = "0x20c0000000000000000000000000000000000001";
const PRIV  = "0xd3dd2940e09d14bea2b8714497b57a703162bc9695a37fcb5f3993f4a2347171";

// ── usage: node sim/onchain-rtp.mjs [PLAYS] [BALLS] ──
const PLAYS = parseInt(process.argv[2] || "10", 10);
const BALLS = parseInt(process.argv[3] || "100", 10);
const FROM_BLOCK = 14440175n;  // Pachi v3 deploy block

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

async function getLogs(fromBlock, toBlock) {
  const playedSig = "0x" + (await rpc("web3_clientVersion", []).then(() => "")) || "";
  // keccak256("Played(address,uint256,uint256,uint256[],uint256[],uint256,uint256,uint256)")
  const sig = "0xc6ce98194008ed376863343a2de4f8fef55325811d454082332e83a1280b1409";
  return rpc("eth_getLogs", [{
    address: PACHI,
    topics: [sig],
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock:   "0x" + toBlock.toString(16),
  }]);
}

function decodePlayedData(hex) {
  // strip 0x
  const h = hex.slice(2);
  const at = (i) => BigInt("0x" + h.slice(i * 64, (i + 1) * 64));
  // layout: stake(0) nBalls(1) offsetPaths(2) offsetMults(3) totalBps(4) payout(5) nonce(6) ...
  return {
    stake:    at(0),
    nBalls:   at(1),
    totalBps: at(4),
    payout:   at(5),
    nonce:    at(6),
  };
}

const fmtUSD = (raw) =>
  "$" + (Number(raw) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n * 100).toFixed(3) + "%";

console.log(`\n=== Aggregating Played events from block ${FROM_BLOCK} to latest ===\n`);
const latestHex = await rpc("eth_blockNumber", []);
const latest = BigInt(latestHex);
console.log(`Latest block: ${latest} (range = ${latest - FROM_BLOCK})\n`);

// Chunked getLogs (Tempo caps range)
const CHUNK = 5000n;
const allLogs = [];
for (let from = FROM_BLOCK; from <= latest; from += CHUNK + 1n) {
  const to = from + CHUNK > latest ? latest : from + CHUNK;
  const logs = await getLogs(from, to);
  allLogs.push(...logs);
}

console.log(`Found ${allLogs.length} Played events`);

const players = new Map();
let totalWagered = 0n;
let totalPaid = 0n;
let totalBalls = 0n;

for (const log of allLogs) {
  const player = "0x" + log.topics[1].slice(26);
  const { stake, nBalls, payout } = decodePlayedData(log.data);
  const wagered = stake * nBalls;
  totalWagered += wagered;
  totalPaid += payout;
  totalBalls += nBalls;
  if (!players.has(player)) players.set(player, { plays: 0, balls: 0n, wagered: 0n, paid: 0n });
  const p = players.get(player);
  p.plays++; p.balls += nBalls; p.wagered += wagered; p.paid += payout;
}

console.log(`\n=== Aggregate (all-time, all wallets) ===`);
console.log(`  Unique wallets:  ${players.size}`);
console.log(`  Total plays:     ${allLogs.length}`);
console.log(`  Total balls:     ${totalBalls.toLocaleString()}`);
console.log(`  Total wagered:   ${fmtUSD(totalWagered)}`);
console.log(`  Total paid:      ${fmtUSD(totalPaid)}`);
console.log(`  House net:       ${fmtUSD(totalWagered - totalPaid)}`);
const rtp = Number(totalPaid) / Number(totalWagered);
console.log(`  Real RTP:        ${fmtPct(rtp)}`);
console.log(`  Real edge:       ${fmtPct(1 - rtp)}  (target 1.618%)`);
const delta = (1 - rtp) - 0.01618;
console.log(`  Δ vs target:     ${(delta * 100 >= 0 ? "+" : "") + (delta * 100).toFixed(3)}pp`);

console.log(`\n=== Per-wallet ===`);
const rows = [...players.entries()]
  .map(([addr, p]) => ({ addr, ...p, rtp: Number(p.paid) / Number(p.wagered) }))
  .sort((a, b) => Number(b.wagered) - Number(a.wagered));
console.log(`  wallet                                       plays  balls    wagered    paid       rtp`);
for (const r of rows) {
  console.log(
    `  ${r.addr}   ${String(r.plays).padStart(4)}  ${String(r.balls).padStart(6)}  ${fmtUSD(r.wagered).padStart(9)}  ${fmtUSD(r.paid).padStart(9)}  ${fmtPct(r.rtp)}`
  );
}
