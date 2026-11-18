#!/usr/bin/env node
// Makes the room's sound effects in web/public/sounds (the speaker ESP32 and the TV play them).
//
//   ELEVENLABS_API_KEY=... node scripts/make-sounds.mjs      ElevenLabs Sound Effects API (text to sound effect)
//   node scripts/make-sounds.mjs --synth                     procedural placeholders, synthesized here (no key)
//   options: --only start,win   just these     --all   with --synth, also redo join and tap (the original two)
//            --out <dir>        write somewhere else (default web/public/sounds)
//
// Every file: mono 16-bit PCM WAV, 22.05 kHz (lastcall.wav: 8 kHz, it is 3.5 s of ticks), leading silence
// trimmed, short fades, normalized (about -14 dBFS RMS, peaks under -1 dBFS), under 60 KB (the speaker streams any length, but small files
// start instantly over a hotspot and stay cheap in the repo). firmware/speaker/speaker.ino plays 8/16-bit PCM WAV
// at 4-48 kHz, mono or stereo.
//
// ElevenLabs (checked against the API reference, Nov 18 2026):
//   POST https://api.elevenlabs.io/v1/sound-generation?output_format=pcm_22050
//   header xi-api-key, body { text, duration_seconds (0.5-30), prompt_influence (0-1), model_id }
//   model eleven_text_to_sound_v3 (ELEVENLABS_SFX_MODEL overrides; falls back to eleven_text_to_sound_v2)
// The key is read from the environment only and never printed. If ElevenLabs fails for one sound, its current
// file is kept and the script says so.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join as joinPath, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = resolve(opt("--out") ?? joinPath(HERE, "../public/sounds"));
const RATE = 22050;
const MAX_BYTES = 60_000;
const PEAK = 0.89; // -1 dBFS
const RMS_TARGET = 0.2; // about -14 dBFS
const API_BASE = ((process.env.ELEVENLABS_BASE_URL || "").trim() || "https://api.elevenlabs.io").replace(/\/+$/, "");

// ---------------------------------------------------------------- the sounds
// prompt/seconds: what ElevenLabs is asked for. max: seconds kept. synth: the procedural placeholder.
const SOUNDS = [
  { name: "join", keep: true, prompt: "Short bright friendly two-note notification chime, clean, no reverb tail", seconds: 0.8, max: 0.6, synth: join },
  { name: "tap", keep: true, prompt: "Single soft UI tap click pop, very short", seconds: 0.5, max: 0.2, synth: tap },
  { name: "start", prompt: "Fast airy whoosh swoosh, sports broadcast transition, rising", seconds: 1, max: 0.9, synth: whoosh },
  { name: "lastcall", rate: 8000, prompt: "Countdown: four wooden clock ticks exactly one second apart, then a bright ding", seconds: 4, max: 3.5, synth: lastcall },
  { name: "lock", prompt: "Heavy metal latch clunk, vault door locking shut, short and punchy", seconds: 0.7, max: 0.5, synth: clunk },
  { name: "win", prompt: "Short triumphant brass fanfare, stadium celebration, bright major chord ending", seconds: 1.5, max: 1.3, synth: fanfare },
  { name: "lose", prompt: "Small crowd groaning aww in disappointment, short", seconds: 1.5, max: 1.25, synth: aww },
  { name: "siren", prompt: "Short stadium alert siren, two quick rising wails, attention call", seconds: 1.5, max: 1.3, synth: siren },
  { name: "cheer", prompt: "Stadium crowd erupting in cheers and applause after a touchdown", seconds: 2, max: 1.3, synth: cheer },
  { name: "coin", prompt: "Coins payout ka-ching, cash register bell with coin jingle", seconds: 1, max: 0.8, synth: coin },
];

// ---------------------------------------------------------------- tiny DSP kit

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Band-pass biquad (RBJ, constant 0 dB peak gain); set() may be called every sample to sweep it. */
function bandpass(rate) {
  let b0 = 0, b2 = 0, a1 = 0, a2 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return {
    set(f, q) {
      const w = (2 * Math.PI * Math.min(f, rate * 0.45)) / rate;
      const al = Math.sin(w) / (2 * q);
      const a0 = 1 + al;
      b0 = al / a0;
      b2 = -al / a0;
      a1 = (-2 * Math.cos(w)) / a0;
      a2 = (1 - al) / a0;
      return this;
    },
    run(x) {
      const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      return y;
    },
  };
}

