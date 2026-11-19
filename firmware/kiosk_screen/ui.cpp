// Huddle box screen renderer ("Kickoff" design in green + ivory). See ui.h.
//
// How a frame works: the scene is a pure function of (screen JSON, touch/scroll state, time). Each frame it runs
// once with an empty clip to collect hit areas and the rectangles that are animating ("measure"), then once per
// dirty rectangle with that clip ("draw"), and only those rectangles are copied to the panel. A still screen
// costs nothing; a countdown ring costs a 180 x 180 patch; screen changes redraw everything once.
//
// Motion follows DESIGN.md: resting state = final state (every entrance is a function of time since the screen
// appeared, so it always finishes), springs for arrivals, digits roll, the split seam glides, the lock ring
// drains pixel by pixel and turns hot in the last 5 s, the lock snaps, the winner floods the stage.
#include "ui.h"
#include <ArduinoJson.h>
#include <math.h>
#include <stddef.h>
#include "config.h"
#include "ui_draw.h"
#include "ui_fonts.h"

using namespace dr;

// ================================================================ palette (shared design tokens)

struct Palette {
  uint16_t canvas, card, well, rule, ruleStrong, ink, ink2, muted, accent, deep, lime, yes, yes600, no, no600, hot,
      gold, white, accentTint, goldTint, yesTint, noTint;
};
static Palette P;
static void defaultPalette() {
  // Dark, calm look: black canvas, beige ink and highlights, muted green / red for YES / NO and win / lose.
  P.canvas = rgb(0x000000);
  P.card = rgb(0x111111);
  P.well = rgb(0x1A1A1A);
  P.rule = rgb(0x262626);
  P.ruleStrong = rgb(0x3A3A3A);
  P.ink = rgb(0xE9DFC9);
  P.ink2 = rgb(0xBDB4A2);
  P.muted = rgb(0x8A8479);  // AA on black, card and well
  P.accent = rgb(0xE9DFC9);
  P.deep = rgb(0xCFC3A8);
  P.lime = rgb(0x3DBE84);
  P.yes = rgb(0x3DBE84);
  P.yes600 = rgb(0x2E9C6B);
  P.no = rgb(0xE5615A);
  P.no600 = rgb(0xC24A44);
  P.hot = rgb(0xE5615A);
  P.gold = rgb(0xD9B36C);
  P.white = rgb(0x0A0A0A);  // text on a filled button: near-black on beige / green / red
  P.accentTint = rgb(0x26231C);
  P.goldTint = rgb(0x2A2418);
  P.yesTint = rgb(0x10261C);
  P.noTint = rgb(0x2B1513);
}

// ================================================================ screen model (parsed once per JSON)

enum Scr : uint8_t { S_NONE, S_SELECT, S_LOBBY, S_MARKET, S_LOCKED, S_RESULT, S_ENDED, S_MESSAGE };
enum Style : uint8_t { B_PLAIN, B_PRIMARY, B_YES, B_NO, B_BRAND, B_CALL, B_INK, B_WHITE };

struct Btn {
  char id[40];
  char label[40];
  uint8_t style;
  bool enabled;
};
struct Team {
  char name[32];
  char nick[20];  // what fans call the team ("49ers"); the card draws it when the server sends one
  char abbr[8];
  uint16_t color;
  bool has;
};
struct GameCard {
  char id[40];
  char title[48];
  char sub[64];
  char league[16];
  char date[28];
  char kind[8];
  Team home, away;
  uint16_t color;
  bool enabled, gemini, hasColor;
  bool at;  // "Away at Home" (US style, away drawn first) instead of "Home v Away"
};
struct Person {
  char name[24];
  int32_t cents;  // roster: balance; winners: payout; losers: lost; board: final total
  int32_t extra;  // roster: deposited; winners: profit; board: P&L
  bool has2;
  int16_t rank;  // board: shared on a tie (0 = not sent)
};
struct TradeRow {
  char name[24];
  bool yes;
  int32_t cents;
  int16_t price;
};

static const int MAX_CARDS = 16, MAX_PEOPLE = 16, MAX_BTN = 8, MAX_HIST = 64, MAX_LINES = 10;
static const int MAX_CHART = 64, MAX_ODDS = 10, ODDS_HIST = 32;
static const int PAY_QR = 96;  // pay QR up to 96 modules (version 19; a solana: URL at ECC L is version 9-11)

// The odds graph under the market / locked / result view (JSON "chart").
struct Chart {
  bool has, hasGem;
  int16_t n;
  int8_t room[MAX_CHART];  // YES price 0-100
  int8_t gem[MAX_CHART];   // Gemini 0-100, -1 = no price then
  int16_t model;           // -1 = none
  int16_t span;            // x 0-100 where the samples end
  int16_t lock;            // x 0-100 of the lock, -1 = none
  char outcome;            // 'Y', 'N', 0
  char x0[16], x1[16];
};
struct OddsRow {
  char label[84];
  bool room;  // the room's open question (else a Gemini market)
  int16_t p;
  uint8_t nHist;
  int8_t hist[ODDS_HIST];
};

struct Screen {
  Scr scr;
  char title[96], subtitle[160], footer[48], code[12], joinUrl[96], question[220], traded[40];
  char gameTitle[64], mode[12], moment[24], verdict[120], caption[200], error[96];
  int yes, no, move, lockIn, lockInMs, lockTotal, volume, pot, model, gemini, lockYes;
  bool geminiLive, hasLock, hasWinners;
  bool boardTie;  // the site sent ranks and nobody is strictly ahead: no crown, no highlighted row
  char geminiLabel[40];
  char result;  // 'Y', 'N' or 0
  int16_t hist[MAX_HIST];
  int nHist;
  uint8_t qrSize;
  uint8_t qr[64][8];
  Btn buttons[MAX_BTN];
  int nButtons;
  Btn calls[MAX_BTN];
  int nCalls;
  GameCard cards[MAX_CARDS];
  int nCards;
  Person roster[MAX_PEOPLE], winners[MAX_PEOPLE], losers[MAX_PEOPLE], board[MAX_PEOPLE];
  int nRoster, nWinners, nLosers, nBoard;
  TradeRow trades[8];
  int nTrades;
  char lines[MAX_LINES][64];
  int nLines;
  bool hasScore;
  Team home, away;
  int homeScore, awayScore;
  char clock[12], period[12], scoreStatus[8];
  int scRoom, scModel, scGemini;  // Brier x1000, -1 = none
  // Solana Pay card on top of any screen (JSON "pay"). payLeftMs ticks every poll: not part of the redraw test.
  bool hasPay, payPaid;
  char payName[24];
  int32_t payCents, payLeftMs;
  uint8_t payQrSize;  // 0 = no QR (the URL did not fit)
  uint8_t payQr[PAY_QR][PAY_QR / 8];
  // ---- page sections below the view. Compared by hash, so a new price there redraws only that section.
  Chart chart;
  OddsRow odds[MAX_ODDS];
  int nOdds;
  char oddsNote[144];
  Person stand[MAX_PEOPLE];
  int nStand;
  bool standTie;
  uint32_t chartHash, oddsHash, standHash;
  // ---- box-only extras (optional JSON; missing = nothing drawn). leftMs values tick: not in xHash.
  int16_t betsN, betsOf;  // betsIn {n, of}; betsOf 0 = none
  bool hasHot, hasTip, hasFlash, hasConfirm, hasInter;
  char hotName[24], tipLabel[24], tipText[140], flashName[24], flashText[64], confName[24];
  int16_t hotMult;
  char flashKind;  // 'j' join, 'w' bigwin, 'l' bigloss
  bool confYes;
  int32_t flashCents, confCents, hotLeft, flashLeft, confLeft, interLeft;
  uint32_t xHash;
};
#define SCREEN_CORE offsetof(Screen, chart)  // memcmp up to here decides a full redraw

static Screen *cur = nullptr, *nxt = nullptr;
static JsonDocument doc;
static bool haveScreen = false;
static uint32_t recvAt = 0;

// ================================================================ time + easing

static uint32_t NOW = 0;
static float clampf(float v, float a, float b) { return v < a ? a : v > b ? b : v; }
static float prog(uint32_t t0, int delay, int dur) {
  int32_t dt = (int32_t)(NOW - t0) - delay;
  if (dt <= 0) return 0;
  return dt >= dur ? 1.f : dt / (float)dur;
}
static float eOut(float t) {
  float u = 1 - clampf(t, 0, 1);
  return 1 - u * u * u;
}
static float eBack(float t, float s = 1.5f) {  // spring-ish settle with overshoot
  t = clampf(t, 0, 1);
  float u = t - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
}
static float eSnap(float t) {
  t = clampf(t, 0, 1);
  return t < .5f ? 16 * t * t * t * t * t : 1 - powf(-2 * t + 2, 5) / 2;
}

// ================================================================ frame bookkeeping

static bool measuring = false;
static Rect dirty[16];
static int nDirty = 0;
static bool fullDirty = true;
// Page scrolling: market, locked and result are taller than the screen. Their drawing code uses page
// coordinates; pageY is how far the page is scrolled (screen y = page y - pageY). Marks, hits, clips and scroll
// views convert here, so every component works unchanged inside a page. 0 everywhere else.
static int pageY = 0;

static void markR(Rect r) {
  if (!measuring || r.empty()) return;
  r.y -= pageY;
  if (r.x < 0) { r.w += r.x; r.x = 0; }
  if (r.y < 0) { r.h += r.y; r.y = 0; }
  if (r.x + r.w > SCR_W) r.w = SCR_W - r.x;
  if (r.y + r.h > SCR_H) r.h = SCR_H - r.y;
  if (r.empty()) return;
  for (int i = 0; i < nDirty; i++) {  // merge with an overlapping rect
    Rect &d = dirty[i];
    if (r.x <= d.x + d.w + 8 && d.x <= r.x + r.w + 8 && r.y <= d.y + d.h + 8 && d.y <= r.y + r.h + 8) {
      int x0 = min(d.x, r.x), y0 = min(d.y, r.y), x1 = max(d.x + d.w, r.x + r.w), y1 = max(d.y + d.h, r.y + r.h);
      d = {(int16_t)x0, (int16_t)y0, (int16_t)(x1 - x0), (int16_t)(y1 - y0)};
      return;
    }
  }
  if (nDirty < 16) dirty[nDirty++] = r;
  else fullDirty = true;
}
static void mark(int x, int y, int w, int h) { markR({(int16_t)x, (int16_t)y, (int16_t)w, (int16_t)h}); }
// Ambient motion (live dot, ping on the price line, breathing dots) only redraws at 10 fps, so a still screen
// stays almost idle while it keeps a little life.
static bool ambientTick = false;
static void markAmbient(int x, int y, int w, int h) {
  if (ambientTick) mark(x, y, w, h);
}

// Clip stack (intersecting).
static Rect clipStack[8];
static int clipDepth = 0;
static void pushClip(int x, int y, int w, int h) {
  y -= pageY;
  Rect c = getClip();
  if (clipDepth < 8) clipStack[clipDepth++] = c;
  int x0 = max<int>(c.x, x), y0 = max<int>(c.y, y), x1 = min<int>(c.x + c.w, x + w), y1 = min<int>(c.y + c.h, y + h);
  clip({(int16_t)x0, (int16_t)y0, (int16_t)max(0, x1 - x0), (int16_t)max(0, y1 - y0)});
}
static void popClip() {
  if (clipDepth > 0) clip(clipStack[--clipDepth]);
}

// ================================================================ touch, hits, scrolling

struct Hit {
  Rect r;
  char id[40];
};
static Hit hits[48];
static int nHits = 0;
static void hit(int x, int y, int w, int h, const char *id) {
  if (!measuring || !id || !id[0] || nHits >= 48) return;
  // Clip hits to the current clip's measure-time view (scroll areas set it) by the caller. In a page: to the screen.
  y -= pageY;
  if (y < 0) {
    h += y;
    y = 0;
  }
  if (y + h > SCR_H) h = SCR_H - y;
  if (h <= 0 || w <= 0) return;
  hits[nHits].r = {(int16_t)x, (int16_t)y, (int16_t)w, (int16_t)h};
  strlcpy(hits[nHits].id, id, sizeof(hits[nHits].id));
  nHits++;
}

struct Scroller {
  Rect view;
  float off, vel, maxOff, dragFrom;
  uint32_t lastMove;
  bool used;
  // The page (scrolls[PAGE]): full-screen, moved by shifting the frame buffer; snaps to its sections.
  bool snapping;
  float snapTo;
  int16_t snaps[6];
  int nSnaps;
};
static const int PAGE = 3;  // scrolls[PAGE] is the page scroller of market / locked / result
static Scroller scrolls[4];
static int scrollCount = 0;  // registered this frame
static uint32_t lastScrollStep = 0;
static uint32_t lastTouchAt = 0;  // any finger down (the page glides home after a minute untouched)

struct TouchState {
  bool down, dragging;
  int16_t x0, y0, x, y;
  uint32_t t0, lastT;
  float lastY, vel;
  char id[40];
  int scroll;
} T = {};

static char tapped[40] = "";       // the id we just sent (pending until the server answers)
static uint32_t tappedAt = 0;
static char released[40] = "";     // spring back after release
static uint32_t releasedAt = 0;

static bool isPressed(const char *id) { return T.down && !T.dragging && id && !strcmp(T.id, id); }
static bool isPending(const char *id) { return tapped[0] && id && !strcmp(tapped, id) && NOW - tappedAt < 2500; }

// Scroll area: call while drawing; returns the offset to apply. contentH = full height of the content.
static float scrollArea(int idx, int x, int y, int w, int h, int contentH) {
  Scroller &s = scrolls[idx];
  s.view = {(int16_t)x, (int16_t)(y - pageY), (int16_t)w, (int16_t)h};
  s.maxOff = max(0, contentH - h);
  s.used = true;
  if (idx + 1 > scrollCount) scrollCount = idx + 1;
  return s.off;
}

static void resetScrolls(bool keepPage = false) {
  for (int i = 0; i < 4; i++)
    if (!(keepPage && i == PAGE)) scrolls[i] = {};
}

// Glide the page to an offset (snaps, "Back to top", the More tab).
static void pageGlide(float to) {
  Scroller &p = scrolls[PAGE];
  p.vel = 0;
  p.snapTo = clampf(to, 0, max(0.f, p.maxOff));
  p.snapping = true;
  p.lastMove = NOW;
}

// Proximity snap: when the page comes to rest near the top of a section, it settles there (like the web page).
static bool pageSnap() {
  Scroller &p = scrolls[PAGE];
  if (p.off < 0 || p.off > p.maxOff) return false;  // the rubber band handles the ends
  int best = -1;
  float bd = 1e9f;
  for (int i = 0; i < p.nSnaps; i++) {
    float d = fabsf(p.snaps[i] - p.off);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  if (best < 0 || bd < 0.5f || bd >= 90) return false;
  pageGlide(p.snaps[best]);
  return true;
}

// ================================================================ parsing

static uint16_t parseHex(const char *s, uint16_t def) {
  if (!s || !s[0]) return def;
  if (*s == '#') s++;
  if (strlen(s) != 6) return def;
  char *end;
  uint32_t v = strtoul(s, &end, 16);
  return *end ? def : rgb(v);
}

static void cpy(char *dst, size_t cap, JsonVariantConst v) { strlcpy(dst, v | "", cap); }
#define CPY(dst, v) cpy(dst, sizeof(dst), v)

static uint8_t styleOf(const char *s) {
  if (!strcmp(s, "primary")) return B_PRIMARY;
  if (!strcmp(s, "yes")) return B_YES;
  if (!strcmp(s, "no")) return B_NO;
  if (!strcmp(s, "brand")) return B_BRAND;
  if (!strcmp(s, "call")) return B_CALL;
  return B_PLAIN;
}

static void parseTeam(Team &t, JsonVariantConst v, uint16_t def) {
  memset(&t, 0, sizeof(t));
  if (v.is<const char *>()) {
    CPY(t.name, v);
  } else if (v.is<JsonObjectConst>()) {
    CPY(t.name, v["name"]);
    CPY(t.nick, v["nick"]);
    const char *a = v["short"] | (v["abbr"] | "");
    strlcpy(t.abbr, a, sizeof(t.abbr));
    t.color = parseHex(v["color"] | "", def);
  } else {
    return;
  }
  if (!t.color) t.color = def;
  if (!t.abbr[0]) {  // first 3 letters
    int n = 0;
    for (const char *p = t.name; *p && n < 3; p++)
      if (isalpha((uint8_t)*p)) t.abbr[n++] = toupper((uint8_t)*p);
    t.abbr[n] = 0;
  }
  t.has = t.name[0] != 0;
}

static void parsePeople(Person *out, int &n, JsonArrayConst arr, const char *k1, const char *k2) {
  n = 0;
  for (JsonVariantConst v : arr) {
    if (n >= MAX_PEOPLE) break;
    Person &p = out[n];
    memset(&p, 0, sizeof(p));
    if (v.is<const char *>()) {
      CPY(p.name, v);
    } else {
      CPY(p.name, v["name"]);
      p.cents = v[k1] | 0;
      p.has2 = !v[k2].isNull();
      p.extra = v[k2] | 0;
      p.rank = (int16_t)constrain((int32_t)(v["rank"] | 0), (int32_t)0, (int32_t)99);
    }
    n++;
  }
}

static uint32_t memHash(const void *p, size_t n) {
  const uint8_t *b = (const uint8_t *)p;
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < n; i++) h = (h ^ b[i]) * 16777619u;
  return h;
}
static int pct(JsonVariantConst v, int def) {  // 0-100, clamped; def when missing or not a number
  if (!v.is<float>() && !v.is<int>()) return def;
  return constrain((int)lroundf(v.as<float>()), 0, 100);
}

// Page sections and the pay card (all optional; missing fields leave them empty and the page short).
static void parsePage(Screen &s, JsonObjectConst j) {
  JsonObjectConst ch = j["chart"].as<JsonObjectConst>();
  if (!ch.isNull()) {
    Chart &c = s.chart;
    for (JsonVariantConst v : ch["room"].as<JsonArrayConst>()) {
      if (c.n >= MAX_CHART) break;
      c.room[c.n++] = (int8_t)pct(v, 50);
    }
    int g = 0;
    for (JsonVariantConst v : ch["gemini"].as<JsonArrayConst>()) {
      if (g >= c.n) break;
      c.gem[g] = (int8_t)pct(v, -1);
      if (c.gem[g] >= 0) c.hasGem = true;
      g++;
    }
    for (; g < MAX_CHART; g++) c.gem[g] = -1;
    if (c.n == 1) c.room[c.n++] = c.room[0];  // one sample: a flat line
    c.has = c.n >= 2;
    c.model = (int16_t)pct(ch["model"], -1);
    c.span = (int16_t)pct(ch["span"], 100);
    if (c.span < 1) c.span = 1;
    c.lock = (int16_t)pct(ch["lock"], -1);
    const char *o = ch["outcome"] | "";
    c.outcome = !strcmp(o, "YES") ? 'Y' : !strcmp(o, "NO") ? 'N' : 0;
    CPY(c.x0, ch["x0"]);
    CPY(c.x1, ch["x1"]);
  }
  for (JsonVariantConst v : j["odds"].as<JsonArrayConst>()) {
    if (s.nOdds >= MAX_ODDS) break;
    OddsRow &r = s.odds[s.nOdds];
    CPY(r.label, v["label"]);
    if (!r.label[0]) continue;
    r.room = !strcmp(v["source"] | "", "room");
    r.p = (int16_t)pct(v["p"], 50);
    for (JsonVariantConst h : v["hist"].as<JsonArrayConst>()) {
      if (r.nHist >= ODDS_HIST) break;
      r.hist[r.nHist++] = (int8_t)pct(h, r.p);
    }
    s.nOdds++;
  }
  CPY(s.oddsNote, j["oddsNote"]);
  parsePeople(s.stand, s.nStand, j["standings"].as<JsonArrayConst>(), "cents", "pnl");
  s.standTie = s.nStand > 0 && !(j["standings"][0]["lead"] | false);
  s.chartHash = memHash(&s.chart, sizeof(s.chart));
  s.oddsHash = memHash(s.odds, sizeof(s.odds)) ^ memHash(s.oddsNote, sizeof(s.oddsNote)) ^ (uint32_t)s.nOdds;
  s.standHash = memHash(s.stand, sizeof(s.stand)) ^ (uint32_t)s.nStand * 977u ^ (s.standTie ? 1u : 0u);

  // box-only extras
  s.betsN = s.betsOf = 0;
  s.hasHot = s.hasTip = s.hasFlash = s.hasConfirm = s.hasInter = false;
  {
    JsonObjectConst b = j["betsIn"].as<JsonObjectConst>();
    if (!b.isNull()) {
      s.betsOf = constrain((int)(b["of"] | 0), 0, 99);
      s.betsN = constrain((int)(b["n"] | 0), 0, (int)s.betsOf);
    }
    JsonObjectConst h = j["hotseat"].as<JsonObjectConst>();
    if (!h.isNull()) {
      s.hasHot = true;
      CPY(s.hotName, h["name"]);
      s.hotMult = constrain((int)(h["mult"] | 2), 1, 99);
      s.hotLeft = constrain((int32_t)(h["leftMs"] | 0), (int32_t)0, (int32_t)600000);
    }
    JsonObjectConst t = j["tip"].as<JsonObjectConst>();
    if (!t.isNull()) {
      CPY(s.tipLabel, t["label"]);
      CPY(s.tipText, t["text"]);
      s.hasTip = s.tipText[0] != 0;
    }
    JsonObjectConst f = j["flash"].as<JsonObjectConst>();
    if (!f.isNull()) {
      s.hasFlash = true;
      const char *k = f["kind"] | "join";
      s.flashKind = !strcmp(k, "bigwin") ? 'w' : !strcmp(k, "bigloss") ? 'l' : 'j';
      CPY(s.flashName, f["name"]);
      CPY(s.flashText, f["text"]);
      s.flashCents = constrain((int32_t)(f["cents"] | 0), (int32_t)0, (int32_t)100000000);
      s.flashLeft = constrain((int32_t)(f["leftMs"] | 0), (int32_t)0, (int32_t)60000);
    }
    JsonObjectConst c = j["confirm"].as<JsonObjectConst>();
    if (!c.isNull()) {
      s.hasConfirm = true;
      CPY(s.confName, c["name"]);
      s.confYes = strcmp(c["side"] | "YES", "NO") != 0;
      s.confCents = constrain((int32_t)(c["cents"] | 0), (int32_t)0, (int32_t)100000000);
      s.confLeft = constrain((int32_t)(c["leftMs"] | 0), (int32_t)0, (int32_t)600000);
    }
    JsonObjectConst in = j["interlude"].as<JsonObjectConst>();
    if (!in.isNull()) {
      s.hasInter = true;
      s.interLeft = constrain((int32_t)(in["leftMs"] | 0), (int32_t)0, (int32_t)600000);
    }
    uint32_t hh = (uint32_t)s.betsN * 131u + (uint32_t)s.betsOf * 7u;
    hh ^= (s.hasHot ? 1u : 0) | (s.hasTip ? 2u : 0) | (s.hasFlash ? 4u : 0) | (s.hasConfirm ? 8u : 0) | (s.hasInter ? 16u : 0);
    hh ^= memHash(s.hotName, sizeof(s.hotName)) * 3u ^ memHash(s.tipText, sizeof(s.tipText)) * 5u;
    hh ^= memHash(s.flashText, sizeof(s.flashText)) * 7u ^ memHash(s.confName, sizeof(s.confName)) * 11u;
    hh ^= memHash(s.flashName, sizeof(s.flashName)) * 13u ^ memHash(s.tipLabel, sizeof(s.tipLabel)) * 17u;
    hh ^= (uint32_t)s.hotMult * 19u ^ (uint32_t)s.confCents * 23u ^ (uint32_t)s.flashCents * 29u ^ (s.confYes ? 64u : 0);
    s.xHash = hh;
  }

  JsonObjectConst pay = j["pay"].as<JsonObjectConst>();
  if (!pay.isNull()) {
    s.hasPay = true;
    CPY(s.payName, pay["name"]);
    s.payCents = constrain((int32_t)(pay["cents"] | 0), (int32_t)0, (int32_t)100000000);
    s.payLeftMs = constrain((int32_t)(pay["leftMs"] | 0), (int32_t)0, (int32_t)86400000);
    s.payPaid = pay["paid"] | false;
    int size = pay["qr"]["size"] | 0;
    if (size > 0 && size <= PAY_QR) {
      s.payQrSize = size;
      int r = 0;
      for (JsonVariantConst row : pay["qr"]["rows"].as<JsonArrayConst>()) {
        if (r >= size) break;
        const char *bits = row | "";
        for (int c = 0; c < size && bits[c]; c++)
          if (bits[c] == '1') s.payQr[r][c >> 3] |= 1 << (c & 7);
        r++;
      }
    }
  }
}

