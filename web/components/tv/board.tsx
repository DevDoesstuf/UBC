"use client";
// The TV page's pieces, after the original Huddle box (Kickoff): scorebug, join chip, the market takeover with
// the LED-ring countdown, odds rolling, the split bar and the live price line, the trade ticker, leaderboard,
// caption bar, the result flood, "Who's smarter?" and the end-of-game podium. Green and ivory tokens.
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, useQueryParam, type LobbyData } from "@/components/client";
import { Qr } from "@/components/Qr";
import {
  Avatar,
  Burst,
  Icon,
  Kinetic,
  Mark,
  MarkerShape,
  Pct,
  Roll,
  SplitBar,
  delay,
  useFlip,
  useNewIds,
  useReplayClass,
  type LockState,
} from "@/components/huddle";
import { money, payoutText, pctText, secsText, SIDE_LABEL, yesNo } from "./format";
import { perDollar } from "@/components/phone/derive";
import { awayFirst } from "@/lib/matchup";
import { standings as rank, worthOf, type Standing } from "@/lib/standings";
import { Sparkline, type Line } from "./Sparkline";

export type L = LobbyData;
export type M = NonNullable<LobbyData["market"]>;
export type Player = L["players"][number];
export type Score = NonNullable<NonNullable<L["game"]>["score"]>;
export type Card = NonNullable<L["scorecard"]>;

const MODE_LABEL = { market: "Market", pool: "Pool", h2h: "Head to head" } as const;

export const joinHost = (url: string) => url.replace(/^https?:\/\//, "");

/**
 * What a player is worth tonight (lib/standings.ts): balance, anything already cashed out (a cash-out never
 * drops a rank) and open positions at value (a buy never drops a rank either).
 */
export const worth = (p: Player) => worthOf(p);

export type Ranked = Standing<Player>;

/** Players by worth, then by who joined first; shared rank on a tie, `lead` only for a sole leader. */
export const ranked = (players: Player[]): Ranked[] => rank(players);

/** What a "Call it" moment is called on the box ("Penalty!"), or null for a scripted question. */
export function momentLabel(l: L, m: M): string | null {
  if (!m.moment) return null;
  const hit = l.moments?.find((x) => x.id === `moment:${m.moment}`);
  return hit?.label ?? m.moment.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/* ================================================================ top bar */

/** One side of the scorebug; `right` mirrors it (score square on the inside). */
function TeamScore({ short, name, score, right }: { short: string; name: string; score: number; right?: boolean }) {
  const beat = useReplayClass(score, "hd-beat");
  return (
    <span className={`tv-team ${right ? "away" : ""}`}>
      <span className="tv-team-name" title={name}>{short}</span>
      <span className={`hd-num tv-team-score ${beat}`}>
        <Roll text={String(score)} flash={false} duration={700} />
      </span>
    </span>
  );
}

/**
 * Replay games: the scorebug pill (score squares roll and beat on a score, clock with the live dot). US
 * leagues put the away team first, like the game card ("49ers at Cowboys": SF on the left), soccer the home team.
 */
export function Scorebug({ score, persona, sport, league }: { score: Score; persona?: string; sport?: string | null; league?: string | null }) {
  const live = !!score.started && score.status !== "final";
  const period = persona === "nfl" && score.period ? `Q${score.period}` : null;
  const at = awayFirst(sport, league);
  const home = <TeamScore key="home" short={score.homeShort || score.home} name={score.home} score={score.homeScore} right={at} />;
  const away = <TeamScore key="away" short={score.awayShort || score.away} name={score.away} score={score.awayScore} right={!at} />;
  return (
    <div
      className="hd-drop tv-scorebug"
      role="group"
      aria-label={at
        ? `${score.away} ${score.awayScore} at ${score.home} ${score.homeScore}, ${score.clock}`
        : `${score.home} ${score.homeScore}, ${score.away} ${score.awayScore}, ${score.clock}`}
    >
      {at ? away : home}
      <span className="tv-clock">
        <span className="hd-num tv-clock-time">{period ? `${period} · ` : ""}{score.clock}</span>
        <span className="tv-clock-state">
          {score.status === "final" ? "Full time" : live ? (<><span className="live-dot" aria-hidden="true" />Replay</>) : "Pre-game"}
        </span>
      </span>
      {at ? home : away}
    </div>
  );
}

/** "Join late" chip: a small QR and the code. */
export function JoinChip({ code, joinUrl }: { code: string; joinUrl: string }) {
  return (
    <div className="hd-drop tv-joinchip" style={delay(80)}>
      <span className="tv-joinchip-qr"><Qr text={joinUrl} size={40} /></span>
      <span className="tv-joinchip-text">
        <span>Join</span>
        <b translate="no">{code}</b>
      </span>
    </div>
  );
}

export function SoundToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={`tv-soundbtn hd-press ${on ? "on" : ""}`} aria-pressed={on} onClick={onToggle}>
      <Icon name={on ? "speaker" : "mute"} size="1.25em" />
      {on ? "Sound on" : "Turn sound on"}
    </button>
  );
}

/* ================================================================ market */

export type Clock = { lockIn: number; fraction: number; state: LockState };