const TAU = 2 * Math.PI;
const env = (t, attack, tau) => (t < 0 ? 0 : t < attack ? t / attack : Math.exp(-(t - attack) / tau));

/** Adds a decaying tone with partials [[ratio, gain], ...] at time t0. */
function bell(out, rate, t0, f, partials, tau, gain = 1, attack = 0.002) {
  const n0 = Math.floor(t0 * rate);
  const len = Math.min(out.length - n0, Math.floor((attack + tau * 7) * rate));
  for (let i = 0; i < len; i++) {
    const t = i / rate;
    let s = 0;
    for (const [r, g] of partials) s += g * Math.sin(TAU * f * r * t);
    out[n0 + i] += gain * env(t, attack, tau) * s;
  }
}

function join(rate) {
  const out = new Float32Array(Math.round(0.5 * rate));
  bell(out, rate, 0, 659.25, [[1, 1], [2, 0.25]], 0.12);
  bell(out, rate, 0.09, 987.77, [[1, 1], [2, 0.2]], 0.16);
  return out;
}

function tap(rate) {
  const out = new Float32Array(Math.round(0.12 * rate));
  const r = rng(7);
  bell(out, rate, 0, 1900, [[1, 1], [2.4, 0.3]], 0.018);
  for (let i = 0; i < rate * 0.004; i++) out[i] += (r() * 2 - 1) * 0.5 * (1 - i / (rate * 0.004));
  return out;
}

function whoosh(rate) {
  const T = 0.9;
  const out = new Float32Array(Math.round(T * rate));
  const r = rng(11);
  const bp = bandpass(rate), bp2 = bandpass(rate);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const x = Math.min(1, t / 0.72);
    const f = 280 * Math.pow(4200 / 280, x); // exponential sweep up
    const n = r() * 2 - 1;
    const a = Math.pow(Math.sin(Math.PI * Math.min(1, t / 0.85)), 1.6) * (t < 0.48 ? 1 : Math.max(0, 1 - (t - 0.48) / 0.4));
    ph += (TAU * (380 + 900 * x)) / rate;
    out[i] = a * (bp.set(f, 1.4).run(n) * 2.2 + bp2.set(f * 1.9, 3).run(n) * 0.8) + a * 0.06 * Math.sin(ph);
  }
  return out;
}

function lastcall(rate) {
  const out = new Float32Array(Math.round(3.5 * rate));
  const r = rng(5);
  for (let k = 0; k < 3; k++) {
    const t0 = k;
    const f = k % 2 ? 950 : 1250;
    bell(out, rate, t0, f, [[1, 1], [2.1, 0.35]], 0.03, 0.9, 0.001);
    const n0 = Math.floor(t0 * rate);
    for (let i = 0; i < rate * 0.006; i++) out[n0 + i] += (r() * 2 - 1) * 0.6 * (1 - i / (rate * 0.006));
  }
  // The last second: a bright ding (the lock clunk follows on the next sound).
  bell(out, rate, 3, 1760, [[1, 1], [2, 0.4], [1.5, 0.2]], 0.16, 1, 0.003);
  return out;
}

function clunk(rate) {
  const out = new Float32Array(Math.round(0.45 * rate));
  const r = rng(3);
  const bp = bandpass(rate).set(900, 0.9);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const f = 55 + 45 * Math.exp(-t / 0.04);
    ph += (TAU * f) / rate;
    const thump = Math.sin(ph) * env(t, 0.002, 0.085);
    const noise = bp.run(r() * 2 - 1) * env(t, 0.0005, 0.012) * 3;
    out[i] = thump + noise;
  }
  bell(out, rate, 0, 420, [[1, 1], [2.69, 0.6], [5.26, 0.35]], 0.05, 0.28);
  bell(out, rate, 0.075, 610, [[1, 1], [2.4, 0.5]], 0.03, 0.18);
  return out;
}

