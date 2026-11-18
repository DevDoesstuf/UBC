# Huddle

Huddle turns a watch party into a small prediction market that friends run themselves, around a box on the coffee table.

1. A group picks a game on the kiosk touchscreen (a real clip, or a replayed game).
2. Everyone taps a phone on the kiosk (NFC) or scans its QR code to join.
3. A laptop or TV plays the game with the live price, the leaderboard and an announcer on top.
4. Everyone buys YES or NO on one question at a time. Prices move with every trade (LMSR, Kalshi style), trading locks before the play, and winning shares pay $1.
5. **The box runs the game:** when something happens on TV, someone slams a **Call it!** button on the kiosk (Penalty!, 3rd down, Big play...) and a market opens on every phone instantly, priced by a model, with the announcer calling it.

Everything runs on **one website** (Next.js on Vercel, Upstash Redis). The kiosk, the phones and the TV page are all views of the same lobby. **All logic lives on the site**: the kiosk firmware only draws what the site sends and reports taps, so new screens, buttons and colours ship without reflashing.

**Live:** https://huddle-live-eight.vercel.app (TV: `/watch/CODE`, phones: `/l/CODE`, box preview: `/kiosk?id=1`).

## What Huddle adds on top of the original Live Lines build

| Feature | How | Where |
|---|---|---|
| **Call it! moments** | Kiosk buttons open an instant market for the moment on TV, priced from real data (nflverse, StatsBomb) | `lib/moments.ts`, `lib/kiosk.ts` |
| **AI-written questions from the game** | Replay games fold play-by-play events on every read and open the next question automatically; resolvers settle them from the plays | `lib/replay/` |
| **Real recent games** | 49ers 46-40 Cowboys, Chargers 23-20 Ravens, Colts 24-22 Dolphins (NFL, Nov 15-16), Man United 4-4 Aston Villa (Premier League, Nov 8), Clippers 113-112 Thunder (NBA, Nov 13): real ESPN play-by-play compressed to about 7 minutes, with NFL, soccer and NBA questions (free throws, timeouts, quarter winners, crunch time). `node scripts/build-replays.mjs` rebuilds them or adds more | `scripts/build-replays.mjs`, `config/replays/` |
| **Model prices + Gemini odds** | Each market opens at the model's probability, calibrated to Gemini; Gemini sits beside the room's price (on real games: Gemini's real price at that moment of the game, from its price history), recorded at open and lock and drawn over time; end-of-game Brier scorecard (Room vs Model vs Gemini); `GET /api/gemini/markets` lists what Gemini is trading now | `lib/gemini.ts`, `lib/lobby.ts` |
| **Announcer** | One caption per event in the game's voice; ElevenLabs TTS when `ELEVENLABS_API_KEY` is set (served to the TV and to the speaker ESP32 through `/api/kiosk/audio`), browser voice otherwise | `lib/announcer.ts`, `lib/tts.ts` |
| **Three ways to play** | LMSR market (default), pool (winners split the pot), head-to-head offers between friends | `lib/modes.ts` |
| **Solana money, invisible** | Demo money by default. `MONEY_MODE=solana`: buy in with **Solana Pay** (scan a QR with any Solana wallet, devnet USDC), cash out to any Solana address; the treasury pays all fees | `lib/solana.ts` |
| **Kickoff design, green + ivory** | The original Huddle "Kickoff" look and motion (kinetic questions, rolling odds, LED-ring countdown, split bar, result flood, confetti, podium) recoloured green on ivory. One kit and one set of tokens for the phones, the TV page and the box preview; the box firmware draws the same design | `components/huddle/` (kit), `app/globals.css` (tokens), `components/phone/`, `components/tv/`, `firmware/kiosk_screen/ui.cpp` |

Data contract, env vars and human setup steps: [`web/CONTRACT.md`](web/CONTRACT.md).

This README is the single source of context for people and agents working on the repo. The original spec is in [docs/](docs/Live%20Lines%20-%20Kiosk%20&%20Watch-Party%20Flow.pdf).

---

## Status (Nov 17, 2026)

| Piece | State |
|---|---|
| Website: lobby, games config, LMSR market, phone page, watch page, web kiosk, kiosk API | **Built and tested locally** in demo mode: full game end to end (create lobby, 2 players join and deposit, trade, auto-lock, resolve, payouts, end, cash out), plus 20 simultaneous buys with no lost trades. `npm run build` passes. |
| LMSR pricing | **Unit tested** against the spec's worked example (`npm test`). |
| Coinbase Onramp deposits + on-chain payouts | **Written against Coinbase's current docs, not yet run** (needs your CDP keys). See [Money](#money). |
| Upstash Redis storage (needed on Vercel) | **Written, not yet run** against a real Upstash instance. Local dev uses memory. |
| Kiosk firmware (ESP32-S3 touchscreen) | **Compiled, flashed and working on the real board** (Nov 17). First flash failed only because PSRAM was off in the IDE settings. See [Kiosk firmware](#kiosk-firmware-esp32-s3-touch-lcd-43). |
| Speaker + second ESP32 | Not built. The site already serves `/api/kiosk/audio` for it, and the watch page plays the sounds meanwhile. |
| NFC | No firmware needed: a passive NFC sticker holding `https://<site>/k/1`. |
| YouTube clip | **Placeholder.** Put a real clip id and timestamps in `web/config/games.json`. |

---

## Repo layout

```
README.md                  <- you are here (all context)
docs/                      <- original spec PDF
web/                       <- the website (Next.js 16, TypeScript). Vercel root directory = web
  config/games.json        <- games, clips, questions, lock timestamps (edit this to add games)
  lib/lmsr.ts              <- pricing math (pure functions, shared by server and phones)
  lib/lobby.ts             <- lobby state machine, trades, payouts, public view
  lib/kiosk.ts             <- what the kiosk shows + what each kiosk tap does
  lib/money.ts             <- demo money, Coinbase Onramp, USDC payouts
  lib/store.ts             <- Upstash Redis (REST) or in-memory store + per-lobby lock
  lib/http.ts, lib/games.ts, lib/types.ts
  app/api/...              <- JSON API (see API reference)
  app/l/[code]             <- phone page
  app/watch/[code]         <- laptop/TV page
  app/kiosk                <- web version of the kiosk screen (same JSON as the ESP32)
  app/k/[kiosk]            <- NFC entry point (redirects to the kiosk's current lobby)
  components/              <- huddle/ (the shared kit: Roll, LockRing, SplitBar, Kinetic, Burst, Avatar, motion), phone/, tv/, KioskView (same layout as firmware), Qr, client helpers
  public/sounds/*.wav      <- join, start, lock, win, tap (from the TapBet prototype)
  test/lmsr.test.mts       <- pricing tests
firmware/kiosk_screen/     <- Arduino sketch for the Waveshare ESP32-S3-Touch-LCD-4.3
  kiosk_screen.ino         <- setup/loop
  config.h                 <- pins, panel timings, app settings
  secrets.example.h        <- copy to secrets.h: Wi-Fi hotspot, SERVER_URL, KIOSK_ID, KIOSK_KEY
  board.cpp/.h             <- panel, CH422G expander (backlight/resets), GT911 touch
  net.cpp/.h               <- Wi-Fi + HTTP on its own task
  ui.cpp/.h                <- draws the screen JSON
.claude/launch.json        <- dev server config for Claude Code's preview
```

The earlier **TapBet** prototype (Express, pooled bets, in-memory) was the starting point. Its kiosk API idea (the firmware draws whatever the server describes) and its sounds were kept. Everything else was rebuilt for the spec: LMSR instead of pools, Vercel-friendly storage, Coinbase instead of Stripe/Solana.

---

## Quick start (local)

Needs Node 20.9+.

```powershell
cd web
npm install
npm run dev
```

Then open:

| URL | What |
|---|---|
| http://localhost:3000 | Home: join by code, links, server status and config warnings |
| http://localhost:3000/kiosk?id=1 | The kiosk screen in a browser (click = touch) |
| http://localhost:3000/l/ABCD | Phone page for lobby ABCD. Add `?seat=2` to be a second player in the same browser |
| http://localhost:3000/watch/ABCD | Watch page (click "Start the watch party" once to allow sound) |
| http://localhost:3000/k/1 | What the NFC tag opens: redirects to kiosk 1's current lobby |

Try a full round without hardware: open `/kiosk?id=1`, tap **Football**, open the lobby link in two tabs (`?seat=2` on the second), join, add test money, tap **Start question 1** on the kiosk, buy YES/NO on the phones, wait for the lock (or tap **Lock now**), tap **It was YES**.

To test with real phones or the ESP32 before the site is on Vercel, run `npm run lan` (production build, listening on every network interface, port 3000) and open `http://<laptop-ip>:3000` on the phones (same Wi-Fi or hotspot as the laptop). Find the IP with `ipconfig` (the Wi-Fi adapter's IPv4 address). Set `PUBLIC_BASE_URL=http://<laptop-ip>:3000` in `web/.env.local` so QR codes point at the laptop and not at `localhost`. The first time, Windows Firewall asks whether Node.js may accept connections: allow it. Phone hotspots often count as "Public" networks, so tick Public too, or set that Wi-Fi network to Private in Windows settings.

Other commands: `npm test` (pricing tests), `npm run typecheck`, `npm run build`.

---

## How it works

### Devices

```
 Kiosk (ESP32 touchscreen)     Phones                       Laptop / TV
 GET /api/kiosk/state  1/s     GET /api/lobby/ABCD 1.5/s    GET /api/lobby/ABCD 1/s
 POST /api/kiosk/touch         POST join/deposit/buy/...    plays YouTube in sync
            \                         |                          /
             +----------- Vercel site (one lobby, shared state) +
                                      |            \
                               Upstash Redis     Coinbase Onramp (deposits), Base USDC (payouts)
```

Real time is **polling** (about once a second). Vercel functions cannot hold websockets, and polling is plenty for a table of friends. If it ever needs to be instant, swap the polling hook (`components/client.ts`) for a hosted pub/sub (Ably, Pusher, Upstash QStash) without touching the game logic.

### Lobby state machine (`web/lib/lobby.ts`)

| Phase | Kiosk shows | Moves on when |
|---|---|---|
| (no lobby) | 4 game tiles (1 live, 3 "Coming soon") | someone taps the live game: a lobby with a 4-letter code is created |
| `lobby` | QR code + code, players and their deposit status | host taps **Start question N** |
| `open` | question, YES ¢ / NO ¢ with arrows, price line, total traded, countdown | countdown hits zero (auto) or host taps **Lock now** |
| `locked` | "Trading closed, watch the play" | host taps **It was YES / NO**, or auto-resolve if the config has `answer` |
| `result` | YES or NO, who won how much (+ sound) | **Next question** (opens it) or **End session** |
| `ended` | final balances | **New game** frees the kiosk (players can still cash out) |

Timed transitions (auto-lock, auto-resolve) are applied whenever anyone reads or writes the lobby, so no background job is needed. Every write goes through `mutate()`, which holds a short per-lobby lock so simultaneous buys never overwrite each other.

**Video sync.** When a question opens, the server records `openedAt`. The watch page plays the clip at `startAt + (now - openedAt)` and re-seeks if it drifts more than 2.5 s. Trading locks at `lockAt` seconds into the clip.

### Pricing: LMSR (`web/lib/lmsr.ts`)

The server keeps two numbers per market: YES shares sold and NO shares sold. `b` sets how fast prices move.

- Cost: `C = b * ln(e^(YES/b) + e^(NO/b))`
- Price of YES: `e^(YES/b) / (e^(YES/b) + e^(NO/b))`, NO = 1 - YES
- A buy costs `C(after) - C(before)`. Phones buy by dollar amount; shares come from the closed-form inverse: `s = b * ln(e^(m/b) + e^((other - mine)/b) * (e^(m/b) - 1))`.
- Each winning share pays $1 (payout rounded down to the cent). Balances are integer cents.
- Worked example (b = 10), checked by `npm test`: 5 YES costs $2.81 and moves YES to 62%, then 4 NO costs $1.70 and YES drops to 52%.
- **Subsidy:** the house can lose at most `b * ln(1/p)` per question, where p is the opening price of the side that wins (`lmsr.maxLoss(b, prior)`): $6.93 at b = 10 for a 50/50 open, up to $29.96 for a question that opens at 5% (model priors do). With demo money that is free. With real money, the treasury must hold that much per question. `housePnl` in the lobby tracks it.
- Prices shown are clamped to 1..99¢. There is no selling yet: players can only buy.

### Games config (`web/config/games.json`)

One entry per tile; the first 4 are shown. Adding a game means adding an entry, not code.

```json
{
  "id": "football", "title": "Football", "subtitle": "4th quarter: defense on the field",
  "live": true, "youtubeId": "<11-char id>", "b": 10,
  "questions": [
    { "id": "int", "text": "Will the defense intercept on the next play?", "short": "Interception next play?",
      "startAt": 0, "lockAt": 45, "resolveAt": 60, "answer": null }
  ]
}
```

- `youtubeId`: the 11 characters after `v=`. The clip must allow embedding.
- `startAt` / `lockAt` / `resolveAt`: seconds into the video. Trading is open from `startAt` to `lockAt`.
- `answer`: `"yes"` / `"no"` makes the question resolve itself at `resolveAt` (good for a known clip when nobody wants to tap). `null` means the host taps the result.
- The config is bundled at build time: redeploy (or restart dev) after editing.

**To do before the demo:** pick a real clip, set `youtubeId`, and set timestamps so `lockAt` is just before the play.

---

## API reference

All JSON. Phones identify themselves with the `x-player-token` header they get from `join` (stored in `localStorage`).

### Kiosk API (the only thing the firmware depends on)

`GET /api/kiosk/state?kiosk=1` returns the screen to draw:

```json
{
  "screen": "market", "kiosk": "1", "color": "amber",
  "title": "Question 1 of 2", "subtitle": "Buy YES or NO on your phone", "footer": "Kiosk 1  -  Lobby XNFK",
  "question": "Will the defense intercept on the next play?",
  "yes": 53, "no": 47, "move": -1, "history": [50, 59, 53], "traded": "$3.00 traded", "lockIn": 20,
  "buttons": [{ "id": "lock", "label": "Lock now", "style": "plain" }]
}
```

| Field | Screens |
|---|---|
| `screen` | `select`, `lobby`, `market`, `locked`, `result`, `ended`. Unknown values draw header + buttons only, so the site can add screens without breaking old firmware |
| `title`, `subtitle`, `footer`, `color` (`blue`/`amber`/`red`/`green`/`gray`) | all |
| `tiles: [{id, label, sub, enabled}]` | `select` |
| `code`, `joinUrl`, `qr: {size, rows: ["0101..."]}`, `players: ["Sam  $10.00"]`, `question` | `lobby` (the QR is generated server side, so the ESP32 needs no QR library) |
| `question`, `yes`, `no` (cents), `move` (1 = YES went up, -1 = NO went up), `history` (cents), `traded`, `lockIn` (s) | `market`, `locked` |
| `result` (`YES`/`NO`), `lines` | `result`, `ended` |
| `buttons: [{id, label, style}]` (`primary`/`yes`/`no`/`plain`) | drawn as a row along the bottom |

`POST /api/kiosk/touch` with body `{"kiosk":"1","id":"<tile or button id>"}` returns the new screen. A refused tap returns HTTP 400 with the current screen plus `"error"`, which the kiosk shows as a toast. Ids: `game:<gameId>`, `start`, `next`, `lock`, `resolve:yes`, `resolve:no`, `end`, `cancel`, `new`. If `KIOSK_KEY` is set on the site, touches need the header `x-kiosk-key`.

`GET /api/kiosk/audio?kiosk=1&after=<last id>` is for the future speaker ESP32. `after=-1` at boot returns the latest id without a sound. Otherwise it returns the next `{id, url, text}` to play (22 kHz mono WAV) or `url: null`. Ids are increasing timestamps, so they never reset between games.

Strings sent to the kiosk are limited to Latin-1, because the firmware fonts are Latin-1.

**v2 fields (optional, additive).** The box renderer also reads `palette`, `game`, `score` (scorebug), `cards` (every game for the scrolling picker; `tiles` stays the first 4), `roster` + `pot` + `calls` (lobby, "Call it!" moments), `volume`, `lockInMs`, `lockTotal`, `model`, `gemini`, `trades` (market), `winners`, `losers`, `lockYes` (result), `leaderboard`, `scorecard` (ended). The full list is at the top of `web/lib/kiosk.ts`; `web/test/kiosk.test.mts` checks both the v1 and v2 shapes.

### Phone / watch API

| Method + path | Body | Returns |
|---|---|---|
| `GET /api/lobby/:code` | (token optional) | lobby view: phase, game, market (prices, history, lockAt, trades, winners), players, results, events, `me`, `money`, `buy` options |
| `POST /api/lobby/:code/join` | `{name}` | `{playerId, token, name}` |
| `POST /api/lobby/:code/deposit` | `{cents}` (one of `money.depositOptions`) | demo: `{credited}`. Coinbase: `{url}` to open |
| `POST /api/lobby/:code/deposit/sync` | | `{credited, pending}`: credits finished Coinbase deposits (idempotent) |
| `POST /api/lobby/:code/buy` | `{side: "yes"/"no", cents}` | `{shares, priceAfter}` |
| `POST /api/lobby/:code/cashout` | `{address}` (only for on-chain payouts) | `{cents, mode, txHash?, explorer?}` |
| `GET /api/health` | | storage mode, money mode, config warnings |
| `GET /api/games` | | games config summary |
| `GET /k/:kiosk` | | 302 to `/l/<current lobby>` (NFC entry) |

---

## Money

Set with env vars (see `web/.env.example`). The default is **demo**: "Add $5 test money" buttons, cash-out just zeroes the balance.

### Coinbase Onramp (`MONEY_MODE=coinbase`)

How a deposit works:

1. A player taps **Deposit $5**. The server creates a Coinbase Onramp session for **USDC on Base** paid to the **treasury address**, tagged with `partnerUserRef = ll-<LOBBY>-<playerId>` (with a `sandbox-` prefix in sandbox mode). It uses `POST https://api.cdp.coinbase.com/platform/v2/onramp/sessions` by default, or the v1 session token flow with `COINBASE_ONRAMP_API=v1`.
2. The phone opens the Coinbase-hosted page. The player pays (card or Coinbase balance) and Coinbase sends USDC to the treasury.
3. Coinbase redirects back to `/l/ABCD?deposit=1`. The phone calls `/deposit/sync` every 3 s. The server asks Coinbase's Transaction Status API (`GET /onramp/v1/buy/user/{partnerUserRef}/transactions`). Each `ONRAMP_TRANSACTION_STATUS_SUCCESS` transaction in USDC on Base to our treasury is credited **once**, keyed by its `transaction_id`. There's also a manual **Check for my deposit** button.

Cash-out with `PAYOUTS=onchain` (real money only) sends the player's whole balance as USDC on Base from the treasury (a CDP Server Wallet account) to the 0x address they enter. If the transfer fails, the balance is put back.

**What I need from you (Coinbase dev account):**

1. In [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com), create a **Secret API key** (Ed25519 recommended). Put its id and secret in `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` in **Vercel env vars**, not in chat or git.
2. Create a **Wallet Secret** (Server Wallet) and put it in `CDP_WALLET_SECRET`. The server then creates or loads a treasury account named `live-lines-treasury`. Its address shows up the first time a deposit is started. Or set `TREASURY_ADDRESS` to a Base address you already control (payouts then need to be done by hand).
3. In the portal, under Onramp, make sure Onramp is enabled for the project and add your Vercel domain to the **Domain Allowlist**. Without it, Coinbase silently ignores the redirect back to the site; the deposit still lands and **Check for my deposit** still works.
4. For real payouts, keep a little ETH on Base in the treasury for gas, plus enough USDC to cover the house subsidy (`b * ln(1/p)` per question, up to $29.96 at b = 10 and a 5% open).
5. Start with `COINBASE_SANDBOX=true` (the default), then switch to `false` for real money.

**Caveats from Coinbase's docs:**

- Coinbase's hosted-onramp page says **guest checkout (debit card / Apple Pay without a Coinbase account) was to be discontinued on June 30, 2026** in favor of their Headless Onramp API. So assume players need a Coinbase account (they can also send USDC they already hold).
- Sandbox is documented as "prefix `partnerUserRef` with `sandbox-`", mainly for the headless API. Whether the hosted page honors it is not confirmed; try one sandbox deposit first.
- The Transaction Status docs disagree on `pageSize` vs `page_size`; the code uses `pageSize` from the API reference.

### Real money

Peer-to-peer betting with real money is regulated as gambling in most places, and the spec itself says to keep the demo to test funds. Real money needs **all of** `MONEY_MODE=coinbase`, `COINBASE_SANDBOX=false` and (for payouts) `PAYOUTS=onchain`, so it can't be switched on by accident. Make sure it is legal where you run it before turning it on.

---

## Deploying to Vercel

1. Push the repo to GitHub and import it in Vercel. **Root Directory: `web`** (framework preset: Next.js).
2. **Storage (required):** Vercel > Storage / Marketplace > **Upstash for Redis** > connect it to the project. It sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` (the code also accepts `UPSTASH_REDIS_REST_*`). Without it, lobbies live in one function instance's memory and randomly vanish; `/api/health` warns about this.
3. Optional env vars: `KIOSK_KEY`, `PUBLIC_BASE_URL`, and the money vars above.
4. Redeploy after editing `config/games.json` or env vars.

---

## Kiosk firmware (ESP32-S3-Touch-LCD-4.3)

**Hardware:** Waveshare ESP32-S3-Touch-LCD-4.3 (Amazon B0CNCRZWVB), 800x480 IPS RGB panel (ST7262), GT911 5-point capacitive touch on I2C, CH422G IO expander (backlight, resets), 8 MB PSRAM. The **4.3B** variant has the same LCD/touch pins and works with the same code.

The firmware draws the kiosk JSON and posts taps. The layout matches `web/components/KioskView.tsx`, so the `/kiosk` page is the preview of what the ESP32 shows. Network runs on its own task (core 0), so touches stay responsive.

### The box renderer (Kickoff design, green + ivory)

`ui.cpp` + `ui_draw.cpp` draw the original Huddle "Kickoff" box UI: a scrollable game picker (league, teams and colours, date, Gemini odds badge), the lobby with QR, code tiles, players sliding in and a "Call it!" grid, the market takeover (gradient sweep, kinetic question, rolling YES/NO prices with payouts, gliding split bar with Model/Gemini notches, stepped price line, recent trades, scorebug on replay games) with the LED-ring countdown that drains pixel by pixel and turns hot in the last 5 s, the lock snap, the result flood in the winner's colour with confetti and "Called it / Cooked" lists, and the podium with scrolling standings.

- **Flicker-free and light.** It draws straight into the 768 KB PSRAM canvas that `board.cpp` already allocates, with anti-aliased shapes and 4-bit anti-aliased fonts (`ui_fonts.h`, cut from the same Bricolage Grotesque / Archivo / Atkinson Hyperlegible files the web uses by `firmware/tools/mkfonts.py`). Each frame it works out which rectangles changed and copies only those rows to the panel. A still screen draws nothing (ambient motion such as the live dot runs at 10 fps); animations run at about 30-40 fps; a full redraw happens only when the screen changes.
- **Touch.** Tap = finger down and up on the same target (pressed state on touch-down, action on release); dragging a list scrolls it with momentum and a rubber band. Every target is at least 64 px tall. Taps are queued to the network task exactly as before.
- **Wi-Fi loss.** The last screen stays up with a "Reconnecting" pill; after 15 s without the site it switches to the connection page (Wi-Fi, IP, last error), and recovers by itself.
- **Data.** Everything still streams from the site (`GET /api/kiosk/state`). The v2 fields (see the top of `web/lib/kiosk.ts`) are optional: missing ones fall back to the v1 fields, so an older site still draws.
- **Unchanged:** `board.cpp`, `net.cpp`, pins, panel timings, touch flags, libraries, board settings and `secrets.h`.

**Upload (one step, Dev):** pull, open `firmware/kiosk_screen/kiosk_screen.ino` in Arduino IDE with the same Tools settings as before (ESP32S3 Dev Module, OPI PSRAM, 8 MB or 16 MB flash), and press Upload. The first compile after pulling takes a few minutes (the fonts are a 1.2 MB header). Or with arduino-cli: `arduino-cli compile --upload -p <port> --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashSize=8M,PartitionScheme=default_8MB" firmware/kiosk_screen`.

**Check it without the board:** `firmware/tools/sim/run.sh <out-dir> http://localhost:3000 1 < script.txt` builds the same `ui.cpp` for the desktop, drives the kiosk API (taps, phones joining, finger drags) and saves PNGs of exactly what the box draws (script commands at the top of `firmware/tools/sim/main.cpp`).

### What the kiosk needs physically

Just the board and one USB-C cable. No other wiring for the screen. The touch panel, backlight and Wi-Fi antenna are all on the board.

- **Flashing:** USB-C cable from the laptop to the port labeled **UART**. It also powers the board.
- **Running:** any 5 V USB-C supply on either port: a phone charger (2 A or more) or a power bank. Weak supplies cause brownout resets when the backlight and Wi-Fi start together.
- **Network:** the board joins your phone hotspot and talks to the site. Before the site is on Vercel, run the site on a laptop on the same hotspot (`npm run lan`) and use `SERVER_URL "http://<laptop-ip>:3000"`.

### First flash, step by step

1. **Display check (no Wi-Fi yet).** Flash without creating `secrets.h`. The screen should show "Live Lines kiosk 1 / Wi-Fi is not set up yet". That proves the build, the panel and the backlight work. Tap the screen with the Serial Monitor open (115200): each tap prints `[touch] x,y`. Tapping near the top-left corner should print small numbers; if not, see the touch flags below.
2. **Wi-Fi + site.** Create `secrets.h` (below), start the site (`npm run lan` on the laptop, or use the Vercel URL), flash again. Expected order: "Connecting to Wi-Fi..." then "Wi-Fi OK (IP ...)" then the 4 game tiles.
3. **Touch.** Tap **Football**: you should get the lobby screen with the QR code. Scan it with a phone on the same network to join.

### Setup

1. **Arduino IDE 2.x** > Boards Manager: install **esp32 by Espressif Systems** (3.x).
2. Library Manager: install exactly these three: **GFX Library for Arduino** by Moon On Our Nation (1.6.x; not "Adafruit GFX"), **U8g2** by oliver (fonts), **ArduinoJson** by Benoit Blanchon (7.x). Wi-Fi, HTTPS and I2C come with the ESP32 board package.
3. Tools menu:
   - Board: **ESP32S3 Dev Module**
   - PSRAM: **OPI PSRAM** (required; it defaults to Disabled, and then the board reboot-loops with a black screen and "no mem for frame buffer" on serial)
   - Flash Size: **16MB (128Mb)**. Our board reported 16 MB via `esptool flash_id` even though Waveshare's docs say 8 MB. **8MB** also works and is safe on either.
   - Partition Scheme: **16M Flash (3MB APP/9.9MB FATFS)** (or **8M with spiffs** if you picked 8MB)
   - USB CDC On Boot: Disabled
   - Upload and Serial Monitor go through the USB-C port labeled **UART**
4. Copy `firmware/kiosk_screen/secrets.example.h` to `secrets.h` and fill in:
   - `WIFI_SSID` / `WIFI_PASSWORD`: your phone hotspot (2.4 GHz; on iPhone turn on *Maximize Compatibility*)
   - `SERVER_URL`: e.g. `https://your-site.vercel.app`, or `http://<laptop-ip>:3000` for local testing
   - `KIOSK_ID`: `"1"`
   - `KIOSK_KEY`: same as the site's `KIOSK_KEY`, or `""`
5. Open `firmware/kiosk_screen/kiosk_screen.ino`, then Upload. Serial monitor runs at 115200.

`secrets.h` is git-ignored. Without it the sketch still builds and shows a "Wi-Fi is not set up yet" screen. The Wi-Fi details really are just those 2 lines, so you can add the hotspot later. If Wi-Fi or the site drops, the screen switches to a connection page (SSID, IP, last error) and recovers by itself.

With arduino-cli instead:

```powershell
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashSize=8M,PartitionScheme=default_8MB" firmware/kiosk_screen
```

### Build times and when to reflash

- The first compile, or any compile after changing a Tools setting, the ESP32 board package or a library, rebuilds everything: several minutes. After that, rebuilds take about a minute.
- Most changes don't need a reflash at all: screens, labels, buttons, games and flow all come from the site. Reflash only to change Wi-Fi or `SERVER_URL` (`secrets.h`), or the drawing code in `ui.cpp`.
- Upload needs no button presses on the UART port (auto-reset). Close the Serial Monitor before uploading.

### Troubleshooting

Things to check if a flash misbehaves:

- **Compile error in the `Arduino_ESP32RGBPanel(...)` call:** an older GFX library; update to 1.6.x, or remove the last four constructor arguments.
- **Blank screen, serial says panel begin failed:** PSRAM is not set to OPI PSRAM.
- **Image shifted or flickering:** try Waveshare's timings in `config.h` (hsync/vsync pulse 4, back porch 8, front porch 8). If it drifts while Wi-Fi is busy, raise `LCD_BOUNCE_BUFFER_PX` to `SCR_W * 20`.
- **Touches in the wrong place:** flip `TOUCH_SWAP_XY` / `TOUCH_INVERT_X` / `TOUCH_INVERT_Y` in `config.h`. Serial prints every tap's coordinates and the button it hit.
- **"GT911 not found" on serial:** the touch reset sequence (CH422G EXIO1 + GPIO4) didn't take; power-cycle the board.
- **Brownout resets when the backlight turns on:** the backlight is switched on before Wi-Fi starts for this reason; use a solid 5 V supply.
- **HTTPS:** the firmware skips certificate checks (`setInsecure`) to keep the demo simple.
- The CH422G byte sequence (`0x01` to address `0x24`, outputs to `0x38`) follows the CH422 datasheet and ESP_IOExpander's driver. It isn't in Waveshare's docs pages, so it's a first suspect if the backlight stays off.

### NFC tap

No hardware code needed. The tap is a **passive NFC sticker** (NTAG213/215) that always holds the same link, `https://<your-site>/k/1`. The site redirects that link to whatever lobby kiosk 1 is running right now, so the sticker never has to change between games. Phones without NFC scan the QR code on the lobby screen.

**Writing the sticker:** in a writer app on your phone (for example "NFC Tools": Write > Add a record > URL), enter the URL, then write it to the sticker. Don't use the app's "lock tag" option, so you can rewrite it once the Vercel URL exists. For local testing write `http://<laptop-ip>:3000/k/1` instead.

**Placing it:**
- Put it on the enclosure where people naturally tap, for example a "Tap phone here" spot on the front, below or beside the screen. Mark it with an icon.
- Don't put it **on** the screen or directly on the board: metal (the LCD's back plate, the PCB's copper) stops a plain sticker from working. Keep it 1 cm or more from the board, or use an "anti-metal" NFC sticker.
- Plastic is fine: stick it on the inside of a thin (1-2 mm) printed wall, or on the outside.
- iPhones read from the top edge of the back; most Androids from the middle of the back (NFC must be on in settings). Test with both before the demo.

**About the PN532:** it isn't needed for the demo, and it should not go on the screen board. The PN532's I2C address is 0x24, which is one of the addresses the screen board's CH422G IO expander uses on the same I2C bus (SDA 8 / SCL 9). Wiring it there would break the backlight and touch. A PN532 also can't reliably read a phone (iPhones don't act as a readable tag). If you want a "tap detected" effect later, it could go on the second ESP32 (the speaker one).

### Speaker and second ESP32 (later)

Planned: a second ESP32 with an I2S amp (e.g. MAX98357A) that polls `GET /api/kiosk/audio?kiosk=1&after=<id>` once a second and plays the WAV URL it gets (see the API reference). The server side already exists. Until then the **watch page** plays the same sounds and reads the result aloud.

---

## Decisions on the spec's open questions

| Question | Decision |
|---|---|
| Kiosk hardware: ESP32 + on-device UI, or Raspberry Pi + browser? | ESP32-S3 touchscreen drawing server-sent JSON (no LVGL, no QR library on device). `/kiosk` is the same screen in a browser, so a tablet or Pi works as a fallback |
| Real-time: polling or hosted real-time? | Polling about every second |
| Onramp provider | Coinbase Onramp (USDC on Base) + CDP Server Wallet for payouts |
| Resolving markets | Host taps YES/NO on the kiosk. Optional auto-resolve from config (`answer` + `resolveAt`). AI resolution is a later add-on |
| Subsidy | LMSR. House covers up to `b * ln(1/p)` per question (p = opening price of the winning side; `b * ln 2` at 50/50). The pooled-bet fallback from the spec is not implemented (TapBet had it) |
| Real money | Off by default. Needs three env flags. Legal note above |
| Other 3 games | Basketball, Soccer, Tennis as "Coming soon" tiles (change in games.json) |

## Known limitations / next steps

- No selling of shares; one question at a time per lobby; max 12 players per lobby.
- Lobbies expire 24 h after their last change (Redis TTL). Balances are not tied to accounts across lobbies.
- Anyone at the kiosk can tap the result (fine for friends; add a host PIN if needed).
- Phones authenticate with a random token in `localStorage`. Clearing it means rejoining as a new player (old balance stays on the old player).
- Coinbase webhooks (`onramp.transaction.*`) could replace the deposit polling.

## Notes for agents

- **The firmware contract is `web/lib/kiosk.ts`.** If you change field names there, change `firmware/kiosk_screen/ui.cpp` and `web/components/KioskView.tsx` too. Adding new optional fields or screens is safe: old firmware ignores them.
- Never put game logic in the firmware. Make the site decide and send it.
- Money is integer **cents** everywhere except inside `lmsr.ts` (dollars and shares).
- Every lobby write goes through `mutate()` in `lib/lobby.ts` (lock + timers + version bump). Don't write lobby JSON anywhere else.
- `lib/lmsr.ts` must stay dependency-free: the phone page imports it for trade previews.
- Secrets live only in env vars (`web/.env.local`, Vercel) and `firmware/kiosk_screen/secrets.h`. All are git-ignored.

## Sources

- Coinbase: [create onramp session (v2)](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/onramp/create-an-onramp-session), [session token (v1)](https://docs.cdp.coinbase.com/api-reference/rest-api/onramp-offramp/create-session-token), [transaction status](https://docs.cdp.coinbase.com/onramp/core-features/transaction-status), [hosted onramp overview](https://docs.cdp.coinbase.com/onramp/coinbase-hosted-onramp/overview), [session token auth](https://docs.cdp.coinbase.com/onramp-&-offramp/session-token-authentication)
- Waveshare: [ESP32-S3-Touch-LCD-4.3 docs](https://docs.waveshare.com/ESP32-S3-Touch-LCD-4.3), [4.3B docs](https://docs.waveshare.com/ESP32-S3-Touch-LCD-4.3B), [Arduino_GFX example for this board](https://github.com/Westcott1/Waveshare-ESP32-S3-Touch-LCD-4.3-and-Arduino), [ESP32_Display_Panel board configs](https://github.com/esp-arduino-libs/ESP32_Display_Panel)
- [Arduino_GFX](https://github.com/moononournation/Arduino_GFX), [U8g2 font list](https://github.com/olikraus/u8g2/wiki/fntlistall)
