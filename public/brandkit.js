// Brand kit — kitchen-sink reference of the PACHI design language.
// Renders into the existing modal body. Self-contained: pulls Tone.js for
// audio demos, defines all CSS scoped under .brandkit, and reads CSS vars
// from styles.css for the palette so it stays in sync with the live theme.
//
// Audience: future agents/contributors. The point is to surface every
// visual + audio + motion + haptic decision in one place so design choices
// don't have to be reverse-engineered from scattered files.

import * as Tone from "https://esm.sh/tone@15.0.4";
import * as flux from "./flux.js";

const PHI = 1.6180339887;

// Mirrors the same multiplier table the contract + card use.
const MULTS = [850000, 110000, 30000, 16000, 5000, 12000, 1086,
               12000, 5000, 16000, 30000, 110000, 850000];
const TIER_GOLD = [
  "#1d1605", "#3a2e0e", "#6b521b", "#9c772a",
  "#d09e3a", "#ffc940", "#ffe066",
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
const fmtMult = (bps) => {
  const m = bps / 10000;
  if (m >= 100) return Math.round(m) + "×";
  if (m >= 10)  return m.toFixed(0) + "×";
  return m.toFixed(1) + "×";
};

const FIB_SPACING = [3, 5, 8, 13, 21, 34, 55, 89, 144];

// Lazy audio singleton — only starts when the user clicks a sound button
// (browsers require a gesture to unlock the AudioContext).
let audio = null;
async function ensureAudio() {
  if (audio) {
    if (Tone.context.state === "suspended") await Tone.context.resume();
    return audio;
  }
  await Tone.start();
  const dest = new Tone.Limiter(-1).toDestination();
  audio = {
    dest,
    click: new Tone.MembraneSynth({
      pitchDecay: 0.005, octaves: 4,
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
      volume: -16,
    }).connect(dest),
    land: new Tone.Synth({
      oscillator: { type: "triangle" },
      envelope: { attack: 0.005, decay: 0.4, sustain: 0, release: 0.4 },
      volume: -8,
    }).connect(dest),
    jackpot: new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: { attack: 0.005, decay: 0.6, sustain: 0.1, release: 0.4 },
      volume: -4,
    }).connect(dest),
  };
  return audio;
}

async function playPegClick(row = 6) {
  const a = await ensureAudio();
  const note = 180 * Math.pow(PHI, row / 24) + Math.random() * 14;
  a.click.triggerAttackRelease(note, 0.04);
}
async function playSlotLand(bps) {
  const a = await ensureAudio();
  const m = bps / 10000;
  const phiExp = Math.log(m + 0.5) / Math.log(PHI) * 0.5;
  const note = 220 * Math.pow(PHI, phiExp);
  a.land.triggerAttackRelease(note, 0.18);
}
async function playJackpotChord() {
  const a = await ensureAudio();
  const tonic = 392;
  a.jackpot.triggerAttackRelease(
    [tonic, tonic * PHI, tonic * PHI * PHI, tonic * PHI * PHI * PHI],
    0.55
  );
}

function buzz(pattern) {
  if (!navigator.vibrate) return false;
  navigator.vibrate(pattern);
  return true;
}

