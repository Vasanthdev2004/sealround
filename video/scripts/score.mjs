// Original score for the Sealround launch video, synthesized from scratch.
// 120 BPM, one bar = 2 s, 44 bars = 88 s. Writes public/audio/score.wav
// (48 kHz, 16-bit stereo). Every sound here is generated: no samples, no
// third-party audio, so the track is free to use.
//
// Arrangement follows src/timeline.json:
//   bars 0-5   problem: ticking clock, low pad, half-time pulse
//   bar 6      riser into the title
//   bars 7-14  product: impact, bell, groove builds
//   bar 15     breath ("On NEAR testnet")
//   bars 16-27 proof: full groove, impact at the reveal (bar 21)
//   bars 28-30 breakdown under the burn, riser back in
//   bars 31-39 verify, judges, recap: full groove, riser at 39
//   bars 40-43 end: impact, bell motif, final chord rings out

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const timeline = JSON.parse(readFileSync(join(here, "../src/timeline.json"), "utf8"));
const SR = 48000;
const BAR = (60 / timeline.bpm) * 4; // 2 s
const BEAT = BAR / 4;
const LEN = timeline.bars * BAR; // 88 s
const N = Math.ceil(LEN * SR);

// ---------- helpers ----------
let seed = 0x5ea1; // deterministic noise
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const noise = () => rand() * 2 - 1;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const bus = () => ({ L: new Float32Array(N), R: new Float32Array(N) });
const at = (bar, beat = 0) => bar * BAR + beat * BEAT;
const idx = (t) => Math.max(0, Math.min(N, Math.round(t * SR)));

function polyblep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

