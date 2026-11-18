import type { Side } from "./lmsr";
import type { Persona } from "./announcer";
import type { GeminiGameConfig, GeminiRef, GeminiSnapshot } from "./gemini";
import type { ScoreEntry } from "./scorecard";
import type { MatchedPair } from "./modes";
import type { ReplayRun } from "./replay/run";
import type { GeminiHint } from "./replay/types";
export type { Side, Persona, GeminiRef, ScoreEntry, MatchedPair };

/** How a question is traded. market = LMSR (default), pool = pari-mutuel pot, h2h = offers between players. */
export type MarketMode = "market" | "pool" | "h2h";
export const MARKET_MODES: MarketMode[] = ["market", "pool", "h2h"];

/** Lobby phases. The kiosk screen, phone page and watch page are all views of this one field. */
export type Phase = "lobby" | "open" | "locked" | "result" | "ended";

export interface Question {
  id: string;
  text: string;
  short?: string;
  /** Seconds into the video where this question's segment starts (video jumps here when trading opens). */
  startAt: number;
  /** Seconds into the video when trading closes. */
  lockAt: number;
  /** Seconds into the video when the play is over (used for auto-resolve when `answer` is set). */
  resolveAt?: number | null;
  /** Known outcome of the clip. If set, the market resolves itself at resolveAt. If null, the host taps it. */
  answer?: Side | null;
  /** Model probability of YES (0..1). The LMSR opens at this price instead of 50/50 (clamped to 5..95%). */
  prior?: number | null;
  /** Comparable Gemini contract: event ticker and the contract code that means YES (e.g. "DAL"). */
  gemini?: { event: string; contract: string } | null;
}

export interface Game {
  id: string;
  title: string;
  subtitle?: string;
  live: boolean;
  color?: string;
  youtubeId: string;
  b?: number;
  questions: Question[];
  /** clip (default): YouTube clip + configured questions. replay: timeline + engine-written questions. */
  kind?: "clip" | "replay";
  /** Replay timeline id (config/replays/*.json), for kind=replay. */
  replay?: string;
  /** Default trading mode for lobbies of this game (market if unset). */
  mode?: MarketMode;
  /** Announcer persona for captions (nfl | soccer | calm). */
  persona?: Persona;
  /** Gemini Prediction Markets mapping for the game. */
  gemini?: GeminiGameConfig;
  /** Sport, for "Call it" moments (default: the replay's sport, else from the persona). */
  sport?: "nfl" | "soccer" | "nba";
  /** "Call it" moment kinds the kiosk offers for this game (see MOMENT_KINDS in lib/moments.ts). */
  moments?: string[];
  /** Real replayed games: league label, local date of the game, and where the play-by-play came from (from the replay file). */
  league?: string;
  date?: string;
  real?: boolean;
  source?: { provider: string; event: string; url: string | null } | null;
}

export interface Player {
  id: string;
  token: string;
  name: string;
  /** Spendable balance in cents. */
  balance: number;
  /** Total deposited in cents (for the kiosk's "deposit status"). */
  deposited: number;
  withdrawn: number;
  joinedAt: number;
  lastSyncAt?: number;
  /** Solana wallet the player paid from or got faucet money at (default cash-out address). */
  solanaAddress?: string;
  /** Faucet already used in this lobby. */
  fauceted?: boolean;
}

export interface Position {
  yes: number; // shares
  no: number; // shares
  spent: number; // cents
}

export interface Trade {
  at: number;
  playerId: string;
  name: string;
  side: Side;
  cents: number;
  shares: number;
  priceAfter: number; // YES price 0..1 after this trade
}