/** The room's, the model's and Gemini's YES numbers in one row (shapes + labels, never colour alone). */
export function ProsLegend({ m, compact = false }: { m: M; compact?: boolean }) {
  if (m.model === null && !m.gemini) return null;
  return (
    <dl className={`tv-pros ${compact ? "compact" : ""}`} aria-label="Yes price: room, model and Gemini">
      <div>
        <dt><span className="tv-room-dot" aria-hidden="true" />Room</dt>
        <dd className="hd-num room"><Pct p={m.yesCents / 100} flash={false} /></dd>
      </div>
      <div>
        <dt><MarkerShape shape="solid" />Model</dt>
        <dd className="hd-num">{m.model === null ? "–" : `${pctText(m.model)}%`}</dd>
      </div>
      {m.gemini && (
        <div>
          <dt><MarkerShape shape="hollow" />Gemini</dt>
          <dd className="hd-num">{pctText(m.gemini.prob)}%</dd>
        </div>
      )}
    </dl>
  );
}

/** "$1 pays $X": what $1 on `side` returns right now after the price moves (the phones' number exactly). */
function payoutPerDollar(m: M, side: "yes" | "no"): string {
  const per = perDollar(m, side);
  return per ? payoutText(1 / per) : payoutText((side === "yes" ? m.yesCents : m.noCents) / 100);
}

/** Slim Yes / No pill (tinted, like the box): side, price, and what $1 pays (or the pot / open offers). */
function OutcomePill({ m, side, locked, d }: { m: M; side: "yes" | "no"; locked: boolean; d: number }) {
  const cents = side === "yes" ? m.yesCents : m.noCents;
  const kick = useReplayClass(cents, "tile-kick");
  const pool = m.pool;
  const offers = (m.offers ?? []).filter((o) => o.open && o.side === side).length;
  const line =
    m.mode === "pool" && pool
      ? `${money(side === "yes" ? pool.yesCents : pool.noCents)} in the pot`
      : m.mode === "h2h"
        ? `${offers} open ${offers === 1 ? "offer" : "offers"}`
        : payoutPerDollar(m, side);
  return (
    <div className="tv-pill-wrap tv-in" style={delay(d)}>
      <div className={`tv-opill ${side} ${kick} ${locked ? "locked" : ""}`}>
        <span className="tv-opill-side">{SIDE_LABEL[side]}</span>
        <span className="hd-num tv-opill-price"><Pct p={cents / 100} flash={false} /></span>
        <span className="tv-opill-line">{line}</span>
        {locked && <Icon name="lock" />}
      </div>
    </div>
  );
}

/** The thin countdown bar under the market (transform only), with the seconds left beside it. */
export function Countdown({ clock, locked }: { clock: Clock; locked: boolean }) {
  const urgent = clock.state === "urgent";
  return (
    <div className={`tv-count ${urgent ? "urgent" : ""} ${locked ? "locked" : ""}`} role="timer" aria-label={locked ? "Trading locked" : `${clock.lockIn} seconds to lock`}>
      <span className="tv-count-track"><span className="tv-count-fill" style={{ transform: `scaleX(${locked ? 0 : clock.fraction})` }} /></span>
      <span className="hd-num tv-count-num">{locked ? <><Icon name="lock" /> Locked</> : `${secsText(clock.lockIn)}`}</span>
      {!locked && <span className="tv-count-k">{urgent ? "Last call" : "to lock"}</span>}
    </div>
  );
}

/**
 * takeover: a market opens. The stage zooms in, the badge pops, the question is kinetic, the hero "% chance"
 * rolls in over the live chart (which draws on), the pills rise 80 ms apart and the countdown bar runs down.
 * Every price change rolls the hero, tweens the chart and pulses the stage. `compact` is the side-column
 * version next to a playing clip (`chart` replaces the big chart there).
 */
export function MarketStage({ l, m, clock, compact = false, chart }: { l: L; m: M; clock: Clock; compact?: boolean; chart?: ReactNode }) {
  const locked = l.phase !== "open";
  const flash = useReplayClass(locked, "flash");
  const pulse = useReplayClass(m.history.length, "tv-pulse");
  const moment = momentLabel(l, m);
  const urgent = clock.state === "urgent";
  const start = (m.history.length ? m.history : [m.yesCents])[0];
  const diff = m.yesCents - start;
  return (
    <section className={`hd-zoom tv-stage-card tv-market ${compact ? "compact" : ""} ${locked ? "is-locked" : ""}`} aria-label="Market">
      {moment && <span className="tv-ribbon" aria-hidden="true" />}
      {urgent && <span className="urgent-edge" aria-hidden="true" />}
      {pulse && <span key={pulse} className="tv-trade-pulse" aria-hidden="true" />}
      {flash && locked && <div key={flash} className="hd-flashout tv-lockflash" aria-hidden="true" />}
      <p className="tv-market-meta">
        {locked ? (
          <span key="locked" className="hd-pop tv-badge ink"><Icon name="lock" /> Locked, watch the play</span>
        ) : moment ? (
          <span key="moment" className="hd-pop tv-badge brand"><Icon name="bolt" strokeWidth={2.4} /> {moment} called</span>
        ) : (
          <span key="open" className="hd-pop tv-badge live"><span className="live-dot" aria-hidden="true" /> Live</span>
        )}
        <span className="tv-in" style={delay(120)}>
          Question {m.qIndex + 1}{l.game?.kind !== "replay" && l.questionCount > m.qIndex ? ` of ${l.questionCount}` : ""}
        </span>
        {!compact && <span className="tv-in" style={delay(160)}>{MODE_LABEL[m.mode]}</span>}
        <span className="tv-in tnum" style={delay(200)}>
          <Roll text={money(m.volume)} value={m.volume} flash={false} /> traded
        </span>
      </p>
      <h1 className="tvq tv-question"><Kinetic text={m.text} delay={120} stagger={40} /></h1>
      <div className="tv-hero tv-in" style={delay(300)}>
        <p className="tv-hero-num">
          <span className="hd-num tv-hero-pct"><Pct p={m.yesCents / 100} flash={false} /></span>
          <span className="tv-hero-k">chance{compact ? "" : " of Yes"}</span>
          <span className={`hd-num tv-hero-diff ${diff > 0 ? "up" : diff < 0 ? "down" : ""}`}>
            {diff !== 0 && <Icon name={diff > 0 ? "up" : "down"} />}
            {diff === 0 ? "Flat" : `${Math.abs(diff)}`}
          </span>
        </p>
        {!compact && <ProsLegend m={m} />}
      </div>
      <div className="tv-market-chart tv-in" style={delay(420)}>
        {chart ?? <PriceChart m={m} bare />}
      </div>
      <div className="tv-pills">
        <OutcomePill m={m} side="yes" locked={locked} d={520} />
        <OutcomePill m={m} side="no" locked={locked} d={600} />
      </div>
      <div className="tv-in" style={delay(680)}>
        <Countdown clock={clock} locked={locked} />
      </div>
      {compact && <ProsLegend m={m} compact />}
    </section>
  );
}