// Topology-preserving state-variable filter (Zavalishin).
class SVF {
  constructor() {
    this.ic1 = 0;
    this.ic2 = 0;
    this.set(1000, 0.7);
  }
  set(fc, q) {
    fc = Math.min(fc, SR * 0.45);
    const g = Math.tan((Math.PI * fc) / SR);
    const k = 1 / q;
    this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  run(v0) {
    const v3 = v0 - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.low = v2;
    this.band = v1;
    this.high = v0 - this.k * v1 - v2;
    return v2;
  }
}

const pan = (p) => [Math.cos(((p + 1) * Math.PI) / 4), Math.sin(((p + 1) * Math.PI) / 4)];

// ---------- buses ----------
const pad = bus();
const bass = bus();
const drums = bus();
const keys = bus(); // plucks and bells (dry)
const fx = bus();
const verbSend = bus();
const delaySend = bus();
const sidechainKicks = [];

// ---------- chords ----------
const C = {
  Dm9: { root: 38, notes: [50, 53, 57, 60, 64] },
  Bbmaj9: { root: 34, notes: [46, 53, 57, 60, 62] },
  Fmaj9A: { root: 33, notes: [45, 53, 55, 60, 64] },
  Cadd9: { root: 36, notes: [48, 55, 62, 64, 67] },
  Gm9: { root: 31, notes: [43, 53, 58, 62, 69] },
  A7sus: { root: 33, notes: [45, 52, 55, 62, 64] },
  A7: { root: 33, notes: [45, 52, 55, 61, 64] },
  Fmaj9: { root: 41, notes: [53, 57, 60, 64, 67] },
};

// Chord per bar.
const chart = [];
const put = (from, list) => list.forEach((c, i) => (chart[from + i] = c));
put(0, ["Dm9", "Dm9", "Bbmaj9", "Bbmaj9", "Gm9", "A7sus", "A7"]);
put(7, ["Bbmaj9", "Fmaj9A", "Dm9", "Cadd9", "Bbmaj9", "Fmaj9A", "Dm9", "Cadd9"]);
put(15, ["Gm9"]);
put(16, ["Dm9", "Bbmaj9", "Fmaj9A", "Cadd9", "Dm9", "Bbmaj9", "Fmaj9A", "Cadd9", "Dm9", "Bbmaj9", "Fmaj9A", "Cadd9"]);
put(28, ["Bbmaj9", "Bbmaj9", "A7sus"]);
put(31, ["Bbmaj9", "Fmaj9A", "Dm9", "Cadd9", "Bbmaj9", "Fmaj9A", "Dm9", "Cadd9", "A7sus"]);
put(40, ["Bbmaj9", "Bbmaj9", "Fmaj9", "Fmaj9"]);

// Pad brightness per bar (lowpass cutoff in Hz) and level.
function padShape(bar) {
  if (bar < 2) return { cut: 500 + bar * 150, lvl: 0.75 };
  if (bar < 6) return { cut: 750 + (bar - 2) * 120, lvl: 0.8 };
  if (bar === 6) return { cut: 1400, lvl: 0.85 };
  if (bar < 9) return { cut: 1800, lvl: 0.85 };
  if (bar < 15) return { cut: 2200, lvl: 0.7 };
  if (bar === 15) return { cut: 1600, lvl: 0.8 };
  if (bar < 21) return { cut: 2400, lvl: 0.65 };
  if (bar < 28) return { cut: 3400, lvl: 0.65 };
  if (bar < 30) return { cut: 900, lvl: 0.85 };
  if (bar === 30) return { cut: 1500, lvl: 0.8 };
  if (bar < 40) return { cut: 3200, lvl: 0.65 };
  return { cut: 2600, lvl: 0.95 };
}

// ---------- instruments ----------
function padChord(notes, t0, t1, cutStart, cutEnd, lvl, attack, release) {
  const i0 = idx(t0);
  const i1 = idx(t1 + release);
  const len = i1 - i0;
  const dets = [-0.11, 0, 0.11]; // semitones
  const pans = [-0.7, 0, 0.7];
  const fl = new SVF();
  const fr = new SVF();
  const phases = notes.map(() => dets.map(() => rand()));
  for (let n = 0; n < len; n++) {
    const t = n / SR;
    if (n % 32 === 0) {
      const p = Math.min(1, t / Math.max(0.01, t1 - t0));
      const lfo = 1 + 0.12 * Math.sin(2 * Math.PI * 0.11 * (t0 + t));
      const cut = (cutStart + (cutEnd - cutStart) * p) * lfo;
      fl.set(cut, 0.8);
      fr.set(cut, 0.8);
    }
    let l = 0;
    let r = 0;
    for (let a = 0; a < notes.length; a++) {
      for (let v = 0; v < 3; v++) {
        const f = mtof(notes[a] + dets[v]);
        const dt = f / SR;
        let ph = phases[a][v] + dt;
        if (ph >= 1) ph -= 1;
        phases[a][v] = ph;
        const s = 2 * ph - 1 - polyblep(ph, dt);
        const [pl, pr] = pan(pans[v] * (a % 2 ? -1 : 1));
        l += s * pl;
        r += s * pr;
      }
    }
    const env =
      Math.min(1, t / attack) * (t < t1 - t0 ? 1 : Math.exp((-(t - (t1 - t0)) * 4) / release));
    const g = (env * lvl * 0.035);
    pad.L[i0 + n] += fl.run(l) * g;
    pad.R[i0 + n] += fr.run(r) * g;
  }
}

function subNote(midi, t0, t1, lvl) {
  const f = mtof(midi);
  const i0 = idx(t0);
  const i1 = idx(t1 + 0.08);
  let ph = 0;
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    ph += f / SR;
    const s = Math.sin(2 * Math.PI * ph) + 0.25 * Math.sin(4 * Math.PI * ph);
    const env = Math.min(1, t / 0.012) * (i < idx(t1) ? 1 : Math.exp(-(t - (t1 - t0)) * 60));
    const v = Math.tanh(s * 1.4) * env * lvl * 0.33;
    bass.L[i] += v;
    bass.R[i] += v;
  }
}

