"use client";
// The phone's market card (DESIGN.md section 9): question, lock ring, the split, the price line,
// solid YES/NO game tiles that kick on price moves, the stake tray ("you pay / you get"), your
// position, and the result (flood, "Called it" / "Cooked"). Head-to-head shows the offer book.
import { useRef, useState, type ReactNode } from "react";
import {
  Burst, Icon, Kinetic, LockRing, MarkerShape, Pct, Roll, Sparkline, SplitBar, SplitMarkers, pctLabel, pctText,
  payoutText, useCoins, useReplayClass, usd, usdShort, signedUsd, type SeriesPoint,
} from "@/components/huddle";
import {
  SIDE, lockClock, modeOf, momentLabel, myResult, offerPreview, offerTerms, other, perDollar, stakeReturn,
  type Lobby, type MarketMode, type Mkt, type Side,
} from "./derive";
import { InlineError, Money, cx, d } from "./ui";

export interface Actions {
  busy: boolean;
  balance: number;
  buy(side: Side, cents: number): Promise<boolean>;
  offer(side: Side, cents: number, odds: number): Promise<boolean>;
  take(offerId: string, cents: number): Promise<boolean>;
  addMoney(): void;
}

const MODE_LABEL: Record<MarketMode, string> = { market: "Market", pool: "Pool", h2h: "Head-to-head" };
const ODDS = [1.5, 2, 3];

/** Fire coins from the element that was tapped to the split bar (the pot). */
type Flow = (from: Element | null) => void;

export function MarketCard({ l, m, serverNow, actions }: { l: Lobby; m: Mkt; serverNow: number; actions: Actions }) {
  const mode = modeOf(m);
  const phase = l.phase;
  const cd = phase === "open" ? lockClock(m, serverNow) : null;
  const lockingNow = phase === "open" && !!cd && cd.remainingMs === 0;
  const live = phase === "open" && !lockingNow;
  const locked = phase === "locked" || lockingNow;
  const settled = phase === "result" && !!m.outcome;
  const moment = !!m.moment;
  const ring = live && !!cd && cd.secs < 100;
  const urgent = ring && !!cd?.urgent;
  // takeover: only for a question that opened in the last few seconds (not on every reload).
  const [fresh] = useState(() => phase === "open" && serverNow - m.openedAt < 6000);
  const lockFlash = useReplayClass(locked, "x");
  const split = useRef<HTMLDivElement>(null);
  const [coins, fireCoins] = useCoins();
  const flow: Flow = (from) => fireCoins(from, split.current, 3);
  const step = (i: number) => (fresh ? d(160 + i * 80) : undefined);
  const badge = momentLabel(l, m.moment);

  return (
    <article
      className={cx("ph-mcard hd-card", moment && "is-moment", fresh && "hd-zoom", locked && "is-locked")}
      aria-labelledby="q-text"
      data-testid="market-card"
      data-phase={phase}
    >
      {moment && <div className="ph-ribbon" aria-hidden="true" />}
      {fresh && <div className="hd-wipe" aria-hidden="true" />}
      {urgent && <div className="ph-urgent-edge" aria-hidden="true" />}
      {lockFlash && locked && <div key={lockFlash} className="hd-flashout ph-lock-flash" aria-hidden="true" />}

      <header className="ph-mcard-head">
        <div className="ph-mcard-titles">
          <div className="ph-mcard-meta">
            <p className="ph-mcard-kind">
              {moment ? (
                <span className="ph-moment-badge hd-pop" style={step(0)}>
                  <Icon name="bolt" size={13} /> {badge ?? "Moment"}
                </span>
              ) : (
                <span className="ph-qno">
                  <span className="ph-dot-green" aria-hidden="true" />
                  {l.questionCount > 0 ? `Question ${m.qIndex + 1}${l.game?.kind === "replay" ? "" : ` of ${l.questionCount}`}` : "Question"}
                </span>
              )}
              <span className="ph-mode">
                {MODE_LABEL[mode]}
                {mode === "pool" && m.pool && m.pool.yesCents + m.pool.noCents > 0 && (
                  <>
                    {" · Pot "}
                    <Money cents={m.pool.yesCents + m.pool.noCents} flash={false} duration={700} className="ph-mode-pot" />
                  </>
                )}
              </span>
            </p>
            {!ring && <Status phase={phase} lockingNow={lockingNow} outcome={m.outcome} voided={!!m.voided} />}
          </div>
          <Kinetic as="h1" id="q-text" text={m.text} className="hd-q ph-question" delay={fresh ? 200 : 0} stagger={fresh ? 45 : 28} />
        </div>
        {ring && cd && (
          <LockRing compact fraction={cd.fraction} label={cd.label} state={cd.urgent ? "urgent" : "open"} size="3.5rem" className="ph-ring" />
        )}
      </header>

      <div ref={split} className={cx("ph-split-wrap", fresh && "hd-rise")} style={step(3)}>
        <SplitBlock l={l} m={m} settled={settled} />
      </div>

      <div className={cx("ph-trade", fresh && "hd-rise")} style={step(4)}>
        {mode === "h2h" ? (
          <OfferBook l={l} m={m} live={live} actions={actions} flow={flow} />
        ) : settled ? null : (
          <Tiles m={m} live={live} locked={locked} actions={actions} flow={flow} />
        )}
      </div>

      <Position l={l} m={m} />
      <ResultRow l={l} m={m} />
      {coins}
    </article>
  );
}

