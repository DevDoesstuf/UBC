// The speaker ESP32 contract: what /api/kiosk/audio hands it, in what order, and whether every WAV it is sent
// (the event sounds and /api/tts?format=wav) is one firmware/speaker/speaker.ino can play. `SpeakerWav` below
// mirrors speaker.ino's WavToI2S (parseHeader + feed) line by line, fed in random packet sizes like
// HTTPClient::writeToStream does.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";

const tts = await import("../lib/tts.ts");
const speaker = await import("../lib/speaker.ts");
const ann = await import("../lib/announcer.ts");

// ---------------------------------------------------------------- speaker.ino's WAV parser, in JS

class SpeakerWav {
  state: "HEADER" | "DATA" | "BAD" = "HEADER";
  hdr = new Uint8Array(1024);
  hdrLen = 0;
  haveFmt = false;
  fmtTag = 0;
  channels = 1;
  bits = 16;
  rate = 22050;
  dataLeft = 0;
  frames = 0;
  carry = -1;
  samples = 0;
  outLen = 0;
  private le16 = (p: Uint8Array, o: number) => p[o] | (p[o + 1] << 8);
  private le32 = (p: Uint8Array, o: number) => (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0;
  private tag = (o: number) => String.fromCharCode(...this.hdr.subarray(o, o + 4));

  write(buf: Uint8Array): number {
    const n = buf.length;
    if (this.state === "HEADER") {
      const take = Math.min(n, this.hdr.length - this.hdrLen);
      this.hdr.set(buf.subarray(0, take), this.hdrLen);
      this.hdrLen += take;
      const ds = { dataStart: 0 };
      const r = this.parseHeader(ds);
      if (r < 0 || (r === 0 && this.hdrLen === this.hdr.length)) {
        this.state = "BAD";
        return n;
      }
      if (r === 0) return n;
      this.state = "DATA";
      if (this.hdrLen > ds.dataStart) this.feed(this.hdr.subarray(ds.dataStart, this.hdrLen));
      if (take < n) this.feed(buf.subarray(take));
      return n;
    }
    if (this.state === "DATA") this.feed(buf);
    return n;
  }

  parseHeader(out: { dataStart: number }): number {
    if (this.hdrLen < 12) return 0;
    if (this.tag(0) !== "RIFF" || this.tag(8) !== "WAVE") return -1;
    let p = 12;
    while (p + 8 <= this.hdrLen) {
      const sz = this.le32(this.hdr, p + 4);
      if (this.tag(p) === "fmt ") {
        if (p + 8 + 16 > this.hdrLen) return 0;
        this.fmtTag = this.le16(this.hdr, p + 8);
        this.channels = this.le16(this.hdr, p + 10);
        this.rate = this.le32(this.hdr, p + 12);
        this.bits = this.le16(this.hdr, p + 22);
        this.haveFmt = true;
        if (this.fmtTag !== 1 || (this.bits !== 8 && this.bits !== 16) || this.channels < 1 || this.channels > 2 || this.rate < 4000 || this.rate > 48000) return -1;
      } else if (this.tag(p) === "data") {
        if (!this.haveFmt) return -1;
        out.dataStart = p + 8;
        this.dataLeft = sz === 0 || sz === 0xffffffff ? 0xffffffff : sz;
        return 1;
      }
      if (sz > this.hdr.length) return -1;
      p += 8 + sz + (sz & 1);
    }
    return 0;
  }

  private push() {
    this.samples++;
    if (this.channels === 1) this.frames++;
    else if (++this.outLen % 2 === 0) this.frames++;
  }

  feed(p: Uint8Array) {
    let n = p.length;
    if (this.dataLeft !== 0xffffffff) {
      if (n > this.dataLeft) n = this.dataLeft;
      this.dataLeft -= n;
    }
    let i = 0;
    if (this.bits === 8) {
      for (; i < n; i++) this.push();
      return;
    }
    if (this.carry >= 0 && n > 0) {
      this.push();
      this.carry = -1;
      i = 1;
    }
    for (; i + 1 < n; i += 2) this.push();
    if (i < n) this.carry = p[i];
  }

  playedMs() {
    return this.rate ? Math.floor((this.frames * 1000) / this.rate) : 0;
  }
}

/** Plays bytes through the mirror in random packet sizes (1..1460, like TCP segments). */
function play(bytes: Uint8Array, seed = 1): SpeakerWav {
  const w = new SpeakerWav();
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) % 1460) + 1;
  for (let o = 0; o < bytes.length; ) {
    const n = Math.min(rnd(), bytes.length - o);
    w.write(bytes.subarray(o, o + n));
    o += n;
  }
  return w;
}

// ---------------------------------------------------------------- the WAV files

