// Software renderer for the kiosk: anti-aliased shapes and text drawn straight into the 800x480 RGB565
// frame buffer (the Arduino_Canvas buffer in PSRAM), then only the changed rectangles are copied to the panel.
// Everything respects one clip rectangle, so a scene can be redrawn cheaply inside a small dirty area.
#pragma once
#include <Arduino.h>

struct HGlyph {
  uint32_t off;
  uint8_t w, h;
  int8_t xo, yo;
  uint8_t adv;
};
struct HFont {
  const uint8_t *bits;
  const HGlyph *glyphs;
  uint16_t first, last;
  uint8_t ascent, descent, size;
};

struct Rect {
  int16_t x, y, w, h;
  bool empty() const { return w <= 0 || h <= 0; }
  bool contains(int px, int py) const { return px >= x && py >= y && px < x + w && py < y + h; }
};

namespace dr {

static constexpr uint16_t rgb(uint32_t hex) {
  return (uint16_t)((((hex >> 16) & 0xF8) << 8) | (((hex >> 8) & 0xFC) << 3) | ((hex & 0xFF) >> 3));
}
uint16_t mix(uint16_t a, uint16_t b, uint8_t t);  // t=0 -> a, 255 -> b

bool begin();               // find the frame buffer to draw in (canvas buffer, or our own PSRAM buffer)
void present(const Rect &r);  // copy one rectangle of the frame buffer to the panel
uint16_t *buffer();

void clip(const Rect &r);   // replaces the clip (intersected with the screen)
Rect getClip();
bool visible(int x, int y, int w, int h);  // does this box touch the clip?
// A layer: every primitive after this is moved by (dx, dy) and multiplied by alpha (entrances, fades).
void layer(int dx, int dy, uint8_t alpha);
void layerReset();  // back to the origin, full alpha
// Origin: a scrolled page moves everything by (dx, dy) underneath the layer (layers stay relative to it).
void origin(int dx, int dy);
// Moves rows [y0, y1) of the frame buffer up by d pixels (down when d < 0): a scrolled page reuses what it
// already drew and only draws the strip that scrolled into view.
void scrollRows(int y0, int y1, int d);

void fill(int x, int y, int w, int h, uint16_t c, uint8_t a = 255);
void rrect(int x, int y, int w, int h, int r, uint16_t c, uint8_t a = 255);
// Rounded rect filled with a left-to-right gradient through up to 3 stops.
void rrectGrad(int x, int y, int w, int h, int r, uint16_t c0, uint16_t c1, uint16_t c2, uint8_t a = 255);
void rrectStroke(int x, int y, int w, int h, int r, int t, uint16_t c, uint8_t a = 255);
void shadow(int x, int y, int w, int h, int r, uint8_t strength = 255);  // soft lift under a card
void circle(float cx, float cy, float r, uint16_t c, uint8_t a = 255);
void ring(float cx, float cy, float r, float t, uint16_t c, uint8_t a = 255, bool topHalfOnly = false);
void line(float x0, float y0, float x1, float y1, float t, uint16_t c, uint8_t a = 255);
void tri(float x0, float y0, float x1, float y1, float x2, float y2, uint16_t c, uint8_t a = 255);
void fillUnderLine(const int16_t *xs, const int16_t *ys, int n, int bottom, uint16_t c, uint8_t a);

// Text. `y` is the baseline. Returns the advance. UTF-8 in, Latin-1 glyphs.
int text(const HFont &f, int x, int y, const char *s, uint16_t c, uint8_t a = 255);
int textW(const HFont &f, const char *s);
int textN(const HFont &f, int x, int y, const char *s, int n, uint16_t c, uint8_t a = 255);  // first n bytes
int textWN(const HFont &f, const char *s, int n);
int glyphW(const HFont &f, uint32_t cp);
// Copies s into out, cut with "..." so it fits in maxW.
void fit(const HFont &f, const char *s, int maxW, char *out, size_t cap);
// Word wrap: fills `starts`/`lens` with up to maxLines lines (the last one may get "..."). Returns lines used.
int wrap(const HFont &f, const char *s, int maxW, int maxLines, int *starts, int *lens, bool *cut);

}  // namespace dr