/** Lock status at the top right, in words: "Open", "Locking…", "Locked", "Settled". */
function Status({ phase, lockingNow, outcome, voided }: { phase: string; lockingNow: boolean; outcome: Side | null; voided: boolean }) {
  if (phase === "open" && !lockingNow)
    return (
      <span className="ph-status open">
        <span className="hd-live-dot" aria-hidden="true" /> Open
      </span>
    );
  if (lockingNow || phase === "locked")
    return (
      <span key="locked" className="ph-status ink hd-snap">
        <Icon name="lock" size={14} /> {lockingNow ? "Locking…" : "Locked"}
      </span>
    );
  if (phase === "result")
    return (
      <span key="settled" className="ph-status well hd-snap">
        <Icon name={voided ? "refresh" : "check"} size={14} /> {voided ? "Voided" : outcome ? "Settled" : "Waiting"}
      </span>
    );
  return null;
}

/** The split, Model and Gemini notches with their legend, and the price line. Settled: the winner floods. */
function SplitBlock({ l, m, settled }: { l: Lobby; m: Mkt; settled: boolean }) {
  const p = m.priceYes;
  const parts = [
    { id: "yes", label: "Yes", p: settled ? (m.outcome === "yes" ? 1 : 0) : p },
    { id: "no", label: "No", p: settled ? (m.outcome === "no" ? 1 : 0) : 1 - p },
  ];
  const gem = m.gemini;
  const showPros = !settled && (m.model != null || !!gem);
  const atLock = m.priceAtLock;
  const winP = m.outcome === "yes" ? atLock : atLock != null ? 1 - atLock : null;
  return (
    <div>
      {showPros && (
        <SplitMarkers
          className="ph-markers"
          markers={[
            { id: "model", label: "Model", p: m.model, shape: "solid" },
            { id: "gemini", label: "Gemini", p: gem?.prob, shape: "hollow" },
          ]}
        />
      )}
      <SplitBar parts={parts} className={cx("ph-split", m.voided && "is-void")} />
      {!settled && <p className="ph-legend">
        <span className="ph-legend-item">
          <span className="ph-dot-green" aria-hidden="true" />
          Room on Yes <Pct p={p} className="hd-num ph-legend-room" duration={700} />
        </span>
        {m.model != null && (
          <span className="ph-legend-item">
            <MarkerShape shape="solid" /> Model <span className="hd-num ph-legend-n">{pctText(m.model)}%</span>
          </span>
        )}
        {gem && (
          <span className="ph-legend-item">
            <MarkerShape shape="hollow" />
            {gem.url ? (
              <a href={gem.url} target="_blank" rel="noreferrer" className="ph-link">
                Gemini
              </a>
            ) : (
              "Gemini"
            )}{" "}
            <span className="hd-num ph-legend-n">{pctText(gem.prob)}%</span>
            {!gem.live && gem.asOf && <span className="ph-legend-asof">as of {shortDate(gem.asOf)}</span>}
          </span>
        )}
      </p>}
      {!settled && <PriceLine m={m} />}
      {settled && m.outcome && (
        <p className="ph-settled-line">
          <span key={m.outcome} className={cx("hd-stamp ph-win-word", m.outcome)}>
            {m.voided ? "Voided" : SIDE[m.outcome]}
          </span>
          {m.voided ? " Every stake is refunded." : winP != null ? ` won. The room had it at ${pctText(winP)}%.` : " won."}
        </p>
      )}
      {l.game?.kind === "replay" && m.rationale && !settled && <p className="ph-rationale">{m.rationale}</p>}
    </div>
  );
}

