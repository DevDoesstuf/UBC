# Huddle extras: data contract

What the backend adds on top of Dev's lobby API. Everything here is **optional and additive**: old clients
and the ESP32 kiosk keep working unchanged (`GET /api/kiosk/state` and `POST /api/kiosk/touch` are not changed:
same screens, same fields).

All money is integer **cents**. Probabilities are 0..1 unless the field name ends in `Cents`/`Pct`.

## `GET /api/lobby/:code` (publicView) new fields

```ts
game.kind?: 'clip' | 'replay'
game.persona?: 'nfl' | 'soccer' | 'calm'          // announcer voice for captions / TTS
game.score?: {                                    // replay games only
  home: string; away: string;                     // team names, e.g. "Dallas Cowboys"
  homeScore: number; awayScore: number;
  clock: string;                                  // "9:06" (NFL) or "27'" (soccer)
  // extras: homeShort, awayShort, period, status ('pre'|'live'|'final'), started (clock running), lastPlay (ticker text)
}
mode?: 'market' | 'pool' | 'h2h'                  // lobby default for the next questions

market.mode?: 'market' | 'pool' | 'h2h'           // default 'market' (LMSR)
market.pool?: { yesCents: number; noCents: number }           // pool mode only
market.offers?: {                                             // h2h mode only
  id: string; by: string /* maker player id */; side: 'yes'|'no'; cents: number /* maker stake */;
  odds: number /* decimal odds for the maker's side */; open: boolean;
  // extras: name (maker name), filled, remaining (maker cents left), takeCents (taker stake that takes all that is left)
}[]
market.model?: number | null                      // model YES probability the market opened at (null = no model, 50/50)
market.gemini?: { prob: number; label: string; asOf: string; url?: string; live: boolean } | null
                                                  // Gemini's YES probability for comparable questions; live=false means
                                                  // the API was unreachable and this is the bundled last-seen snapshot (asOf is real)
// extras: market.priceAtLock (YES price when trading locked), market.voided, market.rationale (why the model says what it says)
market.gemini.source?: 'live' | 'snapshot' | 'replay'  // replay = Gemini's real price at this moment of the replayed real game
market.geminiAtOpen?: number | null               // Gemini's YES probability when the question opened (null = not comparable)
market.trail?: { at: number /* wall ms */; room: number; gemini: number | null }[]
                                                  // room (YES price) vs Gemini over time: a point when either moves,
                                                  // always one at open and one at lock (max 120). Draw both lines on the TV.

game.sport?: 'nfl' | 'soccer' | 'nba' | null
game.league?: string | null                       // "NFL", "NBA", "Premier League" (real replayed games)
game.date?: string | null                         // local date of the real game, "2026-11-15"
game.real?: boolean                               // true = real play-by-play (ESPN), not a hand-written demo
game.source?: { provider: 'ESPN'; event: string; url: string | null } | null

gemini?: {                                        // game-level Gemini block, null when the game has no Gemini mapping
  event: string;                                  // ticker base, e.g. "NFL-2611152125-SF-DAL"
  url: string | null;                             // the moneyline's page on gemini.com
  source: 'live' | 'snapshot' | 'replay';
  live: boolean;                                  // true only for prices fetched from Gemini just now
  asOf: string;                                   // ISO; for 'replay' it is the real time of the play on screen
  note: string;                                   // one sentence to show as is, e.g. "Gemini's real price at this moment
                                                  // of the game (Nov 15, 6:02 PM ET). The market settled Nov 15."
  settled: boolean;                               // the game's Gemini markets have settled
  moneyline: { home: { code: string|null; prob: number|null }; away: {...}; draw: number|null } | null
  total: { line: number; over: number|null } | null   // the total line nearest 50%
  track: { t: number /* replay ms */; p: number /* Gemini home-win prob */ }[]
                                                  // replayed real games: Gemini's home-win probability from kickoff
                                                  // to now (<= 80 points; empty before the clock starts)
} | null

captions?: { id: number; at: number; text: string }[]          // newest last, about 10 kept; ids only increase
scorecard?: { room: number|null; model: number|null; gemini: number|null; n: number; verdict: string }
                                                  // Brier scores (lower is better) over resolved questions
parked?: { text; yesCents; model; gemini; volume; mode; myPosition } | null
                                                  // replay: the pregame question, locked, settling at the final whistle
me.stake?: { yes: number; no: number }            // pool mode: my cents on each side
players[].withdrawn: number                       // cents already cashed out
players[].open: number                            // cents in the running (or parked pregame) question at value:
                                                  // market mode shares at the current price, pool/h2h stake at
                                                  // cost (h2h includes unmatched offers); 0 once it settles
                                                  // Boards rank by balance + withdrawn + open (lib/standings.ts
                                                  // standings(): shared rank on a tie, `lead` only for a sole leader)
```

