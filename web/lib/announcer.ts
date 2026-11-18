// Announcer captions: one short line per lobby event, in the game's persona. Adapted from Huddle's
// packages/announcer/src/templates.ts. Rules:
//  - every number comes from lobby state (prices, amounts, names); nothing is invented
//  - several variants per event, picked deterministically from a seed so replays and tests are stable
//  - never nudge anyone to chase losses or bet more after losing; no roasting losers
// The TV reads these aloud (ElevenLabs via /api/tts, or the browser's Web Speech as a fallback).
// Pure module: no imports, safe anywhere.

export type Persona = "nfl" | "soccer" | "calm";

export type CaptionEvent =
  | { type: "join"; name: string }
  | { type: "deposit"; name: string; cents: number }
  | { type: "start"; call?: string | null; text: string; yesPct: number; modelPct?: number | null; gemini?: { label: string; pct: number } | null; lockIn?: number; mode?: "market" | "pool" | "h2h" }
  | { type: "lock"; yesPct: number; mode?: "market" | "pool" | "h2h" }
  | { type: "result"; outcome: "yes" | "no"; winners: { name: string; cents: number }[]; atLockPct?: number | null }
  | { type: "void"; reason?: string | null }
  | { type: "trade"; name: string; side: "yes" | "no"; cents: number; yesPctAfter?: number | null }
  | { type: "offer"; name: string; side: "yes" | "no"; cents: number; odds: number }
  | { type: "play"; text: string }
  | { type: "end"; leader?: { name: string; cents: number } | null; verdict?: string | null };

