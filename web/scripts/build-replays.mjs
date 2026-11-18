#!/usr/bin/env node
// Builds replay games from REAL completed games: ESPN's public play-by-play + Gemini Prediction Markets prices.
//
//   node scripts/build-replays.mjs                 # every game in GAMES below
//   node scripts/build-replays.mjs replay-sf-dal   # one game by id
//   node scripts/build-replays.mjs --league nfl --event 401873063 --id replay-x   # any ESPN game
//
// Sources (public, no keys):
//   ESPN   https://site.api.espn.com/apis/site/v2/sports/{football/nfl | basketball/nba | soccer/eng.1}/summary?event=<id>
//   Gemini https://api.gemini.com/v1/prediction-markets/events?category=sports&status=settled&search=<LEAGUE-yymmddHHMM>
//          https://api.gemini.com/v1/prediction-markets/events/<ticker>
//          https://api.gemini.com/v2/candles/<instrumentSymbol>/5m   (Gemini's real price history, 5 minute candles)
//
// Output: config/replays/<file>.json in the app's replay format (see lib/replay/timeline.ts), compressed to about
// 6-7 minutes of demo time. Key moments get room to trade (3rd/4th downs, red zone trips, penalties, corners, free
// throws, timeouts); everything else plays fast. Every event keeps its real wall-clock time, so the Gemini price
// shown at any moment of the replay is Gemini's real price at that moment of the real game ("gemini.track").
// The pregame snapshot (prices one minute before kickoff) calibrates the pricing models and is the fallback.
//
// Register new files in lib/replay/timeline.ts (FILES) and config/games.json. The app never calls ESPN at runtime.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "replays");
const GEMINI = "https://api.gemini.com";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports";

/** The games we ship. `target` is demo length in seconds. */
export const GAMES = [
  { id: "replay-sf-dal", file: "49ers-cowboys", league: "nfl", event: "401873063", target: 420, note: "NFL Week 11. A 46-40 shootout decided in the last minute." },
  { id: "replay-lac-bal", file: "chargers-ravens", league: "nfl", event: "401873065", target: 390, note: "NFL Week 11, Monday Night Football. Chargers win 23-20." },
  { id: "replay-mia-ind", file: "dolphins-colts", league: "nfl", event: "401873059", target: 390, note: "NFL Week 11. Colts edge the Dolphins 24-22." },
  { id: "replay-avl-mun", file: "villa-united", league: "eng.1", event: "401879240", target: 400, note: "Premier League. Man United 4-4 Aston Villa, equaliser in the 96th minute." },
  { id: "replay-okc-lac", file: "thunder-clippers", league: "nba", event: "401909304", target: 400, note: "NBA. Clippers 113, Thunder 112." },
];

const LEAGUES = {
  nfl: { path: "football/nfl", sport: "nfl", gemini: "NFL", label: "NFL" },
  nba: { path: "basketball/nba", sport: "nba", gemini: "NBA", label: "NBA" },
  "eng.1": { path: "soccer/eng.1", sport: "soccer", gemini: "EPL", label: "Premier League" },
};

// ---------------------------------------------------------------- http

async function getJson(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "huddle-replay-builder" }, signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return await r.json();
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 500 * (i + 1)));
    }
  }
  throw last;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

// ---------------------------------------------------------------- helpers

const clean = (s) => String(s ?? "")
  .replace(/\((No Huddle, )?Shotgun\)\s*/g, "")
  .replace(/\(No Huddle\)\s*/g, "")
  .replace(/\s*\[[^\]]*\]/g, "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 160);
const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const clockSecs = (display) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(display ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};
const yymmddHHMM = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
};
const hex = (c) => (c && /^[0-9a-f]{6}$/i.test(c) ? `#${c.toUpperCase()}` : undefined);
function teamColor(t) {
  const main = hex(t.color);
  // Near-white primaries (e.g. some away kits) read badly on ivory: use the alternate colour.
  if (main && parseInt(main.slice(1), 16) > 0xe8e8e8) return hex(t.alternateColor) ?? main;
  return main ?? hex(t.alternateColor) ?? "#10261C";
}

// ---------------------------------------------------------------- timing
// Each raw event gets a `cost` (demo ms before the next event) and an optional `dwell` (extra ms after it, so a
// question opened by it can trade). Filler costs are scaled so the whole game fits the target length.

function schedule(raw, targetMs, opts = {}) {
  const minFill = opts.minFill ?? 450;
  const maxFill = opts.maxFill ?? 2200;
  const fixed = raw.reduce((a, e) => a + (e.dwell ?? 0) + (e.fixed ?? 0), 0);
  const fillW = raw.reduce((a, e) => a + (e.fixed !== undefined ? 0 : e.weight ?? 1), 0) || 1;
  const per = Math.min(maxFill, Math.max(minFill, (targetMs - fixed - 2000) / fillW));
  let t = 2000;
  return raw.map((e) => {
    const atMs = Math.round(t);
    t += (e.fixed !== undefined ? e.fixed : (e.weight ?? 1) * per) + (e.dwell ?? 0);
    const { dwell, fixed: _f, weight, ...rest } = e;
    return { atMs, ...rest };
  });
}

// ---------------------------------------------------------------- NFL