In pool and h2h mode `market.yesCents/noCents/priceYes/history` still work: pool shows the share of the pot on
YES (the model prior while empty), h2h shows the YES probability implied by the last matched offer.
`me.position` in pool/h2h mode holds **dollars staked** per side (not $1 shares).

## "Call it" moments (kiosk hardware)

The host taps a moment on the kiosk the instant it happens; a market opens immediately with a model-priced
question and a short trading window (15-25 s). Between questions only (phase `lobby` or `result`).

```ts
// lib/lobby.ts (server)
export const MOMENT_KINDS: Record<'nfl' | 'soccer', MomentKind[]>   // re-exported from lib/moments.ts
//   nfl:    third_down "3rd down", red_zone "Red zone", big_play "Big play", next_score "Next score"
//   soccer: penalty "Penalty!", corner "Corner", free_kick "Free kick", next_goal "Next goal"
export function momentsFor(l: Lobby): { id: string /* "moment:<kind>" */; label: string /* Latin-1, <= 11 chars */ }[]
export function openMoment(l: Lobby, kind: string /* "penalty" or "moment:penalty" */, now: number): void  // throws ApiError(400)
```

Kiosk wiring (UI agent, in `lib/kiosk.ts`): show `momentsFor(l)` as buttons on the lobby/result screens and on a
tap `moment:<kind>` call `await mutate(code, (l, now) => openMoment(l, arg, now))`. The market then behaves like
any other: `market` screen, auto-lock at `lockAt`, host taps **It was YES/NO** (resolveAt is null), except in
replay games where a matching engine question exists (3rd down, red zone, penalty, corner): then the
play-by-play resolves it. A called moment does not use up one of the game's scripted questions (`qIndex` is
unchanged after it resolves). The caption leads with the call: "Penalty called! Will Ronaldo score this penalty? ...".

- `game.moments` in `config/games.json`: the kinds a game offers (and `game.sport`: `nfl` | `soccer`).
- publicView: `moments: { id, label, enabled }[]` (enabled = no question running) and `market.moment`
  (the kind, when the market came from a call).
- HTTP for screens other than the ESP32: `GET /api/lobby/:code/moment` lists them; `POST /api/lobby/:code/moment {kind}`
  opens one (x-kiosk-key if set).

## New routes