static void parseInto(Screen &s, JsonObjectConst j) {
  memset(&s, 0, sizeof(Screen));
  const char *scr = j["screen"] | "";
  s.scr = !strcmp(scr, "select") ? S_SELECT
          : !strcmp(scr, "lobby") ? S_LOBBY
          : !strcmp(scr, "market") ? S_MARKET
          : !strcmp(scr, "locked") ? S_LOCKED
          : !strcmp(scr, "result") ? S_RESULT
          : !strcmp(scr, "ended") ? S_ENDED
                                  : S_MESSAGE;
  CPY(s.title, j["title"]);
  CPY(s.subtitle, j["subtitle"]);
  CPY(s.footer, j["footer"]);
  CPY(s.code, j["code"]);
  CPY(s.joinUrl, j["joinUrl"]);
  CPY(s.question, j["question"]);
  CPY(s.traded, j["traded"]);
  CPY(s.mode, j["mode"]);
  CPY(s.moment, j["moment"]);
  CPY(s.error, j["error"]);
  CPY(s.gameTitle, j["game"]["title"]);
  s.yes = j["yes"] | 50;
  s.no = j["no"] | (100 - s.yes);
  s.move = j["move"] | 0;
  s.hasLock = !j["lockIn"].isNull();
  s.lockIn = constrain((int32_t)(j["lockIn"] | 0), (int32_t)0, (int32_t)86400);  // clamp: no overflow below
  s.lockInMs = constrain((int32_t)(j["lockInMs"] | (s.lockIn * 1000)), (int32_t)0, (int32_t)86400000);
  s.lockTotal = constrain((int32_t)(j["lockTotal"] | 0), (int32_t)0, (int32_t)86400);
  s.volume = j["volume"] | -1;
  s.pot = j["pot"] | -1;
  s.model = j["model"].isNull() ? -1 : (int)(j["model"] | -1);
  JsonVariantConst gm = j["gemini"];
  s.gemini = -1;
  if (gm.is<JsonObjectConst>() && !gm["cents"].isNull()) {
    s.gemini = gm["cents"] | -1;
    s.geminiLive = gm["live"] | false;
    CPY(s.geminiLabel, gm["label"]);
  }
  s.lockYes = j["lockYes"] | -1;
  const char *res = j["result"] | "";
  s.result = !strcmp(res, "YES") ? 'Y' : !strcmp(res, "NO") ? 'N' : 0;
  for (JsonVariantConst v : j["history"].as<JsonArrayConst>()) {
    if (s.nHist >= MAX_HIST) break;
    s.hist[s.nHist++] = v | 50;
  }
  // QR as bits.
  int size = j["qr"]["size"] | 0;
  if (size > 0 && size <= 64) {
    s.qrSize = size;
    int r = 0;
    for (JsonVariantConst row : j["qr"]["rows"].as<JsonArrayConst>()) {
      if (r >= size) break;
      const char *bits = row | "";
      for (int c = 0; c < size && bits[c]; c++)
        if (bits[c] == '1') s.qr[r][c >> 3] |= 1 << (c & 7);
      r++;
    }
  }
  // Buttons: "Call it!" moments go to their own grid; the rest stay buttons.
  for (JsonVariantConst b : j["buttons"].as<JsonArrayConst>()) {
    const char *id = b["id"] | "";
    bool isCall = !strncmp(id, "moment:", 7);
    if (isCall && !j["calls"].isNull()) continue;
    Btn *dst = isCall ? (s.nCalls < MAX_BTN ? &s.calls[s.nCalls++] : nullptr) : (s.nButtons < MAX_BTN ? &s.buttons[s.nButtons++] : nullptr);
    if (!dst) continue;
    CPY(dst->id, b["id"]);
    CPY(dst->label, b["label"]);
    dst->style = isCall ? B_CALL : styleOf(b["style"] | "plain");
    dst->enabled = b["enabled"] | true;
  }
  for (JsonVariantConst b : j["calls"].as<JsonArrayConst>()) {
    if (s.nCalls >= MAX_BTN) break;
    Btn &d = s.calls[s.nCalls++];
    CPY(d.id, b["id"]);
    CPY(d.label, b["label"]);
    d.style = B_CALL;
    d.enabled = b["enabled"] | true;
  }
  // Game cards (new) or tiles (old contract).
  JsonArrayConst cards = j["cards"].as<JsonArrayConst>();
  if (cards.isNull()) cards = j["tiles"].as<JsonArrayConst>();
  for (JsonVariantConst t : cards) {
    if (s.nCards >= MAX_CARDS) break;
    GameCard &c = s.cards[s.nCards++];
    CPY(c.id, t["id"]);
    const char *title = t["title"] | (t["label"] | "");
    strlcpy(c.title, title, sizeof(c.title));
    CPY(c.sub, t["sub"]);
    CPY(c.league, t["league"]);
    CPY(c.date, t["date"]);
    CPY(c.kind, t["kind"]);
    c.enabled = t["enabled"] | false;
    c.gemini = t["gemini"] | false;
    c.hasColor = !t["color"].isNull();
    c.color = parseHex(t["color"] | "", P.accent);
    parseTeam(c.home, t["home"], c.color);
    parseTeam(c.away, t["away"], P.ink2);
    // Older servers do not send "at": only the NFL wrote "at" then.
    c.at = t["at"].is<bool>() ? t["at"].as<bool>() : !strcmp(c.league, "NFL");
  }
  // People.
  if (!j["roster"].isNull()) parsePeople(s.roster, s.nRoster, j["roster"].as<JsonArrayConst>(), "cents", "deposited");
  else parsePeople(s.roster, s.nRoster, j["players"].as<JsonArrayConst>(), "cents", "deposited");
  parsePeople(s.winners, s.nWinners, j["winners"].as<JsonArrayConst>(), "cents", "profit");
  s.hasWinners = !j["winners"].isNull();
  parsePeople(s.losers, s.nLosers, j["losers"].as<JsonArrayConst>(), "cents", "x");
  parsePeople(s.board, s.nBoard, j["leaderboard"].as<JsonArrayConst>(), "cents", "pnl");
  s.boardTie = s.nBoard > 0 && !j["leaderboard"][0]["rank"].isNull() && !(j["leaderboard"][0]["lead"] | false);
  for (JsonVariantConst t : j["trades"].as<JsonArrayConst>()) {
    if (s.nTrades >= 8) break;
    TradeRow &r = s.trades[s.nTrades++];
    CPY(r.name, t["name"]);
    r.yes = !strcmp(t["side"] | "yes", "yes");
    r.cents = t["cents"] | 0;
    r.price = t["price"] | -1;
  }
  for (JsonVariantConst l : j["lines"].as<JsonArrayConst>()) {
    if (s.nLines >= MAX_LINES) break;
    CPY(s.lines[s.nLines++], l);
  }
  JsonVariantConst sc = j["score"];
  if (sc.is<JsonObjectConst>()) {
    s.hasScore = true;
    JsonObjectConst h = sc.as<JsonObjectConst>();
    strlcpy(s.home.name, h["home"] | "", sizeof(s.home.name));
    strlcpy(s.home.abbr, h["homeShort"] | "", sizeof(s.home.abbr));
    s.home.color = parseHex(h["homeColor"] | "", P.ink2);
    strlcpy(s.away.name, h["away"] | "", sizeof(s.away.name));
    strlcpy(s.away.abbr, h["awayShort"] | "", sizeof(s.away.abbr));
    s.away.color = parseHex(h["awayColor"] | "", P.muted);
    s.homeScore = h["homeScore"] | 0;
    s.awayScore = h["awayScore"] | 0;
    CPY(s.clock, h["clock"]);
    CPY(s.period, h["period"]);
    CPY(s.scoreStatus, h["status"]);
  }
  JsonVariantConst card = j["scorecard"];
  s.scRoom = s.scModel = s.scGemini = -1;
  if (card.is<JsonObjectConst>()) {
    if (!card["room"].isNull()) s.scRoom = (int)((card["room"] | 0.0f) * 1000);
    if (!card["model"].isNull()) s.scModel = (int)((card["model"] | 0.0f) * 1000);
    if (!card["gemini"].isNull()) s.scGemini = (int)((card["gemini"] | 0.0f) * 1000);
    CPY(s.verdict, card["verdict"]);
  }
  CPY(s.caption, j["caption"]["text"]);
  parsePage(s, j);
}

// ================================================================ animation state

static uint32_t tScreen = 0;    // current layout appeared (entrances)
static uint32_t tQuestion = 0;  // market question appeared (takeover)
static uint32_t tLocked = 0;    // trading locked (snap)
static uint32_t tResult = 0;    // result landed (flood)
static uint32_t tToast = 0;
static char toast[96] = "";
static uint32_t tHist = 0;      // last history point arrived (draw-on)
static int histPrevN = 0;
static float splitFrom = 0.5f, splitTo = 0.5f;
static uint32_t tSplit = 0;
static int32_t remBase = 0;     // ms to lock at remAt
static uint32_t remAt = 0;
static int lockTotalMs = 0;
static char lastQuestion[220] = "";
// Page sections: each animates in the first time it scrolls into view (0 = not seen yet on this screen).
static uint32_t tChartIn = 0, tOddsIn = 0, tListIn = 0;
// Pay card.
static uint32_t tPay = 0, tPaid = 0;  // card appeared, payment landed
static int32_t payBase = 0;           // ms left at payAt
static uint32_t payAt = 0;
static uint32_t payHiddenAt = 0;      // Close tapped: hide the card (2.5 s) while the site clears it

struct RollState {
  char shown[16], prev[16];
  uint32_t t0;
  int8_t dir;
};
static RollState rYes, rNo, rPot, rCount, rVol, rClock, rHome, rAway;

static void rollSet(RollState &r, const char *v, int dir) {
  if (!strcmp(r.shown, v)) return;
  strlcpy(r.prev, r.shown, sizeof(r.prev));
  strlcpy(r.shown, v, sizeof(r.shown));
  r.t0 = NOW;
  r.dir = dir;
}
static void rollReset(RollState &r, const char *v) {
  strlcpy(r.shown, v, sizeof(r.shown));
  strlcpy(r.prev, v, sizeof(r.prev));
  r.t0 = 0;
  r.dir = 0;
}

// Names already shown in a list: new ones slide in.
struct Seen {
  uint32_t hash[24];
  uint32_t at[24];
  int n;
};
static Seen seenRoster, seenTrades;
static uint32_t strHash(const char *s, int salt = 0) {
  uint32_t h = 2166136261u ^ salt;
  while (*s) h = (h ^ (uint8_t)*s++) * 16777619u;
  return h;
}
static uint32_t seenAt(Seen &s, uint32_t h, bool firstPaint) {
  for (int i = 0; i < s.n; i++)
    if (s.hash[i] == h) return s.at[i];
  uint32_t t = firstPaint ? 0 : NOW;
  if (s.n < 24) {
    s.hash[s.n] = h;
    s.at[s.n] = t;
    s.n++;
  }
  return t;
}

// ================================================================ small helpers

static void fmtMoney(int32_t cents, char *out, size_t cap, bool sign = false) {
  bool neg = cents < 0;
  uint32_t c = neg ? 0u - (uint32_t)cents : (uint32_t)cents;  // safe for INT32_MIN
  const char *pre = neg ? "-" : (sign ? "+" : "");
  if (c % 100 == 0 && c >= 1000) snprintf(out, cap, "%s$%u", pre, (unsigned)(c / 100));
  else snprintf(out, cap, "%s$%u.%02u", pre, (unsigned)(c / 100), (unsigned)(c % 100));
}

static uint16_t avatarColor(const char *name) {
  static const uint32_t cols[] = {0x0B7A3E, 0x127C71, 0x6D4AD6, 0xB4235A, 0x5B6B2F, 0x8C5A1B, 0x2F4858, 0x9A3412};
  return rgb(cols[strHash(name) % 8]);
}

static void avatar(int cx, int cy, int r, const char *name, uint8_t a = 255) {
  circle(cx, cy, r, avatarColor(name), a);
  char ini[4] = {0};
  const char *p = name;
  while (*p == ' ') p++;
  if ((uint8_t)*p >= 0xC0) {  // keep a 2-byte UTF-8 letter whole
    ini[0] = p[0];
    ini[1] = p[1];
  } else {
    ini[0] = toupper((uint8_t)*p);
  }
  const HFont &f = r >= 20 ? F_B1 : F_B3;
  int w = textW(f, ini);
  text(f, cx - w / 2, cy + (r >= 20 ? 7 : 5), ini, P.white, a);
}

static int pill(int x, int y, int h, const char *s, const HFont &f, uint16_t bg, uint16_t fg, uint8_t a = 255, int padX = 12) {
  int w = textW(f, s) + padX * 2;
  rrect(x, y, w, h, h / 2, bg, a);
  text(f, x + padX, y + h / 2 + f.size * 34 / 100, s, fg, a);
  return w;
}

static void textCenter(const HFont &f, int cx, int y, const char *s, uint16_t c, uint8_t a = 255) { text(f, cx - textW(f, s) / 2, y, s, c, a); }
static void textRight(const HFont &f, int rx, int y, const char *s, uint16_t c, uint8_t a = 255) { text(f, rx - textW(f, s), y, s, c, a); }
static void textFit(const HFont &f, int x, int y, int maxW, const char *s, uint16_t c, uint8_t a = 255) {
  char buf[224];
  fit(f, s, maxW, buf, sizeof(buf));
  text(f, x, y, buf, c, a);
}

// Icons drawn from shapes (scale s around a center).
static void iconBolt(float cx, float cy, float s, uint16_t c, uint8_t a = 255) {
  tri(cx + 2 * s, cy - 9 * s, cx - 6 * s, cy + 1.5f * s, cx + 1 * s, cy + 1.5f * s, c, a);
  tri(cx - 2 * s, cy + 9 * s, cx + 6 * s, cy - 1.5f * s, cx - 1 * s, cy - 1.5f * s, c, a);
}
static void iconLock(float cx, float cy, float s, uint16_t c, uint8_t a = 255) {
  ring(cx, cy - 3 * s, 5.5f * s, 2.6f * s, c, a, true);
  fill(cx - 5.5f * s - 1.3f * s, cy - 3 * s, 2.6f * s, 3 * s, c, a);
  fill(cx + 5.5f * s - 1.3f * s, cy - 3 * s, 2.6f * s, 3 * s, c, a);
  rrect(cx - 9 * s, cy - 0.5f * s, 18 * s, 13 * s, 3 * s, c, a);
}
static void iconCheck(float cx, float cy, float s, uint16_t c, uint8_t a = 255) {
  line(cx - 8 * s, cy, cx - 2.5f * s, cy + 6 * s, 3.4f * s, c, a);
  line(cx - 2.5f * s, cy + 6 * s, cx + 9 * s, cy - 7 * s, 3.4f * s, c, a);
}
static void iconArrow(float cx, float cy, float s, bool up, uint16_t c, uint8_t a = 255) {
  if (up) tri(cx, cy - 6 * s, cx - 7 * s, cy + 5 * s, cx + 7 * s, cy + 5 * s, c, a);
  else tri(cx, cy + 6 * s, cx - 7 * s, cy - 5 * s, cx + 7 * s, cy - 5 * s, c, a);
}
static void iconPlay(float cx, float cy, float s, uint16_t c, uint8_t a = 255) { tri(cx - 5 * s, cy - 7 * s, cx - 5 * s, cy + 7 * s, cx + 7 * s, cy, c, a); }
static void iconCrown(float cx, float cy, float s, uint16_t c, uint8_t a = 255) {
  rrect(cx - 11 * s, cy + 2 * s, 22 * s, 6 * s, 2 * s, c, a);
  tri(cx - 11 * s, cy + 3 * s, cx - 11 * s, cy - 8 * s, cx - 3 * s, cy + 3 * s, c, a);
  tri(cx - 6 * s, cy + 3 * s, cx, cy - 10 * s, cx + 6 * s, cy + 3 * s, c, a);
  tri(cx + 11 * s, cy + 3 * s, cx + 11 * s, cy - 8 * s, cx + 3 * s, cy + 3 * s, c, a);
}

// The Huddle mark: the box's LED ring from above, 12 pixels; lit ones walk the green brand gradient.
static void markLogo(float cx, float cy, float R, int lit, bool spin, uint8_t a = 255) {
  static const uint32_t LIT[12] = {0x0B7A3E, 0x0E8743, 0x109448, 0x12A150, 0x2BAA4F, 0x43B24F, 0x5BBB4E, 0x7CCB4E,
                                   0x9BCF45, 0xBFC93F, 0xD9B43C, 0xE8A33D};
  int step = spin ? (int)((NOW / 90) % 12) : 0;
  for (int i = 0; i < 12; i++) {
    float ang = (i / 12.f) * 6.2831853f - 1.5707963f;
    int k = (i - step + 12) % 12;
    bool on = spin ? k < 3 : i < lit;
    float r = on ? R * 0.25f : R * 0.17f;
    uint16_t c = on ? rgb(LIT[spin ? 3 + k * 2 : (lit == 1 ? 3 : i)]) : P.ruleStrong;
    circle(cx + R * cosf(ang), cy + R * sinf(ang), r, c, a);
  }
}

static void wordmark(int x, int baseline, int lit = 1) {
  markLogo(x + 13, baseline - 9, 11, lit, false);
  text(F_H3, x + 32, baseline, "huddle", P.ink);
}

static void liveDot(int cx, int cy, bool fresh) {
  uint16_t c = fresh ? P.accent : P.gold;
  if (fresh) {  // a soft ping every 1.6 s
    float p = (NOW % 1600) / 1600.f;
    if (p < 0.8f) circle(cx, cy, 5 + 9 * eOut(p / 0.8f), c, (uint8_t)(90 * (1 - p / 0.8f)));
  }
  markAmbient(cx - 16, cy - 16, 32, 32);  // also turns gold when the site stops answering
  circle(cx, cy, 5, c);
}

// ================================================================ components

static void card(int x, int y, int w, int h, int r, uint16_t c = 0, uint8_t a = 255) {
  shadow(x, y, w, h, r, a);
  rrect(x, y, w, h, r, c ? c : P.card, a);
}

// Rolling number: digits roll on a strip, the number flashes its direction colour for 1.1 s.
static int rollDraw(RollState &r, const HFont &f, int x, int y, uint16_t c, uint16_t upC, uint16_t downC, int durMs = 560, uint8_t a = 255) {
  const char *now = r.shown;
  const char *old = r.prev;
  int n = strlen(now), m = strlen(old);
  float flash = r.t0 ? prog(r.t0, 0, 1100) : 1.f;
  uint16_t col = c;
  if (flash < 1 && r.dir) col = mix(r.dir > 0 ? upC : downC, c, (uint8_t)(255 * eOut(flash)));
  // Roll inside the digit box (cap height of '0'), so a rolling digit never crosses nearby text.
  int capTop = y - f.ascent, capH = f.ascent;
  if ('0' >= f.first && '0' <= f.last && f.glyphs['0' - f.first].h) {
    capTop = y + f.glyphs['0' - f.first].yo - 2;
    capH = f.glyphs['0' - f.first].h + 4;
  }
  int cellH = capH;
  int top = capTop;
  int cx = x;
  bool anim = false;
  for (int i = 0; i < n; i++) {
    char ch[2] = {now[i], 0};
    int w = glyphW(f, (uint8_t)now[i]);
    int j = m - (n - i);  // aligned from the right
    char oc = j >= 0 ? old[j] : ' ';
    float p = r.t0 ? prog(r.t0, (n - 1 - i) * 28, durMs) : 1.f;
    if (p >= 1 || oc == now[i] || !isdigit((uint8_t)now[i])) {
      text(f, cx, y, ch, col, a);
    } else {
      anim = true;
      float e = eOut(p);
      int d = (int)(e * cellH) * (r.dir >= 0 ? 1 : -1);
      pushClip(cx - 2, top, w + 4, cellH);
      char och[2] = {oc, 0};
      if (oc != ' ') text(f, cx, y - d, och, col, a);
      text(f, cx, y - d + (r.dir >= 0 ? cellH : -cellH), ch, col, a);
      popClip();
    }
    cx += w;
  }
  if (anim || (flash < 1 && r.dir)) mark(x - 4, top - 2, cx - x + 12 + max(0, (m - n)) * f.size / 2, cellH + 4);
  return cx - x;
}

// Kinetic text: each word rises out of its own baseline mask on a spring, staggered.
static int kinetic(const HFont &f, int x, int y, int w, int maxLines, int lh, const char *s, uint16_t c, uint32_t t0, int delay, int stagger, uint8_t a = 255) {
  int starts[6], lens[6];
  bool cut = false;
  maxLines = min(maxLines, 6);
  int n = wrap(f, s, w, maxLines, starts, lens, &cut);
  int word = 0;
  bool anim = false;
  for (int li = 0; li < n; li++) {
    char buf[224];
    int bl = min(lens[li], (int)sizeof(buf) - 1);
    memcpy(buf, s + starts[li], bl);
    buf[bl] = 0;
    if (li == n - 1 && cut) {
      char tmp[224];
      snprintf(tmp, sizeof(tmp), "%s %s", buf, s + starts[li] + lens[li]);
      fit(f, tmp, w, buf, sizeof(buf));
    }
    int by = y + li * lh;
    int cx = x;
    char *p = buf;
    while (*p) {
      char *e = p;
      while (*e && *e != ' ') e++;
      int len = e - p;
      int ww = textWN(f, p, len);
      float pr = prog(t0, delay + word * stagger, 520);
      if (pr >= 1) {
        textN(f, cx, by, p, len, c, a);
      } else if (pr > 0) {
        anim = true;
        float k = eBack(pr, 1.7f);
        int dy = (int)((1 - k) * (f.ascent + f.descent));
        pushClip(cx - 2, by - f.ascent - 2, ww + 6, f.ascent + f.descent + 4);
        textN(f, cx, by + dy, p, len, c, (uint8_t)(a * clampf(pr * 2.5f, 0, 1)));
        popClip();
      } else {
        anim = true;
      }
      cx += ww + glyphW(f, ' ');
      word++;
      p = e;
      while (*p == ' ') p++;
    }
  }
  if (anim) mark(x - 2, y - f.ascent - 4, w + 8, (n ? n : 1) * lh + f.descent + 8);
  return n;
}

