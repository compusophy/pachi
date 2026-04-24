// Physics drift simulator — runs real Matter.js with the exact same board
// geometry, engine settings, ball properties, and tick-loop aim/stuck logic
// as public/cards/pachi.js. For each random 12-bit path, drops a ball and
// records the slot it physically lands in vs the contract's authoritative
// slot (popcount(path)). Reports drift rate, per-tier mismatches, and a
// confusion matrix.
//
// Usage: node sim/physics-drift.mjs [N]   (default 1000 trials)
//
// Keep this in sync with pachi.js whenever the physics or aim logic changes,
// then re-run before deploying. If drift > ~3% the visual will mismatch the
// contract's payout often enough that users notice.

import Matter from "matter-js";
const { Engine, Bodies, World, Body } = Matter;

// ── Geometry / engine — MIRROR of pachi.js buildBoard() defaults ──────────
const PHI       = 1.6180339887;
const ROWS      = 12;
const SLOTS     = 13;
const W         = 360;                                       // sample mobile width
const H         = Math.round(W * PHI);                       // golden portrait
const slotWidth = (W - 24) / SLOTS;
const pegR      = Math.max(2.5, slotWidth * 0.13);
const ballR     = Math.max(4, pegR * PHI);
const slotsH    = Math.max(36, slotWidth * PHI);
const topY      = 55;     // mirror pachi.js spawn-zone bump
const rowSpacing = Math.max(slotWidth * 0.78, (H - slotsH - topY - 26) / ROWS);
const slotsY    = topY + ROWS * rowSpacing + 6;

// Multiplier table — for tier breakdown
const MULTS = [850000, 110000, 30000, 16000, 5000, 12000, 1086,
               12000, 5000, 16000, 30000, 110000, 850000];
function tierForBps(b) {
  if (b >= 800_000) return 6;
  if (b >= 100_000) return 5;
  if (b >= 30_000)  return 4;
  if (b >= 16_000)  return 3;
  if (b >= 12_000)  return 2;
  if (b >= 5_000)   return 1;
  return 0;
}
const SLOT_TIERS = MULTS.map(tierForBps);

const popcount12 = (x) => { let c = 0; for (let i = 0; i < 12; i++) if ((x >> i) & 1) c++; return c; };

// ── Build engine + static world once ──────────────────────────────────────
const engine = Engine.create();
engine.gravity.y = 0.55;
engine.timing.timeScale = 0.85;

// Pegs (pyramid)
for (let r = 0; r < ROWS; r++) {
  const cols = r + 3;
  for (let c = 0; c < cols; c++) {
    const x = W / 2 + (c - (cols - 1) / 2) * slotWidth;
    const y = topY + r * rowSpacing;
    World.add(engine.world, Bodies.circle(x, y, pegR, {
      isStatic: true, restitution: 0.4, friction: 0.05, label: "peg",
    }));
  }
}

// Slot dividers + outer walls
const bottomRowCols = ROWS + 2;
const leftEdgeX  = W / 2 - (bottomRowCols - 1) / 2 * slotWidth;
const rightEdgeX = W / 2 + (bottomRowCols - 1) / 2 * slotWidth;
for (let i = 0; i < bottomRowCols; i++) {
  const x = leftEdgeX + i * slotWidth;
  World.add(engine.world, Bodies.rectangle(x, slotsY + slotsH / 2, 2, slotsH, {
    isStatic: true, label: "divider",
  }));
}
const outerWallH = slotsY + slotsH - topY + 32;
World.add(engine.world, [
  Bodies.rectangle(W / 2, slotsY + slotsH + 4, W, 8, { isStatic: true, label: "floor" }),
  Bodies.rectangle(leftEdgeX  - 1, topY + outerWallH / 2 - 16, 2, outerWallH, { isStatic: true }),
  Bodies.rectangle(rightEdgeX + 1, topY + outerWallH / 2 - 16, 2, outerWallH, { isStatic: true }),
]);

// Slot bounds (for landing detection)
const slotBounds = [];
for (let s = 0; s < SLOTS; s++) {
  const x0 = leftEdgeX + s * slotWidth;
  slotBounds.push({ x0, x1: x0 + slotWidth, mid: x0 + slotWidth / 2, idx: s });
}