function kick(t0, lvl = 1, duck = true) {
  const i0 = idx(t0);
  const len = idx(0.55);
  let ph = 0;
  for (let n = 0; n < len && i0 + n < N; n++) {
    const t = n / SR;
    const f = 44 + 120 * Math.exp(-t * 32);
    ph += f / SR;
    const amp = Math.exp(-t * 5.5) * Math.min(1, t / 0.002);
    const click = noise() * Math.exp(-t * 500) * 0.18;
    const v = Math.tanh((Math.sin(2 * Math.PI * ph) * amp + click) * 1.6) * 0.55 * lvl;
    drums.L[i0 + n] += v;
    drums.R[i0 + n] += v;
  }
  if (duck) sidechainKicks.push(t0);
}

function clap(t0, lvl = 1) {
  const i0 = idx(t0);
  const len = idx(0.35);
  const f = new SVF();
  f.set(1400, 1.3);
  for (let n = 0; n < len && i0 + n < N; n++) {
    const t = n / SR;
    let env = 0;
    for (const o of [0, 0.011, 0.022]) if (t >= o) env = Math.max(env, Math.exp(-(t - o) * 90));
    if (t >= 0.03) env = Math.max(env, 0.55 * Math.exp(-(t - 0.03) * 14));
    f.run(noise());
    const v = f.band * env * 0.5 * lvl;
    drums.L[i0 + n] += v * 0.9;
    drums.R[i0 + n] += v;
    verbSend.L[i0 + n] += v * 0.35;
    verbSend.R[i0 + n] += v * 0.35;
  }
}

function hat(t0, lvl = 1, open = false, p = 0.25) {
  const i0 = idx(t0);
  const dec = open ? 9 : 55;
  const len = idx(open ? 0.4 : 0.09);
  const f = new SVF();
  f.set(7800, 0.9);
  const [pl, pr] = pan(p);
  for (let n = 0; n < len && i0 + n < N; n++) {
    const t = n / SR;
    f.run(noise());
    const v = f.high * Math.exp(-t * dec) * 0.13 * lvl;
    drums.L[i0 + n] += v * pl;
    drums.R[i0 + n] += v * pr;
  }
}

function tick(t0, lvl = 1, p = 0) {
  const i0 = idx(t0);
  const len = idx(0.05);
  const [pl, pr] = pan(p);
  for (let n = 0; n < len && i0 + n < N; n++) {
    const t = n / SR;
    const v =
      (Math.sin(2 * Math.PI * 2100 * t) * 0.7 + Math.sin(2 * Math.PI * 4230 * t) * 0.3) *
      Math.exp(-t * 160) *
      0.12 *
      lvl;
    fx.L[i0 + n] += v * pl;
    fx.R[i0 + n] += v * pr;
    verbSend.L[i0 + n] += v * 0.15;
    verbSend.R[i0 + n] += v * 0.15;
  }
}

function pluck(midi, t0, lvl = 1, p = 0, bright = 1) {
  const f0 = mtof(midi);
  const i0 = idx(t0);
  const len = idx(0.9);
  const flt = new SVF();
  let a = rand();
  let b = rand();
  const [pl, pr] = pan(p);
  for (let n = 0; n < len && i0 + n < N; n++) {
    const t = n / SR;
    if (n % 16 === 0) flt.set(260 + 4200 * bright * Math.exp(-t * 16), 1.1);
    const fa = f0 * 1.0035;
    const fb = f0 * 0.9965;
    a += fa / SR;
    if (a >= 1) a -= 1;
    b += fb / SR;
    if (b >= 1) b -= 1;
    const s =
      (2 * a - 1 - polyblep(a, fa / SR)) * 0.5 + (2 * b - 1 - polyblep(b, fb / SR)) * 0.5;
    const env = Math.min(1, t / 0.003) * Math.exp(-t * 5.2);
    const v = flt.run(s) * env * 0.11 * lvl;
    keys.L[i0 + n] += v * pl;
    keys.R[i0 + n] += v * pr;
    delaySend.L[i0 + n] += v * 0.45 * pl;
    delaySend.R[i0 + n] += v * 0.45 * pr;
    verbSend.L[i0 + n] += v * 0.3;
    verbSend.R[i0 + n] += v * 0.3;
  }
}

