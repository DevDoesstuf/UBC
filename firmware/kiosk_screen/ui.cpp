#include "ui.h"
#include <ArduinoJson.h>
#include "board.h"
#include "config.h"

// Fonts come from the U8g2 library (Arduino_GFX picks them up when U8g2 is installed).
#define F_SMALL u8g2_font_helvR14_tf
#define F_BODY u8g2_font_helvB18_tf
#define F_LARGE u8g2_font_helvB24_tf
#define F_TITLE u8g2_font_fub30_tf
#define F_PRICE u8g2_font_logisoso92_tn
#define F_CLOCK u8g2_font_logisoso32_tn
#define F_RESULT u8g2_font_logisoso58_tr

static constexpr uint16_t hex565(uint32_t hex) {
  return (uint16_t)((((hex >> 16) & 0xF8) << 8) | (((hex >> 8) & 0xFC) << 3) | ((hex & 0xFF) >> 3));
}
static const uint16_t K_BG = hex565(0x0b0f17), K_CARD = hex565(0x151b26), K_LINE = hex565(0x273042), K_TEXT = hex565(0xeef2f8), K_DIM = hex565(0x93a0b4),
                      K_YES = hex565(0x1d9e75), K_YES_DARK = hex565(0x0e4a37), K_NO = hex565(0xd85a30), K_NO_DARK = hex565(0x5a2414),
                      K_BLUE = hex565(0x378add), K_TILE = hex565(0x1f4f80), K_TILE_OFF = hex565(0x1b2331), K_OFF_TEXT = hex565(0x6b778a),
                      K_AMBER = hex565(0xc98a1a), K_RED_TEXT = hex565(0xe0675b), K_PINK = hex565(0xf4a3a3), K_MINT = hex565(0x7fe0bd),
                      K_TOAST = hex565(0x5a1f1a), K_WHITE = 0xFFFF, K_BLACK = 0x0000, K_SUBTITLE = hex565(0xc9d2df);

static uint16_t headerColor(const char *c) {
  if (!strcmp(c, "amber")) return hex565(0x5a3d08);
  if (!strcmp(c, "red")) return hex565(0x5a1f1a);
  if (!strcmp(c, "green")) return hex565(0x0e4a37);
  if (!strcmp(c, "gray")) return hex565(0x2a3140);
  return hex565(0x123a63);  // blue
}

static uint16_t buttonColor(const char *s) {
  if (!strcmp(s, "primary")) return K_BLUE;
  if (!strcmp(s, "yes")) return K_YES;
  if (!strcmp(s, "no")) return K_NO;
  return K_LINE;
}

static uint16_t lighten(uint16_t c) {  // halfway to white, for pressed buttons
  uint16_t r = (c >> 11) & 0x1F, g = (c >> 5) & 0x3F, b = c & 0x1F;
  return ((r + (31 - r) / 2) << 11) | ((g + (63 - g) / 2) << 5) | (b + (31 - b) / 2);
}

// ---------------------------------------------------------------- state

static JsonDocument doc;
static bool haveScreen = false;
static bool dirty = true;
static uint32_t receivedAt = 0;
static char toast[96] = "";
static uint32_t toastUntil = 0;
static char pressed[48] = "";
static uint32_t pressedAt = 0;

struct Hit {
  int16_t x, y, w, h;
  char id[48];
};
static Hit hits[8];
static int nHits = 0;

static bool lastStale = true;
static int lastLockIn = -1;
static bool lastToast = false;
static uint32_t lastStaleDraw = 0;

static void addHit(int16_t x, int16_t y, int16_t w, int16_t h, const char *id) {
  if (nHits >= 8) return;
  hits[nHits] = {x, y, w, h, ""};
  strlcpy(hits[nHits].id, id, sizeof(hits[nHits].id));
  nHits++;
}

// ---------------------------------------------------------------- text helpers

static int16_t textW(const char *s) {
  int16_t x1, y1;
  uint16_t w, h;
  gfx->getTextBounds(s, 0, 0, &x1, &y1, &w, &h);
  return (int16_t)w;
}

static void text(int16_t x, int16_t y, const char *s, const uint8_t *font, uint16_t color) {
  gfx->setFont(font);
  gfx->setTextColor(color);
  gfx->setCursor(x, y);
  gfx->print(s);
}