// ── One ball drop ─────────────────────────────────────────────────────────
function simulateBall(path) {
  const expectedSlot = popcount12(path);

  const startX = W / 2 + (Math.random() - 0.5) * slotWidth * 0.5;
  const ball = Bodies.circle(startX, topY - ballR * 2 - Math.random() * 16, ballR, {
    restitution: 0.32, friction: 0.002, frictionAir: 0.005, density: 0.025,
    label: "ball",
  });
  ball.path = path;
  ball.expectedSlot = expectedSlot;
  ball.currentRow = -1;
  ball.logicalCol = 0;
  ball.lastProgressY = ball.position.y;
  ball.lastProgressF = 0;

  World.add(engine.world, ball);

  let actualSlot = -1;
  let settled    = false;
  let frame      = 0;
  const MAX_FRAMES = 1500;          // ~25 sec of real time, way more than needed

  while (!settled && frame < MAX_FRAMES) {
    Engine.update(engine, 1000 / 60);

    // Aim — absolute target per row (mirror pachi.js)
    const newRow = Math.floor((ball.position.y - topY) / rowSpacing);
    if (newRow > ball.currentRow && newRow < ROWS) {
      ball.currentRow = newRow;
      const bit = (path >> newRow) & 1;
      if (bit) ball.logicalCol++;
      ball.targetX = W / 2 + (ball.logicalCol - (newRow + 1) / 2) * slotWidth;
      const nextRowY = topY + (newRow + 1) * rowSpacing;
      const dy = Math.max(rowSpacing * 0.5, nextRowY - ball.position.y);
      const vY = Math.max(1.4, ball.velocity.y);
      const timeToNext = dy / vY;
      const rawVx = (ball.targetX - ball.position.x) / timeToNext;
      const vx   = Math.max(-3.5, Math.min(3.5, rawVx));
      Body.setVelocity(ball, { x: vx, y: vY });
    }

    // Continuous steering — gentle pull toward the active target each frame.
    // Without this, peg bounces between rows can drift the ball off-aim and
    // the next row's recalc is stuck catching up.
    if (ball.targetX != null && ball.currentRow >= 0) {
      const dx = ball.targetX - ball.position.x;
      if (Math.abs(dx) > 0.5) {
        // Force scaled by mass so behavior is independent of density.
        Body.applyForce(ball, ball.position, { x: dx * 0.000018 * ball.mass, y: 0 });
      }
    }

    // Stuck detector
    if (ball.position.y > ball.lastProgressY + 1) {
      ball.lastProgressY = ball.position.y;
      ball.lastProgressF = frame;
    } else if (frame - ball.lastProgressF > 30) {
      Body.setVelocity(ball, {
        x: ball.velocity.x * 0.3 + (Math.random() - 0.5) * 0.6,
        y: 3.5,
      });
      ball.lastProgressF = frame;
    }

    // Settled in slot
    if (ball.position.y > slotsY + slotsH * 0.4 && Math.abs(ball.velocity.y) < 1.2) {
      settled = true;
      for (const sb of slotBounds) {
        if (ball.position.x >= sb.x0 && ball.position.x < sb.x1) {
          actualSlot = sb.idx;
          break;
        }
      }
      // Edge case: ball outside any slot
      if (actualSlot < 0) {
        actualSlot = ball.position.x < W / 2 ? 0 : SLOTS - 1;
      }
    }

    frame++;
  }

  World.remove(engine.world, ball);
  return { expectedSlot, actualSlot, frames: frame, settled };
}

// ── Run trials ────────────────────────────────────────────────────────────
const N = parseInt(process.argv[2] || "1000", 10);
console.log(`\nPhysics drift simulator — ${N} trials`);
console.log(`  Geometry: W=${W}px H=${H}px slotWidth=${slotWidth.toFixed(1)} pegR=${pegR.toFixed(1)} ballR=${ballR.toFixed(1)}`);
console.log(`  Engine:   gravity.y=${engine.gravity.y} timeScale=${engine.timing.timeScale}\n`);

