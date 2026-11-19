"use client";
// Phone page: /l/ABCD (add ?seat=2 to play as a second player from the same browser while testing).
// Join -> buy in -> the live market card (tiles, stake tray, offers) with the board and results one
// tab away -> the end of the game and cash out. Kickoff design in green + ivory (DESIGN.md section 9).
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import "@/components/phone/phone.css";
import { useTrail } from "@/components/phone/Trail";
import { HttpError, api, loadToken, saveToken, useNow, usePoll, type LobbyData } from "@/components/client";
import { Empty, InlineError, Loading } from "@/components/phone/ui";
import { Icon, Kinetic, Mark, Wordmark, useCoins, usd } from "@/components/huddle";
import { MarketCard, ParkedCard, mkKey, type Actions } from "@/components/phone/MarketCard";
import {
  Backdrop, BuyInScreen, CashOut, Dock, EndOfGame, Header, JoinScreen, Leaderboard, MoneySheet, PayLink, ResultsTab, type Tab,
} from "@/components/phone/Screens";
import { SIDE, type Side } from "@/components/phone/derive";

type Toast = { text: string; kind: "ok" | "err"; n: number };

export default function PhonePage() {
  const params = useParams<{ code: string }>();
  // Codes are letters; anything else ("%3Cscript%3E") is shown decoded, not URL-encoded.
  const code = (() => {
    try {
      return decodeURIComponent(String(params.code || "")).toUpperCase().slice(0, 12);
    } catch {
      return String(params.code || "").toUpperCase().slice(0, 12);
    }
  })();
  const [boot, setBoot] = useState<{ seat: string | null; depositReturn: boolean } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [buyError, setBuyError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("play");
  const [moneyOpen, setMoneyOpen] = useState(false);
  const [buyInDone, setBuyInDone] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [payLink, setPayLink] = useState<{ url: string; cents: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [boxBusy, setBoxBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [cashed, setCashed] = useState<{ cents: number; explorer?: string } | null>(null);
  const balanceCoins = useCoins();
  const now = useNow(250);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const seat = q.get("seat");
    setToken(loadToken(code, seat));
    setBoot({ seat, depositReturn: q.get("deposit") === "1" });
    // "Just watch for now" is remembered for this lobby and seat, so a reload does not ask again.
    try {
      if (localStorage.getItem(`huddle:skip:${code}:${seat ?? ""}`) === "1") setSkipped(true);
    } catch {
      /* private mode: ask again after a reload */
    }
  }, [code]);

  const { data: l, error, refresh, lastOk } = usePoll(boot ? () => api<LobbyData>(`/api/lobby/${code}`, { token }) : null, 1000);
  const trail = useTrail(l ?? null);

  const say = useCallback((text: string, kind: "ok" | "err" = "ok") => setToast((t) => ({ text, kind, n: (t?.n ?? 0) + 1 })), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === "err" ? 6000 : 3500);
    return () => clearTimeout(t);
  }, [toast]);

  /** Runs a request; on failure says what happened. Returns the result or null. */
  async function run<T>(fn: () => Promise<T>, okText?: (r: T) => string | null, onErr?: (msg: string) => void): Promise<T | null> {
    setBusy(true);
    try {
      const r = await fn();
      const text = okText?.(r);
      if (text) say(text);
      await refresh();
      return r;
    } catch (e) {
      const msg = (e as Error).message;
      if (onErr) onErr(msg);
      else say(msg, "err");
      return null;
    } finally {
      setBusy(false);
    }
  }

  // A new question opened: bring the player to the Play tab (or badge it), and buzz once.
  const marketKey = l?.market ? mkKey(l.market) : null;
  const lastMarket = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastMarket.current === undefined) {
      lastMarket.current = marketKey;
      return;
    }
    if (marketKey && marketKey !== lastMarket.current && l?.phase === "open") {
      setTab("play");
      try {
        // Chrome blocks (and logs) vibrate before the first tap on the page.
        const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
        if (!ua || ua.hasBeenActive) navigator.vibrate?.(30);
      } catch {
        /* no vibration */
      }
    }
    lastMarket.current = marketKey;
  }, [marketKey, l?.phase]);

  // Coinbase return (?deposit=1): ask the server to check every few seconds until it lands.
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
  }, [shouldSync, code, refresh, say]);

  // Solana Pay: while a payment link is showing, check for it every 3 s.
  useEffect(() => {
    if (!payLink) return;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const r = await api<{ credited: number; pending: number }>(`/api/lobby/${code}/deposit/sync`, { body: {}, token: tokenRef.current });
        if (alive && r.credited > 0) {
          say(`Money added: ${usd(r.credited)}`);
          setPayLink(null);
          await refresh();
        }
      } catch {
        /* keep trying; the button reports errors */
      }
    }, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [payLink, code, refresh, say]);

  // ---------------------------------------------------------------- loading / errors
  if (!boot || (!l && !error)) {
    return (
      <div className="ph-screen">
        <Backdrop />
        <div className="ph-col ph-full ph-centered">
          <Loading>Finding party {code}…</Loading>
        </div>
      </div>
    );
  }
  if (!l) {
    const notFound = error instanceof HttpError && error.status === 404;
    return (
      <div className="ph-screen">
        <Backdrop />
        <div className="ph-col ph-full">
          <header className="ph-brandbar">
            <a href="/" aria-label="Huddle home" className="ph-brand-link">
              <Wordmark className="ph-wordmark" />
            </a>
          </header>
          <div className="ph-grow" />
          <Kinetic as="h1" text={notFound ? `No party called ${code}.` : "Can’t reach Huddle."} className="hd-q ph-title-h" />
          <InlineError
            text={
              notFound
                ? "Tap your phone on the box again, or check the code on its screen."
                : `${error?.message ?? "Network error"}. Check your connection; this page keeps trying by itself.`
            }
          />
          <div className="ph-grow" />
          <a className="hd-btn hd-btn-secondary hd-btn-block" href="/">
            Enter a different code
          </a>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- join
  if (!l.me) {
    return (
      <JoinScreen
        l={l}
        busy={busy}
        error={joinError}
        onJoin={(name) => {
          setJoinError(null);
          run(
            async () => {
              const r = await api<{ token: string }>(`/api/lobby/${code}/join`, { body: { name } });
              saveToken(code, boot.seat, r.token);
              setToken(r.token);
              return r;
            },
            () => null,
            setJoinError,
          );
        }}
      />
    );
  }

  const me = l.me;
  const m = l.market;
  const serverNow = now + (l.now - lastOk);
  const solana = (l.money.mode as string) === "solana";
  const coinbase = l.money.mode === "coinbase";

  /** Deposit: demo credits at once; Solana returns a pay link; Coinbase opens checkout. */
  const deposit = async (cents: number): Promise<boolean> => {
    const r = await run(
      () => api<{ url?: string; credited?: number }>(`/api/lobby/${code}/deposit`, { body: { cents }, token }),
      (r) => (r.url?.startsWith("solana:") ? "Scan the code or open your wallet app" : r.url ? "Opening checkout…" : null),
      (msg) => {
        setBuyError(msg);
        say(msg, "err");
      },
    );
    if (!r) return false;
    if (r.url?.startsWith("solana:")) {
      setPayLink({ url: r.url, cents });
      return false;
    }
    if (r.url) {
      window.location.href = r.url;
      return false;
    }
    return true;
  };

  const checkPayment = () => {
    setChecking(true);
    run(
      () => api<{ credited: number; pending: number }>(`/api/lobby/${code}/deposit/sync`, { body: {}, token }),
      (r) => {
        if (r.credited) setPayLink(null);
        return r.credited ? `Money added: ${usd(r.credited)}` : r.pending > 0 ? "Still processing your payment…" : "Nothing new yet. Give it a few seconds.";
      },
    ).finally(() => setChecking(false));
  };

  /** "Pay on the box": the box shows this deposit's Solana Pay QR (for a wallet on another phone); credited by itself. */
  const payOnBox = (cents: number) => {
    setBoxBusy(true);
    run(
      () => api<{ url: string }>(`/api/lobby/${code}/deposit/box`, { body: { cents }, token }),
      () => {
        setPayLink(null);
        return "It's on the box now. Scan it there with your wallet";
      },
    ).finally(() => setBoxBusy(false));
  };

  const payment = payLink ? (
    <PayLink
      url={payLink.url}
      cents={payLink.cents}
      checking={checking}
      onCheck={checkPayment}
      onClose={() => setPayLink(null)}
      onBox={solana && l.money.boxPay ? () => payOnBox(payLink.cents) : undefined}
      onBoxBusy={boxBusy || busy}
    />
  ) : null;

  const checkButton =
    (coinbase || solana) && !payLink ? (
      <button className="hd-btn hd-btn-quiet hd-btn-block" disabled={busy || syncing || checking} onClick={checkPayment}>
        {syncing ? "Waiting for your payment…" : "Check for my payment"}
      </button>
    ) : null;

  const cashOut = (address: string) =>
    run(
      () => api<{ cents: number; explorer?: string }>(`/api/lobby/${code}/cashout`, { body: { address }, token }),
      (r) => {
        setCashed({ cents: r.cents, explorer: r.explorer });
        setMoneyOpen(false);
        return `Cashed out ${usd(r.cents)}`;
      },
    );

  // ---------------------------------------------------------------- buy-in
  const needsBuyIn = me.deposited === 0 && !skipped && l.phase !== "ended";
  if (needsBuyIn || buyInDone) {
    return (
      <>
        <BuyInScreen
          l={l}
          done={buyInDone}
          busy={busy || syncing}
          error={buyError}
          payment={payment}
          onBuyIn={async (c) => {
            setBuyError(null);
            const ok = await deposit(c);
            if (ok) setBuyInDone(true);
            return ok;
          }}
          onDone={() => {
            setBuyInDone(false);
            setSkipped(true);
          }}
          onSkip={() => {
            setSkipped(true);
            try {
              localStorage.setItem(`huddle:skip:${code}:${boot.seat ?? ""}`, "1");
            } catch {
              /* private mode */
            }
          }}
        />
        <ToastView toast={toast} />
      </>
    );
  }

  // ---------------------------------------------------------------- live
  const actions: Actions = {
    busy,
    balance: me.balance,
    addMoney: () => setMoneyOpen(true),
    buy: async (side: Side, cents: number) =>
      !!(await run(
        () => api<{ shares: number }>(`/api/lobby/${code}/buy`, { body: { side, cents }, token }),
        () => `${usd(cents)} on ${SIDE[side]}. You’re in.`,
      )),
    offer: async (side, cents, odds) =>
      !!(await run(
        () => api(`/api/lobby/${code}/offer`, { body: { side, cents, odds }, token }),
        () => `Offer posted: ${usd(cents)} on ${SIDE[side]} at ${odds}x`,
      )),
    take: async (offerId, cents) =>
      !!(await run(
        () => api<{ takerCents: number }>(`/api/lobby/${code}/take`, { body: { offerId, cents }, token }),
        (r) => `Matched. You put in ${usd(r.takerCents)}.`,
      )),
  };

  const ended = l.phase === "ended";
  const caption = l.captions?.length ? l.captions[l.captions.length - 1] : null;
  const live = !!m && (l.phase === "open" || l.phase === "locked" || l.phase === "result");
  const tint = m?.moment && l.phase === "open" ? (l.game?.color ?? null) : null;
  const cashOutEl = <CashOut l={l} busy={busy} prime={ended || me.balance > me.deposited} onCashOut={cashOut} />;

  return (
    <div className="ph-screen">
      <Backdrop tint={tint} />
      <a className="ph-skip" href="#main">
        Skip to content
      </a>
      <Header l={l} onMoney={() => setMoneyOpen(true)} />
      {error && (
        <div className="ph-offline-wrap">
          <div className="ph-offline hd-pop" role="status">
            <Icon name="wifiOff" size={18} /> Reconnecting… your bets are safe.
          </div>
        </div>
      )}
      <main id="main" className="ph-col ph-main">
        <div key={tab} className="hd-fade ph-stackgap">
          {tab === "play" &&
            (ended ? (
              <EndOfGame l={l} cashed={cashed} cashOut={cashOutEl} />
            ) : (
              <>
                {live && m ? (
                  <MarketCard key={mkKey(m)} l={l} m={m} serverNow={serverNow} actions={actions} />
                ) : (
                  <Waiting l={l} />
                )}
                <ParkedCard l={l} />
                {me.balance <= 0 && !live && (
                  <button className="hd-btn hd-btn-secondary hd-btn-block" onClick={() => setMoneyOpen(true)}>
                    <Icon name="plus" size={18} /> Add money to play
                  </button>
                )}
              </>
            ))}
          {tab === "board" && <Leaderboard l={l} />}
          {tab === "results" && <ResultsTab l={l} trail={trail} />}
        </div>
      </main>
      <Dock
        tab={tab}
        badge={l.phase === "open"}
        caption={caption}
        onTab={setTab}
      />
      <MoneySheet
        l={l}
        open={moneyOpen}
        onClose={() => setMoneyOpen(false)}
        busy={busy || syncing}
        onDeposit={async (c, el) => {
          const ok = await deposit(c);
          if (ok) {
            say(`Added ${usd(c)}`);
            balanceCoins[1](el, document.querySelector("[data-testid=balance]"), 3);
          }
        }}
        payment={payment}
        checkButton={checkButton}
        cashOut={cashOutEl}
      />
      {balanceCoins[0]}
      <ToastView toast={toast} />
    </div>
  );
}

/** Between questions: who you are, what happens next. */
function Waiting({ l }: { l: LobbyData }) {
  const me = l.me!;
  const replay = l.game?.kind === "replay";
  const first = l.qIndex === 0 && l.results.length === 0;
  return (
    <section className="ph-wait hd-card" aria-labelledby="wait-h">
      <Mark size="2.75rem" lit={Math.min(12, l.players.length + 1)} className="hd-float ph-wait-mark" />
      <Kinetic as="h1" id="wait-h" text={first ? `You’re in, ${me.name}.` : "Next question coming up."} className="hd-q ph-wait-h" stagger={50} />
      <p className="ph-lead">
        {replay
          ? "Questions drop by themselves on the big plays. Keep this open."
          : `The host starts question ${l.qIndex + 1} from the box. When something happens on TV, they can call it and a quick question opens here.`}
      </p>
      {l.nextQuestion && (
        <p className="ph-next">
          <span className="ph-k">Up next</span>
          <span className="ph-next-q">{l.nextQuestion}</span>
        </p>
      )}
      {l.players.length < 2 && <Empty>Friends join by tapping their phone on the box or scanning its code. Party code <b className="hd-num">{l.code}</b>.</Empty>}
    </section>
  );
}

function ToastView({ toast }: { toast: Toast | null }) {
  return (
    <div className="ph-toasts" aria-live="polite" role="status">
      {toast && (
        <div key={toast.n} className={`ph-toast hd-drop ${toast.kind === "err" ? "err" : ""}`}>
          <Icon name={toast.kind === "err" ? "warn" : "check"} size={16} />
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  );
}