// Entrance helper: returns alpha and sets a layer offset. kind 0 = rise, 1 = drop, 2 = slide from right, 3 = fade.
static bool enter(uint32_t t0, int delay, int kind, Rect r, int dur = 480) {
  float p = prog(t0, delay, dur);
  if (p >= 1) {
    layerReset();
    return true;
  }
  mark(r.x - 40, r.y - 24, r.w + 80, r.h + 48);
  if (p <= 0) {
    layer(0, 0, 0);
    return false;
  }
  float e = eBack(p, 1.2f);
  int dx = 0, dy = 0;
  if (kind == 0) dy = (int)((1 - e) * 18);
  if (kind == 1) dy = (int)((e - 1) * 18);
  if (kind == 2) dx = (int)((1 - e) * 40);
  if (kind == 4) dx = (int)((e - 1) * 40);
  layer(dx, dy, (uint8_t)(255 * clampf(p * 2.2f, 0, 1)));
  return true;
}

// Button. Pressed: squish (inset 3 px) and darken; released: springs back; pending: three dots pulse.
static bool rowNoIcon = false;  // set by callRow: this row's labels need the bolt's room
static void button(int x, int y, int w, int h, const Btn &b, const HFont &f, int r = 18) {
  bool pressed = isPressed(b.id) && b.enabled;
  float inset = 0;
  if (pressed) inset = 3;
  else if (released[0] && !strcmp(released, b.id)) {
    float p = prog(releasedAt, 0, 380);
    inset = 3 * (1 - eBack(p, 2.4f));
    if (p < 1) mark(x - 4, y - 4, w + 8, h + 8);
  }
  int ix = (int)roundf(inset);
  int bx = x + ix, by = y + ix, bw = w - 2 * ix, bh = h - 2 * ix;
  uint16_t bg = P.card, fg = P.ink;
  bool grad = false;
  switch (b.style) {
    case B_PRIMARY: bg = P.accent; fg = P.white; break;
    case B_YES: bg = P.yes; fg = P.white; break;
    case B_NO: bg = P.no; fg = P.ink; break;
    case B_BRAND: grad = true; fg = P.white; break;
    case B_CALL: bg = P.accentTint; fg = P.deep; break;
    case B_INK: bg = P.ink; fg = P.white; break;
    case B_WHITE: bg = P.white; fg = P.ink; break;
    default: bg = P.card; fg = P.ink; break;
  }
  if (!b.enabled) {
    bg = P.well;
    fg = P.muted;
    grad = false;
  }
  if (!pressed && b.enabled) shadow(bx, by, bw, bh, r, b.style == B_PLAIN || b.style == B_WHITE || b.style == B_CALL ? 200 : 255);
  if (grad) rrectGrad(bx, by, bw, bh, r, P.deep, P.accent, P.lime);
  else rrect(bx, by, bw, bh, r, bg);
  if (b.style == B_PLAIN && b.enabled) rrectStroke(bx, by, bw, bh, r, 1, P.rule);
  if (b.style == B_CALL && b.enabled) rrectStroke(bx, by, bw, bh, r, 2, P.accent, 110);
  if (pressed) rrect(bx, by, bw, bh, r, P.ink, 30);
  // label (+ icon)
  char lab[48];
  int iconW = (b.style == B_CALL && !rowNoIcon) ? 18 : 0;
  bool play = !strcmp(b.id, "start") || !strcmp(b.id, "next");
  if (play) iconW = 18;
  // Narrow button: drop to the small face, then drop the icon, before cutting the label.
  const HFont *lf = &f;
  if (textW(*lf, b.label) > bw - 24 - iconW && &f != &F_B3) lf = &F_B3;
  if (textW(*lf, b.label) > bw - 20 - iconW) iconW = 0, play = false;
  fit(*lf, b.label, bw - 20 - iconW, lab, sizeof(lab));
  int tw = textW(*lf, lab) + iconW;
  int tx = bx + (bw - tw) / 2;
  int ty = by + bh / 2 + lf->size * 35 / 100;
  if (b.style == B_CALL && iconW) {
    iconBolt(tx + 6, by + bh / 2, 0.9f, b.enabled ? P.accent : P.muted);
    tx += iconW;
  }
  text(*lf, tx, ty, lab, fg);
  if (play) iconPlay(tx + textW(*lf, lab) + 13, by + bh / 2, 0.85f, fg);
  if (isPending(b.id)) {
    for (int i = 0; i < 3; i++) {
      float ph = ((NOW + i * 160) % 900) / 900.f;
      float s = 0.5f + 0.5f * sinf(ph * 6.2831853f);
      circle(bx + bw - 26 + i * 8, by + bh - 12, 2.2f, fg, (uint8_t)(90 + 150 * s));
    }
    markAmbient(bx + bw - 34, by + bh - 20, 30, 16);
  }
  hit(x, y - max(0, (64 - h) / 2), w, max(h, 64), b.id);
}

/**
 * A row of "Call it!" buttons between x and x1: as many as fit with their whole label and bolt (at most 4,
 * at least 2), all in one face (the big one only when every label fits it).
 */
static void callRow(const Btn *calls, int nCalls, int x, int x1, int y, int h, int r) {
  int n = min(nCalls, 4);
  if (n <= 0) return;
  auto widthFor = [&](int k) { return (x1 - x - (k - 1) * 8) / k; };
  for (; n > 2; n--) {  // keep a button only while every label fits whole in the small face
    int bw = widthFor(n);
    bool ok = true;
    for (int i = 0; i < n; i++)
      if (textW(F_B3, calls[i].label) > bw - 20) ok = false;
    if (ok) break;
  }
  int bw = widthFor(n);
  bool big = true, bolts = true;  // one face and the bolt on all of them or none, so the row matches
  for (int i = 0; i < n; i++) {
    if (textW(F_B1, calls[i].label) > bw - 24 - 18) big = false;
    if (textW(F_B3, calls[i].label) > bw - 20 - 18) bolts = false;
  }
  rowNoIcon = !big && !bolts;
  for (int i = 0; i < n; i++) button(x + i * (bw + 8), y, bw, h, calls[i], big ? F_B1 : F_B3, r);
  rowNoIcon = false;
}

static const Btn *findBtn(const Screen &s, const char *id) {
  for (int i = 0; i < s.nButtons; i++)
    if (!strcmp(s.buttons[i].id, id)) return &s.buttons[i];
  return nullptr;
}

// Split bar: YES share from the left in blue, NO in orange, a white seam that glides; model/Gemini notches.
static void splitBar(int x, int y, int w, int h, float frac, int model, int gemini) {
  frac = clampf(frac, 0.02f, 0.98f);
  int sx = x + (int)(w * frac);
  pushClip(x, y, sx - x, h);
  rrect(x, y, w, h, h / 2, P.yes);
  popClip();
  pushClip(sx, y, x + w - sx, h);
  rrect(x, y, w, h, h / 2, P.no);
  popClip();
  fill(x + 4, y + 1, w - 8, h / 3, P.white, 50);  // top highlight
  fill(sx - 2, y, 4, h, P.card);
  if (model >= 0) {
    float mx = x + w * model / 100.f;
    tri(mx - 7, y - 12, mx + 7, y - 12, mx, y - 2, P.ink);
  }
  if (gemini >= 0) {
    float gx = x + w * gemini / 100.f;
    tri(gx - 7, y - 12, gx + 7, y - 12, gx, y - 2, P.ink);
    tri(gx - 3.6f, y - 10.2f, gx + 3.6f, y - 10.2f, gx, y - 5, P.card);
  }
}

// Stepped price line with a soft fill, drawn on as trades land; the end dot pings.
static void sparkline(int x, int y, int w, int h, const int16_t *hist, int n, uint16_t c, uint16_t tint) {
  if (n <= 0) return;
  int lo = 100, hi = 0;
  for (int i = 0; i < n; i++) {
    lo = min<int>(lo, hist[i]);
    hi = max<int>(hi, hist[i]);
  }
  int mid = (lo + hi) / 2, span2 = max(24, hi - lo + 8);
  lo = max(0, mid - span2 / 2);
  hi = min(100, lo + span2);
  auto py = [&](int v) { return y + h - 3 - ((v - lo) * (h - 6)) / max(1, hi - lo); };
  float reveal = prog(tHist, 0, 700);
  int m = max(2, n);
  int16_t xs[2 * MAX_HIST + 2], ys[2 * MAX_HIST + 2];
  int k = 0;
  for (int i = 0; i < m; i++) {
    int v = hist[min(i, n - 1)];
    int px = x + (i * (w - 8)) / (m - 1);
    if (i == m - 1 && n > 1 && reveal < 1) {  // last step draws on
      int prevX = x + ((i - 1) * (w - 8)) / (m - 1);
      px = prevX + (int)((px - prevX) * eOut(reveal));
    }
    if (k > 0) {  // horizontal then vertical: a step chart
      xs[k] = px;
      ys[k] = ys[k - 1];
      k++;
    }
    xs[k] = px;
    ys[k] = py(v);
    k++;
  }
  fillUnderLine(xs, ys, k, y + h, tint, 255);
  for (int i = 0; i + 1 < k; i++) line(xs[i], ys[i], xs[i + 1], ys[i + 1], 2.6f, c);
  float ex = xs[k - 1], ey = ys[k - 1];
  float p = (NOW % 1600) / 1600.f;
  if (p < 0.8f) circle(ex, ey, 4 + 10 * eOut(p / 0.8f), c, (uint8_t)(110 * (1 - p / 0.8f)));
  circle(ex, ey, 4.5f, c);
  if (reveal < 1) mark(x - 4, y - 16, w + 24, h + 32);
  else markAmbient((int)ex - 18, (int)ey - 18, 36, 36);
}

// The lock countdown as the box's LED ring: 24 pixels go dark one by one; hot + throbbing in the last 5 s.
static void lockRing(int cx, int cy, int R, int32_t rem, int32_t tot, bool locked, bool manual) {
  const int N = 24;
  bool urgent = !locked && !manual && rem <= 5000;
  float frac = tot > 0 ? clampf(rem / (float)tot, 0, 1) : 1;
  int lit = locked ? 0 : manual ? N : (int)ceilf(frac * N);
  uint16_t on = urgent ? P.hot : P.accent;
  float throb = 1;
  if (urgent) {
    int inSec = 1000 - (int)(rem % 1000);
    if (inSec < 400) throb = 1.06f - 0.06f * (inSec / 400.f);
    // glow
    float g = inSec < 600 ? 1 - inSec / 600.f : 0;
    circle(cx, cy, R * (0.62f + 0.1f * g), P.hot, (uint8_t)(18 + 40 * g));
  } else if (!locked) {
    circle(cx, cy, R * 0.62f, P.accent, 16);
  }
  for (int i = 0; i < N; i++) {
    float ang = (i / (float)N) * 6.2831853f - 1.5707963f;
    float rr = R * (urgent ? throb : 1);
    float px = cx + rr * cosf(ang), py = cy + rr * sinf(ang);
    bool isOn = i < lit;
    float dotR = urgent ? 7.2f : 6.4f;
    uint16_t col = isOn ? on : P.rule;
    if (!isOn && !locked && !manual && tot > 0) {
      // when did this pixel go dark? it was lit while rem > i * tot / N
      int32_t since = (int32_t)(i * (int64_t)tot / N) - rem;
      float p = clampf(since / 420.f, 0, 1);
      dotR = 6.4f * (1 - 0.28f * eBack(p, 1.8f));
      col = mix(on, P.rule, (uint8_t)(255 * eOut(clampf(since / 240.f, 0, 1))));
    } else if (!isOn) {
      dotR = 6.4f * 0.72f;
    }
    circle(px, py, dotR, col);
  }
  if (locked) {
    float p = prog(tLocked, 0, 420);
    float sc = p < 1 ? 1.9f - 0.9f * eSnap(p) : 1.f;
    if (p > 0.55f && p < 0.8f) sc = 0.92f + (sc - 0.92f) * 0.5f;
    uint8_t a = (uint8_t)(255 * clampf(p * 1.8f, 0, 1));
    iconLock(cx, cy - 10, 2.1f * sc, P.ink, a);
    textCenter(F_B1, cx, cy + 38, "Locked", P.ink, a);
    if (p < 1) mark(cx - R - 20, cy - R - 20, 2 * R + 40, 2 * R + 40);
    return;
  }
  if (manual) {
    textCenter(F_B1, cx, cy + 2, "Locks on", P.ink);
    textCenter(F_B1, cx, cy + 24, "the play", P.ink);
    return;
  }
  int secs = (rem + 999) / 1000;
  char lab[8];
  if (secs >= 60) snprintf(lab, sizeof(lab), "%d:%02d", secs / 60, secs % 60);
  else snprintf(lab, sizeof(lab), "%d", secs);
  rollSet(rClock, lab, -1);
  const HFont &nf = strlen(lab) > 2 ? F_N3 : F_N2;
  int w = textW(nf, lab);
  rollDraw(rClock, nf, cx - w / 2, cy + (strlen(lab) > 2 ? 10 : 16), urgent ? P.hot : P.ink, P.hot, urgent ? P.hot : P.ink, 320);
  if (urgent) textCenter(F_B3, cx, cy + 42, "Last call", P.hot);
  else textCenter(F_B3, cx, cy + 42, "to lock", P.muted);
  mark(cx - R - 14, cy - R - 14, 2 * R + 28, 2 * R + 28);
}

// Redraw a small area when a value it shows changes, without a full-screen redraw (the game clock ticks every second).
struct Watch {
  uint32_t drawn;
};
static Watch wScore;
static void watch(Watch &w, uint32_t key, int x, int y, int ww, int hh) {
  if (measuring) {
    if (key != w.drawn) mark(x, y, ww, hh);
  } else {
    w.drawn = key;
  }
}

/** The scorebug's width, so the top bar can keep its left side clear of it. */
static int scorebugW(const Screen &s) {
  char hs[8], as[8];
  snprintf(hs, sizeof(hs), "%d", s.homeScore);
  snprintf(as, sizeof(as), "%d", s.awayScore);
  const char *ha = s.home.abbr[0] ? s.home.abbr : "HOME";
  const char *aa = s.away.abbr[0] ? s.away.abbr : "AWAY";
  int wHa = textW(F_B1, ha), wAa = textW(F_B1, aa), wHs = max(26, textW(F_N4, hs) + 12), wAs = max(26, textW(F_N4, as) + 12);
  int wClock = max(textW(F_N4, s.clock), textW(F_B3, s.period[0] ? s.period : "Live")) + 8;
  return 12 + 6 + 8 + wHa + 8 + wHs + 12 + wClock + 12 + wAs + 8 + wAa + 8 + 6 + 12;
}

static void scorebug(const Screen &s, int rx, int y, int h) {
  // [bar ABBR score] clock [score ABBR bar]  right-aligned at rx
  char hs[8], as[8];
  snprintf(hs, sizeof(hs), "%d", s.homeScore);
  snprintf(as, sizeof(as), "%d", s.awayScore);
  const char *ha = s.home.abbr[0] ? s.home.abbr : "HOME";
  const char *aa = s.away.abbr[0] ? s.away.abbr : "AWAY";
  int wHa = textW(F_B1, ha), wAa = textW(F_B1, aa), wHs = max(26, textW(F_N4, hs) + 12), wAs = max(26, textW(F_N4, as) + 12);
  int wClock = max(textW(F_N4, s.clock), textW(F_B3, s.period[0] ? s.period : "Live")) + 8;
  int w = scorebugW(s);
  int x = rx - w;
  watch(wScore, strHash(s.clock, s.homeScore * 1000 + s.awayScore) ^ strHash(s.period) ^ strHash(s.scoreStatus), x - 10, y - 4, w + 20, h + 14);
  card(x, y, w, h, h / 2);
  int cy = y + h / 2;
  int cx = x + 12;
  rrect(cx, cy - 11, 6, 22, 3, s.home.color);
  cx += 14;
  text(F_B1, cx, cy + 7, ha, P.ink);
  cx += wHa + 8;
  rrect(cx, cy - 13, wHs, 26, 7, P.ink);
  rollSet(rHome, hs, 1);
  rollDraw(rHome, F_N4, cx + (wHs - textW(F_N4, hs)) / 2, cy + 8, P.white, P.white, P.white, 700);
  cx += wHs + 12;
  textCenter(F_N4, cx + wClock / 2, cy + 3, s.clock, P.ink);
  bool live = !strcmp(s.scoreStatus, "live");
  const char *sub = !strcmp(s.scoreStatus, "final") ? "Final" : s.period[0] ? s.period : (live ? "Live" : "Pre");
  int sw = textW(F_B3, sub);
  if (live) circle(cx + wClock / 2 - sw / 2 - 6, cy + 13, 3, P.hot);
  text(F_B3, cx + wClock / 2 - sw / 2 + (live ? 2 : 0), cy + 18, sub, P.ink2);
  cx += wClock + 12;
  rrect(cx, cy - 13, wAs, 26, 7, P.ink);
  rollSet(rAway, as, 1);
  rollDraw(rAway, F_N4, cx + (wAs - textW(F_N4, as)) / 2, cy + 8, P.white, P.white, P.white, 700);
  cx += wAs + 8;
  text(F_B1, cx, cy + 7, aa, P.ink);
  cx += wAa + 8;
  rrect(cx, cy - 11, 6, 22, 3, s.away.color);
}

// Confetti burst: deterministic particles (seeded), gravity, spin approximated by flicker in width.
static void burst(uint32_t t0, int delay, float ox, float oy, int count, int seed, const uint16_t *cols, int nCols) {
  float p = prog(t0, delay, 1800);
  if (p <= 0 || p >= 1) {
    if (p <= 0) mark(0, 0, SCR_W, SCR_H);
    return;
  }
  float t = p * 1.8f;
  uint32_t r = seed * 2654435761u + 12345;
  auto rnd = [&]() {
    r ^= r << 13;
    r ^= r >> 17;
    r ^= r << 5;
    return (r % 10000) / 10000.f;
  };
  for (int i = 0; i < count; i++) {
    float ang = -1.5707963f + (rnd() - 0.5f) * 2.6f;
    float sp = 380 + rnd() * 520;
    float vx = cosf(ang) * sp, vy = sinf(ang) * sp;
    float x = ox + vx * t * 0.8f, y = oy + vy * t + 900 * t * t;
    float wob = sinf((t * 14 + i) * 1.3f);
    int w = 4 + (int)(5 * fabsf(wob)), h = 9;
    uint8_t a = (uint8_t)(255 * clampf((1 - p) * 3, 0, 1));
    rrect((int)x - w / 2, (int)y - h / 2, w, h, 2, cols[i % nCols], a);
  }
  mark(0, 0, SCR_W, SCR_H);
}

// ================================================================ screens

static void topRight(const Screen &s, int &rx, const NetStatus &st) {
  bool fresh = st.lastOkMs && millis() - st.lastOkMs < 2500;
  liveDot(rx - 8, 30, fresh);
  rx -= 26;
}

static void codeChip(const Screen &s, int &rx) {
  if (!s.code[0]) return;
  char buf[24];
  snprintf(buf, sizeof(buf), "Join %s", s.code);
  int w = textW(F_B1, buf) + 28;
  rx -= w;
  card(rx, 12, w, 38, 19);
  text(F_B3, rx + 14, 36, "Join", P.ink2);
  text(F_B1, rx + 14 + textW(F_B3, "Join") + 6, 37, s.code, P.ink);
  rx -= 10;
}

// ---------------------------------------------------------------- select: the game picker

static void drawGameCard(const GameCard &c, int x, int y, int w, int h, int idx) {
  bool pressed = isPressed(c.id);
  int ix = pressed ? 3 : 0;
  float rel = 0;
  if (!pressed && released[0] && !strcmp(released, c.id)) {
    float p = prog(releasedAt, 0, 380);
    rel = 3 * (1 - eBack(p, 2.4f));
    if (p < 1) mark(x - 6, y - 6, w + 12, h + 12);
    ix = (int)roundf(rel);
  }
  x += ix;
  y += ix;
  w -= 2 * ix;
  h -= 2 * ix;
  const int r = 22;
  if (c.enabled) {
    if (!pressed) shadow(x, y, w, h, r);
    rrect(x, y, w, h, r, P.card);
  } else {
    rrect(x, y, w, h, r, P.well);
  }
  // team colour ribbon across the top
  pushClip(x, y, w, 7);
  // first/second in reading order: "Away at Home" for US leagues, "Home v Away" for soccer
  const Team &t1 = c.at ? c.away : c.home;
  const Team &t2 = c.at ? c.home : c.away;
  if (c.home.has && c.away.has) {
    pushClip(x, y, w / 2, 7);
    rrect(x, y, w, h, r, t1.color, c.enabled ? 255 : 120);
    popClip();
    pushClip(x + w / 2, y, w - w / 2, 7);
    rrect(x, y, w, h, r, t2.color, c.enabled ? 255 : 120);
    popClip();
  } else {
    rrect(x, y, w, h, r, c.hasColor ? c.color : P.accent, c.enabled ? 255 : 120);
  }
  popClip();
  uint16_t ink = c.enabled ? P.ink : P.muted;
  // row 1: league + status
  int lx = x + 14;
  if (c.league[0]) lx += pill(lx, y + 18, 26, c.league, F_B3, c.enabled ? P.well : P.rule, P.ink2) + 6;
  const char *status = !c.enabled ? "Soon" : !strcmp(c.kind, "replay") ? "Replay" : "Live";
  int sw = textW(F_B3, status) + 24 + (c.enabled && strcmp(c.kind, "replay") ? 10 : 0);
  int sx = x + w - 14 - sw;
  if (!c.enabled) pill(sx, y + 18, 26, status, F_B3, P.rule, P.muted);
  else if (!strcmp(c.kind, "replay")) pill(sx, y + 18, 26, status, F_B3, P.accentTint, P.deep);
  else {
    rrect(sx, y + 18, sw, 26, 13, P.ink);
    circle(sx + 13, y + 31, 3.5f, P.hot);
    text(F_B3, sx + 22, y + 36, status, P.white);
  }
  // teams or title
  if (c.home.has && c.away.has) {
    rrect(x + 14, y + 58, 8, 28, 4, t1.color, c.enabled ? 255 : 120);
    textFit(F_H3, x + 30, y + 80, w - 44, t1.nick[0] ? t1.nick : t1.name, ink);
    text(F_B3, x + 30, y + 102, c.at ? "at" : "v", P.muted);
    rrect(x + 14, y + 108, 8, 28, 4, t2.color, c.enabled ? 255 : 120);
    textFit(F_H3, x + 30, y + 130, w - 44, t2.nick[0] ? t2.nick : t2.name, ink);
  } else {
    int starts[2], lens[2];
    bool cut;
    int n = wrap(F_H2, c.title, w - 28, 2, starts, lens, &cut);
    for (int i = 0; i < n; i++) {
      char buf[64];
      int l = min(lens[i], 60);
      memcpy(buf, c.title + starts[i], l);
      buf[l] = 0;
      if (i == n - 1 && cut) {
        char tmp[64];
        fit(F_H2, buf, w - 40, tmp, sizeof(tmp));
        strlcpy(buf, tmp, sizeof(buf));
      }
      text(F_H2, x + 14, y + 86 + i * 34, buf, ink);
    }
    if (n < 2 && c.sub[0]) {  // the subtitle gets two lines under a one-line title
      int ss[2], sl[2];
      bool scut;
      int m = wrap(F_B2, c.sub, w - 28, 2, ss, sl, &scut);
      for (int i = 0; i < m; i++) {
        char buf[72];
        int l = min(sl[i], 70);
        memcpy(buf, c.sub + ss[i], l);
        buf[l] = 0;
        if (i == m - 1 && scut) {
          char tmp[80];
          snprintf(tmp, sizeof(tmp), "%s ...", buf);
          fit(F_B2, tmp, w - 28, buf, sizeof(buf));
        }
        text(F_B2, x + 14, y + 120 + i * 24, buf, P.ink2);
      }
    }
  }
  // bottom row: date + Gemini badge
  int gbw = 0;
  if (c.gemini) {
    gbw = textW(F_B3, "Gemini odds") + 34;
    int gx = x + w - 14 - gbw;
    rrect(gx, y + h - 40, gbw, 26, 13, P.ink, c.enabled ? 255 : 140);
    // hollow triangle = the Gemini marker
    tri(gx + 10, y + h - 32, gx + 22, y + h - 32, gx + 16, y + h - 21, P.white);
    tri(gx + 13, y + h - 30.5f, gx + 19, y + h - 30.5f, gx + 16, y + h - 25, P.ink);
    text(F_B3, gx + 26, y + h - 22, "Gemini odds", P.white);
  }
  const char *bottom = c.date[0] ? c.date : (c.home.has ? c.sub : "");
  if (bottom[0]) textFit(F_B3, x + 14, y + h - 21, w - 28 - gbw - 8, bottom, P.muted);
  if (pressed) rrectStroke(x, y, w, h, r, 3, P.accent);
  (void)idx;
}

