#include "ui_draw.h"
#include <math.h>
#include "config.h"
#ifndef HOST_SIM
#include "board.h"
#endif

namespace dr {

static uint16_t *fb = nullptr;
static int cx0 = 0, cy0 = 0, cx1 = SCR_W, cy1 = SCR_H;
static int ox = 0, oy = 0, ga = 255;  // effective offset (origin + layer) + layer alpha
static int bx = 0, by = 0;             // origin (a scrolled page)
static int lx = 0, ly = 0;             // layer offset

void origin(int dx, int dy) {
  bx = dx;
  by = dy;
  ox = bx + lx;
  oy = by + ly;
}
void layer(int dx, int dy, uint8_t alpha) {
  lx = dx;
  ly = dy;
  ox = bx + dx;
  oy = by + dy;
  ga = alpha;
}
void layerReset() { layer(0, 0, 255); }

void scrollRows(int y0, int y1, int d) {
  if (!fb || d == 0) return;
  y0 = max(0, y0);
  y1 = min(SCR_H, y1);
  int h = y1 - y0;
  if (h <= 0 || abs(d) >= h) return;
  if (d > 0) memmove(fb + y0 * SCR_W, fb + (y0 + d) * SCR_W, (size_t)(h - d) * SCR_W * 2);
  else memmove(fb + (y0 - d) * SCR_W, fb + y0 * SCR_W, (size_t)(h + d) * SCR_W * 2);
}
#define LAYER_I(x, y, a) \
  x += ox;               \
  y += oy;               \
  a = (uint8_t)((a * ga + 127) / 255)

#ifdef HOST_SIM
// Desktop simulator (firmware/tools/sim): draw into a plain buffer that the simulator saves as PNG.
bool begin() {
  if (!fb) fb = (uint16_t *)calloc(SCR_W * SCR_H, 2);
  return fb != nullptr;
}
void present(const Rect &) {}
#else
static Arduino_G *out = nullptr;

// Arduino_Canvas keeps the panel it flushes to in a protected member. A pointer-to-member formed through a
// derived class is the legal way to read it, so we can copy just the changed rows instead of all 768 KB.
struct CanvasPeek : public Arduino_Canvas {
  static Arduino_G *Arduino_Canvas::*outPtr() { return &CanvasPeek::_output; }
};

bool begin() {
  if (fb) return true;
  // No RTTI on the ESP32 core: compare vtables with a throwaway canvas to know whether gfx is a canvas.
  Arduino_Canvas probe(1, 1, nullptr);
  bool isCanvas = gfx && *(void **)gfx == *(void **)&probe;
  if (isCanvas) {
    Arduino_Canvas *c = (Arduino_Canvas *)gfx;
    fb = c->getFramebuffer();
    out = c->*(CanvasPeek::outPtr());
  }
  if (!fb || !out) {
    // board.cpp fell back to drawing on the panel: keep our own buffer in PSRAM and copy rows to the panel.
    fb = (uint16_t *)ps_malloc(SCR_W * SCR_H * 2);
    out = gfx;
  }
  Serial.printf("[ui] renderer: %s buffer\n", isCanvas ? "canvas" : "own");
  return fb != nullptr;
}

void present(const Rect &r0) {
  if (!fb || !out) return;
  int x0 = max<int>(0, r0.x), y0 = max<int>(0, r0.y);
  int x1 = min<int>(SCR_W, r0.x + r0.w), y1 = min<int>(SCR_H, r0.y + r0.h);
  if (x1 <= x0 || y1 <= y0) return;
  if (x0 == 0 && x1 == SCR_W) {
    out->draw16bitRGBBitmap(0, y0, fb + y0 * SCR_W, SCR_W, y1 - y0);
  } else {
    for (int y = y0; y < y1; y++) out->draw16bitRGBBitmap(x0, y, fb + y * SCR_W + x0, x1 - x0, 1);
  }
}
#endif

uint16_t *buffer() { return fb; }

void clip(const Rect &r) {
  cx0 = max<int>(0, r.x);
  cy0 = max<int>(0, r.y);
  cx1 = min<int>(SCR_W, r.x + r.w);
  cy1 = min<int>(SCR_H, r.y + r.h);
  if (cx1 < cx0) cx1 = cx0;
  if (cy1 < cy0) cy1 = cy0;
}

Rect getClip() { return {(int16_t)cx0, (int16_t)cy0, (int16_t)(cx1 - cx0), (int16_t)(cy1 - cy0)}; }

bool visible(int x, int y, int w, int h) { return x < cx1 && y < cy1 && x + w > cx0 && y + h > cy0 && w > 0 && h > 0; }

// ---------------------------------------------------------------- pixels

uint16_t mix(uint16_t a, uint16_t b, uint8_t t) {
  int ar = a >> 11, ag = (a >> 5) & 63, ab = a & 31;
  int br = b >> 11, bg = (b >> 5) & 63, bb = b & 31;
  int r = ar + (((br - ar) * t + 128) >> 8);
  int g = ag + (((bg - ag) * t + 128) >> 8);
  int bl = ab + (((bb - ab) * t + 128) >> 8);
  return (uint16_t)((r << 11) | (g << 5) | bl);
}

static inline void put(uint16_t *p, uint16_t c, int a) {
  if (a >= 252) *p = c;
  else if (a > 3) *p = mix(*p, c, (uint8_t)a);
}

static inline void span(uint16_t *p, int n, uint16_t c) {
  if (n <= 0) return;
  if ((uintptr_t)p & 2) {
    *p++ = c;
    n--;
  }
  uint32_t cc = c | ((uint32_t)c << 16);
  uint32_t *q = (uint32_t *)p;
  int m = n >> 1;
  while (m >= 4) {
    q[0] = cc;
    q[1] = cc;
    q[2] = cc;
    q[3] = cc;
    q += 4;
    m -= 4;
  }
  while (m--) *q++ = cc;
  if (n & 1) *(uint16_t *)q = c;
}

static inline void spanA(uint16_t *p, int n, uint16_t c, int a) {
  if (a >= 252) return span(p, n, c);
  if (a <= 3) return;
  int fr = (c >> 11) * a, fg = ((c >> 5) & 63) * a, fb2 = (c & 31) * a, ia = 256 - a;
  for (int i = 0; i < n; i++) {
    uint16_t d = p[i];
    int r = ((d >> 11) * ia + fr) >> 8, g = (((d >> 5) & 63) * ia + fg) >> 8, b = ((d & 31) * ia + fb2) >> 8;
    p[i] = (uint16_t)((r << 11) | (g << 5) | b);
  }
}

void fill(int x, int y, int w, int h, uint16_t c, uint8_t a) {
  LAYER_I(x, y, a);
  int x0 = max(x, cx0), y0 = max(y, cy0), x1 = min(x + w, cx1), y1 = min(y + h, cy1);
  if (x1 <= x0 || y1 <= y0 || !a) return;
  for (int yy = y0; yy < y1; yy++) spanA(fb + yy * SCR_W + x0, x1 - x0, c, a);
}

static inline float clamp01(float v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// Signed distance to a rounded box (negative inside).
static inline float sdRR(float px, float py, float cx, float cy, float hw, float hh, float r) {
  float qx = fabsf(px - cx) - (hw - r), qy = fabsf(py - cy) - (hh - r);
  float ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
  return sqrtf(ox * ox + oy * oy) + fminf(fmaxf(qx, qy), 0.f) - r;
}

static void rrectCore(int x, int y, int w, int h, int r, const uint16_t *cols, uint16_t c, uint8_t a) {
  if (w <= 0 || h <= 0 || !a || !visible(x, y, w, h)) return;
  r = min(r, min(w, h) / 2);
  if (r < 0) r = 0;
  int y0 = max(y, cy0), y1 = min(y + h, cy1);
  int xa = max(x, cx0), xb = min(x + w, cx1);
  for (int py = y0; py < y1; py++) {
    uint16_t *row = fb + py * SCR_W;
    int top = py - y, bot = y + h - 1 - py;
    int d = min(top, bot);
    int solidL = x, solidR = x + w;  // [solidL, solidR) drawn at full coverage
    if (d < r) {
      float dy = (top < bot) ? (y + r) - (py + 0.5f) : (py + 0.5f) - (y + h - r);
      float dy2 = dy * dy;
      // left corner
      int lx = x;
      for (; lx < x + r; lx++) {
        float dx = (x + r) - (lx + 0.5f);
        float cov = clamp01(r - sqrtf(dx * dx + dy2) + 0.5f);
        if (cov >= 0.999f) break;
        if (lx >= xa && lx < xb) put(row + lx, cols ? cols[lx - x] : c, (int)(cov * a));
      }
      solidL = lx;
      int rx = x + w - 1;
      for (; rx >= x + w - r; rx--) {
        float dx = (rx + 0.5f) - (x + w - r);
        float cov = clamp01(r - sqrtf(dx * dx + dy2) + 0.5f);
        if (cov >= 0.999f) break;
        if (rx >= xa && rx < xb) put(row + rx, cols ? cols[rx - x] : c, (int)(cov * a));
      }
      solidR = rx + 1;
    }
    int s0 = max(solidL, xa), s1 = min(solidR, xb);
    if (s1 <= s0) continue;
    if (cols) {
      for (int px = s0; px < s1; px++) put(row + px, cols[px - x], a);
    } else {
      spanA(row + s0, s1 - s0, c, a);
    }
  }
}

void rrect(int x, int y, int w, int h, int r, uint16_t c, uint8_t a) {
  LAYER_I(x, y, a);
  rrectCore(x, y, w, h, r, nullptr, c, a);
}

void rrectGrad(int x, int y, int w, int h, int r, uint16_t c0, uint16_t c1, uint16_t c2, uint8_t a) {
  LAYER_I(x, y, a);
  if (w <= 0 || w > SCR_W * 2 || !visible(x, y, w, h)) return;
  static uint16_t cols[SCR_W * 2];
  for (int i = 0; i < w; i++) {
    int t = (i * 510) / max(1, w - 1);  // 0..510
    cols[i] = t <= 255 ? mix(c0, c1, t) : mix(c1, c2, t - 255);
  }
  rrectCore(x, y, w, h, r, cols, c0, a);
}

void rrectStroke(int x, int y, int w, int h, int r, int t, uint16_t c, uint8_t a) {
  LAYER_I(x, y, a);
  if (w <= 0 || h <= 0 || !visible(x, y, w, h)) return;
  r = min(r, min(w, h) / 2);
  float cx = x + w / 2.f, cy = y + h / 2.f, hw = w / 2.f, hh = h / 2.f;
  int y0 = max(y, cy0), y1 = min(y + h, cy1);
  int band = max(r, t) + 1;
  for (int py = y0; py < y1; py++) {
    uint16_t *row = fb + py * SCR_W;
    bool edgeRow = (py - y) < band || (y + h - 1 - py) < band;
    auto doPx = [&](int px) {
      if (px < cx0 || px >= cx1) return;
      float sd = sdRR(px + 0.5f, py + 0.5f, cx, cy, hw, hh, r);
      float cov = clamp01(0.5f - sd) * (1.f - clamp01(0.5f - (sd + t)));
      if (cov > 0.01f) put(row + px, c, (int)(cov * a));
    };
    if (edgeRow) {
      for (int px = x; px < x + w; px++) doPx(px);
    } else {
      for (int px = x; px < x + t + 1; px++) doPx(px);
      for (int px = x + w - t - 1; px < x + w; px++) doPx(px);
    }
  }
}

void shadow(int x, int y, int w, int h, int r, uint8_t strength) {
  LAYER_I(x, y, strength);
  // A soft, slightly dropped shadow (light from above), only where it shows around the card.
  const int spread = 7, drop = 3;
  if (!visible(x - spread, y, w + spread * 2, h + spread + drop)) return;
  const uint16_t ink = rgb(0x10261C);
  float cx = x + w / 2.f, cy = y + h / 2.f + drop, hw = w / 2.f, hh = h / 2.f;
  int maxA = (int)(26 * strength / 255);
  int y0 = max(y + r / 2, cy0), y1 = min(y + h + drop + spread, cy1);
  for (int py = y0; py < y1; py++) {
    uint16_t *row = fb + py * SCR_W;
    bool under = py < y + h - r;  // the card covers the middle of this row
    for (int px = max(x - spread, cx0); px < min(x + w + spread, cx1); px++) {
      if (under && px >= x + 1 && px < x + w - 1) {
        px = x + w - 2;
        continue;
      }
      float sd = sdRR(px + 0.5f, py + 0.5f, cx, cy, hw, hh, (float)r);
      if (sd < -1.f) {
        if (py < y + h) continue;
        sd = -1.f;
      }
      float f = 1.f - clamp01((sd + 1.f) / spread);
      int al = (int)(maxA * f * f);
      if (al > 1) row[px] = mix(row[px], ink, al);
    }
  }
}

void circle(float cx, float cy, float r, uint16_t c, uint8_t a) {
  LAYER_I(cx, cy, a);
  if (r <= 0) return;
  int x0 = max((int)floorf(cx - r - 1), cx0), x1 = min((int)ceilf(cx + r + 1), cx1);
  int y0 = max((int)floorf(cy - r - 1), cy0), y1 = min((int)ceilf(cy + r + 1), cy1);
  for (int py = y0; py < y1; py++) {
    uint16_t *row = fb + py * SCR_W;
    float dy = py + 0.5f - cy, dy2 = dy * dy;
    for (int px = x0; px < x1; px++) {
      float dx = px + 0.5f - cx;
      float cov = clamp01(r - sqrtf(dx * dx + dy2) + 0.5f);
      if (cov > 0.004f) put(row + px, c, (int)(cov * a));
    }
  }
}

void ring(float cx, float cy, float r, float t, uint16_t c, uint8_t a, bool topHalfOnly) {
  LAYER_I(cx, cy, a);
  float ro = r + t / 2 + 1;
  int x0 = max((int)floorf(cx - ro), cx0), x1 = min((int)ceilf(cx + ro), cx1);
  int y0 = max((int)floorf(cy - ro), cy0), y1 = min((int)ceilf(topHalfOnly ? cy + 1 : cy + ro), cy1);
  for (int py = y0; py < y1; py++) {
    uint16_t *row = fb + py * SCR_W;
    float dy = py + 0.5f - cy;
    for (int px = x0; px < x1; px++) {
      float dx = px + 0.5f - cx;
      float cov = clamp01(t / 2 - fabsf(sqrtf(dx * dx + dy * dy) - r) + 0.5f);
      if (cov > 0.004f) put(row + px, c, (int)(cov * a));
    }
  }
}

void line(float x0, float y0, float x1, float y1, float t, uint16_t c, uint8_t a) {
  LAYER_I(x0, y0, a);
  x1 += ox;
  y1 += oy;
  float hr = t / 2;
  int bx0 = max((int)floorf(fminf(x0, x1) - hr - 1), cx0), bx1 = min((int)ceilf(fmaxf(x0, x1) + hr + 1), cx1);
  int by0 = max((int)floorf(fminf(y0, y1) - hr - 1), cy0), by1 = min((int)ceilf(fmaxf(y0, y1) + hr + 1), cy1);
  float vx = x1 - x0, vy = y1 - y0, len2 = vx * vx + vy * vy;
  for (int py = by0; py < by1; py++) {
    uint16_t *row = fb + py * SCR_W;
    for (int px = bx0; px < bx1; px++) {
      float wx = px + 0.5f - x0, wy = py + 0.5f - y0;
      float k = len2 > 0 ? clamp01((wx * vx + wy * vy) / len2) : 0;
      float dx = wx - vx * k, dy = wy - vy * k;
      float cov = clamp01(hr - sqrtf(dx * dx + dy * dy) + 0.5f);
      if (cov > 0.004f) put(row + px, c, (int)(cov * a));
    }
  }
}

void tri(float x0, float y0, float x1, float y1, float x2, float y2, uint16_t c, uint8_t a) {
  LAYER_I(x0, y0, a);
  x1 += ox;
  y1 += oy;
  x2 += ox;
  y2 += oy;
  float area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (fabsf(area) < 0.01f) return;
  if (area < 0) {  // make it counter-clockwise in screen space
    float tx = x1, ty = y1;
    x1 = x2; y1 = y2; x2 = tx; y2 = ty;
  }
  float ex[3] = {x0, x1, x2}, ey[3] = {y0, y1, y2};
  float nx[3], ny[3], nc[3];
  for (int i = 0; i < 3; i++) {
    int j = (i + 1) % 3;
    float dx = ex[j] - ex[i], dy = ey[j] - ey[i], l = sqrtf(dx * dx + dy * dy);
    nx[i] = -dy / l;
    ny[i] = dx / l;
    nc[i] = -(nx[i] * ex[i] + ny[i] * ey[i]);
  }
  int bx0 = max((int)floorf(fminf(x0, fminf(x1, x2))) - 1, cx0), bx1 = min((int)ceilf(fmaxf(x0, fmaxf(x1, x2))) + 1, cx1);
  int by0 = max((int)floorf(fminf(y0, fminf(y1, y2))) - 1, cy0), by1 = min((int)ceilf(fmaxf(y0, fmaxf(y1, y2))) + 1, cy1);
  for (int py = by0; py < by1; py++) {
    uint16_t *row = fb + py * SCR_W;
    for (int px = bx0; px < bx1; px++) {
      float fx = px + 0.5f, fy = py + 0.5f, d = 1e9f;
      for (int i = 0; i < 3; i++) d = fminf(d, nx[i] * fx + ny[i] * fy + nc[i]);
      float cov = clamp01(d + 0.5f);  // d > 0 inside with this winding
      if (cov > 0.004f) put(row + px, c, (int)(cov * a));
    }
  }
}

void fillUnderLine(const int16_t *xs, const int16_t *ys, int n, int bottom, uint16_t c, uint8_t a) {
  a = (uint8_t)((a * ga + 127) / 255);
  bottom += oy;
  for (int i = 0; i + 1 < n; i++) {
    int xa = xs[i] + ox, xb = xs[i + 1] + ox;
    if (xb <= xa) continue;
    for (int px = max(xa, cx0); px < min(xb, cx1); px++) {
      int py = oy + ys[i] + ((ys[i + 1] - ys[i]) * (px - xa)) / (xb - xa);
      for (int yy = max(py, cy0); yy < min(bottom, cy1); yy++) put(fb + yy * SCR_W + px, c, a);
    }
  }
}

// ---------------------------------------------------------------- text

static uint32_t nextCp(const char *&s, const char *end) {
  uint8_t b = (uint8_t)*s++;
  if (b < 0x80) return b;
  if ((b & 0xE0) == 0xC0 && s < end) return ((b & 0x1F) << 6) | ((uint8_t)*s++ & 0x3F);
  if ((b & 0xF0) == 0xE0 && s + 1 < end) {
    uint32_t cp = ((b & 0x0F) << 12) | (((uint8_t)s[0] & 0x3F) << 6) | ((uint8_t)s[1] & 0x3F);
    s += 2;
    if (cp == 0x2026) return '.';  // "..." collapsed to a dot rather than "?"
    if (cp == 0x2019 || cp == 0x2018) return '\'';
    if (cp == 0x2013 || cp == 0x2014) return '-';
    return '?';
  }
  while (s < end && ((uint8_t)*s & 0xC0) == 0x80) s++;
  return '?';
}

static const HGlyph *glyph(const HFont &f, uint32_t cp) {
  if (cp >= f.first && cp <= f.last) {
    const HGlyph *g = &f.glyphs[cp - f.first];
    if (g->adv || g->w) return g;
  }
  if ('?' >= f.first && '?' <= f.last) {
    const HGlyph *g = &f.glyphs['?' - f.first];
    if (g->adv) return g;
  }
  return nullptr;
}

int glyphW(const HFont &f, uint32_t cp) {
  const HGlyph *g = glyph(f, cp);
  return g ? g->adv : 0;
}

int textWN(const HFont &f, const char *s, int n) {
  if (!s) return 0;
  const char *end = s + n;
  int w = 0;
  while (s < end && *s) {
    const HGlyph *g = glyph(f, nextCp(s, end));
    if (g) w += g->adv;
  }
  return w;
}

int textW(const HFont &f, const char *s) { return s ? textWN(f, s, strlen(s)) : 0; }

int textN(const HFont &f, int x, int y, const char *s, int n, uint16_t c, uint8_t a) {
  LAYER_I(x, y, a);
  if (!s) return 0;
  const char *end = s + n;
  int x0 = x;
  // Whole line outside the clip: just measure.
  if (y - f.ascent - 4 >= cy1 || y + f.descent + 4 <= cy0) return textWN(f, s, n);
  while (s < end && *s) {
    const HGlyph *g = glyph(f, nextCp(s, end));
    if (!g) continue;
    int gx = x + g->xo, gy = y + g->yo;
    if (g->w && gx < cx1 && gy < cy1 && gx + g->w > cx0 && gy + g->h > cy0) {
      const uint8_t *bits = f.bits + g->off;
      int ry0 = max(0, cy0 - gy), ry1 = min((int)g->h, cy1 - gy);
      int rx0 = max(0, cx0 - gx), rx1 = min((int)g->w, cx1 - gx);
      for (int ry = ry0; ry < ry1; ry++) {
        uint16_t *row = fb + (gy + ry) * SCR_W + gx;
        int base = ry * g->w;
        for (int rx = rx0; rx < rx1; rx++) {
          int idx = base + rx;
          int v = (bits[idx >> 1] >> ((idx & 1) ? 0 : 4)) & 15;
          if (!v) continue;
          int al = (v * 17 * a + 127) / 255;
          put(row + rx, c, al);
        }
      }
    }
    x += g->adv;
  }
  return x - x0;
}

int text(const HFont &f, int x, int y, const char *s, uint16_t c, uint8_t a) { return s ? textN(f, x, y, s, strlen(s), c, a) : 0; }

void fit(const HFont &f, const char *s, int maxW, char *outBuf, size_t cap) {
  strlcpy(outBuf, s ? s : "", cap);
  if (textW(f, outBuf) <= maxW) return;
  int dots = textW(f, "...");
  size_t n = strlen(outBuf);
  while (n > 0) {
    n--;
    while (n > 0 && ((uint8_t)outBuf[n] & 0xC0) == 0x80) n--;  // keep UTF-8 sequences whole
    if (textWN(f, outBuf, n) + dots <= maxW) break;
  }
  while (n > 0 && outBuf[n - 1] == ' ') n--;
  outBuf[n] = 0;
  strlcat(outBuf, "...", cap);
}

int wrap(const HFont &f, const char *s, int maxW, int maxLines, int *starts, int *lens, bool *cut) {
  if (cut) *cut = false;
  if (!s) return 0;
  int len = strlen(s), pos = 0, lines = 0;
  while (pos < len && lines < maxLines) {
    while (pos < len && s[pos] == ' ') pos++;
    if (pos >= len) break;
    int best = -1, j = pos;
    while (j <= len) {
      if (j == len || s[j] == ' ') {
        if (textWN(f, s + pos, j - pos) <= maxW) best = j;
        else break;
      }
      j++;
    }
    if (best < 0) {  // one long word: hard cut
      best = pos + 1;
      while (best < len && textWN(f, s + pos, best + 1 - pos) <= maxW) best++;
    }
    starts[lines] = pos;
    lens[lines] = best - pos;
    lines++;
    pos = best;
  }
  while (pos < len && s[pos] == ' ') pos++;
  if (pos < len && cut) *cut = true;
  return lines;
}

}  // namespace dr