// Soft glass bell: two-operator FM with a high partial.
function bell(midi, t0, lvl = 1, p = 0, dur = 4.5) {
  const f = mtof(midi);
  const i0 = idx(t0);
  const len = idx(dur);
  const [pl, pr] = pan(p);
  for (let n = 0; n < len && i0 + n < N; n++) {
    const t = n / SR;
    const idxm = 2.2 * Math.exp(-t * 3.5);
    const mod = Math.sin(2 * Math.PI * f * 2 * t) * idxm;
    const s =
      Math.sin(2 * Math.PI * f * t + mod) * Math.exp(-t * 1.1) +
      0.16 * Math.sin(2 * Math.PI * f * 4.007 * t) * Math.exp(-t * 5);
    const v = s * Math.min(1, t / 0.002) * 0.11 * lvl;
    keys.L[i0 + n] += v * pl;
    keys.R[i0 + n] += v * pr;
    verbSend.L[i0 + n] += v * 0.7;
    verbSend.R[i0 + n] += v * 0.7;
    delaySend.L[i0 + n] += v * 0.25 * pl;
    delaySend.R[i0 + n] += v * 0.25 * pr;
  }
}

// Noise riser ending exactly at tEnd.
function riser(tEnd, dur, lvl = 1) {
  const i0 = idx(tEnd - dur);
  const len = idx(dur);
  const f = new SVF();
  let ph = 0;
  for (let n = 0; n < len; n++) {
    const t = n / SR;
    const p = t / dur;
    if (n % 16 === 0) f.set(300 * Math.pow(8000 / 300, p), 2.2);
    f.run(noise());
    const tone = Math.sin(2 * Math.PI * ph) * 0.25;
    ph += (180 * Math.pow(4, p)) / SR;
    const v = (f.band * 0.9 + tone * p) * Math.pow(p, 2.2) * 0.32 * lvl;
    const w = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.8 * t);
    fx.L[i0 + n] += v * (0.6 + 0.4 * w);
    fx.R[i0 + n] += v * (1 - 0.4 * w);
    verbSend.L[i0 + n] += v * 0.4;
    verbSend.R[i0 + n] += v * 0.4;
  }
}

function impact(t0, lvl = 1) {
  const i0 = idx(t0);
  const len = idx(2.6);
  const f = new SVF();
  f.set(1800, 0.7);
  let ph = 0;
  for (let n = 0; n < len && i0 + n < N; n++) {
    const t = n / SR;
    const fr = 30 + 55 * Math.exp(-t * 4);
    ph += fr / SR;
    const boom = Math.sin(2 * Math.PI * ph) * Math.exp(-t * 1.9) * 0.75;
    f.run(noise());
    const air = f.low * Math.exp(-t * 7) * 0.5;
    const v = Math.tanh((boom + air) * 1.3) * 0.62 * lvl;
    fx.L[i0 + n] += v;
    fx.R[i0 + n] += v;
    verbSend.L[i0 + n] += air * 0.6 * lvl;
    verbSend.R[i0 + n] += air * 0.6 * lvl;
  }
  sidechainKicks.push(t0);
}

// Short air whoosh for a cut, centred on tMid.
function whoosh(tMid, dur = 0.7, lvl = 1, dir = 1) {
  const i0 = idx(tMid - dur * 0.6);
  const len = idx(dur);
  const f = new SVF();
  for (let n = 0; n < len && i0 + n < N; n++) {
    const t = n / SR;
    const p = t / dur;
    if (n % 16 === 0) f.set(500 * Math.pow(9, Math.sin(Math.PI * p)), 1.4);
    f.run(noise());
    const env = Math.pow(Math.sin(Math.PI * Math.min(1, p)), 2);
    const v = f.band * env * 0.22 * lvl;
    const pp = dir * (p * 2 - 1) * 0.8;
    const [pl, pr] = pan(pp);
    fx.L[i0 + n] += v * pl;
    fx.R[i0 + n] += v * pr;
    verbSend.L[i0 + n] += v * 0.25;
    verbSend.R[i0 + n] += v * 0.25;
  }
}