static void textCenter(int16_t cx, int16_t y, const char *s, const uint8_t *font, uint16_t color) {
  gfx->setFont(font);
  text(cx - textW(s) / 2, y, s, font, color);
}

static void textRight(int16_t rx, int16_t y, const char *s, const uint8_t *font, uint16_t color) {
  gfx->setFont(font);
  text(rx - textW(s), y, s, font, color);
}

// Cuts `buf` and adds "..." until it fits in maxW (font must already be set).
static void ellipsize(char *buf, size_t cap, int16_t maxW) {
  if (textW(buf) <= maxW) return;
  size_t n = strlen(buf);
  while (n > 0) {
    buf[--n] = 0;
    char tmp[200];
    snprintf(tmp, sizeof(tmp), "%s...", buf);
    if (textW(tmp) <= maxW) {
      strlcpy(buf, tmp, cap);
      return;
    }
  }
}

static void textFit(int16_t x, int16_t y, int16_t maxW, const char *s, const uint8_t *font, uint16_t color) {
  char buf[200];
  strlcpy(buf, s, sizeof(buf));
  gfx->setFont(font);
  ellipsize(buf, sizeof(buf), maxW);
  text(x, y, buf, font, color);
}

// Word-wraps `s` into at most maxLines lines; the last line gets "..." if text is left over.
static void wrap(int16_t x, int16_t y, int16_t maxW, int16_t lineH, int maxLines, const char *s, const uint8_t *font, uint16_t color) {
  gfx->setFont(font);
  char line[200];
  const char *p = s;
  for (int ln = 0; ln < maxLines && *p; ln++) {
    int len = strlen(p), best = 0;
    for (int j = 1; j <= len && j < (int)sizeof(line) - 4; j++) {
      if (j == len || p[j] == ' ') {
        memcpy(line, p, j);
        line[j] = 0;
        if (textW(line) <= maxW) best = j;
        else break;
      }
    }
    if (best == 0) best = min(len, (int)sizeof(line) - 4);  // one very long word: let ellipsize cut it
    memcpy(line, p, best);
    line[best] = 0;
    p += best;
    while (*p == ' ') p++;
    if (ln == maxLines - 1 && *p) {
      strlcat(line, " ...", sizeof(line));
      ellipsize(line, sizeof(line), maxW);
    } else {
      ellipsize(line, sizeof(line), maxW);
    }
    text(x, y + ln * lineH, line, font, color);
  }
}

// ---------------------------------------------------------------- pieces

static void drawHeader(JsonObjectConst s, const NetStatus &st) {
  gfx->fillRect(0, 0, SCR_W, 88, headerColor(s["color"] | "blue"));
  textFit(24, 44, 560, s["title"] | "", F_TITLE, K_TEXT);
  textFit(24, 76, 750, s["subtitle"] | "", F_BODY, K_SUBTITLE);
  textRight(SCR_W - 34, 30, s["footer"] | "", F_SMALL, K_SUBTITLE);
  bool fresh = st.lastOkMs && millis() - st.lastOkMs < 2500;
  gfx->fillCircle(SCR_W - 18, 25, 6, fresh ? K_MINT : K_AMBER);
}

static void drawButtons(JsonArrayConst buttons) {
  int n = buttons.size();
  if (n == 0) return;
  const int gap = 16, y = 400, h = 64;
  int w = (768 - (n - 1) * gap) / n;
  int i = 0;
  for (JsonVariantConst b : buttons) {
    const char *id = b["id"] | "";
    int x = 16 + i * (w + gap);
    uint16_t col = buttonColor(b["style"] | "plain");
    if (pressed[0] && !strcmp(pressed, id)) col = lighten(col);
    gfx->fillRoundRect(x, y, w, h, 14, col);
    gfx->setFont(F_LARGE);
    char label[64];
    strlcpy(label, b["label"] | "", sizeof(label));
    ellipsize(label, sizeof(label), w - 20);
    textCenter(x + w / 2, y + 41, label, F_LARGE, K_TEXT);
    addHit(x, y, w, h, id);
    i++;
  }
}

