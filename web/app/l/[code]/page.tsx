"use client";
// Phone page: /l/ABCD  (add ?seat=2 to play as a second player from the same browser while testing)
// Light, trading-app layout: the question and its live price on top, the buy buttons in a dock at thumb reach.
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Qr } from "@/components/Qr";
import { Spark } from "@/components/Spark";
import { HttpError, api, fmtClock, loadToken, saveToken, useNow, usePoll, usd, type LobbyData } from "@/components/client";
import {
  gameScore, latestCaption, marketGemini, marketMode, marketModel, marketOffers, marketPool, probCents, scorecard,
  type Offer,
} from "@/components/extras";
import { CountUp, Icon, Roll, Wordmark, useNewIds } from "@/components/ui";
import { sharesForSpend } from "@/lib/lmsr";

type Side = "yes" | "no";
const SIDE: Record<Side, string> = { yes: "Yes", no: "No" };
const ODDS = [1.5, 2, 3];
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58 public key

export default function PhonePage() {
  const params = useParams<{ code: string }>();
  const code = String(params.code || "").toUpperCase();
  const [boot, setBoot] = useState<{ seat: string | null; depositReturn: boolean } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err"; n: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState(100);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [payLink, setPayLink] = useState<{ url: string; cents: number } | null>(null);
  const [offerSide, setOfferSide] = useState<Side>("yes");
  const [offerOdds, setOfferOdds] = useState(2);
  const now = useNow(250);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const seat = q.get("seat");
    setToken(loadToken(code, seat));
    setBoot({ seat, depositReturn: q.get("deposit") === "1" });
  }, [code]);

  const { data: l, error, refresh, lastOk } = usePoll(
    boot ? () => api<LobbyData>(`/api/lobby/${code}`, { token }) : null,
    1500,
  );

  const say = (text: string, kind: "ok" | "err" = "ok") => setMsg((m) => ({ text, kind, n: (m?.n ?? 0) + 1 }));
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), msg.kind === "err" ? 6000 : 4000);
    return () => clearTimeout(t);
  }, [msg]);

  async function act<T>(fn: () => Promise<T>, okText?: (r: T) => string) {
    setBusy(true);
    try {
      const r = await fn();
      if (okText) say(okText(r));
      else setMsg(null);
      await refresh();
      return r;
    } catch (e) {
      say((e as Error).message, "err");
      return null;
    } finally {
      setBusy(false);
    }
  }

  // Coming back from the payment page (?deposit=1): ask the server to check every few seconds until it lands.
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  });
  const shouldSync = !!(boot?.depositReturn && l?.me && l.money.mode === "coinbase");
  useEffect(() => {
    if (!shouldSync) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search.replace(/[?&]deposit=1/, "").replace(/^&/, "?"));
    let alive = true;
    (async () => {
      setSyncing(true);
      for (let i = 0; i < 60 && alive; i++) {
        try {
          const r = await api<{ credited: number; pending: number }>(`/api/lobby/${code}/deposit/sync`, { body: {}, token: tokenRef.current });
          if (r.credited > 0) {
            say(`Money added: ${usd(r.credited)}`);
            await refresh();
            break;
          }
        } catch (e) {
          say((e as Error).message, "err");
        }
        await new Promise((res) => setTimeout(res, 3000));
      }
      if (alive) setSyncing(false);
    })();
    return () => {
      alive = false;
    };
  }, [shouldSync, code, refresh]);

  const playerIds = l?.players.map((p) => p.id) ?? [];
  const freshPlayers = useNewIds(playerIds);

  // ---------------- loading / errors
  if (!boot || (!l && !error)) {
    return (
      <>
        <PlainBar />
        <main className="phone" aria-busy="true">
          <div className="empty"><p>Loading lobby {code}…</p></div>
        </main>
      </>
    );
  }
  if (!l) {
    const notFound = error instanceof HttpError && error.status === 404;
    return (
      <>
        <PlainBar />
        <main className="phone">
          <div className="empty">
            <h1 style={{ fontSize: 20 }}>{notFound ? `No lobby called ${code}` : "Can’t reach Huddle"}</h1>
            <p>{notFound ? "Tap your phone on the box again, or check the 4-letter code on its screen." : `${error?.message ?? "Network error"}. Check your connection; this page retries by itself.`}</p>
          </div>
          <a className="btn btn-line btn-block" href="/">Enter a different code</a>
        </main>
      </>
    );
  }

  const me = l.me;
  const m = l.market;
  const serverNow = now + (l.now - lastOk);
  const lockIn = m ? Math.max(0, Math.ceil((m.lockAt - serverNow) / 1000)) : 0;
  const open = l.phase === "open" && !!m;
  const caption = latestCaption(l);
  const score = gameScore(l);

  // ---------------- not joined yet
  if (!me) {
    return (
      <>
        <PlainBar code={l.code} />
        <main className="phone join" id="main">
          <div className="hero">
            <span className="chip green">
              <span className="dot green" /> {l.players.length ? `${l.players.length} in this huddle` : "Be the first to join"}
            </span>
            <h1>{l.game?.title ?? "Huddle"}</h1>
            <p>{l.game?.subtitle ? `${l.game.subtitle}. ` : ""}Call each play with your friends. A winning call pays $1 a share.</p>
          </div>
          {l.phase === "ended" ? (
            <div className="empty"><h2>This session has ended</h2><p>Pick a new game on the box to start another.</p></div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                act(async () => {
                  const r = await api<{ token: string }>(`/api/lobby/${code}/join`, { body: { name } });
                  saveToken(code, boot.seat, r.token);
                  setToken(r.token);
                  return r;
                });
              }}
            >
              <label className="field" htmlFor="name">
                Your name
                <input
                  id="name"
                  name="nickname"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={14}
                  placeholder="e.g. Maya…"
                  autoComplete="nickname"
                  spellCheck={false}
                  enterKeyHint="go"
                />
              </label>
              <button className="btn-green btn-block" disabled={busy || !name.trim()}>
                {busy ? "Joining…" : "Join the huddle"}
              </button>
              {msg?.kind === "err" && <p className="err-text" role="alert">{msg.text}</p>}
            </form>
          )}
          {l.players.length > 0 && (
            <div>
              <div className="section-h"><h2>Already here</h2></div>
              <div className="inline-people">
                {l.players.map((p) => <span key={p.id} className="chip">{p.name}</span>)}
              </div>
            </div>
          )}
        </main>
      </>
    );
  }

  // ---------------- joined
  const pos = me.position;
  const mode = marketMode(l);
  const pool = marketPool(l);
  const offers = marketOffers(l);
  const model = marketModel(l);
  const gemini = marketGemini(l);
  const card = scorecard(l);
  const preview = m && open ? {
    yes: sharesForSpend("yes", amount / 100, m.yesShares, m.noShares, m.b),
    no: sharesForSpend("no", amount / 100, m.yesShares, m.noShares, m.b),
  } : null;
  const coinbase = l.money.mode === "coinbase";
  // Optional Solana Pay mode from the backend: deposits come back as a `solana:` link shown as a QR code,
  // cash-out goes to a pasted address. Nothing here renders unless the server says money.mode === "solana".
  const solana = (l.money.mode as string) === "solana";
  const realMoney = l.money.realMoney;
  const payoutKind: "evm" | "solana" | null = solana ? "solana" : l.money.payouts === "onchain" ? "evm" : null;
  const addressOk =
    payoutKind === "solana" ? SOLANA_ADDRESS.test(address) : payoutKind === "evm" ? /^0x[0-9a-fA-F]{40}$/.test(address) : true;
  const showDock = open && mode !== "h2h";
  const live = !!m && (l.phase === "open" || l.phase === "locked" || l.phase === "result");
  const board = [...l.players].sort((a, b) => b.balance - a.balance);

  const deposit = (c: number) =>
    act(async () => {
      const r = await api<{ url?: string; credited?: number }>(`/api/lobby/${code}/deposit`, { body: { cents: c }, token });
      if (r.url && r.url.startsWith("solana:")) setPayLink({ url: r.url, cents: c });
      else if (r.url) window.location.href = r.url;
      return r;
    }, (r) => (r.url?.startsWith("solana:") ? "Scan or open the payment link" : r.url ? "Opening checkout…" : `Added ${usd(r.credited ?? c)}`));

  const buy = (side: Side) =>
    act(
      () => api<{ shares: number }>(`/api/lobby/${code}/buy`, { body: { side, cents: amount }, token }),
      (r) => (mode === "pool" ? `You put ${usd(amount)} on ${SIDE[side]}` : `Bought ${r.shares.toFixed(2)} ${SIDE[side]} for ${usd(amount)}`),
    );

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="appbar">
        <div className="appbar-in">
          <Wordmark size={22} />
          <span className="chip code" translate="no" aria-label={`Lobby ${l.code}`}>{l.code}</span>
          <div className="bal">
            <div className="k">Balance</div>
            <div className="v tnum"><Roll text={usd(me.balance)} tint={false} /></div>
          </div>
        </div>
      </header>

      <main className={`phone ${showDock ? "has-dock" : ""}`} id="main">
        {caption && (
          <p className="caption" aria-live="polite">
            <Icon name="sound" size={16} />
            <span key={caption.id} className="txt fresh">{caption.text}</span>
          </p>
        )}
        {score && <Scorebug s={score} />}

        {/* ---------------- current question */}
        {live && m ? (
          <section className="panel" aria-labelledby="question">
            <div className="meta">
              <span>{l.game?.title} · Question {m.qIndex + 1} of {l.questionCount}</span>
              {l.phase === "open" && (
                <span className={`status ${lockIn <= 10 ? "soon" : "open"}`} aria-live="off">
                  <Icon name="clock" size={14} /> <span className="tnum">Locks in {fmtClock(lockIn)}</span>
                </span>
              )}
              {l.phase === "locked" && <span className="status closed"><Icon name="lock" size={14} /> Closed</span>}
              {l.phase === "result" && m.outcome && (
                <span className="status closed"><Icon name="check" size={14} /> {SIDE[m.outcome]} won</span>
              )}
            </div>
            <h1 className="q" id="question">{m.text}</h1>

            <div className="big-chance" aria-live="polite">
              <span className="n"><Roll text={`${m.yesCents}%`} value={m.yesCents} arrow label={`${m.yesCents} percent chance of yes`} /></span>
              <span className="l">chance of Yes</span>
            </div>
            <div className="chart"><Spark points={m.history} height={88} /></div>

            {l.phase === "result" && m.outcome ? (
              <Outcome outcome={m.outcome} />
            ) : (
              <div className="quotes">
                {l.phase === "locked" && (
                  <p className="locked-note"><Icon name="lock" size={16} /> Trading closed. Watch the play.</p>
                )}
                <Quote side="yes" cents={m.yesCents} />
                <Quote side="no" cents={m.noCents} />
              </div>
            )}

            {mode === "pool" && pool && <PoolBar pool={pool} />}
            {(model !== null || gemini) && <Compare room={m.yesCents} model={model} gemini={gemini} />}

            <div className="stats">
              <span><b className="tnum">{usd(m.volume)}</b> traded</span>
              <span>{mode === "pool" ? "Winners split the pot" : "A winning share pays $1"}</span>
            </div>

            {pos && (pos.yes > 0 || pos.no > 0) && l.phase !== "result" && (
              <div className="position">
                You hold {pos.yes > 0 && <b className="tnum">{pos.yes.toFixed(2)} Yes</b>}
                {pos.yes > 0 && pos.no > 0 && " and "}
                {pos.no > 0 && <b className="tnum">{pos.no.toFixed(2)} No</b>} for {usd(pos.spent)}.
                {mode !== "pool" && (
                  <> Pays {pos.yes > 0 && <b className="tnum">{usd(Math.floor(pos.yes * 100))} if Yes</b>}{pos.yes > 0 && pos.no > 0 && ", "}{pos.no > 0 && <b className="tnum">{usd(Math.floor(pos.no * 100))} if No</b>}.</>
                )}
              </div>
            )}

            {l.phase === "result" && m.outcome && (
              <div className={`won ${me.payout ? "" : "zero"}`} aria-live="polite">
                <span className="k">{me.payout ? "You won" : pos ? "Not this time" : "You sat this one out"}</span>
                <span className="v">{me.payout ? <CountUp cents={me.payout} format={usd} /> : usd(0)}</span>
              </div>
            )}

            {m.trades.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div className="section-h"><h2>Latest trades</h2></div>
                <ul className="rows compact">
                  {m.trades.slice(0, 4).map((t) => (
                    <li key={`${t.at}-${t.name}`}>
                      <span className="grow">{t.name}</span>
                      <span className={`side-tag ${t.side}`}>{SIDE[t.side]}</span>
                      <span className="amt">{usd(t.cents)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        ) : l.phase === "ended" ? (
          <section className="empty" aria-labelledby="done">
            <h2 id="done">Session over. Thanks for playing.</h2>
            <p>You finished with <b className="tnum">{usd(me.balance + me.withdrawn)}</b>{me.balance > 0 ? ". Cash out below." : "."}</p>
          </section>
        ) : (
          <section className="empty" aria-labelledby="wait">
            <h2 id="wait">You’re in, {me.name}.</h2>
            <p>The host starts question {l.qIndex + 1} from the box. {me.balance > 0 ? "You’re ready to trade." : "Add money now so you’re ready."}</p>
            {l.nextQuestion && <p className="ink2" style={{ marginTop: 10 }}><b>First up:</b> {l.nextQuestion}</p>}
          </section>
        )}

        {/* ---------------- head-to-head offers */}
        {mode === "h2h" && open && (
          <OfferBook
            offers={offers}
            meName={me.name}
            amount={amount}
            options={l.buy.options}
            setAmount={setAmount}
            side={offerSide}
            setSide={setOfferSide}
            odds={offerOdds}
            setOdds={setOfferOdds}
            busy={busy}
            balance={me.balance}
            onPost={() => act(() => api(`/api/lobby/${code}/offer`, { body: { side: offerSide, cents: amount, odds: offerOdds }, token }), () => `Offer posted: ${usd(amount)} on ${SIDE[offerSide]} at ${offerOdds}x`)}
            onTake={(o) => act(() => api(`/api/lobby/${code}/take`, { body: { offerId: o.id, cents: Math.min(amount, o.cents) }, token }), () => `You took ${o.by}’s offer`)}
          />
        )}

        {card && l.phase === "ended" && <ScorecardBlock s={card} />}

        {/* ---------------- money */}
        <section className="section" aria-labelledby="money">
          <div className="section-h">
            <h2 id="money">Money</h2>
            <span className="mute tnum">{usd(me.balance)} available</span>
          </div>
          {l.phase !== "ended" && (
            <>
              <div className="money-row">
                {l.money.depositOptions.map((c) => (
                  <button key={c} className="btn-line" disabled={busy || syncing} onClick={() => deposit(c)}>
                    <Icon name="plus" size={16} /> Add {usd(c)}
                  </button>
                ))}
              </div>
              {solana && payLink && (
                <div className="paylink" role="group" aria-label={`Pay ${usd(payLink.cents)}`}>
                  <span className="qr"><Qr text={payLink.url} size={132} /></span>
                  <div className="paylink-body">
                    <b>Add {usd(payLink.cents)}</b>
                    <p className="hint" style={{ marginTop: 2 }}>Scan with your phone’s wallet app, or open it here.</p>
                    <a className="btn btn-ink" href={payLink.url}>Open in wallet</a>
                    <button className="btn-text" onClick={() => setPayLink(null)}>Done</button>
                  </div>
                </div>
              )}
              {(coinbase || solana) && (
                <button
                  className="btn-text btn-block"
                  style={{ marginTop: 6 }}
                  disabled={busy || syncing}
                  onClick={() => act(
                    () => api<{ credited: number; pending: number }>(`/api/lobby/${code}/deposit/sync`, { body: {}, token }),
                    (r) => (r.credited ? `Money added: ${usd(r.credited)}` : r.pending > 0 ? "Still processing your payment…" : "Nothing new yet"),
                  )}
                >
                  {syncing ? "Waiting for your payment…" : "Check for my payment"}
                </button>
              )}
              <p className="hint">
                {!coinbase && !solana && "Demo money for the party. Nothing real is charged."}
                {solana && "Pay from any wallet app; your balance shows in US dollars."}
                {coinbase && !realMoney && "Test mode: no real money moves."}
                {coinbase && realMoney && "You pay by card or bank; your balance is in US dollars."}
              </p>
            </>
          )}
          {(me.balance > 0 || l.phase === "ended") && <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            {payoutKind && (
              <label className="field" htmlFor="payout">
                {payoutKind === "solana" ? "Your Solana address" : "Payout address"}
                <input
                  id="payout"
                  name="payout-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value.trim())}
                  placeholder={payoutKind === "solana" ? "Paste your address…" : "0x…"}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={address.length > 0 && !addressOk}
                />
                {address.length > 0 && !addressOk && <span className="err-text">That doesn’t look like a {payoutKind === "solana" ? "Solana" : "Base"} address. Paste it again.</span>}
              </label>
            )}
            <button
              className={l.phase === "ended" ? "btn-green btn-block" : "btn-text btn-block"}
              disabled={busy || me.balance <= 0 || !addressOk}
              onClick={() => {
                if (!window.confirm(`Cash out ${usd(me.balance)}${payoutKind ? ` to ${address}` : ""}?`)) return;
                act(
                  () => api<{ cents: number; explorer?: string }>(`/api/lobby/${code}/cashout`, { body: { address }, token }),
                  (r) => `Cashed out ${usd(r.cents)}`,
                );
              }}
            >
              Cash out {usd(me.balance)}
            </button>
          </div>}
        </section>

        {/* ---------------- leaderboard */}
        <section className="section" aria-labelledby="board">
          <div className="section-h"><h2 id="board">Leaderboard</h2><span className="mute">{l.players.length} playing</span></div>
          <ol className="rows">
            {board.map((p, i) => (
              <li key={p.id} className={`${p.id === me.id ? "me" : ""} ${freshPlayers.has(p.id) ? "new" : ""}`}>
                <span className="rank">{i + 1}</span>
                <span className="grow">{p.name}{p.id === me.id ? " (you)" : ""}</span>
                <span className="amt">{usd(p.balance)}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* ---------------- results so far */}
        {l.results.length > 0 && (
          <section className="section" aria-labelledby="results">
            <div className="section-h"><h2 id="results">Results</h2></div>
            <ul className="rows">
              {l.results.map((r, i) => (
                <li key={i}>
                  <span className="grow" style={{ whiteSpace: "normal" }}>{r.text}</span>
                  <span className={`side-tag ${r.outcome}`}><Icon name="check" size={12} />&nbsp;{SIDE[r.outcome]}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="section" aria-labelledby="activity">
          <div className="section-h"><h2 id="activity">Activity</h2></div>
          <ul className="rows compact">
            {[...l.events].reverse().slice(0, 6).map((e) => (
              <li key={e.id}><span className="grow ink2" style={{ whiteSpace: "normal" }}>{e.text}</span></li>
            ))}
          </ul>
        </section>
      </main>

      {/* ---------------- trade dock (thumb reach) */}
      {showDock && m && (
        <div className="dock" role="region" aria-label="Trade">
          <div className="dock-in">
            <div className="seg" role="group" aria-label="Amount to spend">
              {l.buy.options.map((c) => (
                <button key={c} aria-pressed={amount === c} onClick={() => setAmount(c)}>{usd(c)}</button>
              ))}
            </div>
            <div className="buy">
              {(["yes", "no"] as const).map((side) => (
                <button key={side} className={side === "yes" ? "btn-green" : "btn-ink"} disabled={busy || me.balance < amount} onClick={() => buy(side)}>
                  <span className="t">
                    {side === "yes" ? <Icon name="check" size={16} /> : <Icon name="x" size={16} />}
                    Buy {SIDE[side]} · <span className="tnum">{side === "yes" ? m.yesCents : m.noCents}¢</span>
                  </span>
                  <span className="s">
                    {mode === "pool" ? "Winners split the pot" : preview ? `${usd(amount)} pays ${usd(Math.floor(preview[side] * 100))}` : ""}
                  </span>
                </button>
              ))}
            </div>
            {me.balance < amount && (
              <div className="dock-row">
                <span>Balance {usd(me.balance)}</span>
                <button className="btn-text" disabled={busy || syncing} onClick={() => deposit(l.money.depositOptions[0])}>
                  <Icon name="plus" size={14} /> Add {usd(l.money.depositOptions[0])}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div aria-live="polite" role="status">
        {msg && (
          <div key={msg.n} className={`toast ${msg.kind === "err" ? "err" : ""} ${showDock ? "above-dock" : ""}`}>
            <Icon name={msg.kind === "err" ? "x" : "check"} size={16} />
            <span>{msg.text}</span>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- pieces

function PlainBar({ code }: { code?: string }) {
  return (
    <header className="appbar">
      <div className="appbar-in">
        <a href="/" aria-label="Huddle home" style={{ textDecoration: "none" }}><Wordmark size={22} /></a>
        {code && <span className="chip code" translate="no">{code}</span>}
      </div>
    </header>
  );
}

function Quote({ side, cents }: { side: Side; cents: number }) {
  return (
    <div className={`quote ${side}`}>
      <span className="side"><span className="sw" aria-hidden="true" />{SIDE[side]}</span>
      <span className="pays">pays $1</span>
      <span className="px"><Roll text={String(cents)} value={cents} label={`${SIDE[side]} ${cents} cents`} /><span className="c">¢</span></span>
    </div>
  );
}

function Outcome({ outcome }: { outcome: Side }) {
  return (
    <div className="outcome" aria-label={`Resolved ${SIDE[outcome]}`}>
      {(["yes", "no"] as const).map((side) => {
        const win = side === outcome;
        return (
          <div key={side} className={`orow ${side} ${win ? "win" : "lose"}`}>
            {win && <span className="fill" aria-hidden="true" />}
            <span className="lbl">{win ? <Icon name="check" size={16} /> : <Icon name="x" size={16} />} {SIDE[side]}</span>
            <span className="tag">{win ? "Pays $1 a share" : "Pays $0"}</span>
          </div>
        );
      })}
    </div>
  );
}

function PoolBar({ pool }: { pool: { yesCents: number; noCents: number } }) {
  const total = pool.yesCents + pool.noCents;
  const y = total ? (pool.yesCents / total) * 100 : 50;
  return (
    <div className="pool">
      <div className="bar" aria-hidden="true">
        <span className="y" style={{ width: `${y}%` }} />
        <span className="n" style={{ width: `${100 - y}%` }} />
      </div>
      <div className="legend">
        <span className="tnum">Yes pool {usd(pool.yesCents)}</span>
        <span className="tnum">No pool {usd(pool.noCents)}</span>
      </div>
    </div>
  );
}

function Compare({ room, model, gemini }: { room: number; model: number | null; gemini: { prob: number; label: string; url?: string } | null }) {
  return (
    <div className="compare" aria-label="Room, model and Gemini prices for Yes">
      <div className="me"><div className="k">Room</div><div className="v tnum">{room}¢</div></div>
      <div><div className="k">Model</div><div className="v tnum">{model !== null ? `${probCents(model)}¢` : "–"}</div></div>
      <div>
        <div className="k">{gemini?.url ? <a href={gemini.url} target="_blank" rel="noreferrer">Gemini</a> : "Gemini"}</div>
        <div className="v tnum">{gemini ? `${probCents(gemini.prob)}¢` : "–"}</div>
      </div>
    </div>
  );
}

function Scorebug({ s }: { s: { home: string; away: string; homeScore: number; awayScore: number; clock: string } }) {
  return (
    <div className="scorebug" aria-label={`${s.home} ${s.homeScore}, ${s.away} ${s.awayScore}${s.clock ? `, ${s.clock}` : ""}`}>
      <span>{s.home}</span>
      <span className="sc">{s.homeScore} – {s.awayScore}</span>
      <span>{s.away}</span>
      {s.clock && <span className="clk tnum">{s.clock}</span>}
    </div>
  );
}

function ScorecardBlock({ s }: { s: { room: number | null; model: number | null; gemini: number | null; n: number; verdict: string } }) {
  const f = (v: number | null) => (v === null ? "–" : v.toFixed(3));
  return (
    <section className="section" aria-labelledby="scorecard">
      <div className="section-h"><h2 id="scorecard">Who called it best</h2><span className="mute">{s.n} {s.n === 1 ? "question" : "questions"} · lower is better</span></div>
      <div className="compare" style={{ marginTop: 0 }}>
        <div className="me"><div className="k">Room</div><div className="v tnum">{f(s.room)}</div></div>
        <div><div className="k">Model</div><div className="v tnum">{f(s.model)}</div></div>
        <div><div className="k">Gemini</div><div className="v tnum">{f(s.gemini)}</div></div>
      </div>
      {s.verdict && <p className="hint">{s.verdict}</p>}
    </section>
  );
}

function OfferBook(props: {
  offers: Offer[];
  meName: string;
  amount: number;
  options: number[];
  setAmount: (c: number) => void;
  side: Side;
  setSide: (s: Side) => void;
  odds: number;
  setOdds: (o: number) => void;
  busy: boolean;
  balance: number;
  onPost: () => void;
  onTake: (o: Offer) => void;
}) {
  const { offers, meName, amount, options, setAmount, side, setSide, odds, setOdds, busy, balance, onPost, onTake } = props;
  const openOffers = offers.filter((o) => o.open);
  return (
    <section className="section" aria-labelledby="h2h">
      <div className="section-h"><h2 id="h2h">Head to head</h2><span className="mute">Back a side, a friend takes the other</span></div>
      {openOffers.length > 0 ? (
        <div>
          {openOffers.map((o) => (
            <div key={o.id} className="offer">
              <div>
                <div className="who">{o.by === meName ? "Your offer" : o.by}</div>
                <div className="terms tnum">{usd(o.cents)} on {SIDE[o.side]} at {o.odds}x</div>
              </div>
              {o.by !== meName && (
                <button className={o.side === "yes" ? "btn-ink" : "btn-green"} disabled={busy || balance <= 0} onClick={() => onTake(o)}>
                  Take {SIDE[o.side === "yes" ? "no" : "yes"]}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="hint" style={{ marginTop: 0 }}>No open offers yet. Post the first one.</p>
      )}
      <div className="offer-form" style={{ marginTop: 14 }}>
        <div className="seg" role="group" aria-label="Side">
          {(["yes", "no"] as const).map((s) => <button key={s} aria-pressed={side === s} onClick={() => setSide(s)}>{SIDE[s]}</button>)}
        </div>
        <div className="seg" role="group" aria-label="Amount">
          {options.map((c) => <button key={c} aria-pressed={amount === c} onClick={() => setAmount(c)}>{usd(c)}</button>)}
        </div>
        <div className="seg" role="group" aria-label="Odds">
          {ODDS.map((o) => <button key={o} aria-pressed={odds === o} onClick={() => setOdds(o)}>{o}x</button>)}
        </div>
        <button className="btn-green btn-block" disabled={busy || balance < amount} onClick={onPost}>
          Offer {usd(amount)} on {SIDE[side]} at {odds}x
        </button>
      </div>
    </section>
  );
}