static void drawSelect(const Screen &s, const NetStatus &st) {
  wordmark(20, 40);
  text(F_H2, 176, 42, s.title[0] ? s.title : "Pick a game", P.ink);
  int rx = SCR_W - 16;
  topRight(s, rx, st);
  int tx = 176 + textW(F_H2, s.title[0] ? s.title : "Pick a game") + 16;
  textFit(F_B2, tx, 41, rx - tx - 8, s.subtitle, P.ink2);

  const int cols = 3, gap = 12, cw = 248, ch = 184, top = 68;
  int rows = (s.nCards + cols - 1) / cols;
  int viewY = 62, viewH = SCR_H - viewY;
  int contentH = top - viewY + rows * (ch + gap) + 4;
  float off = scrollArea(0, 0, viewY, SCR_W, viewH, contentH);
  pushClip(0, viewY, SCR_W, viewH);
  for (int i = 0; i < s.nCards; i++) {
    int x = 16 + (i % cols) * (cw + gap);
    int y = top + (i / cols) * (ch + gap) - (int)off;
    if (y + ch < viewY - 10 || y > SCR_H + 10) continue;
    Rect r = {(int16_t)x, (int16_t)y, (int16_t)cw, (int16_t)ch};
    if (enter(tScreen, 80 + i * 60, 0, r)) drawGameCard(s.cards[i], x, y, cw, ch, i);
    layerReset();
    if (s.cards[i].enabled && y + ch > viewY && y < SCR_H) {
      int hy = max(y, viewY), hh = min(y + ch, (int)SCR_H) - hy;
      if (hh > 20) hit(x, hy, cw, hh, s.cards[i].id);
    }
  }
  popClip();
  // edge fades say "there is more"
  Scroller &sc = scrolls[0];
  if (sc.maxOff > 0) {
    if (sc.off > 2)
      for (int i = 0; i < 10; i++) fill(0, viewY + i, SCR_W, 1, P.canvas, 220 - i * 22);
    if (sc.off < sc.maxOff - 2)
      for (int i = 0; i < 14; i++) fill(0, SCR_H - 1 - i, SCR_W, 1, P.canvas, 230 - i * 16);
    // scrollbar
    int barH = max(40, viewH * viewH / contentH);
    int barY = viewY + (int)((viewH - barH) * clampf(sc.off / max(1.f, sc.maxOff), 0, 1));
    bool active = NOW - sc.lastMove < 1200 || T.dragging;
    rrect(SCR_W - 7, barY + 4, 4, barH - 8, 2, P.ink, active ? 110 : 40);
    if (active || NOW - sc.lastMove < 1500) mark(SCR_W - 10, viewY, 10, viewH);
  }
}

// ---------------------------------------------------------------- lobby

static void drawQR(const Screen &s, int x, int y, int box) {
  rrect(x, y, box, box, 18, P.ink);  // light quiet zone, dark modules (scanners want dark on light)
  if (!s.qrSize) return;
  int inner = box - 20;
  int scale = max(1, inner / s.qrSize);
  int ox = x + (box - scale * s.qrSize) / 2, oy = y + (box - scale * s.qrSize) / 2;
  for (int r = 0; r < s.qrSize; r++)
    for (int c = 0; c < s.qrSize; c++)
      if (s.qr[r][c >> 3] & (1 << (c & 7))) fill(ox + c * scale, oy + r * scale, scale, scale, P.canvas);
}

static void personRow(const Person &p, int x, int y, int w, int h, uint32_t bornAt, bool lobby) {
  float sl = bornAt ? prog(bornAt, 0, 520) : 1;
  if (sl < 1) {
    float e = eBack(sl, 1.3f);
    layer((int)((1 - e) * 60), 0, (uint8_t)(255 * clampf(sl * 2, 0, 1)));
    mark(x - 10, y - 10, w + 80, h + 20);
  }
  card(x, y, w, h, 16);
  if (sl < 1 && bornAt) rrectStroke(x, y, w, h, 16, 2, P.accent, (uint8_t)(255 * (1 - sl)));
  avatar(x + 26, y + h / 2, 17, p.name);
  char amt[16] = "";
  if (lobby) {
    if (p.has2 && p.extra <= 0) strlcpy(amt, "adding...", sizeof(amt));
    else if (p.has2 || p.cents) fmtMoney(p.cents, amt, sizeof(amt));
  }
  int aw = amt[0] ? textW(amt[0] == '$' ? F_N4 : F_B3, amt) : 0;
  textFit(F_B1, x + 52, y + h / 2 + 7, w - 64 - aw - 8, p.name, P.ink);
  if (amt[0] == '$') textRight(F_N4, x + w - 14, y + h / 2 + 7, amt, P.ink2);
  else if (amt[0]) textRight(F_B3, x + w - 14, y + h / 2 + 6, amt, P.muted);
  layerReset();
}

static void drawLobby(const Screen &s, const NetStatus &st) {
  // Join panel: the one loud thing.
  const int px = 12, py = 12, pw = 292, ph = 456;
  if (enter(tScreen, 0, 4, {px, py, pw, ph})) {
    rrectGrad(px, py, pw, ph, 30, P.deep, P.accent, P.lime);
    drawQR(s, px + 40, py + 22, 212);  // still: phones scan it
    textCenter(F_H3, px + pw / 2, 276, "Tap your phone here", P.white);
    textCenter(F_B2, px + pw / 2, 300, "or scan the code to join", P.white, 230);
    textCenter(F_B3, px + pw / 2, 328, "Party code", P.white, 220);
    int n = strlen(s.code);
    int tw = 50, gap = 8, tx = px + (pw - (n * tw + (n - 1) * gap)) / 2;
    for (int i = 0; i < n; i++) {
      float p = prog(tScreen, 320 + i * 90, 600);
      if (p <= 0) {
        mark(tx - 10, 330, tw + 20, 80);
        tx += tw + gap;
        continue;
      }
      float e = eBack(p, 2.0f);
      int sz = (int)(tw * (0.6f + 0.4f * e)), sh = (int)(62 * (0.6f + 0.4f * e));
      int cx = tx + tw / 2, cy = 338 + 31;
      rrect(cx - sz / 2, cy - sh / 2, sz, sh, 14, P.white);
      char ch[2] = {s.code[i], 0};
      if (p > 0.3f) textCenter(F_H1, cx, cy + 15, ch, P.ink, (uint8_t)(255 * clampf((p - 0.3f) * 3, 0, 1)));
      if (p < 1) mark(tx - 12, 324, tw + 24, 90);
      tx += tw + gap;
    }
    char url[96];
    fit(F_B3, s.joinUrl, pw - 28, url, sizeof(url));
    textCenter(F_B3, px + pw / 2, 432, url, P.white, 220);
  }
  layerReset();

  const int x0 = 322, x1 = SCR_W - 14, w = x1 - x0;
  int rx = SCR_W - 16;
  topRight(s, rx, st);
  kinetic(F_H2, x0, 46, rx - x0 - 8, 1, 34, s.gameTitle[0] ? s.gameTitle : s.title, P.ink, tScreen, 120, 45);
  if (enter(tScreen, 360, 0, {(int16_t)x0, 58, (int16_t)w, 26})) textFit(F_B2, x0, 76, w, s.subtitle, P.ink2);
  layerReset();

  // stats: pot + players
  int sy = 90, sh = 88, cw = (w - 12) / 2;
  if (enter(tScreen, 420, 0, {(int16_t)x0, (int16_t)sy, (int16_t)cw, (int16_t)sh})) {
    card(x0, sy, cw, sh, 20);
    circle(x0 + 22, sy + 21, 6, P.gold);
    text(F_B3, x0 + 34, sy + 26, "In the pot", P.ink2);
    char pot[16];
    int potC = s.pot;
    if (potC < 0) {
      potC = 0;
      for (int i = 0; i < s.nRoster; i++) potC += s.roster[i].has2 ? s.roster[i].extra : 0;
    }
    fmtMoney(potC, pot, sizeof(pot));
    rollSet(rPot, pot, 1);
    rollDraw(rPot, F_N2, x0 + 16, sy + 78, P.ink, P.deep, P.no600, 900);
  }
  layerReset();
  if (enter(tScreen, 500, 0, {(int16_t)(x0 + cw + 12), (int16_t)sy, (int16_t)cw, (int16_t)sh})) {
    card(x0 + cw + 12, sy, cw, sh, 20);
    text(F_B3, x0 + cw + 28, sy + 26, s.nRoster == 1 ? "Player" : "Players", P.ink2);
    char cnt[8];
    snprintf(cnt, sizeof(cnt), "%d", s.nRoster);
    rollSet(rCount, cnt, 1);
    rollDraw(rCount, F_N2, x0 + cw + 28, sy + 78, P.accent, P.deep, P.deep, 700);
    markLogo(x0 + 2 * cw + 12 - 34, sy + 50, 18, max(1, min(12, s.nRoster)), false);
  }
  layerReset();

  // players list (scrolls), then Call it! + Start / Cancel
  bool calls = s.nCalls > 0;
  int listY = sy + sh + 12;
  int listBottom = calls ? 302 : 392;
  int rowH = 52, gap = 8, colW = (w - 10) / 2;
  int rows = (s.nRoster + 1) / 2;
  int contentH = rows * (rowH + gap);
  float off = scrollArea(0, x0 - 6, listY, w + 12, listBottom - listY, contentH);
  pushClip(x0 - 10, listY, w + 20, listBottom - listY);
  if (s.nRoster == 0) {
    if (enter(tScreen, 560, 0, {(int16_t)x0, (int16_t)listY, (int16_t)w, 60})) {
      rrectStroke(x0, listY + 2, w, 64, 16, 2, P.ruleStrong);
      float b = 0.5f + 0.5f * sinf(NOW / 400.f);
      circle(x0 + 22, listY + 34, 5, P.accent, (uint8_t)(120 + 135 * b));
      markAmbient(x0 + 10, listY + 22, 24, 24);
      text(F_B1, x0 + 40, listY + 31, "Waiting for the first player", P.ink);
      text(F_B3, x0 + 40, listY + 52, "Tap a phone on the box or scan the code", P.ink2);
    }
    layerReset();
  }
  for (int i = 0; i < s.nRoster; i++) {
    int rxp = x0 + (i % 2) * (colW + 10);
    int ry = listY + (i / 2) * (rowH + gap) - (int)off;
    // Register every name (visible or not) so only real arrivals slide in, not rows scrolled into view.
    uint32_t born = seenAt(seenRoster, strHash(s.roster[i].name), NOW - tScreen < 400);
    if (ry + rowH < listY - 4 || ry > listBottom + 4) continue;
    personRow(s.roster[i], rxp, ry, colW, rowH, born, true);
  }
  popClip();
  if (scrolls[0].maxOff > 0) {
    int vh = listBottom - listY, barH = max(30, vh * vh / max(1, contentH));
    int barY = listY + (int)((vh - barH) * clampf(scrolls[0].off / max(1.f, scrolls[0].maxOff), 0, 1));
    rrect(x1 + 6, barY, 4, barH, 2, P.ink, NOW - scrolls[0].lastMove < 1200 ? 110 : 40);
    if (NOW - scrolls[0].lastMove < 1500) mark(x1 + 2, listY, 12, vh);
  }

  if (calls) {
    if (enter(tScreen, 600, 0, {(int16_t)x0, 304, (int16_t)w, 86})) {
      iconBolt(x0 + 8, 316, 0.75f, P.accent);
      text(F_B3, x0 + 20, 322, "Call it! Tap the moment it happens on TV", P.ink2);
      callRow(s.calls, s.nCalls, x0, x0 + w, 330, 60, 16);
    }
    layerReset();
  }
  const Btn *start = findBtn(s, "start");
  const Btn *cancel = findBtn(s, "cancel");
  if (enter(tScreen, 680, 0, {(int16_t)x0, 400, (int16_t)w, 68})) {
    int bx = x0;
    if (cancel) {
      button(bx, 400, 124, 66, *cancel, F_B1, 20);
      bx += 136;
    }
    if (start) {
      Btn b = *start;
      b.style = B_BRAND;
      button(bx, 400, x1 - bx, 66, b, F_H3, 22);
    }
  }
  layerReset();
}

// ---------------------------------------------------------------- market (open + locked)

static int32_t remainingMs() {
  int32_t r = remBase - (int32_t)(NOW - remAt);
  return r < 0 ? 0 : r;
}

// Kalshi-style market: a slim top bar, the question as a calm title, a huge "67% chance" over a clean YES price
// chart (room solid, model dashed, Gemini a quiet second line), a right rail with a thin countdown and two slim
// Yes / No price tiles, then recent trades (open) or the host's result buttons (locked).
static RollState rHeroP;
static Watch wHeroChart;

// Thin countdown: "Closes in 12s" with a hairline progress bar (hot in the last 5 s).
static void countdownBar(const Screen &s, int x, int y, int w, bool locked) {
  int32_t rem = remainingMs(), tot = lockTotalMs;
  bool manual = !locked && (!s.hasLock || tot <= 0);
  bool urgent = !locked && !manual && rem <= 5000;
  if (!locked && !manual) mark(x - 4, y - 24, w + 8, 40);
  if (locked) {
    iconLock(x + 7, y - 8, 0.7f, P.ink);
    text(F_B2, x + 22, y - 2, "Trading closed", P.ink);
    fill(x, y + 10, w, 3, P.ruleStrong);
    return;
  }
  if (manual) {
    text(F_B3, x, y - 2, "Open until the host locks", P.ink2);
    fill(x, y + 10, w, 3, P.rule);
    return;
  }
  text(F_B3, x, y - 2, "Closes in", P.ink2);
  char t[12];
  int secs = (int)((rem + 999) / 1000);
  if (secs >= 60) snprintf(t, sizeof(t), "%d:%02d", secs / 60, secs % 60);
  else snprintf(t, sizeof(t), "%ds", secs);
  textRight(F_N4, x + w, y, t, urgent ? P.hot : P.ink);
  float f = tot > 0 ? clampf(rem / (float)tot, 0, 1) : 0;
  fill(x, y + 10, w, 3, P.rule);
  int fw = (int)(w * f);
  if (fw > 0) fill(x, y + 10, fw, 3, urgent ? P.hot : P.ink);
}

// Slim Yes / No tile: tinted, a hairline edge, "Yes" left, "67¢" right (digits roll on a move).
static void priceTile(const Screen &s, bool yes, int x, int y, int w, int h, bool locked) {
  uint16_t c = yes ? P.yes : P.no;
  rrect(x, y, w, h, h / 2, yes ? P.yesTint : P.noTint);
  rrectStroke(x, y, w, h, h / 2, 1, c, locked ? 70 : 150);
  text(F_B1, x + 22, y + h / 2 + 7, yes ? "Yes" : "No", c);
  RollState &r = yes ? rYes : rNo;
  char num[8];
  int v = (int)clampf(yes ? s.yes : s.no, 0, 100);
  snprintf(num, sizeof(num), "%d", v);
  int mv = yes ? s.move : -s.move;
  rollSet(r, num, mv > 0 ? 1 : mv < 0 ? -1 : r.dir);
  int cw = textW(F_N4, "\xC2\xA2");
  int nw = textW(F_N3, num);
  rollDraw(r, F_N3, x + w - 20 - cw - 2 - nw, y + h / 2 + 11, c, c, c, 560);
  text(F_N4, x + w - 20 - cw, y + h / 2 + 11, "\xC2\xA2", c);
  if (r.t0 && prog(r.t0, 0, 600) < 1) mark(x, y, w, h);
  if (locked) rrect(x, y, w, h, h / 2, P.canvas, 110);
}

// The hero chart: room YES price over time (stepped, soft fill), Gemini thin and quiet, the model dashed.
static void heroChart(const Screen &s, int x, int y, int w, int h, bool locked) {
  const Chart &c = s.chart;
  watch(wHeroChart, s.chartHash ^ (uint32_t)s.nHist * 977u, x - 6, y - 6, w + 12, h + 12);
  int16_t vals[MAX_CHART];
  int n = 0;
  int span = 100;
  if (c.has && c.n > 0) {
    n = min((int)c.n, MAX_CHART);
    for (int i = 0; i < n; i++) vals[i] = (int16_t)clampf(c.room[i], 0, 100);
    span = (int)clampf(c.span, 5, 100);
  } else {
    n = min(s.nHist, MAX_CHART);
    for (int i = 0; i < n; i++) vals[i] = (int16_t)clampf(s.hist[s.nHist - n + i], 0, 100);
  }
  const int px0 = x, px1 = x + w - 44, py0 = y + 24, py1 = y + h - 22;
  auto PY = [&](int v) { return py1 - (v * (py1 - py0)) / 100; };
  auto PX = [&](int i) { return n <= 1 ? px0 : px0 + (int)(((int32_t)(px1 - px0) * span * i) / (100 * (n - 1))); };
  for (int v = 0; v <= 100; v += 25) {
    int gy = PY(v);
    for (int xx = px0; xx < px1; xx += 6) fill(xx, gy, 2, 1, v == 50 ? P.ruleStrong : P.rule);
    char lab[8];
    snprintf(lab, sizeof(lab), "%d%%", v);
    text(F_B3, px1 + 8, gy + 5, lab, P.muted);
  }
  text(F_B3, px0, py1 + 18, c.has && c.x0[0] ? c.x0 : "Open", P.muted);
  textRight(F_B3, px1, py1 + 18, locked ? "Locked" : c.has && c.x1[0] ? c.x1 : "Now", P.muted);
  // legend (above the plot)
  uint16_t lineC = locked ? mix(P.yes, P.muted, 110) : P.yes;
  int lx = px0, ly = y + 6;
  line(lx, ly, lx + 14, ly, 2.4f, lineC);
  lx += 20;
  lx += text(F_B3, lx, ly + 5, "Room", P.ink2) + 16;
  if (c.has && c.model >= 0) {
    line(lx, ly, lx + 4, ly, 1.4f, P.ink2);
    line(lx + 9, ly, lx + 14, ly, 1.4f, P.ink2);
    lx += 20;
    lx += text(F_B3, lx, ly + 5, "Model", P.ink2) + 16;
  }
  if (c.has && c.hasGem) {
    line(lx, ly, lx + 14, ly, 1.4f, P.ink2, 150);
    lx += 20;
    text(F_B3, lx, ly + 5, "Gemini", P.ink2);
  }
  if (locked) {  // frozen: a lock badge over the plot
    float p = prog(tLocked, 0, 500);
    int bw = textW(F_B3, "Locked") + 40, bx = px1 - bw, by = y - 7;
    uint8_t a = (uint8_t)(255 * clampf(p * 2, 0, 1));
    rrect(bx, by, bw, 26, 13, P.well, a);
    rrectStroke(bx, by, bw, 26, 13, 1, P.ruleStrong, a);
    iconLock(bx + 15, by + 12, 0.55f, P.ink, a);
    text(F_B3, bx + 27, by + 18, "Locked", P.ink, a);
    if (p < 1) mark(bx - 4, by - 4, bw + 8, 34);
  }
  if (n <= 0) {
    textCenter(F_B2, (px0 + px1) / 2, (py0 + py1) / 2 + 6, "No trades yet", P.muted);
    return;
  }
  float rp = prog(tQuestion, 200, 1100);
  if (rp < 1) mark(x - 6, y - 6, w + 12, h + 12);
  if (c.has && c.model >= 0) {
    int my = PY((int)clampf(c.model, 0, 100));
    uint8_t ma = (uint8_t)(170 * clampf(rp * 2, 0, 1));
    for (int xx = px0; xx < px1; xx += 12) line(xx, my, min(xx + 6, px1), my, 1.4f, P.ink2, ma);
  }
  int endX = PX(n - 1);
  int revealX = px0 - 4 + (int)((max(endX, px0 + 40) - px0 + 30) * eOut(rp));
  pushClip(px0 - 6, py0 - 10, max(0, revealX - (px0 - 6)), py1 - py0 + 20);
  int16_t xs[2 * MAX_CHART], ys[2 * MAX_CHART];
  int k = 0;
  for (int i = 0; i < n; i++) {
    int px = PX(i), py = PY(vals[i]);
    if (k > 0) {
      xs[k] = px;
      ys[k] = ys[k - 1];
      k++;
    }
    xs[k] = px;
    ys[k] = py;
    k++;
  }
  if (k == 1) {
    xs[1] = px0 + 40;
    ys[1] = ys[0];
    k = 2;
  }
  fillUnderLine(xs, ys, k, py1, mix(P.canvas, lineC, 26), 255);
  if (c.has && c.hasGem)
    for (int i = 1; i < n; i++)
      if (c.gem[i - 1] >= 0 && c.gem[i] >= 0) line(PX(i - 1), PY(c.gem[i - 1]), PX(i), PY(c.gem[i]), 1.4f, P.ink2, 150);
  for (int i = 0; i + 1 < k; i++) line(xs[i], ys[i], xs[i + 1], ys[i + 1], 2.6f, lineC);
  popClip();
  if (rp >= 1) {
    float ex = xs[k - 1], ey = ys[k - 1];
    if (!locked) {
      float p = (NOW % 2000) / 2000.f;
      if (p < 0.7f) circle(ex, ey, 4 + 8 * eOut(p / 0.7f), P.yes, (uint8_t)(80 * (1 - p / 0.7f)));
      markAmbient((int)ex - 14, (int)ey - 14, 28, 28);
    }
    circle(ex, ey, 4.5f, lineC);
  }
}