static void drawSelect(JsonObjectConst s) {
  int i = 0;
  for (JsonVariantConst t : s["tiles"].as<JsonArrayConst>()) {
    if (i >= 4) break;
    int x = 16 + (i % 2) * 392, y = 100 + (i / 2) * 192, w = 376, h = 176;
    bool on = t["enabled"] | false;
    const char *id = t["id"] | "";
    uint16_t col = on ? K_TILE : K_TILE_OFF;
    if (on && pressed[0] && !strcmp(pressed, id)) col = lighten(col);
    gfx->fillRoundRect(x, y, w, h, 16, col);
    textFit(x + 18, y + 50, w - 36, t["label"] | "", F_TITLE, on ? K_TEXT : K_OFF_TEXT);
    textFit(x + 18, y + 84, w - 36, t["sub"] | "", F_BODY, on ? K_SUBTITLE : K_OFF_TEXT);
    if (on) {
      gfx->fillRoundRect(x + w - 86, y + h - 46, 70, 30, 15, K_AMBER);
      textCenter(x + w - 51, y + h - 24, "LIVE", F_BODY, K_WHITE);
      addHit(x, y, w, h, id);
    }
    i++;
  }
}

static void drawLobby(JsonObjectConst s) {
  // QR code on a white square (quiet zone included), so phones can scan it.
  gfx->fillRoundRect(24, 100, 230, 230, 8, K_WHITE);
  JsonObjectConst qr = s["qr"].as<JsonObjectConst>();
  int size = qr["size"] | 0;
  if (size > 0) {
    int scale = 230 / (size + 4);
    int ox = 24 + (230 - scale * size) / 2, oy = 100 + (230 - scale * size) / 2;
    int r = 0;
    for (JsonVariantConst row : qr["rows"].as<JsonArrayConst>()) {
      const char *bits = row | "";
      for (int c = 0; c < size && bits[c]; c++)
        if (bits[c] == '1') gfx->fillRect(ox + c * scale, oy + r * scale, scale, scale, K_BLACK);
      r++;
    }
  }
  char code[32];
  snprintf(code, sizeof(code), "Code %s", (const char *)(s["code"] | ""));
  textCenter(139, 360, code, F_LARGE, K_TEXT);
  gfx->setFont(F_SMALL);
  char url[96];
  strlcpy(url, s["joinUrl"] | "", sizeof(url));
  ellipsize(url, sizeof(url), 270);
  textCenter(139, 386, url, F_SMALL, K_DIM);

  JsonArrayConst players = s["players"].as<JsonArrayConst>();
  char head[32];
  snprintf(head, sizeof(head), "Players (%d)", (int)players.size());
  text(280, 124, head, F_LARGE, K_TEXT);
  if (players.size() == 0) text(280, 160, "Waiting for players...", F_BODY, K_DIM);
  int i = 0;
  for (JsonVariantConst p : players) {
    if (i >= 7) break;
    textFit(280, 158 + i * 30, 496, p | "", F_LARGE, K_TEXT);
    i++;
  }
  const char *q = s["question"] | "";
  if (q[0]) {
    char line[200];
    snprintf(line, sizeof(line), "First up: %s", q);
    textFit(280, 370, 496, line, F_BODY, K_DIM);
  }
}

static void drawPrice(int x, const char *label, int value, bool up, bool yes) {
  const int y = 180, w = 250, h = 200;
  gfx->fillRoundRect(x, y, w, h, 16, yes ? K_YES_DARK : K_NO_DARK);
  gfx->drawRoundRect(x, y, w, h, 16, yes ? K_YES : K_NO);
  gfx->drawRoundRect(x + 1, y + 1, w - 2, h - 2, 15, yes ? K_YES : K_NO);
  text(x + 20, y + 38, label, F_LARGE, K_TEXT);
  if (up) gfx->fillTriangle(x + w - 25, y + 14, x + w - 39, y + 36, x + w - 11, y + 36, K_MINT);
  char num[8];
  snprintf(num, sizeof(num), "%d", value);
  gfx->setFont(F_PRICE);
  int16_t wn = textW(num);
  gfx->setFont(F_LARGE);
  int16_t wc = textW("\xC2\xA2");  // cent sign
  int16_t sx = x + (w - (wn + 6 + wc)) / 2;
  text(sx, y + 166, num, F_PRICE, K_TEXT);
  text(sx + wn + 6, y + 166, "\xC2\xA2", F_LARGE, K_TEXT);
}