export async function render(targetEl) {
  targetEl.innerHTML = `
    <div class="brandkit">
      <style>${BRANDKIT_CSS}</style>

      <p class="bk-intro">
        PACHI's design language: a single typeface (IBM Plex Mono), a 7-tier
        gold scale, the φ ratio for every spatial decision, and Fibonacci
        numbers for spacing/timing. No decorative gradients, no neon, no
        rainbow. Slot color encodes payoff value — never decorative.
      </p>

      <section class="bk-sec">
        <h3>gold scale</h3>
        <p class="bk-note">7 tiers from dim ember to blazing. Lightness steps roughly φ-spaced. Tier 0 is the central 0.1× sink; tier 6 is the jackpot 85×.</p>
        <div class="bk-swatches">
          ${TIER_GOLD.map((c, i) => `
            <div class="bk-swatch" style="background:${c}">
              <span class="bk-swatch-label">tier ${i}</span>
              <span class="bk-swatch-hex">${c}</span>
            </div>
          `).join("")}
        </div>
      </section>

      <section class="bk-sec">
        <h3>ink scale</h3>
        <p class="bk-note">Deep warm-tinted neutrals. Backgrounds, surfaces, borders.</p>
        <div class="bk-swatches">
          <div class="bk-swatch" style="background:var(--ink-deep)"><span class="bk-swatch-label" style="color:#fff">ink-deep</span></div>
          <div class="bk-swatch" style="background:var(--ink-bg)"><span class="bk-swatch-label" style="color:#fff">ink-bg</span></div>
          <div class="bk-swatch" style="background:var(--ink-surface)"><span class="bk-swatch-label" style="color:#fff">ink-surface</span></div>
          <div class="bk-swatch" style="background:var(--ink); color:#0a0810"><span class="bk-swatch-label">ink</span></div>
          <div class="bk-swatch" style="background:var(--dim)"><span class="bk-swatch-label">dim</span></div>
        </div>
      </section>

      <section class="bk-sec">
        <h3>logo + ball glyph</h3>
        <p class="bk-note">Logo: gold (HSL 45°) with a 4-layer glow at Fibonacci radii (3 / 8 / 21 / 55 px) and inverse-golden-power opacities. Ball glyph: the SAME yellow radial gradient as the in-game physics ball (#fff7c2 → #ffeb47 → #c89200), clipped to the ● character via background-clip:text. Used for wallet balance, pill button dots, outcome pile, and flux animations — the ball is the universal currency unit.</p>
        <div class="bk-logo-row">
          <span class="bk-logo">PACHI</span>
          <span class="ball-glyph" style="font-size:34px">●</span>
          <span class="bk-balance-demo">1,000 <span class="ball-glyph">●</span></span>
        </div>
      </section>

      <section class="bk-sec">
        <h3>circular ball flow</h3>
        <p class="bk-note">PACHI's economy is a closed loop — balls flow OUT of the wallet on DROP, into the pyramid, into the slots, then BACK to the wallet on LAND. Every ball is the same visual ball; the flux canvas overlay animates them between DOM elements without ever changing their appearance.</p>
        <div class="bk-flow">
          <div class="bk-flow-step">
            <div class="bk-flow-num">1</div>
            <div class="bk-flow-label">DROP</div>
            <div class="bk-flow-detail">Wallet ● →<br/>spawn point</div>
          </div>
          <div class="bk-flow-arrow">↓</div>
          <div class="bk-flow-step">
            <div class="bk-flow-num">2</div>
            <div class="bk-flow-label">PYRAMID</div>
            <div class="bk-flow-detail">Physics balls<br/>cascade through pegs</div>
          </div>
          <div class="bk-flow-arrow">↓</div>
          <div class="bk-flow-step">
            <div class="bk-flow-num">3</div>
            <div class="bk-flow-label">LAND</div>
            <div class="bk-flow-detail">Slots glow<br/>by tier</div>
          </div>
          <div class="bk-flow-arrow">↑</div>
          <div class="bk-flow-step">
            <div class="bk-flow-num">4</div>
            <div class="bk-flow-label">RETURN</div>
            <div class="bk-flow-detail">Outcome pile →<br/>wallet ●</div>
          </div>
        </div>
        <div class="bk-buttons" style="margin-top:13px">
          <button class="bk-btn" data-flow="drop">demo · ball flies wallet → pyramid spawn</button>
          <button class="bk-btn" data-flow="return">demo · ball flies outcome → wallet</button>
        </div>
      </section>

      <section class="bk-sec">
        <h3>pill selector (×1 / ×10 / ×100)</h3>
        <p class="bk-note">Active state = 1px gold OUTLINE only (no fill), so the ball glyph inside reads as the same yellow ball used everywhere. Inactive = gunmetal gray ball + gray text. Click to toggle the active state and feel how the visual hierarchy shifts.</p>
        <div class="bk-pill-demo">
          <div class="pachi-pills" role="radiogroup">
            <button class="pachi-pill bk-demo-pill" data-n="1"   aria-pressed="true">
              <span class="ball-glyph">●</span><span class="x">×1</span>
            </button>
            <button class="pachi-pill bk-demo-pill" data-n="10"  aria-pressed="false">
              <span class="ball-glyph">●</span><span class="x">×10</span>
            </button>
            <button class="pachi-pill bk-demo-pill" data-n="100" aria-pressed="false">
              <span class="ball-glyph">●</span><span class="x">×100</span>
            </button>
          </div>
        </div>
      </section>

      <section class="bk-sec">
        <h3>slot tier colors (payoff-encoded)</h3>
        <p class="bk-note">Click any slot to hear its landing tone — pitch shifts by φ-ratio intervals.</p>
        <div class="bk-slots">
          ${MULTS.map((bps, i) => {
            const tier = tierForBps(bps);
            return `
              <button class="bk-slot" data-bps="${bps}" style="background:${TIER_GOLD[tier]}; color:${tier <= 2 ? '#ffe066' : '#0a0810'}">
                <span class="bk-slot-mult">${fmtMult(bps)}</span>
                <span class="bk-slot-tier">t${tier}</span>
              </button>
            `;
          }).join("")}
        </div>
      </section>

      <section class="bk-sec">
        <h3>sound</h3>
        <p class="bk-note">Three voices. All φ-tuned: peg pitches climb 180·φ^(row/24); slot land pitch is 220·φ^(½·log_φ(m+0.5)); jackpot stacks tonic + φ + φ² + φ³ — non-Western interval.</p>
        <div class="bk-buttons">
          <button class="bk-btn" data-sound="peg-low">peg · row 0</button>
          <button class="bk-btn" data-sound="peg-mid">peg · row 6</button>
          <button class="bk-btn" data-sound="peg-high">peg · row 11</button>
          <button class="bk-btn" data-sound="land-bust">land · bust 0.1×</button>
          <button class="bk-btn" data-sound="land-small">land · 1.2×</button>
          <button class="bk-btn" data-sound="land-big">land · 11×</button>
          <button class="bk-btn" data-sound="jackpot">jackpot chord</button>
        </div>
      </section>

      <section class="bk-sec">
        <h3>haptics</h3>
        <p class="bk-note">Patterns are Fibonacci-rhythm in milliseconds. Tap to feel each tier. Mobile only — desktop browsers ignore <code>navigator.vibrate</code>.</p>
        <div class="bk-buttons">
          <button class="bk-btn" data-haptic="bust">bust · 5</button>
          <button class="bk-btn" data-haptic="small">small win · 8/5/8</button>
          <button class="bk-btn" data-haptic="big">10× · 13/8/13/21</button>
          <button class="bk-btn" data-haptic="jackpot">jackpot · 21/13/21/13/34/55</button>
        </div>
        <div class="bk-haptic-status" id="bk-haptic-status"></div>
      </section>

      <section class="bk-sec">
        <h3>fibonacci spacing scale</h3>
        <p class="bk-note">Every margin / padding / gap / radius / size in the codebase comes from this set. Don't introduce other values.</p>
        <div class="bk-fib-row">
          ${FIB_SPACING.map(n => `
            <div class="bk-fib-cell">
              <div class="bk-fib-bar" style="width:${n}px; height:${n}px"></div>
              <span class="bk-fib-num">${n}</span>
            </div>
          `).join("")}
        </div>
      </section>

      <section class="bk-sec">
        <h3>motion · gold-intensity scaling</h3>
        <p class="bk-note">Win text color + glow scales by log_φ(payout/wagered). 1× → white. φ¹ ≈ 1.62× → subtle gold. φ⁵ ≈ 11× → rich. φ⁸ ≈ 47× → blazing.</p>
        <div class="bk-gold-grid">
          <div class="bk-gold-sample" data-ratio="1">1.0× · break-even</div>
          <div class="bk-gold-sample" data-ratio="1.62">1.62× · φ¹</div>
          <div class="bk-gold-sample" data-ratio="2.62">2.62× · φ²</div>
          <div class="bk-gold-sample" data-ratio="6.85">6.85× · φ⁴</div>
          <div class="bk-gold-sample" data-ratio="11">11× · jackpot-mid</div>
          <div class="bk-gold-sample" data-ratio="47">47× · φ⁸ blazing</div>
          <div class="bk-gold-sample" data-ratio="85">85× · top jackpot</div>
        </div>
      </section>

      <section class="bk-sec">
        <h3>letter-spacing scale (inverse-φ powers)</h3>
        <p class="bk-note">Tracking values are 1/φ^n. The further out, the looser the chrome.</p>
        <div class="bk-tracking">
          <div style="letter-spacing:0.034em">0.034em — 1/φ⁵ — body chrome</div>
          <div style="letter-spacing:0.055em">0.055em — toast / table</div>
          <div style="letter-spacing:0.13em">0.13em — version footer</div>
          <div style="letter-spacing:0.146em">0.146em — 1/φ⁴ — modal / stale</div>
          <div style="letter-spacing:0.236em">0.236em — 1/φ³ — logo / pill / stake</div>
          <div style="letter-spacing:0.382em">0.382em — 1/φ² — DROP button</div>
        </div>
      </section>

      <section class="bk-sec">
        <h3>type — IBM Plex Mono</h3>
        <p class="bk-note">Single typeface throughout. Tabular numerals enabled wherever digits matter. Weights used: 300 / 400 / 500 / 600 / 700 / 800.</p>
        <div class="bk-type">
          <div style="font-weight:300">300 — light · The quick brown fox 0123456789</div>
          <div style="font-weight:400">400 — regular · The quick brown fox 0123456789</div>
          <div style="font-weight:500">500 — medium · The quick brown fox 0123456789</div>
          <div style="font-weight:600">600 — semibold · The quick brown fox 0123456789</div>
          <div style="font-weight:700">700 — bold · The quick brown fox 0123456789</div>
          <div style="font-weight:800">800 — extra-bold · The quick brown fox 0123456789</div>
        </div>
      </section>

      <section class="bk-sec">
        <h3>UI text discipline</h3>
        <ul class="bk-rules">
          <li>Action verbs are constant across game states. <strong>DROP</strong> stays <strong>DROP</strong> — never "AGAIN", never "PLAY".</li>
          <li>No descriptive prefix labels on screens (no "PACHI · cascade plinko").</li>
          <li>No house-edge / RTP / EV math in player UI. Operator surface only.</li>
          <li>Currency unit is the ball glyph <span class="ball-glyph">●</span> — never $, never "PACHI". Same yellow gradient everywhere: wallet, pills, outcome pile, flux animations.</li>
          <li>Lowercase chrome (logo dropdown, modal titles). UPPERCASE for primary CTAs only.</li>
        </ul>
      </section>
    </div>
  `;

  // Pill demo — tap to toggle active state. Pure aria-pressed swap;
   // mirrors the live card behavior.
  targetEl.querySelectorAll(".bk-demo-pill").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      targetEl.querySelectorAll(".bk-demo-pill").forEach(p => p.setAttribute("aria-pressed", "false"));
      el.setAttribute("aria-pressed", "true");
    });
  });

  // Slot click → land tone for that slot's bps.
  targetEl.querySelectorAll(".bk-slot").forEach(el => {
    el.addEventListener("click", () => {
      const bps = Number(el.dataset.bps);
      playSlotLand(bps);
      if (bps >= 800_000) buzz([21, 13, 21, 13, 34, 55]);
      else if (bps >= 100_000) buzz([13, 8, 13, 21]);
      else if (bps >= 11_000) buzz([8, 5, 8]);
      else buzz(5);
    });
  });

  // Sound buttons.
  targetEl.querySelectorAll("[data-sound]").forEach(el => {
    el.addEventListener("click", () => {
      const k = el.dataset.sound;
      if (k === "peg-low")    playPegClick(0);
      if (k === "peg-mid")    playPegClick(6);
      if (k === "peg-high")   playPegClick(11);
      if (k === "land-bust")  playSlotLand(1086);
      if (k === "land-small") playSlotLand(12000);
      if (k === "land-big")   playSlotLand(110000);
      if (k === "jackpot")    playJackpotChord();
    });
  });

  // Haptic buttons.
  const hStatus = targetEl.querySelector("#bk-haptic-status");
  targetEl.querySelectorAll("[data-haptic]").forEach(el => {
    el.addEventListener("click", () => {
      const k = el.dataset.haptic;
      let pattern;
      if (k === "bust")        pattern = 5;
      if (k === "small")       pattern = [8, 5, 8];
      if (k === "big")         pattern = [13, 8, 13, 21];
      if (k === "jackpot")     pattern = [21, 13, 21, 13, 34, 55];
      const ok = buzz(pattern);
      hStatus.textContent = ok ? "vibrated ✓" : "not supported on this device";
      setTimeout(() => { if (hStatus) hStatus.textContent = ""; }, 1400);
    });
  });

  // Flow demo buttons — fire flux animations between visible anchors so a
  // future agent can SEE the primitive that drives the closed loop.
  const walletEl = document.getElementById("bal");
  targetEl.querySelectorAll("[data-flow]").forEach(el => {
    el.addEventListener("click", () => {
      const k = el.dataset.flow;
      const wallet = flux.anchorOf(walletEl);
      const btnRect = el.getBoundingClientRect();
      const btnCenter = { x: btnRect.left + btnRect.width / 2, y: btnRect.top + btnRect.height / 2 };
      if (!wallet) return;
      if (k === "drop") {
        // wallet → simulated spawn point (just below the button as proxy
        // since pyramid isn't rendered in the modal).
        const target = { x: btnCenter.x, y: btnCenter.y + 89 };
        for (let i = 0; i < 5; i++) {
          setTimeout(() => flux.flyBall({
            fromX: wallet.x, fromY: wallet.y,
            toX:   target.x, toY:   target.y,
            duration: 600, radius: 7,
          }), i * 80);
        }
      } else if (k === "return") {
        // simulated outcome → wallet
        const source = { x: btnCenter.x, y: btnCenter.y + 89 };
        for (let i = 0; i < 5; i++) {
          setTimeout(() => flux.flyBall({
            fromX: source.x, fromY: source.y,
            toX:   wallet.x, toY:   wallet.y,
            duration: 700, radius: 7,
            arc: -Math.abs(wallet.y - source.y) * 0.42,
          }), i * 80);
        }
      }
    });
  });

  // Apply the live gold-intensity formula to each sample so future agents
  // can read the implementation in one place: same math as cards/pachi.js.
  targetEl.querySelectorAll(".bk-gold-sample").forEach(el => {
    const ratio = Number(el.dataset.ratio);
    if (ratio <= 1) {
      el.style.color = "#fff";
      return;
    }
    const intensitySteps = Math.log(ratio) / Math.log(PHI);
    const t = Math.max(0.22, Math.min(intensitySteps / 6, 1));
    const lightness = 88 - t * 38;
    el.style.color = `hsl(50, 100%, ${lightness}%)`;
    const s = (a, b) => a + (b - a) * t;
    el.style.textShadow = [
      `0 0 ${s(5, 21).toFixed(1)}px  rgba(255, 247, 194, ${s(0.45, 0.95).toFixed(2)})`,
      `0 0 ${s(13, 55).toFixed(1)}px rgba(255, 214, 10,  ${s(0.30, 0.78).toFixed(2)})`,
      `0 0 ${s(21, 144).toFixed(1)}px rgba(255, 140, 0,  ${s(0.18, 0.55).toFixed(2)})`,
    ].join(", ");
  });
}

