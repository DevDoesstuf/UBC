#!/usr/bin/env node
// The speaker ESP32 without the hardware: the same loop as firmware/speaker/speaker.ino, logging what it would
// play, in order, with timings. Downloads each WAV, parses its header like speaker.ino, and "plays" it by waiting
// for its duration (the real board blocks the same way).
//
//   node scripts/speaker-sim.mjs [server=http://localhost:3000] [kiosk=1] [seconds=120]
const SERVER = (process.argv[2] || "http://localhost:3000").replace(/\/+$/, "");
const KIOSK = process.argv[3] || "1";
const RUN_MS = Number(process.argv[4] || 120) * 1000;
const POLL_MS = 700; // speaker.ino POLL_MS

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** speaker.ino parseHeader: {rate, channels, bits, dataBytes} or an error string. */
function parseWav(b) {
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") return "not RIFF/WAVE";
  let p = 12, fmt = null;
  while (p + 8 <= Math.min(b.length, 1024)) {
    const id = b.toString("latin1", p, p + 4);
    const sz = b.readUInt32LE(p + 4);
    if (id === "fmt ") {
      fmt = { tag: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
      if (fmt.tag !== 1 || (fmt.bits !== 8 && fmt.bits !== 16) || fmt.channels < 1 || fmt.channels > 2 || fmt.rate < 4000 || fmt.rate > 48000) return `unplayable fmt ${JSON.stringify(fmt)}`;
    } else if (id === "data") {
      if (!fmt) return "data before fmt";
      const avail = b.length - (p + 8);
      const dataBytes = sz === 0 || sz === 0xffffffff ? avail : Math.min(sz, avail);
      return { ...fmt, dataBytes };
    }
    if (sz > 1024) return "huge chunk before data";
    p += 8 + sz + (sz & 1);
  }
  return "no data chunk in the first 1024 bytes";
}

let lastId = -1;
let lastPoll = 0;
let played = 0;
console.log(`${ts()}  speaker sim: ${SERVER} kiosk ${KIOSK}`);
while (Date.now() - t0 < RUN_MS) {
  if (Date.now() - lastPoll < POLL_MS) {
    await sleep(20);
    continue;
  }
  lastPoll = Date.now();
  let j;
  try {
    const r = await fetch(`${SERVER}/api/kiosk/audio?kiosk=${encodeURIComponent(KIOSK)}&after=${lastId}`, { signal: AbortSignal.timeout(6000) });
    if (r.status !== 200) {
      console.log(`${ts()}  poll HTTP ${r.status}`);
      continue;
    }
    j = await r.json();
  } catch (e) {
    console.log(`${ts()}  poll failed: ${e.message}`);
    continue;
  }
  const pollMs = Date.now() - lastPoll;
  if (lastId < 0 || !j.url) {
    if (j.id > lastId) {
      if (lastId >= 0 && j.id !== lastId) console.log(`${ts()}  skipped stale items, after -> ${j.id}`);
      else if (lastId < 0) console.log(`${ts()}  boot: latest id ${j.id}, nothing old plays`);
      lastId = j.id;
    }
    continue;
  }
  if (j.id <= lastId) console.log(`${ts()}  !! id went backwards: ${j.id} <= ${lastId}`);
  lastId = j.id;
  const age = Date.now() - j.id;
  const started = Date.now();
  let info, bytes = 0;
  try {
    const r = await fetch(j.url, { signal: AbortSignal.timeout(10_000) }); // speaker.ino playUrl: 10 s
    if (r.status !== 200) {
      console.log(`${ts()}  ${j.kind.padEnd(5)} ${j.url.split("/").pop()}  download failed: HTTP ${r.status}`);
      continue;
    }
    const b = Buffer.from(await r.arrayBuffer());
    bytes = b.length;
    const cl = r.headers.get("content-length");
    if (cl && Number(cl) !== b.length) console.log(`${ts()}  !! Content-Length ${cl} but ${b.length} bytes`);
    info = parseWav(b);
  } catch (e) {
    console.log(`${ts()}  download failed: ${e.message}`);
    continue;
  }
  const fetchMs = Date.now() - started;
  if (typeof info === "string") {
    console.log(`${ts()}  ${j.kind} ${j.url}  NOT PLAYABLE: ${info}`);
    continue;
  }
  const ms = Math.round((info.dataBytes / (info.bits / 8) / info.channels / info.rate) * 1000);
  const name = j.kind === "voice" ? "voice" : j.url.split("/").pop();
  console.log(`${ts()}  play ${name.padEnd(13)} ${String(ms).padStart(5)} ms  ${info.rate} Hz  ${String(bytes).padStart(6)} B  age ${String(age).padStart(5)} ms  poll ${pollMs} ms  fetch ${fetchMs} ms  "${j.text}"`);
  played++;
  await sleep(ms + 60); // writeSilence(60)
  lastPoll = 0; // played something: ask again right away
}
console.log(`${ts()}  done, played ${played}`);
