// The kiosk screen: draws the JSON from the site (GET /api/kiosk/state) with the Huddle "Kickoff" look in
// green + ivory, animates it, and turns finger input into taps and scrolls.
// Layout and motion match web/components/KioskView.tsx (800 x 480), so /kiosk?id=1 previews the box.
#pragma once
#include <Arduino.h>
#include "net.h"

void uiBegin();                                   // after boardBegin(): grab the frame buffer
void uiBootScreen(const char *line);
void uiSetJson(const String &body);               // a new screen from the server
// Feed the finger every loop: down + position. Returns a button/tile id when a tap completes (finger lifted on
// the same target without dragging), else nullptr. Drags scroll lists, with momentum.
const char *uiTouch(bool down, int16_t x, int16_t y);
// Draws what changed and copies only those rectangles to the panel. Returns true while something moves
// (then call again soon, about 30 fps); false when the screen is still (idle: no drawing at all).
bool uiFrame(const NetStatus &st);