function brassNote(out, rate, t0, dur, f, gain) {
  const n0 = Math.floor(t0 * rate);
  const len = Math.min(out.length - n0, Math.floor((dur + 0.25) * rate));
  for (let i = 0; i < len; i++) {
    const t = i / rate;
    const a = t < 0.018 ? t / 0.018 : t < dur ? 1 - 0.15 * ((t - 0.018) / dur) : 0.85 * Math.exp(-(t - dur) / 0.07);
    const vib = 1 + (t > 0.15 ? 0.006 * Math.sin(TAU * 5.5 * t) : 0);
    const bright = 0.5 + 0.5 * a;
    let s = 0;
    for (let h = 1; h <= 8; h++) s += (Math.pow(bright, h - 1) / h) * Math.sin(TAU * f * h * vib * t);
    out[n0 + i] += gain * a * s;
  }
}

function fanfare(rate) {
  const out = new Float32Array(Math.round(1.3 * rate));
  const G4 = 392, C5 = 523.25, E5 = 659.25, G5 = 783.99;
  brassNote(out, rate, 0.0, 0.1, G4, 0.8);
  brassNote(out, rate, 0.12, 0.1, C5, 0.8);
  brassNote(out, rate, 0.24, 0.1, E5, 0.8);
  for (const [f, g] of [[G5, 0.8], [E5, 0.5], [C5, 0.5], [C5 / 2, 0.35]]) brassNote(out, rate, 0.36, 0.7, f, g);
  return out;
}

function aww(rate) {
  const T = 1.25;
  const out = new Float32Array(Math.round(T * rate));
  const r = rng(21);
  for (let v = 0; v < 7; v++) {
    const f0 = 190 + r() * 120;
    const onset = r() * 0.09;
    const f1 = bandpass(rate).set(650 + r() * 120, 5);
    const f2 = bandpass(rate).set(1000 + r() * 150, 6);
    let ph = 0;
    for (let i = Math.floor(onset * rate); i < out.length; i++) {
      const t = i / rate - onset;
      const glide = 1 - 0.28 * Math.min(1, t / 1.0); // "aww" falls
      ph += (f0 * glide * (1 + 0.01 * Math.sin(TAU * (4 + v) * t))) / rate;
      const saw = 2 * (ph - Math.floor(ph)) - 1;
      const a = Math.min(1, t / 0.16) * Math.max(0, 1 - Math.max(0, t - 0.55) / 0.6);
      out[i] += (a * (f1.run(saw) * 1.0 + f2.run(saw) * 0.6)) / 3;
    }
  }
  const br = bandpass(rate).set(1200, 0.7);
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    out[i] += br.run(r() * 2 - 1) * 0.05 * Math.min(1, t / 0.2) * Math.max(0, 1 - t / T);
  }
  return out;
}

function siren(rate) {
  const T = 1.25;
  const out = new Float32Array(Math.round(T * rate));
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const f = 620 + 640 * (0.5 - 0.5 * Math.cos((TAU * t) / 0.6));
    ph += (TAU * f) / rate;
    const s = Math.sin(ph) + 0.33 * Math.sin(3 * ph) + 0.18 * Math.sin(5 * ph);
    const a = Math.min(1, t / 0.03) * Math.min(1, (T - t) / 0.12);
    out[i] = a * s;
  }
  return out;
}