// Falling tone under the burn counter.
function downlifter(t0, dur, lvl = 1) {
  const i0 = idx(t0);
  const len = idx(dur);
  let ph = 0;
  const f = new SVF();
  for (let n = 0; n < len && i0 + n < N; n++) {
    const t = n / SR;
    const p = t / dur;
    ph += (900 * Math.pow(1 / 9, p)) / SR;
    const s = 2 * (ph % 1) - 1;
    if (n % 32 === 0) f.set(2000 * Math.pow(0.15, p), 1.5);
    const v = f.run(s) * Math.sin(Math.PI * Math.min(1, p * 1.1)) * 0.12 * lvl;
    fx.L[i0 + n] += v;
    fx.R[i0 + n] += v;
    verbSend.L[i0 + n] += v * 0.5;
    verbSend.R[i0 + n] += v * 0.5;
  }
}

// ---------- arrangement ----------
// Pad, one chord per bar, slightly overlapping.
for (let b = 0; b < timeline.bars; b++) {
  const name = chart[b];
  if (!name) continue;
  const prev = chart[b - 1];
  if (name === prev && b !== 40) continue; // held chords render as one
  let end = b + 1;
  while (end < timeline.bars && chart[end] === name && end !== 40) end++;
  const s0 = padShape(b);
  const s1 = padShape(end - 1);
  const t0 = at(b) - 0.02;
  const t1 = end >= timeline.bars ? LEN - 1.6 : at(end);
  const atk = b < 7 || b >= 28 && b < 31 || b >= 40 ? 0.6 : 0.12;
  const rel = end >= timeline.bars ? 1.6 : 0.5;
  padChord(C[name].notes, t0, t1, s0.cut, s1.cut * 1.1, s0.lvl, atk, rel);
}

// Bass.
for (let b = 2; b < timeline.bars; b++) {
  const name = chart[b];
  if (!name) continue;
  const root = C[name].root;
  if (b < 6) subNote(root, at(b), at(b + 1) - 0.02, 0.42);
  else if (b === 6) subNote(root, at(b), at(b, 3), 0.4);
  else if (b < 9) subNote(root, at(b), at(b + 1) - 0.02, 0.55);
  else if (b === 15) subNote(root, at(b), at(b, 2), 0.5);
  else if (b < 28 || (b >= 31 && b < 40)) {
    // Offbeat eighths with the root on the one: drives without crowding.
    subNote(root, at(b), at(b, 0.45), 0.72);
    for (let q = 0; q < 4; q++) subNote(root + (q === 3 ? 12 : 0), at(b, q + 0.5), at(b, q + 0.95), 0.62);
  } else if (b < 30) subNote(root, at(b), at(b + 1) - 0.02, 0.45);
  else if (b === 30) subNote(root, at(b), at(b, 3.5), 0.4);
  else if (b >= 40 && b < 42) subNote(root, at(b), at(b + 1) - 0.02, 0.55);
  else if (b >= 42) subNote(C[name].root - 12, at(b), b === 43 ? LEN - 1.4 : at(b + 1), 0.5);
}

// Clock ticks: the race. Eighths, accent on the beat, 16ths in the riser bars.
for (let b = 0; b < 7; b++) {
  const sub = b === 6 ? 4 : 2;
  for (let s = 0; s < 4 * sub; s++) {
    const beatPos = s / sub;
    const acc = s % sub === 0 ? 1 : 0.55;
    const ramp = b === 6 ? 0.7 + 0.5 * (s / (4 * sub)) : 1;
    tick(at(b, beatPos), acc * ramp, s % 2 ? 0.35 : -0.35);
  }
}
for (let s = 0; s < 16; s++) tick(at(30, s / 4), (s % 4 ? 0.5 : 0.9) * (0.7 + (0.5 * s) / 16), s % 2 ? 0.35 : -0.35);

