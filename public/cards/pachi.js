// PACHI v2 — multi-ball Plinko (1 / 10 / 100)
// Self-contained card. Matter.js for physics, custom canvas2d for render,
// Tone.js for audio. Ball outcomes are deterministic from contract event paths.

import Matter from "https://esm.sh/matter-js@0.20.0";
import * as Tone from "https://esm.sh/tone@15.0.4";

// Diamond address — stable across all future facet upgrades. Don't change
// this when we modify game logic; bump appVersion (see project_pachi_versioning).
const PACHI_ADDR = "0x71e767bf661d6294c88953d640f0fc792a4c5086";
// Game stake token = PachiUSD (Phase 2). Approve goes here; gas (paid in
// AlphaUSD) is set on the chain config in shell.js, not here.
const TOKEN_ADDR = "0x576da0a989d574a3f9568007daceea919db6c53b"; // PachiUSD
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

// Integer balls only — display floor(raw / 1e6). Fractional contract
// truth (e.g. 1.2× of stake = 1.2 balls) is invisible to the player; the
// outcome reads as a clean whole number. Reconciliation against chain
// happens in shell.js via refreshBalance() at round end.
const fmtBallsBare = (raw) => (raw / 1_000_000n).toLocaleString();

// ── module ────────────────────────────────────────────────────────────────
export function mount(slot, ctx) {
  slot.innerHTML = `
    <div class="pachi-root">
      <!-- Apex ball — single large yellow gradient ball at the top of the
           pyramid. Source of every DROP ball, destination of every LAND
           ball. Scales with the wallet balance via shell.js renderBalance.
           Sits OUTSIDE the canvas (DOM element) so flux can anchor to it
           by getBoundingClientRect. -->
      <div class="pachi-apexwrap">
        <div class="pachi-apex" aria-hidden="true"></div>
      </div>
      <div class="pachi-board" id="pboard">
        <canvas id="pcanvas"></canvas>
      </div>
      <div class="pachi-totalwrap" id="ptotalwrap" aria-hidden="true">
        <div class="pachi-total shown" id="ptotal">0</div>
      </div>
      <div class="pachi-controls">
        <div class="pachi-pills" role="radiogroup">
          <button class="pachi-pill" data-n="1"   aria-pressed="true">
            <span class="ball-glyph">●</span><span class="x">×1</span>
          </button>
          <button class="pachi-pill" data-n="10"  aria-pressed="false">
            <span class="ball-glyph">●</span><span class="x">×10</span>
          </button>
          <button class="pachi-pill" data-n="100" aria-pressed="false">
            <span class="ball-glyph">●</span><span class="x">×100</span>
          </button>
        </div>
        <button class="pachi-btn" id="pbtn">DROP</button>
      </div>
    </div>
  `;
  const style = document.createElement("style");
  style.textContent = PACHI_CSS;
  slot.appendChild(style);

  const canvas    = slot.querySelector("#pcanvas");
  const btnEl     = slot.querySelector("#pbtn");
  const totalEl   = slot.querySelector("#ptotal");
  const totalWrap = slot.querySelector("#ptotalwrap");
  const board     = slot.querySelector("#pboard");
  const pills     = [...slot.querySelectorAll(".pachi-pill")];
  const cx        = canvas.getContext("2d");

  // Portal the digit out of the stage and onto body. The flux overlay
  // is a fixed-position canvas at z-index:300 attached to body — anything
  // inside the stage (z:0 in body's stacking context) is stuck below it.
  // Portaling the digit gives it z-index:400 in body's context so flux
  // balls that pile in the catch tray render UNDER the running total
  // instead of obscuring it.
  document.body.appendChild(totalEl);
  totalEl.classList.add("pachi-total-overlay");
  function positionTotalDigit() {
    if (!totalWrap || !totalEl) return;
    const r = totalWrap.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    totalEl.style.left = (r.left + r.width / 2) + "px";
    totalEl.style.top  = (r.top  + r.height / 2) + "px";
  }
  // Reposition on layout shifts (resize / scroll / orientation).
  const totalRO = new ResizeObserver(positionTotalDigit);
  totalRO.observe(totalWrap);
  window.addEventListener("resize", positionTotalDigit, { passive: true });
  window.addEventListener("scroll", positionTotalDigit, { passive: true });

  // ── ball-count selector ─────────────────────────────────────────────────
  let selectedN = 1;
  function setN(n) {
    selectedN = n;
    pills.forEach(p => p.setAttribute("aria-pressed", String(Number(p.dataset.n) === n)));
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
  let rowSpacing = 0;
  let pegBodies = [];
  let slotBounds = [];
  // Decorative-only pegs above the physics top row — visual row of 2.
  // Drawn during render() but never collide (no Matter body). Makes the
  // pyramid read 1 (apex ball) → 2 → 3 → 4 → ... continuously instead of
  // jumping 1 → 3 with no row of 2.
  let visualPegs = [];

  function buildBoard() {
    Matter.World.clear(engine.world, false);
    pegBodies = [];
    slotBounds = [];

    dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = board.clientWidth;
    if (cssW < 8) return;

    // Width is the only externally-driven dimension. Heights are derived
    // from the natural pyramid layout (slotWidth × row count + slot row),
    // then applied back to the board element so the canvas has zero dead
    // space below the slots. Earlier the board used a fixed aspect-ratio
    // which left ~80px of empty canvas under the slot row on phones,
    // pushing the catch tray and controls into a "weird gap" zone.
    W = cssW;

    const usableW = W - 24;
    slotWidth = usableW / SLOTS;
    pegR  = Math.max(2.5, slotWidth * 0.13);
    ballR = Math.max(4, pegR * PHI);  // golden ratio: ball is φ× the peg radius
    slotsH = Math.max(36, slotWidth * PHI);
    topY = 55;  // ≈ 2 × ballR + Fibonacci jitter band, well below canvas top
    // rowSpacing is purely a function of slotWidth — no clientHeight
    // dependency. The pyramid grows with the board; we size the canvas
    // to fit, not the other way around.
    rowSpacing = Math.max(slotWidth * 0.78, slotWidth * 0.82);
    slotsY = topY + ROWS * rowSpacing + 6;
    // Natural canvas height = everything in one column with no slack.
    H = slotsY + slotsH;
    board.style.height = H + "px";
    canvas.width  = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width  = W + "px";
    canvas.style.height = H + "px";
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Canvas height change shifts the catch tray vertically — reposition
    // the portaled digit to track. ResizeObserver only fires on size
    // changes (catch tray height stays 89), so this explicit call is
    // needed when *position* changes due to upstream layout shifts.
    positionTotalDigit();

    // Visual-only 2-peg row above the physics top row. Same color as
    // physics pegs at rest, slightly smaller so they read as part of the
    // apex's "shadow" rather than competing with the live game pegs.
    visualPegs = [
      { x: W / 2 - slotWidth / 2, y: topY - rowSpacing },
      { x: W / 2 + slotWidth / 2, y: topY - rowSpacing },
    ];

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
    if (audio) {
      // Mobile sleep / tab background suspends the AudioContext. Resume so
      // sound returns when the user comes back. Without this, audio is silent
      // forever after the first sleep cycle.
      if (Tone.context && Tone.context.state === "suspended") {
        try { await Tone.context.resume(); } catch {}
      }
      return audio;
    }
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
    // Absorb chime — the soft bell that plays each time a ball returns to
    // the apex (wallet). Sine wave + light reverb for a clean, ringing
    // tone. Pitches are a φ-tuned arpeggio rooted on G3 (G major):
    // G3, B3, D4, G4, with each step a φ-rotated index so successive
    // arrivals don't repeat the same note.
    const absorbReverb = new Tone.Reverb({ decay: 1.6, wet: 0.34 }).connect(dest);
    const absorb = new Tone.Synth({
      oscillator: { type: "sine" },
      envelope: { attack: 0.005, decay: 0.55, sustain: 0.05, release: 0.55 },
      volume: -16,
    }).connect(absorbReverb);
    audio = { dest, click, land, jackpot, absorb, absorbReverb };
    return audio;
  }

  // φ-rotated arpeggio over G major triad (G3 B3 D4 G4). Each call advances
  // the index by 5 (≈φ × 3 mod 4 sequence) so consecutive notes don't
  // repeat. Rooted in G major because the user explicitly asked for it.
  const ABSORB_NOTES = [196, 247, 294, 392, 494];   // G3 B3 D4 G4 B4
  let absorbIdx = 0;
  function playAbsorb() {
    if (!audio || !audio.absorb) return;
    const note = ABSORB_NOTES[absorbIdx % ABSORB_NOTES.length];
    absorbIdx = (absorbIdx + 3) % ABSORB_NOTES.length;   // φ-stride pattern
    try { audio.absorb.triggerAttackRelease(note, 0.34); } catch {}
  }

  // ── render ──────────────────────────────────────────────────────────────
  const trails = [];
  const balls = [];
  const slotFlashes = []; // {slotIdx, t}
  let mounted = true;

  // rAF queue guards. Memory note (project_pachi_round_watchdog_pattern):
  // rAF doesn't reliably resume on FC mini-app / mobile Safari after a
  // backgrounding event. We need to re-kick on visibilitychange — but
  // doing so naively can produce two parallel chains. These flags
  // ensure exactly one render+tick pass is scheduled at any time.
  let renderQueued = false;
  let tickQueued   = false;
  function scheduleRender() {
    if (renderQueued || !mounted) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
  function scheduleTick() {
    if (tickQueued || !mounted) return;
    tickQueued = true;
    requestAnimationFrame(() => { tickQueued = false; tick(); });
  }

  function render() {
    if (!mounted) return;
    if (W === 0) buildBoard();

    // bg — flat black to match the page; pyramid reads as part of the
    // page surface, not a separate panel.
    cx.fillStyle = "#000";
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

    // No slot dividers, no labels — color tier alone defines the slot's
    // value. The bg fill alpha + always-on shimmer (tier 5+) + hot tint
    // on impact carry the semantics. Numbers were noisy and the vertical
    // dividers competed with the slot fills.

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

    // Visual-only top row of 2 pegs — completes the apex→2→3→4→… pyramid.
    // Same color and radius as physics pegs at rest so all pegs read as
    // one continuous lattice. (No collision body — physics balls fall
    // through these, but visually they belong to the same peg field.)
    cx.fillStyle = "#d8d6cd";
    for (const vp of visualPegs) {
      cx.beginPath(); cx.arc(vp.x, vp.y, pegR, 0, Math.PI * 2); cx.fill();
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
      // Hard cap so the array can't grow unbounded if decay falls behind.
      if (trails.length > 144) trails.splice(0, trails.length - 144);
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

    scheduleRender();
  }

  function toAlphaHex(v) {
    const i = Math.max(0, Math.min(255, Math.floor(v)));
    return i.toString(16).padStart(2, "0");
  }

  // ── physics step + ball routing ─────────────────────────────────────────
  function tick() {
    if (!mounted) return;
    if (W === 0) { scheduleTick(); return; }
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

    scheduleTick();
  }

  Matter.Events.on(engine, "collisionStart", (ev) => {
    const now = performance.now();
    // Throttle ranges chosen so audio voices never stack: 12ms (was) was
    // 83 triggers/sec — too many for end-of-round Tone.js voices.
    const audioBudget = balls.length > 30 ? 80 : balls.length > 8 ? 40 : 25;
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

  // Physics ball spawn coords — fixed (no jitter), positioned ABOVE the
   // visual 2-peg row so the ball visibly drops past those decorative
   // pegs into the live physics field. Computed dynamically because
   // rowSpacing changes with board size. spawnAnchor() returns the same
   // viewport coord so the flux ball flying from the apex hands off
   // seamlessly to the physics body — same pixel, one continuous ball.
  function spawnYCanvas() {
    return topY - rowSpacing - ballR * 2;
  }
  function dropBall(path, ballMultBps) {
    const startX = W / 2;
    // Per-ball physics jitter — tiny variation so each ball feels
    // physically distinct (user feedback: balls felt too uniform). The
    // continuous-steering aim formula compensates so the contract-
    // determined slot is still hit. Range is intentionally small —
    // larger spreads outpaced the steering correction in the bottom rows.
    const elasticity = 0.27 + Math.random() * 0.10;   // 0.27 – 0.37
    const air        = 0.0042 + Math.random() * 0.0016; // 0.0042 – 0.0058
    const dens       = 0.0225 + Math.random() * 0.005;  // 0.0225 – 0.0275
    const ball = Matter.Bodies.circle(startX, spawnYCanvas(), ballR, {
      restitution: elasticity,
      friction: 0.002,
      frictionAir: air,
      density: dens,
      // Negative group = no collision with other negative-group bodies.
      // Balls pass through each other — Plinko has no inter-ball mechanic
      // and clustering in slots was tanking framerate at end-of-round.
      collisionFilter: { group: -1 },
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
    // Contract truth is law. If physics drift carried the ball into a
    // neighbouring slot, snap it onto the contract-determined slot before
    // any visual feedback fires. Otherwise an 85× slot can light up while
    // the contract pays the 0.1× sink, which reads as cheating.
    // Velocity zeroed so the ball visibly STOPS in the slot before the
    // multiplier flux balls drop down — sells the "absorbed by the slot"
    // feeling per user feedback.
    const slot = ball.expectedSlot;
    const sb = slotBounds[slot];
    if (sb) {
      Matter.Body.setPosition(ball, { x: sb.mid, y: ball.position.y });
      Matter.Body.setVelocity(ball, { x: 0, y: 0 });
    }
    const bps = ball.expectedMultBps;
    runningTotalBps += bps;

    // payout = stake_per_ball × totalBps / 10_000
    const payoutRaw = (stakePerBallRaw * BigInt(runningTotalBps)) / 10_000n;
    totalEl.textContent = fmtBallsBare(payoutRaw);
    totalEl.classList.add("shown");
    applyGoldIntensity(payoutRaw, runningStakeRaw);
    totalEl.classList.add("flash");
    if (totalEl._flashT) clearTimeout(totalEl._flashT);
    totalEl._flashT = setTimeout(() => totalEl.classList.remove("flash"), 220);

    if (sb) sb.hot = performance.now();

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

    // Multiply at slot — emit M flux balls from the slot's center, each
    // flying slot → catch box → apex. M tracks the contract's INTEGER
    // ball return (floor of stake × multiplier). When the slot is the
    // sink (0.1086×) or 0.5× and stake = 1 ball, M = 0 and NO flux
    // balls emit — the user sees the catch tray stay at 0 instead of a
    // false-positive ball flying back to the wallet. Dust still
    // reconciles via refreshBalance() at finishRound.
    const stakeRaw   = stakePerBallRaw > 0n ? stakePerBallRaw : 1_000_000n;
    const totalRaw   = (stakeRaw * BigInt(bps)) / 10_000n;
    const totalBalls = Number(totalRaw / 1_000_000n);   // floor — what the player sees
    const PER_LANDING_MAX = 8;
    const multCount  = Math.min(PER_LANDING_MAX, totalBalls);
    const perRaw     = multCount > 0 ? totalRaw / BigInt(multCount) : 0n;
    const residual   = totalRaw - perRaw * BigInt(multCount);
    if (multCount > 0) emitBallsFromSlot(sb, multCount, perRaw, residual);

    // Remove the physics ball quickly — it's done its job, the multiplier
    // flux balls take over from here. 90ms is short enough that the
    // matter ball vanishes just as the first dropped multiplier ball
    // appears, so the visual handoff reads as the matter ball "becoming"
    // the multiplied set.
    setTimeout(() => {
      Matter.World.remove(engine.world, ball);
      const i = balls.indexOf(ball); if (i >= 0) balls.splice(i, 1);
      maybeFinishRound();
    }, 90);
  }

  // Continuous slot → catch → apex flow. Each emitted ball flies a short
  // hop down into the catch box, holds briefly so the user can see balls
  // accumulating, then rises to the apex (which is the wallet). The apex
  // receives optimisticAdd per arrival so the wallet balance ticks live.
  // Round bookkeeping: we count emits and arrivals; when both physics and
  // flux drains hit zero, the round is officially over.
  let roundFluxRemaining = 0;
  function emitBallsFromSlot(sb, count, perRaw, residual) {
    if (count <= 0) return;
    const board_r = board.getBoundingClientRect();
    const slotMidX = board_r.left + sb.mid;
    const slotMidY = board_r.top  + slotsY + slotsH * 0.5;
    const catch_el = slot.querySelector("#ptotalwrap");
    if (!catch_el || !ctx.flux) return;
    const catch_r = catch_el.getBoundingClientRect();
    // Catch X = the SLOT'S column directly below. Balls from slot k pool
    // under slot k. No B-lining to the catch's horizontal center —
    // earlier code converged every emission on catchCx which made the
    // tray look like it had ~3 fixed positions instead of accumulating
    // naturally based on which slots fired. With per-slot drop columns
    // a 100-ball jackpot round visibly piles balls on the EDGES (where
    // 85× lives) and a sink-heavy round piles them in the MIDDLE.
    const columnX = slotMidX;
    // Catch Y near the bottom 70% — pool low like real plinko bins,
    // leave the upper third for the digit readout to breathe.
    const catchCy = catch_r.top + catch_r.height * 0.7;

    const DROP_DURATION   = 420;
    const PER_BALL_LAUNCH = 60;
    const COLLECTIVE_HOLD = 520;
    const lastDropArrives = (count - 1) * PER_BALL_LAUNCH + DROP_DURATION;
    const upLaunchAt      = lastDropArrives + COLLECTIVE_HOLD;

    for (let i = 0; i < count; i++) {
      roundFluxRemaining++;
      // Tiny jitter within the slot's own column — ±35% of slotWidth so
      // siblings don't stack on one pixel but still read as "from this
      // slot" (not migrating across the tray).
      const jitterX = (Math.random() - 0.5) * slotWidth * 0.7;
      // Stack each successive ball slightly higher so they accumulate
      // visibly instead of all overlapping. Capped at 21px so the pile
      // doesn't climb into the digit area on big emissions.
      const stackY  = -Math.min(21, i * 3);
      const catchX  = columnX + jitterX;
      const catchY  = catchCy + stackY + (Math.random() - 0.5) * 4;
      const dropAt  = i * PER_BALL_LAUNCH;
      const myDropArrival = dropAt + DROP_DURATION;
      const myHoldDuration = Math.max(60, upLaunchAt - myDropArrival);

      setTimeout(() => {
        // Stage 1: gravity drop slot → catch column. ease:"in"
        // accelerates so the ball reads as falling under gravity (slow
        // start, fast end) rather than the soft-landing easeOutCubic
        // that arc:0 used to inherit by default.
        ctx.flux.flyBall({
          fromX: slotMidX, fromY: slotMidY,
          toX:   catchX,   toY:   catchY,
          duration: DROP_DURATION,
          arc: 0,
          ease: "in",
          radius: Math.max(8, ballR),
          onArrive: () => {
            // Stage 2: static hold (linear ease, zero motion).
            ctx.flux.flyBall({
              fromX: catchX, fromY: catchY,
              toX:   catchX, toY:   catchY,
              duration: myHoldDuration,
              arc: 0,
              ease: "linear",
              radius: Math.max(8, ballR),
              onArrive: () => {
                // Stage 3: collective rise to wallet apex.
                const wallet = ctx.walletAnchor && ctx.walletAnchor();
                if (!wallet) {
                  roundFluxRemaining = Math.max(0, roundFluxRemaining - 1);
                  maybeFinishRound();
                  return;
                }
                const dy = wallet.y - catchY;
                ctx.flux.flyBall({
                  fromX: catchX, fromY: catchY,
                  toX: wallet.x, toY: wallet.y,
                  duration: 720 + Math.random() * 120,
                  arc: -Math.abs(dy) * 0.42,
                  radius: Math.max(8, ballR),
                  onArrive: () => {
                    if (ctx.optimisticAdd) {
                      const tip = (i === count - 1) ? residual : 0n;
                      ctx.optimisticAdd(perRaw + tip);
                    }
                    if (ctx.pulseWallet) ctx.pulseWallet();
                    playAbsorb();
                    roundFluxRemaining = Math.max(0, roundFluxRemaining - 1);
                    maybeFinishRound();
                  },
                });
              },
            });
          },
        });
      }, dropAt);
    }
  }

  let roundActive = false;
  // Hard mutex against re-entry. Belt to the disabled-attribute braces:
  // even if a click slips through during the synchronous window before
  // btnEl.disabled is set, or while the error path is awaiting
  // refreshBalance, this flag blocks a second optimisticDeduct from
  // firing. Cleared inside finishRound() and forceResetRound().
  let playInFlight = false;
  // Watchdog — if a round somehow stays "active" for too long without
  // hitting maybeFinishRound (rAF stalled while tab was hidden, an
  // onArrive callback got dropped, anything weird), force-reset so the
  // user isn't stuck with a permanently disabled DROP button. Long
  // enough that a normal n=100 round (~12s) always completes naturally;
  // short enough that the user doesn't have to wait for the universe.
  const ROUND_WATCHDOG_MS = 90_000;
  let roundWatchdogT = null;
  function armRoundWatchdog() {
    if (roundWatchdogT) clearTimeout(roundWatchdogT);
    roundWatchdogT = setTimeout(() => {
      roundWatchdogT = null;
      if (!roundActive) return;
      forceResetRound("watchdog: round stalled past 90s");
      if (ctx.refreshBalance) ctx.refreshBalance();
    }, ROUND_WATCHDOG_MS);
  }
  function disarmRoundWatchdog() {
    if (roundWatchdogT) { clearTimeout(roundWatchdogT); roundWatchdogT = null; }
  }

  function maybeFinishRound() {
    if (!roundActive) return;
    if (balls.length > 0) return;
    if (pendingDrops > 0) return;
    if (roundFluxRemaining > 0) return;
    finishRound();
  }

  function finishRound() {
    if (!roundActive) return;
    roundActive = false;
    disarmRoundWatchdog();
    const payoutRaw = (stakePerBallRaw * BigInt(runningTotalBps)) / 10_000n;
    if (runningStakeRaw > 0n && payoutRaw >= runningStakeRaw * 3n) {
      totalEl.classList.add("big");
      setTimeout(() => totalEl.classList.remove("big"), 900);
    }
    playInFlight = false;
    btnEl.disabled = false;
    if (ctx.refreshBalance) ctx.refreshBalance();
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

  // initial stake read — needed for client-side payout math (totalBps × stake / 10_000)
  ctx.client.readContract({ address: PACHI_ADDR, abi: PACHI_ABI, functionName: "stake", args: [] })
    .then(s => { stakePerBallRaw = s; })
    .catch(() => {});

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
        // Only retry the narrow "nonce too low" stale-state race — NOT the
        // "expiring nonce must == 0" / "invalid parameters" errors, which
        // are config bugs and won't recover with a retry loop.
        const isNonceRace = msg.includes("nonce too low");
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

  // Wrap a promise so it can never hang the UI longer than `ms`. If a tx
  // is sent but the receipt request stalls (typical after mobile sleep
  // suspends the network), this surfaces a clean error instead of leaving
  // btnEl.disabled forever.
  function withTimeout(p, ms, label) {
    return Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + " timed out — try again")), ms)),
    ]);
  }

  // Spawn-point anchor in viewport coords — MUST equal where dropBall()
   // places the Matter body so the apex→spawn flux ball seamlessly
   // becomes the falling physics ball.
  function spawnAnchor() {
    const r = board.getBoundingClientRect();
    return { x: r.left + W / 2, y: r.top + spawnYCanvas() };
  }
  // Outcome anchor — under the pyramid where the running-total digits sit.
  // LAND animation flies balls from here up to the wallet glyph.
  function outcomeAnchor() {
    const tw = slot.querySelector("#ptotalwrap");
    const r = (tw || totalEl).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  async function play() {
    // Hard mutex first — disabled attribute alone has been racing on
    // mobile (rapid taps double-deducted then only the last tx settled).
    if (playInFlight || btnEl.disabled) return;
    playInFlight = true;

    // Disable + arm the watchdog FIRST. Anything that hangs after this
    // (RPC, version-check, ensureApproval) gets bailed out by the
    // 90s watchdog instead of leaving the button stuck forever.
    btnEl.disabled = true;
    roundActive = true;
    armRoundWatchdog();

    // Pre-flight version check — wrap in a timeout so a stalled RPC
    // can't hang play() before we even start. Failure is non-fatal:
    // if checkVersion throws/times out, treat as match and proceed.
    try {
      if (ctx.checkVersion) {
        const ok = await withTimeout(ctx.checkVersion(), 8_000, "version check");
        if (!ok) {
          forceResetRound("version mismatch — refresh modal shown");
          disarmRoundWatchdog();
          return;
        }
      }
    } catch (err) {
      console.warn("version check timed out — proceeding optimistically:", err);
    }
    // Audio is best-effort. Cap at 2s so a hung AudioContext.resume() (seen
    // on iOS Safari after long backgrounding) doesn't block the round.
    try { await withTimeout(ensureAudio(), 2_000, "audio init"); }
    catch (err) { console.warn("ensureAudio skipped:", err); }

    // reset round state immediately
    runningTotalBps = 0;
    totalEl.classList.remove("big", "flash");
    totalEl.classList.add("shown");
    totalEl.textContent = "0";              // placeholder reserves spacing
    clearGoldIntensity();
    roundFluxRemaining = 0;

    const n = selectedN;
    runningStakeRaw = stakePerBallRaw * BigInt(n);

    try {
      await withTimeout(ensureApproval(), 45_000, "approve");

      // Pre-flight simulate — catches BankrollTooLow / BallsOutOfRange /
      // insufficient-balance reverts BEFORE we deduct optimistically and
      // burn nonces on a tx that just reverts. simulateContract runs the
      // call as eth_call which throws with the contract's custom error
      // name in shortMessage. Cheap (one RPC), high payoff (clean error
      // messages instead of generic "transaction reverted on chain").
      await withTimeout(
        ctx.client.simulateContract({
          address: PACHI_ADDR, abi: PACHI_ABI, functionName: "play",
          args: [BigInt(n)], account: ctx.account,
        }),
        8_000, "simulate"
      );

      // Simulate passed → safe to deduct. Only debit the displayed
      // balance once we know the tx will land; before this point a
      // reverted DROP would falsely tick the wallet down.
      if (ctx.optimisticDeduct) ctx.optimisticDeduct(runningStakeRaw);

      const hash = await withTimeout(
        writeWithRetry({
          address: PACHI_ADDR, abi: PACHI_ABI, functionName: "play", args: [BigInt(n)],
        }),
        45_000, "tx submit"
      );
      const receipt = await withTimeout(
        ctx.client.waitForTransactionReceipt({ hash }),
        60_000, "receipt"
      );
      // Explicit revert check — tx may "succeed" at the RPC level but
      // revert in execution (e.g., insufficient PachiUSD). receipt.status
      // is "success" or "reverted". Better error than "no Played event".
      if (receipt.status && receipt.status !== "success") {
        throw new Error("transaction reverted on chain");
      }
      const events = ctx.parseEventLogs({ abi: PACHI_ABI, eventName: "Played", logs: receipt.logs });
      if (!events.length) throw new Error("no Played event");
      const { paths, ballMults } = events[0].args;

      // Steady stream — even per-ball cadence, NOT a Fibonacci-compressed
      // bolus. Earlier the 100-ball drop launched all 100 within ~340ms
      // which read as a single clump leaving the apex; the user explicitly
      // wanted a continuous stream. A constant 34ms cadence (Fibonacci) ×
      // n gives n=10→340ms, n=100→3.4s — visibly drip-fed regardless of
      // size, and the apex ball stays the focal point of the stream.
      const PER_BALL_MS = 34;
      const launchTimes = [];
      for (let i = 0; i < n; i++) launchTimes.push(i * PER_BALL_MS);

      // Don't pre-set the outcome to 0 — let it stay blank until the first
      // physics ball actually lands. handleBallLanded then writes the
      // running payout, so the user sees the number CHANGE in sync with
      // a ball reaching a slot rather than "0" hovering in dead air during
      // the flux flight + cascade.

      const wallet = ctx.walletAnchor && ctx.walletAnchor();
      const spawn  = spawnAnchor();
      const flightMs = 540;   // shorter than 600 — feels snappy on small n

      pendingDrops = paths.length;
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i], m = ballMults[i];
        const launchAt = launchTimes[i];

        const launch = () => {
          // If wallet anchor isn't available (rare; e.g. zero-height
          // chrome before fonts load), skip flux and drop the ball
          // directly so play never hangs.
          if (!wallet || !ctx.flux) {
            dropBall(p, m);
            pendingDrops--;
            return;
          }
          // Slight per-ball jitter in flight time so 100-ball drops don't
          // arrive in a single frame (which would defeat the cascade feel).
          const dur = flightMs + Math.random() * 80 - 40;
          ctx.flux.flyBall({
            fromX: wallet.x, fromY: wallet.y,
            toX:   spawn.x,  toY:   spawn.y,
            duration: dur,
            radius: Math.max(8, ballR),       // matches game ball radius
            onArrive: () => {
              dropBall(p, m);
              pendingDrops--;
            },
          });
        };
        if (launchAt === 0) launch();
        else setTimeout(launch, launchAt);
      }
    } catch (err) {
      // Build a rich, copyable diagnostic blob. Stuffs every field viem
      // surfaces (shortMessage / metaMessages / details / cause chain)
      // plus stack into a single text payload the user can paste back
      // for triage. The toast displays a one-liner; the [copy] button
      // hands over the full blob.
      const collectCause = (e, depth = 0) => {
        if (!e || depth > 4) return [];
        const block = [
          `--- cause ${depth} ---`,
          `name:         ${e.name || "(none)"}`,
          `shortMessage: ${e.shortMessage || "(none)"}`,
          `message:      ${e.message || "(none)"}`,
          `details:      ${e.details || "(none)"}`,
          `metaMessages: ${(e.metaMessages || []).join(" | ") || "(none)"}`,
          `data:         ${e.data ? JSON.stringify(e.data) : "(none)"}`,
        ];
        return [...block, ...collectCause(e.cause, depth + 1)];
      };
      const blob = [
        `=== PACHI tx error ===`,
        `time:    ${new Date().toISOString()}`,
        `wallet:  ${ctx.account.address}`,
        `n:       ${selectedN}`,
        `stake:   ${stakePerBallRaw}`,
        ``,
        ...collectCause(err),
        ``,
        `--- stack ---`,
        err.stack || "(no stack)",
      ].join("\n");
      // Console marker the user can grep in DevTools (and that I can
      // ask them to look for): PACHI_ERROR>>>
      console.error("PACHI_ERROR>>>\n" + blob + "\n<<<PACHI_ERROR");

      // Player-facing one-liner. We scan the full blob (not just
      // shortMessage) because the actual revert reason is often nested
      // inside cause chains.
      let userMsg;
      if (/BankrollTooLow/i.test(blob)) {
        userMsg = "bankroll too low — house can't cover max payout";
      } else if (/BallsOutOfRange/i.test(blob)) {
        userMsg = "ball count must be 1–100";
      } else if (/transferFrom|insufficient (balance|allowance)|ERC20InsufficientBalance/i.test(blob)) {
        userMsg = "not enough PachiUSD for this stake";
      } else if (/expiring nonce/i.test(blob)) {
        userMsg = "tempo nonce error (config bug — copy details)";
      } else if (/timed out/i.test(blob)) {
        userMsg = "rpc timed out — try again";
      } else if (/revert/i.test(blob)) {
        userMsg = "tx reverted — copy details to debug";
      } else {
        userMsg = (err.shortMessage || err.message || "drop failed").slice(0, 80);
      }
      ctx.toast(userMsg, 0, { severity: "error", copyText: blob });
      // Reverse the optimistic deduction by re-syncing with chain truth.
      // AWAIT this so playInFlight stays held until the displayed balance
      // is back in sync — otherwise a rapid second click after an error
      // double-deducts in the UI before chain truth lands.
      if (ctx.refreshBalance) {
        try { await ctx.refreshBalance(); } catch {}
      }
      forceResetRound("play() error");
      disarmRoundWatchdog();
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
    scheduleRender();
    scheduleTick();
    positionTotalDigit();
  });

  const ro = new ResizeObserver(() => {
    if (board.clientWidth !== W || board.clientHeight !== H) buildBoard();
  });
  ro.observe(board);

  // Tab-resume recovery. The previous version only re-enabled the button
  // when there were no physics balls AND no pending drops — but flux
  // balls held in their slot→catch→apex flight would leave roundFluxRemaining
  // > 0 forever (rAF doesn't reliably resume in some mobile / Farcaster
  // mini-app contexts). Now: resume audio, FLUSH any in-flight flux
  // balls, fully reset round counters, and re-enable the button.
  // Side effect: a tab switch mid-round drops the LAND animation. Worth
  // it — the alternative is a frozen game.
  function forceResetRound(reason) {
    try { ctx.flux?.clearBalls?.(); } catch {}
    pendingDrops = 0;
    roundFluxRemaining = 0;
    roundActive = false;
    playInFlight = false;
    if (btnEl) btnEl.disabled = false;
    if (reason) console.warn("forceResetRound:", reason);
  }
  function onVisibilityChange() {
    if (document.visibilityState !== "visible") return;
    if (Tone.context && Tone.context.state === "suspended") {
      Tone.context.resume().catch(() => {});
    }
    // Mobile / Farcaster mini-app: backgrounding can clear the canvas
    // backing store AND fail to auto-resume rAF. Rebuild + re-kick the
    // loops; the renderQueued/tickQueued flags ensure we don't end up
    // with two parallel chains if rAF did resume on its own.
    buildBoard();
    scheduleRender();
    scheduleTick();
    // If physics balls are ACTUALLY mid-fall, leave them alone — the user
    // backgrounded for a fraction of a second and Matter.js can resume.
    // Otherwise, stale state is the more common failure: flush + reset.
    if (balls.length === 0) {
      forceResetRound("visibility-resume");
    }
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  setN(1);

  return () => {
    mounted = false;
    ro.disconnect();
    totalRO.disconnect();
    window.removeEventListener("resize", positionTotalDigit);
    window.removeEventListener("scroll", positionTotalDigit);
    if (totalEl && totalEl.parentNode === document.body) {
      document.body.removeChild(totalEl);
    }
    document.removeEventListener("visibilitychange", onVisibilityChange);
    Matter.Engine.clear(engine);
    if (audio) {
      try {
        audio.click.dispose();
        audio.land.dispose();
        audio.jackpot.dispose();
        audio.absorb?.dispose();
        audio.absorbReverb?.dispose();
        audio.dest.dispose();
      } catch {}
    }
  };
}

// ── card-scoped CSS ───────────────────────────────────────────────────────
const PACHI_CSS = `
/* Fibonacci spacing scale: 3, 5, 8, 13, 21, 34, 55, 89.
   Every gap, padding, and margin uses one of these. */

/* Vertical stack (top → bottom):
     [apex ball]                   ← single large yellow gradient ball,
                                     wallet-balance-scaled. Origin/return
                                     point for every ball.
     [pyramid board]               ← wider than tall (aspect 1.236:1)
     [catch box]                   ← gold-bordered, holds the outcome digits
     [pills]                       ← ball-count selector
     [DROP]                        ← primary CTA
   The header just holds the wallet number — no glyph, no ●. The visual
   ball IS the apex. Spacing around the apex (-13px margin so it nests
   into the top of the pyramid) keeps the column tight. */
.pachi-root {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center;
  /* Center the whole stack so leftover viewport space distributes evenly
     above the apex and below the DROP. On tall phones this kills the
     "tons of space below the catch" gap that flex-start + margin-top:auto
     was producing. Side gutters match chrome's 21px (PACHI / cog align). */
  justify-content: center;
  padding: 55px 21px 21px;
  gap: 0;     /* pyramid + slot row + catch flow as one column */
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  color: #fff;
  background: #000;
}

/* Apex ball wrap — capped tighter (max 55px diameter) so the ball doesn't
   crowd the wallet digit above it. The ball uses the universal yellow
   radial gradient (matches in-game balls). Bottom margin is negative so
   the ball visually nests into the top of the pyramid. */
.pachi-apexwrap {
  width: 100%;
  height: 55px;
  display: flex; align-items: center; justify-content: center;
  margin-bottom: -8px;
  z-index: 6;
  position: relative;
}
.pachi-apex {
  width: 26px; height: 26px;        /* JS overrides via setDisplayedRaw */
  border-radius: 50%;
  background: radial-gradient(circle at 32% 32%, #fff7c2 0%, #ffeb47 55%, #c89200 100%);
  /* Same Fibonacci-radius glow stack as the wordmark + flux balls — the
     apex IS the wallet, so it carries the brand's gold language. */
  box-shadow:
    0 0 8px  rgba(255, 246, 200, 0.62),
    0 0 21px rgba(255, 214, 10,  0.38),
    0 0 55px rgba(255, 140, 0,   0.24),
    0 0 89px rgba(255, 100, 0,   0.15);
  transition: width 0.34s ease, height 0.34s ease, transform 0.18s cubic-bezier(.4, 0, .2, 1.4);
  will-change: transform, width, height;
}
/* Subtle pulse on ball arrival — the absorb chime carries the feedback,
   the visual is a barely-there wobble (~6% scale) rather than a hop. */
.pachi-apex.pulse { transform: scale(1.06); }

.pachi-board {
  position: relative;
  margin: 0 auto;
  /* Width-driven, height computed in JS (buildBoard sets style.height to
     the natural pyramid height = topY + ROWS×rowSpacing + slotsH).
     No aspect-ratio constraint → no dead space below the slot row.
     Container width capped at 610 on tablet/desktop. */
  width: min(100%, 610px);
  overflow: visible;     /* pegs/balls can breathe past the edge */
}
.pachi-board canvas { display: block; }

/* Catch tray — fully transparent, no border, no gradient. Flat black
   page bg shows through. The digit hovers over whatever flux balls are
   piling in the tray. (User: no decorative gradients in the design
   system — the catch is just the visible bottom-of-stack space where
   balls accumulate before lifting to the apex.) */
.pachi-totalwrap {
  position: relative;
  width: min(100%, 610px);
  height: 89px;
  display: flex; align-items: center; justify-content: center;
  background: transparent;
  /* Digit needs to sit ABOVE the flux overlay (which is z-index:300
     on document.body so flux balls render OVER chrome). Anything we
     put above 300 here will rise above the flux canvas as long as we
     also create a stacking context (transform/opacity does it
     implicitly; an explicit z-index needs position too). */
  z-index: 5;
}
.pachi-total {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-weight: 700;
  font-size: 42px;
  line-height: 1; letter-spacing: -0.04em;
  font-feature-settings: "tnum" 1;
  transition: color 0.21s ease, text-shadow 0.21s ease, opacity 0.21s ease;
  color: #fff;
  opacity: 0;            /* revealed on first ball arriving in the catch */
}
/* When portaled to body, position-fixed at the catch tray's center so
   it stacks above the flux overlay (z:300). 400 > 300 wins. */
.pachi-total-overlay {
  position: fixed;
  z-index: 400;
  transform: translate(-50%, -50%);
  pointer-events: none;
  white-space: nowrap;
}
.pachi-total.shown { opacity: 1; }
.pachi-total.flash { color: #ffeb47; }
.pachi-total.big {
  color: #ffd60a;
  text-shadow: 0 0 34px rgba(255,214,10,0.55);
}

.pachi-controls {
  display: flex; flex-direction: column; align-items: center; gap: 13px;
  /* Fixed gap above the pill bar — earlier the catch tray was butting
     directly into the pills with no breathing room. 34px (Fibonacci)
     gives the catch a clear visual end before the action area starts. */
  margin-top: 34px;
}
/* Pill bar — same width as DROP (233 / Fibonacci), each pill claims 1/3
   via flex:1. Background neutral so the bar itself doesn't compete with
   the active pill. */
.pachi-pills {
  display: flex;
  width: 233px;
  gap: 5px;
  padding: 5px;
  background: rgba(255,255,255,0.03);
  border-radius: 999px;
}
.pachi-pill {
  flex: 1 1 0;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  padding: 10px 0;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dim, #6b6a64);
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 13px; font-weight: 700;
  letter-spacing: 0.06em;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease, transform 0.05s ease;
}
.pachi-pill:active { transform: translateY(1px); }
/* Pill ball glyph — bigger than chrome glyph so the pill reads as a unit
   selector, and matches the actual game ball size at typical board scale. */
.pachi-pill .ball-glyph {
  font-size: 18px;
  line-height: 1;
}
.pachi-pill .x {
  font-size: 13px;
  opacity: 0.85;
  font-feature-settings: 'tnum' 1;
}
/* Inactive pills: gunmetal gray. Inactive ball glyphs override the gold
   gradient with a flat gray clip so they read as "off". */
.pachi-pill[aria-pressed="false"] .ball-glyph {
  background: #555;
  -webkit-background-clip: text;
          background-clip: text;
  -webkit-text-fill-color: transparent;
          color: transparent;
  filter: none;
}
/* Active pill: 1px gold OUTLINE only — no fill — so the gold ball inside
   reads as the same ball used everywhere else. Text + ball both gold. */
.pachi-pill[aria-pressed="true"] {
  border-color: var(--gold-pure, #ffd60a);
  color: var(--gold-pure, #ffd60a);
}

/* DROP button — wider golden landscape (φ²:1). The previous 233×144
   (φ:1) ate too much vertical space and clipped the bottom on small
   screens. Now 233×89 (also Fibonacci) — width is φ² × height. The
   button is short and wide; the white space around it absorbs the
   Fibonacci-φ proportions instead of the button itself. */
.pachi-btn {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-weight: 800;
  font-size: 21px;
  letter-spacing: 0.382em;     /* 1/φ² */
  color: #050308;
  background: #ffeb47;
  border: none;
  width: 233px;
  height: 89px;
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

`;
