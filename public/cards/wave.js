// WAVE — perpetual altitude card
// Self-contained module. Brings its own visual language (shader, type, audio, motion).
// Exports mount(slot, ctx) which renders into slot and returns an unmount fn.

import { gsap } from "https://esm.sh/gsap@3.12.5";
import * as Tone from "https://esm.sh/tone@15.0.4";

const WAVE_ADDR = "0x4f9B1Af0343cC0F04e6C0e69f4B157C954729de9";
const WAVE_ABI = [
  { type: "function", name: "play", stateMutability: "nonpayable",
    inputs: [{ name: "targetBps", type: "uint256" }],
    outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "stake", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "streak", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "bestStreak", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "event", name: "Played", inputs: [
    { indexed: true,  name: "player",       type: "address" },
    { indexed: false, name: "stake",        type: "uint256" },
    { indexed: false, name: "targetBps",    type: "uint256" },
    { indexed: false, name: "crashBps",     type: "uint256" },
    { indexed: false, name: "payout",       type: "uint256" },
    { indexed: false, name: "streakAfter",  type: "uint256" },
    { indexed: false, name: "nonce",        type: "uint256" },
  ]},
];

// Token approval — already done at deploy time for this burner. The shell
// loaded balance, so we trust the wallet is set up.

// ── altitude curve (visual) ───────────────────────────────────────────────
// mult(t) = exp(t / TAU). Starts at 1.0, gentle early, exponential later.
const TAU = 7.5;
const altAt = (tSeconds) => Math.exp(tSeconds / TAU);

// ── fragment shader ───────────────────────────────────────────────────────
const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 u_res;
uniform float u_time;
uniform float u_alt;       // 1.0+
uniform float u_intensity; // 0..1, climbs through the round
uniform float u_flash;     // 0..1, transient on bank/crash
uniform float u_crashed;   // 0 or 1
uniform float u_glitch;    // 0..1, danger zone