function nflEvents(sum, teams) {
  const idToAbbr = teams.idToAbbr;
  const drives = sum.drives?.previous ?? [];
  const raw = [];
  let period = 1;
  let started = false;
  const offenseOf = (p) => idToAbbr[p.start?.team?.id] ?? idToAbbr[p.end?.team?.id];
  const score = (p) => [Number(p.homeScore ?? 0), Number(p.awayScore ?? 0)];
  const SKIP = /Timeout|Two-minute warning|Official/i;

  // Rank 3rd/4th downs: these get a snap event and room to trade. Prefer 4th downs, red zone, late and close.
  const thirds = [];
  drives.forEach((d, di) => d.plays.forEach((p, pi) => {
    const down = p.start?.down;
    const type = p.type?.text ?? "";
    // Only real attempts (a run or a pass, not a punt, a kick or a pre-snap penalty), and not hopeless distances.
    const pt = classify(type, p.text).playType;
    if ((down === 3 || down === 4) && (pt === "run" || pt === "pass") && (p.start?.distance ?? 99) <= 12 && !/No Play/i.test(p.text) && !/Penalty/i.test(type)) {
      const pr = p.period?.number ?? 1;
      const margin = Math.abs(Number(p.homeScore) - Number(p.awayScore));
      let s = 1 + (down === 4 ? 1.5 : 0) + ((p.start?.yardsToEndzone ?? 99) <= 20 ? 1.5 : 0) + (pr >= 4 && margin <= 8 ? 1.5 : 0) + (pr === 2 && clockSecs(p.clock?.displayValue) <= 120 ? 1 : 0);
      s += ((di * 7 + pi * 3) % 5) / 10; // deterministic tie-break
      thirds.push({ key: `${di}:${pi}`, s, di, down });
    }
  }));
  thirds.sort((a, b) => b.s - a.s);
  const picked = new Set();
  const perDrive = new Map();
  let fourths = 0;
  for (const t of thirds) {
    if (picked.size >= 9) break;
    if ((perDrive.get(t.di) ?? 0) >= 2) continue;
    if (t.down === 4 && fourths >= 3) continue;
    if (t.down === 4) fourths++;
    picked.add(t.key);
    perDrive.set(t.di, (perDrive.get(t.di) ?? 0) + 1);
  }

  let redZoneDwells = 0;
  drives.forEach((d, di) => {
    const team = idToAbbr[d.team?.id] ?? d.team?.abbreviation;
    const plays = d.plays ?? [];
    let driveStarted = false;
    let inRedZone = false;
    plays.forEach((p, pi) => {
      const type = p.type?.text ?? "";
      const pr = p.period?.number ?? period;
      const clock = p.clock?.displayValue;
      const wall = ms(p.wallclock);
      if (pr !== period && started) {
        raw.push({ type: "period_end", period, clock: "0:00", score: score(p), wall, fixed: 1800, text: periodText(period, "nfl", score(p), teams) });
        period = pr;
        raw.push({ type: "period_start", period, clock: "15:00", score: score(p), wall, fixed: 1800, text: pr > 4 ? "Overtime!" : `Start of the ${ordinal(pr)} quarter.` });
      }
      if (/^End (Period|of Half|of Game)/i.test(type)) return;
      if (/Kickoff/i.test(type)) {
        if (!started) {
          started = true;
          raw.push({ type: "kickoff", period: 1, clock: "15:00", team: idToAbbr[p.start?.team?.id], score: [0, 0], wall, fixed: 3000, text: `${teams.away.name} at ${teams.home.name}. ${clean(p.text)}` });
        }
        if (/Touchdown/i.test(type)) raw.push({ type: "score_update", clock, score: score(p), wall, fixed: 3500, text: `Kick return TOUCHDOWN! ${clean(p.text)}`, data: { big: true } });
        return;
      }
      if (SKIP.test(type)) return;
      const offense = offenseOf(p);
      if (!driveStarted && offense) {
        driveStarted = true;
        const yl = 100 - (p.start?.yardsToEndzone ?? 75);
        raw.push({ type: "drive_start", clock, team: offense, score: score(plays[Math.max(0, pi - 1)] ?? p), wall, data: { yardline: yl }, fixed: 2500, text: `${teams.byAbbr[offense]?.nick ?? offense} ball at ${p.start?.possessionText ?? p.start?.downDistanceText ?? "the 25"}.` });
      }
      const c = classify(type, p.text);
      const down = p.start?.down;
      const distance = p.start?.distance;
      const yardline = p.start?.yardsToEndzone !== undefined ? 100 - p.start.yardsToEndzone : undefined;
      const noPlay = /No Play/i.test(p.text ?? "") || (/Penalty/i.test(type) && !c.playType);
      const key = `${di}:${pi}`;
      if (picked.has(key) && down && distance !== undefined) {
        const goForIt = down === 4;
        raw.push({ type: "snap", clock, team: offense, score: score(plays[Math.max(0, pi - 1)] ?? p), wall: wall - 20000, data: { down, distance, yardline, ...(goForIt ? { goForIt: true } : {}) }, dwell: 14500, fixed: 0,
          text: `${ordinal(down)} and ${distance >= (p.start?.yardsToEndzone ?? 99) ? "goal" : distance} for the ${teams.byAbbr[offense]?.nick ?? offense} at ${p.start?.possessionText ?? "midfield"}.` });
      }
      const td = /Touchdown/i.test(type) && !/Interception|Fumble Return|Punt Return|Blocked/i.test(type);
      const turnover = !!p.isTurnover || /Interception|Fumble Recovery \(Opponent\)/i.test(type);
      const endTeam = idToAbbr[p.end?.team?.id];
      const firstDown = !noPlay && !td && !turnover && c.playType !== "punt" && c.playType !== "kick" && p.end?.down === 1 && endTeam === offense && (p.start?.down ?? 1) >= 1 && !(p.start?.down === 1 && p.end?.distance === p.start?.distance && p.statYardage < (p.start?.distance ?? 10));
      const data = {
        down, distance, yardline, playType: noPlay ? "other" : c.playType ?? "other", gained: Number(p.statYardage ?? 0),
        firstDown: !!firstDown,
        ...(td ? { touchdown: true, big: true } : {}),
        ...(turnover ? { turnover: true } : {}),
        ...(c.playType === "kick" ? { good: /Good/i.test(type) } : {}),
        ...(noPlay ? { noPlay: true, penalty: true } : {}),
      };
      const scoring = !!p.scoringPlay;
      const enteredRz = !inRedZone && yardline !== undefined && yardline < 80 && yardline + data.gained >= 80 && !td && !turnover;
      if (enteredRz) inRedZone = true;
      const rzDwell = enteredRz && redZoneDwells < 6 && !noPlay ? (redZoneDwells++, 9000) : 0;
      raw.push({
        type: "play_result", clock, team: offense, player: undefined, score: score(p), wall, data,
        text: (td ? "TOUCHDOWN! " : turnover ? "TURNOVER! " : "") + clean(p.text),
        weight: scoring || turnover ? 1.2 : picked.has(key) ? 1 : 1,
        dwell: (scoring ? 3500 : 0) + (turnover ? 2500 : 0) + rzDwell,
      });
    });
    if (driveStarted) {
      const r = String(d.result ?? d.displayResult ?? "").toUpperCase();
      const result = r === "TD" || r.includes("TOUCHDOWN") ? "td" : r === "FG" || r.includes("FIELD GOAL") && !r.includes("MISSED") ? "fg" : r.includes("PUNT") ? "punt" : r.includes("INT") || r.includes("FUMBLE") ? "turnover" : r.includes("DOWNS") ? "downs" : r.includes("HALF") ? "end_half" : r.includes("GAME") ? "end_game" : "none";
      const last = plays[plays.length - 1];
      raw.push({ type: "drive_end", clock: last?.clock?.displayValue, team, score: last ? score(last) : undefined, wall: ms(last?.wallclock), data: { result }, fixed: 1200 });
    }
  });
  const lastPlay = drives.at(-1)?.plays.at(-1);
  const fin = lastPlay ? score(lastPlay) : [0, 0];
  raw.push({ type: "period_end", period, clock: "0:00", score: fin, wall: ms(lastPlay?.wallclock), fixed: 1500, text: "That's the end of regulation." .replace("regulation", period > 4 ? "overtime" : "regulation") });
  raw.push({ type: "final", clock: "0:00", score: fin, wall: ms(lastPlay?.wallclock) + 1000, fixed: 3000, data: { big: true }, text: finalText(teams, fin, "nfl") });
  // The last two minutes of a one-score game play slower.
  let cur = 1;
  for (const e of raw) {
    if (e.type === "period_start") cur = e.period;
    if (e.fixed !== undefined || e.type !== "play_result") continue;
    const left = clockSecs(e.clock);
    if (cur >= 4 && left !== undefined && left <= 120 && e.score && Math.abs(e.score[0] - e.score[1]) <= 8) e.weight = (e.weight ?? 1) * 2.5;
  }
  return raw;
}

