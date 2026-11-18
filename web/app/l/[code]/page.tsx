"use client";
// Phone page: /l/ABCD  (add ?seat=2 to play as a second player from the same browser while testing)
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Spark } from "@/components/Spark";
import { HttpError, api, fmtClock, loadToken, saveToken, useNow, usePoll, usd, type LobbyData } from "@/components/client";
import { sharesForSpend } from "@/lib/lmsr";

const PHASE_TEXT: Record<string, string> = {
  lobby: "Waiting for the host to start",
  open: "Trading is open",
  locked: "Trading closed. Watch the play!",
  result: "Result is in",
  ended: "Session over",
};

export default function PhonePage() {
  const params = useParams<{ code: string }>();
  const code = String(params.code || "").toUpperCase();
  const [boot, setBoot] = useState<{ seat: string | null; depositReturn: boolean } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState(100);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [syncing, setSyncing] = useState(false);
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

  const say = (text: string, kind: "ok" | "err" = "ok") => setMsg({ text, kind });
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

  // Coming back from Coinbase (?deposit=1): ask the server to check Coinbase every few seconds until it lands.
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
            say(`Deposit received: ${usd(r.credited)}`);
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

  if (!boot || (!l && !error)) {
    return <main className="wrap"><div className="card">Loading…</div></main>;
  }
  if (!l) {
    const notFound = error instanceof HttpError && error.status === 404;
    return (
      <main className="wrap">
        <div className="card stack">
          <h1>{notFound ? "Lobby not found" : "Can't reach the server"}</h1>
          <div className="dim">{notFound ? `There is no lobby ${code}. Tap the kiosk again or check the code.` : error?.message}</div>
          <a className="btn" href="/">Home</a>
        </div>
      </main>
    );
  }

  const me = l.me;
  const m = l.market;
  const serverNow = now + (l.now - lastOk);
  const lockIn = m ? Math.max(0, Math.ceil((m.lockAt - serverNow) / 1000)) : 0;
  const open = l.phase === "open" && !!m;

  // ---------------- not joined yet
  if (!me) {
    return (
      <main className="wrap">
        <div className="card stack">
          <div className="dim">Lobby {l.code}</div>
          <h1>{l.game?.title ?? "Live Lines"}</h1>
          <div className="dim">{l.game?.subtitle}</div>
        </div>
        {l.phase === "ended" ? (
          <div className="card">This session has ended.</div>
        ) : (
          <form
            className="card stack"
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
            <h2>What should we call you?</h2>
            <div className="row">
              <input className="grow" value={name} onChange={(e) => setName(e.target.value)} maxLength={14} placeholder="Your name" aria-label="Your name" autoFocus />
              <button className="btn-primary" disabled={busy || !name.trim()}>Join</button>
            </div>
            <div className="dim small">{l.players.length} in the lobby{l.players.length ? `: ${l.players.map((p) => p.name).join(", ")}` : ""}</div>
            {msg && <div className={msg.kind}>{msg.text}</div>}
          </form>
        )}
      </main>
    );
  }

  // ---------------- joined
  const pos = me.position;
  const preview = m && open ? {
    yes: sharesForSpend("yes", amount / 100, m.yesShares, m.noShares, m.b),
    no: sharesForSpend("no", amount / 100, m.yesShares, m.noShares, m.b),
  } : null;
  const coinbase = l.money.mode === "coinbase";
  const realMoney = l.money.realMoney;

  return (
    <main className="wrap">
      <div className="card">
        <div className="row spread">
          <div className="grow">
            <div className="dim small">Lobby {l.code} · {me.name}</div>
            <h1>{l.game?.title}</h1>
            <div className="dim">{PHASE_TEXT[l.phase]}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="dim small">Balance</div>
            <div className="big">{usd(me.balance)}</div>
          </div>
        </div>
      </div>

      {msg && <div className={`banner ${msg.kind === "err" ? "lose" : "info"}`}>{msg.text}</div>}

      {/* ---------------- current question */}
      {m && l.phase !== "lobby" && l.phase !== "ended" ? (
        <div className="card">
          <div className="row spread">
            <span className="dim small">Question {m.qIndex + 1} of {l.questionCount}</span>
            {l.phase === "open" && <span className="pill live">Locks in {fmtClock(lockIn)}</span>}
            {l.phase === "locked" && <span className="pill closed">Closed</span>}
            {l.phase === "result" && m.outcome && <span className={`pill ${m.outcome}`}>{m.outcome.toUpperCase()} won</span>}
          </div>
          <h2 style={{ fontSize: 22, margin: "10px 0 0" }}>{m.text}</h2>
          <div className="prices">
            <div className="price yes">
              <div className="lbl">YES {m.lastMove === 1 && <span className="arrow-up">▲</span>}</div>
              <div className="num">{m.yesCents}¢</div>
            </div>
            <div className="price no">
              <div className="lbl">NO {m.lastMove === -1 && <span className="arrow-up">▲</span>}</div>
              <div className="num">{m.noCents}¢</div>
            </div>
          </div>
          <Spark points={m.history} height={70} />
          <div className="dim small" style={{ marginTop: 6 }}>{usd(m.volume)} traded · a winning share pays $1.00</div>

          {open && (
            <>
              <div className="row" style={{ marginTop: 14 }}>
                <span className="dim small">Spend</span>
                {l.buy.options.map((c) => (
                  <button key={c} className={`chip ${amount === c ? "sel" : ""}`} onClick={() => setAmount(c)}>{usd(c)}</button>
                ))}
              </div>
              <div className="grid2" style={{ marginTop: 10 }}>
                {(["yes", "no"] as const).map((side) => (
                  <button
                    key={side}
                    className={side === "yes" ? "btn-yes" : "btn-no"}
                    style={{ flexDirection: "column", minHeight: 72 }}
                    disabled={busy || me.balance < amount}
                    onClick={() => act(
                      () => api<{ shares: number }>(`/api/lobby/${code}/buy`, { body: { side, cents: amount }, token }),
                      (r) => `Bought ${r.shares.toFixed(2)} ${side.toUpperCase()} for ${usd(amount)}`,
                    )}
                  >
                    <span style={{ fontSize: 20 }}>Buy {side.toUpperCase()}</span>
                    {preview && (
                      <span className="small" style={{ fontWeight: 500 }}>
                        {preview[side].toFixed(2)} shares · pays {usd(Math.floor(preview[side] * 100))}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {me.balance < amount && <div className="dim small" style={{ marginTop: 8 }}>Add money below to trade.</div>}
            </>
          )}

          {pos && (pos.yes > 0 || pos.no > 0) && (
            <div className="banner info" style={{ marginTop: 12, marginBottom: 0, fontWeight: 500 }}>
              You hold {pos.yes > 0 && <b>{pos.yes.toFixed(2)} YES</b>}
              {pos.yes > 0 && pos.no > 0 && " and "}
              {pos.no > 0 && <b>{pos.no.toFixed(2)} NO</b>} (spent {usd(pos.spent)}).
              {l.phase !== "result" && <> Pays {pos.yes > 0 && `${usd(Math.floor(pos.yes * 100))} if YES`}{pos.yes > 0 && pos.no > 0 && ", "}{pos.no > 0 && `${usd(Math.floor(pos.no * 100))} if NO`}.</>}
            </div>
          )}
          {l.phase === "result" && m.outcome && (
            <div className={`banner ${me.payout ? "win" : "lose"}`} style={{ marginTop: 12, marginBottom: 0 }}>
              {me.payout ? `${m.outcome.toUpperCase()} won! You got ${usd(me.payout)}.` : `${m.outcome.toUpperCase()} won.${pos ? " Better luck next play." : ""}`}
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          {l.phase === "ended" ? (
            <h2>Thanks for playing! Cash out below.</h2>
          ) : (
            <>
              <h2>Waiting for the host</h2>
              <div className="dim">{l.nextQuestion ? `First question: ${l.nextQuestion}` : "The host starts the market on the kiosk."}</div>
              <div className="dim small" style={{ marginTop: 6 }}>Add money now so you are ready to trade.</div>
            </>
          )}
        </div>
      )}

      {/* ---------------- deposit */}
      {l.phase !== "ended" && (
        <div className="card">
          <h2>Add money</h2>
          <div className="row">
            {l.money.depositOptions.map((c) => (
              <button
                key={c}
                className="btn-primary"
                disabled={busy || syncing}
                onClick={() => act(async () => {
                  const r = await api<{ url?: string; credited?: number }>(`/api/lobby/${code}/deposit`, { body: { cents: c }, token });
                  if (r.url) window.location.href = r.url;
                  return r;
                }, (r) => (r.url ? "Opening Coinbase…" : `Added ${usd(r.credited ?? c)} test money`))}
              >
                {coinbase ? `Deposit ${usd(c)}` : `Add ${usd(c)} test money`}
              </button>
            ))}
          </div>
          {coinbase && (
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="chip"
                disabled={busy || syncing}
                onClick={() => act(
                  () => api<{ credited: number; pending: number }>(`/api/lobby/${code}/deposit/sync`, { body: {}, token }),
                  (r) => (r.credited ? `Deposit received: ${usd(r.credited)}` : r.pending > 0 ? "Coinbase is still processing your deposit…" : "No new deposits yet"),
                )}
              >
                {syncing ? "Waiting for Coinbase…" : "Check for my deposit"}
              </button>
            </div>
          )}
          <div className="dim small" style={{ marginTop: 8 }}>
            {!coinbase && "Demo mode: this is pretend money for the demo."}
            {coinbase && !realMoney && "Coinbase sandbox: no real money moves."}
            {coinbase && realMoney && "Real money: you pay with Coinbase and your deposit arrives as USDC on Base."}
          </div>
        </div>
      )}

      {/* ---------------- players */}
      <div className="card">
        <h2>Players</h2>
        <ul className="list">
          {l.players.map((p) => (
            <li key={p.id}>
              <span>{p.name}{p.id === me.id ? " (you)" : ""}</span>
              <span className="mono">{usd(p.balance)}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* ---------------- results so far */}
      {l.results.length > 0 && (
        <div className="card">
          <h2>Results</h2>
          <ul className="list">
            {l.results.map((r, i) => (
              <li key={i}>
                <span className="grow">{r.text}</span>
                <span className={`pill ${r.outcome}`}>{r.outcome.toUpperCase()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---------------- cash out */}
      <div className="card stack">
        <h2>Cash out</h2>
        {l.money.payouts === "onchain" ? (
          <>
            <div className="dim small">Sends your whole balance as USDC on Base to your wallet (for example your Coinbase USDC address on Base).</div>
            <input value={address} onChange={(e) => setAddress(e.target.value.trim())} placeholder="0x… address on Base" aria-label="Wallet address on Base" />
          </>
        ) : (
          <div className="dim small">{coinbase ? "Sandbox: cashing out sets your balance to zero, nothing is sent." : "Demo: cashing out just sets your balance to zero."}</div>
        )}
        <button
          disabled={busy || me.balance <= 0 || (l.money.payouts === "onchain" && !/^0x[0-9a-fA-F]{40}$/.test(address))}
          onClick={() => {
            if (!window.confirm(`Cash out ${usd(me.balance)}${l.money.payouts === "onchain" ? ` to ${address}` : ""}?`)) return;
            act(
              () => api<{ cents: number; explorer?: string }>(`/api/lobby/${code}/cashout`, { body: { address }, token }),
              (r) => `Cashed out ${usd(r.cents)}${r.explorer ? `. Transaction: ${r.explorer}` : ""}`,
            );
          }}
        >
          Cash out {usd(me.balance)}
        </button>
      </div>

      <div className="card">
        <h2>Activity</h2>
        <ul className="list small">
          {[...l.events].reverse().slice(0, 8).map((e) => (
            <li key={e.id}><span>{e.text}</span></li>
          ))}
        </ul>
      </div>
    </main>
  );
}