// Problem: half-time pulse.
for (let b = 2; b < 6; b++) {
  kick(at(b, 0), 0.7);
  kick(at(b, 2), 0.55);
}

// Risers and impacts on the big cuts.
riser(at(7), BAR, 1);
impact(at(7), 1);
bell(74, at(7), 1, -0.2); // D5
bell(81, at(7, 0.5), 0.6, 0.3); // A5
bell(77, at(7, 1), 0.45, 0); // F5

whoosh(at(15), 0.8, 1, 1);
impact(at(15), 0.45);
bell(72, at(15), 0.55, 0.2);

riser(at(21), BAR * 0.75, 0.7);
impact(at(21), 0.9);
bell(74, at(21), 0.8, -0.3);
bell(77, at(21, 0.75), 0.5, 0.3);
bell(81, at(21, 1.5), 0.4, 0);
hat(at(21), 1.2, true, 0);

downlifter(at(28), BAR * 2, 1);
riser(at(31), BAR, 0.9);
impact(at(31), 0.85);
hat(at(31), 1.1, true, 0);

riser(at(40), BAR, 1.05);
impact(at(40), 1);
// Closing motif: the title notes, then the resolution.
bell(74, at(40), 0.9, -0.2);
bell(81, at(40, 0.5), 0.6, 0.3);
bell(77, at(40, 1), 0.5, 0);
bell(72, at(41, 0), 0.45, -0.3);
bell(76, at(42, 0), 0.8, 0.2, 6);
bell(84, at(42, 0.5), 0.45, -0.2, 6);

// Cut whooshes on scene changes inside the groove (soft).
for (const b of [9, 11, 13, 16, 19, 24, 26, 28, 35, 38]) whoosh(at(b), 0.55, 0.5, b % 2 ? 1 : -1);

// Grooves.
function groove(b, { clapOn = true, ghost = false, arp = true, arpLvl = 1, kickLvl = 1 } = {}) {
  for (let q = 0; q < 4; q++) kick(at(b, q), kickLvl);
  if (clapOn) {
    clap(at(b, 1), 0.9);
    clap(at(b, 3), 0.95);
  }
  for (let q = 0; q < 4; q++) hat(at(b, q + 0.5), 0.9, false, 0.3);
  if (ghost) for (let s = 0; s < 16; s++) if (s % 2) hat(at(b, s / 4), 0.35 + 0.25 * (s % 4 === 3), false, -0.35);
  if (arp) {
    const ns = C[chart[b]].notes.map((n) => n + 12);
    const pat = [0, 2, 4, 1, 3, 2, 4, 3, 0, 2, 4, 1, 3, 4, 2, 1];
    for (let s = 0; s < 16; s++) {
      const n = ns[pat[s] % ns.length];
      const vel = s % 4 === 0 ? 1 : s % 2 ? 0.6 : 0.8;
      pluck(n, at(b, s / 4), vel * arpLvl, s % 2 ? 0.4 : -0.4, 0.7 + 0.3 * (s % 4 === 0));
    }
  }
}

for (let b = 7; b < 9; b++) kick(at(b, 0), 0.8); // title: one soft beat a bar
for (let b = 9; b < 15; b++) groove(b, { clapOn: b >= 11, ghost: b >= 13, arpLvl: b < 11 ? 0.75 : 0.95 });
groove(15, { clapOn: false, arp: true, arpLvl: 0.5, kickLvl: 0 });
for (let b = 16; b < 28; b++) groove(b, { ghost: b >= 18, arpLvl: b >= 21 ? 1.05 : 0.95 });
// Burn breakdown: heartbeat only.
for (let b = 28; b < 30; b++) {
  kick(at(b, 0), 0.55, false);
  kick(at(b, 0.5), 0.4, false);
  kick(at(b, 2), 0.5, false);
  kick(at(b, 2.5), 0.35, false);
}
for (let b = 31; b < 39; b++) groove(b, { ghost: true, arpLvl: 1 });
// Bar 39: build with a clap roll into the end.
for (let q = 0; q < 4; q++) kick(at(39, q), 0.9);
for (let s = 0; s < 16; s++) clap(at(39, s / 4), 0.25 + 0.55 * (s / 16));

