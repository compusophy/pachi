// One-shot read-only check of the live diamond's house edge against
// the theoretical edge derived from the contract's MULTS table. Reports
// the gap in pp AND a z-score so the operator can tell whether a gap
// is real or just sample noise.
//
//   npm run sim:edge
//
// Reads houseStats() from the diamond — no key needed, no tx, no cost.
// Useful when you want to know "is the bankroll bleeding faster than
// theory?" before reaching for AdminFacet.setMults().

import { encodeFunctionData } from "viem";

const RPC     = "https://rpc.moderato.tempo.xyz";
const DIAMOND = "0x71e767bf661d6294c88953d640f0fc792a4c5086";

// Same MULTS the contract initialises with — kept in sync by hand. If
// you setMults() on chain, mirror the change here too.
const MULTS = [850000, 110000, 30000, 16000, 5000, 12000, 1086,
               12000, 5000, 16000, 30000, 110000, 850000];
const C12   = [1, 12, 66, 220, 495, 792, 924, 792, 495, 220, 66, 12, 1];

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

const data = encodeFunctionData({
  abi: [{
    type: "function", name: "houseStats", stateMutability: "view", inputs: [],
    outputs: [
      { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
      { type: "uint256" }, { type: "uint256" },
    ],
  }],
  functionName: "houseStats",
});

const result = await rpc("eth_call", [{ to: DIAMOND, data }, "latest"]);
const h  = result.slice(2);
const at = (i) => BigInt("0x" + h.slice(i * 64, (i + 1) * 64));
const totalPlays    = at(0);
const totalBalls    = at(1);
const totalWagered  = at(2);
const totalPaid     = at(3);
const uniqueWallets = at(4);

const wagered = Number(totalWagered) / 1e6;
const paid    = Number(totalPaid)    / 1e6;
const rtp     = wagered ? paid / wagered : 0;
const edge    = 1 - rtp;

let evBps = 0, e2Bps = 0;
for (let k = 0; k < 13; k++) {
  const p = C12[k] / 4096;
  evBps  += p * MULTS[k];
  e2Bps  += p * MULTS[k] * MULTS[k];
}
const sdBps      = Math.sqrt(e2Bps - evBps * evBps);
const theoryEdge = 1 - evBps / 10000;
const balls      = Number(totalBalls);
const se         = balls ? (sdBps / 10000) / Math.sqrt(balls) : Infinity;
const gap        = edge - theoryEdge;
const z          = se > 0 ? gap / se : 0;

const verdict =
  Math.abs(z) > 3 ? "STRONG SIGNAL — investigate the contract math" :
  Math.abs(z) > 2 ? "borderline significant — wait for more samples"
                  : "within sample noise";

const fmtUSD = (n) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });

console.log("=== PACHI live edge check (Tempo Moderato testnet) ===\n");
console.log(`  totalPlays:      ${totalPlays.toString()}`);
console.log(`  totalBalls:      ${totalBalls.toString()}`);
console.log(`  uniqueWallets:   ${uniqueWallets.toString()}`);
console.log(`  totalWagered:    ${fmtUSD(wagered)}`);
console.log(`  totalPaid:       ${fmtUSD(paid)}`);
console.log(`  house net:       ${fmtUSD(wagered - paid)}\n`);
console.log(`  Real RTP:        ${(rtp * 100).toFixed(4)}%`);
console.log(`  Real edge:       ${(edge * 100).toFixed(4)}%`);
console.log(`  Theory edge:     ${(theoryEdge * 100).toFixed(4)}%   (from MULTS table)`);
console.log(`  Gap:             ${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(4)} pp`);
console.log(`  SE on estimate:  ${(se * 100).toFixed(4)} pp   (n=${balls})`);
console.log(`  z-score:         ${z.toFixed(2)}σ   → ${verdict}\n`);

// Sample-size advice — how many balls to detect the current gap as
// significant if it's real? Useful for "should we wait or recalibrate?"
if (Math.abs(gap) > 0 && Math.abs(z) <= 2) {
  const needed = Math.ceil(Math.pow((sdBps / 10000) / Math.abs(gap) * 2, 2));
  console.log(`  To resolve current ${Math.abs(gap * 100).toFixed(2)}pp gap at 2σ, need n ≥ ${needed.toLocaleString()} balls`);
  console.log(`  (currently n=${balls}, so ~${(needed / balls).toFixed(1)}× more samples)`);
}