function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(t);
}

/** price-draw: the YES price since the question opened, drawn on as trades land. */
function PriceLine({ m }: { m: Mkt }) {
  const pts: SeriesPoint[] = m.history.map((c, i) => ({ t: i, p: c / 100 }));
  if (!pts.length) pts.push({ t: 0, p: m.priceYes });
  const start = pts[0].p;
  const diff = Math.round((m.priceYes - start) * 100);
  return (
    <div className="ph-price">
      <p className="ph-price-head">
        <span className="ph-price-label">
          Yes price since it opened at <span className="hd-num ph-ink">{pctText(start)}%</span>
        </span>
        <span className={cx("hd-num ph-price-diff", diff > 0 ? "up" : diff < 0 ? "down" : "flat")}>
          {diff !== 0 && <Icon name={diff > 0 ? "up" : "down"} size="0.6em" />}
          {diff === 0 ? "Flat" : `${diff > 0 ? "+" : "−"}${Math.abs(diff)} pts`}
        </span>
      </p>
      <Sparkline points={pts} className="ph-spark" stroke="var(--k-yes)" fill="rgba(20,104,255,0.12)" />
    </div>
  );
}

// ------------------------------------------------------------------ market + pool

function Tiles({ m, live, locked, actions, flow }: { m: Mkt; live: boolean; locked: boolean; actions: Actions; flow: Flow }) {
  const [pick, setPick] = useState<Side | null>(null);
  const mode = modeOf(m);
  return (
    <div>
      <div className="ph-tiles">
        {(["yes", "no"] as const).map((side) => {
          const p = side === "yes" ? m.priceYes : 1 - m.priceYes;
          const per = perDollar(m, side);
          const emptySide = mode === "pool" && m.pool && (side === "yes" ? m.pool.yesCents : m.pool.noCents) === 0;
          return (
            <OutcomeTile
              key={side}
              side={side}
              selected={pick === side}
              disabled={!live}
              onClick={() => setPick(pick === side ? null : side)}
              kickOn={pctText(p)}
              figure={<Pct p={p} arrow className="hd-num ph-tile-pct" duration={640} />}
              figureLabel={pctLabel(p)}
              note={emptySide ? `Be first on ${SIDE[side]}` : per ? payoutText(1 / per) : "–"}
            />
          );
        })}
        {locked && <div className="ph-lock-veil" aria-hidden="true" />}
      </div>
      {locked && (
        <p className="ph-locked-line hd-rise">
          <Icon name="lock" size={16} /> Trading closed. Watch the play.
        </p>
      )}
      {pick && live && (
        <StakeTray
          key={pick}
          side={pick}
          m={m}
          actions={actions}
          flow={flow}
          onClose={() => setPick(null)}
        />
      )}
    </div>
  );
}