// hash + value noise — compact, no textures
vec2 hash(vec2 p){
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(dot(hash(i + vec2(0,0)), f - vec2(0,0)),
                 dot(hash(i + vec2(1,0)), f - vec2(1,0)), u.x),
             mix(dot(hash(i + vec2(0,1)), f - vec2(0,1)),
                 dot(hash(i + vec2(1,1)), f - vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.05; a *= 0.5; }
  return v;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res) / u_res.y;
  float t  = u_time * 0.18;
  float k  = clamp(u_intensity, 0.0, 1.0);
  float kk = pow(k, 1.4);

  // flow field — warp UV by fbm at multiple scales
  vec2 q = uv * (1.2 + 0.6*kk);
  q += vec2(t * 0.5, -t * 0.35);
  float n1 = fbm(q + vec2(fbm(q * 2.0), fbm(q * 1.7 + 11.0)));
  vec2 warp = vec2(n1, fbm(q + 5.3)) * (0.35 + 1.1*kk);
  float n2 = fbm((uv + warp) * (2.0 + 4.0*kk) + vec2(0.0, t * (1.0 + 2.5*kk)));

  // palette — cool deep-water → hot magma
  vec3 c0 = vec3(0.02, 0.05, 0.10);   // deep
  vec3 c1 = vec3(0.10, 0.18, 0.40);   // ocean
  vec3 c2 = vec3(0.85, 0.35, 0.05);   // ember
  vec3 c3 = vec3(1.00, 0.85, 0.40);   // flare
  vec3 base = mix(mix(c0, c1, smoothstep(-0.4, 0.4, n2)),
                  mix(c2, c3, smoothstep(0.0, 0.7, n2)),
                  kk);

  // bottom-anchored glow that intensifies with altitude — the "rising heat"
  float d = length(uv - vec2(0.0, -0.55));
  float glow = exp(-d * (2.0 - 1.0*kk)) * (0.25 + 1.2*kk);
  base += glow * mix(vec3(0.05,0.10,0.25), vec3(1.0, 0.55, 0.18), kk);

  // chromatic aberration in the danger zone — split RGB
  if (u_glitch > 0.01) {
    float g = u_glitch;
    vec2 dir = normalize(uv + 0.0001) * 0.012 * g;
    float r = fbm((uv - dir) * 3.0 + vec2(0, t));
    float gC = fbm(uv * 3.0 + vec2(0, t));
    float b = fbm((uv + dir) * 3.0 + vec2(0, t));
    base += vec3(r, gC, b) * 0.18 * g;
  }

  // vignette
  float vig = 1.0 - smoothstep(0.5, 1.3, length(uv));
  base *= vig;

  // crash overlay — desaturated red wash
  if (u_crashed > 0.5) {
    float lum = dot(base, vec3(0.299, 0.587, 0.114));
    base = mix(base, vec3(lum * 1.2, lum * 0.15, lum * 0.1), 0.85);
  }

  // bank/crash flash
  base += vec3(u_flash);

  outColor = vec4(base, 1.0);
}
`;

const VERT = `#version 300 es
in vec2 a;
void main(){ gl_Position = vec4(a, 0.0, 1.0); }
`;

// ── module ────────────────────────────────────────────────────────────────
export function mount(slot, ctx) {
  // root container
  slot.innerHTML = `
    <canvas class="wave-bg"></canvas>
    <div class="wave-frame">
      <div class="wave-meta">
        <span class="wave-tag">WAVE · perpetual altitude</span>
        <span class="wave-streak" id="wstreak">streak 0 · best 0</span>
      </div>
      <div class="wave-center">
        <div class="wave-mult" id="wmult">1.00<span class="x">×</span></div>
        <div class="wave-sub" id="wsub">tap to lift</div>
      </div>
      <div class="wave-foot">
        <button class="wave-btn" id="wbtn" data-s="idle">PLAY</button>
        <div class="wave-stake" id="wstake">stake $1.00 · alphaUSD</div>
      </div>
    </div>
  `;

  // styles — scoped, no leakage to shell
  const style = document.createElement("style");
  style.textContent = WAVE_CSS;
  slot.appendChild(style);

  const canvas = slot.querySelector(".wave-bg");
  const multEl   = slot.querySelector("#wmult");
  const subEl    = slot.querySelector("#wsub");
  const btnEl    = slot.querySelector("#wbtn");
  const streakEl = slot.querySelector("#wstreak");
  const stakeEl  = slot.querySelector("#wstake");

  // ── shader pipeline ─────────────────────────────────────────────────────
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) {
    slot.innerHTML = `<div class="wave-fallback">webgl2 unavailable — try a modern browser</div>`;
    return () => {};
  }

  function compile(type, src){
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(s));
      throw new Error("shader compile failed");
    }
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const aLoc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(aLoc);
  gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);

  const u = {
    res:       gl.getUniformLocation(prog, "u_res"),
    time:      gl.getUniformLocation(prog, "u_time"),
    alt:       gl.getUniformLocation(prog, "u_alt"),
    intensity: gl.getUniformLocation(prog, "u_intensity"),
    flash:     gl.getUniformLocation(prog, "u_flash"),
    crashed:   gl.getUniformLocation(prog, "u_crashed"),
    glitch:    gl.getUniformLocation(prog, "u_glitch"),
  };

  function resize(){
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width  = Math.floor(window.innerWidth  * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width  = window.innerWidth  + "px";
    canvas.style.height = window.innerHeight + "px";
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener("resize", resize);
  resize();

  // ── audio (lazy, must be unlocked by user gesture) ──────────────────────
  let audio = null;
  async function ensureAudio(){
    if (audio) return audio;
    await Tone.start();
    const dest = new Tone.Limiter(-1).toDestination();
    const drone = new Tone.Oscillator({ frequency: 60, type: "sine", volume: -28 }).start().connect(dest);
    const noise = new Tone.Noise({ type: "pink", volume: -38 }).start();
    const filt  = new Tone.Filter({ frequency: 200, type: "lowpass", Q: 4 });
    noise.connect(filt); filt.connect(dest);
    const bell  = new Tone.Synth({ oscillator: { type: "triangle" },
      envelope: { attack: 0.005, decay: 0.4, sustain: 0, release: 0.4 }, volume: -8 }).connect(dest);
    const thud  = new Tone.MembraneSynth({ pitchDecay: 0.1, octaves: 6, volume: -6 }).connect(dest);
    audio = { dest, drone, noise, filt, bell, thud };
    return audio;
  }

  // ── state machine ───────────────────────────────────────────────────────
  // idle → climbing → settling → revealed → idle
  let state = "idle";
  let climbStart = 0;
  let visualAlt = 1.0;
  let intensity = 0.0;
  let flash = 0.0;
  let glitch = 0.0;
  let crashed = 0;
  let lastAltUpdate = 0;
  let mounted = true;

  // ── render loop ─────────────────────────────────────────────────────────
  const t0 = performance.now();
  function frame(){
    if (!mounted) return;
    const now = performance.now();
    const t = (now - t0) / 1000;

    // visual altitude tick (only when climbing)
    if (state === "climbing") {
      const tc = (now - climbStart) / 1000;
      visualAlt = altAt(tc);
      intensity = Math.min(1, Math.log(visualAlt) / 4.5); // ~1.0 at ~90x
      glitch    = Math.max(0, (visualAlt - 5) / 25);      // kicks past 5x
      multEl.textContent = formatMult(visualAlt);
      // variable-font weight grows with altitude
      const w = Math.round(200 + Math.min(700, intensity * 700));
      multEl.style.fontVariationSettings = `"wght" ${w}`;
      // tilt slightly past 10x
      const tilt = Math.min(8, Math.max(0, (visualAlt - 10) * 0.4));
      multEl.style.transform = `rotate(${-tilt}deg)`;

      // audio: drone pitch follows altitude
      if (audio) {
        const target = 60 + Math.min(360, visualAlt * 6);
        audio.drone.frequency.rampTo(target, 0.08);
        audio.filt.frequency.rampTo(200 + intensity * 3500, 0.08);
        audio.noise.volume.rampTo(-38 + intensity * 22, 0.08);
      }
    }

    // flash decay
    flash *= 0.86;
    if (flash < 0.001) flash = 0;

    // push uniforms
    gl.uniform2f(u.res, canvas.width, canvas.height);
    gl.uniform1f(u.time, t);
    gl.uniform1f(u.alt, visualAlt);
    gl.uniform1f(u.intensity, intensity);
    gl.uniform1f(u.flash, flash);
    gl.uniform1f(u.crashed, crashed);
    gl.uniform1f(u.glitch, glitch);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ── interactions ────────────────────────────────────────────────────────
  async function startClimb(){
    if (state !== "idle") return;
    await ensureAudio().catch(() => {});
    state = "climbing";
    climbStart = performance.now();
    visualAlt = 1.0;
    crashed = 0;
    glitch = 0;
    flash = 0.18;
    btnEl.textContent = "BANK";
    btnEl.dataset.s = "climbing";
    subEl.textContent = "tap BANK to lock";
    if (navigator.vibrate) navigator.vibrate(8);
  }

  async function bank(){
    if (state !== "climbing") return;
    state = "settling";
    const targetBps = Math.max(10000, Math.floor(visualAlt * 10000));
    btnEl.textContent = "SETTLING";
    btnEl.dataset.s = "settling";
    btnEl.disabled = true;
    subEl.textContent = `target ${formatMult(visualAlt)}`;
    if (navigator.vibrate) navigator.vibrate([15, 20, 15]);

    try {
      const hash = await ctx.client.writeContract({
        address: WAVE_ADDR, abi: WAVE_ABI, functionName: "play", args: [BigInt(targetBps)],
      });
      const receipt = await ctx.client.waitForTransactionReceipt({ hash });
      const events = ctx.parseEventLogs({ abi: WAVE_ABI, eventName: "Played", logs: receipt.logs });
      if (!events.length) throw new Error("no Played event");
      const { crashBps, payout, streakAfter } = events[0].args;
      reveal({
        targetBps,
        crashBps: Number(crashBps),
        payout,
        streakAfter: Number(streakAfter),
      });
    } catch (err) {
      console.error(err);
      ctx.toast(err.shortMessage || err.message || "bank failed");
      resetIdle();
    }
  }

  async function refreshStreak(){
    try {
      const [s, b] = await Promise.all([
        ctx.client.readContract({ address: WAVE_ADDR, abi: WAVE_ABI, functionName: "streak", args: [ctx.account.address] }),
        ctx.client.readContract({ address: WAVE_ADDR, abi: WAVE_ABI, functionName: "bestStreak", args: [ctx.account.address] }),
      ]);
      streakEl.textContent = `streak ${s} · best ${b}`;
    } catch {}
  }
  refreshStreak();

  function reveal({ targetBps, crashBps, payout, streakAfter }){
    state = "revealed";
    const survived = payout > 0n;
    if (survived) {
      flash = 0.45;
      visualAlt = targetBps / 10000; // lock display to what they banked
      multEl.textContent = formatMult(visualAlt);
      subEl.innerHTML = `<span class="ok">SAFE</span> · would have crashed at ${formatMult(crashBps/10000)} · +$${(Number(payout)/1e6).toFixed(2)}`;
      gsap.fromTo(multEl, { scale: 1 }, { scale: 1.18, duration: 0.16, yoyo: true, repeat: 1, ease: "power2.out" });
      if (audio) {
        audio.bell.triggerAttackRelease(440 + Math.min(800, visualAlt * 8), 0.3);
        setTimeout(() => audio.bell.triggerAttackRelease(660 + Math.min(800, visualAlt * 8), 0.3), 80);
      }
      if (navigator.vibrate) navigator.vibrate([25, 30, 25]);
    } else {
      crashed = 1;
      flash = 0.6;
      visualAlt = Math.max(1, crashBps / 10000);
      multEl.textContent = formatMult(visualAlt);
      subEl.innerHTML = `<span class="bad">CRASHED</span> at ${formatMult(crashBps/10000)} · −$1.00`;
      gsap.fromTo(slot, { x: 0 }, { x: 12, duration: 0.05, yoyo: true, repeat: 9, ease: "none", onComplete: () => gsap.set(slot, { x: 0 }) });
      if (audio) {
        audio.thud.triggerAttackRelease("C1", "8n");
        audio.bell.triggerAttackRelease(110, 0.6);
      }
      if (navigator.vibrate) navigator.vibrate([60, 30, 80]);
    }

    if (audio) {
      audio.drone.frequency.rampTo(60, 0.6);
      audio.filt.frequency.rampTo(200, 0.6);
      audio.noise.volume.rampTo(-60, 0.6);
    }
    intensity *= 0.6;

    btnEl.textContent = "AGAIN";
    btnEl.dataset.s = "again";
    btnEl.disabled = false;
    streakEl.textContent = `streak ${streakAfter} · best ${Math.max(streakAfter, parseInt(streakEl.textContent.match(/best (\d+)/)?.[1] ?? "0"))}`;
    refreshStreak();
    ctx.refreshBalance();
  }

  function resetIdle(){
    state = "idle";
    visualAlt = 1.0;
    intensity = 0;
    glitch = 0;
    crashed = 0;
    multEl.textContent = "1.00";
    multEl.style.fontVariationSettings = `"wght" 200`;
    multEl.style.transform = "";
    subEl.textContent = "tap to lift";
    btnEl.textContent = "PLAY";
    btnEl.dataset.s = "idle";
    btnEl.disabled = false;
  }

  btnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state === "idle") startClimb();
    else if (state === "climbing") bank();
    else if (state === "revealed") resetIdle();
  });

  // tapping the card body works the same as the button (reduce friction)
  slot.addEventListener("click", () => {
    if (state === "idle") startClimb();
    else if (state === "climbing") bank();
    else if (state === "revealed") resetIdle();
  });

  return () => {
    mounted = false;
    window.removeEventListener("resize", resize);
    if (audio) {
      try { audio.drone.dispose(); audio.noise.dispose(); audio.filt.dispose();
            audio.bell.dispose(); audio.thud.dispose(); audio.dest.dispose(); } catch {}
    }
  };
}

function formatMult(m){
  if (m < 10)    return m.toFixed(2);
  if (m < 100)   return m.toFixed(1);
  if (m < 1000)  return Math.round(m).toString();
  return (m / 1000).toFixed(1) + "k";
}

// ── card-scoped CSS ────────────────────────────────────────────────────────
const WAVE_CSS = `
.wave-bg {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  display: block;
  z-index: 0;
}
.wave-frame {
  position: absolute; inset: 0;
  display: grid;
  grid-template-rows: auto 1fr auto;
  padding: 56px 24px max(56px, env(safe-area-inset-bottom));
  z-index: 1;
  font-family: 'JetBrains Mono', monospace;
  color: #fff;
  pointer-events: none;
}
.wave-frame button { pointer-events: auto; }
.wave-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: lowercase;
  opacity: 0.75;
}
.wave-tag::before { content: "○ "; opacity: 0.6; }
.wave-streak { font-variant-numeric: tabular-nums; }