static void drawChart(JsonArrayConst hist) {
  const int x = 556, y = 180, w = 220, h = 110;
  gfx->fillRoundRect(x, y, w, h, 10, K_CARD);
  gfx->drawRoundRect(x, y, w, h, 10, K_LINE);
  auto py = [&](int v) { return y + h - 6 - (v * (h - 12)) / 100; };
  for (int dx = x + 6; dx < x + w - 6; dx += 8) gfx->drawFastHLine(dx, py(50), 4, K_LINE);
  int n = hist.size();
  if (n < 2) {
    int v = n ? (hist[0] | 50) : 50;
    gfx->drawFastHLine(x + 6, py(v), w - 12, K_YES);
    return;
  }
  int prevX = 0, prevY = 0, i = 0;
  for (JsonVariantConst v : hist) {
    int cx = x + 6 + (i * (w - 12)) / (n - 1);
    int cy = py(v | 50);
    if (i > 0) {
      gfx->drawLine(prevX, prevY, cx, cy, K_YES);
      gfx->drawLine(prevX, prevY + 1, cx, cy + 1, K_YES);
    }
    prevX = cx;
    prevY = cy;
    i++;
  }
  gfx->fillCircle(prevX, prevY, 4, K_YES);
}

static int currentLockIn(JsonObjectConst s) {
  int lockIn = s["lockIn"] | 0;
  int elapsed = (millis() - receivedAt) / 1000;
  return max(0, lockIn - elapsed);
}

static void drawMarket(JsonObjectConst s, bool locked) {
  wrap(24, 128, 752, 34, 2, s["question"] | "", F_TITLE, K_TEXT);
  int move = s["move"] | 0;
  drawPrice(24, "YES", s["yes"] | 50, move == 1, true);
  drawPrice(290, "NO", s["no"] | 50, move == -1, false);
  drawChart(s["history"].as<JsonArrayConst>());
  text(556, 318, s["traded"] | "", F_BODY, K_TEXT);
  if (!locked) {
    int secs = currentLockIn(s);
    char clock[12];
    snprintf(clock, sizeof(clock), "%d:%02d", secs / 60, secs % 60);
    text(556, 346, "Locks in", F_SMALL, K_DIM);
    text(556, 388, clock, F_CLOCK, secs <= 10 ? K_PINK : K_TEXT);
  } else {
    text(556, 376, "CLOSED", F_TITLE, K_RED_TEXT);
  }
}

static void drawResult(JsonObjectConst s) {
  const char *res = s["result"] | "";
  bool yes = !strcmp(res, "YES");
  gfx->fillRoundRect(24, 100, 320, 284, 16, yes ? K_YES : K_NO);
  textCenter(184, 271, res, F_RESULT, K_WHITE);
  wrap(368, 124, 408, 26, 2, s["question"] | "", F_BODY, K_DIM);
  int i = 0;
  for (JsonVariantConst line : s["lines"].as<JsonArrayConst>()) {
    if (i >= 6) break;
    textFit(368, 196 + i * 34, 408, line | "", F_LARGE, K_TEXT);
    i++;
  }
}

static void drawEnded(JsonObjectConst s) {
  textCenter(400, 120, "Final balances", F_BODY, K_DIM);
  int i = 0;
  for (JsonVariantConst line : s["lines"].as<JsonArrayConst>()) {
    if (i >= 6) break;
    textCenter(400, 162 + i * 40, line | "", F_LARGE, K_TEXT);
    i++;
  }
}

static void drawToast() {
  gfx->fillRoundRect(16, 350, 768, 40, 10, K_TOAST);
  gfx->drawRoundRect(16, 350, 768, 40, 10, K_RED_TEXT);
  gfx->setFont(F_BODY);
  char buf[96];
  strlcpy(buf, toast, sizeof(buf));
  ellipsize(buf, sizeof(buf), 740);
  textCenter(400, 377, buf, F_BODY, K_TEXT);
}