static void drawMarket(const Screen &s, const NetStatus &st, bool locked) {
  // ---- compact top bar: question number + volume | score bug / code, Lock now, live dot
  const Btn *lockB = findBtn(s, "lock");
  int rx = SCR_W - 16;
  topRight(s, rx, st);
  if (lockB && !locked) {
    Btn b = *lockB;
    int w = textW(F_B2, b.label) + 32;
    rx -= w;
    button(rx, 12, w, 36, b, F_B2, 18);
    rx -= 10;
  }
  if (s.hasScore) {
    scorebug(s, rx, 10, 40);
    rx -= scorebugW(s) + 10;
  } else if (s.code[0]) {
    codeChip(s, rx);
  }
  if (enter(tQuestion, 0, 3, {16, 8, 400, 44})) {
    int x = 20;
    const char *badge = locked ? "Trading closed" : s.title[0] ? s.title : "Market open";
    char sb[40];
    if (!strncmp(badge, "Question ", 9)) {
      snprintf(sb, sizeof(sb), "Q%s", badge + 9);
      badge = sb;
    }
    if (locked) iconLock(x + 5, 29, 0.6f, P.ink2);
    else circle(x + 5, 30, 4, P.yes);
    x += 16;
    x += text(F_B2, x, 36, badge, P.ink2) + 14;
    if (s.volume >= 0 && x + 90 < rx) {
      char m[16];
      fmtMoney(s.volume, m, sizeof(m));
      rollSet(rVol, m, 1);
      int w = rollDraw(rVol, F_B2, x, 36, P.muted, P.ink, P.muted, 560);
      if (x + w + 70 < rx) text(F_B2, x + w + 5, 36, "vol", P.muted);
    } else if (s.volume < 0 && s.traded[0] && x + 60 < rx) {
      textFit(F_B2, x, 36, rx - x - 10, s.traded, P.muted);
    }
  }
  layerReset();
  fill(16, 58, SCR_W - 32, 1, P.rule);

  // ---- left: title, hero %, chart
  const int LX = 24, LW = 508;
  int starts[3], lens[3];
  bool cut;
  int nl = wrap(F_H3, s.question, LW, 2, starts, lens, &cut);
  kinetic(F_H3, LX, 94, LW, 2, 29, s.question, P.ink, tQuestion, 80, 30);
  int heroY = nl >= 2 ? 190 : 162;
  if (enter(tQuestion, 200, 0, {(int16_t)LX, (int16_t)(heroY - 62), 380, 76})) {
    char pv[8];
    snprintf(pv, sizeof(pv), "%d%%", (int)clampf(s.yes, 0, 100));
    rollSet(rHeroP, pv, s.move > 0 ? 1 : s.move < 0 ? -1 : rHeroP.dir);
    int nw = rollDraw(rHeroP, F_N2, LX - 2, heroY, locked ? P.ink2 : P.ink, P.yes, P.no, 700);
    if (rHeroP.t0 && prog(rHeroP.t0, 0, 1200) < 1) mark(LX - 4, heroY - 60, nw + 12, 76);
    int cx = LX + nw + 10;
    text(F_B1, cx, heroY - 2, "chance", P.ink2);
    int diff = s.nHist > 0 ? s.yes - s.hist[0] : 0;
    if (diff) {
      char d[16];
      snprintf(d, sizeof(d), "%d", diff > 0 ? diff : -diff);
      uint16_t dc = diff > 0 ? P.yes : P.no;
      int ax = cx + textW(F_B1, "chance") + 16;
      iconArrow(ax + 5, heroY - 9, 0.6f, diff > 0, dc);
      text(F_B2, ax + 14, heroY - 2, d, dc);
    }
  }
  layerReset();
  int chY = heroY + 20, chH = 446 - chY;
  if (enter(tQuestion, 260, 3, {(int16_t)(LX - 6), (int16_t)(chY - 10), (int16_t)(LW + 12), (int16_t)(chH + 16)}, 600)) heroChart(s, LX, chY, LW, chH, locked);
  layerReset();

  // ---- right rail
  const int RX = 556, RW = 224;
  if (enter(tQuestion, 160, 3, {(int16_t)(RX - 12), 66, (int16_t)(RW + 24), 400})) {
    rrect(RX - 12, 70, RW + 24, 382, 18, P.card);
    countdownBar(s, RX + 4, 104, RW - 8, locked);
    priceTile(s, true, RX, 132, RW, 58, locked);
    priceTile(s, false, RX, 200, RW, 58, locked);
    if (locked) {
      const Btn *y = findBtn(s, "resolve:yes");
      const Btn *n = findBtn(s, "resolve:no");
      if (y || n) text(F_B3, RX + 4, 292, "Settle it", P.muted);
      if (y) button(RX, 304, RW, 48, *y, F_B2, 24);
      if (n) button(RX, 362, RW, 48, *n, F_B2, 24);
      if (!y && !n) {
        text(F_B3, RX + 4, 300, "Watch the play.", P.ink2);
        text(F_B3, RX + 4, 322, "The result comes in by itself.", P.muted);
      }
    } else {
      text(F_B3, RX + 4, 290, "Recent trades", P.muted);
      int y = 300;
      if (s.nTrades == 0) text(F_B3, RX + 4, y + 22, "No trades yet", P.muted);
      for (int i = 0; i < min(3, s.nTrades); i++) {
        const TradeRow &t = s.trades[i];
        char key[48];
        snprintf(key, sizeof(key), "%s%d%d%d", t.name, t.cents, t.yes, s.nHist);
        uint32_t born = i == 0 ? seenAt(seenTrades, strHash(key), NOW - tQuestion < 400) : 0;
        float sl = born ? prog(born, 0, 420) : 1;
        if (sl < 1) {
          layer((int)((1 - eOut(sl)) * 24), 0, (uint8_t)(255 * clampf(sl * 2, 0, 1)));
          mark(RX - 4, y + i * 32 - 2, RW + 30, 32);
        }
        int ry = y + i * 32;
        avatar(RX + 14, ry + 14, 10, t.name);
        char nm[24];
        fit(F_B3, t.name, 86, nm, sizeof(nm));
        text(F_B3, RX + 32, ry + 19, nm, P.ink);
        text(F_B3, RX + 124, ry + 19, t.yes ? "Yes" : "No", t.yes ? P.yes : P.no);
        char m[16];
        fmtMoney(t.cents, m, sizeof(m));
        textRight(F_B3, RX + RW - 4, ry + 19, m, P.ink2);
        if (i < min(3, s.nTrades) - 1) fill(RX + 4, ry + 30, RW - 8, 1, P.rule);
        layerReset();
      }
    }
  }
  layerReset();
}

// ---------------------------------------------------------------- result

static void peopleCard(int x, int y, int w, int h, const char *title, bool win, const Person *ps, int n, int scrollIdx, uint32_t t0, int delay, const char *empty) {
  float p = prog(t0, delay, 520);
  if (p <= 0) {
    mark(x - 10, y - 10, w + 20, h + 40);
    return;
  }
  if (p < 1) {
    layer(0, (int)((1 - eBack(p, 1.2f)) * 24), (uint8_t)(255 * clampf(p * 2.2f, 0, 1)));
    mark(x - 10, y - 10, w + 20, h + 40);
  }
  card(x, y, w, h, 20);
  iconArrow(x + 20, y + 21, 0.8f, win, win ? P.yes600 : P.no600);
  text(F_B1, x + 34, y + 28, title, win ? P.yes600 : P.no600);
  int listY = y + 38, listH = h - 44, rowH = 34;
  float off = scrollArea(scrollIdx, x, listY, w, listH, n * rowH);
  pushClip(x, listY, w, listH);
  if (n == 0) text(F_B2, x + 16, listY + 24, empty, P.ink2);
  for (int i = 0; i < n; i++) {
    int ry = listY + i * rowH - (int)off;
    if (ry + rowH < listY || ry > listY + listH) continue;
    const Person &q = ps[i];
    avatar(x + 28, ry + 16, 12, q.name, win ? 255 : 150);
    char m[20], lab[28];
    if (win) {
      fmtMoney(q.has2 ? max<int32_t>(0, q.extra) : q.cents, m, sizeof(m), q.has2);
      snprintf(lab, sizeof(lab), q.has2 ? "%s won" : "%s", m);
    } else {
      fmtMoney(q.cents, m, sizeof(m));
      snprintf(lab, sizeof(lab), "%s lost", m);
    }
    int lw = textW(F_N4, lab);
    textFit(F_B1, x + 48, ry + 23, w - 64 - lw - 8, q.name, win ? P.ink : P.ink2);
    textRight(F_N4, x + w - 14, ry + 23, lab, win ? P.ink2 : P.muted);
    // the glint across each winner's name
    if (win) {
      float g = prog(t0, delay + 400 + i * 180, 700);
      if (g > 0 && g < 1) {
        int gx = x + 40 + (int)((w - 60) * g);
        for (int k = 0; k < 24; k++) fill(gx + k, ry + 2, 1, rowH - 6, P.white, (uint8_t)(120 * (1 - fabsf(k - 12.f) / 12.f)));
        mark(x, ry, w, rowH);
      }
    }
  }
  popClip();
  if (scrolls[scrollIdx].maxOff > 0) {
    Scroller &sc = scrolls[scrollIdx];
    int barH = max(20, listH * listH / max(1, n * rowH));
    int barY = listY + (int)((listH - barH) * clampf(sc.off / max(1.f, sc.maxOff), 0, 1));
    rrect(x + w - 8, barY, 4, barH, 2, P.ink, NOW - sc.lastMove < 1200 ? 110 : 40);
    if (NOW - sc.lastMove < 1500) mark(x + w - 10, listY, 10, listH);
  }
  layerReset();
}

static void drawResult(const Screen &s, const NetStatus &st) {
  wordmark(20, 40);
  int rx = SCR_W - 16;
  topRight(s, rx, st);
  if (s.hasScore) scorebug(s, rx, 10, 42);
  else codeChip(s, rx);

  const int SX = 12, SY = 64, SW = 776, SH = 404;
  bool yes = s.result == 'Y';
  bool voided = !s.result;
  uint16_t win = voided ? P.well : yes ? P.yes : P.no;
  uint16_t on = voided ? P.ink : yes ? P.white : P.ink;
  float zp = prog(tResult, 0, 480);
  int z = (int)((1 - eBack(zp, 1.1f)) * 12);
  card(SX + z, SY + z, SW - 2 * z, SH - 2 * z, 30);
  // flood: from the winner's share of the split to the whole stage
  float fp = prog(tResult, 150, 650);
  float share = s.lockYes >= 0 ? s.lockYes / 100.f : (yes ? s.yes / 100.f : s.no / 100.f);
  if (!yes) share = s.lockYes >= 0 ? 1 - s.lockYes / 100.f : share;
  share = clampf(share, 0.05f, 0.95f);
  float fw = share + (1 - share) * eBack(fp, 0.6f);
  int floodW = (int)(SW * clampf(fw, 0, 1));
  if (fp > 0) {
    if (yes || voided) pushClip(SX, SY, floodW, SH);
    else pushClip(SX + SW - floodW, SY, floodW, SH);
    rrect(SX + z, SY + z, SW - 2 * z, SH - 2 * z, 30, win);
    popClip();
  }
  if (fp < 1 || zp < 1) mark(0, SY - 16, SCR_W, SCR_H - SY + 16);
  uint16_t txt = fp > 0.5f ? on : P.ink;

  float tp = prog(tResult, 120, 300);
  uint8_t ta = (uint8_t)(255 * tp);
  text(F_B2, 36, 98, voided ? "Voided" : "Result", txt, ta);
  int starts[2], lens[2];
  bool cut;
  int n = wrap(F_H3, s.question, 720, 2, starts, lens, &cut);
  for (int i = 0; i < n; i++) {
    char buf[224];
    int l = min(lens[i], 200);
    memcpy(buf, s.question + starts[i], l);
    buf[l] = 0;
    if (i == n - 1 && cut) {
      char tmp[224];
      snprintf(tmp, sizeof(tmp), "%s ...", buf);
      fit(F_H3, tmp, 720, buf, sizeof(buf));
    }
    text(F_H3, 36, 128 + i * 28, buf, txt, (uint8_t)(ta * 0.92f));
  }
  // the winner word stamps in
  float sp = prog(tResult, 380, 820);
  if (sp > 0) {
    float e = eBack(sp, 2.2f);
    int dy = (int)((1 - e) * -34);
    uint8_t a = (uint8_t)(255 * clampf(sp * 2.2f, 0, 1));
    layer(0, dy, a);
    const char *word = voided ? "Refunded" : yes ? "YES" : "NO";
    const HFont &hf = voided ? F_H1 : F_HERO;
    int hy = 262;
    if (!voided) iconCheck(70, hy - 34, 2.6f, on);
    text(hf, voided ? 36 : 112, voided ? 232 : hy, word, voided ? P.ink : on);
    layerReset();
    if (sp < 1) mark(20, 150, 520, 130);
  } else {
    mark(20, 150, 520, 130);
  }
  // summary on the right of the word
  if (enter(tResult, 600, 3, {360, 180, 400, 80})) {
    char m[20], l1[48];
    if (s.volume >= 0) {
      fmtMoney(s.volume, m, sizeof(m));
      snprintf(l1, sizeof(l1), "%s traded", m);
    } else {
      strlcpy(l1, s.traded, sizeof(l1));
    }
    textRight(F_N3, 760, 218, l1, on);
    char l2[40];
    snprintf(l2, sizeof(l2), "%d %s", s.nWinners, s.nWinners == 1 ? "winner" : "winners");
    textRight(F_B1, 760, 248, s.nWinners || s.nLosers ? l2 : "Winning shares pay $1", on, 230);
  }
  layerReset();

  // who won what
  int cy = 274, ch = 112, cw = (SW - 48 - 12) / 2;
  if (s.hasWinners || !s.nLines) {
    peopleCard(SX + 24, cy, cw, ch, "Called it", true, s.winners, s.nWinners, 0, tResult, 760, "Nobody. Brutal.");
    peopleCard(SX + 24 + cw + 12, cy, cw, ch, "Cooked", false, s.losers, s.nLosers, 1, tResult, 840, "Clean sweep.");
  } else {  // old contract: plain lines
    Person tmp[MAX_LINES];
    int nn = 0;
    for (int i = 0; i < s.nLines && i < MAX_LINES; i++) {
      memset(&tmp[nn], 0, sizeof(Person));
      strlcpy(tmp[nn].name, s.lines[i], sizeof(tmp[nn].name));
      nn++;
    }
    peopleCard(SX + 24, cy, SW - 48, ch, "Called it", true, tmp, nn, 0, tResult, 760, "");
  }

  // buttons: Next (ink) | Call it! moments | End
  const Btn *next = findBtn(s, "next");
  const Btn *end = findBtn(s, "end");
  if (enter(tResult, 900, 0, {SX + 24, 396, SW - 48, 64})) {
    int x = SX + 24, x1 = SX + SW - 24;
    bool calls = s.nCalls > 0;
    if (next) {
      Btn b = *next;
      b.style = voided ? B_BRAND : B_INK;
      // With Call it! buttons beside it, Next shrinks to its label so the calls get the room.
      int w = calls ? min(230, textW(F_B1, b.label) + 62) : 230;
      button(x, 396, w, 62, b, F_B1, 20);
      x += w + 12;
    }
    if (end) {
      Btn b = *end;
      b.style = next ? B_WHITE : B_INK;
      int w = calls ? min(120, textW(F_B1, b.label) + 44) : next ? 120 : 230;
      button(x1 - w, 396, w, 62, b, F_B1, 20);
      x1 -= w + 12;
    }
    callRow(s.calls, s.nCalls, x, x1, 396, 62, 18);
  }
  layerReset();
  if (!voided && s.nWinners > 0) {
    uint16_t cols[5] = {P.gold, P.lime, P.white, P.accent, yes ? rgb(0x9CC2FF) : rgb(0xFFC08A)};
    burst(tResult, 520, 240, 230, min(48, 18 + s.nWinners * 6), (int)strHash(s.question) & 0xFFFF, cols, 5);
  }
}

// ---------------------------------------------------------------- ended: podium + leaderboard

static void drawEnded(const Screen &s, const NetStatus &st) {
  wordmark(20, 40);
  text(F_H2, 176, 42, s.title[0] ? s.title : "Session over", P.ink);
  int rx = SCR_W - 16;
  topRight(s, rx, st);
  int tx = 176 + textW(F_H2, s.title[0] ? s.title : "Session over") + 16;
  textFit(F_B2, tx, 41, rx - tx - 8, s.subtitle, P.ink2);

  // Leaderboard data: new field, else parse "1.  Sam  $12.00" lines.
  Person board[MAX_PEOPLE];
  int nb = s.nBoard;
  if (nb) memcpy(board, s.board, sizeof(Person) * nb);
  else {
    for (int i = 0; i < s.nLines && nb < MAX_PEOPLE; i++) {
      memset(&board[nb], 0, sizeof(Person));
      const char *l = s.lines[i];
      const char *p = strstr(l, ".  ");
      p = p ? p + 3 : l;
      const char *d = strrchr(p, '$');
      int len = d ? (int)(d - p) : (int)strlen(p);
      while (len > 0 && p[len - 1] == ' ') len--;
      memcpy(board[nb].name, p, min(len, 23));
      board[nb].cents = d ? (int32_t)(atof(d + 1) * 100 + 0.5) : 0;
      nb++;
    }
  }

  // podium (left)
  const int PX = 16, PW = 380, base = 452;
  struct Slot { int rank, x, h; } slots[3] = {{2, PX + 8, 104}, {1, PX + 134, 156}, {3, PX + 260, 72}};
  for (int k = 0; k < 3; k++) {
    int rank = slots[k].rank;
    if (rank > nb) continue;
    const Person &p = board[rank - 1];
    int x = slots[k].x, w = 112, h = slots[k].h, y = base - h;
    int delay = rank == 1 ? 520 : rank == 2 ? 300 : 120;
    float pr = prog(tScreen, delay, 640);
    if (pr <= 0) {
      mark(x - 10, 60, w + 20, SCR_H - 60);
      continue;
    }
    float e = eBack(pr, 1.3f);
    int bh = (int)(h * clampf(e, 0, 1.2f));
    if (pr < 1) mark(x - 10, 60, w + 20, SCR_H - 60);
    pushClip(0, 0, SCR_W, base);  // flat bottoms: the podium stands on the line
    if (rank == 1) rrectGrad(x, base - bh, w, bh + 20, 18, P.deep, P.accent, P.lime);
    else if (rank == 2) rrect(x, base - bh, w, bh + 20, 18, P.ink);
    else {
      shadow(x, base - bh, w, bh + 20, 18);
      rrect(x, base - bh, w, bh + 20, 18, P.card);
      rrectStroke(x, base - bh, w, bh + 20, 18, 1, P.rule);
    }
    popClip();
    char rk[4];
    snprintf(rk, sizeof(rk), "%d", rank);
    if (bh > 50) textCenter(F_N2, x + w / 2, base - bh + 58, rk, rank == 3 ? P.ink : P.white, (uint8_t)(255 * clampf(pr * 2, 0, 1)));
    uint8_t a = (uint8_t)(255 * clampf((pr - 0.4f) * 2.5f, 0, 1));
    int ay = y - 92;
    avatar(x + w / 2, ay + 22, 22, p.name, a);
    if (rank == 1 && !s.boardTie) iconCrown(x + w / 2, ay - 12, 1.2f, P.gold, a);
    char nm[24];
    fit(F_B1, p.name, w + 8, nm, sizeof(nm));
    textCenter(F_B1, x + w / 2, ay + 66, nm, P.ink, a);
    char m[16];
    fmtMoney(p.cents, m, sizeof(m));
    textCenter(F_N4, x + w / 2, ay + 88, m, rank == 1 ? P.deep : P.ink2, a);
  }
  if (nb == 0) {
    textCenter(F_B1, PX + PW / 2, 260, "No players this time", P.ink2);
  }
  fill(PX, base, PW, 2, P.ruleStrong);
  if (s.verdict[0]) textFit(F_B3, PX, 472, PW, s.verdict, P.ink2);

  // standings (right, scrolls)
  const int LX = 412, LW = SCR_W - 16 - LX;
  text(F_H3, LX, 92, "Final standings", P.ink);
  int listY = 104, listH = 286, rowH = 56, gap = 6;
  float off = scrollArea(0, LX - 4, listY, LW + 8, listH, nb * (rowH + gap));
  pushClip(LX - 8, listY, LW + 16, listH);
  for (int i = 0; i < nb; i++) {
    int ry = listY + i * (rowH + gap) - (int)off;
    if (ry + rowH < listY || ry > listY + listH) continue;
    float pr = prog(tScreen, 300 + i * 70, 480);
    if (pr <= 0) {
      mark(LX - 10, ry - 4, LW + 60, rowH + 8);
      continue;
    }
    if (pr < 1) {
      layer((int)((1 - eBack(pr, 1.2f)) * 40), 0, (uint8_t)(255 * clampf(pr * 2, 0, 1)));
      mark(LX - 10, ry - 4, LW + 60, rowH + 8);
    }
    const Person &p = board[i];
    bool lead = i == 0 && !s.boardTie;
    if (lead) rrect(LX, ry, LW, rowH, 16, P.ink);
    else card(LX, ry, LW, rowH, 16);
    char rk[4];
    snprintf(rk, sizeof(rk), "%d", p.rank > 0 ? p.rank : i + 1);
    textCenter(F_N4, LX + 20, ry + 35, rk, lead ? P.gold : P.muted);
    avatar(LX + 54, ry + rowH / 2, 17, p.name);
    char m[16];
    fmtMoney(p.cents, m, sizeof(m));
    int mw = textW(F_N4, m);
    textFit(F_B1, LX + 80, ry + 35, LW - 100 - mw, p.name, lead ? P.white : P.ink);
    if (p.has2 && p.extra != 0) {
      textRight(F_N4, LX + LW - 14, ry + 27, m, lead ? P.white : P.ink);
      char pl[16];
      fmtMoney(p.extra, pl, sizeof(pl), true);
      uint16_t c = lead ? P.lime : p.extra > 0 ? P.yes600 : P.no600;
      int pw = textW(F_B3, pl);
      iconArrow(LX + LW - 14 - pw - 9, ry + 42, 0.55f, p.extra > 0, c);
      textRight(F_B3, LX + LW - 14, ry + 47, pl, c);
    } else {
      textRight(F_N4, LX + LW - 14, ry + 36, m, lead ? P.white : P.ink);
    }
    layerReset();
  }
  popClip();
  if (scrolls[0].maxOff > 0) {
    Scroller &sc = scrolls[0];
    int barH = max(30, listH * listH / max(1, nb * (rowH + gap)));
    int barY = listY + (int)((listH - barH) * clampf(sc.off / max(1.f, sc.maxOff), 0, 1));
    rrect(SCR_W - 9, barY, 4, barH, 2, P.ink, NOW - sc.lastMove < 1200 ? 110 : 40);
    if (NOW - sc.lastMove < 1500) mark(SCR_W - 12, listY, 12, listH);
  }
  const Btn *nw = findBtn(s, "new");
  if (nw && enter(tScreen, 700, 0, {(int16_t)LX, 400, (int16_t)LW, 66})) {
    Btn b = *nw;
    b.style = B_BRAND;
    button(LX, 400, LW, 66, b, F_H3, 22);
  }
  layerReset();
  if (nb > 0) {
    uint16_t cols[5] = {P.gold, P.lime, P.accent, P.yes, P.no};
    burst(tScreen, 900, PX + 190, 230, 40, 7, cols, 5);
  }
}