const matrix       = Array.from({ length: SLOTS }, () => new Array(SLOTS).fill(0));
const expectedHits = new Array(SLOTS).fill(0);
const driftDist    = [];
let mismatches = 0;
let unsettled  = 0;
let totalFrames = 0;

const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const path = Math.floor(Math.random() * 4096);
  const { expectedSlot, actualSlot, frames, settled } = simulateBall(path);
  totalFrames += frames;
  if (!settled) { unsettled++; continue; }
  expectedHits[expectedSlot]++;
  matrix[expectedSlot][actualSlot]++;
  if (expectedSlot !== actualSlot) {
    mismatches++;
    driftDist.push(Math.abs(expectedSlot - actualSlot));
  }
  if ((i + 1) % 200 === 0) {
    process.stdout.write(`  ${i + 1}/${N}  drift so far ${(100 * mismatches / (i + 1 - unsettled)).toFixed(2)}%\n`);
  }
}
const elapsed = (Date.now() - t0) / 1000;

const settled = N - unsettled;
const driftRate = mismatches / settled;
const avgDrift = driftDist.length ? driftDist.reduce((a, b) => a + b, 0) / driftDist.length : 0;
const maxDrift = driftDist.length ? Math.max(...driftDist) : 0;
const fmtPct = (n) => (n * 100).toFixed(2) + "%";

console.log(`\n=== Aggregate ===`);
console.log(`  Trials:         ${N}`);
console.log(`  Settled:        ${settled}`);
console.log(`  Unsettled:      ${unsettled}${unsettled > 0 ? "  ⚠ stuck-detector failed" : ""}`);
console.log(`  Visual drift:   ${mismatches}/${settled}  (${fmtPct(driftRate)})`);
console.log(`  Avg drift:      ${avgDrift.toFixed(2)} slots`);
console.log(`  Max drift:      ${maxDrift} slots`);
console.log(`  Sim speed:      ${(N / elapsed).toFixed(0)} balls/sec  (${elapsed.toFixed(1)}s total)`);

console.log(`\n=== Per-tier drift rate ===`);
console.log(`  Tier  Mult       Slots                           expected hits   drifted   rate`);
const tierBuckets = new Array(7).fill(null).map(() => ({ exp: 0, drift: 0 }));
for (let s = 0; s < SLOTS; s++) {
  const tier = SLOT_TIERS[s];
  tierBuckets[tier].exp   += expectedHits[s];
  tierBuckets[tier].drift += expectedHits[s] - matrix[s][s];
}
const tierLabels = [
  ["0", "0.1×"], ["1", "0.5×"], ["2", "1.2×"], ["3", "1.6×"],
  ["4", "3×"  ], ["5", "11×" ], ["6", "85×" ],
];
for (let t = 6; t >= 0; t--) {
  const slotIdxs = SLOT_TIERS.map((tt, i) => tt === t ? i : -1).filter(i => i >= 0);
  const label = `${tierLabels[t][0]}     ${tierLabels[t][1].padEnd(8)}  [${slotIdxs.join(",").padEnd(28)}]`;
  const { exp, drift } = tierBuckets[t];
  const rate = exp > 0 ? drift / exp : 0;
  console.log(`  ${label}  ${String(exp).padStart(13)}   ${String(drift).padStart(7)}   ${fmtPct(rate)}`);
}

console.log(`\n=== Confusion matrix (rows = expected slot, cols = actual slot) ===`);
let header = "       ";
for (let s = 0; s < SLOTS; s++) header += String(s).padStart(5);
console.log(header);
for (let r = 0; r < SLOTS; r++) {
  let line = `  ${String(r).padStart(2)}:  `;
  for (let c = 0; c < SLOTS; c++) {
    const v = matrix[r][c];
    if (v === 0) line += "    .";
    else if (r === c) line += String(v).padStart(5);          // correct
    else line += "\x1b[31m" + String(v).padStart(5) + "\x1b[0m"; // red drift
  }
  line += `   tot ${expectedHits[r]}`;
  console.log(line);
}

console.log(`\n${driftRate < 0.03 ? "✓ drift under 3% — visual mismatch should be rare in production" :
              driftRate < 0.10 ? "⚠ drift 3–10% — noticeable in heavy play, consider tuning" :
                                 "✗ drift > 10% — physics aim needs work"}`);