function classify(type, text = "") {
  const t = type.toLowerCase();
  if (/rush/.test(t)) return { playType: "run" };
  if (/pass|sack|interception/.test(t)) return { playType: "pass" };
  if (/punt/.test(t)) return { playType: "punt" };
  if (/field goal/.test(t)) return { playType: "kick" };
  if (/fumble/.test(t)) return { playType: /pass|sack/i.test(text) ? "pass" : "run" };
  if (/safety/.test(t)) return { playType: "run" };
  return {};
}

function ordinal(n) {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}

function periodText(p, sport, sc, teams) {
  const s = `${teams.home.nick} ${sc[0]}, ${teams.away.nick} ${sc[1]}`;
  if (sport === "nfl") return p === 2 ? `Halftime. ${s}.` : p >= 4 ? `End of regulation. ${s}.` : `End of the ${ordinal(p)} quarter. ${s}.`;
  if (sport === "nba") return p === 2 ? `Halftime. ${s}.` : p >= 4 ? `End of regulation. ${s}.` : `End of the ${ordinal(p)} quarter. ${s}.`;
  return p === 1 ? `Halftime. ${s}.` : `Full time. ${s}.`;
}

function finalText(teams, sc, sport) {
  const [h, a] = sc;
  const w = h > a ? teams.home : teams.away;
  const l = h > a ? teams.away : teams.home;
  if (h === a) return `Full time: ${teams.home.name} ${h}, ${teams.away.name} ${a}. Honours even!`;
  return `${sport === "soccer" ? "Full time" : "Final"}: ${w.name} ${Math.max(h, a)}, ${l.name} ${Math.min(h, a)}.`;
}

// ---------------------------------------------------------------- soccer (ESPN commentary)