// ---------------------------------------------------------------- pages: market / locked / result scroll down
//
// The first 480 px of the page are the screen as it always was. Under it: the odds graph, "Odds right now" and
// recent trades + standings. Drag anywhere to scroll (momentum, rubber band, snaps to each section); the page
// moves by shifting the frame buffer, so a scroll frame only draws the strip that came into view.

static bool pageDrawnValid = false;  // the panel shows the page drawn at pageDrawnY
static int pageDrawnY = 0;
static int blitD = 0;  // rows the page shifts this frame (set before the measure pass)

// Fixed elements drawn over a scrolling page (screen coordinates: sticky header, scrollbar, toast, pay card).
// When the page shifts, their old pixels moved with it, so they and the band they slid through are redrawn.
static Rect ovNow[8], ovPrev[8];
static int nOvNow = 0, nOvPrev = 0;
static void overlay(int x, int y, int w, int h) {
  if (!measuring) return;
  if (nOvNow < 8) ovNow[nOvNow++] = {(int16_t)x, (int16_t)y, (int16_t)w, (int16_t)h};
  if (blitD) mark(x, y - abs(blitD), w, h + 2 * abs(blitD));
}

static bool hasPage(const Screen &s) {
  return (s.scr == S_MARKET || s.scr == S_LOCKED || s.scr == S_RESULT) && (s.chart.has || s.nOdds > 0 || s.nStand > 0);
}

struct PageLayout {
  int chartY, chartH, oddsY, oddsH, listY, listH, endY, contentH;
};
static PageLayout pageLayout(const Screen &s) {
  PageLayout L;
  L.chartY = SCR_H + 8;
  L.chartH = s.chart.has ? 348 : 0;
  L.oddsY = L.chartY + (L.chartH ? L.chartH + 20 : 0);
  L.oddsH = 64 + max(1, s.nOdds) * 66;
  L.listY = L.oddsY + L.oddsH + 12;
  L.listH = 58 + constrain(max(s.nTrades, s.nStand), 1, 8) * 38 + 10;
  L.endY = L.listY + L.listH + 20;
  L.contentH = L.endY + 62 + 18;
  return L;
}

// How much of [y, y+h) (page coordinates) is on screen.
static int pageVis(int y, int h) { return min(y + h, pageY + SCR_H) - max(y, pageY); }
static bool onPage(int y, int h) { return pageVis(y, h) > 0; }
// A section animates in the first time a good part of it is on screen.
static void seen(uint32_t &t, int y, int h) {
  if (measuring && !t && pageVis(y, h) >= min(h / 3, 150)) t = NOW ? NOW : 1;
}

static Watch wChart, wOdds, wStand, wHdr, wPay;

// A small line of earlier values (odds rows): auto-ranged, stepped for the room's price, end dot.
static void miniLine(const int8_t *v, int n, int x, int y, int w, int h, uint16_t c, bool stepped) {
  if (n < 2) return;
  int lo = 100, hi = 0;
  for (int i = 0; i < n; i++) {
    lo = min<int>(lo, v[i]);
    hi = max<int>(hi, v[i]);
  }
  int mid = (lo + hi) / 2, sp = max(20, hi - lo + 6);
  lo = constrain(mid - sp / 2, 0, max(0, 100 - sp));
  hi = lo + sp;
  auto py = [&](int val) { return y + h - 2 - ((val - lo) * (h - 4)) / max(1, hi - lo); };
  auto px = [&](int i) { return x + (i * (w - 6)) / (n - 1); };
  for (int i = 1; i < n; i++) {
    if (stepped) {
      line(px(i - 1), py(v[i - 1]), px(i), py(v[i - 1]), 2.2f, c);
      line(px(i), py(v[i - 1]), px(i), py(v[i]), 2.2f, c);
    } else {
      line(px(i - 1), py(v[i - 1]), px(i), py(v[i]), 2.2f, c);
    }
  }
  circle(px(n - 1), py(v[n - 1]), 3.6f, c);
}

// The odds graph: room YES price over the question (stepped, filled), Gemini's price, the model's line, the lock,
// the outcome; axis 0-100% with gridlines, current values at the right. Draws on left to right when it first shows.
static void chartSection(const Screen &s, int y, int h) {
  const Chart &c = s.chart;
  if (!c.has) return;
  seen(tChartIn, y, h);
  watch(wChart, s.chartHash, 0, y - 4, SCR_W, h + 12);
  if (!onPage(y - 10, h + 20)) return;
  const int X = 12, W = 776;
  card(X, y, W, h, 26);
  text(F_H3, 32, y + 40, "Odds graph", P.ink);
  textFit(F_B2, 32, y + 66, 736, s.question, P.ink2);
  // legend (right to left on the title line)
  int lx = 768;
  const int ly = y + 34;
  if (c.hasGem) {
    lx -= textW(F_B3, "Gemini");
    text(F_B3, lx, y + 40, "Gemini", P.ink2);
    lx -= 30;
    line(lx, ly, lx + 22, ly, 2.4f, P.ink);
    tri(lx + 5, ly - 7, lx + 17, ly - 7, lx + 11, ly + 3, P.ink);
    tri(lx + 8, ly - 5.5f, lx + 14, ly - 5.5f, lx + 11, ly - 0.5f, P.card);
    lx -= 16;
  }
  if (c.model >= 0) {
    lx -= textW(F_B3, "Model");
    text(F_B3, lx, y + 40, "Model", P.ink2);
    lx -= 30;
    for (int k = 0; k < 3; k++) line(lx + k * 8, ly, lx + k * 8 + 5, ly, 2.2f, P.ink, 190);
    lx -= 16;
  }
  lx -= textW(F_B3, "Room");
  text(F_B3, lx, y + 40, "Room", P.ink2);
  lx -= 30;
  line(lx, ly, lx + 22, ly, 3.4f, P.yes);

  const int px0 = 72, px1 = 668, py0 = y + 96, py1 = y + 300;
  auto PY = [&](int v) { return py1 - (v * (py1 - py0)) / 100; };
  auto PX = [&](int i) { return px0 + (int)(((int32_t)(px1 - px0) * c.span * i) / (100 * (c.n - 1))); };
  const int spanX = px0 + (px1 - px0) * c.span / 100;
  // still trading: the rest of the window up to the lock is shaded
  bool future = s.scr == S_MARKET && spanX < px1 - 2;
  if (future) fill(spanX, py0, px1 - spanX, py1 - py0, P.well, 170);
  for (int v = 0; v <= 100; v += 25) {
    int gy = PY(v);
    fill(px0, gy, px1 - px0, 1, v == 50 ? P.ruleStrong : P.rule);
    char lab[8];
    snprintf(lab, sizeof(lab), "%d%%", v);
    textRight(F_B3, px0 - 10, gy + 5, lab, P.muted);
  }
  // axis labels and the lock
  text(F_B3, px0, py1 + 26, c.x0[0] ? c.x0 : "Open", P.muted);
  textRight(F_B3, px1, py1 + 26, c.x1[0] ? c.x1 : "Now", P.muted);
  // The lock marker (not where the outcome's marker stands: a host-settled question locks just before it).
  int lockX = -1;
  if (c.lock >= 0 && !(c.outcome && c.lock >= 96)) {
    int lxp = px0 + (px1 - px0) * c.lock / 100;
    lockX = lxp;
    for (int yy = py0 + 4; yy < py1; yy += 10) fill(lxp - 1, yy, 2, 5, P.ink, 140);
    iconLock(lxp, py0 - 6, 0.6f, P.ink);
    if (lxp - px0 > 70 && px1 - lxp > 70) textCenter(F_B3, lxp, py1 + 26, "Locked", P.ink2);
  }
  if (future && px1 - spanX > 150) textCenter(F_B3, (spanX + px1) / 2, py1 - 14, "Trading until the lock", P.muted);
  float rp = tChartIn ? prog(tChartIn, 120, 900) : 0;
  if (rp < 1) mark(X, py0 - 30, W, py1 - py0 + 64);
  // the model's price: a dashed line across, fading in
  if (c.model >= 0) {
    int my = PY(c.model);
    uint8_t ma = (uint8_t)(170 * clampf(rp * 2, 0, 1));
    for (int x = px0; x < px1; x += 14) line(x, my, min(x + 8, px1), my, 2.2f, P.ink, ma);
  }
  // the lines, revealed left to right
  int revealX = px0 - 6 + (int)((spanX - px0 + 46) * eOut(rp));
  pushClip(px0 - 8, py0 - 24, max(0, revealX - (px0 - 8)), py1 - py0 + 48);
  int16_t xs[2 * MAX_CHART], ys[2 * MAX_CHART];
  int k = 0;
  for (int i = 0; i < c.n; i++) {
    int px = PX(i), py = PY(c.room[i]);
    if (k > 0) {
      xs[k] = px;
      ys[k] = ys[k - 1];
      k++;
    }
    xs[k] = px;
    ys[k] = py;
    k++;
  }
  fillUnderLine(xs, ys, k, py1, mix(P.card, P.yes, 30), 255);
  if (c.hasGem)
    for (int i = 1; i < c.n; i++)
      if (c.gem[i - 1] >= 0 && c.gem[i] >= 0) line(PX(i - 1), PY(c.gem[i - 1]), PX(i), PY(c.gem[i]), 2.4f, P.ink);
  for (int i = 0; i + 1 < k; i++) line(xs[i], ys[i], xs[i + 1], ys[i + 1], 3.2f, P.yes);
  popClip();
  float ex = xs[k - 1], ey = ys[k - 1];
  if (rp >= 1) {
    if (s.scr == S_MARKET) {  // live: the end of the line pings
      float p = (NOW % 1600) / 1600.f;
      if (p < 0.8f) circle(ex, ey, 5 + 11 * eOut(p / 0.8f), P.yes, (uint8_t)(110 * (1 - p / 0.8f)));
      markAmbient((int)ex - 20, (int)ey - 20, 40, 40);
    }
    circle(ex, ey, 5.5f, P.yes);
    circle(ex, ey, 2.4f, P.card);
  }
  // the outcome: where it settled
  uint8_t ta = (uint8_t)(255 * clampf((rp - 0.6f) * 2.5f, 0, 1));
  if (c.outcome && ta) {
    bool yes = c.outcome == 'Y';
    int oy = PY(yes ? 100 : 0);
    for (int yy = min((int)ey, oy) + 6; yy < max((int)ey, oy) - 6; yy += 9) fill((int)ex - 1, yy, 2, 4, yes ? P.yes : P.no600, ta);
    ring(ex, oy, 12, 2.5f, yes ? P.yes : P.no, ta / 2);
    circle(ex, oy, 8, yes ? P.yes : P.no, ta);
    const char *lab = yes ? "It was YES" : "It was NO";
    int labR = (int)ex - 18;
    if (lockX > 0 && labR - lockX < 150 && lockX < labR) labR = lockX - 10;  // keep clear of the lock line
    textRight(F_B1, labR, oy + (yes ? 24 : -10), lab, yes ? P.yes600 : P.no600, ta);
  }
  // current values, kept apart, at the right
  struct Tag {
    int y, v;
    uint8_t kind;  // 0 room, 1 gemini, 2 model
  } tags[3];
  int nt = 0;
  tags[nt++] = {PY(c.room[c.n - 1]), c.room[c.n - 1], 0};
  if (c.hasGem) {
    int g = -1;
    for (int i = c.n - 1; i >= 0 && g < 0; i--) g = c.gem[i];
    if (g >= 0) tags[nt++] = {PY(g), g, 1};
  }
  if (c.model >= 0) tags[nt++] = {PY(c.model), c.model, 2};
  for (int a = 0; a < nt; a++)
    for (int b = a + 1; b < nt; b++)
      if (tags[b].y < tags[a].y) {
        Tag t = tags[a];
        tags[a] = tags[b];
        tags[b] = t;
      }
  int ty[3];
  for (int i = 0; i < nt; i++) ty[i] = i ? max(tags[i].y, ty[i - 1] + 30) : max(tags[i].y, py0 - 8);
  int over = ty[nt - 1] - (py1 + 8);
  if (over > 0)
    for (int i = 0; i < nt; i++) ty[i] -= over;
  for (int i = 0; i < nt; i++) {
    char v[8];
    snprintf(v, sizeof(v), "%d%%", tags[i].v);
    int w = textW(F_N4, v) + 22, tx = 684;
    uint16_t bg = tags[i].kind == 0 ? P.yes : tags[i].kind == 1 ? P.ink : P.card;
    uint16_t fg = tags[i].kind == 2 ? P.ink : P.white;
    int fromX = tags[i].kind == 0 ? (int)ex + 8 : (tags[i].kind == 2 ? px1 : spanX) + 4;
    if (fromX < tx - 4) {  // flat from the line, bending only next to the tag, so it never reads as a price move
      uint16_t lc = tags[i].kind == 0 ? P.yes : P.ink;
      int bendX = max(fromX, tx - 18);
      if (bendX > fromX) line(fromX, tags[i].y, bendX, tags[i].y, 1.2f, lc, ta / 3);
      line(bendX, tags[i].y, tx - 2, ty[i], 1.2f, lc, ta / 3);
    }
    rrect(tx, ty[i] - 13, w, 26, 13, bg, ta);
    if (tags[i].kind == 2) rrectStroke(tx, ty[i] - 13, w, 26, 13, 2, P.ink, ta);
    text(F_N4, tx + 11, ty[i] + 7, v, fg, ta);
  }
}

static void oddsRow(const OddsRow &r, int x, int y, int w, int h) {
  card(x, y, w, h, 18);
  if (r.room) rrectStroke(x, y, w, h, 18, 2, P.accent, 120);
  int cx = x + 14, cy = y + (h - 26) / 2, cw;
  if (r.room) {
    cw = pill(cx, cy, 26, "Room", F_B3, P.accentTint, P.deep);
  } else {
    cw = textW(F_B3, "Gemini") + 36;
    rrect(cx, cy, cw, 26, 13, P.ink);
    tri(cx + 9, cy + 8, cx + 21, cy + 8, cx + 15, cy + 19, P.white);
    tri(cx + 12, cy + 9.5f, cx + 18, cy + 9.5f, cx + 15, cy + 15, P.ink);
    text(F_B3, cx + 26, cy + 18, "Gemini", P.white);
  }
  char v[8];
  snprintf(v, sizeof(v), "%d%%", r.p);
  textRight(F_N3, x + w - 16, y + h / 2 + 12, v, r.room ? P.yes600 : P.ink);
  int valL = x + w - 16 - 86;
  int sparkX = valL - 164;
  bool spark = r.nHist >= 2;
  if (spark) miniLine(r.hist, r.nHist, sparkX, y + 12, 150, h - 24, r.room ? P.yes : P.ink2, r.room);
  int lx = cx + cw + 12;
  textFit(F_B1, lx, y + h / 2 + 7, (spark ? sparkX - 18 : valL - 10) - lx, r.label, P.ink);
}

static void oddsSection(const Screen &s, int y, int h) {
  seen(tOddsIn, y, h);
  watch(wOdds, s.oddsHash, 0, y - 4, SCR_W, h + 8);
  if (!onPage(y - 8, h + 16)) return;
  text(F_H3, 24, y + 30, "Odds right now", P.ink);
  if (s.oddsNote[0]) textFit(F_B3, 24, y + 52, 752, s.oddsNote, P.muted);
  if (!s.nOdds) {
    card(16, y + 64, 768, 58, 18);
    text(F_B2, 34, y + 64 + 36, "No odds to show yet.", P.ink2);
    return;
  }
  for (int i = 0; i < s.nOdds; i++) {
    int ry = y + 64 + i * 66;
    if (!onPage(ry - 8, 74)) continue;
    float p = tOddsIn ? prog(tOddsIn, 60 + i * 70, 480) : 0;
    if (p <= 0) {
      mark(0, ry - 6, SCR_W, 72);
      continue;
    }
    if (p < 1) {
      layer((int)((1 - eBack(p, 1.2f)) * 40), 0, (uint8_t)(255 * clampf(p * 2, 0, 1)));
      mark(0, ry - 6, SCR_W, 72);
    }
    oddsRow(s.odds[i], 16, ry, 768, 58);
    layerReset();
  }
}

static void listsSection(const Screen &s, int y, int h) {
  seen(tListIn, y, h);
  watch(wStand, s.standHash, 0, y - 4, SCR_W, h + 8);
  if (!onPage(y - 8, h + 16)) return;
  const int cw = 378, rowH = 38;
  for (int side = 0; side < 2; side++) {
    int x = side ? 406 : 16;
    float p = tListIn ? prog(tListIn, side * 90, 520) : 0;
    if (p <= 0) {
      mark(x - 10, y - 10, cw + 20, h + 30);
      continue;
    }
    if (p < 1) {
      layer(0, (int)((1 - eBack(p, 1.2f)) * 24), (uint8_t)(255 * clampf(p * 2.2f, 0, 1)));
      mark(x - 10, y - 10, cw + 20, h + 40);
    }
    card(x, y, cw, h, 22);
    text(F_H3, x + 18, y + 36, side ? "Standings" : "Recent trades", P.ink);
    int n = side ? min(8, s.nStand) : min(8, s.nTrades);
    if (n == 0) text(F_B2, x + 18, y + 80, side ? "No players" : "No trades", P.ink2);
    for (int i = 0; i < n; i++) {
      int ry = y + 54 + i * rowH;
      if (!side) {
        const TradeRow &t = s.trades[i];
        avatar(x + 30, ry + 15, 13, t.name);
        char nm[24];
        fit(F_B1, t.name, 126, nm, sizeof(nm));
        text(F_B1, x + 52, ry + 22, nm, P.ink);
        uint16_t col = t.yes ? P.yes600 : P.no600;
        iconArrow(x + 192, ry + 14, 0.6f, t.yes, col);
        text(F_B3, x + 202, ry + 20, t.yes ? "Yes" : "No", col);
        if (t.price >= 0) {
          char pr[8];
          snprintf(pr, sizeof(pr), "@%d%%", t.price);
          text(F_B3, x + 240, ry + 20, pr, P.muted);
        }
        char m[16];
        fmtMoney(t.cents, m, sizeof(m));
        textRight(F_N4, x + cw - 16, ry + 22, m, P.ink);
      } else {
        const Person &q = s.stand[i];
        bool lead = i == 0 && !s.standTie;
        if (lead) rrect(x + 8, ry - 4, cw - 16, 36, 12, P.ink);
        char rk[4];
        snprintf(rk, sizeof(rk), "%d", q.rank > 0 ? q.rank : i + 1);
        textCenter(F_N4, x + 28, ry + 22, rk, lead ? P.gold : P.muted);
        avatar(x + 60, ry + 14, 13, q.name);
        char m[16], pl[16] = "";
        fmtMoney(q.cents, m, sizeof(m));
        int mw = textW(F_N4, m);
        if (q.has2 && q.extra != 0) fmtMoney(q.extra, pl, sizeof(pl), true);
        int pw = pl[0] ? textW(F_B3, pl) + 10 : 0;
        textFit(F_B1, x + 82, ry + 22, cw - 82 - 16 - mw - pw - 10, q.name, lead ? P.white : P.ink);
        textRight(F_N4, x + cw - 16, ry + 22, m, lead ? P.white : P.ink);
        if (pl[0]) textRight(F_B3, x + cw - 16 - mw - 10, ry + 21, pl, lead ? P.lime : q.extra > 0 ? P.yes600 : P.no600);
      }
    }
    layerReset();
  }
}

static void shortBadge(const Screen &s, char *out, size_t cap) {
  if (!strncmp(s.title, "Question ", 9)) {  // "Question 3 of 8" -> "Q3"
    int n = 0;
    out[n++] = 'Q';
    for (const char *p = s.title + 9; *p >= '0' && *p <= '9' && n < (int)cap - 1; p++) out[n++] = *p;
    out[n] = 0;
  } else {
    fit(F_B1, s.title[0] ? s.title : "Live", 120, out, cap);
  }
}

// Fixed parts of a page: the slim header that slides in once the view is scrolled away (tap = back to the top),
// the "more below" tab, the scrollbar.
static void pageChrome(const Screen &s, int contentH, int py) {
  Scroller &pg = scrolls[PAGE];
  if (pg.maxOff <= 0) return;
  // scrollbar
  int barH = max(36, SCR_H * SCR_H / max(1, contentH));
  int barY = (int)((SCR_H - barH) * clampf(pg.off / max(1.f, pg.maxOff), 0, 1));
  bool active = NOW - pg.lastMove < 1200 || (T.dragging && T.scroll == PAGE);
  overlay(SCR_W - 10, 0, 10, SCR_H);
  rrect(SCR_W - 7, barY + 3, 4, barH - 6, 2, P.ink, active ? 120 : 45);
  if (NOW - pg.lastMove < 1500) mark(SCR_W - 10, 0, 10, SCR_H);
  // "more below" tab on the bottom edge
  if (py < 60) {
    uint8_t a = (uint8_t)(255 * clampf(1 - py / 60.f, 0, 1));
    const char *lab = s.chart.has ? "Odds graph" : "More";
    int tw = textW(F_B3, lab) + 46, tx = (SCR_W - tw) / 2, ty = 460;
    overlay(tx - 4, ty - 6, tw + 8, SCR_H - ty + 6);
    rrect(tx, ty, tw, 40, 14, P.ink, a);
    text(F_B3, tx + 16, ty + 16, lab, P.white, a);
    float bob = 1.5f * sinf(NOW / 260.f);
    iconArrow(tx + tw - 18, ty + 10 + bob, 0.55f, false, P.white, a);
    markAmbient(tx + tw - 30, ty, 26, 20);
    hit(tx - 16, ty, tw + 32, SCR_H - ty, "ui:more");
  }
  // sticky header
  float hp = clampf((py - 150) / 40.f, 0, 1);
  if (hp <= 0) return;
  overlay(0, 0, SCR_W, 68);
  layer(0, (int)((hp - 1) * 24), (uint8_t)(255 * hp));
  fill(0, 0, SCR_W, 58, P.canvas);
  fill(0, 58, SCR_W, 1, P.rule);
  for (int i = 0; i < 6; i++) fill(0, 59 + i, SCR_W, 1, P.ink, 12 - i * 2);
  int x = 16;
  char b[40];
  if (s.scr == S_MARKET) {
    shortBadge(s, b, sizeof(b));
    int w = textW(F_B1, b) + 46;
    rrectGrad(x, 12, w, 34, 17, P.deep, P.accent, P.lime);
    iconBolt(x + 20, 29, 0.8f, P.white);
    text(F_B1, x + 34, 36, b, P.white);
    x += w + 12;
  } else if (s.scr == S_LOCKED) {
    int w = textW(F_B1, "Closed") + 48;
    rrect(x, 12, w, 34, 17, P.ink);
    iconLock(x + 20, 28, 0.75f, P.white);
    text(F_B1, x + 36, 36, "Closed", P.white);
    x += w + 12;
  } else {
    const char *r = s.result == 'Y' ? "YES" : s.result == 'N' ? "NO" : "Void";
    int w = pill(x, 12, 34, r, F_B1, s.result == 'Y' ? P.yes : s.result == 'N' ? P.no : P.well, s.result == 'Y' ? P.white : P.ink, 255, 16);
    x += w + 12;
  }
  int rx = SCR_W - 18;
  // Top: an up arrow and the word
  rx -= textW(F_B3, "Top");
  text(F_B3, rx, 35, "Top", P.ink2);
  iconArrow(rx - 12, 28, 0.6f, true, P.ink2);
  rx -= 34;
  if (s.scr != S_RESULT) {
    char v[16];
    snprintf(v, sizeof(v), "Yes %d\xC2\xA2", s.yes);
    int w = textW(F_B1, v) + 26;
    rx -= w;
    rrect(rx, 12, w, 34, 17, P.yes);
    text(F_B1, rx + 13, 36, v, P.white);
    rx -= 12;
  }
  if (s.scr == S_MARKET && s.hasLock && lockTotalMs > 0) {
    int32_t rem = remainingMs();
    int secs = (rem + 999) / 1000;
    char t[12];
    if (secs >= 60) snprintf(t, sizeof(t), "%d:%02d", secs / 60, secs % 60);
    else snprintf(t, sizeof(t), "%ds", secs);
    int w = textW(F_N4, t);
    watch(wHdr, (uint32_t)secs, rx - w - 40, 0, w + 44, 58);
    textRight(F_N4, rx, 37, t, secs <= 5 ? P.hot : P.ink);
    iconLock(rx - w - 16, 27, 0.6f, secs <= 5 ? P.hot : P.ink2);
    rx -= w + 34;
  }
  textFit(F_B1, x, 36, rx - x - 8, s.question, P.ink);
  if (isPressed("ui:top")) fill(0, 0, SCR_W, 58, P.ink, 18);
  layerReset();
  hit(0, 0, SCR_W, 58, "ui:top");
}

