// Network layer: Wi-Fi and the two HTTP calls of the kiosk API, on their own FreeRTOS task (core 0)
// so touches and drawing never wait on the network.
//   GET  {SERVER_URL}/api/kiosk/state?kiosk={KIOSK_ID}       every POLL_MS
//   POST {SERVER_URL}/api/kiosk/touch  {"kiosk":"1","id":"..."}  when something is tapped
// Both return the screen JSON that ui.cpp draws.
#pragma once
#include <Arduino.h>

struct NetStatus {
  bool configured;      // false while secrets.h still has the placeholder SSID
  bool wifi;            // connected to Wi-Fi
  uint32_t lastOkMs;    // millis() of the last good reply (0 = never)
  int lastCode;         // last HTTP status (negative = HTTPClient error)
  char error[96];       // last problem, for the connection screen
  char ip[16];
};

void netBegin();
// Copies the newest screen JSON into `out` if it changed since `seq`. Returns true when it did.
bool netTake(String &out, uint32_t &seq);
void netStatus(NetStatus &st);
void netSendTouch(const char *id);