const SOUNDS = ["join", "tap", "start", "lastcall", "lock", "win", "lose", "siren", "cheer", "coin"];
const DIR = new URL("../public/sounds/", import.meta.url);

test("every event sound exists, is a WAV speaker.ino plays (mono 16-bit, 8 or 22.05 kHz), under 60 KB, real sound", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".wav"));
  for (const name of SOUNDS) assert.ok(files.includes(`${name}.wav`), `missing ${name}.wav`);
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(new URL(f, DIR)));
    assert.ok(statSync(new URL(f, DIR)).size < 60_000, `${f} is ${bytes.length} bytes`);
    const w = play(bytes, f.length);
    assert.equal(w.state, "DATA", `${f} rejected`);
    assert.equal(w.channels, 1, f);
    assert.equal(w.bits, 16, f);
    assert.ok(w.rate === 22050 || w.rate === 8000, `${f} at ${w.rate} Hz`);
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    assert.equal(dv.getUint32(40, true), bytes.length - 44, `${f} data size`);
    assert.equal(w.frames, (bytes.length - 44) / 2, `${f} frames`);
    let peak = 0;
    for (let i = 44; i + 1 < bytes.length; i += 2) peak = Math.max(peak, Math.abs(dv.getInt16(i, true)));
    assert.ok(peak > 8000, `${f} is (nearly) silent`);
  }
});

test("the mirror parser agrees with speaker.ino on edge cases (streamed size, extra chunks, bad formats)", () => {
  const pcm = new Uint8Array(2000).map((_, i) => i & 255);
  const wav = tts.wavFromPcm(pcm);
  // Streamed WAV with an unknown size (0xFFFFFFFF) plays to the end of the download.
  const streamed = wav.slice();
  new DataView(streamed.buffer).setUint32(40, 0xffffffff, true);
  assert.equal(play(streamed).frames, 1000);
  // A LIST chunk before "data" is skipped.
  const list = new Uint8Array(wav.length + 12);
  list.set(wav.subarray(0, 36));
  list.set(new TextEncoder().encode("LIST"), 36);
  new DataView(list.buffer).setUint32(40, 4, true);
  list.set(new TextEncoder().encode("INFO"), 44);
  list.set(wav.subarray(36), 48);
  assert.equal(play(list).frames, 1000);
  // MP3 bytes or a 24-bit WAV: refused (the speaker logs it and moves on).
  assert.equal(play(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).state, "BAD");
  const w24 = wav.slice();
  new DataView(w24.buffer).setUint16(34, 24, true);
  assert.equal(play(w24).state, "BAD");
});

// ---------------------------------------------------------------- /api/tts?format=wav with a mocked ElevenLabs

test("TTS WAV: pcm_22050 from ElevenLabs (mocked) becomes exactly the WAV speaker.ino accepts, with a correct Content-Length", async () => {
  const lobby = await import("../lib/lobby.ts");
  const { kioskTouch } = await import("../lib/kiosk.ts");
  const ttsRoute = await import("../app/api/tts/route.ts");
  await kioskTouch("661", "game:nfl-sf-dal", "http://x");
  await kioskTouch("661", "start", "http://x");
  const l = (await lobby.getKioskLobby("661"))!;
  const cap = l.captions![l.captions!.length - 1];
  assert.ok(cap.say && cap.say.length <= ann.MAX_SPEECH && !/\d/.test(cap.say), `spoken line: ${cap.say}`);
  const samples = 22050 + 7; // 1 s and a bit, plus an odd trailing byte below
  const pcm = new Uint8Array(samples * 2 + 1);
  for (let i = 0; i < samples; i++) new DataView(pcm.buffer).setInt16(i * 2, Math.round(8000 * Math.sin(i / 10)), true);
  const realFetch = globalThis.fetch;
  const seen: { url: string; body: { text: string; model_id: string } }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(pcm, { status: 200, headers: { "content-type": "audio/pcm" } });
  }) as typeof fetch;
  process.env.ELEVENLABS_API_KEY = "sk-test-not-real";
  try {
    await tts.resetTtsKeyCheck();
    const r = await ttsRoute.GET(new Request(`http://x/api/tts?code=${l.code}&id=${cap.id}&format=wav`));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "audio/wav");
    const body = new Uint8Array(await r.arrayBuffer());
    assert.equal(Number(r.headers.get("content-length")), body.length, "Content-Length matches the body (no chunking needed)");
    assert.equal(body.length, 44 + samples * 2, "header + whole samples (the odd byte is dropped)");
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/v1\/text-to-speech\/[^/]+\/stream\?output_format=pcm_22050$/);
    assert.equal(seen[0].body.model_id, "eleven_flash_v2_5");
    assert.equal(seen[0].body.text, cap.say, "the speaker hears the spoken line, not the screen caption");
    const dv = new DataView(body.buffer);
    assert.equal(String.fromCharCode(...body.subarray(0, 4)), "RIFF");
    assert.equal(dv.getUint32(4, true), body.length - 8);
    assert.equal(dv.getUint16(20, true), 1);
    assert.equal(dv.getUint16(22, true), 1);
    assert.equal(dv.getUint32(24, true), 22050);
    assert.equal(dv.getUint16(34, true), 16);
    assert.equal(dv.getUint32(40, true), samples * 2);
    for (const seed of [1, 2, 3]) {
      const w = play(body, seed);
      assert.equal(w.state, "DATA");
      assert.equal(w.frames, samples, "every sample reaches the amp, whatever the packet split");
      assert.equal(w.playedMs(), 1000);
    }
    // Second time: from the cache, same bytes, no new ElevenLabs call.
    const again = new Uint8Array(await (await ttsRoute.GET(new Request(`http://x/api/tts?code=${l.code}&id=${cap.id}&format=wav`))).arrayBuffer());
    assert.deepEqual(again, body);
    assert.equal(seen.length, 1);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ELEVENLABS_API_KEY;
    await tts.resetTtsKeyCheck();
  }
});