// ---------- effects ----------
// Ping-pong delay, dotted eighth.
{
  const d = idx(BEAT * 0.75);
  const fb = 0.38;
  const lp = new SVF();
  lp.set(3500, 0.7);
  const outL = new Float32Array(N);
  const outR = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const inL = delaySend.L[i];
    const inR = delaySend.R[i];
    const dl = i >= d ? outR[i - d] : 0;
    const dr = i >= d ? outL[i - d] : 0;
    outL[i] = lp.run(inL + inR * 0.5 + dl * fb);
    outR[i] = inR * 0.5 + dr * fb;
  }
  for (let i = 0; i < N; i++) {
    keys.L[i] += outL[i] * 0.55;
    keys.R[i] += outR[i] * 0.55;
    verbSend.L[i] += outL[i] * 0.2;
    verbSend.R[i] += outR[i] * 0.2;
  }
}

// Freeverb.
function freeverb(inL, inR, room = 0.86, damp = 0.25) {
  const scale = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const aps = [556, 441, 341, 225];
  const mk = (spread) => ({
    c: combs.map((l) => ({ buf: new Float32Array(Math.round((l + spread) * scale)), i: 0, f: 0 })),
    a: aps.map((l) => ({ buf: new Float32Array(Math.round((l + spread) * scale)), i: 0 })),
  });
  const chans = [mk(0), mk(23)];
  const outs = [new Float32Array(N), new Float32Array(N)];
  const ins = [inL, inR];
  for (let ch = 0; ch < 2; ch++) {
    const { c, a } = chans[ch];
    const inp = ins[ch];
    const out = outs[ch];
    for (let i = 0; i < N; i++) {
      const x = (inp[i] + ins[1 - ch][i]) * 0.015;
      let s = 0;
      for (const cb of c) {
        const y = cb.buf[cb.i];
        cb.f = y * (1 - damp) + cb.f * damp;
        cb.buf[cb.i] = x + cb.f * room;
        if (++cb.i >= cb.buf.length) cb.i = 0;
        s += y;
      }
      for (const ap of a) {
        const y = ap.buf[ap.i];
        ap.buf[ap.i] = s + y * 0.5;
        if (++ap.i >= ap.buf.length) ap.i = 0;
        s = y - s;
      }
      out[i] = s;
    }
  }
  return outs;
}

// Pad gets a little room too.
for (let i = 0; i < N; i++) {
  verbSend.L[i] += pad.L[i] * 0.25;
  verbSend.R[i] += pad.R[i] * 0.25;
}
const [vL, vR] = freeverb(verbSend.L, verbSend.R);

// Sidechain gain from kicks and impacts.
const duck = new Float32Array(N).fill(1);
for (const t0 of sidechainKicks) {
  const i0 = idx(t0);
  const len = idx(0.4);
  for (let n = 0; n < len && i0 + n < N; n++) {
    const t = n / SR;
    const g = 1 - 0.55 * Math.min(1, t / 0.004) * Math.exp(-t * 9);
    if (g < duck[i0 + n]) duck[i0 + n] = g;
  }
}