/**
 * The outcome tile: a solid game tile (YES blue with white text, NO orange with ink text), label
 * then the rolling number, the exact payout under it. It kicks when its price moves; selected gets a
 * check that pops and an ink ring.
 */
export function OutcomeTile({
  side,
  selected,
  disabled,
  onClick,
  figure,
  figureLabel,
  note,
  kickOn,
  label,
  small = false,
}: {
  side: Side;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  figure?: ReactNode;
  figureLabel?: string;
  note?: ReactNode;
  kickOn?: unknown;
  label?: string;
  small?: boolean;
}) {
  const kick = useReplayClass(kickOn, "ph-kick");
  const name = label ?? SIDE[side];
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      aria-label={figureLabel ? `${name}, ${figureLabel}` : name}
      data-testid={`outcome-${side}`}
      className={cx("ph-tile hd-press hd-on-fill", side, small && "small", selected && "selected", kick)}
    >
      <span className="ph-tile-label">
        {selected && (
          <span className="ph-tile-check hd-pop">
            <Icon name="check" size={14} strokeWidth={3} />
          </span>
        )}
        {name}
      </span>
      {figure && (
        <span className="ph-tile-fig" aria-hidden="true">
          {figure}
        </span>
      )}
      {note && (
        <span className="ph-tile-note" aria-hidden="true">
          {note}
        </span>
      )}
    </button>
  );
}

/**
 * Stake chips: one tap places, gold coins fly to the split. Each chip says exactly what you pay and
 * what you get back if your side wins.
 */
