// On-chain activity of a lobby, as plain data (no Solana imports, so lobby.ts and the kiosk can use it).
//
// Every Solana transaction Huddle sends or credits for a lobby is recorded once as a ChainEvent (signature +
// explorer link). `chainView` is the additive `chain` block of the public lobby view: phones and the TV show
// "Settled on Solana" with a link from it.
import type { ChainEvent, Lobby } from "./types";

const MAX_EVENTS = 40;

/** Records an on-chain action once per (signature, kind). A second report only adds what is new (streamed). */
export function pushChainEvent(l: Lobby, ev: ChainEvent): ChainEvent {
  const list = (l.chain ??= []);
  const hit = list.find((e) => e.sig === ev.sig && e.kind === ev.kind);
  if (hit) {
    if ((ev.via === "quicknode" || ev.streamed) && !hit.streamed) {
      hit.streamed = true;
      hit.streamedAt = Date.now();
    }
    return hit;
  }
  const rec: ChainEvent = { ...ev, ...(ev.via === "quicknode" || ev.streamed ? { streamed: true, streamedAt: Date.now() } : {}) };
  list.push(rec);
  if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
  return rec;
}

/** Marks every recorded event of this signature as also seen on a QuickNode Stream. True when one was found. */
export function markStreamed(l: Lobby, sig: string): boolean {
  let hit = false;
  for (const e of l.chain ?? []) {
    if (e.sig !== sig) continue;
    if (!e.streamed) e.streamedAt = Date.now();
    hit = e.streamed = true;
  }
  return hit;
}

const LABEL: Record<ChainEvent["kind"], string> = {
  deposit: "Deposit",
  faucet: "Test USDC",
  cashout: "Cash-out",
  create: "Vault opened",
  sweep: "Into the vault",
  topup: "House top-up",
  close: "Close requested",
  state: "Final balance verified",
  finalize: "Settled on Solana",
  withdraw: "Paid out",
  host: "House share",
};

/** The `chain` block of publicView. `meId` adds the viewer's own payout. */
export function chainView(l: Lobby, meId?: string | null) {
  const v = l.vault;
  const events = l.chain ?? [];
  if (!v && !events.length) return null;
  const name = (id?: string) => (id ? l.players[id]?.name ?? null : null);
  const settledTx = v?.finalized ?? null;
  const mine = meId && v ? v.payouts[meId] ?? null : null;
  const program = v?.program ?? null;
  return {
    /** "vault": money sits in this party's huddle_vault PDA and settles through the program; "treasury": plain transfers. */
    settlement: v ? ("vault" as const) : ("treasury" as const),
    program,
    party: v?.party ?? null,
    vault: v?.vault ?? null,
    /** open -> closing -> finalized (balances verified on chain) -> settled (every payout sent). */
    status: v?.status ?? null,
    settled: !!settledTx,
    settledAt: settledTx?.at ?? null,
    /** The finalize transaction: link it as "Settled on Solana". */
    settleTx: settledTx ? { sig: settledTx.sig, explorer: settledTx.explorer } : null,
    partyExplorer: v?.explorer ?? null,
    payout: mine ? { cents: mine.cents, to: mine.to, sig: mine.sig, explorer: mine.explorer } : null,
    events: events.slice(-20).map((e) => ({ kind: e.kind, label: LABEL[e.kind], sig: e.sig, explorer: e.explorer, at: e.at, cents: e.cents ?? null, name: name(e.playerId), via: e.via ?? null, streamed: !!e.streamed, streamedAt: e.streamedAt ?? null })),
  };
}