// ---------- mix ----------
const outL = new Float32Array(N);
const outR = new Float32Array(N);
const hpL = new SVF();
const hpR = new SVF();
hpL.set(28, 0.7);
hpR.set(28, 0.7);
for (let i = 0; i < N; i++) {
  const d = duck[i];
  let l = pad.L[i] * 2.1 * d + bass.L[i] * d + drums.L[i] * 0.95 + keys.L[i] * 2.3 * (0.6 + 0.4 * d) + fx.L[i] + vL[i] * 0.9;
  let r = pad.R[i] * 2.1 * d + bass.R[i] * d + drums.R[i] * 0.95 + keys.R[i] * 2.3 * (0.6 + 0.4 * d) + fx.R[i] + vR[i] * 0.9;
  hpL.run(l);
  hpR.run(r);
  l = hpL.high;
  r = hpR.high;
  outL[i] = l;
  outR[i] = r;
}

// Gentle bus glue: soft clip, then normalise to -1 dBFS peak.
let peak = 0;
for (let i = 0; i < N; i++) {
  outL[i] = Math.tanh(outL[i] * 1.25) / 1.25;
  outR[i] = Math.tanh(outR[i] * 1.25) / 1.25;
  peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
}
const gain = Math.pow(10, -1 / 20) / peak;
let sumSq = 0;
const fadeIn = idx(0.25);
const fadeOutStart = idx(LEN - 2.2);
for (let i = 0; i < N; i++) {
  let g = gain;
  if (i < fadeIn) g *= i / fadeIn;
  if (i > fadeOutStart) g *= Math.pow(1 - (i - fadeOutStart) / (N - fadeOutStart), 1.6);
  outL[i] *= g;
  outR[i] *= g;
  sumSq += outL[i] * outL[i] + outR[i] * outR[i];
}
const rms = Math.sqrt(sumSq / (2 * N));

// ---------- write WAV ----------
const data = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, outL[i])) * 32767), i * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, outR[i])) * 32767), i * 4 + 2);
}
const hdr = Buffer.alloc(44);
hdr.write("RIFF", 0);
hdr.writeUInt32LE(36 + data.length, 4);
hdr.write("WAVE", 8);
hdr.write("fmt ", 12);
hdr.writeUInt32LE(16, 16);
hdr.writeUInt16LE(1, 20);
hdr.writeUInt16LE(2, 22);
hdr.writeUInt32LE(SR, 24);
hdr.writeUInt32LE(SR * 4, 28);
hdr.writeUInt16LE(4, 32);
hdr.writeUInt16LE(16, 34);
hdr.write("data", 36);
hdr.writeUInt32LE(data.length, 40);
const out = join(here, "../public/audio/score.wav");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([hdr, data]));
console.log(`score.wav: ${LEN}s, peak -1 dBFS, RMS ${(20 * Math.log10(rms)).toFixed(1)} dBFS, ${sidechainKicks.length} kicks`);

if (process.env.SCORE_STATS) {
  const rmsOf = (b, b0, b1) => {
    let s = 0;
    const i0 = idx(at(b0));
    const i1 = idx(at(b1));
    for (let i = i0; i < i1; i++) s += b.L[i] * b.L[i] + b.R[i] * b.R[i];
    return (20 * Math.log10(Math.sqrt(s / (2 * (i1 - i0))) + 1e-9)).toFixed(1);
  };
  for (const [name, b] of Object.entries({ pad, bass, drums, keys, fx })) {
    console.log(name.padEnd(6), "intro", rmsOf(b, 2, 6), "title", rmsOf(b, 7, 9), "groove", rmsOf(b, 16, 20), "break", rmsOf(b, 28, 30), "end", rmsOf(b, 40, 43));
  }
  const sec = (b0, b1) => {
    let s = 0;
    const i0 = idx(at(b0));
    const i1 = idx(at(b1));
    for (let i = i0; i < i1; i++) s += outL[i] * outL[i] + outR[i] * outR[i];
    return (20 * Math.log10(Math.sqrt(s / (2 * (i1 - i0))))).toFixed(1);
  };
  console.log("master", "cold", sec(0, 2), "intro", sec(2, 6), "title", sec(7, 9), "build", sec(9, 15), "groove", sec(16, 28), "break", sec(28, 30), "verify", sec(31, 39), "end", sec(40, 43));
}