export interface Market {
  qIndex: number;
  questionId: string;
  text: string;
  short: string;
  b: number;
  yes: number; // YES shares outstanding
  no: number; // NO shares outstanding
  volume: number; // cents traded
  openedAt: number; // ms epoch: video was at q.startAt at this moment
  startAt: number; // video seconds
  lockAt: number; // ms epoch
  lockAtVideo: number; // video seconds
  resolveAt: number | null; // ms epoch (auto-resolve), null = host resolves
  history: number[]; // YES price 0..1 after each trade, starts at 0.5
  lastMove: -1 | 0 | 1;
  positions: Record<string, Position>;
  trades: Trade[];
  outcome: Side | null;
  payouts: Record<string, number>; // cents
  resolvedAt: number | null;
  /** Trading mode (missing = market). */
  mode?: MarketMode;
  /** Model YES probability the market opened at (null/missing = no model, opened at 50/50). */
  model?: number | null;
  /** Gemini's comparable YES quote (refreshed while open, frozen at lock). */
  gemini?: GeminiRef | null;
  /** Gemini's YES probability when the question opened (null = no comparable Gemini market). */
  geminiAtOpen?: number | null;
  /** Room vs Gemini over time: a point whenever either price moves, plus open and lock (max 120). */
  trail?: { at: number; room: number; gemini: number | null }[];
  /** How to find the Gemini quote again: a hint for replay questions, or a fixed contract for clip questions. */
  geminiKey?: { hint?: GeminiHint; yesTeam?: string; event?: string; contract?: string } | null;
  /** YES price when trading locked (the room's forecast for the scorecard). */
  priceAtLock?: number | null;
  /** Pool mode: cents staked per side, and per player. */
  pool?: { yes: number; no: number };
  stakes?: Record<string, { yes: number; no: number }>;
  /** Head-to-head mode: offers and matched pairs. */
  offers?: Offer[];
  pairs?: MatchedPair[];
  /** Resolved as void: every stake refunded. */
  voided?: boolean;
  voidReason?: string | null;
  /** Where the question came from. */
  source?:
    | { kind: "replay"; templateId: string; key: string; rationale: string; moment?: string }
    | { kind: "clip" }
    | { kind: "moment"; moment: string; label: string; rationale: string };
}

export interface Offer {
  id: string;
  /** Maker player id. */
  by: string;
  name: string;
  side: Side;
  /** Maker stake in cents. */
  cents: number;
  /** Maker stake matched so far. */
  filled: number;
  /** Decimal odds for the maker's side (1.01..50). */
  odds: number;
  open: boolean;
  at: number;
}

export interface Caption {
  id: number;
  at: number;
  text: string;
  /** Lobby event kind it narrates. */
  kind?: string;
}

export interface LobbyEvent {
  id: number;
  at: number;
  kind: "join" | "start" | "lock" | "result" | "deposit" | "end" | "tap";
  text: string;
  sound?: "join" | "start" | "lock" | "win" | "tap";
}

export interface Result {
  qIndex: number;
  text: string;
  outcome: Side;
  volume: number;
  payouts: Record<string, number>;
}

export interface DepositRecord {
  playerId: string;
  cents: number;
  at: number;
  source: "demo" | "coinbase" | "solana";
  ref?: string;
}

export interface WithdrawalRecord {
  playerId: string;
  cents: number;
  at: number;
  to: string | null;
  txHash: string | null;
  /** "pending": a Solana cash-out was sent but not confirmed yet (settled on the player's next cash-out or sync). */
  status: "demo" | "sent" | "failed" | "pending";
  error?: string;
  /** Solana: the transaction's last valid block height (after it, an unseen transaction can never land). */
  validUntil?: number;
}