function soccerEvents(sum, teams) {
  const cm = [...(sum.commentary ?? [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const nameToAbbr = (n) => {
    if (!n) return undefined;
    const x = n.toLowerCase();
    if (x === teams.home.name.toLowerCase()) return teams.home.short;
    if (x === teams.away.name.toLowerCase()) return teams.away.short;
    return undefined;
  };
  const minuteOf = (x) => {
    const m = /^(\d+)'(?:\+(\d+)')?/.exec(x.time?.displayValue ?? "");
    return m ? Number(m[1]) + (m[2] ? Number(m[2]) : 0) : undefined;
  };
  const scoreRe = new RegExp(`${escapeRe(teams.home.name)} (\\d+), ${escapeRe(teams.away.name)} (\\d+)`);
  const raw = [];
  let sc = [0, 0];
  let period = 1;
  let lastWall = NaN;
  let minute = 0;
  // Corners are frequent and the question repeats: give room to trade to at most four, spread over the match.
  const corners = cm.map((x, i) => (x.play?.type?.text === "Corner Awarded" ? i : -1)).filter((i) => i >= 0);
  const featuredCorners = new Set(corners.length <= 4 ? corners : [0, 1, 2, 3].map((k) => corners[Math.round((k * (corners.length - 1)) / 3)]));
  for (let i = 0; i < cm.length; i++) {
    const x = cm[i];
    const p = x.play ?? {};
    const type = p.type?.text ?? "";
    const text = String(x.text ?? "");
    const m = minuteOf(x);
    if (m !== undefined) minute = m;
    const wall = Number.isFinite(ms(p.wallclock)) ? ms(p.wallclock) : lastWall;
    if (Number.isFinite(wall)) lastWall = wall;
    const team = nameToAbbr(p.team?.displayName);
    const s = scoreRe.exec(text);
    if (s) sc = [Number(s[1]), Number(s[2])];
    const base = { minute, wall, score: [...sc] };
    if (type === "Kickoff") {
      raw.push({ ...base, type: "kickoff", period: 1, minute: 0, team, fixed: 3000, text: `${teams.home.name} v ${teams.away.name} at ${teams.venue ?? "the stadium"}. We're underway!` });
      continue;
    }
    if (!type && /First Half ends/i.test(text)) {
      raw.push({ ...base, type: "period_end", minute: 45, fixed: 2500, text: `Halftime. ${teams.home.name} ${sc[0]}, ${teams.away.name} ${sc[1]}.` });
      continue;
    }
    if (!type && /Second Half begins/i.test(text)) {
      period = 2;
      raw.push({ ...base, type: "period_start", period: 2, minute: 45, fixed: 2500, text: "The second half is underway." });
      continue;
    }
    if (/^Goal|Own Goal/i.test(type)) {
      const player = /^Goal!.*?\.\s*(.+?) \(/.exec(text)?.[1];
      raw.push({ ...base, type: "goal", team, player, weight: 1, dwell: 5000, data: { big: true }, text: `GOAL! ${shortSoccer(text)}` });
      continue;
    }
    if (/^Penalty - (Scored|Missed|Saved)/i.test(type)) {
      const scored = /Scored/i.test(type);
      const player = /\.\s*(.+?) \(/.exec(text)?.[1];
      raw.push({ ...base, type: "penalty_result", team, player, data: { scored }, fixed: 600, text: `${player ?? "The taker"} steps up...` });
      if (scored) raw.push({ ...base, type: "goal", team, player, data: { penalty: true, big: true }, weight: 1, dwell: 5000, text: `PENALTY SCORED! ${shortSoccer(text)}` });
      else raw.push({ ...base, type: "score_update", team, weight: 1, dwell: 3000, text: `Penalty ${/Saved/i.test(type) ? "SAVED" : "MISSED"}! ${shortSoccer(text)}` });
      continue;
    }
    if (/^Penalty [A-Z]/.test(text) && /draws a foul in the penalty area/i.test(text)) {
      const awarded = nameToAbbr(/^Penalty (.+?)\./.exec(text)?.[1]);
      // The taker steps up before the kick: take their name from the result.
      const res = cm.slice(i + 1, i + 8).find((y) => /^Penalty - /.test(y.play?.type?.text ?? ""));
      const taker = res ? /\.\s*(.+?) \(/.exec(String(res.text))?.[1] : undefined;
      raw.push({ ...base, type: "penalty_awarded", team: awarded ?? team, player: taker, weight: 1, dwell: 15500, data: { big: true }, text: `PENALTY to ${teamName(teams, awarded ?? team)}! ${text.replace(/^Penalty .+?\.\s*/, "")}${taker ? ` ${taker} will take it.` : ""}` });
      continue;
    }
    if (type === "Corner Awarded") {
      // Did the same team get a shot on target from it? Look at the next few commentary lines (about 90 s of play).
      let sot = false;
      let outcomeWall = wall + 30000;
      for (let j = i + 1; j < Math.min(cm.length, i + 6); j++) {
        const y = cm[j];
        const yt = y.play?.type?.text ?? "";
        const yw = ms(y.play?.wallclock);
        if (Number.isFinite(yw) && Number.isFinite(wall) && yw - wall > 90000) break;
        if (yt === "Corner Awarded") break;
        if (nameToAbbr(y.play?.team?.displayName) === team && /^(Shot On Target|Goal|Penalty - Scored|Shot Hit Woodwork)/.test(yt)) {
          sot = yt !== "Shot Hit Woodwork";
          if (Number.isFinite(yw)) outcomeWall = yw;
          break;
        }
      }
      raw.push({ ...base, type: "corner", team, weight: 1, dwell: featuredCorners.has(i) ? 12000 : 0, text: `Corner to ${teamName(teams, team)}. ${text.replace(/^Corner, .+?\.\s*/, "")}` });
      raw.push({ ...base, wall: outcomeWall, type: "corner", team, data: { shotOnTarget: sot }, weight: 0.5, text: sot ? `The corner leads to a shot on target for ${teamName(teams, team)}!` : `Nothing comes of the ${teamName(teams, team)} corner.` });
      continue;
    }
    if (/Yellow Card|Red Card/i.test(type)) {
      const player = /^(.+?) \(/.exec(text)?.[1];
      raw.push({ ...base, type: "card", team, player, data: { color: /Red/i.test(type) ? "red" : "yellow" }, weight: 1, dwell: 2500, text: `${/Red/i.test(type) ? "RED card" : "Yellow card"}: ${text}` });
      continue;
    }
    if (type === "Substitution") {
      raw.push({ ...base, type: "sub", team, weight: 0.4, text });
      continue;
    }
    if (/^(Shot On Target|Shot Hit Woodwork)$/.test(type)) {
      raw.push({ ...base, type: "score_update", team, weight: 0.8, text: type === "Shot Hit Woodwork" ? `Off the woodwork! ${shortSoccer(text)}` : shortSoccer(text) });
      continue;
    }
    if (/End Regular Time/i.test(type)) break;
  }
  const fin = [...sc];
  raw.push({ type: "period_end", minute: 90, wall: lastWall, score: fin, fixed: 1500, text: "The referee blows for full time." });
  raw.push({ type: "final", minute: 90, wall: lastWall + 1000, score: fin, fixed: 3000, data: { big: true }, text: finalText(teams, fin, "soccer") });
  return raw;
}

function shortSoccer(t) {
  return String(t).replace(/^Goal!\s*/, "").replace(/\s+/g, " ").slice(0, 150);
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function teamName(teams, abbr) {
  return abbr === teams.home.short ? teams.home.name : abbr === teams.away.short ? teams.away.name : "them";
}

// ---------------------------------------------------------------- NBA

function nbaEvents(sum, teams) {
  const plays = sum.plays ?? [];
  const idToAbbr = teams.idToAbbr;
  const raw = [];
  let period = 1;
  const sc = (p) => [Number(p.homeScore ?? 0), Number(p.awayScore ?? 0)];
  // Free-throw trips and timeouts get room to trade; pick the ones that matter (late, close).
  const trips = [];
  const timeouts = [];
  plays.forEach((p, i) => {
    const type = p.type?.text ?? "";
    const pr = p.period?.number ?? 1;
    const margin = Math.abs(Number(p.homeScore) - Number(p.awayScore));
    const late = pr >= 4 ? 2 : pr === 2 && clockSecs(p.clock?.displayValue) < 120 ? 1 : 0;
    if (/^Free Throw - 1 of [23]$/.test(type)) trips.push({ i, s: late + (margin <= 6 ? 1.5 : 0) + ((i * 7) % 5) / 10 });
    if (/Timeout/i.test(type) && !/Official/i.test(type)) timeouts.push({ i, s: late + (margin <= 8 ? 1.5 : 0) + ((i * 3) % 5) / 10 });
  });
  const pickTrips = new Set(trips.sort((a, b) => b.s - a.s).slice(0, 7).map((t) => t.i));
  const pickTimeouts = new Set(timeouts.sort((a, b) => b.s - a.s).slice(0, 6).map((t) => t.i));
  let started = false;
  plays.forEach((p, i) => {
    const type = p.type?.text ?? "";
    const pr = p.period?.number ?? period;
    const clock = p.clock?.displayValue;
    const wall = ms(p.wallclock);
    const team = idToAbbr[p.team?.id];
    const score = sc(p);
    if (!started) {
      started = true;
      raw.push({ type: "kickoff", period: 1, clock: "12:00", team, score: [0, 0], wall, fixed: 3000, text: `${teams.away.name} at ${teams.home.name}. ${clean(p.text)}` });
      return;
    }
    if (pr !== period) {
      period = pr;
      raw.push({ type: "period_start", period: pr, clock: pr > 4 ? "5:00" : "12:00", score, wall, fixed: 1800, text: pr > 4 ? "Overtime!" : `Start of the ${ordinal(pr)} quarter.` });
    }
    if (/^End Period/i.test(type)) {
      raw.push({ type: "period_end", period: pr, clock: "0:00", score, wall, fixed: 2000, text: periodText(pr, "nba", score, teams) });
      return;
    }
    if (/^End Game/i.test(type)) return;
    if (/^Free Throw/i.test(type)) {
      const m = /(\d) of (\d)/.exec(type);
      const n = m ? Number(m[1]) : 1;
      const of = m ? Number(m[2]) : 1;
      const technical = /Technical|Flagrant/i.test(type);
      const shooter = /^(.+?) (makes|misses)/.exec(p.text ?? "")?.[1];
      // Featured trips get a "to the line" event (the engine asks about it) and room to trade.
      if (n === 1 && of >= 2 && !technical && pickTrips.has(i)) {
        raw.push({ type: "free_throw", clock, team, player: shooter, score: sc(plays[i - 1] ?? p), wall: wall - 15000, data: { trip: true, attempts: of }, dwell: 11000, fixed: 0,
          text: `${shooter ?? "The shooter"} to the line for ${of === 3 ? "three" : "two"}.` });
      }
      raw.push({ type: "free_throw", clock, team, player: shooter, score, wall, data: { made: !!p.scoringPlay, n, of, ...(technical ? { technical: true } : {}), points: p.scoringPlay ? 1 : 0 }, weight: 0.8, text: clean(p.text) });
      return;
    }
    if (p.shootingPlay) {
      const made = !!p.scoringPlay;
      const pts = made ? Number(p.scoreValue ?? 2) : 0;
      const three = Number(p.pointsAttempted) === 3 || /three point/i.test(p.text ?? "");
      raw.push({ type: "shot", clock, team, score, wall, data: { made, points: pts, three }, weight: made ? 1 : 0.6, dwell: made && three ? 600 : 0, text: (made && three ? "THREE! " : "") + clean(p.text) });
      return;
    }
    if (/Turnover/i.test(type)) {
      raw.push({ type: "turnover", clock, team, score, wall, weight: 0.7, text: clean(p.text) });
      return;
    }
    if (/Timeout/i.test(type) && !/Official/i.test(type)) {
      // Who has the ball after the timeout: the team of the next shot or turnover.
      const next = plays.slice(i + 1).find((q) => q.shootingPlay || /Turnover/i.test(q.type?.text ?? "") || /^Free Throw/.test(q.type?.text ?? ""));
      const ball = next ? idToAbbr[next.team?.id] : team;
      // Featured timeouts say who has the ball (the engine asks "do they score next?") and leave room to trade.
      const featured = pickTimeouts.has(i) && !!ball;
      raw.push({ type: "timeout", clock, team, score, wall, ...(featured ? { data: { ball } } : {}), dwell: featured ? 11000 : 0, weight: 0.8, text: `${clean(p.text)}.` });
      return;
    }
  });
  const last = plays.at(-1);
  const fin = last ? sc(last) : [0, 0];
  raw.push({ type: "final", clock: "0:00", score: fin, wall: ms(last?.wallclock) + 1000, fixed: 3000, data: { big: true }, text: finalText(teams, fin, "nba") });
  // Crunch time plays slower: the last two minutes of a close game get four times the filler time, and the
  // last 2:30 of every quarter half again as much (so "who wins the quarter?" has room to trade).
  let cur = 1;
  for (const e of raw) {
    if (e.type === "period_start") cur = e.period;
    if (e.fixed !== undefined) continue;
    const left = anySecs(e.clock);
    if (left === undefined) continue;
    const close = e.score && Math.abs(e.score[0] - e.score[1]) <= 6;
    if (cur >= 4 && left <= 120 && close) e.weight = (e.weight ?? 1) * 4;
    else if (left <= 150) e.weight = (e.weight ?? 1) * 1.6;
  }
  return raw;
}

/** "4:21" or "32.3" -> seconds. */
function anySecs(display) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(display ?? ""));
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const s = /^(\d{1,2})(?:\.\d+)?$/.exec(String(display ?? ""));
  return s ? Number(s[1]) : undefined;
}

// ---------------------------------------------------------------- Gemini

function geminiKind(ev) {
  const sm = ev.sportsMarket ?? {};
  const scope = sm.scope?.type;
  if (sm.type === "moneyline") {
    if (scope === "quarter" || scope === "half") return { kind: "period_winner", period: `${sm.scope.ordinal}${scope === "quarter" ? "Q" : "H"}` };
    return { kind: "moneyline" };
  }
  if (sm.type === "total" && (!sm.subject || sm.subject === "contest") && scope !== "quarter" && scope !== "half") return { kind: "total" };
  return null;
}

function priceAt(candles, t) {
  // candles: [[startMs, open, high, low, close], ...] ascending, 5 minute buckets. Interpolate open -> close.
  if (!candles.length || t < candles[0][0]) return null;
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  const c = candles[lo];
  const into = t - c[0];
  if (into >= 300000) return c[4];
  return Math.round((c[1] + (c[4] - c[1]) * (into / 300000)) * 1000) / 1000;
}

async function geminiFor(league, kickoffIso, teams) {
  const prefix = `${LEAGUES[league].gemini}-${yymmddHHMM(kickoffIso)}`;
  const found = [];
  for (const status of ["settled", "active", "closed"]) {
    for (let offset = 0; offset < 1000; offset += 100) {
      try {
        const d = await getJson(`${GEMINI}/v1/prediction-markets/events?category=sports&limit=100&offset=${offset}&status=${status}&search=${prefix}`);
        found.push(...(d.data ?? []));
        if (offset + 100 >= (d.pagination?.total ?? 0)) break;
      } catch {
        break; // try the next status
      }
    }
  }
  // Match the game: the moneyline event whose participants/title name our two teams.
  const words = (t) => [t.name, t.location, t.nick, t.short].filter(Boolean).flatMap((s) => s.toLowerCase().split(/\s+/)).filter((w) => w.length >= 3 || w === t.short.toLowerCase());
  const hw = words(teams.home);
  const aw = words(teams.away);
  const scoreEv = (e) => {
    const title = `${e.title} ${(e.participants ?? []).map((p) => `${p.name} ${p.abbreviation}`).join(" ")}`.toLowerCase();
    return (hw.some((w) => title.includes(w)) ? 1 : 0) + (aw.some((w) => title.includes(w)) ? 1 : 0);
  };
  const ml = found.filter((e) => /-M$/.test(e.ticker)).sort((a, b) => scoreEv(b) - scoreEv(a))[0];
  if (!ml || scoreEv(ml) < 2) return null;
  const base = ml.ticker.replace(/-M$/, "");
  const parts = ml.participants ?? [];
  const codeFor = (side) => parts.find((p) => p.side === side)?.abbreviation;
  const evs = [...new Map(found.filter((e) => e.ticker.startsWith(`${base}-`)).map((e) => [e.ticker, e])).values()];
  const kept = [];
  for (const e of evs) {
    const k = geminiKind(e);
    if (!k) continue;
    let full = e;
    if (!e.contracts?.length) full = await getJson(`${GEMINI}/v1/prediction-markets/events/${e.ticker}`);
    kept.push({ ...k, ev: full });
  }
  const kickoff = ms(kickoffIso);
  const candleOf = new Map();
  const jobs = kept.flatMap((k) => (k.ev.contracts ?? []).map((c) => ({ k, c })));
  await pool(jobs, 6, async ({ c }) => {
    try {
      const raw = await getJson(`${GEMINI}/v2/candles/${c.instrumentSymbol}/5m`);
      candleOf.set(c.instrumentSymbol, (Array.isArray(raw) ? raw : []).map((x) => x.map(Number)).sort((a, b) => a[0] - b[0]));
    } catch {
      candleOf.set(c.instrumentSymbol, []);
    }
  });
  const pre = kickoff - 60000;
  const snapEvents = [];
  const tracked = [];
  for (const k of kept) {
    const contracts = (k.ev.contracts ?? []).map((c) => ({ c, p: priceAt(candleOf.get(c.instrumentSymbol) ?? [], pre) }));
    let use = contracts.filter((x) => x.p !== null);
    if (k.kind === "total") {
      use = use.filter((x) => x.p > 0.06 && x.p < 0.94).sort((a, b) => Math.abs(a.p - 0.5) - Math.abs(b.p - 0.5)).slice(0, 5);
      if (use[0]) tracked.push({ ev: k.ev, c: use[0].c });
    } else {
      for (const x of contracts) if ((candleOf.get(x.c.instrumentSymbol) ?? []).length) tracked.push({ ev: k.ev, c: x.c });
    }
    if (!use.length) continue;
    snapEvents.push({
      ticker: k.ev.ticker, title: k.ev.title, ...(k.ev.slug ? { slug: k.ev.slug } : {}),
      contracts: use.map((x) => ({ ticker: x.c.ticker, label: x.c.label, lastTradePrice: x.p.toFixed(3) })),
    });
  }
  const order = (t) => (/-M$/.test(t) ? 0 : /-T$|-REGT$/.test(t) ? 1 : 2);
  snapEvents.sort((a, b) => order(a.ticker) - order(b.ticker) || a.ticker.localeCompare(b.ticker));
  const settledAt = kept.map((k) => k.ev.resolvedAt).filter(Boolean).sort().at(-1) ?? null;
  return { base, home: codeFor("home"), away: codeFor("away"), status: ml.status, settledAt, kickoff: kickoffIso, slug: ml.slug, snapshot: { asOf: new Date(pre).toISOString(), events: snapEvents }, tracked, candleOf };
}

/** Gemini's real price at every replay event, per tracked contract (deduped to moves of half a cent or more). */
function buildTrack(events, g) {
  const track = {};
  for (const { ev, c } of g.tracked) {
    const candles = g.candleOf.get(c.instrumentSymbol) ?? [];
    const pts = [];
    let last = null;
    for (const e of events) {
      if (!Number.isFinite(e.wall)) continue;
      const p = priceAt(candles, e.wall);
      if (p === null) continue;
      if (last === null || Math.abs(p - last) >= 0.005 || e === events[events.length - 1]) {
        pts.push([e.atMs, Math.round(p * 1000) / 1000]);
        last = p;
      }
    }
    if (pts.length) (track[ev.ticker] ??= {})[c.ticker] = pts;
  }
  return track;
}

// ---------------------------------------------------------------- one game

function teamsFrom(sum, league) {
  const comp = sum.header?.competitions?.[0];
  const cs = comp?.competitors ?? [];
  const mk = (c) => {
    const t = c.team;
    const name = t.displayName;
    const words = name.split(/\s+/);
    return {
      id: t.id, name, short: t.abbreviation, color: teamColor(t), location: t.location,
      nick: league === "eng.1" ? (t.shortDisplayName ?? name) : (t.name ?? words.at(-1)),
    };
  };
  const home = mk(cs.find((c) => c.homeAway === "home"));
  const away = mk(cs.find((c) => c.homeAway === "away"));
  const idToAbbr = { [home.id]: home.short, [away.id]: away.short };
  const byAbbr = { [home.short]: home, [away.short]: away };
  return { home, away, idToAbbr, byAbbr, venue: sum.gameInfo?.venue?.fullName, date: comp?.date, final: [Number(cs.find((c) => c.homeAway === "home")?.score), Number(cs.find((c) => c.homeAway === "away")?.score)] };
}

export async function buildGame(spec) {
  const L = LEAGUES[spec.league];
  if (!L) throw new Error(`unknown league ${spec.league}`);
  const sum = await getJson(`${ESPN}/${L.path}/summary?event=${spec.event}`);
  const status = sum.header?.competitions?.[0]?.status?.type;
  if (!status?.completed) throw new Error(`${spec.id}: ESPN event ${spec.event} is not final (${status?.name})`);
  const teams = teamsFrom(sum, spec.league);
  const kickoff = teams.date;
  const raw = L.sport === "nfl" ? nflEvents(sum, teams) : L.sport === "nba" ? nbaEvents(sum, teams) : soccerEvents(sum, teams);
  const g = await geminiFor(spec.league, kickoff, teams).catch((e) => {
    console.warn(`  gemini: ${e.message}`);
    return null;
  });
  // Our team codes: Gemini's when it lists the game (e.g. MUN, not ESPN's MAN), so contracts map 1:1.
  const remap = {};
  if (g?.home && g.home !== teams.home.short) remap[teams.home.short] = g.home;
  if (g?.away && g.away !== teams.away.short) remap[teams.away.short] = g.away;
  for (const [from, to] of Object.entries(remap)) {
    for (const e of raw) {
      if (e.team === from) e.team = to;
      if (e.data?.ball === from) e.data.ball = to;
    }
    if (teams.home.short === from) teams.home.short = to;
    if (teams.away.short === from) teams.away.short = to;
  }
  const scheduled = schedule(raw, spec.target * 1000, L.sport === "nba" ? { minFill: 350, maxFill: 1400 } : L.sport === "soccer" ? { maxFill: 5000 } : {});
  const events = scheduled.map((e) => {
    const out = { atMs: e.atMs, type: e.type };
    if (e.period !== undefined) out.period = e.period;
    if (e.minute !== undefined && L.sport === "soccer") out.minute = e.minute;
    if (e.clock !== undefined && L.sport !== "soccer") out.clock = e.clock;
    if (e.team) out.team = e.team;
    if (e.player) out.player = e.player;
    if (e.data && Object.keys(e.data).length) out.data = Object.fromEntries(Object.entries(e.data).filter(([, v]) => v !== undefined));
    if (e.score) out.score = e.score;
    if (e.text) out.text = e.text;
    if (Number.isFinite(e.wall)) out.wall = new Date(e.wall).toISOString();
    return out;
  });
  const withWall = events.map((e, i) => ({ atMs: e.atMs, wall: ms(e.wall), i }));
  const track = g ? buildTrack(withWall, g) : {};
  const durationMs = events.at(-1).atMs + 3000;
  const short = (t) => (L.sport === "soccer" ? t.nick : t.nick);
  const title = L.sport === "soccer" ? `${teams.home.name} v ${teams.away.name}` : `${teams.away.name} at ${teams.home.name}`;
  const file = {
    id: spec.id,
    sport: L.sport,
    league: L.label,
    title,
    date: new Date(kickoff).toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
    description: `${spec.note} Real play-by-play from ESPN (event ${spec.event}), compressed to about ${Math.round(durationMs / 60000)} minutes of demo time; Gemini prices are Gemini's real prices at each moment of the game.`,
    real: true,
    source: { provider: "ESPN", event: spec.event, league: spec.league, url: `https://www.espn.com/${L.sport === "soccer" ? "soccer" : L.sport}/game/_/gameId/${spec.event}`, fetchedAt: new Date().toISOString() },
    venue: teams.venue,
    home: { name: teams.home.name, short: teams.home.short, color: teams.home.color, nick: short(teams.home) },
    away: { name: teams.away.name, short: teams.away.short, color: teams.away.color, nick: short(teams.away) },
    final: teams.final,
    startsAt: kickoff,
    durationMs,
    gemini: g
      ? {
          event: g.base, home: g.home, away: g.away, status: g.status, settledAt: g.settledAt, kickoff: g.kickoff,
          url: `https://www.gemini.com/predictions/${g.base}-M${g.slug ? `/${g.slug}` : ""}`,
          builtAt: new Date().toISOString(), snapshot: g.snapshot, track,
        }
      : null,
    events,
  };
  await mkdir(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${spec.file}.json`);
  await writeFile(path, `${JSON.stringify(file, null, 0).replace(/\{"atMs"/g, '\n{"atMs"')}\n`);
  const counts = events.reduce((a, e) => ((a[e.type] = (a[e.type] ?? 0) + 1), a), {});
  console.log(`${spec.id}: ${title} (${file.date}) ${teams.final.join("-")}  ${events.length} events, ${Math.round(durationMs / 1000)} s demo  gemini=${g ? `${g.base} (${g.status}), ${Object.values(track).reduce((a, c) => a + Object.keys(c).length, 0)} tracked contracts` : "none"}`);
  console.log(`  ${JSON.stringify(counts)}  -> ${path}`);
  return file;
}

// ---------------------------------------------------------------- cli

async function main() {
  const args = process.argv.slice(2);
  let specs = GAMES;
  const flag = (n) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (flag("event")) {
    const id = flag("id") ?? `replay-${flag("event")}`;
    specs = [{ id, file: id.replace(/^replay-/, ""), league: flag("league") ?? "nfl", event: flag("event"), target: Number(flag("target") ?? 400), note: "" }];
  } else if (args.length) {
    specs = GAMES.filter((g) => args.includes(g.id) || args.includes(g.file));
    if (!specs.length) throw new Error(`no game matches ${args.join(" ")}`);
  }
  let failed = 0;
  for (const s of specs) {
    try {
      await buildGame(s);
    } catch (e) {
      failed++;
      console.error(`${s.id}: FAILED ${e.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