/** Gemini's YES price, kept per trade so it can be drawn against the room's line (the first value we saw fills the past). */
export function useGeminiTrail(key: string, len: number, g: number | null): number[] | null {
  const ref = useRef<{ key: string; pts: number[] }>({ key: "", pts: [] });
  if (g === null || len < 1) return null;
  if (ref.current.key !== key) ref.current = { key, pts: Array(len).fill(g) };
  let pts = ref.current.pts;
  if (pts.length < len) pts = [...pts, ...Array(len - pts.length).fill(g)];
  else if (pts.length > len) pts = pts.slice(0, len);
  if (pts[pts.length - 1] !== g) pts = [...pts.slice(0, -1), g];
  ref.current.pts = pts;
  return pts;
}

/** market.trail as two point lists in cents (Gemini gaps filled from its nearest price), or null without Gemini. */
function serverTrail(m: M): { room: number[]; gemini: number[] } | null {
  const t = m.trail ?? [];
  if (t.length < 2 || !t.some((x) => x.gemini !== null)) return null;
  const room = t.map((x) => Math.round(x.room * 100));
  const first = t.find((x) => x.gemini !== null)!.gemini!;
  let last = first;
  const gemini = t.map((x) => (last = x.gemini === null ? last : x.gemini)).map((g) => Math.round(g * 100));
  if (room[room.length - 1] !== m.yesCents) {
    room.push(m.yesCents);
    gemini.push(gemini[gemini.length - 1]);
  }
  return { room, gemini };
}

/**
 * price-draw: the room's YES price since the market opened (smooth line, soft fill), the model as a dashed
 * level and Gemini as a subtle line when it prices the same question. `bare` is the big chart inside the
 * market stage (the hero above it says the numbers), otherwise a head and a foot say them.
 */
export function PriceChart({ m, compact = false, bare = false, className = "" }: { m: M; compact?: boolean; bare?: boolean; className?: string }) {
  const hist = m.history.length ? m.history : [m.yesCents];
  const gem = m.gemini ? Math.round(m.gemini.prob * 100) : null;
  const local = useGeminiTrail(`${m.qIndex}:${m.openedAt}`, hist.length, gem);
  // The server's room-vs-Gemini trail (market.trail) carries Gemini's real moves (replayed games); use it when
  // Gemini prices this question, else the room's trade history with Gemini held level beside it.
  const server = serverTrail(m);
  const trail = server ? server.gemini : local;
  const roomPts = server ? server.room : hist;
  const start = hist[0];
  const diff = m.yesCents - start;
  const lines: Line[] = [{ id: "room", points: roomPts, tone: "room" }];
  if (trail) lines.push({ id: "gemini", points: trail, tone: "gemini" });
  if (typeof m.model === "number") lines.push({ id: "model", points: [Math.round(m.model * 100)], tone: "model" });
  const moves = hist.length - 1;
  const u = "%";
  const key = (
    <span className="tv-chart-key">
      <span><i className="room" aria-hidden="true" />Room</span>
      {typeof m.model === "number" && <span><i className="model" aria-hidden="true" />Model</span>}
      {trail && <span><i className="gem" aria-hidden="true" />Gemini{m.gemini && !m.gemini.live ? " (last seen)" : ""}</span>}
    </span>
  );
  if (bare) {
    return (
      <div className={`tv-chart bare ${className}`}>
        <Sparkline key={`${m.qIndex}:${m.openedAt}`} lines={lines} className="tv-chart-plot" />
        <p className="tv-chart-foot">
          {key}
          <span>Opened {start}{u} · {moves > 0 ? `${moves} ${moves === 1 ? "trade" : "trades"}` : "No trades yet"}</span>
        </p>
      </div>
    );
  }
  return (
    <div className={`tv-chart ${compact ? "compact" : ""} ${className}`}>
      <p className="tv-chart-head">
        <span>{trail ? "Room vs Gemini" : m.mode === "pool" ? "Yes share of the pot" : m.mode === "h2h" ? "Yes odds from matched offers" : "Yes price"}</span>
        <span className={`hd-num tv-chart-diff ${diff > 0 ? "up" : diff < 0 ? "down" : ""}`}>
          {diff !== 0 && <Icon name={diff > 0 ? "up" : "down"} />}
          {diff === 0 ? "Flat" : `${diff > 0 ? "+" : "\u2212"}${Math.abs(diff)} pts`}
        </span>
      </p>
      <Sparkline key={`${m.qIndex}:${m.openedAt}`} lines={lines} className="tv-chart-plot" axis={!compact} />
      {!compact && (
        <p className="tv-chart-foot">
          {key}
          <span>{moves > 0 ? `${moves} ${moves === 1 ? "trade" : "trades"}` : "No trades yet"}</span>
        </p>
      )}
    </div>
  );
}