/** "$5" / "$2.50" (whole dollars drop the cents, which reads better aloud). */
export function money(cents: number): string {
  const c = Math.abs(Math.round(cents));
  return c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`;
}

const pct = (p: number) => `${Math.round(p)}%`;
const side = (s: "yes" | "no") => (s === "yes" ? "YES" : "NO");

function endSentence(s: string): string {
  const t = s.trim();
  return /[.!?]["')\]]?$/.test(t) ? t : `${t}.`;
}

/** FNV-1a 32 bit. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pick<T>(items: readonly T[], seed: string): T | undefined {
  return items.length ? items[hashSeed(seed) % items.length] : undefined;
}

type ByPersona = Record<Persona, string[]>;

function variants(ev: CaptionEvent, p: Persona): string[] {
  switch (ev.type) {
    case "join": {
      const n = ev.name;
      const t: ByPersona = {
        nfl: [`${n} checks in!`, `Welcome to the huddle, ${n}!`, `${n}'s in!`],
        soccer: [`${n}'s in!`, `Welcome, ${n}!`, `${n} joins the party!`],
        calm: [`${n} is in.`, `Welcome, ${n}.`, `${n} joins us.`],
      };
      return t[p];
    }
    case "deposit": {
      const n = ev.name;
      const a = money(ev.cents);
      const t: ByPersona = {
        nfl: [`${n} is in for ${a}.`, `${n} loads up ${a}.`],
        soccer: [`${n} is in for ${a}.`, `${a} in the kitty from ${n}.`],
        calm: [`${n} added ${a}.`, `${a} in for ${n}.`],
      };
      return t[p];
    }
    case "start": {
      const q = endSentence(ev.text);
      const room = pct(ev.yesPct);
      const lock = ev.lockIn && ev.lockIn > 0 ? Math.round(ev.lockIn) : null;
      const model = typeof ev.modelPct === "number" ? pct(ev.modelPct) : null;
      // Labels read "Chargers", "Chargers to win the 1st quarter", "Over 56.5 points", "Tie in the 2nd half".
      const gl = ev.gemini ? ev.gemini.label.replace(/^(Over|Under|Tie|Draw)\b/, (w) => w.toLowerCase()) : "";
      const gem = ev.gemini ? `Gemini has ${gl === "draw" ? "a draw" : gl === "tie" ? "a tie" : gl.startsWith("tie ") ? `a ${gl}` : gl} at ${pct(ev.gemini.pct)}.` : null;
      const pool = ev.mode === "pool";
      const h2h = ev.mode === "h2h";
      const closer: Record<Persona, string> = {
        nfl: lock ? `${lock} seconds on the clock!` : "Window is open!",
        soccer: lock ? `${lock} seconds, get in!` : "Bets are open!",
        calm: lock ? `You have ${lock} seconds.` : "Bets are open.",
      };
      const head: Record<Persona, string[]> = {
        nfl: [`Here we go! ${q}`, `Market's open! ${q}`, q],
        soccer: [`New market! ${q}`, q, `Here we go! ${q}`],
        calm: [q, `New one for you. ${q}`, q],
      };
      const facts: string[] = [];
      if (h2h) facts.push("Make an offer or take one.");
      else if (pool) facts.push(model ? `The model says ${model}. Winners split the pot.` : "Winners split the pot.");
      else if (model) facts.push(`The model opens YES at ${model}.`);
      if (gem) facts.push(gem);
      // A called moment leads with the call: "Penalty called! Will Ronaldo score this penalty? ..."
      if (ev.call) return [[ev.call, q, ...facts, closer[p]].join(" ")];
      return head[p].map((h) => [h, ...facts, closer[p]].join(" "));
    }
    case "lock": {
      const at = ev.mode === "h2h" || ev.mode === "pool" ? "" : ` YES closed at ${pct(ev.yesPct)}.`;
      const t: ByPersona = {
        nfl: [`Locked! Bets are in.${at}`, `Window's closed.${at}`, `That's the whistle. Locked!${at}`],
        soccer: [`Locked! No more bets.${at}`, `That's it, locked!${at}`, `Bets are closed. Here we go!${at}`],
        calm: [`Locked.${at}`, `Bets are closed.${at}`, `That's locked. Let's see.${at}`],
      };
      return t[p];
    }
    case "result": {
      const o = side(ev.outcome);
      const winners = [...ev.winners].sort((a, b) => b.cents - a.cents);
      const w = winners[0];
      const upset = typeof ev.atLockPct === "number" && ev.atLockPct > 0 && ev.atLockPct < 30 ? pct(ev.atLockPct) : null;
      if (!w) {
        const t: ByPersona = {
          nfl: [`It's ${o}! Nobody had action on that one.`, `${o} it is. No winners this time.`],
          soccer: [`It's ${o}! Nobody called it.`, `${o} it is! No winners this time.`],
          calm: [`It's ${o}. No winners this time.`, `${o}. Quiet one.`],
        };
        return t[p];
      }
      const amt = money(w.cents);
      const others = winners.length - 1;
      const tail = others === 1 ? ` ${winners[1].name} wins too.` : others > 1 ? ` ${others} more cash in too.` : "";
      if (upset) {
        const t: Record<Persona, string> = {
          nfl: `Upset alert! The room had ${o} at just ${upset}. ${w.name} takes ${amt}.${tail}`,
          soccer: `Upset! The room had ${o} at just ${upset}. ${w.name} takes ${amt}.${tail}`,
          calm: `A surprise. The room had ${o} at ${upset}. ${w.name} takes ${amt}.${tail}`,
        };
        return [t[p]];
      }
      const t: ByPersona = {
        nfl: [`It's ${o}! ${w.name} takes ${amt}.`, `${o}! ${w.name} cashes in for ${amt}.`, `That's ${o}, folks! ${w.name} collects ${amt}.`],
        soccer: [`It's ${o}! ${w.name} takes ${amt}.`, `There it is, ${o}! ${w.name} collects ${amt}.`, `${o} it is! ${w.name} pockets ${amt}.`],
        calm: [`It's ${o}. ${w.name} takes ${amt}.`, `${o}. ${w.name} collects ${amt}.`, `It's ${o}. ${amt} to ${w.name}.`],
      };
      return t[p].map((s) => s + tail);
    }
    case "void": {
      const r = ev.reason && ev.reason.length < 70 ? ` (${ev.reason.replace(/[.!?]+$/, "")})` : "";
      const t: ByPersona = {
        nfl: [`No play on that one${r}. Everybody gets their money back.`],
        soccer: [`That one's off${r}. Everyone gets their money back.`],
        calm: [`That one is off${r}. Stakes are refunded.`],
      };
      return t[p];
    }
    case "trade": {
      const n = ev.name;
      const a = money(ev.cents);
      const o = side(ev.side);
      const after = typeof ev.yesPctAfter === "number" ? pct(ev.yesPctAfter) : null;
      const t: ByPersona = {
        nfl: [`${n} just dropped ${a} on ${o}. Big-time play.`, `Whoa! ${n} is in for ${a} on ${o}.`, after ? `${n} drops ${a} on ${o}. YES now at ${after}.` : `${a} on ${o} from ${n}.`],
        soccer: [`Big move! ${n} puts ${a} on ${o}.`, `${n} goes in with ${a} on ${o}. Confidence!`, after ? `${n} puts ${a} on ${o}. That moves YES to ${after}.` : `${a} on ${o} from ${n}.`],
        calm: [`${n} put ${a} on ${o}.`, `${a} on ${o} from ${n}. Noted.`, after ? `${n} put ${a} on ${o}. YES is at ${after} now.` : `${n} likes ${o}.`],
      };
      return t[p];
    }
    case "offer": {
      const n = ev.name;
      const a = money(ev.cents);
      const o = side(ev.side);
      const odds = ev.odds.toFixed(2);
      const t: ByPersona = {
        nfl: [`${n} puts up ${a} on ${o} at ${odds}. Any takers?`, `${n} is calling somebody out: ${a} on ${o} at ${odds}.`],
        soccer: [`${n} is offering ${a} on ${o} at ${odds}. Any takers?`, `${a} on ${o} from ${n} at ${odds}. Who wants the other side?`],
        calm: [`${n} is offering ${a} on ${o} at ${odds}.`, `${a} on ${o} at ${odds} from ${n}. Takers welcome.`],
      };
      return t[p];
    }
    case "play":
      return ev.text.trim() ? [endSentence(ev.text)] : [];
    case "end": {
      const l = ev.leader;
      const lead = l && l.cents > 0 ? `${l.name} wins the night, up ${money(l.cents)}.` : l ? `${l.name} finishes on top.` : "";
      const verdict = ev.verdict ? endSentence(ev.verdict) : "";
      const outro: Record<Persona, string> = { nfl: "That's the ballgame. Thanks for playing, folks!", soccer: "Full time! Thanks for playing!", calm: "That's the session. Thanks for playing." };
      return [[outro[p], lead, verdict].filter(Boolean).join(" ")];
    }
  }
}