export interface Lobby {
  code: string;
  kioskId: string;
  gameId: string;
  createdAt: number;
  updatedAt: number;
  /** Bumped on every change. Clients can skip work when it has not moved. */
  v: number;
  phase: Phase;
  /** Index of the current (or next to open) question. */
  qIndex: number;
  players: Record<string, Player>;
  order: string[];
  market: Market | null;
  results: Result[];
  events: LobbyEvent[];
  eventSeq: number;
  deposits: Record<string, DepositRecord>;
  withdrawals: WithdrawalRecord[];
  /** House profit/loss in cents across resolved markets: volume in minus payouts out. */
  housePnl: number;
  /** Trading mode for new questions (missing = the game's default, else market). */
  mode?: MarketMode;
  /** Announcer lines, newest last (about 10 kept). */
  captions?: Caption[];
  /** Resolved questions for the room / model / Gemini scorecard. */
  scoreEntries?: ScoreEntry[];
  /** Replay games: the running game clock and question engine state. */
  replay?: ReplayRun;
  /** Latest Gemini quotes for this game (copied in from the 30 s cache). */
  gemini?: GeminiSnapshot | null;
  /** MONEY_MODE=solana: open Solana Pay deposit requests by reference key. */
  solanaRefs?: Record<string, { playerId: string; cents: number; at: number }>;
  /**
   * "Pay on the box": a phone asked the box to show a Solana Pay QR for this player's deposit. The box draws it and
   * clears it on touch `pay:close`; the server sets `paidAt` once the payment is credited and clears it ~4 s later
   * (or at `until`, ~90 s after it was asked for).
   */
  boxPay?: { playerId: string; name: string; cents: number; url: string /* solana: transfer-request URL */; reference: string; at: number; until: number /* ms epoch, ~90 s */; paidAt?: number | null } | null;
  /** Every on-chain action for this lobby, newest last (about 40 kept): what the phones and TV link to. */
  chain?: ChainEvent[];
  /** SETTLEMENT=vault: this party's huddle_vault accounts and settlement progress. */
  vault?: LobbyVault;
}

/** One Solana transaction Huddle made or saw for a lobby. */
export interface ChainEvent {
  at: number;
  kind: "deposit" | "faucet" | "cashout" | "create" | "sweep" | "topup" | "close" | "state" | "finalize" | "withdraw" | "host";
  sig: string;
  explorer: string;
  playerId?: string;
  cents?: number;
  /** Who found it: our own send ("server"), deposit polling ("sync"), the box QR check ("box"), or QuickNode ("quicknode"). */
  via?: "server" | "sync" | "box" | "quicknode";
  /** A QuickNode Stream also delivered this transaction. */
  streamed?: boolean;
}

export interface VaultTx {
  sig: string;
  explorer: string;
  at: number;
}

/** A credited Solana Pay deposit moved from the treasury into the party vault by the program's `deposit`. */
export interface VaultSweep {
  playerId: string;
  cents: number;
  status: "pending" | "sent" | "unclear";
  sig?: string;
  explorer?: string;
  validUntil?: number;
  at: number;
  error?: string;
}

export interface LobbyVault {
  program: string;
  /** Party PDA ["party", host, party_id] and its token vault PDA ["vault", party]. */
  party: string;
  vault: string;
  partyId: string;
  host: string;
  boxSigner: string;
  /** Explorer link of the party account. */
  explorer: string;
  status: "open" | "closing" | "finalized" | "settled";
  created?: VaultTx | null;
  /** Keyed by the deposit record key (`sol-<payment signature>`). */
  sweeps: Record<string, VaultSweep>;
  /** House top-up when the room won more than it put in (the house seat's claim is 0). */
  topUp?: (VaultTx & { cents: number }) | null;
  closed?: VaultTx | null;
  /** Signed final balance per member seat, verified on chain through the Ed25519 program. */
  states: Record<string, VaultTx & { cents: number; playerId: string | null }>;
  finalized?: VaultTx | null;
  /** Payouts by player id ("house" for the house seat): vault -> seat -> the player's own wallet, one transaction. */
  payouts: Record<string, VaultTx & { cents: number; to: string }>;
  hostPayout?: (VaultTx & { cents: number }) | null;
  /** Signatures of sends whose confirmation was unclear, by step ("pay:<playerId>", "close"...), for reconciling. */
  inflight?: Record<string, string>;
  error?: string | null;
  lastTryAt?: number;
}
