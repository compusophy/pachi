// Verify the absolute-target aim formula in pachi.js lands every possible
// path at the contract's authoritative slot center. Pure math — no Matter.js,
// no physics noise. If this passes, the AIM is correct; physics noise is a
// separate concern (handled by per-row recalculation + velocity clamp).

const ROWS = 12;
const SLOTS = 13;
const W = 360;                                  // sample board width
const slotWidth = (W - 24) / SLOTS;
const popcount12 = (x) => { let c = 0; for (let i = 0; i < 12; i++) if ((x >> i) & 1) c++; return c; };

// Replica of pachi.js aim target formula:
//   after processing row r, ball belongs in gap `logicalCol` of row r at
//   targetX = W/2 + (logicalCol - (r+1)/2) * slotWidth
function aimTargetForPath(path) {
  let logicalCol = 0;
  let target = W / 2;
  for (let r = 0; r < ROWS; r++) {
    if ((path >> r) & 1) logicalCol++;
    target = W / 2 + (logicalCol - (r + 1) / 2) * slotWidth;
  }
  return target;
}

// Replica of slotBounds[s].mid:
//   leftEdgeX = W/2 - 6.5 * slotWidth ; mid = leftEdgeX + s*slotWidth + slotWidth/2
//             = W/2 + (s - 6) * slotWidth
function slotMid(s) { return W / 2 + (s - (SLOTS - 1) / 2) * slotWidth; }

let mismatches = 0;
let maxDelta = 0;
for (let path = 0; path < 4096; path++) {
  const expectedSlot = popcount12(path);
  const target = aimTargetForPath(path);
  const expected = slotMid(expectedSlot);
  const delta = Math.abs(target - expected);
  if (delta > maxDelta) maxDelta = delta;
  if (delta > 1e-6) {
    mismatches++;
    if (mismatches <= 3) {
      console.log(`  path 0b${path.toString(2).padStart(12, "0")} popcount=${expectedSlot}  target=${target.toFixed(3)}  expected=${expected.toFixed(3)}  Δ=${delta.toExponential(2)}`);
    }
  }
}

console.log(`\nAim formula validation across all 4096 possible 12-bit paths:`);
console.log(`  Mismatches: ${mismatches} / 4096`);
console.log(`  Max delta:  ${maxDelta.toExponential(2)} px`);
console.log(`  Status:     ${mismatches === 0 ? "✓ correct — aim lands every path on its slot center" : "✗ formula has a bug"}`);