const BRANDKIT_CSS = `
.brandkit { font-family: 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink); font-size: 13px; line-height: 1.55; }
.brandkit code { background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 3px; font-size: 12px; }

.bk-intro { opacity: 0.75; margin: 0 0 21px; font-size: 13px; line-height: 1.55; }

.bk-sec { margin: 0 0 34px; }
.bk-sec h3 {
  margin: 0 0 8px;
  font-size: 11px;
  letter-spacing: 0.236em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--gold-pure);
  opacity: 0.85;
}
.bk-note { margin: 0 0 13px; font-size: 12px; opacity: 0.65; line-height: 1.55; }

.bk-swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(89px, 1fr)); gap: 8px; }
.bk-swatch {
  height: 55px;
  border-radius: 5px;
  display: flex; flex-direction: column; justify-content: space-between;
  padding: 8px;
  border: 1px solid var(--ink-line);
  font-size: 10px;
  letter-spacing: 0.05em;
}
.bk-swatch-label { font-weight: 700; color: #0a0810; text-transform: uppercase; opacity: 0.85; }
.bk-swatch-hex { color: rgba(0,0,0,0.55); font-feature-settings: 'tnum' 1; font-size: 9px; }
.bk-swatch:nth-child(1) .bk-swatch-label,
.bk-swatch:nth-child(2) .bk-swatch-label,
.bk-swatch:nth-child(3) .bk-swatch-label { color: #ffe066; }
.bk-swatch:nth-child(1) .bk-swatch-hex,
.bk-swatch:nth-child(2) .bk-swatch-hex,
.bk-swatch:nth-child(3) .bk-swatch-hex { color: rgba(255,255,255,0.45); }

.bk-logo-row {
  display: flex; align-items: center; gap: 34px; flex-wrap: wrap;
  padding: 21px;
  background: var(--ink-deep);
  border-radius: 8px;
  border: 1px solid var(--ink-line);
}
.bk-logo {
  font-weight: 800;
  font-size: 21px;
  letter-spacing: 0.236em;
  color: #ffd60a;
  text-shadow:
    0 0 3px  rgba(255, 246, 200, 0.62),
    0 0 8px  rgba(255, 214, 10,  0.38),
    0 0 21px rgba(255, 140, 0,   0.24),
    0 0 55px rgba(255, 100, 0,   0.15);
}
.bk-balance-demo {
  font-weight: 700;
  font-size: 21px;
  font-variant-numeric: tabular-nums;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.bk-flow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 21px;
  background: var(--ink-deep);
  border-radius: 8px;
  border: 1px solid var(--ink-line);
  justify-content: center;
}
.bk-flow-step {
  flex: 1 1 0;
  min-width: 89px;
  text-align: center;
  padding: 13px 8px;
  border: 1px solid var(--ink-line);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.02);
}
.bk-flow-num {
  font-size: 21px;
  font-weight: 800;
  color: var(--gold-pure);
  line-height: 1;
  margin-bottom: 5px;
}
.bk-flow-label {
  font-size: 10px;
  letter-spacing: 0.236em;
  text-transform: uppercase;
  font-weight: 700;
  margin-bottom: 5px;
  opacity: 0.85;
}
.bk-flow-detail {
  font-size: 10px;
  opacity: 0.55;
  line-height: 1.4;
}
.bk-flow-arrow {
  font-size: 21px;
  color: var(--gold-pure);
  opacity: 0.55;
  flex: 0 0 auto;
}

.bk-pill-demo {
  display: flex;
  justify-content: center;
  padding: 13px;
  background: var(--ink-deep);
  border-radius: 8px;
  border: 1px solid var(--ink-line);
}


.bk-slots { display: grid; grid-template-columns: repeat(13, 1fr); gap: 3px; }
.bk-slot {
  aspect-ratio: 1 / 1.618;
  border: none;
  border-radius: 3px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  cursor: pointer;
  font-family: inherit;
  padding: 3px;
  transition: transform 0.05s, filter 0.15s;
  min-width: 0;
}
.bk-slot:hover { filter: brightness(1.15); }
.bk-slot:active { transform: translateY(1px); }
.bk-slot-mult { font-size: 11px; font-weight: 700; }
.bk-slot-tier { font-size: 8px; opacity: 0.55; letter-spacing: 0.1em; text-transform: uppercase; }

.bk-buttons { display: flex; flex-wrap: wrap; gap: 5px; }
.bk-btn {
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  padding: 8px 13px;
  border-radius: 5px;
  border: 1px solid var(--ink-line);
  background: rgba(255,255,255,0.04);
  color: var(--ink);
  cursor: pointer;
  transition: background 0.13s, border-color 0.13s;
}
.bk-btn:hover { background: rgba(255,214,10,0.08); border-color: rgba(255,214,10,0.34); }
.bk-btn:active { transform: translateY(1px); }
.bk-haptic-status {
  margin-top: 8px;
  font-size: 11px;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--gold-pure);
  opacity: 0.7;
  min-height: 14px;
}

.bk-fib-row { display: flex; align-items: flex-end; gap: 13px; flex-wrap: wrap; }
.bk-fib-cell { display: flex; flex-direction: column; align-items: center; gap: 5px; }
.bk-fib-bar {
  background: var(--gold-pure);
  border-radius: 2px;
  box-shadow: 0 0 8px rgba(255,214,10,0.34);
}
.bk-fib-num { font-size: 10px; opacity: 0.6; font-feature-settings: 'tnum' 1; }

.bk-gold-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(144px, 1fr)); gap: 8px; }
.bk-gold-sample {
  padding: 13px;
  border: 1px solid var(--ink-line);
  border-radius: 5px;
  background: var(--ink-deep);
  font-weight: 700;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  text-align: center;
}

.bk-tracking > div {
  padding: 8px 13px;
  margin-bottom: 5px;
  background: rgba(255,255,255,0.03);
  border-radius: 3px;
  font-size: 12px;
  text-transform: uppercase;
  font-weight: 600;
  color: var(--ink);
}

.bk-type > div { padding: 5px 0; font-size: 13px; font-feature-settings: 'tnum' 1; }

.bk-rules {
  margin: 0;
  padding-left: 21px;
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.85;
}
.bk-rules li { margin-bottom: 5px; }
.bk-rules strong { color: var(--gold-pure); font-weight: 700; }
`;