static void drawPage(const Screen &s, const NetStatus &st) {
  PageLayout L = pageLayout(s);
  Scroller &pg = scrolls[PAGE];
  pg.nSnaps = 0;
  pg.snaps[pg.nSnaps++] = 0;
  if (L.chartH) pg.snaps[pg.nSnaps++] = L.chartY - 66;
  pg.snaps[pg.nSnaps++] = L.oddsY - 66;
  pg.snaps[pg.nSnaps++] = L.listY - 66;
  float off = scrollArea(PAGE, 0, 0, SCR_W, SCR_H, L.contentH);
  pageY = (int)floorf(off);
  origin(0, -pageY);
  if (pageY < SCR_H) {
    if (s.scr == S_RESULT) drawResult(s, st);
    else drawMarket(s, st, s.scr == S_LOCKED);
  }
  layerReset();
  chartSection(s, L.chartY, L.chartH);
  oddsSection(s, L.oddsY, L.oddsH);
  listsSection(s, L.listY, L.listH);
  if (onPage(L.endY - 10, 90)) {
    Btn b = {};
    strlcpy(b.id, "ui:top", sizeof(b.id));
    strlcpy(b.label, "Back to top", sizeof(b.label));
    b.style = B_PLAIN;
    b.enabled = true;
    button(250, L.endY, 300, 62, b, F_B1, 22);
    iconArrow(250 + 40, L.endY + 31, 0.7f, true, P.ink2);
  }
  int py = pageY;
  if (!measuring) {
    pageDrawnValid = true;
    pageDrawnY = pageY;
  }
  pageY = 0;
  origin(0, 0);
  pageChrome(s, L.contentH, py);
}

// ---------------------------------------------------------------- Solana Pay card (on top of any screen)

static int32_t payLeft() {
  int32_t r = payBase - (int32_t)(NOW - payAt);
  return r < 0 ? 0 : r;
}
static bool payVisible() { return cur && cur->hasPay && !(payHiddenAt && millis() - payHiddenAt < 2500); }

static void payCard(const Screen &s) {
  float fp = prog(tPay, 0, 260);
  overlay(0, 0, SCR_W, SCR_H);
  if (fp < 1) mark(0, 0, SCR_W, SCR_H);
  fill(0, 0, SCR_W, SCR_H, P.canvas, (uint8_t)(190 * eOut(fp)));
  hit(0, 0, SCR_W, SCR_H, "ui:none");  // nothing under the card reacts while it is up
  const int X = 60, Y = 40, W = 680, H = 400;
  if (enter(tPay, 60, 0, {X, Y, W, H})) {
    card(X, Y, W, H, 30);
    const int qx = 84, qy = 64, qb = 352, qcx = qx + qb / 2, qcy = qy + qb / 2;
    char amt[16];
    fmtMoney(s.payCents, amt, sizeof(amt));
    bool expired = !s.payPaid && payLeft() <= 0;
    if (!s.payPaid) {
      rrect(qx, qy, qb, qb, 22, P.ink);
      rrectStroke(qx, qy, qb, qb, 22, 2, P.rule);
      if (s.payQrSize) {
        int scale = max(1, (qb - 28) / s.payQrSize);
        int ox = qx + (qb - scale * s.payQrSize) / 2, oy = qy + (qb - scale * s.payQrSize) / 2;
        for (int r = 0; r < s.payQrSize; r++)
          for (int c = 0; c < s.payQrSize; c++)
            if (s.payQr[r][c >> 3] & (1 << (c & 7))) fill(ox + c * scale, oy + r * scale, scale, scale, P.canvas);
      } else {
        textCenter(F_B1, qcx, qcy - 6, "Pay from your phone", P.ink2);
        textCenter(F_B3, qcx, qcy + 20, "This request does not fit a QR", P.muted);
      }
      if (expired) {
        rrect(qx, qy, qb, qb, 22, P.white, 190);
        textCenter(F_H2, qcx, qcy + 10, "Expired", P.ink);
      }
    } else {
      float a = prog(tPaid, 0, 620), b = prog(tPaid, 260, 520);
      rrect(qx, qy, qb, qb, 22, P.accentTint);
      if (a < 1) ring(qcx, qcy, 104 + 56 * eOut(a), 5 * (1 - a) + 1, P.accent, (uint8_t)(170 * (1 - a)));
      circle(qcx, qcy, 104 * clampf(eBack(a, 1.8f), 0, 1.2f), P.accent);
      // the check draws on: short stroke, then the long one
      const float k = 7.f;
      float ax = qcx - 8 * k, ay = qcy, bx2 = qcx - 2.5f * k, by2 = qcy + 6 * k, cx2 = qcx + 9 * k, cy2 = qcy - 7 * k;
      float e = eOut(b);
      if (e > 0) {
        float s1 = clampf(e / 0.35f, 0, 1);
        line(ax, ay, ax + (bx2 - ax) * s1, ay + (by2 - ay) * s1, 3.4f * k * 0.6f, P.white);
        if (e > 0.35f) {
          float s2 = (e - 0.35f) / 0.65f;
          line(bx2, by2, bx2 + (cx2 - bx2) * s2, by2 + (cy2 - by2) * s2, 3.4f * k * 0.6f, P.white);
        }
      }
      if (a < 1 || b < 1) mark(qx - 70, qy - 70, qb + 140, qb + 140);
    }
    const int rx = 460, rw = 256;
    // "Solana Pay" chip: the token's two colours as a small mark
    int cw = textW(F_B3, "Solana Pay") + 40;
    rrect(rx, 66, cw, 28, 14, P.ink);
    rrectGrad(rx + 10, 75, 18, 10, 3, rgb(0x9945FF), rgb(0x5A8CE6), rgb(0x14F195));
    text(F_B3, rx + 34, 85, "Solana Pay", P.white);
    if (!s.payPaid) {
      int starts[2], lens[2];
      bool cut;
      static const char SCAN[] = "Scan with any Solana wallet";
      int n = wrap(F_H3, SCAN, rw, 2, starts, lens, &cut);
      for (int i = 0; i < n; i++) textN(F_H3, rx, 136 + i * 30, &SCAN[starts[i]], lens[i], P.ink);
      text(F_B3, rx, 210, "Paying in", P.muted);
      textFit(F_B1, rx, 236, rw, s.payName[0] ? s.payName : "Player", P.ink);
      text(F_N2, rx, 304, amt, P.ink);
      int secs = (payLeft() + 999) / 1000;
      char t[32];
      if (expired) strlcpy(t, "This request expired", sizeof(t));
      else snprintf(t, sizeof(t), "Expires in %d:%02d", secs / 60, secs % 60);
      watch(wPay, (uint32_t)secs, rx - 4, 318, rw + 8, 30);
      circle(rx + 6, 334, 5, expired ? P.hot : P.accent);
      text(F_B2, rx + 18, 340, t, P.ink2);
      Btn b = {};
      strlcpy(b.id, "pay:close", sizeof(b.id));
      strlcpy(b.label, "Close", sizeof(b.label));
      b.style = B_PLAIN;
      b.enabled = true;
      button(rx, 360, rw, 58, b, F_B1, 20);
    } else {
      float tp = prog(tPaid, 360, 420);
      uint8_t a = (uint8_t)(255 * tp);
      if (tp < 1) mark(rx - 10, 100, rw + 20, 220);
      text(F_H1, rx, 160, "Paid!", P.deep, a);
      text(F_N2, rx, 236, amt, P.ink, a);
      char line2[48];
      snprintf(line2, sizeof(line2), "added for %s", s.payName[0] ? s.payName : "the player");
      textFit(F_B1, rx, 274, rw, line2, P.ink2, a);
      text(F_B3, rx, 302, "It shows on their phone now.", P.muted, a);
      Btn b = {};
      strlcpy(b.id, "pay:close", sizeof(b.id));
      strlcpy(b.label, "Done", sizeof(b.label));
      b.style = B_BRAND;
      b.enabled = true;
      button(rx, 360, rw, 58, b, F_B1, 20);
    }
  }
  layerReset();
}

// ---------------------------------------------------------------- unknown screens + connection

static void drawMessage(const Screen &s, const NetStatus &st) {
  wordmark(20, 40);
  int rx = SCR_W - 16;
  topRight(s, rx, st);
  kinetic(F_H1, 40, 190, 720, 2, 48, s.title, P.ink, tScreen, 80, 45);
  int starts[3], lens[3];
  bool cut;
  int n = wrap(F_B1, s.subtitle, 720, 3, starts, lens, &cut);
  for (int i = 0; i < n; i++) {
    char buf[160];
    int l = min(lens[i], 150);
    memcpy(buf, s.subtitle + starts[i], l);
    buf[l] = 0;
    text(F_B1, 40, 270 + i * 28, buf, P.ink2);
  }
  int nb = s.nButtons;
  if (nb) {
    int w = (SCR_W - 32 - (nb - 1) * 12) / nb;
    for (int i = 0; i < nb; i++) {
      Btn b = s.buttons[i];
      if (b.style == B_PLAIN && i == 0) b.style = B_BRAND;
      button(16 + i * (w + 12), 396, w, 66, b, F_B1, 20);
    }
  }
}

static void drawConnection(const NetStatus &st, bool hadScreen) {
  fill(0, 0, SCR_W, SCR_H, P.canvas);
  markLogo(612, 240, 110, 0, true);
  textCenter(F_H3, 612, 248, "huddle", P.ink);
  markAmbient(470, 100, 290, 290);
  wordmark(32, 60);
  char t[48];
  snprintf(t, sizeof(t), "Box %s", KIOSK_ID);
  text(F_H1, 32, 140, hadScreen ? "Reconnecting..." : "Getting ready", P.ink);
  text(F_B2, 32, 172, t, P.muted);
  int y = 224;
  char line[160];
  if (!st.configured) {
    text(F_B1, 32, y, "Wi-Fi is not set up yet.", P.ink);
    const char *lines[] = {"Copy secrets.example.h to secrets.h, fill in", "WIFI_SSID, WIFI_PASSWORD and SERVER_URL,", "then upload the sketch again."};
    for (int i = 0; i < 3; i++) text(F_B2, 32, y + 32 + i * 26, lines[i], P.ink2);
    return;
  }
  if (!st.wifi) {
    snprintf(line, sizeof(line), "Connecting to Wi-Fi \"%s\"...", WIFI_SSID);
    textFit(F_B1, 32, y, 400, line, P.ink);
    text(F_B2, 32, y + 32, "Is the phone hotspot on? It must be 2.4 GHz", P.ink2);
    text(F_B2, 32, y + 58, "(iPhone: turn on Maximize Compatibility).", P.ink2);
    return;
  }
  snprintf(line, sizeof(line), "Wi-Fi OK  (IP %s)", st.ip);
  circle(40, y - 6, 6, P.accent);
  text(F_B1, 54, y, line, P.deep);
  text(F_B1, 32, y + 36, st.lastOkMs ? "Reconnecting to the site..." : "Reaching the site...", P.ink);
  textFit(F_B2, 32, y + 64, 420, SERVER_URL, P.ink2);
  if (st.error[0]) {
    snprintf(line, sizeof(line), "Last error: %s", st.error);
    textFit(F_B2, 32, y + 96, 420, line, P.hot);
  }
  if (!st.lastOkMs) text(F_B3, 32, y + 130, "A hosted site can take 30 s to wake up.", P.muted);
}

// ---------------------------------------------------------------- box-only extras (betsIn, tip, overlays)

static uint32_t xAt = 0, tHot = 0, tFlash = 0, tConf = 0, tInter = 0;
static int32_t hotBase = 0, flashBase = 0, confBase = 0, interBase = 0;
static Watch wHot, wConf, wInter;
static int32_t xLeft(int32_t base) {
  int32_t r = base - (int32_t)(NOW - xAt);
  return r < 0 ? 0 : r;
}

// "3 of 5 in": a thin row of avatar dots under the chart, filled for those who have bet.
static void betsInStrip(const Screen &s) {
  if (s.betsOf <= 0 || (s.scr != S_MARKET && s.scr != S_LOCKED)) return;
  const int x = 24, y = 464;
  overlay(x - 4, y - 12, 420, 24);
  int n = min((int)s.betsOf, 14), bn = (int)clampf(s.betsN, 0, s.betsOf);
  for (int i = 0; i < n; i++) {
    if (i < bn) circle(x + i * 14 + 5, y, 5, P.yes);
    else ring(x + i * 14 + 5, y, 4.5f, 1.2f, P.ruleStrong);
  }
  char b[24];
  snprintf(b, sizeof(b), "%d of %d in", bn, (int)s.betsOf);
  text(F_B3, x + n * 14 + 8, y + 5, b, bn >= s.betsOf ? P.yes : P.muted);
}

// "Inside info": a small subtle chip at the foot of the right rail.
static void tipCard(const Screen &s) {
  if (!s.hasTip || (s.scr != S_MARKET && s.scr != S_LOCKED)) return;
  const int x = 556, y = 414, w = 224, h = 30;
  overlay(x, y, w, h);
  rrect(x, y, w, h, 15, P.goldTint);
  circle(x + 14, y + h / 2, 3.5f, P.gold);
  const char *lab = s.tipLabel[0] ? s.tipLabel : "Inside info";
  int lw = text(F_B3, x + 24, y + 20, lab, P.gold);
  textFit(F_B3, x + 30 + lw, y + 20, w - 40 - lw, s.tipText, P.ink2);
}

static void countdownRing(int cx, int cy, int r, int32_t left, int32_t total, uint16_t c) {
  ring(cx, cy, r, 4, P.rule);
  float f = total > 0 ? clampf((float)left / total, 0, 1) : 0;
  int segs = (int)(90 * f);
  for (int i = 0; i < segs; i++) {
    float a0 = -1.5708f + 6.2832f * i / 90.f;
    circle(cx + cosf(a0) * r, cy + sinf(a0) * r, 2.6f, c);
  }
  char t[8];
  snprintf(t, sizeof(t), "%d", (int)((left + 999) / 1000));
  textCenter(F_N3, cx, cy + 11, t, P.ink);
}

// Hot seat: name huge, "Tap to double" (touch id hotseat:accept), a countdown.
static void hotseatCard(const Screen &s) {
  float fp = prog(tHot, 0, 320);
  overlay(0, 0, SCR_W, SCR_H);
  if (fp < 1) mark(0, 0, SCR_W, SCR_H);
  fill(0, 0, SCR_W, SCR_H, P.canvas, (uint8_t)(235 * eOut(fp)));
  hit(0, 0, SCR_W, SCR_H, "ui:none");
  int32_t left = xLeft(hotBase);
  int secs = (left + 999) / 1000;
  textCenter(F_B1, 400, 90, "HOT SEAT", P.gold);
  char nm[24];
  fit(F_HERO, s.hotName[0] ? s.hotName : "Player", 720, nm, sizeof(nm));
  textCenter(F_HERO, 400, 200, nm, P.ink, (uint8_t)(255 * fp));
  char m[16];
  snprintf(m, sizeof(m), "%dx", s.hotMult);
  textCenter(F_H1, 400, 270, m, P.yes);  // the number fonts have digits only
  watch(wHot, (uint32_t)secs, 640, 300, 120, 120);
  countdownRing(700, 366, 44, left, max(hotBase, (int32_t)1000), P.gold);
  Btn b = {};
  strlcpy(b.id, "hotseat:accept", sizeof(b.id));
  if (s.hotMult == 2) strlcpy(b.label, "Tap to double", sizeof(b.label));
  else snprintf(b.label, sizeof(b.label), "Tap for %dx", s.hotMult);
  b.style = B_YES;
  b.enabled = left > 0;
  button(220, 330, 360, 72, b, F_H3, 36);
}

// Confirm: "Ayan, tap your phone here to lock $5 on YES" with a tap icon and a countdown.
static void confirmCard(const Screen &s) {
  float fp = prog(tConf, 0, 260);
  overlay(0, 0, SCR_W, SCR_H);
  mark(0, 0, SCR_W, SCR_H);  // the waves pulse
  fill(0, 0, SCR_W, SCR_H, P.canvas, (uint8_t)(225 * eOut(fp)));
  hit(0, 0, SCR_W, SCR_H, "ui:none");
  uint16_t c = s.confYes ? P.yes : P.no;
  const int ix = 400, iy = 140;
  rrectStroke(ix - 28, iy - 48, 56, 96, 12, 3, P.ink);
  fill(ix - 10, iy + 34, 20, 3, P.ink);
  float pulse = (NOW % 1400) / 1400.f;
  for (int k = 0; k < 3; k++) {
    float r = 62 + k * 16 + pulse * 16;
    ring(ix, iy, r, 2.5f, c, (uint8_t)(200 * (1 - (k + pulse) / 3.f)), true);
  }
  char amt[16], l1[64], l2[48], fl[64];
  fmtMoney(s.confCents, amt, sizeof(amt));
  snprintf(l1, sizeof(l1), "%s, tap your phone here", s.confName[0] ? s.confName : "Player");
  fit(F_H2, l1, 740, fl, sizeof(fl));
  textCenter(F_H2, 400, 262, fl, P.ink);
  snprintf(l2, sizeof(l2), "to lock %s on ", amt);
  const char *side = s.confYes ? "YES" : "NO";
  int w1 = textW(F_H2, l2), w2 = textW(F_H2, side), x0 = 400 - (w1 + w2) / 2;
  text(F_H2, x0, 304, l2, P.ink2);
  text(F_H2, x0 + w1, 304, side, c);
  int32_t left = xLeft(confBase);
  countdownRing(400, 396, 40, left, max(confBase, (int32_t)1000), c);
}

// Flash: a short toast with an avatar (join / big win / big loss).
static void flashToast(const Screen &s) {
  float fp = prog(tFlash, 0, 300);
  const int w = 520, h = 76, x = (SCR_W - w) / 2, y = 20 + (int)(-30 * (1 - eOut(fp)));
  overlay(x - 4, 0, w + 8, h + 30);
  if (fp < 1) mark(x - 4, 0, w + 8, h + 30);
  uint16_t c = s.flashKind == 'w' ? P.yes : s.flashKind == 'l' ? P.no : P.gold;
  rrect(x, y, w, h, 20, P.card);
  rrectStroke(x, y, w, h, 20, 2, c);
  avatar(x + 42, y + h / 2, 24, s.flashName[0] ? s.flashName : "?");
  int tx = x + 80;
  char nm[24];
  fit(F_H3, s.flashName[0] ? s.flashName : "Someone", 240, nm, sizeof(nm));
  text(F_H3, tx, y + 32, nm, P.ink);
  textFit(F_B2, tx, y + 58, w - 100 - (s.flashCents ? 120 : 0), s.flashText, P.ink2);
  if (s.flashCents) {
    char amt[16], sg[20];
    fmtMoney(s.flashCents, amt, sizeof(amt));
    snprintf(sg, sizeof(sg), "%s%s", s.flashKind == 'l' ? "-" : "+", amt);
    textRight(F_N3, x + w - 18, y + 50, sg, c);
  }
}

// Interlude: full-screen standings between questions (uses the standings field).
static void interludeCard(const Screen &s) {
  float fp = prog(tInter, 0, 800);
  overlay(0, 0, SCR_W, SCR_H);
  if (fp < 1) mark(0, 0, SCR_W, SCR_H);
  fill(0, 0, SCR_W, SCR_H, P.canvas);
  hit(0, 0, SCR_W, SCR_H, "ui:none");
  text(F_H2, 40, 64, "Standings", P.ink);
  int32_t left = xLeft(interBase);
  int secs = (left + 999) / 1000;
  char t[24];
  snprintf(t, sizeof(t), "Next in %d", secs);
  watch(wInter, (uint32_t)secs, 560, 30, 220, 50);
  textRight(F_B1, 760, 62, t, P.muted);
  int n = min(s.nStand, 6);
  if (!n) textCenter(F_H3, 400, 260, "No bets yet", P.muted);
  for (int i = 0; i < n; i++) {
    const Person &p = s.stand[i];
    float rp = eOut(prog(tInter, 80 + i * 70, 360));
    int y = 96 + i * 62, x = 40 + (int)(40 * (1 - rp));
    uint8_t a = (uint8_t)(255 * rp);
    bool lead = i == 0 && !s.standTie;
    rrect(x, y, 720, 54, 14, lead ? P.accentTint : P.card, a);
    char rk[6];
    snprintf(rk, sizeof(rk), "%d", p.rank > 0 ? p.rank : i + 1);
    text(F_N3, x + 20, y + 39, rk, i == 0 ? P.gold : P.muted, a);
    avatar(x + 92, y + 27, 18, p.name, a);
    textFit(F_H3, x + 124, y + 36, 380, p.name, P.ink, a);
    char m[16], pl[20], sg[24];
    fmtMoney(p.cents, m, sizeof(m));
    textRight(F_N4, x + 700, y + 26, m, P.ink, a);
    fmtMoney(abs(p.extra), pl, sizeof(pl));
    snprintf(sg, sizeof(sg), "%s%s", p.extra < 0 ? "-" : "+", pl);
    textRight(F_B3, x + 700, y + 46, sg, p.extra < 0 ? P.no : P.yes, a);
  }
}

static void drawExtras(const Screen &s) {
  betsInStrip(s);
  tipCard(s);
  if (s.hasInter) interludeCard(s);
  if (s.hasHot) hotseatCard(s);
  else if (s.hasConfirm) confirmCard(s);
  if (s.hasFlash && xLeft(flashBase) > 0) flashToast(s);
}