/** Head-to-head: the open offers on the table (`compact`: just the list, for the side column next to a clip). */
export function OffersCard({ m, compact = false, locked = false }: { m: M; compact?: boolean; locked?: boolean }) {
  const offers = (m.offers ?? []).filter((o) => o.open && o.remaining > 0).slice(0, compact ? 2 : 4);
  const list = offers.length ? (
    <ul>
      {offers.map((o) => (
        <li key={o.id} className="hd-slide-r">
          <Avatar name={o.name} size={compact ? "1.5rem" : "1.75rem"} />
          <span className="grow"><b>{o.name}</b> backs <span className={`tv-side-word ${o.side}`}>{SIDE_LABEL[o.side]}</span></span>
          <span className="hd-num">{money(o.remaining)} at {o.odds.toFixed(2)}</span>
        </li>
      ))}
    </ul>
  ) : (
    <p className="tv-empty">
      {locked
        ? "Trading is closed. Unmatched stakes went back."
        : (m.offers ?? []).some((o) => o.filled > 0)
          ? "Every offer is matched. Post another on your phone."
          : "No offers yet. Make one on your phone."}
    </p>
  );
  if (compact) return <div className="tv-offers compact" aria-label="Offers on the table">{list}</div>;
  return (
    <section className="hd-rise tv-card tv-offers" aria-labelledby="tv-offers-h">
      <h2 id="tv-offers-h" className="tv-card-title"><Icon name="handshake" /> Offers on the table</h2>
      {list}
    </section>
  );
}

/* ================================================================ result */

/**
 * result-flood: the winner's colour floods the stage from its own share of the split, the split drains, the
 * winner word stamps in, confetti sized to the moment, and the callers' card rises with a glint on each name,
 * next to who got cooked (backed the other side and got nothing back), like the box's result screen.
 */