// ---------------------------------------------------------------- the queue: order, boot, stale skipping

const item = (id: number, kind: "sound" | "voice", ttl = 8000, sound?: string) => ({ id, url: `u${id}`, text: `t${id}`, kind, ttl, sound: sound as never });

test("speaker queue: boot gives the latest id; then oldest fresh item first; stale items skipped past, never replayed", () => {
  const now = 1_000_000;
  const items = [item(now - 20_000, "sound"), item(now - 19_999, "voice"), item(now - 3000, "sound"), item(now - 2999, "voice"), item(now - 1500, "sound", 1200, "lastcall")];
  // Boot: nothing old plays.
  assert.deepEqual(speaker.nextForSpeaker(items, -1, now).reply, { id: now - 1500, url: null });
  // Behind by 20 s: the two old items are skipped, the 3 s old sound plays first, then its voice line.
  const a = speaker.nextForSpeaker(items, now - 25_000, now).reply;
  assert.equal(a.id, now - 3000);
  const b = speaker.nextForSpeaker(items, a.id, now).reply;
  assert.equal(b.id, now - 2999);
  assert.equal(b.url, `u${now - 2999}`);
  // The last-call tick 1.5 s late is pointless: skipped, and `after` moves past it.
  assert.deepEqual(speaker.nextForSpeaker(items, b.id, now).reply, { id: now - 1500, url: null });
  assert.deepEqual(speaker.nextForSpeaker(items, now - 1500, now).reply, { id: now - 1500, url: null });
  // Nothing in the lobby at all.
  assert.deepEqual(speaker.nextForSpeaker([], -1, now).reply, { id: 0, url: null });
  assert.deepEqual(speaker.nextForSpeaker([], 123, now).reply, { id: 123, url: null });
  // Pre-warm: while a sound plays, the voice line right after it.
  assert.equal(speaker.voiceToPrewarm(items, items[2], now)?.id, now - 2999);
});

test("a game on the speaker: sound effect then the announcer, in id order; last call; win vs lose; coin on deposits", async () => {
  const lobby = await import("../lib/lobby.ts");
  const { kioskTouch } = await import("../lib/kiosk.ts");
  const audio = await import("../app/api/kiosk/audio/route.ts");
  await kioskTouch("662", "game:nfl-sf-dal", "http://x");
  const code = (await lobby.getKioskCode("662"))!;
  await lobby.mutate(code, (l, now) => {
    const p = lobby.join(l, "Sam", now);
    lobby.creditDeposit(l, p.id, 500, "demo", "d1", now);
  });
  await kioskTouch("662", "start", "http://x");
  // Make the open market long enough for a last call, then let it come due.
  await lobby.mutate(code, (l, now) => {
    l.market!.openedAt = now - 20_000;
    l.market!.lockAt = now + 3000;
  });
  const l1 = (await lobby.getKioskLobby("662"))!;
  assert.equal(l1.events[l1.events.length - 1].sound, "lastcall");
  await kioskTouch("662", "lock", "http://x");
  await kioskTouch("662", "resolve:yes", "http://x");
  const l = (await lobby.getKioskLobby("662"))!;
  const sounds = l.events.map((e) => e.sound).filter(Boolean);
  assert.deepEqual(sounds, ["tap", "join", "coin", "start", "lastcall", "lock", "start", "lock", "lose"], sounds.join(" "));

  process.env.ELEVENLABS_API_KEY = "sk-test-not-real";
  await tts.resetTtsKeyCheck();
  try {
    const heard: { id: number; url: string; kind: string; text: string }[] = [];
    let after = -1;
    const boot = await (await audio.GET(new Request(`http://x/api/kiosk/audio?kiosk=662&after=-1`))).json();
    assert.equal(boot.url, null);
    after = 0; // pretend the speaker booted before the game: everything (fresh) plays
    for (let i = 0; i < 60; i++) {
      const r = await (await audio.GET(new Request(`http://x/api/kiosk/audio?kiosk=662&after=${after}`))).json();
      if (!r.url) break;
      assert.ok(r.id > after, "ids only increase");
      heard.push(r);
      after = r.id;
    }
    assert.equal(after, boot.id, "ends at the latest id");
    // Every caption comes right after the sound effect of its event.
    const kinds = heard.map((h) => (h.kind === "sound" ? h.url.split("/").pop()!.replace(".wav", "") : "voice"));
    assert.deepEqual(kinds, ["tap", "join", "voice", "coin", "start", "voice", "lastcall", "lock", "voice", "start", "voice", "lock", "voice", "lose", "voice"], kinds.join(" "));
    for (const h of heard.filter((x) => x.kind === "voice")) {
      assert.match(h.url, /\/api\/tts\?code=[A-Z]{4}&id=\d+&format=wav$/);
      assert.ok(!/\d|%|\$|https?:/.test(h.text), `spoken text has no digits or symbols: ${h.text}`);
    }
  } finally {
    delete process.env.ELEVENLABS_API_KEY;
    await tts.resetTtsKeyCheck();
  }
});

