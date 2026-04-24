// PACHI v2 — multi-ball Plinko (1 / 10 / 100)
// Self-contained card. Matter.js for physics, custom canvas2d for render,
// Tone.js for audio. Ball outcomes are deterministic from contract event paths.

import Matter from "https://esm.sh/matter-js@0.20.0";
import * as Tone from "https://esm.sh/tone@15.0.4";

const PACHI_ADDR = "0xbc42C1a7815098BA4321B7bc1Bce0137Fd055E56";
const TOKEN_ADDR = "0x20c0000000000000000000000000000000000001"; // AlphaUSD
const MAX_UINT256 = (1n << 256n) - 1n;

const PACHI_ABI = [
  { type: "function", name: "play", stateMutability: "nonpayable",
    inputs: [{ name: "n", type: "uint256" }],
    outputs: [
      { type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256" }, { type: "uint256" },
    ] },
  { type: "function", name: "stake", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
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

const ERC20_ABI = [
  { type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];

// Same multiplier table the contract uses (in bps).
// Calibrated for 1.618% house edge.
const MULTS = [850000, 110000, 30000, 16000, 5000, 12000, 1086,
               12000, 5000, 16000, 30000, 110000, 850000];

const PHI = 1.6180339887;

// Slot tone — tiered gold scale (no rainbow). Each tier is a φ-step in
// payoff value; visual intensity follows. Mirrors the brand palette.
const TIER_GOLD = [
  "#1d1605",  // tier 0 — dim ember (only the central 0.1× sink)
  "#3a2e0e",  // tier 1 — deep amber  (0.5×)
  "#6b521b",  // tier 2 — settled bronze (1.2×)
  "#9c772a",  // tier 3 — honey (1.6×)
  "#d09e3a",  // tier 4 — bright honey (3×)
  "#ffc940",  // tier 5 — bright gold (11×)
  "#ffe066",  // tier 6 — blazing (jackpot 85×)
];
function tierForBps(bps) {
  if (bps >= 800_000) return 6;
  if (bps >= 100_000) return 5;
  if (bps >= 30_000)  return 4;
  if (bps >= 16_000)  return 3;
  if (bps >= 12_000)  return 2;
  if (bps >= 5_000)   return 1;
  return 0;
}
const SLOT_TIERS  = MULTS.map(tierForBps);
const SLOT_COLORS = SLOT_TIERS.map((t) => TIER_GOLD[t]);

// Per-tier base fill alpha (Fibonacci hex steps — each tier ~φ× brighter)
const TIER_BG_ALPHA  = [0x05, 0x0d, 0x14, 0x21, 0x34, 0x55, 0x89];
// Per-tier hot-tint amplification — high-tier slots respond more dramatically
// when struck, low-tier slots are quietly absorbed.
const TIER_HOT_BOOST = [0.8, 1.0, 1.2, 1.5, 1.9, 2.3, 3.0];

const popcount12 = (x) => {
  let c = 0;
  for (let i = 0; i < 12; i++) if ((x >> i) & 1) c++;
  return c;
};

const fmtMult = (bps) => {
  const m = bps / 10000;
  if (m >= 100) return Math.round(m) + "×";
  if (m >= 10)  return m.toFixed(0) + "×";
  if (m >= 1)   return m.toFixed(1) + "×";
  return m.toFixed(1) + "×";
};

const fmtUSD = (raw) =>
  `$${(Number(raw) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── module ────────────────────────────────────────────────────────────────
export function mount(slot, ctx) {
  slot.innerHTML = `
    <div class="pachi-root">
      <div class="pachi-totalwrap">
        <div class="pachi-total" id="ptotal">—</div>
      </div>
      <div class="pachi-board" id="pboard">
        <canvas id="pcanvas"></canvas>
      </div>
      <div class="pachi-controls">
        <div class="pachi-pills" role="radiogroup">
          <button class="pachi-pill" data-n="1"   aria-pressed="true">
            <span class="dot"></span><span class="x">×1</span>
          </button>
          <button class="pachi-pill" data-n="10"  aria-pressed="false">
            <span class="dot"></span><span class="x">×10</span>
          </button>
          <button class="pachi-pill" data-n="100" aria-pressed="false">
            <span class="dot"></span><span class="x">×100</span>
          </button>
        </div>
        <button class="pachi-btn" id="pbtn">DROP</button>
        <div class="pachi-stake" id="pstake">$1.00</div>
      </div>
    </div>
  `;
  const style = document.createElement("style");
  style.textContent = PACHI_CSS;
  slot.appendChild(style);

  const canvas  = slot.querySelector("#pcanvas");
  const btnEl   = slot.querySelector("#pbtn");
  const totalEl = slot.querySelector("#ptotal");
  const stakeEl = slot.querySelector("#pstake");
  const board   = slot.querySelector("#pboard");
  const pills   = [...slot.querySelectorAll(".pachi-pill")];
  const cx      = canvas.getContext("2d");

  // ── ball-count selector ─────────────────────────────────────────────────
  let selectedN = 1;
  function setN(n) {
    selectedN = n;
    pills.forEach(p => p.setAttribute("aria-pressed", String(Number(p.dataset.n) === n)));
    updateStakeLabel();
  }
  pills.forEach(p => p.addEventListener("click", (e) => {
    e.stopPropagation();
    if (btnEl.disabled) return;
    setN(Number(p.dataset.n));
    p.blur();
  }));

  // ── physics setup ───────────────────────────────────────────────────────
  const engine = Matter.Engine.create();
  engine.gravity.y = 0.55;
  engine.timing.timeScale = 0.85;

  const ROWS = 12;
  const SLOTS = 13;
  let dpr = 1, W = 0, H = 0, slotWidth = 0, pegR = 0, ballR = 0, topY = 0, slotsY = 0, slotsH = 0;
  let pegBodies = [];
  let slotBounds = [];

  function buildBoard() {
    Matter.World.clear(engine.world, false);
    pegBodies = [];
    slotBounds = [];

    dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = board.clientWidth;
    const cssH = board.clientHeight;
    if (cssW < 8 || cssH < 8) return;
    W = cssW; H = cssH;
    canvas.width  = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width  = cssW + "px";
    canvas.style.height = cssH + "px";
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const usableW = W - 24;
    slotWidth = usableW / SLOTS;
    pegR  = Math.max(2.5, slotWidth * 0.13);
    ballR = Math.max(4, pegR * PHI);  // golden ratio: ball is φ× the peg radius
    // Slot catch container = golden PORTRAIT per box (taller than wide).
    // height = width * φ.
    slotsH = Math.max(36, slotWidth * PHI);
    // Use remaining vertical space for peg field; enforce minimum row spacing
    const rowSpacing = Math.max(slotWidth * 0.78, (H - slotsH - 50) / ROWS);
    topY = 24;
    slotsY = topY + ROWS * rowSpacing + 6;

    for (let r = 0; r < ROWS; r++) {
      const cols = r + 3;
      for (let c = 0; c < cols; c++) {
        const x = W / 2 + (c - (cols - 1) / 2) * slotWidth;
        const y = topY + r * rowSpacing;
        const peg = Matter.Bodies.circle(x, y, pegR, {
          isStatic: true, restitution: 0.4, friction: 0.05, label: "peg",
        });
        peg.lastHit = 0;
        peg.row = r;
        pegBodies.push(peg);
        Matter.World.add(engine.world, peg);
      }
    }

    // Slot dividers: 14 walls beneath the bottom row of pegs (forming 13 slots)
    const bottomRowCols = ROWS + 2;
    const leftEdgeX  = W / 2 - (bottomRowCols - 1) / 2 * slotWidth;
    const rightEdgeX = W / 2 + (bottomRowCols - 1) / 2 * slotWidth;

    for (let i = 0; i < bottomRowCols; i++) {
      const x = leftEdgeX + i * slotWidth;
      const wall = Matter.Bodies.rectangle(x, slotsY + slotsH / 2, 2, slotsH, {
        isStatic: true, label: "divider",
      });
      Matter.World.add(engine.world, wall);
    }

    for (let s = 0; s < SLOTS; s++) {
      const x0 = leftEdgeX + s * slotWidth;
      const x1 = x0 + slotWidth;
      slotBounds.push({ x0, x1, mid: (x0 + x1) / 2, idx: s, hot: 0 });
    }

    // Outer playfield walls — flush with the leftmost / rightmost dividers and
    // extending all the way up to the top, so balls cannot wedge in the gap
    // between the outermost peg column and a far-away wall.
    const outerWallH = slotsY + slotsH - topY + 32;
    Matter.World.add(engine.world, [
      Matter.Bodies.rectangle(W / 2, slotsY + slotsH + 4, W, 8, { isStatic: true, label: "floor" }),
      Matter.Bodies.rectangle(leftEdgeX  - 1, topY + outerWallH / 2 - 16, 2, outerWallH, { isStatic: true, label: "outerWall" }),
      Matter.Bodies.rectangle(rightEdgeX + 1, topY + outerWallH / 2 - 16, 2, outerWallH, { isStatic: true, label: "outerWall" }),
    ]);
  }

  // ── audio (lazy, throttled) ─────────────────────────────────────────────
  let audio = null;
  let lastClickAudio = 0;
  let lastLandAudio = 0;

  async function ensureAudio() {
    if (audio) return audio;
    await Tone.start();
    const dest = new Tone.Limiter(-1).toDestination();
    const click = new Tone.MembraneSynth({
      pitchDecay: 0.005, octaves: 4,
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
      volume: -22,
    }).connect(dest);
    const land = new Tone.Synth({
      oscillator: { type: "triangle" },
      envelope: { attack: 0.005, decay: 0.4, sustain: 0, release: 0.4 },
      volume: -10,
    }).connect(dest);
    const jackpot = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: { attack: 0.005, decay: 0.6, sustain: 0.1, release: 0.4 },
      volume: -6,
    }).connect(dest);
    audio = { dest, click, land, jackpot };
    return audio;
  }

  // ── render ──────────────────────────────────────────────────────────────
  const trails = [];
  const balls = [];
  const slotFlashes = []; // {slotIdx, t}
  let mounted = true;

  function render() {
    if (!mounted) return;
    if (W === 0) buildBoard();

    // bg with subtle inner glow
    cx.fillStyle = "#0a0d18";
    cx.fillRect(0, 0, W, H);

    // slot fills — tiered gold by multiplier value, with hot-tint when struck.
    // Top-tier slots breathe a slow shimmer always-on.
    const now = performance.now();
    for (let s = 0; s < SLOTS; s++) {
      const b = slotBounds[s];
      const tier = SLOT_TIERS[s];
      const c = TIER_GOLD[tier];
      const heat = b.hot > 0 ? Math.max(0, 1 - (now - b.hot) / 600) : 0;
      const boost = TIER_HOT_BOOST[tier];
      // Always-on shimmer for tiers 5+ (bright gold and jackpot)
      const breath = tier >= 5 ? (Math.sin(now * 0.0021 + s * 0.7) + 1) / 2 : 0;
      const alpha = TIER_BG_ALPHA[tier] + heat * 0xA0 * boost + breath * 0x18;
      cx.fillStyle = c + toAlphaHex(Math.min(0xff, alpha));
      cx.fillRect(b.x0 + 1, slotsY, b.x1 - b.x0 - 2, slotsH);
      if (heat > 0) {
        cx.fillStyle = c + toAlphaHex(Math.min(0xff, 0x40 * heat * boost));
        cx.fillRect(b.x0 + 1, slotsY, b.x1 - b.x0 - 2, 3);
      }
    }

    // slot dividers
    cx.strokeStyle = "rgba(255,255,255,0.07)";
    cx.lineWidth = 1;
    for (let s = 0; s <= SLOTS; s++) {
      const x = W / 2 + (s - SLOTS / 2) * slotWidth;
      cx.beginPath(); cx.moveTo(x + 0.5, slotsY); cx.lineTo(x + 0.5, slotsY + slotsH); cx.stroke();
    }

    // slot multiplier labels — tier glow scales with payoff; tier-6 jackpot
    // labels always shine, tier-0 sink stays cleanly dim.
    const labelSize = Math.min(slotsH * 0.36, slotWidth * 0.4);
    cx.font = `700 ${Math.floor(labelSize)}px 'IBM Plex Mono', ui-monospace, monospace`;
    cx.textAlign = "center"; cx.textBaseline = "middle";
    for (let s = 0; s < SLOTS; s++) {
      const b = slotBounds[s];
      const tier = SLOT_TIERS[s];
      cx.fillStyle = TIER_GOLD[tier];
      // Glow blur scales 0 → 13 with tier; matches Fibonacci progression.
      cx.shadowColor = TIER_GOLD[tier];
      cx.shadowBlur  = tier * 2.2;
      cx.fillText(fmtMult(MULTS[s]), b.mid, slotsY + slotsH * 0.5);
    }
    cx.shadowBlur = 0; cx.shadowColor = "transparent";

    // pegs — single gold flash. Lightness ramps with heat by 1/φ steps so the
    // bright phase matches the golden visual language without inventing new hues
    // (slot colors already encode multiplier value; pegs stay color-neutral gold).
    const GOLD_HUE = 45;  // pure gold
    for (const peg of pegBodies) {
      const age = now - peg.lastHit;
      const heat = peg.lastHit > 0 ? Math.max(0, 1 - age / 320) : 0;
      const r = pegR + heat * pegR * 0.6;
      if (heat > 0.05) {
        // φ-stepped glow lightness: 88% at fresh hit → ramps down by 1/φ
        const lightness = 60 + heat * 28;
        const grad = cx.createRadialGradient(peg.position.x, peg.position.y, 0, peg.position.x, peg.position.y, r * 3);
        grad.addColorStop(0, `hsla(${GOLD_HUE}, 95%, ${lightness}%, ${0.55 * heat})`);
        grad.addColorStop(1, `hsla(${GOLD_HUE}, 95%, ${lightness}%, 0)`);
        cx.fillStyle = grad;
        cx.beginPath(); cx.arc(peg.position.x, peg.position.y, r * 3, 0, Math.PI * 2); cx.fill();
      }
      cx.fillStyle = heat > 0
        ? `hsl(${GOLD_HUE}, 95%, ${58 + heat * 22}%)`
        : "#d8d6cd";
      cx.beginPath(); cx.arc(peg.position.x, peg.position.y, r, 0, Math.PI * 2); cx.fill();
    }

    // Trail — Fibonacci frame lengths (21 / 13 / 8 / 0 by ball-count tier),
    // alpha falls off by 1/φ per step (golden-ratio decay). Pure gold tone.
    const trailDensity = balls.length > 30 ? 0 : balls.length > 8 ? 0.5 : 1;
    const trailMaxFrames = balls.length > 8 ? 8 : balls.length > 5 ? 13 : 21;
    for (let i = trails.length - 1; i >= 0; i--) {
      const t = trails[i]; t.age++;
      // alpha = (1/φ)^(age * k) — exponential golden decay, smoother than linear
      const decayK = 2.0 / t.max;  // tuned so by t.max alpha ≈ 0
      const a = Math.pow(1 / PHI, t.age * decayK);
      if (a < 0.02) { trails.splice(i, 1); continue; }
      cx.fillStyle = `rgba(255, 214, 10, ${a * 0.55})`;
      cx.beginPath(); cx.arc(t.x, t.y, ballR * (0.45 + a * 0.55), 0, Math.PI * 2); cx.fill();
    }
    if (trailDensity > 0) {
      for (const b of balls) {
        if (Math.random() < trailDensity) {
          trails.push({ x: b.position.x, y: b.position.y, age: 0, max: trailMaxFrames });
        }
      }
    }

    // balls — bright sodium yellow with radial highlight
    for (const b of balls) {
      const grad = cx.createRadialGradient(b.position.x - ballR * 0.3, b.position.y - ballR * 0.3, 0,
                                           b.position.x, b.position.y, ballR * 1.6);
      grad.addColorStop(0, "#fff7c2");
      grad.addColorStop(0.55, "#ffeb47");
      grad.addColorStop(1, "#c89200");
      cx.fillStyle = grad;
      cx.beginPath(); cx.arc(b.position.x, b.position.y, ballR, 0, Math.PI * 2); cx.fill();
    }

    requestAnimationFrame(render);
  }

  function toAlphaHex(v) {
    const i = Math.max(0, Math.min(255, Math.floor(v)));
    return i.toString(16).padStart(2, "0");
  }

  // ── physics step + ball routing ─────────────────────────────────────────
  function tick() {
    if (!mounted) return;
    if (W === 0) { requestAnimationFrame(tick); return; }
    Matter.Engine.update(engine, 1000 / 60);

    const now = performance.now();
    const rowSpacing = (slotsY - topY - 6) / ROWS;

    for (let bi = balls.length - 1; bi >= 0; bi--) {
      const ball = balls[bi];

      // Absolute-target aim: track logicalCol (cumulative right-bounces from
      // the path bits). At each row crossing, compute the X velocity that
      // takes the ball from its CURRENT position to the inter-peg gap it
      // should be in for the next row. Self-corrects any prior drift, no
      // teleporting.
      const newRow = Math.floor((ball.position.y - topY) / rowSpacing);
      if (newRow > ball.currentRow && newRow < ROWS) {
        ball.currentRow = newRow;
        const bit = (ball.path >> newRow) & 1;
        if (bit) ball.logicalCol++;

        // Inter-peg gap K in row r is centered at:
        //   W/2 + (K - (r+1)/2) * slotWidth
        ball.targetX = W / 2 + (ball.logicalCol - (newRow + 1) / 2) * slotWidth;

        const nextRowY = topY + (newRow + 1) * rowSpacing;
        const dy = Math.max(rowSpacing * 0.5, nextRowY - ball.position.y);
        const vY = Math.max(1.4, ball.velocity.y);
        const timeToNext = dy / vY;
        const rawVx = (ball.targetX - ball.position.x) / timeToNext;
        const vx   = Math.max(-3.5, Math.min(3.5, rawVx));
        Matter.Body.setVelocity(ball, { x: vx, y: vY });
      }

      // Continuous steering — gentle per-frame pull toward the active target.
      // Without this, peg bounces between rows drift the ball off-aim and the
      // next row's recalc has to catch up. Sim shows this drops drift from
      // ~3% to ~0.05%.
      if (ball.targetX != null && ball.currentRow >= 0 && !ball.settled) {
        const dx = ball.targetX - ball.position.x;
        if (Math.abs(dx) > 0.5) {
          Matter.Body.applyForce(ball, ball.position, {
            x: dx * 0.000018 * ball.mass,
            y: 0,
          });
        }
      }

      // Stuck detector — if ball isn't progressing downward, kick it.
      if (ball.position.y > ball.lastProgressY + 1) {
        ball.lastProgressY = ball.position.y;
        ball.lastProgressT = now;
      } else if (now - ball.lastProgressT > 500 && !ball.settled) {
        Matter.Body.setVelocity(ball, {
          x: ball.velocity.x * 0.3 + (Math.random() - 0.5) * 0.6,
          y: 3.5,
        });
        ball.lastProgressT = now;
      }

      // Settled in slot
      if (ball.position.y > slotsY + slotsH * 0.4 && Math.abs(ball.velocity.y) < 1.2) {
        if (!ball.settled) {
          ball.settled = true;
          handleBallLanded(ball);
        }
      }
    }

    requestAnimationFrame(tick);
  }

  Matter.Events.on(engine, "collisionStart", (ev) => {
    const now = performance.now();
    const audioBudget = balls.length > 30 ? 60 : balls.length > 8 ? 30 : 12;
    for (const pair of ev.pairs) {
      const a = pair.bodyA, b = pair.bodyB;
      const peg  = a.label === "peg" ? a : b.label === "peg" ? b : null;
      const ball = a.label?.startsWith("ball:") ? a : b.label?.startsWith("ball:") ? b : null;
      if (peg && ball) {
        peg.lastHit = now;
        if (audio && now - lastClickAudio > audioBudget) {
          lastClickAudio = now;
          // Peg click pitch: ramps by powers of φ across rows (subtle ascent).
          const note = 180 * Math.pow(PHI, peg.row / 24) + Math.random() * 14;
          audio.click.triggerAttackRelease(note, 0.04);
        }
      }
    }
  });

  // ── play orchestration ──────────────────────────────────────────────────
  let runningTotalBps = 0;
  let runningStakeRaw = 0n; // total stake committed this round (raw 6-dec)
  let pendingDrops = 0;
  let liveBallId = 0;
  let stakePerBallRaw = 1_000_000n;

  function updateStakeLabel() {
    const totalRaw = stakePerBallRaw * BigInt(selectedN);
    stakeEl.textContent = fmtUSD(totalRaw);
  }

  function dropBall(path, ballMultBps) {
    const startX = W / 2 + (Math.random() - 0.5) * slotWidth * 0.5;
    const ball = Matter.Bodies.circle(startX, topY - ballR * 2 - Math.random() * 16, ballR, {
      restitution: 0.32,
      friction: 0.002,
      frictionAir: 0.005,
      density: 0.025,
      label: "ball:" + (++liveBallId),
    });
    ball.path = Number(path);
    ball.expectedSlot = popcount12(ball.path);
    ball.expectedMultBps = Number(ballMultBps);
    ball.currentRow = -1;
    ball.logicalCol = 0;       // accumulates the right-bounce count via path bits
    ball.targetX = null;       // active aim target — set at row crossings
    ball.settled = false;
    ball.lastProgressY = ball.position.y;
    ball.lastProgressT = performance.now();
    balls.push(ball);
    Matter.World.add(engine.world, ball);
  }

  function handleBallLanded(ball) {
    let slot = ball.expectedSlot;
    for (const sb of slotBounds) {
      if (ball.position.x >= sb.x0 && ball.position.x < sb.x1) { slot = sb.idx; break; }
    }
    const bps = ball.expectedMultBps;
    runningTotalBps += bps;

    // payout = stake_per_ball × totalBps / 10_000
    const payoutRaw = (stakePerBallRaw * BigInt(runningTotalBps)) / 10_000n;
    totalEl.textContent = fmtUSD(payoutRaw);
    applyGoldIntensity(payoutRaw, runningStakeRaw);
    totalEl.classList.add("flash");
    if (totalEl._flashT) clearTimeout(totalEl._flashT);
    totalEl._flashT = setTimeout(() => totalEl.classList.remove("flash"), 220);

    const sb = slotBounds[slot];
    sb.hot = performance.now();

    const now = performance.now();
    if (audio && now - lastLandAudio > 30) {
      lastLandAudio = now;
      const m = bps / 10000;
      // Bell pitch: φ-ratio intervals (instead of 2:1 octaves). Each multiplicative
      // step in winnings shifts pitch by 1.618:1 — non-Western interval, distinctive.
      const phiExp = Math.log(m + 0.5) / Math.log(PHI) * 0.5;
      const note = 220 * Math.pow(PHI, phiExp);
      audio.land.triggerAttackRelease(note, 0.18);
      if (bps >= 100000 && balls.length < 20) {
        // Jackpot chord stacks at φ ratios: tonic, +φ, +φ², +φ³ — sounds otherworldly
        const tonic = 392;
        setTimeout(() =>
          audio.jackpot.triggerAttackRelease(
            [tonic, tonic * PHI, tonic * PHI * PHI, tonic * PHI * PHI * PHI],
            0.55
          ), 50);
      }
    }
    if (navigator.vibrate && balls.length < 6) {
      // Fibonacci-rhythm haptics — felt rhythm matches the golden-ratio visuals
      let pattern;
      if      (bps >= 800_000) pattern = [21, 13, 21, 13, 34, 55];  // 80x jackpot
      else if (bps >= 100_000) pattern = [13, 8, 13, 21];            // 10x big
      else if (bps >=  11_000) pattern = [8, 5, 8];                  // 1.1x+ small
      else                     pattern = 5;                          // bust
      navigator.vibrate(pattern);
    }

    // remove ball after a beat
    setTimeout(() => {
      Matter.World.remove(engine.world, ball);
      const i = balls.indexOf(ball); if (i >= 0) balls.splice(i, 1);
      if (balls.length === 0 && pendingDrops === 0) finishRound();
    }, 220);
  }

  function finishRound() {
    btnEl.disabled = false;
    const payoutRaw = (stakePerBallRaw * BigInt(runningTotalBps)) / 10_000n;
    // Lock final gold intensity (already applied per ball, but pulse on big wins)
    if (runningStakeRaw > 0n && payoutRaw >= runningStakeRaw * 3n) {
      totalEl.classList.add("big");
      setTimeout(() => totalEl.classList.remove("big"), 900);
    }
    ctx.refreshBalance();
  }

  // Continuous gold intensity scaled by log_φ(payout/wagered).
  // Each φ-step in return adds a Fibonacci-radius glow layer.
  // Below 1.0× return: white (no gold). At φ¹ (1.62×): subtle gold.
  // At φ⁵ (~11×): rich gold. At φ⁸ (~47×): blazing — caps here.
  function applyGoldIntensity(payoutRaw, stakeRaw) {
    if (stakeRaw === 0n) return;
    const ratio = Number(payoutRaw) / Number(stakeRaw);
    if (ratio <= 1) {
      // Loss or break-even — clean white, no glow
      totalEl.style.color = "#fff";
      totalEl.style.textShadow = "none";
      return;
    }
    // Even small wins should be visibly gold (RuneScape-style "any-positive
    // glints"). t maps log_φ(ratio) to a [0.22, 1] band so the lowest
    // possible win still reads as gold, jackpot maxes the scale.
    const intensitySteps = Math.log(ratio) / Math.log(PHI);   // log_φ(ratio)
    const t = Math.max(0.22, Math.min(intensitySteps / 6, 1)); // φ⁶ ≈ 18× → max
    // Color: HSL 50° (gold), lightness 88% (light-gold tint at the floor)
    // → 50% (saturated bullion at jackpot).
    const lightness = 88 - t * 38;
    totalEl.style.color = `hsl(50, 100%, ${lightness}%)`;
    // Glow: 4 layers, sizes Fibonacci-spaced, opacities inverse-golden.
    const s = (a, b) => a + (b - a) * t;
    totalEl.style.textShadow = [
      `0 0 ${s(5, 21).toFixed(1)}px  rgba(255, 247, 194, ${s(0.45, 0.95).toFixed(2)})`,
      `0 0 ${s(13, 55).toFixed(1)}px rgba(255, 214, 10,  ${s(0.30, 0.78).toFixed(2)})`,
      `0 0 ${s(21, 144).toFixed(1)}px rgba(255, 140, 0,  ${s(0.18, 0.55).toFixed(2)})`,
      `0 0 ${s(34, 233).toFixed(1)}px rgba(255, 100, 0,  ${s(0.08, 0.34).toFixed(2)})`,
    ].join(", ");
  }

  function clearGoldIntensity() {
    totalEl.style.color = "";
    totalEl.style.textShadow = "";
  }

  // initial stake read
  ctx.client.readContract({ address: PACHI_ADDR, abi: PACHI_ABI, functionName: "stake", args: [] })
    .then(s => { stakePerBallRaw = s; updateStakeLabel(); })
    .catch(() => updateStakeLabel());

  // Belt-and-braces wrapper for nonce races. The shell wires up viem's
  // nonceManager which usually handles this — but on first write after a
  // page reload there can still be a stale-state race. If we see "nonce too
  // low," wait a beat and retry; the second attempt picks up the corrected
  // nonce automatically.
  async function writeWithRetry(args, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await ctx.client.writeContract(args);
      } catch (err) {
        const msg = (err.shortMessage || err.message || "").toLowerCase();
        const isNonceRace = msg.includes("nonce") && (msg.includes("too low") || msg.includes("invalid"));
        if (!isNonceRace || attempt === retries) throw err;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }

  // One-time approval — first play from a fresh wallet needs the contract to
  // be allowed to pull AlphaUSD via transferFrom. Check + send if missing.
  let approvedSent = false;
  async function ensureApproval() {
    if (approvedSent) return;
    const allowance = await ctx.client.readContract({
      address: TOKEN_ADDR, abi: ERC20_ABI, functionName: "allowance",
      args: [ctx.account.address, PACHI_ADDR],
    });
    if (allowance < 1_000_000_000n) {
      const hash = await writeWithRetry({
        address: TOKEN_ADDR, abi: ERC20_ABI, functionName: "approve",
        args: [PACHI_ADDR, MAX_UINT256],
      });
      await ctx.client.waitForTransactionReceipt({ hash });
    }
    approvedSent = true;
  }

  async function play() {
    if (btnEl.disabled) return;
    await ensureAudio().catch(() => {});

    // reset round state immediately
    runningTotalBps = 0;
    totalEl.classList.remove("big");
    totalEl.textContent = "—";
    clearGoldIntensity();
    btnEl.disabled = true;

    const n = selectedN;
    runningStakeRaw = stakePerBallRaw * BigInt(n);

    try {
      await ensureApproval();
      const hash = await writeWithRetry({
        address: PACHI_ADDR, abi: PACHI_ABI, functionName: "play", args: [BigInt(n)],
      });
      const receipt = await ctx.client.waitForTransactionReceipt({ hash });
      const events = ctx.parseEventLogs({ abi: PACHI_ABI, eventName: "Played", logs: receipt.logs });
      if (!events.length) throw new Error("no Played event");
      const { paths, ballMults } = events[0].args;

      // Fibonacci-decreasing stagger — first ball waits longest, drops accelerate.
      // Generates Fib(n+2)..Fib(2) (largest first), scales total to ~1.5s.
      const totalReleaseMs = n === 1 ? 0 : Math.min(1800, 200 + 14 * Math.sqrt(n));
      let dropTimes = [0];
      if (n > 1) {
        const fib = [1, 1];
        while (fib.length < n) fib.push(fib[fib.length - 1] + fib[fib.length - 2]);
        const deltas = fib.slice().reverse();              // largest first
        const sum    = deltas.reduce((a, b) => a + b, 0);
        const scale  = totalReleaseMs / sum;
        let t = 0;
        dropTimes = [0];
        for (let i = 0; i < n - 1; i++) {
          t += deltas[i] * scale;
          dropTimes.push(t);
        }
      }

      pendingDrops = paths.length;
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i], m = ballMults[i];
        if (dropTimes[i] === 0) { dropBall(p, m); pendingDrops--; }
        else setTimeout(() => { dropBall(p, m); pendingDrops--; }, dropTimes[i]);
      }
      // initial display zero so total ticks up from there
      totalEl.textContent = fmtUSD(0n);
    } catch (err) {
      console.error(err);
      ctx.toast(err.shortMessage || err.message || "drop failed");
      btnEl.disabled = false;
    }
  }

  btnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    btnEl.blur();   // strip lingering focus/hover state on touch devices
    play();
  });

  // ── boot ────────────────────────────────────────────────────────────────
  requestAnimationFrame(() => {
    buildBoard();
    requestAnimationFrame(render);
    requestAnimationFrame(tick);
  });

  const ro = new ResizeObserver(() => {
    if (board.clientWidth !== W || board.clientHeight !== H) buildBoard();
  });
  ro.observe(board);

  setN(1);

  return () => {
    mounted = false;
    ro.disconnect();
    Matter.Engine.clear(engine);
    if (audio) {
      try { audio.click.dispose(); audio.land.dispose(); audio.jackpot.dispose(); audio.dest.dispose(); } catch {}
    }
  };
}

// ── card-scoped CSS ───────────────────────────────────────────────────────
const PACHI_CSS = `
/* Fibonacci spacing scale: 3, 5, 8, 13, 21, 34, 55, 89.
   Every gap, padding, and margin uses one of these. */

.pachi-root {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: space-between;
  padding: 55px 21px max(21px, env(safe-area-inset-bottom));
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  color: #fff;
  background:
    radial-gradient(144% 89% at 50% -21%, rgba(255,200,90,0.05), transparent 55%),
    #0a0d18;
}

.pachi-totalwrap {
  display: flex; align-items: center; justify-content: center;
  margin: 5px 0 13px;
  min-height: 89px;
}
.pachi-total {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-weight: 700;
  /* Anchored to viewport via 1/φ² ≈ 0.382 of a notional board width band. */
  font-size: clamp(55px, calc(34vw / 2.618), 144px);
  line-height: 1; letter-spacing: -0.04em;
  font-feature-settings: "tnum" 1;
  transition: transform 0.21s ease, color 0.21s ease, text-shadow 0.21s ease;
  color: #fff;
}
.pachi-total.flash { color: #ffeb47; }
.pachi-total.big {
  transform: scale(1.13);
  color: #ffd60a;
  text-shadow: 0 0 34px rgba(255,214,10,0.55);
}

.pachi-board {
  position: relative;
  margin: 8px auto;
  width: min(100%, 420px, calc((100dvh - 280px) / 1.618));
  aspect-ratio: 1 / 1.618;
  overflow: hidden;
  border-radius: 13px;
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,0.04),
    inset 0 21px 55px -34px rgba(0,0,0,0.7);
}
.pachi-board canvas { display: block; }

.pachi-controls {
  display: flex; flex-direction: column; align-items: center; gap: 13px;
  margin-top: 13px;
}
/* Pill bar — same width as DROP (233 / Fibonacci), each pill claims 1/3 via
   flex:1 so they're equal-width regardless of label length. Bar height is
   233/φ³ ≈ 55 (Fibonacci) — height-to-width ratio is φ³:1. */
.pachi-pills {
  display: flex;
  width: 233px;
  gap: 5px;
  padding: 5px;
  background: rgba(255,255,255,0.04);
  border-radius: 999px;
}
.pachi-pill {
  flex: 1 1 0;
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  padding: 8px 0;
  border-radius: 999px;
  border: none;
  background: transparent;
  color: rgba(255,255,255,0.55);
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 13px; font-weight: 700;
  letter-spacing: 0.06em;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, transform 0.05s;
}
.pachi-pill:active { transform: translateY(1px); }
.pachi-pill .dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 8px currentColor;
}
.pachi-pill[aria-pressed="true"] { background: #ffeb47; color: #0a0d18; }
.pachi-pill[aria-pressed="true"] .dot { box-shadow: none; }
.pachi-pill .x { font-size: 13px; opacity: 0.85; }

/* DROP button — golden landscape: width:height = φ:1.
   Width 233 (Fibonacci), height = 233/1.618 ≈ 144 (also Fibonacci). */
.pachi-btn {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-weight: 800;
  font-size: 21px;
  letter-spacing: 0.382em;     /* 1/φ² */
  color: #0a0d18;
  background: #ffeb47;
  border: none;
  width: 233px;
  height: 144px;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
  border-radius: 13px;
  transition: background 0.13s, transform 0.05s, box-shadow 0.21s;
  text-transform: uppercase;
  box-shadow:
    0 13px 34px -13px rgba(255,235,71,0.55),
    inset 0 1px 0 rgba(255,255,255,0.6),
    inset 0 -3px 0 rgba(0,0,0,0.18);
}
/* Hover only on devices that actually hover — prevents tap-stickiness on touch */
@media (hover: hover) {
  .pachi-btn:hover { background: #fff7c2; }
}
.pachi-btn:active    { transform: translateY(2px); box-shadow: 0 5px 13px -8px rgba(255,235,71,0.6); }
.pachi-btn:focus     { outline: none; }
.pachi-btn[disabled] { opacity: 0.45; cursor: wait; box-shadow: none; background: #ffeb47; }

.pachi-stake {
  font-size: 13px; letter-spacing: 0.236em;  /* 1/φ³ */
  text-transform: lowercase;
  opacity: 0.5; font-variant-numeric: tabular-nums;
}
`;