function cheer(rate) {
  const T = 1.3;
  const out = new Float32Array(Math.round(T * rate));
  const r = rng(42);
  const lo = bandpass(rate).set(450, 0.7);
  const hi = bandpass(rate).set(1500, 0.6);
  const lfo = Array.from({ length: 6 }, () => ({ f: 3 + r() * 7, p: r() * TAU }));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const n = r() * 2 - 1;
    let chatter = 0;
    for (const l of lfo) chatter += 0.5 + 0.5 * Math.sin(TAU * l.f * t + l.p);
    chatter /= lfo.length;
    const a = Math.min(1, t / 0.22) * (t < 0.9 ? 1 : Math.max(0, 1 - (t - 0.9) / 0.4));
    out[i] = a * (0.55 + 0.45 * chatter) * (lo.run(n) * 1.6 + hi.run(n) * 1.2);
  }
  // A few "whoo!"s on top.
  for (let v = 0; v < 3; v++) {
    const onset = 0.08 + r() * 0.25;
    const f0 = 480 + r() * 250;
    let ph = 0;
    for (let i = Math.floor(onset * rate); i < out.length; i++) {
      const t = i / rate - onset;
      const f = f0 * (1 + 0.55 * Math.min(1, t / 0.35)) * (1 + 0.02 * Math.sin(TAU * 6 * t));
      ph += (TAU * f) / rate;
      const a = Math.min(1, t / 0.05) * Math.max(0, 1 - t / 0.75);
      out[i] += 0.12 * a * (Math.sin(ph) + 0.3 * Math.sin(2 * ph));
    }
  }
  // Claps.
  for (let k = 0; k < 18; k++) {
    const n0 = Math.floor((0.15 + r() * (T - 0.4)) * rate);
    const bp = bandpass(rate).set(1100 + r() * 900, 1.2);
    for (let i = 0; i < rate * 0.012 && n0 + i < out.length; i++) out[n0 + i] += bp.run(r() * 2 - 1) * 1.4 * Math.exp(-i / (rate * 0.003));
  }
  return out;
}

function coin(rate) {
  const out = new Float32Array(Math.round(0.65 * rate));
  const sq = [[1, 1], [3, 0.3], [5, 0.12]];
  bell(out, rate, 0, 987.77, sq, 0.06, 0.8);
  bell(out, rate, 0.075, 1318.51, sq, 0.2, 0.9);
  const r = rng(9);
  for (let k = 0; k < 6; k++) bell(out, rate, 0.1 + r() * 0.3, 2800 + r() * 2200, [[1, 1]], 0.03, 0.12);
  return out;
}

// ---------------------------------------------------------------- shaping and WAV

function trimLeading(x, rate, thresh = 0.0056) {
  // -45 dBFS relative to the peak
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (!peak) return x;
  let i = 0;
  while (i < x.length && Math.abs(x[i]) < peak * thresh) i++;
  return x.subarray(Math.max(0, i - Math.round(rate * 0.002)));
}

function finish(x, rate, maxSec) {
  x = trimLeading(x, rate);
  const maxN = Math.min(Math.round(maxSec * rate), Math.floor((MAX_BYTES - 44) / 2));
  const y = Float32Array.from(x.subarray(0, Math.min(x.length, maxN)));
  const fin = Math.round(rate * 0.003);
  const fout = Math.min(y.length, Math.round(rate * 0.06));
  for (let i = 0; i < fin && i < y.length; i++) y[i] *= i / fin;
  for (let i = 0; i < fout; i++) y[y.length - 1 - i] *= i / fout;
  // Even loudness across the set (a square-ish siren would otherwise drown a clunk): scale to RMS_TARGET,
  // but never past a -1 dBFS peak.
  let peak = 0, ss = 0;
  for (const v of y) {
    peak = Math.max(peak, Math.abs(v));
    ss += v * v;
  }
  const rms = Math.sqrt(ss / Math.max(1, y.length));
  if (peak > 0) {
    const g = Math.min(PEAK / peak, RMS_TARGET / rms);
    for (let i = 0; i < y.length; i++) y[i] *= g;
  }
  return y;
}

