// Live Lines kiosk touchscreen
// Board: Waveshare ESP32-S3-Touch-LCD-4.3 (or 4.3B), 800x480, GT911 touch.
//
// The kiosk only displays state and sends taps. All game logic is on the website:
//   - every second it GETs /api/kiosk/state and draws the JSON it gets back (ui.cpp: animated, scrollable,
//     drawn into the PSRAM frame buffer and copied to the panel only where something changed)
//   - when you tap a button or tile (finger lifted on it, not dragged) it POSTs that id to /api/kiosk/touch
// So labels, screens and flow can change on the site without reflashing.
//
// Setup: copy secrets.example.h to secrets.h, set Wi-Fi + SERVER_URL. Board settings are in the README
// (ESP32S3 Dev Module, PSRAM: OPI PSRAM, Flash 8MB, partition "8M with spiffs").
// Libraries: GFX Library for Arduino (moononournation) 1.6.x, U8g2, ArduinoJson 7.x.

#include "config.h"
#include "board.h"
#include "net.h"
#include "ui.h"

static uint32_t screenSeq = 0;
static String screenBody;

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[kiosk] Live Lines kiosk starting");

  if (!boardBegin()) {
    // Without a working panel there is nothing to show; keep logging so the serial monitor explains.
    for (;;) {
      Serial.println("[kiosk] display failed to start. Check Tools > PSRAM = \"OPI PSRAM\", then upload again.");
      delay(3000);
    }
  }
  uiBegin();
  uiBootScreen("Starting...");
  boardBacklight(true);  // before Wi-Fi starts: the backlight inrush plus Wi-Fi at once can brown out
  delay(300);
  netBegin();
}

void loop() {
  static uint32_t lastTap = 0;

  if (netTake(screenBody, screenSeq)) uiSetJson(screenBody);

  // Finger in: the UI tells a tap (press + release on the same target) from a drag (scrolls a list).
  int16_t x, y;
  bool down = boardTouch(x, y);
  const char *id = uiTouch(down, x, y);
  if (id && millis() - lastTap > TAP_DEBOUNCE_MS) {
    lastTap = millis();
    Serial.printf("[touch] %d,%d -> %s\n", x, y, id);
    netSendTouch(id);
  }

  NetStatus st;
  netStatus(st);
  // About 30-40 fps while something moves, idle otherwise. Wi-Fi runs on the other core either way.
  bool moving = uiFrame(st);
  delay(moving ? 2 : 12);
}
