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

captions?: { id: number; at: number; text: string }[]          // newest last, about 10 kept; ids only increase
scorecard?: { room: number|null; model: number|null; gemini: number|null; n: number; verdict: string }
                                                  // Brier scores (lower is better) over resolved questions
parked?: { text; yesCents; model; gemini; volume; mode; myPosition } | null
                                                  // replay: the pregame question, locked, settling at the final whistle
me.stake?: { yes: number; no: number }            // pool mode: my cents on each side
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
| `POST /api/lobby/:code/deposit` | `{cents}` | demo: `{credited}`; coinbase: `{url}`; **solana**: `{url: "solana:<treasury>?amount=5&spl-token=<mint>&reference=<key>&label=Huddle&message=..", solanaPay: true, reference, recipient, mint, amount}`. Show `url` as a QR and an "Open in wallet" link, then poll `/deposit/sync` every 3 s |
| `POST /api/lobby/:code/deposit/sync` | | `{credited, pending}`. Solana: finds the payment by its reference on devnet, checks USDC reached the treasury, credits once per signature |
| `POST /api/lobby/:code/faucet` (x-player-token) | `{address}` | solana only: $20 test USDC + 0.005 SOL (for fees) to that wallet, once per player per lobby. `{cents, usdcSig, solSig, explorer}` |
| `POST /api/lobby/:code/cashout` | `{address?}` | solana: sends the whole balance as devnet USDC to `address` (a Solana address), or to the wallet the player deposited from / used the faucet with. `{cents, mode: "solana", to, txHash, explorer}` |

`money` in the lobby view (solana mode): `{mode: "solana", payouts: "solana", asset: "test USDC on Solana devnet",
solanaPay: true, faucet: true, depositOptions: [500, 1000, 2000]}`. In demo/coinbase it is unchanged (plus
`solanaPay: false, faucet: false`). Phones should show a Solana address field when `payouts === "solana"`
(optional: without one, cash-out goes to the paying wallet).

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

## Env vars

| Var | Needed for | Default |
|---|---|---|
| `ELEVENLABS_API_KEY` | TTS for captions | unset = `/api/tts` returns 204 (Web Speech fallback) |
| `ELEVENLABS_TTS_MODEL` | | `eleven_flash_v2_5` |
| `ELEVENLABS_VOICE_NFL` / `_SOCCER` / `_CALM` | other stock voices | Brian / George / Eric |
| `GEMINI_API_BASE` | Gemini Prediction Markets | `https://api.gemini.com` (public, no key) |
| `GEMINI_DISABLED=1` | turn Gemini off | |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis on Vercel (lobbies, Gemini and TTS caches) | memory |
| `MONEY_MODE=solana` | Solana Pay money (devnet test USDC) | `demo`. If the two vars below are missing it runs demo money and `/api/health` (`solana.problems`, `warnings`) says why |
| `SOLANA_TREASURY_SECRET_KEY` | treasury keypair (base58 or JSON byte array); receives deposits, pays cash-outs, fees and the faucet | |
| `USDC_MINT` | the test USDC mint | |
| `SOLANA_RPC_URL` | | `https://api.devnet.solana.com` (mainnet URLs are refused) |

## Human steps

- **Upstash**: Vercel > Storage > Upstash for Redis > connect to the project (sets `KV_REST_API_*`). Required on Vercel.
- **ElevenLabs**: create an API key at elevenlabs.io (Text to Speech permission) and set `ELEVENLABS_API_KEY` in Vercel.
- **Gemini**: nothing; the public API needs no key. If it is down, the Titans at Cowboys game uses the bundled
  Nov 16 snapshot (shown with `live: false` and its real `asOf`).
- **Solana (optional, devnet only)**, from `web/`:
  1. `node scripts/solana-setup.mjs` prints a new treasury address and `SOLANA_TREASURY_SECRET_KEY=...`. Keep the
     secret out of git and chat; put it in `web/.env.local` and Vercel env vars.
  2. Go to https://faucet.solana.com, pick **devnet**, paste the treasury address, request 1-5 SOL (the RPC
     airdrop is closed, so this is a browser step; it may ask for a GitHub sign-in).
  3. Run `SOLANA_TREASURY_SECRET_KEY=... node scripts/solana-setup.mjs` again: it creates a 6-decimal test USDC mint
     owned by the treasury, mints $1,000 to it and prints `USDC_MINT=...` (the faucet route then mints for players).
     Alternative: Circle's devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, funded at https://faucet.circle.com.
  4. Set `MONEY_MODE=solana`, `SOLANA_TREASURY_SECRET_KEY`, `USDC_MINT` in Vercel; redeploy; check `/api/health` shows `solana.active: true`.
  5. Players need a devnet wallet (Phantom/Solflare/Backpack with devnet enabled). The faucet route gives them test
     USDC and a little SOL for the transfer fee; they deposit by opening the Solana Pay link.
- Privy was dropped (direction change): no `@privy-io` dependency and no `components/wallet` module.