// ---------------------------------------------------------------- spoken lines

test("spoken lines: numbers in words, short, no URLs or shouting; same story as the caption", () => {
  const s = ann.toSpeech;
  assert.equal(s("Sam takes $1.35."), "Sam takes one dollar thirty-five.");
  assert.equal(s("YES closed at 74%."), "Yes closed at seventy-four percent.");
  assert.equal(s("$5 on NO, $0.50 back, $2.50 more, $1 even"), "Five dollars on No, fifty cents back, two dollars fifty more, one dollar even");
  assert.equal(s("Over 56.5 points in the 2nd half?"), "Over fifty-six and a half points in the second half?");
  assert.equal(s("Dallas leads 21-14 at 1.80 odds"), "Dallas leads twenty-one to fourteen at one point eight odds");
  assert.equal(s("TOUCHDOWN! D.Prescott pass to G.Pickens for 35 yards. See https://x.y/z"), "Touchdown! D. Prescott pass to G. Pickens for thirty-five yards. See");
  assert.equal(s("Will the 49ers score? 20 seconds!"), "Will the Niners score? Twenty seconds!");
  assert.equal(ann.numberWords(1234), "one thousand two hundred thirty-four");

  const start = { type: "start" as const, text: "Will the Cowboys beat the 49ers?", yesPct: 36, modelPct: 36, gemini: { label: "Cowboys", pct: 37 }, lockIn: 20 };
  const cap = ann.captionLine(start, "nfl", "seed")!;
  const say = ann.speechLine(start, "nfl", "seed")!;
  assert.match(cap, /Gemini has Cowboys at 37%/);
  assert.ok(!/Gemini|model/.test(say), say);
  assert.equal(cap.split(" ")[0], say.split(" ")[0], "same opener as the screen");
  assert.match(say, /Twenty seconds!$/);
  const res = { type: "result" as const, outcome: "yes" as const, winners: [{ name: "Sam", cents: 320 }, { name: "Ann", cents: 110 }], atLockPct: 60 };
  assert.match(ann.speechLine(res, "soccer", "x")!, /Sam .*three dollars twenty/);
  assert.ok(!/Ann/.test(ann.speechLine(res, "soccer", "x")!), "the voice names the top winner only");
  assert.equal(ann.speechLine({ type: "play", text: "TOUCHDOWN! B.Purdy pass short right...", kind: "touchdown", team: "Niners" }, "nfl", "a")?.startsWith("Touchdown"), true);
  assert.equal(ann.speechLine({ type: "play", text: "GOAL! ...", kind: "goal", team: "Aston Villa" }, "soccer", "b")?.includes("Aston Villa"), true);
  assert.equal(ann.speechLine({ type: "play", text: "Final", kind: "final", score: "Cowboys 24, 49ers 17" }, "nfl", "c"), "That's the final! Cowboys twenty-four, Niners seventeen.");
  for (const p of ["nfl", "soccer", "calm"] as const) {
    for (const ev of [start, res, { type: "lock" as const, yesPct: 74 }, { type: "end" as const, leader: { name: "Sam", cents: 1235 } }, { type: "void" as const, reason: "a long reason that the voice skips" }]) {
      const line = ann.speechLine(ev, p, "k")!;
      assert.ok(line.length <= ann.MAX_SPEECH && !/\d/.test(line), `${p} ${ev.type}: ${line}`);
    }
  }
});
