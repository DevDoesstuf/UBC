// Hardware layer: panel, backlight (via CH422G), GT911 touch.
#pragma once
#include <Arduino.h>
// U8g2 must be included before Arduino_GFX: Arduino_GFX only turns on its U8g2 font support when it can
// see U8g2, and the Arduino IDE only adds a library to the build when a sketch file includes it directly.
#include <U8g2lib.h>
#include <Arduino_GFX_Library.h>

// What the UI draws on: an off-screen canvas when there is room (no flicker), else the panel itself.
extern Arduino_GFX *gfx;

bool boardBegin();             // I2C, IO expander, resets, panel. Returns false if the panel failed.
void boardBacklight(bool on);
void boardPresent();           // push the finished frame to the panel
bool boardTouch(int16_t &x, int16_t &y);  // true while a finger is down; x/y in screen pixels
bool boardTouchOk();