.wave-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  pointer-events: none;
}
.wave-mult {
  font-family: 'Inter', sans-serif;
  font-variation-settings: "wght" 200;
  font-size: clamp(120px, 32vw, 280px);
  line-height: 0.85;
  letter-spacing: -0.06em;
  font-feature-settings: "tnum" 1;
  transition: font-variation-settings 0.05s linear;
  text-shadow: 0 0 50px rgba(0,0,0,0.4);
  will-change: font-variation-settings, transform;
}
.wave-mult .x {
  font-size: 0.4em;
  margin-left: 0.05em;
  font-variation-settings: "wght" 300;
  opacity: 0.6;
}
.wave-sub {
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: lowercase;
  opacity: 0.75;
  text-align: center;
  min-height: 1em;
  font-variant-numeric: tabular-nums;
}
.wave-sub .ok  { color: #c5ffb1; letter-spacing: 0.3em; }
.wave-sub .bad { color: #ff7b6b; letter-spacing: 0.3em; }

.wave-foot {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
}
.wave-btn {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  font-size: 18px;
  letter-spacing: 0.32em;
  color: #fff;
  background: transparent;
  border: 1px solid rgba(255,255,255,0.85);
  padding: 18px 60px;
  cursor: pointer;
  border-radius: 0;
  min-width: 240px;
  transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.05s;
  text-transform: uppercase;
}
.wave-btn:hover     { background: rgba(255,255,255,0.10); }
.wave-btn:active    { transform: translateY(1px); }
.wave-btn[disabled] { opacity: 0.5; cursor: wait; }
.wave-btn[data-s="climbing"] { background: rgba(255,255,255,0.92); color: #000; border-color: #fff; }
.wave-btn[data-s="settling"] { background: rgba(0,0,0,0.4); }
.wave-btn[data-s="again"]    { background: rgba(0,0,0,0.4); }

.wave-stake {
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: lowercase;
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}

.wave-fallback {
  position: absolute; inset: 0; display: grid; place-items: center;
  color: #aaa; font-family: monospace; padding: 40px; text-align: center;
}
`;
