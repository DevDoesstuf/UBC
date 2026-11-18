// What the kiosk touchscreen shows. The ESP32 firmware (and the /kiosk web page) draw exactly this JSON
// and send back the id of whatever was touched. Change labels/flow here; no reflashing needed.
//
// Contract (keep in sync with firmware/kiosk_screen and README "Kiosk API"):
//   screen    one of select | lobby | market | locked | result | ended | message (unknown -> draw title/subtitle/buttons)
//   title, subtitle, color (blue|amber|red|green|gray), footer
//   tiles     [{id,label,sub,enabled}]                       select screen, up to 4
//   code, joinUrl, qr {size, rows:["0101..."]}, players[]    lobby screen
//   question, yes, no (cents 1-99), move (-1|0|1), history[] (cents), traded, lockIn (seconds)   market/locked
//   result ("YES"|"NO"), lines[]                              result / ended
//   buttons   [{id,label,style}]  style: primary|yes|no|plain, drawn as a row along the bottom
import QRCode from "qrcode";
import { allGames, getGame } from "./games";
import {
  ApiError, createLobby, endSession, getKioskCode, getKioskLobby, getLobby, lockMarket, mutate, openMarket,
  releaseKiosk, resolveMarket, usd,
} from "./lobby";
import * as lobbyModule from "./lobby";
import * as lmsr from "./lmsr";
import type { Lobby } from "./types";

// ---------------------------------------------------------------- "Call it!" moments
// The room slams these on the box when something happens on TV; each opens a quick market on that moment.
// `momentsFor(l)` and `openMoment(l, kind, now)` come from lib/lobby.ts (backend). Read them through the module
// object so this file still builds where they do not exist yet.
type MomentButton = { id: string; label: string };
const backend = lobbyModule as unknown as {
  momentsFor?: (l: Lobby) => MomentButton[];
  openMoment?: (l: Lobby, kind: string, now: number) => void;
};
/** Used only when the backend can open moments but does not list them. */
const FALLBACK_MOMENTS: MomentButton[] = [
  { id: "moment:score", label: "Score!" },
  { id: "moment:turnover", label: "Turnover!" },
];
/**
 * Bottom-row budget (firmware ui.cpp drawButtons): w = (768 - (n-1)*16) / n, label cut to w - 20 px in
 * helvB24 (about 13 px a character). 4 buttons = 180 px each, labels up to about 11 characters. The firmware
 * also keeps at most 8 hit areas. So: at most 2 moments next to 2 host buttons, labels at most 11 characters.
 */
const MAX_MOMENTS = 2;
const MOMENT_LABEL = 11;
function moments(l: Lobby): KioskButton[] {
  if (typeof backend.openMoment !== "function") return [];
  let list: MomentButton[] = [];
  try {
    list = typeof backend.momentsFor === "function" ? backend.momentsFor(l) ?? [] : FALLBACK_MOMENTS;
  } catch {
    list = [];
  }
  return list
    .filter((b) => b && typeof b.id === "string" && b.id.startsWith("moment:") && typeof b.label === "string")
    .slice(0, MAX_MOMENTS)
    // Longer labels still draw: the firmware (and KioskView) end them with "...". Keep backend labels short.
    .map((b) => ({ id: b.id, label: k(b.label).trim().slice(0, MOMENT_LABEL + 9), style: "yes" as const }));
}

export interface KioskButton {
  id: string;
  label: string;
  style?: "primary" | "yes" | "no" | "plain";
}

export interface KioskScreen {
  screen: "select" | "lobby" | "market" | "locked" | "result" | "ended" | "message";
  kiosk: string;
  title: string;
  subtitle: string;
  color: "blue" | "amber" | "red" | "green" | "gray";
  footer: string;
  tiles?: { id: string; label: string; sub: string; enabled: boolean }[];
  code?: string;
  joinUrl?: string;
  qr?: { size: number; rows: string[] };
  players?: string[];
  question?: string;
  yes?: number;
  no?: number;
  move?: number;
  history?: number[];
  traded?: string;
  lockIn?: number;
  result?: "YES" | "NO";
  lines?: string[];
  buttons: KioskButton[];
}

