// Draws the screen JSON from the site. Layout matches web/components/KioskView.tsx (800 x 480).
#pragma once
#include <Arduino.h>
#include "net.h"

void uiSetJson(const String &body);              // parse a new screen from the server
void uiRender(const NetStatus &st);              // draw everything and push it to the panel
bool uiNeedsRender(const NetStatus &st);         // countdown ticked, toast expired, connection changed...
const char *uiHitTest(int16_t x, int16_t y);     // id of the button/tile under (x,y), or nullptr
void uiPress(const char *id);                    // highlight a button until the server answers
void uiBootScreen(const char *line);
