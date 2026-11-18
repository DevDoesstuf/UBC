import type { Side } from "./lmsr";
export type { Side };

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
  source: "demo" | "coinbase";
  ref?: string;
}

export interface WithdrawalRecord {
  playerId: string;
  cents: number;
  at: number;
  to: string | null;
  txHash: string | null;
  status: "demo" | "sent" | "failed";
  error?: string;
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
}
