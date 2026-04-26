// Flux — viewport-wide canvas overlay that animates balls flying between
// arbitrary on-screen elements. Used to visualize the closed loop of
// PACHI's economy: balls leaving the wallet on DROP, balls returning
// from the outcome pile to the wallet on LAND.
//
// Why a canvas instead of DOM elements? At 100 balls / round each round
// can have ~200 in-flight glyphs; canvas keeps that smooth. The same
// yellow radial gradient as in-game physics balls is used so visually
// the animated balls and the matter.js balls read as the same object
// just changing surface (DOM-overlay → physics-canvas → DOM-overlay).
//
// API
// ───
// mount() once at page load.
// flyBall({ fromX, fromY, toX, toY, duration, arc, radius, onArrive })
// allBalls() / clearBalls() — for cleanup if ever needed.
// anchorOf(el) → { x, y } in viewport coords (center of the element).

const PHI = 1.6180339887;

let canvas = null;
let cx = null;
let dpr = 1;
let mounted = false;
const balls = [];

function ensureCanvas() {
  if (canvas) return;
  canvas = document.createElement("canvas");
  canvas.id = "fluxCanvas";
  canvas.style.cssText = [
    "position:fixed",
    "inset:0",
    "width:100vw",
    "height:100dvh",
    "pointer-events:none",
    // Sits above EVERYTHING (chrome z=50, modals z=200) so flux balls are
    // always visible. pointer-events:none means it never blocks clicks on
    // anything below — modal interactions still work normally. Putting flux
    // above modals lets the brand-kit's flow demos visualize themselves
    // even though the modal is open.
    "z-index:300",
  ].join(";");
  document.body.appendChild(canvas);
  cx = canvas.getContext("2d");
  resize();
  window.addEventListener("resize", resize, { passive: true });
}

function resize() {
  if (!canvas) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function tick() {
  if (!mounted) return;
  const now = performance.now();
  const w = window.innerWidth;
  const h = window.innerHeight;
  cx.clearRect(0, 0, w, h);

  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    const t = Math.min(1, (now - b.t0) / b.duration);
    // easeOutCubic for outbound (slows on arrival), easeInCubic
    // for incoming-to-wallet (accelerates as it nears) — chosen by sign
    // of arc: positive arc (descending into game) eases out, negative
    // arc (rising to wallet) eases in. Feels physical.
    const ease = b.arc >= 0
      ? 1 - Math.pow(1 - t, 3)
      : t * t * t;

    const x = b.x0 + (b.x1 - b.x0) * ease;
    // Parabolic vertical: linear path + sin-bowed offset of `arc` pixels
    // peaking at t=0.5. Positive arc bows DOWN (drop arc), negative
    // bows UP (rise arc).
    const linearY = b.y0 + (b.y1 - b.y0) * ease;
    const bow = Math.sin(t * Math.PI) * b.arc;
    const y = linearY + bow;

    // Trail — a few ghost echoes behind the live position. Keeps the
    // motion legible at high ball counts without overdrawing.
    const trailSteps = 3;
    for (let s = trailSteps; s >= 1; s--) {
      const tt = Math.max(0, t - s * 0.05);
      const ee = b.arc >= 0 ? 1 - Math.pow(1 - tt, 3) : tt * tt * tt;
      const tx = b.x0 + (b.x1 - b.x0) * ee;
      const ty = b.y0 + (b.y1 - b.y0) * ee + Math.sin(tt * Math.PI) * b.arc;
      const ta = (1 - s / (trailSteps + 1)) * 0.4 * (1 - t);
      cx.fillStyle = `rgba(255, 214, 10, ${ta.toFixed(3)})`;
      cx.beginPath();
      cx.arc(tx, ty, b.r * 0.6, 0, Math.PI * 2);
      cx.fill();
    }

    // The ball itself — yellow radial gradient identical to the matter.js
    // balls in cards/pachi.js.
    const grad = cx.createRadialGradient(
      x - b.r * 0.3, y - b.r * 0.3, 0,
      x, y, b.r * 1.6
    );
    grad.addColorStop(0,    "#fff7c2");
    grad.addColorStop(0.55, "#ffeb47");
    grad.addColorStop(1,    "#c89200");
    cx.fillStyle = grad;
    cx.beginPath();
    cx.arc(x, y, b.r, 0, Math.PI * 2);
    cx.fill();

    // Soft glow halo on every flux ball — matches the wordmark / glyph
    // glow vocabulary so the flying balls feel of-a-piece with chrome.
    const halo = cx.createRadialGradient(x, y, b.r * 0.5, x, y, b.r * 3);
    halo.addColorStop(0, "rgba(255, 235, 71, 0.28)");
    halo.addColorStop(1, "rgba(255, 235, 71, 0)");
    cx.fillStyle = halo;
    cx.beginPath();
    cx.arc(x, y, b.r * 3, 0, Math.PI * 2);
    cx.fill();

    if (t >= 1) {
      balls.splice(i, 1);
      try { b.onArrive && b.onArrive(); } catch (err) { console.warn("flux onArrive threw:", err); }
    }
  }

  requestAnimationFrame(tick);
}

export function mount() {
  if (mounted) return;
  mounted = true;
  ensureCanvas();
  requestAnimationFrame(tick);
}

export function flyBall(opts) {
  ensureCanvas();
  const {
    fromX, fromY, toX, toY,
    duration = 600,
    // Default arc = 1/φ * |Δy|. Positive bows down (drop), negative
    // bows up (rise). Caller can override.
    arc,
    radius = 8,
    onArrive,
  } = opts;
  const dy = toY - fromY;
  const defaultArc = Math.abs(dy) / PHI * (dy >= 0 ? 0.4 : -0.4);
  balls.push({
    x0: fromX, y0: fromY,
    x1: toX,   y1: toY,
    arc: arc != null ? arc : defaultArc,
    duration,
    r: radius,
    t0: performance.now(),
    onArrive,
  });
}

/// Center of element rect in viewport coords. Returns null if the element
/// has no layout (display:none, detached, etc.) — caller should skip in
/// that case rather than fly to (0,0).
export function anchorOf(el) {
  if (!el || !el.getBoundingClientRect) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function inFlightCount() { return balls.length; }

// Drop every in-flight ball without firing onArrive. Used by the card on
// tab-resume to flush stale flights that were paused while the tab was
// backgrounded — those balls would otherwise sit forever in the array,
// wedging round counters that decrement only on arrival.
export function clearBalls() {
  balls.length = 0;
}