export function ResultReveal({ m, compact = false }: { m: M; compact?: boolean }) {
  const voided = !!m.voided;
  const outcome = m.outcome ?? "yes";
  const atLock = m.priceAtLock ?? m.yesCents / 100;
  const winShare = outcome === "yes" ? atLock : 1 - atLock;
  const pot = m.winners.reduce((a, w) => a + w.cents, 0);
  const losers = m.losers ?? [];
  const shown = compact ? 2 : 3;
  const bits = voided ? 0 : Math.min(48, 14 + m.winners.length * 6 + Math.round(pot / 500));
  const forecasts = [
    { id: "room", label: "Room at lock", p: atLock },
    { id: "model", label: "Model", p: m.model },
    { id: "gemini", label: "Gemini", p: m.gemini?.prob ?? null },
  ].filter((f): f is { id: string; label: string; p: number } => typeof f.p === "number");
  // "Closest" only when one forecast was strictly nearer to what happened than every other.
  const miss = forecasts.map((f) => ({ id: f.id, d: Math.abs((outcome === "yes" ? 1 : 0) - f.p) }));
  const best = miss.length > 1 ? Math.min(...miss.map((x) => x.d)) : null;
  const closest = best !== null && miss.filter((x) => Math.abs(x.d - best) < 0.005).length === 1 ? miss.find((x) => x.d === best)?.id ?? null : null;
  return (
    <section className={`hd-zoom tv-stage-card tv-reveal ${outcome} ${voided ? "void" : ""} ${compact ? "compact" : ""}`} role="status" aria-label={voided ? "Market voided" : `Result: ${SIDE_LABEL[outcome]}`}>
      {voided ? (
        <div className="hd-fade tv-reveal-fill void" aria-hidden="true" />
      ) : (
        <div
          className={`tv-reveal-fill tv-reveal-wash ${outcome}`}
          style={{ ["--from" as string]: String(winShare) } as CSSProperties}
          aria-hidden="true"
        />
      )}
      {bits > 0 && (
        <Burst
          seed={m.qIndex + m.openedAt % 97 + 3}
          count={compact ? Math.min(28, bits) : bits}
          x={compact ? "50%" : "30%"}
          y="42%"
          spread={compact ? 10 : 18}
          delay={520}
          colours={outcome === "yes" ? ["#1FD67F", "#17B067", "#D9B36C", "#E9DFC9"] : ["#FF5148", "#D93A33", "#D9B36C", "#E9DFC9"]}
        />
      )}
      <div className="tv-reveal-body">
        <p className="hd-fade tv-reveal-kicker">{voided ? "Voided" : `Result · question ${m.qIndex + 1}`}</p>
        <p className="tvq hd-fade tv-reveal-q">{m.text}</p>
        <div className="tv-reveal-track" aria-hidden="true">
          <SplitBar parts={yesNo(atLock)} className="hd-drain tv-reveal-split" />
        </div>
        <div className="tv-reveal-word-row">
          <div className="hd-stamp tv-reveal-word" style={delay(380)}>
            {voided ? (
              <span className="tv-small">Stakes refunded</span>
            ) : (
              <>
                <Icon name="check" strokeWidth={3.2} />
                <span>{SIDE_LABEL[outcome]}</span>
              </>
            )}
          </div>
        </div>
        {!voided && (
          <div className={`hd-rise tv-reveal-cards ${!compact && forecasts.length > 0 ? "three" : ""}`} style={delay(760)}>
            <div className="tv-reveal-card">
              <p className="tv-reveal-card-h up"><Icon name="up" /> Called it</p>
              {m.winners.slice(0, shown).map((w, i) => (
                <p key={`${w.name}-${i}`} className="hd-shine tv-winner" style={delay(1000 + i * 180)}>
                  <Avatar name={w.name} size="1.9rem" />
                  <span className="grow">{w.name}</span>
                  <span className="hd-num">{money(w.cents)} <span className="tv-paid">paid</span></span>
                </p>
              ))}
              {m.winners.length > shown && <p className="tv-more">+{m.winners.length - shown} more</p>}
              {m.winners.length === 0 && <p className="tv-empty">Nobody called it. Brutal.</p>}
            </div>
            <div className="tv-reveal-card">
              <p className="tv-reveal-card-h down"><Icon name="down" /> Cooked</p>
              {losers.slice(0, shown).map((w, i) => (
                <p key={`${w.name}-${i}`} className="hd-fade tv-winner tv-loser" style={delay(1100 + i * 180)}>
                  <Avatar name={w.name} size="1.9rem" />
                  <span className="grow">{w.name}</span>
                  <span className="hd-num">{money(w.cents)} <span className="tv-paid">lost</span></span>
                </p>
              ))}
              {losers.length > shown && <p className="tv-more">+{losers.length - shown} more</p>}
              {losers.length === 0 && <p className="tv-empty">Clean sweep.</p>}
            </div>
            {!compact && forecasts.length > 0 && (
              <div className="tv-reveal-card soft">
                <p className="tv-reveal-card-h">Yes was priced at</p>
                {forecasts.map((f) => (
                  <p key={f.id} className="tv-forecast">
                    <span className="grow">{f.label}</span>
                    {closest === f.id && <span className="tv-closest">Closest</span>}
                    <span className="hd-num">{pctText(f.p)}%</span>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
        {voided && <p className="tv-reveal-note">Every stake went back to its owner.</p>}
      </div>
    </section>
  );
}

/* ================================================================ between questions */

export function ParkedCard({ parked }: { parked: NonNullable<L["parked"]> }) {
  return (
    <section className="hd-rise tv-card tv-parked" aria-label="Pregame call" style={delay(300)}>
      <p className="tv-card-title"><Icon name="hourglass" /> Pregame call, settles at the final whistle</p>
      <p className="tvq tv-parked-q">{parked.text}</p>
      <p className="tv-parked-nums">
        <span>Room <b className="hd-num">{parked.yesCents}%</b></span>
        {typeof parked.model === "number" && <span><MarkerShape shape="solid" /> Model <b className="hd-num">{pctText(parked.model)}%</b></span>}
        {parked.gemini && <span><MarkerShape shape="hollow" /> Gemini <b className="hd-num">{pctText(parked.gemini.prob)}%</b></span>}
      </p>
    </section>
  );
}

/** Nothing open right now: what happens next, and a big code for late joiners. */
export function IdleStage({ l, compact = false }: { l: L; compact?: boolean }) {
  const replay = l.game?.kind === "replay";
  const head = l.phase === "result" ? "Next question coming up." : replay ? "The next question drops on the next big moment." : "The host opens the next question from the box.";
  return (
    <section className={`hd-zoom tv-stage-card tv-idle ${compact ? "compact" : ""}`} aria-label="Waiting for the next question">
      <div className="tv-idle-main">
        <Mark size={compact ? "2.5rem" : "3.5rem"} lit={12} className="hd-breathe tv-idle-mark" />
        <h1 className="tvq tv-idle-h"><Kinetic text={head} delay={100} /></h1>
        {l.nextQuestion && (
          <p className="hd-rise tv-idle-next" style={delay(420)}><b>Up next:</b> {l.nextQuestion}</p>
        )}
        {!l.nextQuestion && !compact && (
          <p className="hd-rise tv-idle-sub" style={delay(520)}>
            {replay ? "Third downs, red zones, penalties, corners: the moment it happens, a market opens here and on every phone." : "Prices move with every trade. Trading locks just before the play."}
          </p>
        )}
        {l.parked && <ParkedCard parked={l.parked} />}
      </div>
      {!compact && (
        <div className="hd-pop tv-idle-join" style={delay(300)}>
          <span className="hd-float tv-qr-card"><Qr text={l.joinUrl} size={200} /></span>
          <span className="tv-idle-join-k">Late? Scan to join</span>
          <b className="tv-idle-code" translate="no">{l.code}</b>
          <span className="tv-idle-url">{joinHost(l.joinUrl)}</span>
        </div>
      )}
    </section>
  );
}

/* ================================================================ lobby */

/** "Demo money | Solana": the host picks this game's money before anyone pays in (POST /money; ?key= when KIOSK_KEY is set). */
function MoneyPill({ l }: { l: L }) {
  const key = useQueryParam("key");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [want, setWant] = useState<string | null>(null);
  if (!l.money.offered?.includes("solana")) return null;
  const mode = want ?? l.money.mode;
  const locked = !!l.money.locked;
  async function pick(m: "demo" | "solana") {
    if (busy || locked || m === mode) return;
    setBusy(true);
    setErr(null);
    setWant(m);
    try {
      await api(`/api/lobby/${l.code}/money`, { body: { mode: m }, headers: key ? { "x-kiosk-key": key } : {} });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setWant(null);
      setBusy(false);
    }
  }
  return (
    <div className="hd-rise tv-money" style={delay(390)}>
      <div className={`tv-money-pill ${locked ? "locked" : ""}`} role="radiogroup" aria-label="Money for this game">
        {(["demo", "solana"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} disabled={busy || (locked && mode !== m)} onClick={() => pick(m)}>
            {m === "demo" ? "Demo money" : "Solana"}
          </button>
        ))}
      </div>
      {err && <span className="tv-money-err" role="alert">{err}</span>}
    </div>
  );
}

export function LobbyStage({ l }: { l: L }) {
  const players = l.players;
  const fresh = useNewIds(players.map((p) => p.id));
  const pot = players.reduce((a, p) => a + p.deposited, 0);
  const replay = l.game?.kind === "replay";
  const meta = [`${MODE_LABEL[l.mode ?? "market"]} mode`, replay ? "Full game replay, questions written live" : "Clip with questions", l.money.mode === "solana" && !l.money.offered?.includes("solana") ? "USDC on Solana" : null].filter(Boolean);
  return (
    <div className="tv-lobby">
      <section className="hd-slide-l tv-joinpanel" aria-label="Join this game">
        <span className="hd-pop hd-float tv-qr-card big" style={delay(160)}><Qr text={l.joinUrl} size={232} /></span>
        <p className="tv-joinpanel-h"><Icon name="nfc" /> Tap your phone on the box to join</p>
        <p className="tv-joinpanel-sub">or scan the code, or open {joinHost(l.joinUrl)}</p>
        <span className="tv-joinpanel-k">Game code</span>
        <span className="tv-codetiles" translate="no" aria-label={`Game code ${l.code.split("").join(" ")}`}>
          {l.code.split("").map((ch, i) => (
            <span key={i} className="hd-pop" style={delay(320 + i * 90)} aria-hidden="true">{ch}</span>
          ))}
        </span>
      </section>
      <section className="tv-room" aria-label="The room">
        <h1 className="tvq tv-room-title"><Kinetic text={l.game?.title ?? "Huddle"} delay={120} /></h1>
        <p className="hd-rise tv-room-meta" style={delay(360)}>{meta.join(" · ")}</p>
        <MoneyPill l={l} />
        <div className="tv-room-stats">
          <p className="hd-rise tv-card tv-stat" style={delay(420)}>
            <span className="tv-stat-k"><span className="tv-golddot" aria-hidden="true" /> In the pot</span>
            <span className="hd-num tv-stat-v"><Roll text={money(pot)} value={pot} arrow duration={900} /></span>
            {fresh.size > 0 && <Burst key={fresh.size} seed={fresh.size} count={14} spread={7} x="72%" y="55%" colours={["#D9B36C", "#E9DFC9", "#1FD67F", "#17B067"]} />}
          </p>
          <p className="hd-rise tv-card tv-stat" style={delay(500)}>
            <span className="tv-stat-k">{players.length === 1 ? "Player" : "Players"}</span>
            <span className="hd-num tv-stat-v green"><Roll text={String(players.length)} value={players.length} duration={700} /></span>
          </p>
        </div>
        <ul className={`tv-people ${players.length > 6 ? "three" : ""}`} aria-label="Players in the room" aria-live="polite">
          {players.map((p, i) => {
            const isFresh = fresh.has(p.id);
            return (
              <li key={p.id} className={`tv-person ${isFresh ? "hd-pop fresh" : "hd-rise"}`} style={delay(isFresh ? 0 : 560 + i * 60)}>
                <Avatar name={p.name} size="2.25rem" />
                <span className="grow">{p.name}</span>
                <span className="hd-num">{money(p.deposited)}</span>
                {isFresh && p.deposited > 0 && <span className="hd-coin" style={{ ["--dx" as string]: "-5rem", ["--dy" as string]: "-8rem", ["--d" as string]: "260ms" } as CSSProperties} aria-hidden="true" />}
              </li>
            );
          })}
          {players.length === 0 && (
            <li className="hd-rise tv-person is-empty" style={delay(560)}>
              <span className="hd-breathe tv-greendot" aria-hidden="true" />
              Waiting for the first player. Phones join by tapping the box or scanning the code.
            </li>
          )}
        </ul>
        <p className="hd-rise tv-firstup" style={delay(640)}>
          {l.nextQuestion ? (<><b>First up:</b> {l.nextQuestion}</>) : replay ? (<><b>Kick-off:</b> the first question opens when the host starts the game on the box.</>) : "The host starts the first question from the box."}
        </p>
      </section>
    </div>
  );
}

/* ================================================================ people */

/** Leaderboard card (side column): the sole leader's row is ink with a gold rank badge (none on a tie); rows slide on reorder. */
export function Leaderboard({ players, max = 5 }: { players: Player[]; max?: number }) {
  const rows = ranked(players).slice(0, max);
  const list = useFlip<HTMLOListElement>(rows.map((p) => p.id).join(","));
  const top = Math.max(0, ...rows.map((p) => worth(p)));
  return (
    <section className="hd-rise tv-card tv-board" aria-labelledby="tv-board-h" style={delay(200)}>
      <h2 id="tv-board-h" className="tv-card-title"><Icon name="trophy" /> Leaderboard</h2>
      <ol ref={list}>
        {rows.map((p, i) => (
          <li key={p.id} data-flip={p.id} className={`tv-in ${p.lead ? "lead" : ""}`} style={{ ...delay(260 + i * 70), ["--w" as string]: String(top > 0 ? Math.max(0.04, worth(p) / top) : 0) } as CSSProperties}>
            <span className="tv-row-bar" aria-hidden="true" />
            <span className={`tv-rank hd-num ${p.lead ? "gold" : ""}`}>{p.rank}</span>
            <Avatar name={p.name} size="1.9rem" />
            <span className="grow">{p.name}</span>
            <span className="hd-num tv-bal"><Roll text={money(worth(p))} value={worth(p)} /></span>
          </li>
        ))}
        {rows.length === 0 && <li className="tv-empty">Nobody yet. Scan to join.</li>}
      </ol>
    </section>
  );
}

/** Leader chips along the bottom rail (when the clip takes the stage). */
export function LeaderRail({ players, max = 4 }: { players: Player[]; max?: number }) {
  const rows = ranked(players).slice(0, max);
  const list = useFlip<HTMLOListElement>(rows.map((p) => p.id).join(","));
  return (
    <ol ref={list} className="tv-leaders" aria-label="Leaderboard">
      {rows.map((p) => (
        <li key={p.id} data-flip={p.id} className={`tv-chip ${p.lead ? "lead" : ""}`}>
          <span className="tv-chip-av">
            <Avatar name={p.name} size="1.85rem" />
            <span className={`hd-num tv-chip-rank ${p.lead ? "gold" : ""}`}>{p.rank}</span>
          </span>
          <span className="tv-chip-name">{p.name}</span>
          <span className="hd-num"><Roll text={money(worth(p))} value={worth(p)} /></span>
        </li>
      ))}
    </ol>
  );
}

/** Trade pills: "Leo buys ▲ Yes $2.00". A big trade ($5+) lands gold with a ring and a pop. */
export function TradeTicker({ trades, mode = "market" }: { trades: M["trades"]; mode?: M["mode"] }) {
  return (
    <ul className="tv-ticker" aria-label="Recent trades">
      {trades.slice(0, 4).map((t) => {
        const big = t.cents >= 500;
        return (
          <li key={`${t.at}-${t.name}-${t.side}`} className={`tv-pill ${big ? "big-trade" : "hd-slide-r"}`}>
            <Avatar name={t.name} size="1.6rem" />
            <b>{t.name}</b>
            <span className="tv-pill-verb">{mode === "pool" ? "stakes" : mode === "h2h" ? "backs" : "buys"}</span>
            <span className={`tv-side-word ${t.side}`}><Icon name={t.side === "yes" ? "up" : "down"} />{SIDE_LABEL[t.side]}</span>
            <span className="hd-num">{money(t.cents)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/* ================================================================ captions */

export function CaptionBar({ text, id, speaking, source }: { text: string | null; id: string; speaking: boolean; source: "announcer" | "event" | null }) {
  return (
    <div className="tv-capbar" aria-live="polite" aria-label="Announcer">
      <div className="tv-capbar-pill">
        <span className={`tv-capbar-icon ${speaking ? "live" : ""}`} aria-hidden="true">
          {speaking && <span className="hd-ping tv-capbar-ping" />}
          <Icon name="speaker" />
        </span>
        {text ? (
          <p className="tv-capbar-text"><Kinetic text={text} replay={id} stagger={28} /></p>
        ) : (
          <p className="tv-capbar-text muted">The announcer calls every market here.</p>
        )}
        {source === "announcer" && <span className="tv-capbar-src">Announcer</span>}
      </div>
    </div>
  );
}

/* ================================================================ scorecard + end */

/** Brier bars: Room (brand), Model (ink), Gemini (hatched, ink ring). Shorter bar wins; the best gets a crown. */
export function ScorecardPanel({ card, compact = false }: { card: Card; compact?: boolean }) {
  // A coin flip (0.25) sits at about 70% of the track; worse scores widen the scale so bars never clamp to a fake tie.
  const worst = Math.max(0, ...[card.room, card.model, card.gemini].filter((v): v is number => typeof v === "number"));
  const SCALE = Math.max(0.36, worst * 1.05);
  const bars = [
    { id: "room", label: "Room", v: card.room },
    { id: "model", label: "Model", v: card.model },
    { id: "gemini", label: "Gemini", v: card.gemini },
  ] as const;
  const vals = bars.map((b) => b.v).filter((v): v is number => typeof v === "number");
  const best = vals.length > 1 ? Math.min(...vals) : null;
  return (
    <div className={`tv-scorecard ${compact ? "compact" : ""}`}>
      <div className="tv-scorecard-head">
        <h2 className="tvq"><Kinetic text="Who’s smarter?" /></h2>
        <p className="hd-fade" style={delay(250)}>Room vs model vs Gemini over {card.n} {card.n === 1 ? "question" : "questions"}. Brier score: shorter bar wins.</p>
      </div>
      <div className="tv-bars">
        {bars.map((b, i) => (
          <div key={b.id} className="tv-bar-row">
            <span className={`tv-who ${b.id}`}>
              {b.id === "room" && <span className="tv-room-dot" aria-hidden="true" />}
              {b.id === "model" && <MarkerShape shape="solid" />}
              {b.id === "gemini" && <MarkerShape shape="hollow" />}
              {b.label}
              {best !== null && b.v === best && (
                <span className="hd-pop tv-crown" style={delay(900)}><Icon name="crown" title="Best forecast" /></span>
              )}
            </span>
            <span className="tv-bar-track">
              {b.v !== null && (
                <span
                  className={`hd-flood tv-bar-fill ${b.id}`}
                  style={{ width: `${Math.max(3, Math.min(100, (b.v / SCALE) * 100))}%`, ["--d" as string]: `${200 + i * 160}ms` } as CSSProperties}
                />
              )}
              <span className="tv-bar-flip" style={{ left: `${(0.25 / SCALE) * 100}%` }} aria-hidden="true" />
            </span>
            <span className="hd-num tv-bar-v">{b.v === null ? "–" : <Roll text={b.v.toFixed(2)} value={b.v} flash={false} />}</span>
          </div>
        ))}
      </div>
      <p className="hd-rise tvq tv-verdict" style={delay(700)}>
        {card.n === 0 ? "No results yet. The first settled question starts the scorecard." : card.verdict}
      </p>
    </div>
  );
}

const PODIUM_ORDER = [1, 0, 2];

function Podium({ rows }: { rows: Ranked[] }) {
  // A tie at the top has no winner: no crown, no shine, the shared rank on both blocks.
  const lead = !!rows[0]?.lead;
  return (
    <div className="tv-podium" aria-label="Podium">
      {rows[0] && <Burst seed={7} count={lead ? 36 : 18} x="50%" y="30%" spread={16} delay={1100} />}
      {PODIUM_ORDER.map((idx) => {
        const p = rows[idx];
        if (!p) return <div key={idx} className="tv-podium-col" aria-hidden="true" />;
        const at = (2 - idx) * 260;
        return (
          <div key={p.id} className={`tv-podium-col p${idx + 1}`}>
            <div className="hd-pop tv-podium-who" style={delay(at + 200)}>
              {idx === 0 && lead && <span className="hd-float tv-crown big"><Icon name="crown" title="Winner" /></span>}
              <Avatar name={p.name} size={idx === 0 ? "3rem" : "2.4rem"} />
              <span className={`tv-podium-name ${idx === 0 && lead ? "hd-shine" : ""}`} style={delay(at + 900)}>{p.name}</span>
              <span className="hd-num tv-podium-bal"><Roll text={money(worth(p))} value={worth(p)} flash={false} duration={1100} /></span>
            </div>
            <div className="tv-podium-block-clip">
              <div className="hd-rise tv-podium-block" style={delay(at)}><span className="hd-num">{p.rank}</span></div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** End of game: the podium, the rest of the table, "Who's smarter?" and every question's answer. */
export function EndStage({ l, standings }: { l: L; standings: Ranked[] }) {
  const card = l.scorecard;
  return (
    <div className="tv-end">
      <section className="tv-end-left" aria-label="Final standings">
        <h1 className="tvq tv-end-h"><Kinetic text="That’s the game. Here’s how the room did." delay={100} /></h1>
        <p className="hd-rise tv-end-sub" style={delay(300)}>Cash out on your phone. Final balances below.</p>
        <div className="tv-end-podium"><Podium rows={standings} /></div>
        {standings.length > 3 && (
          <ol className="tv-end-rest" start={4}>
            {standings.slice(3, 7).map((p, i) => (
              <li key={p.id} className="hd-rise" style={delay(1000 + i * 90)}>
                <span className="hd-num tv-rank">{p.rank}</span>
                <Avatar name={p.name} size="1.75rem" />
                <span className="grow">{p.name}</span>
                <span className="hd-num">{money(worth(p))}</span>
              </li>
            ))}
            {standings.length > 7 && (
              <li className="hd-rise tv-end-more" style={delay(1000 + 4 * 90)}>
                <span className="grow">+{standings.length - 7} more on the phones&rsquo; board</span>
              </li>
            )}
          </ol>
        )}
        {standings.length === 0 && <p className="tv-empty">Nobody played this time.</p>}
      </section>
      <section className="hd-slide-r tv-stage-card tv-end-right" style={delay(150)} aria-label="Scorecard and results">
        {card && <ScorecardPanel card={card} />}
        <h2 className="tv-card-title"><Icon name="check" /> Every question</h2>
        <ul className="tv-results">
          {l.results.slice(-5).map((r, i) => (
            <li key={i} className="hd-rise" style={delay(800 + i * 70)}>
              <span className="grow">{r.text}</span>
              <span className={`tv-result-tag ${r.outcome}`}><Icon name="check" strokeWidth={3} />{SIDE_LABEL[r.outcome]}</span>
            </li>
          ))}
          {l.results.length === 0 && <li className="tv-empty">No questions were settled.</li>}
        </ul>
      </section>
    </div>
  );
}
