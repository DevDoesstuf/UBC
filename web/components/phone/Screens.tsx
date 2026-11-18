"use client";
// Phone screens and chrome: join, buy-in, the scorebug header, the tab bar, the caption pill,
// the leaderboard, results + scorecard, the end of the game and the money sheet.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Qr } from "@/components/Qr";
import {
  Aurora, Avatar, Burst, GOLD_BURST, Icon, Kinetic, Mark, Roll, Wordmark, ordinal, useCoins, useFlip, useNewIds,
  useReplayClass, usd, usdShort, signedUsd, withAlpha, type IconName,
} from "@/components/huddle";
import { SIDE, SOLANA_ADDRESS, profitOf, ranked, scoreSides, type Lobby } from "./derive";
import { CodeTiles, Empty, InlineError, Money, SectionTitle, Sheet, cx, d } from "./ui";

/** The server's lobby limit (lib/lobby.ts MAX_PLAYERS): a full lobby says so before anyone types a name. */
const MAX_PARTY = 12;

// ------------------------------------------------------------------ backdrop

/** The drifting colour field behind the app; a moment market tints it with the game's colour. */
export function Backdrop({ tint }: { tint?: string | null }) {
  const blobs = tint
    ? [
        { c: withAlpha(tint, 0.2), x: "-20vmax", y: "-14vmax", s: "64vmax", mx: "10vmax", my: "8vmax", dur: "18s" },
        { c: "rgba(124,203,78,0.2)", x: "40vw", y: "40vh", s: "60vmax", mx: "-9vmax", my: "-7vmax", dur: "22s", d: "-5s" },
        { c: "rgba(232,163,61,0.12)", x: "20vw", y: "10vh", s: "40vmax", mx: "6vmax", my: "5vmax", dur: "26s", d: "-9s" },
      ]
    : undefined;
  return <Aurora key={tint ? "tint" : "default"} blobs={blobs} fixed className="hd-fade" />;
}

// ------------------------------------------------------------------ join