/** The firmware uses Latin-1 fonts: swap typographic characters and drop anything it cannot draw. */
function k(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

function qrRows(text: string): { size: number; rows: string[] } {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const rows: string[] = [];
  for (let r = 0; r < size; r++) {
    let row = "";
    for (let c = 0; c < size; c++) row += qr.modules.get(r, c) ? "1" : "0";
    rows.push(row);
  }
  return { size, rows };
}

export async function kioskScreen(kioskId: string, baseUrl: string): Promise<KioskScreen> {
  const l = await getKioskLobby(kioskId);
  // Look (firmware palette only): header green while a lobby or question is live and when YES wins, gray for
  // calm screens. Main actions use the "yes" style (the firmware's green) instead of "primary" (blue).
  // Copy stays short and Latin-1 (the firmware truncates titles at 560 px and subtitles at 750 px).
  const footer = `Huddle · Kiosk ${kioskId}`;

  if (!l) {
    return {
      screen: "select", kiosk: kioskId, color: "gray", footer,
      title: "Pick a game",
      subtitle: "Then everyone taps a phone here to join",
      tiles: allGames().slice(0, 4).map((g) => {
        const enabled = g.live && g.questions.length > 0;
        return { id: `game:${g.id}`, label: k(g.title), sub: k(enabled ? g.subtitle || "Live" : "Coming soon"), enabled };
      }),
      buttons: [],
    };
  }

  const game = getGame(l.gameId);
  const total = game?.questions.length ?? 0;
  const footerL = `Huddle · ${l.code}`;
  const m = l.market;
  const players = l.order.map((id) => l.players[id]);

  if (l.phase === "lobby") {
    const joinUrl = `${baseUrl}/l/${l.code}`;
    // Once someone is in, the box becomes the controller: "Call it!" moments sit next to the host buttons.
    const calls = players.length ? moments(l) : [];
    return {
      screen: "lobby", kiosk: kioskId, color: "green", footer: footerL,
      title: k(game?.title ?? "Lobby"),
      subtitle: calls.length
        ? `${players.length} in  ·  See a play coming? Slam a green button to call it`
        : `Tap your phone or scan to join  ·  ${players.length} in`,
      code: l.code,
      joinUrl: joinUrl.replace(/^https?:\/\//, ""),
      qr: qrRows(joinUrl),
      players: players.map((p) => k(`${p.name}  ${p.deposited > 0 ? usd(p.balance) : "adding money..."}`)),
      question: k(game?.questions[l.qIndex]?.text ?? ""),
      buttons: calls.length
        ? [{ id: "start", label: `Start Q${l.qIndex + 1}`, style: "plain" }, ...calls, { id: "cancel", label: "Cancel", style: "plain" }]
        : [
            { id: "start", label: `Start question ${l.qIndex + 1}`, style: "yes" },
            { id: "cancel", label: "Cancel", style: "plain" },
          ],
    };
  }

  if ((l.phase === "open" || l.phase === "locked") && m) {
    const py = lmsr.priceYes(m.yes, m.no, m.b);
    const yes = lmsr.toCents(py);
    const base = {
      kiosk: kioskId, footer: footerL,
      question: k(m.text),
      yes, no: 100 - yes, move: m.lastMove,
      history: m.history.slice(-40).map((p) => lmsr.toCents(p)),
      traded: `${usd(m.volume)} traded`,
    };
    if (l.phase === "open") {
      return {
        ...base, screen: "market", color: "green",
        title: String(m.questionId).startsWith("moment") ? "Called it! Live moment" : `Question ${m.qIndex + 1} of ${total}`,
        subtitle: "Buy YES or NO on your phone. A winning share pays $1",
        lockIn: Math.max(0, Math.ceil((m.lockAt - Date.now()) / 1000)),
        buttons: [{ id: "lock", label: "Lock now", style: "plain" }],
      };
    }
    return {
      ...base, screen: "locked", color: "gray",
      title: "Trading closed",
      subtitle: m.resolveAt ? "Watch the play. The result comes in by itself" : "Watch the play, then tap what happened",
      lockIn: 0,
      buttons: [
        { id: "resolve:yes", label: "It was YES", style: "yes" },
        { id: "resolve:no", label: "It was NO", style: "no" },
      ],
    };
  }

  if (l.phase === "result" && m && m.outcome) {
    const winners = Object.entries(m.payouts).sort((a, b) => b[1] - a[1]);
    const more = l.qIndex < total;
    const calls = moments(l);
    const end = { id: "end", label: calls.length ? "End" : "End session", style: "plain" as const };
    return {
      screen: "result", kiosk: kioskId, color: m.outcome === "yes" ? "green" : "gray", footer: footerL,
      title: m.outcome === "yes" ? "It was YES" : "It was NO",
      subtitle: `${winners.length ? `${winners.length} ${winners.length === 1 ? "winner" : "winners"}` : "No winners"}  ·  ${usd(m.volume)} traded  ·  winning shares pay $1`,
      result: m.outcome === "yes" ? "YES" : "NO",
      question: k(m.text),
      lines: winners.length
        ? winners.slice(0, 6).map(([id, c]) => k(`${l.players[id]?.name ?? "?"}  +${usd(c)}`))
        : ["Nobody called it this time"],
      buttons: calls.length
        ? [...(more ? [{ id: "next", label: `Start Q${l.qIndex + 1}`, style: "plain" as const }] : []), ...calls, end]
        : more
          ? [{ id: "next", label: `Start question ${l.qIndex + 1}`, style: "yes" }, end]
          : [{ ...end, style: "yes" }],
    };
  }

  // ended
  const board = [...players].sort((a, b) => b.balance + b.withdrawn - (a.balance + a.withdrawn));
  return {
    screen: "ended", kiosk: kioskId, color: "gray", footer: footerL,
    title: "Session over",
    subtitle: "Thanks for playing. Cash out on your phone",
    lines: board.slice(0, 6).map((p, i) => k(`${i + 1}.  ${p.name}  ${usd(p.balance + p.withdrawn)}`)),
    buttons: [{ id: "new", label: "New game", style: "yes" }],
  };
}

/** A touch on the kiosk. `id` is a button or tile id from kioskScreen. Returns the new screen. */
export async function kioskTouch(kioskId: string, id: string, baseUrl: string): Promise<KioskScreen> {
  const [action, arg] = String(id || "").split(":");
  const code = await getKioskCode(kioskId);

  if (action === "game") {
    const current = code ? await getLobby(code) : null;
    if (current && current.phase !== "ended") throw new ApiError(400, "A game is already running");
    await createLobby(kioskId, arg);
    return kioskScreen(kioskId, baseUrl);
  }
  if (!code) throw new ApiError(400, "Pick a game first");

  switch (action) {
    case "start":
    case "next":
      await mutate(code, (l, now) => openMarket(l, now));
      break;
    case "lock":
      await mutate(code, (l) => lockMarket(l));
      break;
    case "resolve":
      if (arg !== "yes" && arg !== "no") throw new ApiError(400, "Bad result");
      await mutate(code, (l, now) => resolveMarket(l, arg, now));
      break;
    case "end":
      await mutate(code, (l) => endSession(l));
      break;
    case "cancel":
    case "new":
      await releaseKiosk(kioskId, code);
      break;
    case "moment": {
      // "Call it!": the room slammed a moment button. The backend opens a quick market on it.
      const open = backend.openMoment;
      const kind = String(arg || "").replace(/[^\w-]/g, "").slice(0, 32);
      if (typeof open !== "function") throw new ApiError(400, "Calls are not switched on yet");
      if (!kind) throw new ApiError(400, "Unknown call");
      await mutate(code, (l, now) => open(l, kind, now));
      break;
    }
    default:
      throw new ApiError(400, "Unknown button");
  }
  return kioskScreen(kioskId, baseUrl);
}