/** The kiosk box draws at most this many characters of a caption (lib/kiosk.ts cuts there). */
export const MAX_CAPTION = 180;

/**
 * Trim a line to `max` characters without cutting a word: whole sentences while they fit, else the first
 * sentence cut at a word boundary with "...". Sentences split on ". " before a capital, so "D.Prescott" and
 * "Jones Jr. makes" stay whole.
 */
export function fitText(s: string, max: number = MAX_CAPTION): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  let out = "";
  for (const sen of t.split(/(?<=[.!?])\s+(?=[A-Z0-9("'*$])/)) {
    const next = out ? `${out} ${sen}` : sen;
    if (next.length <= max) {
      out = next;
      continue;
    }
    if (out.length < max / 2) {
      const room = max - (out ? out.length + 1 : 0) - 3;
      const cut = sen.slice(0, room + 1);
      const at = cut.lastIndexOf(" ");
      const head = (at > 0 ? cut.slice(0, at) : cut.slice(0, room)).replace(/[\s,;:(-]+$/, "");
      out = `${out ? `${out} ` : ""}${head}...`;
    }
    break;
  }
  return out;
}

/** One caption line for an event, or null when there is nothing worth saying. Never longer than MAX_CAPTION. */
export function captionLine(ev: CaptionEvent, persona: Persona = "nfl", seed = ""): string | null {
  const p: Persona = persona === "soccer" || persona === "calm" ? persona : "nfl";
  const list = variants(ev, p);
  if (!list.length) return null;
  const line = pick(list, `${seed}|${ev.type}`);
  return line ? fitText(line) : null;
}

/** A trade is announced when it is big: at least $5, or at least a third of the market's volume so far. */
export function isBigTrade(cents: number, volumeBefore: number): boolean {
  return cents >= 500 || (volumeBefore > 0 && cents * 3 >= volumeBefore + cents && cents >= 200);
}