| Route | Body | Returns |
|---|---|---|
| `POST /api/lobby/:code/offer` (x-player-token) | `{side, cents, odds}` (odds 1.01..50, cents 25..5000) | `{ok, offer}`. The stake leaves the balance; unmatched stake comes back at lock |
| `POST /api/lobby/:code/take` (x-player-token) | `{offerId, cents}` | `{ok, offerId, takerCents, makerCents, complete}`. Partial takes OK; cents above what is left are not used |
| `POST /api/lobby/:code/buy` | `{side, cents}` | unchanged; in **pool** mode it stakes `cents` on `side` (`shares` = dollars staked). Refused in h2h mode |
| `POST /api/lobby/:code/mode` (x-kiosk-key if set) | `{mode}` | `{ok, mode}`; between questions only |
| `POST /api/lobby` (x-kiosk-key if set) | `{game, kiosk?, mode?}` | `{ok, code, kiosk, mode}`: same as tapping a game tile, plus a mode |
| `POST /api/kiosk/touch` | `{kiosk, id, mode?}` | unchanged; `mode` is honoured on `game:<id>` taps (the ESP32 never sends it) |
| `GET /api/tts?text=...&persona=nfl` or `?code=ABCD&id=<caption id>` | | `audio/mpeg` (ElevenLabs, cached by hash); `&format=wav` gives 22 kHz mono WAV. **204** when `ELEVENLABS_API_KEY` is unset; 502/504 when ElevenLabs fails. On anything but 200, read the caption with Web Speech |
| `GET /api/kiosk/audio?kiosk=1&after=<id>` | | unchanged shape `{id, url, text}`. Still serves the WAV sound effects; with `ELEVENLABS_API_KEY` set, every caption is also an item whose `url` is `/api/tts?code=..&id=..&format=wav` (the announcer on the speaker). Ids only increase (captions share the event id counter) |
| `GET/POST /api/lobby/:code/moment` | `{kind}` | list / open a "Call it" moment (see above) |
| `GET /api/gemini/markets` `?league=NFL,NBA,EPL&team=DAL` | | Market discovery: `{asOf, live, source: 'live'\|'snapshot'\|'unavailable', note, leagues, count, games: [{base, league, title, startTime, isLive, url, home: {code, name, prob}, away, draw, volume}], ours: [{gameId, title, event, real, date, settled, hasPriceHistory, liveNow, upcoming: [game...]}]}`. Full-game moneylines Gemini is trading, soonest first (default leagues NFL, NBA, EPL; also NHL NCAAF NCAAM MLB MLS UCL). `ours` lists the Gemini games our teams play next. Cached 2 min; when Gemini is down it serves the last good list (`live: false`, real `asOf`), never a 5xx |
| `POST /api/lobby/:code/deposit` | `{cents}` | demo: `{credited}`; coinbase: `{url}`; **solana**: `{url: "solana:<treasury>?amount=5&spl-token=<mint>&reference=<key>&label=Huddle&message=..", solanaPay: true, reference, recipient, mint, amount}`. Show `url` as a QR and an "Open in wallet" link, then poll `/deposit/sync` every 3 s |
| `POST /api/lobby/:code/deposit/sync` | `{reference?}` | `{credited, pending}`. Solana: finds the payment by its reference on chain, checks USDC reached the treasury, credits once per signature (see [Solana money](#solana-money-money_modesolana)). Solana adds `payments: [{signature, cents, explorer}]` (credited now) and `refunded` (cents, only when a stuck cash-out came back). `pending: -1` = polled within 2.5 s, ask again |
| `POST /api/lobby/:code/faucet` (x-player-token) | `{address}` | solana only: $20 test USDC + 0.005 SOL (only if the wallet has less) to that wallet in **one** transaction, once per player per lobby. `{cents, usdcSig, solSig, explorer}`; `solSig` is the same signature as `usdcSig`, or `null` when no SOL was sent. 400 with a readable `error` for a bad address |
| `POST /api/lobby/:code/cashout` | `{address?}` | solana: sends the whole balance as test USDC to `address` (a Solana **wallet** address), or to the wallet the player deposited from / used the faucet with. `{cents, mode: "solana", to, txHash, explorer}`, plus `pending: true` when the send could not be confirmed (see below). 400 before anything moves for a token account, the treasury, the mint or a program; 502 (balance put back) when it surely failed |

`money` in the lobby view (solana mode): `{mode: "solana", payouts: "solana", asset: "test USDC on Solana devnet",
solanaPay: true, faucet: true, depositOptions: [500, 1000, 2000]}`. In demo/coinbase it is unchanged (plus
`solanaPay: false, faucet: false`). Phones should show a Solana address field when `payouts === "solana"`
(optional: without one, cash-out goes to the paying wallet). `me.solanaAddress` (string | null: the wallet cash-out
goes to by default, learned from the first payment or the faucet; prefill the field with it) and `me.fauceted`
(boolean: hide the faucet button once used) are in every lobby view.

### Solana money (`MONEY_MODE=solana`)

Everything on chain is test USDC (a 6-decimal SPL token) on **devnet**, or on a local `solana-test-validator`. The
treasury wallet receives deposits and pays every fee and token-account rent; players never need SOL except the
deposit's own transfer fee, which the faucet covers.

- **Deposit URL** (Solana Pay transfer request, checked against the spec and parsed the way Phantom/Solflare parse it):
  `solana:<treasury wallet>?amount=<dollars>&spl-token=<USDC_MINT>&reference=<fresh pubkey>&label=Huddle&message=Huddle%20lobby%20ABCD&memo=huddle-ABCD`.
  `amount` is a plain decimal in dollars with no exponent and no trailing zeros (`5`, `10.5`, `0.25`); text is
  percent-encoded with `%20` for spaces (never `+`). The recipient is the treasury *wallet*; the wallet pays its
  associated USDC account with a `transferChecked`, adds the reference as a read-only non-signer key, and puts the memo
  in an SPL Memo instruction. The response's `amount` field stays `"5.00"` (two decimals) for display.
- **Crediting**: `/deposit/sync` looks up the player's open references (newest 4, under an hour old, or only
  `reference` when given) with `getSignaturesForAddress`, and credits the increase of `USDC_MINT` held by
  treasury-owned accounts in each successful transaction (over/under-payments credit what arrived, rounded down to the
  cent). Each signature is credited once per lobby (`deposits["sol-<signature>"]`) **and** claimed globally in the
  store (`solsig:<signature>`), so one transaction carrying references from two lobbies is credited only once. Paid
  references are dropped. Poll every 3 s while a QR is showing; it is cheap when nothing changed.
- **Cash-out**: one transaction (create the recipient's USDC account if missing + `transferChecked`). If the treasury is
  short and is the mint authority (the test mint), the shortfall is minted in the same transaction. When the RPC drops
  mid-send the outcome is unknown: the response is `ok` with `pending: true`, the withdrawal is recorded with
  `status: "pending"` and the signature, and the next `/cashout` or `/deposit/sync` from that player settles it (marked
  `sent` once confirmed, or the money comes back to the balance once the transaction's blockhash has expired unseen).
  It is never paid twice and never refunded while it could still land.
- **`/api/health` → `solana`**: `{requested, active, ready, network, rpc, problems[], nextSteps[], treasury: {address,
  mint, rpc} | null, checks}`. `active` = `MONEY_MODE=solana` with its env complete; `ready` = live checks passed: RPC
  reachable and not mainnet, treasury has at least 0.02 SOL, `USDC_MINT` exists with 6 decimals, and the treasury
  can mint or holds at least $100. `checks` has the numbers (`cluster`, `treasurySol`, `treasuryUsdcCents`,
  `mint.treasuryIsMintAuthority`); it is cached for 15 s. Problems also appear in `warnings`.

Head-to-head odds: decimal odds for the maker's side. Backing YES with $10 at 1.30 means a taker matches it with
$3; the winner of each matched pair gets both stakes ($13).

Pool: winners split the whole pot pro rata to their stake (rounded down to the cent; dust to the house). If nobody
backed the winner, everyone is refunded.

## Modes: how to pick

1. `mode` in a game's `config/games.json` entry (default for that game), else `market`.
2. Per lobby: `POST /api/lobby {game, mode}`, or `{mode}` on the `game:<id>` kiosk touch.
3. Between questions: `POST /api/lobby/:code/mode {mode}`.

## Replay games (`kind: 'replay'`)

`nfl-replay` (Titans at Cowboys) and `soccer-replay` (Portugal v Spain) are kiosk tiles 2 and 3.
The host's **Start** tap opens the pregame question (games with a Gemini mapping: "Will the Cowboys beat the
Titans?", model calibrated to Gemini, `market.gemini` attached). It trades 20 s, then it is *parked*
(`parked` field) and settles at the final whistle, and the game clock starts on the first live question.
After that the question engine asks one question at a time from the plays (3rd/4th-down conversions, red-zone
touchdowns, drive results, penalties, corners, cards, next goal, period winners), locks it at its lock time or
lock event and resolves it from the play-by-play. The next question opens by itself 5 s after a result.
**Lock now**, **It was YES/NO** and **Next question** taps still work. `questionCount` is the length of the
script when nobody taps; `qIndex` counts questions asked.

### Real games (built from ESPN play-by-play and Gemini price history)

| Game id (kiosk tile) | Real game | Gemini event | Gemini prices |
|---|---|---|---|
| `nfl-sf-dal` (tile 1) | 49ers 46, Cowboys 40, NFL, Nov 15 2026 | `NFL-2611152125-SF-DAL` | pregame + in-game history (moneyline, total 56.5, 1st quarter and 1st half winners) |
| `nba-okc-lac` (tile 2) | Clippers 113, Thunder 112, NBA, Nov 13 2026 | `NBA-2611140330-OKC-LAC` | pregame + history (moneyline, total 220.5) |
| `epl-mun-avl` (tile 3) | Man United 4, Aston Villa 4, Premier League, Nov 8 2026 | `EPL-2611081630-AVL-MUN` | listed and settled, but it never traded: no prices, the model prices alone |
| `nfl-lac-bal` | Chargers 23, Ravens 20, NFL Monday night, Nov 16 2026 | `NFL-2611170115-LAC-BAL` | pregame + history (moneyline, total, quarter and half winners) |
| `nfl-mia-ind` | Colts 24, Dolphins 22, NFL, Nov 15 2026 | `NFL-2611151800-MIA-IND` | pregame + history (moneyline, total, 3rd quarter and 1st half winners) |

Each plays in about 6.5 to 7 minutes. Rebuild or add games with `node scripts/build-replays.mjs [id]` (or
`--league nfl|nba|eng.1 --event <ESPN event id> --id replay-x`), then register the file in
`lib/replay/timeline.ts` and add a `config/games.json` entry with `kind: "replay"` and `replay: <id>`; league,
date, source and the Gemini mapping are read from the file. Nothing calls ESPN at runtime.

Gemini on a real game: the markets settled after the game, so the live API has no prices. The replay file holds
Gemini's real 5-minute price history, and **at replay time T the lobby holds Gemini's real price at the moment of
the real game that T shows** (`source: "replay"`, `asOf` = that real time). Questions comparable to a Gemini
market (moneyline, the total line, quarter and half winners, crunch-time "hold on") show it, record it at open
(`geminiAtOpen`) and at lock (scorecard), and draw it in `market.trail`. The pregame question opens at Gemini's
price a minute before kickoff and the pricing models are calibrated to it.

NBA questions (`nba-okc-lac`): pregame winner, free-throw trips ("Will Shai Gilgeous-Alexander make both free
throws?", league 78% per shot), next score out of a timeout (team with the ball ~68%), a made three in the first
two minutes of a quarter, quarter winner with about 2:30 left while the quarter is in doubt, crunch-time hold-on,
late total at the projected pace. Kiosk "Call it" moments for NBA: `free_throws`, `timeout`, `three`.

## Env vars

| Var | Needed for | Default |
|---|---|---|
| `ELEVENLABS_API_KEY` | TTS for captions | unset = `/api/tts` returns 204 (Web Speech fallback) |
| `ELEVENLABS_TTS_MODEL` | | `eleven_flash_v2_5` |
| `ELEVENLABS_VOICE_NFL` / `_SOCCER` / `_CALM` | other stock voices | Brian / George / Eric |
| `GEMINI_API_BASE` | Gemini Prediction Markets | `https://api.gemini.com` (public, no key) |
| `GEMINI_DISABLED=1` | turn Gemini off | |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis on Vercel (lobbies, Gemini and TTS caches) | memory |
| `MONEY_MODE=solana` | Solana Pay money (devnet test USDC) | `demo`. If the two vars below are missing or malformed it runs demo money and `/api/health` (`solana.problems`, `solana.nextSteps`, `warnings`) says why |
| `SOLANA_TREASURY_SECRET_KEY` | treasury keypair (base58 or JSON byte array); receives deposits, pays cash-outs, fees and the faucet | |
| `USDC_MINT` | the test USDC mint | |
| `SOLANA_RPC_URL` | a devnet RPC (a keyed provider is fine; its key is redacted in `/api/health`) or `http://127.0.0.1:8899` for a local validator | `https://api.devnet.solana.com` (mainnet URLs and mainnet genesis are refused) |

## Human steps

- **Upstash**: Vercel > Storage > Upstash for Redis > connect to the project (sets `KV_REST_API_*`). Required on Vercel.
- **ElevenLabs**: create an API key at elevenlabs.io (Text to Speech permission) and set `ELEVENLABS_API_KEY` in Vercel.
  **Not set yet** (checked Nov 18 with `vercel env pull` on the `huddle-live` project: only the Upstash vars are
  there), so `/api/tts` answers 204 and the TV uses Web Speech. The request (`POST /v1/text-to-speech/{voice}/stream`,
  `xi-api-key`, `output_format=mp3_44100_128` or `pcm_22050`, `model_id: eleven_flash_v2_5`, `voice_settings`) was
  checked against ElevenLabs' current API reference and is tested against a mock (`test/games-live.test.mts`).
- **Gemini**: nothing; the public API needs no key. If it is down, the Titans at Cowboys game uses the bundled
  Nov 16 snapshot (shown with `live: false` and its real `asOf`). Settled markets are never fetched again: the
  stored pregame snapshot is used and `note` says so. Real replayed games need no network for Gemini at all.
- **Solana (optional, devnet only)**, from `web/` (about 5 minutes):
  1. `node scripts/solana-setup.mjs`. It creates the treasury key in `web/.solana/` (gitignored: `treasury.json`,
     `treasury.secret`; the secret is never printed) and prints **`Treasury address: <address>`**. The devnet RPC
     airdrop is closed, so it stops with "NEXT STEP (human)".
  2. Open https://faucet.solana.com, pick **devnet**, paste the printed treasury address, request 1-5 SOL (it may ask
     for a GitHub sign-in). 1 SOL pays for thousands of deposits, cash-outs and faucet drops.
  3. Run `node scripts/solana-setup.mjs` again (add `--write-env-local` to also write `web/.env.local`). It creates a
     6-decimal test USDC mint owned by the treasury (so the faucet and cash-outs can mint), mints the treasury $1,000,
     and prints the env lines plus the exact `vercel env add ...` commands (the secret is piped from
     `web/.solana/treasury.secret`). The same four lines, secret included, are in `web/.solana/vercel.env` for
     Vercel's "Import .env". Re-running is safe: it reuses the key and the mint.
     Alternative mint: Circle's devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (set `USDC_MINT` before
     step 3, fund the treasury at https://faucet.circle.com; the faucet route then sends from the treasury's balance).
  4. In Vercel set `MONEY_MODE=solana`, `SOLANA_TREASURY_SECRET_KEY`, `USDC_MINT` (Production and Preview), redeploy,
     and open `/api/health`: `solana.active` and `solana.ready` must be `true` (otherwise `solana.nextSteps` says what
     is missing). Keep `web/.solana/` backed up privately: it is the treasury.
  5. Players need a wallet on devnet (Phantom: Settings > Developer settings > Testnet mode, Solana devnet; Solflare
     and Backpack have a devnet switch). The faucet button gives them $20 test USDC and SOL for the fee; they deposit
     by scanning the QR or tapping "Open in wallet".
  - Test without phones: `npm run test:localnet` (needs the Agave CLI: it starts `solana-test-validator`, runs the
    setup script, starts `next dev` with `MONEY_MODE=solana` and plays a party: faucet, Solana Pay deposit paid like
    Phantom, sync once, buy, resolve, cash-out checked on chain). `node scripts/solana-wallet.mjs pay '<solana:...>'
    --keypair <file>` pays any deposit QR from the command line (devnet or local).
- Privy was dropped (direction change): no `@privy-io` dependency and no `components/wallet` module.