function StakeTray({ side, m, actions, flow, onClose }: { side: Side; m: Mkt; actions: Actions; flow: Flow; onClose: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const chips = stakeChips(actions.balance);
  const place = async (c: number, el: HTMLElement) => {
    setBusy(c);
    const ok = await actions.buy(side, c);
    setBusy(null);
    if (ok) {
      flow(el);
      onClose();
    }
  };
  return (
    <div className="ph-tray hd-rise" role="group" aria-label={`Stake on ${SIDE[side]}`}>
      <div className="ph-tray-head">
        <span>
          You pay, you get back if <b className={cx("ph-side-text", side)}>{SIDE[side]}</b> wins
        </span>
        <button className="hd-btn hd-btn-quiet ph-icon-btn" onClick={onClose} aria-label="Cancel">
          <Icon name="x" size={20} />
        </button>
      </div>
      {chips.length ? (
        <div className={cx("ph-chips", `n${Math.min(4, chips.length)}`)}>
          {chips.map((c, i) => {
            const back = stakeReturn(m, side, c.cents);
            const can = c.cents <= actions.balance;
            return (
              <button
                key={c.cents}
                data-testid="stake-chip"
                data-stake={c.cents}
                disabled={busy !== null || actions.busy || !can}
                onClick={(e) => place(c.cents, e.currentTarget)}
                aria-label={`Pay ${usd(c.cents)}${c.max ? ", all you have" : ""}, get ${back !== null ? usd(back) : "a share of the pot"} if ${SIDE[side]} wins`}
                className={cx("ph-chip hd-pop hd-press", busy === c.cents && "busy", busy !== null && busy !== c.cents && "dim")}
                style={d(i * 50)}
              >
                <span className="hd-num ph-chip-amt">
                  {usdShort(c.cents)}
                  {c.max && <span className="ph-chip-max">all in</span>}
                </span>
                <span className="ph-chip-get">{busy === c.cents ? "Placing…" : back !== null ? `get ${usd(back)}` : "–"}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <button className="hd-btn hd-btn-secondary hd-btn-block ph-mt8" onClick={actions.addMoney}>
          <Icon name="plus" size={18} /> Add money to play
        </button>
      )}
    </div>
  );
}

/** $1, $2, $5 (the server's quick amounts) plus "all in" when the balance is something else. */
function stakeChips(balance: number): { cents: number; max: boolean }[] {
  const base = [100, 200, 500];
  if (balance < 25) return [];
  const out = base.map((c) => ({ cents: c, max: false }));
  if (balance > 0 && !base.includes(balance) && balance <= 5000 && balance >= 25) out.push({ cents: balance, max: true });
  return out;
}

// ------------------------------------------------------------------ head to head

function OfferBook({ l, m, live, actions, flow }: { l: Lobby; m: Mkt; live: boolean; actions: Actions; flow: Flow }) {
  const meId = l.me?.id;
  const offers = (m.offers ?? []).filter((o) => o.open || o.filled > 0);
  const theirs = offers.filter((o) => o.open && o.by !== meId);
  const mine = offers.filter((o) => o.by === meId);
  const [side, setSide] = useState<Side>("yes");
  const [cents, setCents] = useState(500);
  const [odds, setOdds] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const post = useRef<HTMLButtonElement>(null);
  const pv = offerPreview(cents, odds);

  return (
    <div className="ph-h2h">
      <h2 className="ph-h3">Offers from friends</h2>
      {theirs.length ? (
        <ul className="ph-offers">
          {theirs.map((o, i) => {
            const t = offerTerms(o);
            const pay = Math.min(t.take, actions.balance);
            const partial = pay < t.take;
            return (
              <li key={o.id} className="ph-offer hd-rise" style={d(i * 60)}>
                <div className="ph-offer-body">
                  <div className="ph-offer-who">
                    <b>{o.name}</b> backs <span className={cx("ph-side-text", o.side)}>{SIDE[o.side]}</span> at <span className="hd-num">{o.odds}x</span>
                  </div>
                  <div className="ph-offer-terms">
                    Pay <span className="hd-num ph-ink">{usd(pay)}</span>, get <span className="hd-num ph-ink">{usd(partial ? Math.floor((t.back * pay) / Math.max(1, t.take)) : t.back)}</span> if {SIDE[other(o.side)]}
                    {o.filled > 0 && <span className="ph-offer-filled"> · {usd(o.filled)} matched</span>}
                  </div>
                </div>
                <button
                  className={cx("ph-take hd-btn hd-press", other(o.side))}
                  disabled={!live || actions.busy || pay < 1}
                  onClick={async (e) => {
                    const el = e.currentTarget;
                    setError(null);
                    if (await actions.take(o.id, pay)) flow(el);
                  }}
                >
                  Take {SIDE[other(o.side)]}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="ph-hint">{live ? "No offers to take yet. Post one and a friend can take the other side." : "No open offers."}</p>
      )}

      {mine.length > 0 && (
        <ul className="ph-offers mine">
          {mine.map((o) => (
            <li key={o.id} className="ph-offer mine">
              <div className="ph-offer-body">
                <div className="ph-offer-who">
                  Your offer: <span className="hd-num">{usd(o.cents)}</span> on <span className={cx("ph-side-text", o.side)}>{SIDE[o.side]}</span> at <span className="hd-num">{o.odds}x</span>
                </div>
                <div className="ph-offer-terms">
                  {o.filled > 0 ? `${usd(o.filled)} matched` : "Waiting for a friend"}
                  {o.open && o.remaining > 0 && o.filled > 0 ? ` · ${usd(o.remaining)} still open` : ""}
                  {!o.open && o.remaining > 0 && o.filled > 0 ? " · the rest came back" : ""}
                </div>
              </div>
              <span className={cx("ph-pill", o.open ? "well" : "green")}>{o.open ? "Open" : "Matched"}</span>
            </li>
          ))}
        </ul>
      )}

      {live && (
        <div className="ph-post">
          <h2 className="ph-h3">Post an offer</h2>
          <div className="ph-tiles small">
            {(["yes", "no"] as const).map((s) => (
              <OutcomeTile key={s} side={s} small selected={side === s} disabled={false} onClick={() => setSide(s)} label={`Back ${SIDE[s]}`} />
            ))}
          </div>
          <div className="ph-seg" role="group" aria-label="Your stake">
            {[200, 500, 1000].map((c) => (
              <button key={c} aria-pressed={cents === c} onClick={() => setCents(c)} className="hd-press">
                <span className="hd-num">{usdShort(c)}</span>
              </button>
            ))}
          </div>
          <div className="ph-seg" role="group" aria-label="Odds">
            {ODDS.map((o) => (
              <button key={o} aria-pressed={odds === o} onClick={() => setOdds(o)} className="hd-press">
                <span className="hd-num">{o}x</span>
              </button>
            ))}
          </div>
          <p className="ph-preview">
            You pay <span className="hd-num ph-ink">{usd(cents)}</span>. A friend matches with <span className="hd-num ph-ink">{usd(pv.match)}</span>. You get{" "}
            <span className="hd-num ph-ink">{usd(pv.back)}</span> if {SIDE[side]}.
          </p>
          <button
            ref={post}
            className="hd-btn hd-btn-primary hd-btn-block"
            disabled={actions.busy || actions.balance < cents}
            onClick={async () => {
              setError(null);
              if (await actions.offer(side, cents, odds)) flow(post.current);
            }}
          >
            Offer {usdShort(cents)} on {SIDE[side]} at {odds}x
          </button>
          {actions.balance < cents && (
            <InlineError
              text={`You have ${usd(actions.balance)}. Add money or pick a smaller stake.`}
              action={
                <button className="hd-btn hd-btn-quiet ph-err-action" onClick={actions.addMoney}>
                  Add money
                </button>
              }
            />
          )}
          {error && <InlineError text={error} />}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ position + result

/** "You hold 3.52 Yes shares · pays $3.52 if Yes": stamps when it changes. */
function Position({ l, m }: { l: Lobby; m: Mkt }) {
  const me = l.me;
  const pos = me?.position;
  const mode = modeOf(m);
  const stamp = useReplayClass(pos?.spent ?? 0, "hd-stamp");
  if (!me || !pos || pos.spent <= 0 || l.phase === "result") return null;
  const rows: { side: Side; text: ReactNode; pays: ReactNode }[] = [];
  for (const side of ["yes", "no"] as const) {
    const amt = pos[side];
    if (amt <= 0) continue;
    if (mode === "market") {
      rows.push({
        side,
        text: (
          <>
            You hold <span className="hd-num ph-ink">{amt.toFixed(2)}</span> <b className={cx("ph-side-text", side)}>{SIDE[side]}</b> shares
          </>
        ),
        pays: <>pays <Roll text={usd(Math.floor(amt * 100))} className="hd-num ph-ink" duration={640} /> if {SIDE[side]}</>,
      });
    } else {
      const stakeCents = Math.round(amt * 100);
      const total = m.pool ? m.pool.yesCents + m.pool.noCents : 0;
      const sideTotal = m.pool ? (side === "yes" ? m.pool.yesCents : m.pool.noCents) : 0;
      const est = mode === "pool" && sideTotal > 0 ? Math.floor((stakeCents * total) / sideTotal) : null;
      rows.push({
        side,
        text: (
          <>
            Your stake <span className="hd-num ph-ink">{usd(stakeCents)}</span> on <b className={cx("ph-side-text", side)}>{SIDE[side]}</b>
          </>
        ),
        pays: est !== null ? <>pays about <Roll text={usd(est)} className="hd-num ph-ink" duration={640} /></> : mode === "h2h" ? "matched with friends" : null,
      });
    }
  }
  if (!rows.length) return null;
  return (
    <div className="ph-pos">
      {rows.map((r) => (
        <div key={r.side} className={cx("ph-pos-row", stamp)}>
          <span className={cx("ph-pos-rule", `hd-tone-${r.side}`)} aria-hidden="true" />
          <span className="ph-pos-text">{r.text}</span>
          {r.pays && <span className="ph-pos-pays">{r.pays}</span>}
        </div>
      ))}
      {mode === "market" && <p className="ph-pos-cost">Cost so far <span className="hd-tnum">{usd(pos.spent)}</span></p>}
    </div>
  );
}

function ResultRow({ l, m }: { l: Lobby; m: Mkt }) {
  const landed = useReplayClass(l.phase, "x");
  if (l.phase === "locked")
    return (
      <p className="ph-line">
        <Icon name="hourglass" size={16} /> Locked. Waiting for the result…
      </p>
    );
  if (l.phase !== "result" || !m.outcome) return null;
  const res = myResult(l);
  const celebrate = !!landed;
  const winners = m.winners.filter((w) => w.cents > 0).slice(0, 3);
  return (
    <div className="ph-result">
      {res.kind === "none" ? <p className="ph-hint">You sat this one out.</p> : <ResultBadge res={res} animate={celebrate} />}
      {celebrate && res.kind === "won" && <Burst count={14} seed={m.qIndex + 7} x="4rem" y="1.2rem" spread={8} />}
      {winners.length > 0 && !m.voided && (
        <p className="ph-winners">
          Paid out:{" "}
          {winners.map((w, i) => (
            <span key={w.name}>
              {i > 0 && ", "}
              {w.name} <span className="hd-num ph-ink">{usd(w.cents)}</span>
            </span>
          ))}
        </p>
      )}
      <p className="ph-hint">{l.game?.kind === "replay" ? "The next question opens by itself in a few seconds." : "The host opens the next question from the box."}</p>
    </div>
  );
}

/** "Called it +$1.52" (solid YES pill with a check), "Cooked −$2.00", "Refunded $2.00". */
export function ResultBadge({ res, animate = false }: { res: ReturnType<typeof myResult>; animate?: boolean }) {
  if (res.kind === "won")
    return (
      <span className={cx("ph-badge won", animate && "hd-shine hd-stamp")} data-testid="result-won">
        <Icon name="check" size={16} strokeWidth={2.8} /> Called it <span className="hd-num">{signedUsd(res.net)}</span>
      </span>
    );
  if (res.kind === "lost")
    return (
      <span className={cx("ph-badge lost", animate && "hd-stamp")}>
        <Icon name="x" size={16} strokeWidth={2.8} /> Cooked <span className="hd-num">{signedUsd(res.net)}</span>
      </span>
    );
  if (res.kind === "refunded")
    return (
      <span className="ph-badge refunded">
        <Icon name="refresh" size={16} /> Refunded <span className="hd-num">{usd(res.amount)}</span>
      </span>
    );
  return null;
}

// ------------------------------------------------------------------ between questions

/** The pregame question, locked and settling at the final whistle. */
export function ParkedCard({ l }: { l: Lobby }) {
  const p = l.parked;
  if (!p) return null;
  const pos = p.myPosition as { yes?: number; no?: number; spent?: number } | null;
  return (
    <section className="ph-parked hd-card hd-rise" aria-labelledby="parked-q">
      <p className="ph-parked-kind">
        <Icon name="lock" size={14} /> Pregame call · settles at the final whistle
      </p>
      <h2 id="parked-q" className="hd-q ph-parked-q">{p.text}</h2>
      <p className="ph-legend">
        <span className="ph-legend-item">
          <span className="ph-dot-green" aria-hidden="true" /> Room on Yes <span className="hd-num ph-legend-room">{p.yesCents}%</span>
        </span>
        {pos?.spent ? (
          <span className="ph-legend-item">
            Your stake <span className="hd-num ph-ink">{usd(pos.spent)}</span>
            {pos.yes ? <b className="ph-side-text yes"> Yes</b> : null}
            {pos.no ? <b className="ph-side-text no"> No</b> : null}
          </span>
        ) : null}
      </p>
    </section>
  );
}

export const mkKey = (m: Mkt) => `${m.qIndex}-${m.openedAt}`;