static void drawToast() {
  float p = prog(tToast, 0, 360);
  float out = clampf((int32_t)(NOW - tToast - 2800) / 240.f, 0, 1);
  uint8_t a = (uint8_t)(255 * clampf(p * 2, 0, 1) * (1 - out));
  int dy = (int)((1 - eBack(p, 1.4f)) * 30);
  char buf[96];
  fit(F_B1, toast, 600, buf, sizeof(buf));
  int w = textW(F_B1, buf) + 70, x = (SCR_W - w) / 2, y = 404 + dy;
  overlay(x - 12, 396, w + 24, 84);
  layer(0, 0, a);
  shadow(x, y, w, 52, 26);
  rrect(x, y, w, 52, 26, P.ink);
  rrectStroke(x, y, w, 52, 26, 2, P.hot);
  circle(x + 28, y + 26, 10, P.hot);
  fill(x + 27, y + 19, 2, 9, P.white);
  fill(x + 27, y + 30, 2, 2, P.white);
  text(F_B1, x + 48, y + 33, buf, P.white);
  layerReset();
  mark(x - 12, 396, w + 24, 84);
}

// ================================================================ scene + frame

static bool staleNow = false, lastStale = true;
static uint32_t staleSince = 0;

static void scene(const NetStatus &st) {
  const Screen &s = *cur;
  bool fullConn = !haveScreen || (staleNow && NOW - staleSince > 15000);
  if (fullConn) {
    if (!measuring) pageDrawnValid = false;
    drawConnection(st, haveScreen);
    return;
  }
  fill(0, 0, SCR_W, SCR_H, P.canvas);
  if (hasPage(s)) {
    drawPage(s, st);
  } else {
    if (!measuring) pageDrawnValid = false;
    switch (s.scr) {
      case S_SELECT: drawSelect(s, st); break;
      case S_LOBBY: drawLobby(s, st); break;
      case S_MARKET: drawMarket(s, st, false); break;
      case S_LOCKED: drawMarket(s, st, true); break;
      case S_RESULT: drawResult(s, st); break;
      case S_ENDED: drawEnded(s, st); break;
      default: drawMessage(s, st); break;
    }
  }
  pageY = 0;
  origin(0, 0);
  layerReset();
  drawExtras(s);
  if (payVisible()) payCard(s);
  if (toast[0] && NOW - tToast < 3040) drawToast();
  else if (toast[0] && measuring) {  // gone: erase it
    toast[0] = 0;
    fullDirty = true;
  }
  if (staleNow) {  // keep the last screen, say we are reconnecting
    const char *msg = "Reconnecting to the site...";
    int w = textW(F_B1, msg) + 64, x = (SCR_W - w) / 2;
    overlay(x - 4, 4, w + 8, 52);
    rrect(x, 8, w, 44, 22, P.ink);
    markLogo(x + 24, 30, 9, 0, true);
    text(F_B1, x + 44, 37, msg, P.white);
    markAmbient(x, 8, w, 44);
  }
}

static uint32_t lastFrame = 0, lastAmbient = 0;
static uint32_t badJsonSince = 0;  // first unparseable reply since the last good one (0 = none)
static bool uiReady = false;       // screens and frame buffer allocated (uiBegin)

bool uiFrame(const NetStatus &st) {
  if (!uiReady) return false;
  NOW = millis();
  // connection state
  bool stale = !haveScreen || st.lastOkMs == 0 || NOW - st.lastOkMs > STALE_MS || (badJsonSince && NOW - badJsonSince > STALE_MS);
  if (stale != lastStale) {
    fullDirty = true;
    staleSince = NOW;
    lastStale = stale;
  }
  staleNow = haveScreen && stale;
  static bool lastConn = true;
  bool conn = !haveScreen || (staleNow && NOW - staleSince > 15000);
  if (conn != lastConn) {
    fullDirty = true;
    lastConn = conn;
  }
  // The connection page shows Wi-Fi / site status: redraw when any of it changes.
  static uint32_t lastStatus = 0;
  uint32_t status = strHash(st.error, (st.configured ? 1 : 0) | (st.wifi ? 2 : 0) | (st.lastOkMs ? 4 : 0)) ^ strHash(st.ip);
  if (conn && status != lastStatus) fullDirty = true;
  lastStatus = status;
  if (tapped[0] && NOW - tappedAt >= 2500) {  // no answer: drop the pending dots
    tapped[0] = 0;
    fullDirty = true;
  }
  static bool lastPayVis = false;  // the pay card hid itself after Close, or came back
  if (payVisible() != lastPayVis) {
    lastPayVis = payVisible();
    fullDirty = true;
  }
  ambientTick = NOW - lastAmbient >= 100;
  if (ambientTick) lastAmbient = NOW;

  // momentum scrolling
  float dt = clampf((NOW - lastScrollStep) / 16.f, 0, 4);
  lastScrollStep = NOW;
  for (int i = 0; i < 4; i++) {
    Scroller &s = scrolls[i];
    if (!s.used || (T.down && T.dragging && T.scroll == i)) continue;
    bool moving = false;
    if (i == PAGE && s.snapping) {  // gliding to a snap point (or home)
      s.off += (s.snapTo - s.off) * clampf(0.2f * dt, 0, 1);
      s.vel = 0;
      if (fabsf(s.snapTo - s.off) < 0.6f) {
        s.off = s.snapTo;
        s.snapping = false;
      }
      s.lastMove = NOW;
      continue;
    }
    bool coasting = fabsf(s.vel) > 0.01f;
    if (fabsf(s.vel) > 0.01f) {
      s.off += s.vel * 16 * dt;
      s.vel *= powf(0.94f, dt);
      moving = true;
    }
    if (s.off < 0 || s.off > s.maxOff) {  // rubber band back
      float target = s.off < 0 ? 0 : s.maxOff;
      s.off += (target - s.off) * clampf(0.22f * dt, 0, 1);
      s.vel *= 0.5f;
      if (fabsf(target - s.off) < 0.5f) s.off = target;
      moving = true;
    }
    if (fabsf(s.vel) < 0.02f) s.vel = 0;
    // The page coming to rest near a section's top settles on it.
    if (i == PAGE && coasting && fabsf(s.vel) < 0.15f && !T.down && pageSnap()) moving = true;
    if (moving) s.lastMove = NOW;
  }
  {  // a page left scrolled down glides home after a minute without a touch (the box is shared)
    Scroller &pg = scrolls[PAGE];
    if (pg.used && pg.off > 1 && !pg.snapping && !T.down && NOW - lastTouchAt > 60000 && NOW - pg.lastMove > 60000) pageGlide(0);
  }

  // The page scrolled since the panel was drawn: shift the pixels instead of redrawing them (below).
  bool pageNow = haveScreen && !conn && hasPage(*cur);
  int want = (int)floorf(scrolls[PAGE].off);
  blitD = pageNow && pageDrawnValid && !fullDirty ? want - pageDrawnY : 0;
  if (abs(blitD) >= SCR_H - 40) {
    blitD = 0;
    fullDirty = true;
  }

  // measure: hits + dirty rects
  measuring = true;
  nHits = 0;
  nDirty = 0;
  pageY = 0;
  for (int i = 0; i < 4; i++) {
    Scroller &sc = scrolls[i];
    if (i != PAGE && NOW - sc.lastMove < 1300 && sc.used) markR(sc.view);
    sc.used = false;
  }
  if (blitD)
    for (int i = 0; i < nOvPrev; i++) mark(ovPrev[i].x, ovPrev[i].y - abs(blitD), ovPrev[i].w, ovPrev[i].h + 2 * abs(blitD));
  nOvNow = 0;
  clip({0, 0, 0, 0});
  clipDepth = 0;
  scene(st);
  layerReset();
  memcpy(ovPrev, ovNow, sizeof(ovNow));
  nOvPrev = nOvNow;
  measuring = false;

  int area = 0;
  for (int i = 0; i < nDirty; i++) area += dirty[i].w * dirty[i].h;
  if (area > SCR_W * SCR_H * 6 / 10) fullDirty = true;
  if (!fullDirty && nDirty == 0 && blitD == 0) return false;
  // ~40 fps cap while animating so Wi-Fi + touch keep their share of the CPU
  if (NOW - lastFrame < 22 && !fullDirty) return true;
  lastFrame = NOW;

  bool shifted = false;
  if (!fullDirty && blitD) {
    scrollRows(0, SCR_H, blitD);
    shifted = true;
    Rect strip = blitD > 0 ? Rect{0, (int16_t)(SCR_H - blitD), SCR_W, (int16_t)blitD} : Rect{0, 0, SCR_W, (int16_t)(-blitD)};
    measuring = true;
    markR(strip);
    measuring = false;
  }
  if (fullDirty) {
    nDirty = 1;
    dirty[0] = {0, 0, SCR_W, SCR_H};
    fullDirty = false;
  }
  for (int i = 0; i < nDirty; i++) {
    clip(dirty[i]);
    clipDepth = 0;
    scene(st);
    layerReset();
    if (!shifted) present(dirty[i]);
  }
  if (shifted) present({0, 0, SCR_W, SCR_H});  // every row moved
  clip({0, 0, SCR_W, SCR_H});
  return true;
}

void uiInvalidate() { fullDirty = true; }

// ================================================================ input

static int hitAt(int x, int y) {
  for (int i = nHits - 1; i >= 0; i--)
    if (hits[i].r.contains(x, y)) return i;
  return -1;
}

const char *uiTouch(bool down, int16_t x, int16_t y) {
  static char out[40];
  if (!uiReady) return nullptr;
  uint32_t now = millis();
  if (down && !T.down) {  // finger down
    T = {};
    T.down = true;
    T.x0 = T.x = x;
    T.y0 = T.y = y;
    T.t0 = T.lastT = now;
    T.lastY = y;
    T.scroll = -1;
    lastTouchAt = now;
    int h = hitAt(x, y);
    if (h >= 0) strlcpy(T.id, hits[h].id, sizeof(T.id));
    // The innermost list under the finger scrolls (a list inside the page before the page). Not under the pay card.
    int32_t bestArea = INT32_MAX;
    for (int i = 0; i < 4 && !payVisible(); i++)
      if (scrolls[i].maxOff > 0 && scrolls[i].view.contains(x, y) && (int32_t)scrolls[i].view.w * scrolls[i].view.h < bestArea) {
        bestArea = (int32_t)scrolls[i].view.w * scrolls[i].view.h;
        T.scroll = i;
      }
    if (T.scroll >= 0) {
      Scroller &s = scrolls[T.scroll];
      s.vel = 0;  // a touch catches a moving list
      s.snapping = false;
      s.dragFrom = s.off;
    }
    if (T.id[0] && h >= 0) mark(hits[h].r.x - 6, hits[h].r.y - 6, hits[h].r.w + 12, hits[h].r.h + 12);
    fullDirty = fullDirty || T.id[0];  // pressed state shows right away
    return nullptr;
  }
  if (down && T.down) {  // finger moving
    T.x = x;
    T.y = y;
    int dy = y - T.y0, dx = x - T.x0;
    if (!T.dragging && T.scroll >= 0 && abs(dy) > 12 && abs(dy) > abs(dx)) {
      T.dragging = true;
      if (T.id[0]) fullDirty = true;  // un-press
      T.id[0] = 0;
    }
    if (T.dragging && T.scroll >= 0) {
      Scroller &s = scrolls[T.scroll];
      float off = s.dragFrom - dy;
      if (off < 0) off *= 0.35f;  // rubber band
      if (off > s.maxOff) off = s.maxOff + (off - s.maxOff) * 0.35f;
      s.off = off;
      s.lastMove = now;
      uint32_t dtm = now - T.lastT;
      if (dtm > 0) {
        float v = -(y - T.lastY) / (float)dtm;  // px per ms
        T.vel = T.vel * 0.6f + v * 0.4f;
      }
      T.lastY = y;
      T.lastT = now;
    } else if (T.id[0] && (abs(dx) > 28 || abs(dy) > 28)) {
      T.id[0] = 0;  // slid off the button: no tap
      fullDirty = true;
    }
    return nullptr;
  }
  if (!down && T.down) {  // finger up
    T.down = false;
    if (T.dragging && T.scroll >= 0) {
      Scroller &s = scrolls[T.scroll];
      s.vel = (now - T.lastT < 80) ? clampf(T.vel, -4, 4) : 0;
      s.lastMove = now;
      T.dragging = false;
      if (T.scroll == PAGE && fabsf(s.vel) < 0.15f) {
        s.vel = 0;
        pageSnap();
      }
      return nullptr;
    }
    if (T.id[0] && !strncmp(T.id, "ui:", 3)) {  // handled on the box: never sent to the site
      if (!strcmp(T.id, "ui:top")) pageGlide(0);
      else if (!strcmp(T.id, "ui:more")) pageGlide(scrolls[PAGE].nSnaps > 1 ? scrolls[PAGE].snaps[1] : SCR_H - 66);
      strlcpy(released, T.id, sizeof(released));
      releasedAt = now;
      T.id[0] = 0;
      fullDirty = true;
      return nullptr;
    }
    if (T.id[0]) {
      if (!strcmp(T.id, "pay:close")) payHiddenAt = now ? now : 1;  // hide at once; the site clears it
      strlcpy(out, T.id, sizeof(out));
      strlcpy(released, T.id, sizeof(released));
      releasedAt = now;
      strlcpy(tapped, T.id, sizeof(tapped));
      tappedAt = now;
      T.id[0] = 0;
      fullDirty = true;
      return out;
    }
  }
  return nullptr;
}

// ================================================================ JSON in

static bool sameLayout(const Screen &a, const Screen &b) {
  return a.scr == b.scr && !strcmp(a.question, b.question) && !strcmp(a.code, b.code);
}

void uiSetJson(const String &body) {
  if (!uiReady) return;
  NOW = millis();
  DeserializationError err = deserializeJson(doc, body.c_str(), body.length());
  if (err) {
    Serial.printf("[ui] bad JSON: %s\n", err.c_str());
    // net.cpp counted the reply as good; if only bad replies arrive, uiFrame shows "Reconnecting" after STALE_MS.
    if (!badJsonSince) badJsonSince = NOW ? NOW : 1;
    return;
  }
  badJsonSince = 0;
  JsonObjectConst j = doc.as<JsonObjectConst>();
  parseInto(*nxt, j);
  // palette from the site (optional)
  JsonObjectConst pal = j["palette"].as<JsonObjectConst>();
  if (!pal.isNull()) {
    P.canvas = parseHex(pal["canvas"] | "", P.canvas);
    P.card = parseHex(pal["card"] | "", P.card);
    P.well = parseHex(pal["well"] | "", P.well);
    P.rule = parseHex(pal["rule"] | "", P.rule);
    P.ink = parseHex(pal["ink"] | "", P.ink);
    P.ink2 = parseHex(pal["ink2"] | "", P.ink2);
    P.muted = parseHex(pal["muted"] | "", P.muted);
    P.accent = parseHex(pal["accent"] | "", P.accent);
    P.deep = parseHex(pal["accentDeep"] | "", P.deep);
    P.lime = parseHex(pal["accentLight"] | "", P.lime);
    P.yes = parseHex(pal["yes"] | "", P.yes);
    P.no = parseHex(pal["no"] | "", P.no);
    P.hot = parseHex(pal["hot"] | "", P.hot);
    P.gold = parseHex(pal["gold"] | "", P.gold);
  }
  Screen &n = *nxt, &c = *cur;
  bool first = !haveScreen;
  bool layoutChange = first || !sameLayout(n, c);
  bool screenChange = first || n.scr != c.scr;
  bool questionChange = strcmp(n.question, lastQuestion) != 0;

  // Market timing: ring fraction from the window length.
  if (n.scr == S_MARKET || n.scr == S_LOCKED) {
    int32_t est = n.lockInMs;
    int32_t curRem = remBase - (int32_t)(NOW - remAt);
    if (questionChange || layoutChange || abs(est - curRem) > 400 || n.scr != S_MARKET) {
      remBase = est;
      remAt = NOW;
    } else {
      remBase = curRem + (est - curRem) / 4;
      remAt = NOW;
    }
    if (questionChange) lockTotalMs = 0;
    int tot = n.lockTotal > 0 ? n.lockTotal * 1000 : 0;
    if (!tot) tot = max(lockTotalMs, n.lockInMs);
    lockTotalMs = tot;
  }
  if ((n.scr == S_MARKET || n.scr == S_LOCKED) && (questionChange || (c.scr != S_MARKET && c.scr != S_LOCKED))) {
    tQuestion = NOW;
    seenTrades.n = 0;
    char y[8], no[8];
    snprintf(y, sizeof(y), "%d", n.yes);
    snprintf(no, sizeof(no), "%d", n.no);
    rollReset(rYes, y);
    rollReset(rNo, no);
    char v0[16];
    fmtMoney(max(0, n.volume), v0, sizeof(v0));
    rollReset(rVol, v0);
    splitFrom = splitTo = n.yes / 100.f;
    tSplit = 0;
    histPrevN = n.nHist;
    tHist = 0;
  }
  if (n.scr == S_LOCKED && c.scr != S_LOCKED) tLocked = (c.scr == S_MARKET && !questionChange) ? NOW : NOW - 2000;
  if (n.scr == S_RESULT && (c.scr != S_RESULT || questionChange)) tResult = NOW;
  if (n.scr == S_MARKET || n.scr == S_LOCKED) {
    if (n.yes != c.yes && !questionChange) {
      float curF = splitFrom + (splitTo - splitFrom) * eBack(prog(tSplit, 0, 700), 0.8f);
      splitFrom = curF;
      splitTo = n.yes / 100.f;
      tSplit = NOW;
    }
    if (n.nHist > histPrevN) tHist = NOW;
    histPrevN = n.nHist;
  }
  // Pay card timing (the box has no wall clock: ms left when the JSON was built, then counted here).
  if (n.hasPay) {
    int32_t curLeft = payBase - (int32_t)(NOW - payAt);
    if (!c.hasPay || abs(n.payLeftMs - curLeft) > 1500) {
      payBase = n.payLeftMs;
      payAt = NOW;
    }
    if (!c.hasPay) tPay = NOW;
    if (n.payPaid && !(c.hasPay && c.payPaid)) tPaid = NOW;
  } else {
    payHiddenAt = 0;
  }
  // Extras timing (ms left when the JSON was built, counted down here).
  xAt = NOW;
  if (n.hasHot && !c.hasHot) tHot = NOW;
  if (n.hasConfirm && !c.hasConfirm) tConf = NOW;
  if (n.hasInter && !c.hasInter) tInter = NOW;
  if (n.hasFlash && (!c.hasFlash || strcmp(n.flashText, c.flashText) || strcmp(n.flashName, c.flashName))) tFlash = NOW;
  hotBase = n.hotLeft;
  confBase = n.confLeft;
  interBase = n.interLeft;
  flashBase = n.flashLeft;
  if (first || n.xHash != c.xHash) fullDirty = true;
  strlcpy(lastQuestion, n.question, sizeof(lastQuestion));
  // Locking keeps the page where it is (same question, same graph); anything else starts at the top.
  bool keepPage = !first && c.scr == S_MARKET && n.scr == S_LOCKED && !questionChange;
  if (questionChange || (screenChange && !keepPage)) {
    scrolls[PAGE] = {};
    tChartIn = tOddsIn = tListIn = 0;
  }
  if (screenChange) {
    tScreen = NOW;
    resetScrolls(true);
    seenRoster.n = 0;
    if (n.scr == S_LOBBY) {
      rollReset(rCount, "0");
      rollReset(rPot, "$0.00");
    }
  }
  // The countdown alone changes every second: the ring redraws itself, so that is not a full redraw.
  // So does the scorebug's game clock: it redraws its own pill (watch()).
  int keepIn = n.lockIn, keepMs = n.lockInMs, keepH = n.homeScore, keepA = n.awayScore, keepPay = n.payLeftMs;
  n.payLeftMs = c.payLeftMs;
  char keepClock[12], keepPeriod[12], keepStatus[8];
  memcpy(keepClock, n.clock, sizeof(keepClock));
  memcpy(keepPeriod, n.period, sizeof(keepPeriod));
  memcpy(keepStatus, n.scoreStatus, sizeof(keepStatus));
  n.lockIn = c.lockIn;
  n.lockInMs = c.lockInMs;
  n.homeScore = c.homeScore;
  n.awayScore = c.awayScore;
  memcpy(n.clock, c.clock, sizeof(keepClock));
  memcpy(n.period, c.period, sizeof(keepPeriod));
  memcpy(n.scoreStatus, c.scoreStatus, sizeof(keepStatus));
  // Page sections (chart, odds, standings) are not part of this: they redraw their own area (watch()).
  bool changed = layoutChange || memcmp(&n, &c, SCREEN_CORE) != 0;
  if (changed) fullDirty = true;
  // ...unless the page's layout moved (a section grew or appeared): then everything below it moved too.
  if (n.chart.has != c.chart.has || n.nOdds != c.nOdds || min(8, n.nStand) != min(8, c.nStand)) fullDirty = true;
  n.payLeftMs = keepPay;
  n.lockIn = keepIn;
  n.lockInMs = keepMs;
  n.homeScore = keepH;
  n.awayScore = keepA;
  memcpy(n.clock, keepClock, sizeof(keepClock));
  memcpy(n.period, keepPeriod, sizeof(keepPeriod));
  memcpy(n.scoreStatus, keepStatus, sizeof(keepStatus));
  if (n.error[0]) {
    strlcpy(toast, n.error, sizeof(toast));
    tToast = NOW;
  }
  // The press is done when the screen changes or the server refuses it. A poll that was already in flight
  // (same screen, no error) leaves the pending dots; they time out after 2.5 s otherwise.
  if (tapped[0] && (changed || n.error[0])) {
    fullDirty = true;
    tapped[0] = 0;
  }
  Screen *t = cur;
  cur = nxt;
  nxt = t;
  haveScreen = true;
  recvAt = NOW;
}

// ================================================================ boot

void uiBegin() {
  defaultPalette();
  cur = (Screen *)ps_calloc(1, sizeof(Screen));
  nxt = (Screen *)ps_calloc(1, sizeof(Screen));
  if (!cur || !nxt) {  // free the one that worked, then try internal RAM for both
    free(cur);
    free(nxt);
    cur = (Screen *)calloc(1, sizeof(Screen));
    nxt = (Screen *)calloc(1, sizeof(Screen));
  }
  bool fbOk = dr::begin();
  uiReady = cur && nxt && fbOk;
  if (!uiReady) {
    // Never draw through a null buffer (that crash-loops the board): stay dark and say why on the serial port.
    Serial.printf("[ui] out of memory: screens %s, frame buffer %s. Enable PSRAM (OPI) in the board settings.\n",
                  cur && nxt ? "ok" : "FAILED", fbOk ? "ok" : "FAILED");
  }
}

void uiBootScreen(const char *line) {
  if (!buffer()) return;
  NOW = millis();
  clip({0, 0, SCR_W, SCR_H});
  fill(0, 0, SCR_W, SCR_H, P.canvas);
  markLogo(400, 200, 46, 12, false);
  textCenter(F_H1, 400, 300, "huddle", P.ink);
  textCenter(F_B2, 400, 332, line, P.muted);
  present({0, 0, SCR_W, SCR_H});
}