export function JoinScreen({
  l,
  busy,
  error,
  onJoin,
}: {
  l: Lobby;
  busy: boolean;
  error: string | null;
  onJoin: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const clean = name.trim();
  const ended = l.phase === "ended";
  const players = l.players;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (clean) onJoin(clean);
  };
  return (
    <div className="ph-screen">
      <Backdrop />
      <div className="ph-col ph-full">
        <header className="ph-brandbar">
          <a href="/" aria-label="Huddle home" className="ph-brand-link">
            <Wordmark className="hd-pop ph-wordmark-lg" lit={Math.min(12, players.length + 1)} />
          </a>
        </header>
        <Kinetic as="h1" text={l.game?.title ? "You’re invited to the huddle." : "Your phone is the controller."} className="hd-q ph-hero-h" delay={120} stagger={60} />
        <p className="hd-rise ph-lead" style={d(520)}>
          Call every play with your friends: one tap per question, the odds live, the pot settled for you.
        </p>

        <section className="ph-party hd-card hd-rise" style={d(300)} aria-label="This party">
          <div className="ph-party-top">
            <div className="ph-party-titles">
              <p className="ph-party-kind">
                {l.phase === "open" || l.phase === "locked" ? (
                  <>
                    <span className="hd-live-dot" aria-hidden="true" /> Live now
                  </>
                ) : ended ? (
                  "Finished"
                ) : (
                  "In the lobby"
                )}
              </p>
              <h2 className="hd-q ph-party-title">{l.game?.title ?? "Huddle"}</h2>
              {l.game?.subtitle && <p className="ph-party-sub">{l.game.subtitle}</p>}
            </div>
            <CodeTiles code={l.code} small delay={420} />
          </div>
          <div className="ph-party-people">
            <div className="ph-stack" aria-hidden="true">
              {players.slice(0, 5).map((p, i) => (
                <span key={p.id} className="ph-stack-av hd-pop" style={d(500 + i * 70)}>
                  <Avatar name={p.name} size="2rem" />
                </span>
              ))}
            </div>
            <p>
              {players.length === 0
                ? "Be the first one in."
                : `${players.slice(0, 2).map((p) => p.name).join(", ")}${players.length > 2 ? ` and ${players.length - 2} more` : ""} ${players.length === 1 ? "is" : "are"} in.`}
            </p>
          </div>
        </section>

        <div className="ph-grow" />

        {ended ? (
          <Empty mark>This party has ended. Pick a new game on the box to start another.</Empty>
        ) : l.players.length >= MAX_PARTY ? (
          <Empty mark>This party is full ({MAX_PARTY} players). Watch along on the TV, or start another game on the box.</Empty>
        ) : (
          <form className="ph-join-form hd-rise" style={d(380)} onSubmit={submit} noValidate>
            <label htmlFor="name" className="ph-label">
              What should we call you?
            </label>
            <input
              id="name"
              name="nickname"
              className="hd-field ph-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setTried(false);
              }}
              maxLength={14}
              placeholder="e.g. Maya…"
              autoComplete="nickname"
              autoCapitalize="words"
              spellCheck={false}
              enterKeyHint="go"
              aria-invalid={tried && !clean}
              aria-describedby="name-hint"
            />
            <button className="hd-btn hd-btn-prime hd-btn-block" disabled={busy} data-testid="join">
              {busy ? (
                <>
                  <Mark size="1.4rem" spin lit={3} className="ph-btn-mark" /> Joining…
                </>
              ) : (
                <>
                  Join the huddle <Icon name="arrowRight" size={20} />
                </>
              )}
            </button>
            <p id="name-hint" className="ph-hint ph-center">
              {tried && !clean ? <span className="ph-hot">Type a name first, so friends know it’s you.</span> : "Test money only. Nothing real is charged."}
            </p>
            {error && <InlineError text={error} />}
          </form>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ buy-in

/**
 * money-flow buy-in: one big "Buy in $5", then "You're in": gold coins arc from the button into the
 * room's pot while it rolls up, and a small gold burst lands on the pot. The confirmation stays
 * mounted until the player moves on (or a few seconds pass), even though the money has landed.
 */
export function BuyInScreen({
  l,
  done,
  busy,
  error,
  onBuyIn,
  onDone,
  onSkip,
  payment,
}: {
  l: Lobby;
  done: boolean;
  busy: boolean;
  error: string | null;
  onBuyIn: (cents: number) => Promise<boolean>;
  onDone: () => void;
  onSkip: () => void;
  payment: ReactNode;
}) {
  const options = l.money.depositOptions;
  const [amount, setAmount] = useState(options[0] ?? 500);
  const me = l.me!;
  const inPlayers = l.players.filter((p) => p.deposited > 0);
  const others = inPlayers.filter((p) => p.id !== me.id);
  const pot = l.players.reduce((a, p) => a + p.deposited, 0);
  const button = useRef<HTMLButtonElement>(null);
  const potEl = useRef<HTMLSpanElement>(null);
  const [coins, fire] = useCoins();

  // Move on by itself after a moment (a ref, so the 1 s poll re-render does not restart the timer).
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => doneRef.current(), 4000);
    return () => clearTimeout(t);
  }, [done]);

  const go = async () => {
    const from = button.current;
    if (await onBuyIn(amount)) fire(from, potEl.current, 3);
  };

  return (
    <div className="ph-screen">
      <Backdrop />
      <div className="ph-col ph-full">
        <header className="ph-brandbar">
          <Wordmark className="ph-wordmark" lit={Math.min(12, l.players.length + 1)} />
          <span className="hd-num ph-code-plain" translate="no">{l.code}</span>
        </header>
        <div className="ph-mt24">
          <p className="hd-fade ph-kicker">{l.game?.title ?? "Huddle"}</p>
          <Kinetic as="h1" text={`Hi ${me.name}. Grab your chips.`} className="hd-q ph-title-h" stagger={50} />
        </div>

        <div className="ph-buyin-mid">
          {done ? (
            <div key="done" className="ph-done hd-card hd-zoom" role="status" data-testid="buy-in-done">
              <span className="ph-done-check hd-pop">
                <Icon name="check" size={30} strokeWidth={2.8} />
              </span>
              <Kinetic as="p" text={`You’re in, ${me.name}.`} className="hd-q ph-done-h" delay={120} stagger={70} />
              <p className="hd-rise ph-lead" style={d(420)}>
                <span className="hd-num ph-ink">{usd(me.balance)}</span> ready to play. The first question drops on the next big moment.
              </p>
            </div>
          ) : (
            <div key="cta">
              <p className="hd-zoom hd-num ph-bigmoney">{usdShort(amount)}</p>
              <p className="hd-rise ph-bigmoney-sub" style={d(160)}>to play tonight</p>
              {options.length > 1 && (
                <div className="ph-seg ph-mt16" role="group" aria-label="Buy-in amount">
                  {options.map((c) => (
                    <button key={c} aria-pressed={amount === c} onClick={() => setAmount(c)} className="hd-press">
                      <span className="hd-num">{usdShort(c)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="ph-pot hd-card hd-rise" style={d(260)}>
            <div className="ph-stack" aria-hidden="true">
              {inPlayers.slice(0, 5).map((p, i) => (
                <span key={p.id} className="ph-stack-av hd-pop" style={d(300 + i * 70)}>
                  <Avatar name={p.name} size="2rem" />
                </span>
              ))}
            </div>
            <p className="ph-pot-text">
              {others.length === 0
                ? me.deposited > 0
                  ? "You’re the first one in."
                  : "Be the first one in."
                : `${others.slice(0, 2).map((p) => p.name).join(", ")}${others.length > 2 ? ` and ${others.length - 2} more` : ""} ${others.length === 1 ? "is" : "are"} in.`}
            </p>
            <span className="ph-pot-num">
              <span className="ph-pot-k">
                <span className="ph-gold-dot" aria-hidden="true" /> Room pot
              </span>
              <span ref={potEl} className="hd-num ph-pot-v">
                <Roll text={usd(pot)} value={pot} duration={900} />
              </span>
              {done && <Burst count={14} seed={7} colours={GOLD_BURST} x="70%" y="60%" spread={6} delay={700} />}
            </span>
          </div>
        </div>

        {payment}

        {done ? (
          <button onClick={onDone} className="hd-btn hd-btn-primary hd-btn-block">
            Let’s go <Icon name="arrowRight" size={20} />
          </button>
        ) : (
          <>
            <button ref={button} disabled={busy} onClick={go} data-testid="buy-in" className="hd-btn hd-btn-prime hd-btn-block">
              {busy ? (
                <>
                  <Mark size="1.4rem" spin lit={3} className="ph-btn-mark" /> Getting your chips…
                </>
              ) : (
                `Buy in ${usdShort(amount)}`
              )}
            </button>
            {error && <InlineError text={error} />}
            <p className="ph-hint ph-center">{moneyHint(l)}</p>
            <button onClick={onSkip} className="hd-btn hd-btn-quiet ph-center-btn">
              Just watch for now
            </button>
          </>
        )}
        {coins}
      </div>
    </div>
  );
}

export function moneyHint(l: Lobby): string {
  const mode = l.money.mode as string;
  if (mode === "solana") return "Pay from any wallet app. Test money only; your balance shows in dollars.";
  if (mode === "coinbase") return l.money.realMoney ? "You pay by card or bank. Your balance is in dollars." : "Test checkout: no real money moves.";
  return "Test money for the party. Nothing real is charged.";
}

// ------------------------------------------------------------------ header

/** The scorebug pill (or the game pill), your balance (tap to add money or cash out) and tonight's P&L. */
export function Header({ l, onMoney }: { l: Lobby; onMoney: () => void }) {
  const me = l.me!;
  const profit = profitOf(l);
  const s = l.game?.score;
  const teams = scoreSides(l);
  const live = l.phase === "open" || (!!s && s.status === "live");
  return (
    <header className="ph-top">
      <div className="ph-top-in">
        <div className="ph-top-row">
          {s && teams ? (
            <div className="ph-bug" role="group" aria-label={`${teams.label}${s.clock ? `, ${s.clock}` : ""}`}>
              <span className="ph-bug-teams" aria-hidden="true">
                <span className="ph-team">{teams.left.short ?? teams.left.name.slice(0, 3)}</span>
                <Score key="l" n={teams.left.score} />
                <Score key="r" n={teams.right.score} />
                <span className="ph-team">{teams.right.short ?? teams.right.name.slice(0, 3)}</span>
              </span>
              <span className="ph-bug-clock" aria-hidden="true">
                {/* Same rule as the TV: before the clock starts (the pregame question) it is Pre-game, not live. */}
                {s.status === "live" && s.started !== false && <span className="hd-live-dot" />}
                <span className="hd-num">{s.status === "final" ? "Final" : s.status === "pre" || s.started === false ? "Pre-game" : s.clock}</span>
              </span>
            </div>
          ) : (
            <div className="ph-bug" role="group" aria-label={l.game?.title ?? "Huddle"}>
              <span className="ph-bug-title">
                <Mark size="1.2rem" lit={3} className="ph-bug-mark" />
                <span className="ph-trunc">{l.game?.title ?? "Huddle"}</span>
              </span>
              {live && (
                <span className="ph-bug-clock">
                  <span className="hd-live-dot" aria-hidden="true" /> Live
                </span>
              )}
            </div>
          )}
          <span className="ph-codechip hd-num" translate="no" aria-label={`Party code ${l.code}`}>
            {l.code}
          </span>
        </div>
        <div className="ph-top-money">
          <button onClick={onMoney} className="ph-balance" aria-label={`Your balance ${usd(me.balance)}. Add money or cash out`} data-testid="balance">
            <span className="ph-balance-col">
              <span className="ph-k">Your balance</span>
              <Money cents={me.balance} className="ph-balance-v" duration={700} />
            </span>
            <span className="ph-plus" aria-hidden="true">
              <Icon name="plus" size={14} strokeWidth={2.6} />
            </span>
          </button>
          <div className="ph-tonight">
            <span className="ph-k">Tonight</span>
            <span className={cx("hd-num ph-pnl", profit > 0 ? "up" : profit < 0 ? "down" : "")}>
              {Math.abs(profit) >= 1 && <Icon name={profit > 0 ? "up" : "down"} size={12} />}
              <Money cents={profit} signed flash={false} duration={700} />
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}

/** One side of the score: an ink square that beats when it changes. */
function Score({ n }: { n: number }) {
  const beat = useReplayClass(n, "hd-beat");
  return (
    <span className={cx("hd-num ph-score", beat)}>
      <Roll text={String(n)} flash={false} duration={480} />
    </span>
  );
}

// ------------------------------------------------------------------ dock: caption + tabs

export type Tab = "play" | "board" | "results";
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "play", label: "Play", icon: "bolt" },
  { id: "board", label: "Board", icon: "trophy" },
  { id: "results", label: "Results", icon: "list" },
];

export function Dock({ tab, onTab, caption, badge }: { tab: Tab; onTab: (t: Tab) => void; caption: { id: number; text: string; at: number } | null; badge: boolean }) {
  const i = TABS.findIndex((t) => t.id === tab);
  return (
    <div className="ph-dock">
      {caption && <CaptionPill caption={caption} />}
      <nav className="ph-tabs" aria-label="Sections">
        <span className="ph-tab-pill" style={{ transform: `translateX(${i * 100}%)` }} aria-hidden="true" />
        {TABS.map((t) => (
          <button key={t.id} className={cx("ph-tab", tab === t.id && "on")} aria-current={tab === t.id ? "page" : undefined} onClick={() => onTab(t.id)}>
            <span className="ph-tab-icon">
              <Icon name={t.icon} size={22} />
              {t.id === "play" && badge && tab !== "play" && <span className="ph-tab-badge hd-pop" aria-label="New question" />}
            </span>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

/** The announcer's latest line as an ink pill, word by word; the speaker dot pings while it is fresh. */
function CaptionPill({ caption }: { caption: { id: number; text: string; at: number } }) {
  const [fresh, setFresh] = useState(true);
  useEffect(() => {
    setFresh(true);
    const t = setTimeout(() => setFresh(false), 6000);
    return () => clearTimeout(t);
  }, [caption.id]);
  return (
    <p className="ph-caption" aria-live="polite">
      <span className={cx("ph-caption-dot", fresh && "on")} aria-hidden="true">
        <Icon name="speaker" size={15} />
      </span>
      <Kinetic text={caption.text} replay={caption.id} stagger={28} className="ph-caption-text" />
    </p>
  );
}

// ------------------------------------------------------------------ board

/** board-reorder: rows glide to their new place; the leader is ink with a gold rank and a crown. */
export function Leaderboard({ l, title = "Leaderboard" }: { l: Lobby; title?: string }) {
  const rows = ranked(l);
  const order = rows.map((p) => p.id).join(",");
  const list = useFlip<HTMLOListElement>(order);
  const fresh = useNewIds(rows.map((p) => p.id));
  const meId = l.me?.id;
  return (
    <section aria-labelledby="board-title">
      <SectionTitle id="board-title" count={rows.length}>
        {title}
      </SectionTitle>
      {rows.length ? (
        <ol className="ph-board" ref={list}>
          {rows.map((p, i) => {
            const mine = p.id === meId;
            const lead = p.lead;
            const net = p.worth - p.deposited;
            return (
              <li key={p.id} data-flip={p.id} className={cx("ph-row", lead && "lead", mine && !lead && "mine", fresh.has(p.id) ? "hd-pop" : "hd-rise")} style={d(Math.min(i, 8) * 50)}>
                <span className={cx("hd-num ph-rank", lead && "gold")}>{p.rank}</span>
                <Avatar name={p.name} size="2.5rem" />
                <div className="ph-row-main">
                  <div className="ph-row-name">
                    <span className="ph-trunc">{p.name}</span>
                    {mine && <span className="ph-you">You</span>}
                    {lead && <Icon name="crown" size={16} className="ph-crown" title="Leading" />}
                  </div>
                  <div className="ph-row-sub hd-tnum">{p.deposited > 0 ? `in for ${usd(p.deposited)}` : "not in yet"}</div>
                </div>
                <span className="ph-row-right">
                  <Money cents={p.worth} className="ph-row-bal" duration={900} />
                  {p.deposited > 0 && Math.abs(net) >= 1 && l.phase !== "open" && l.phase !== "locked" && (
                    <span className={cx("hd-num ph-row-net", net > 0 ? "up" : "down")}>{signedUsd(net)}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <Empty mark>Nobody’s in yet. Share the code and the board fills up.</Empty>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ results + scorecard

export function ResultsTab({ l }: { l: Lobby }) {
  return (
    <div className="ph-stackgap">
      <section aria-labelledby="res-title">
        <SectionTitle id="res-title" count={l.results.length}>
          Results
        </SectionTitle>
        {l.results.length ? (
          <ul className="ph-results">
            {[...l.results].reverse().map((r, i) => {
              const mine = r.winners.find((w) => w.name === l.me?.name);
              return (
                <li key={`${r.text}-${i}`} className="ph-res hd-card hd-rise" style={d(i * 50)}>
                  <span className={cx("ph-res-tag", r.outcome)}>
                    <Icon name="check" size={13} strokeWidth={3} /> {SIDE[r.outcome]}
                  </span>
                  <span className="ph-res-text">{r.text}</span>
                  <span className="ph-res-meta">
                    <span className="hd-tnum">{usd(r.volume)} traded</span>
                    {mine && mine.cents > 0 && <span className="ph-res-mine hd-num">you got {usd(mine.cents)}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>No results yet. Each question lands here once it settles.</Empty>
        )}
      </section>
      {l.scorecard && l.scorecard.n > 0 && <ScorecardBlock l={l} />}
      <section aria-labelledby="act-title">
        <SectionTitle id="act-title">Activity</SectionTitle>
        <ul className="ph-activity">
          {[...l.events].reverse().slice(0, 8).map((e) => (
            <li key={e.id}>{e.text}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Friends vs Model vs Gemini: Brier bars (shorter is better), the best gets a gold crown. */
export function ScorecardBlock({ l }: { l: Lobby }) {
  const s = l.scorecard!;
  const rows = [
    { id: "room", label: "Friends", v: s.room, cls: "room" },
    { id: "model", label: "Model", v: s.model, cls: "model" },
    { id: "gemini", label: "Gemini", v: s.gemini, cls: "gemini" },
  ];
  const vals = rows.map((r) => r.v).filter((v): v is number => v !== null);
  const best = vals.length ? Math.min(...vals) : null;
  const max = Math.max(0.25, ...vals);
  return (
    <section aria-labelledby="sc-title" className="ph-score-card hd-card">
      <SectionTitle id="sc-title" aside={`${s.n} ${s.n === 1 ? "question" : "questions"} · shorter is better`}>
        Who called it best
      </SectionTitle>
      <ul className="ph-sc-rows">
        {rows.map((r, i) => (
          <li key={r.id} className="ph-sc-row">
            <span className="ph-sc-label">
              {r.label}
              {best !== null && r.v === best && <Icon name="crown" size={15} className="ph-crown hd-pop" style={d(400 + i * 160)} title="Best" />}
            </span>
            <span className="ph-sc-track">
              {r.v !== null && <span className={cx("ph-sc-bar hd-flood", r.cls)} style={{ transform: `scaleX(${Math.max(0.04, r.v / max)})`, ...d(i * 160) }} />}
            </span>
            <span className="hd-num ph-sc-v">{r.v === null ? "–" : r.v.toFixed(3)}</span>
          </li>
        ))}
      </ul>
      {s.verdict && <Kinetic as="p" text={s.verdict} className="hd-q ph-verdict" stagger={40} />}
    </section>
  );
}

// ------------------------------------------------------------------ end of game

export function EndOfGame({ l, cashOut, cashed }: { l: Lobby; cashOut: ReactNode; cashed: { cents: number; explorer?: string } | null }) {
  const me = l.me!;
  const profit = profitOf(l);
  // Only players who bought in are ranked: a watcher with $0 is not "2nd of 12".
  const rows = ranked(l, true);
  const mine = rows.find((p) => p.id === me.id);
  const rank = mine?.rank ?? 0;
  const tied = !!mine && rows.some((p) => p.id !== me.id && p.rank === mine.rank);
  const teams = scoreSides(l);
  const verdict = mine?.lead && profit > 0 ? "You won the room." : rank === 1 && tied && profit > 0 ? "Tied for the top." : profit > 0 ? "Up on the night." : profit < 0 ? "Cooked tonight." : "Broke even.";
  const pot = useRef<HTMLSpanElement>(null);
  const amount = useRef<HTMLDivElement>(null);
  const [coins, fire] = useCoins();
  useEffect(() => {
    if (!cashed) return;
    const t = setTimeout(() => fire(pot.current, amount.current, 5), 200);
    return () => clearTimeout(t);
  }, [cashed, fire]);

  return (
    <div className="ph-stackgap">
      <section className="ph-ft hd-card" aria-labelledby="ft-title">
        <p id="ft-title" className="ph-kicker ph-center">Full time</p>
        {teams && (
          <p className="ph-ft-score" aria-label={teams.label}>
            <span className="ph-team big" aria-hidden="true">{teams.left.short ?? teams.left.name}</span>
            <span className="hd-num ph-score big hd-pop" aria-hidden="true">{teams.left.score}</span>
            <span className="hd-num ph-score big hd-pop" style={d(90)} aria-hidden="true">{teams.right.score}</span>
            <span className="ph-team big" aria-hidden="true">{teams.right.short ?? teams.right.name}</span>
          </p>
        )}
        <div className="ph-ft-rule" />
        <div className={cx("hd-num hd-zoom ph-night", profit > 0 ? "up hd-shine" : profit < 0 ? "down" : "")} style={d(300)} data-testid="my-night">
          {Math.abs(profit) >= 1 && <Icon name={profit > 0 ? "up" : "down"} size="0.3em" />}
          <Money cents={profit} signed flash={false} duration={1200} />
        </div>
        <Kinetic as="p" text={verdict} className="hd-q ph-ft-verdict" delay={500} stagger={60} />
        {rank > 0 && (
          <p className="hd-rise ph-hint ph-center" style={d(800)}>
            You finished {tied ? "tied " : ""}{ordinal(rank)} of {rows.length}
          </p>
        )}
        {mine?.lead && profit > 0 ? <Burst count={40} seed={11} y="45%" spread={16} delay={600} /> : profit > 0 ? <Burst count={14} seed={5} y="45%" spread={10} delay={600} /> : null}
      </section>

      <section className="hd-card ph-cash" aria-labelledby="cash-title">
        <h2 id="cash-title" className="ph-h2">{cashed ? "Paid out" : me.balance > 0 ? "Cash out" : "All settled"}</h2>
        {cashed ? (
          <div className="ph-paid hd-rise">
            <span ref={pot} className="ph-paid-k">
              <span className="ph-gold-dot" aria-hidden="true" /> Your winnings are in
            </span>
            <div ref={amount} className="hd-stamp" style={d(150)}>
              <span className="hd-num ph-paid-v" data-testid="my-payout" data-amount={cashed.cents}>
                <Roll text={usd(cashed.cents)} flash={false} duration={1200} />
              </span>
            </div>
            {cashed.explorer && (
              <a href={cashed.explorer} target="_blank" rel="noreferrer" className="hd-btn hd-btn-quiet ph-center-btn">
                View receipt <Icon name="external" size={15} />
              </a>
            )}
          </div>
        ) : me.balance > 0 ? (
          <>
            <p className="ph-lead">
              You have <span className="hd-num ph-ink">{usd(me.balance)}</span> to take home.
            </p>
            <span ref={pot} />
            {cashOut}
          </>
        ) : (
          <p className="ph-lead">
            {me.withdrawn > 0 ? (
              <>
                You took home <span className="hd-num ph-ink">{usd(me.withdrawn)}</span>. Thanks for playing.
              </>
            ) : (
              "Nothing left to cash out. Thanks for playing."
            )}
          </p>
        )}
      </section>

      {rows.length > 0 && <Podium l={l} />}
      <Leaderboard l={l} title="Final leaderboard" />
      {l.scorecard && l.scorecard.n > 0 && <ScorecardBlock l={l} />}
      {coins}
    </div>
  );
}

/** The podium as the box draws it: brand gradient 1st, ink 2nd, card 3rd. */
function Podium({ l }: { l: Lobby }) {
  const rows = ranked(l, true).slice(0, 3);
  const order = [1, 0, 2].filter((i) => rows[i]);
  return (
    <section aria-label="Podium" className="ph-podium">
      {order.map((i, k) => {
        const p = rows[i];
        return (
          <div key={p.id} className={cx("ph-pod", `p${i + 1}`, "hd-rise")} style={d(200 + k * 120)}>
            <Avatar name={p.name} size="2.75rem" />
            <span className="ph-pod-name ph-trunc">{p.name}</span>
            <span className="hd-num ph-pod-v">{usd(p.worth)}</span>
            <span className="ph-pod-block">
              <span className="hd-num">{p.rank}</span>
            </span>
          </div>
        );
      })}
    </section>
  );
}

// ------------------------------------------------------------------ money

export function PayLink({ url, cents, onCheck, onClose, checking }: { url: string; cents: number; onCheck: () => void; onClose: () => void; checking: boolean }) {
  return (
    <div className="ph-paylink hd-card hd-rise" role="group" aria-label={`Pay ${usd(cents)}`}>
      <span className="ph-paylink-qr">
        <Qr text={url} size={148} />
      </span>
      <div className="ph-paylink-body">
        <b className="ph-h3">Add {usd(cents)}</b>
        <p className="ph-hint">Scan with your wallet app, or open it on this phone. We check for it every few seconds.</p>
        <a className="hd-btn hd-btn-primary ph-btn-sm" href={url}>
          <Icon name="wallet" size={18} /> Open in wallet
        </a>
        <button className="hd-btn hd-btn-secondary ph-btn-sm" onClick={onCheck} disabled={checking}>
          {checking ? "Checking…" : "Check for my payment"}
        </button>
        <button className="hd-btn hd-btn-quiet ph-btn-sm" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

/** Cash-out control: an optional Solana address field (solana payouts) and one button. */
export function CashOut({
  l,
  busy,
  prime,
  onCashOut,
}: {
  l: Lobby;
  busy: boolean;
  prime: boolean;
  onCashOut: (address: string) => void;
}) {
  const [address, setAddress] = useState("");
  const kind = (l.money.payouts as string) === "solana" ? "solana" : l.money.payouts === "onchain" ? "evm" : null;
  const ok = kind === "solana" ? address === "" || SOLANA_ADDRESS.test(address) : kind === "evm" ? /^0x[0-9a-fA-F]{40}$/.test(address) : true;
  const me = l.me!;
  return (
    <div className="ph-cashout">
      {kind && (
        <label className="ph-field-label" htmlFor="payout">
          {kind === "solana" ? "Your Solana address (optional)" : "Payout address"}
          <input
            id="payout"
            name="payout-address"
            className="hd-field"
            value={address}
            onChange={(e) => setAddress(e.target.value.trim())}
            placeholder={
              kind === "solana"
                ? me.solanaAddress
                  ? `Leave empty to pay ${me.solanaAddress.slice(0, 4)}…${me.solanaAddress.slice(-4)}`
                  : "Paste it, or leave empty to pay the wallet you paid from…"
                : "0x…"
            }
            autoComplete="off"
            spellCheck={false}
            aria-invalid={address.length > 0 && !ok}
          />
          {address.length > 0 && !ok && <span className="ph-hot">That address doesn’t look right. Paste it again.</span>}
        </label>
      )}
      <button
        className={cx("hd-btn hd-btn-block", prime ? "hd-btn-prime" : "hd-btn-secondary")}
        disabled={busy || me.balance <= 0 || !ok}
        onClick={() => onCashOut(address)}
        data-testid="cash-out"
      >
        {busy ? "Cashing out…" : (
          <>
            Cash out <Money cents={me.balance} flash={false} duration={500} />
          </>
        )}
      </button>
    </div>
  );
}

export function MoneySheet({
  l,
  open,
  onClose,
  busy,
  onDeposit,
  payment,
  cashOut,
  checkButton,
}: {
  l: Lobby;
  open: boolean;
  onClose: () => void;
  busy: boolean;
  onDeposit: (cents: number, el: HTMLElement) => void;
  payment: ReactNode;
  cashOut: ReactNode;
  checkButton: ReactNode;
}) {
  const me = l.me!;
  return (
    <Sheet open={open} onClose={onClose} title="Your money">
      <div className="ph-sheet-body">
        <p className="ph-lead">
          Balance <span className="hd-num ph-ink">{usd(me.balance)}</span>
          {me.deposited > 0 && <> · in for <span className="hd-tnum">{usd(me.deposited)}</span></>}
        </p>
        {l.phase !== "ended" && (
          <>
            <h3 className="ph-h3 ph-mt16">Add money</h3>
            <div className="ph-chips n3 ph-mt8">
              {l.money.depositOptions.map((c) => (
                <button key={c} className="ph-chip hd-press" disabled={busy} onClick={(e) => onDeposit(c, e.currentTarget)}>
                  <span className="hd-num ph-chip-amt">{usdShort(c)}</span>
                  <span className="ph-chip-get">add</span>
                </button>
              ))}
            </div>
            {payment}
            {checkButton}
            <p className="ph-hint">{moneyHint(l)}</p>
          </>
        )}
        {me.balance > 0 && (
          <>
            <h3 className="ph-h3 ph-mt16">Cash out</h3>
            <p className="ph-hint">Takes your whole balance out of the game.</p>
            {cashOut}
          </>
        )}
      </div>
    </Sheet>
  );
}