function wav(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write("WAVE", 8, "latin1");
  b.write("fmt ", 12, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return b;
}

/** Mono float samples and rate from a 16-bit PCM WAV, or null. */
function readWav(buf) {
  if (buf.length < 44 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") return null;
  let p = 12, ch = 1, rate = RATE, bits = 16;
  while (p + 8 <= buf.length) {
    const id = buf.toString("latin1", p, p + 4);
    const sz = buf.readUInt32LE(p + 4);
    if (id === "fmt ") {
      ch = buf.readUInt16LE(p + 10);
      rate = buf.readUInt32LE(p + 12);
      bits = buf.readUInt16LE(p + 22);
    } else if (id === "data") {
      if (bits !== 16) return null;
      const end = Math.min(buf.length, sz === 0xffffffff || sz === 0 ? buf.length : p + 8 + sz);
      return { rate, samples: pcmToFloat(buf.subarray(p + 8, end), ch) };
    }
    p += 8 + sz + (sz & 1);
  }
  return null;
}

function pcmToFloat(pcm, channels = 1) {
  const frames = Math.floor(pcm.length / (2 * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += pcm.readInt16LE((i * channels + c) * 2);
    out[i] = s / channels / 32768;
  }
  return out;
}

/** Linear resampling with a moving-average low-pass first when going down. */
function resample(x, from, to) {
  if (from === to) return x;
  let src = x;
  if (to < from) {
    const k = Math.max(1, Math.round(from / to));
    src = new Float32Array(x.length);
    let acc = 0;
    for (let i = 0; i < x.length; i++) {
      acc += x[i] - (i >= k ? x[i - k] : 0);
      src[i] = acc / Math.min(k, i + 1);
    }
  }
  const n = Math.floor((x.length * to) / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = (i * from) / to;
    const j = Math.floor(pos);
    const f = pos - j;
    out[i] = (src[j] ?? 0) * (1 - f) + (src[j + 1] ?? src[j] ?? 0) * f;
  }
  return out;
}

// ---------------------------------------------------------------- ElevenLabs Sound Effects

async function elevenSound(key, s) {
  const models = [...new Set([(process.env.ELEVENLABS_SFX_MODEL || "").trim() || "eleven_text_to_sound_v3", "eleven_text_to_sound_v2"])];
  let last = "";
  for (const model_id of models) {
    const r = await fetch(`${API_BASE}/v1/sound-generation?output_format=pcm_22050`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text: s.prompt, duration_seconds: Math.max(0.5, s.seconds), prompt_influence: 0.6, model_id }),
    });
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      const parsed = readWav(buf);
      if (parsed) return parsed;
      return { rate: RATE, samples: pcmToFloat(buf.subarray(0, buf.length & ~1)) };
    }
    let detail = "";
    try {
      const j = await r.json();
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? "").slice(0, 200);
    } catch {
      /* not JSON */
    }
    last = `HTTP ${r.status}${detail ? ` ${detail}` : ""}`;
    if (r.status === 401 || r.status === 403) break; // the key, not the model
  }
  throw new Error(last || "no response");
}

// ---------------------------------------------------------------- main

const only = opt("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
const key = (process.env.ELEVENLABS_API_KEY || "").trim();
const synthOnly = flag("--synth") || !key;
if (!key && !flag("--synth")) console.log("ELEVENLABS_API_KEY is not set: writing the procedural placeholders (same as --synth).");
const list = SOUNDS.filter((s) => (only ? only.includes(s.name) : synthOnly ? flag("--all") || !s.keep : true));
if (only) for (const n of only) if (!SOUNDS.some((s) => s.name === n)) console.log(`unknown sound "${n}" (known: ${SOUNDS.map((s) => s.name).join(", ")})`);
mkdirSync(OUT, { recursive: true });
let failed = 0;
for (const s of list) {
  const rate = s.rate ?? RATE;
  let samples;
  let how;
  if (synthOnly) {
    samples = s.synth(rate);
    how = "synthesized";
  } else {
    try {
      const got = await elevenSound(key, s);
      samples = resample(got.samples, got.rate, rate);
      how = "ElevenLabs";
    } catch (e) {
      console.log(`${s.name}.wav: ElevenLabs failed (${e instanceof Error ? e.message : e}); kept the current file`);
      failed++;
      continue;
    }
  }
  const data = wav(finish(samples, rate, s.max), rate);
  writeFileSync(joinPath(OUT, `${s.name}.wav`), data);
  console.log(`${s.name}.wav  ${how}  ${(data.length / 1024).toFixed(1)} KB  ${((data.length - 44) / 2 / rate).toFixed(2)} s @ ${rate} Hz`);
}
process.exit(failed ? 1 : 0);