static void drawConnection(const NetStatus &st) {
  gfx->fillScreen(K_BG);
  gfx->fillRect(0, 0, SCR_W, 88, hex565(0x2a3140));
  char title[48];
  snprintf(title, sizeof(title), "Live Lines kiosk %s", KIOSK_ID);
  text(24, 54, title, F_TITLE, K_TEXT);
  int y = 150;
  if (!st.configured) {
    text(24, y, "Wi-Fi is not set up yet.", F_LARGE, K_TEXT);
    wrap(24, y + 44, 752, 30, 4,
         "Copy secrets.example.h to secrets.h in the firmware folder, fill in WIFI_SSID, WIFI_PASSWORD and "
         "SERVER_URL, then upload the sketch again.",
         F_BODY, K_DIM);
    return;
  }
  char line[160];
  if (!st.wifi) {
    snprintf(line, sizeof(line), "Connecting to Wi-Fi \"%s\"...", WIFI_SSID);
    textFit(24, y, 752, line, F_LARGE, K_TEXT);
    wrap(24, y + 44, 752, 30, 3,
         "Is the phone hotspot on? It must be 2.4 GHz (iPhone: turn on Maximize Compatibility).", F_BODY, K_DIM);
    return;
  }
  snprintf(line, sizeof(line), "Wi-Fi OK  (IP %s)", st.ip);
  text(24, y, line, F_LARGE, K_MINT);
  text(24, y + 48, st.lastOkMs ? "Reconnecting to the site..." : "Reaching the site...", F_LARGE, K_TEXT);
  textFit(24, y + 88, 752, SERVER_URL, F_BODY, K_DIM);
  if (st.error[0]) {
    snprintf(line, sizeof(line), "Last error: %s", st.error);
    textFit(24, y + 124, 752, line, F_BODY, K_PINK);
  }
}

// ---------------------------------------------------------------- public

void uiBootScreen(const char *line) {
  gfx->setUTF8Print(true);
  gfx->fillScreen(K_BG);
  textCenter(400, 220, "Live Lines", F_TITLE, K_TEXT);
  textCenter(400, 270, line, F_BODY, K_DIM);
  boardPresent();
}

void uiSetJson(const String &body) {
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    Serial.printf("[ui] bad JSON: %s\n", err.c_str());
    return;
  }
  haveScreen = true;
  receivedAt = millis();
  pressed[0] = 0;  // the server answered, so the press is done
  const char *e = doc["error"] | "";
  if (e[0]) {
    strlcpy(toast, e, sizeof(toast));
    toastUntil = millis() + 3000;
  }
  dirty = true;
}

void uiPress(const char *id) {
  strlcpy(pressed, id, sizeof(pressed));
  pressedAt = millis();
  dirty = true;
}

bool uiNeedsRender(const NetStatus &st) {
  bool stale = !haveScreen || st.lastOkMs == 0 || millis() - st.lastOkMs > STALE_MS;
  if (dirty || stale != lastStale) return true;
  if (stale) return millis() - lastStaleDraw > 1000;  // keep the connection text current
  if (pressed[0] && millis() - pressedAt > 1500) {
    pressed[0] = 0;
    return true;
  }
  if (lastToast && millis() > toastUntil) return true;
  JsonObjectConst s = doc.as<JsonObjectConst>();
  if (!strcmp(s["screen"] | "", "market") && currentLockIn(s) != lastLockIn) return true;
  return false;
}

void uiRender(const NetStatus &st) {
  dirty = false;
  nHits = 0;
  bool stale = !haveScreen || st.lastOkMs == 0 || millis() - st.lastOkMs > STALE_MS;
  lastStale = stale;
  if (stale) {
    lastStaleDraw = millis();
    drawConnection(st);
    boardPresent();
    return;
  }
  JsonObjectConst s = doc.as<JsonObjectConst>();
  const char *screen = s["screen"] | "";
  gfx->fillScreen(K_BG);
  drawHeader(s, st);
  if (!strcmp(screen, "select")) drawSelect(s);
  else if (!strcmp(screen, "lobby")) drawLobby(s);
  else if (!strcmp(screen, "market")) drawMarket(s, false);
  else if (!strcmp(screen, "locked")) drawMarket(s, true);
  else if (!strcmp(screen, "result")) drawResult(s);
  else if (!strcmp(screen, "ended")) drawEnded(s);
  // any other screen: header + buttons only, so new screens on the site never crash old firmware
  drawButtons(s["buttons"].as<JsonArrayConst>());
  lastToast = millis() < toastUntil;
  if (lastToast) drawToast();
  lastLockIn = !strcmp(screen, "market") ? currentLockIn(s) : -1;
  boardPresent();
}

const char *uiHitTest(int16_t x, int16_t y) {
  for (int i = 0; i < nHits; i++) {
    const Hit &h = hits[i];
    if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) return h.id;
  }
  return nullptr;
}
