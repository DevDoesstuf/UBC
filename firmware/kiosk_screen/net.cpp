#include "net.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "config.h"

static SemaphoreHandle_t mtx;
static QueueHandle_t touchQueue;
static String latestBody;
static uint32_t latestSeq = 0;
static NetStatus shared = {};

struct TouchMsg {
  char id[48];
};

static bool isConfigured() {
  return strcmp(WIFI_SSID, "YOUR_HOTSPOT_NAME") != 0 && strlen(WIFI_SSID) > 0;
}

static void setError(const char *msg, int code) {
  xSemaphoreTake(mtx, portMAX_DELAY);
  strlcpy(shared.error, msg, sizeof(shared.error));
  shared.lastCode = code;
  xSemaphoreGive(mtx);
}

static void publish(const String &body, int code) {
  xSemaphoreTake(mtx, portMAX_DELAY);
  latestBody = body;
  latestSeq++;
  shared.lastOkMs = millis();
  shared.lastCode = code;
  shared.error[0] = 0;
  xSemaphoreGive(mtx);
}

// One request. Uses a kept-alive connection, so only the first call pays for the TLS handshake.
static void request(HTTPClient &http, WiFiClient &client, bool post, const String &path, const String &payload) {
  String url = String(SERVER_URL) + path;
  http.setReuse(true);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  if (!http.begin(client, url)) {
    setError("Bad SERVER_URL in secrets.h", -1);
    return;
  }
  http.addHeader("Accept", "application/json");
  if (strlen(KIOSK_KEY) > 0) http.addHeader("x-kiosk-key", KIOSK_KEY);
  int code;
  if (post) {
    http.addHeader("Content-Type", "application/json");
    code = http.POST(payload);
  } else {
    code = http.GET();
  }
  // 200 = screen. 400/401 on a touch = screen plus an "error" message to show. Both are drawable.
  // Any other 4xx/5xx that carries a screen (a 404 for a stale game card, a 500) is drawable the same way.
  if (code == 200 || (code >= 400 && code < 600 && post) || code == 401) {
    String body = http.getString();
    if (body.length() > 0 && body[0] == '{') publish(body, code);
    else setError("Server sent something that is not JSON", code);
  } else if (code > 0) {
    char msg[96];
    snprintf(msg, sizeof(msg), "Server answered HTTP %d", code);
    setError(msg, code);
  } else {
    setError(HTTPClient::errorToString(code).c_str(), code);
  }
  http.end();
}

static void netTask(void *) {
  WiFiClientSecure tls;
  tls.setInsecure();  // demo: do not check the server certificate
  WiFiClient plain;
  const bool https = strncmp(SERVER_URL, "https://", 8) == 0;
  WiFiClient &client = https ? (WiFiClient &)tls : plain;
  HTTPClient http;

  const String statePath = String("/api/kiosk/state?kiosk=") + KIOSK_ID;
  uint32_t lastPoll = 0, lastBegin = 0;

  for (;;) {
    if (!isConfigured()) {
      vTaskDelay(pdMS_TO_TICKS(1000));
      continue;
    }
    if (WiFi.status() != WL_CONNECTED) {
      xSemaphoreTake(mtx, portMAX_DELAY);
      shared.wifi = false;
      xSemaphoreGive(mtx);
      if (lastBegin == 0 || millis() - lastBegin > 15000) {
        Serial.printf("[net] connecting to %s\n", WIFI_SSID);
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        lastBegin = millis();
      }
      vTaskDelay(pdMS_TO_TICKS(300));
      continue;
    }
    xSemaphoreTake(mtx, portMAX_DELAY);
    if (!shared.wifi) Serial.printf("[net] Wi-Fi up, IP %s\n", WiFi.localIP().toString().c_str());
    shared.wifi = true;
    strlcpy(shared.ip, WiFi.localIP().toString().c_str(), sizeof(shared.ip));
    xSemaphoreGive(mtx);

    TouchMsg msg;
    if (xQueueReceive(touchQueue, &msg, 0) == pdTRUE) {
      String body = String("{\"kiosk\":\"") + KIOSK_ID + "\",\"id\":\"" + msg.id + "\"}";
      request(http, client, true, "/api/kiosk/touch", body);
      lastPoll = millis();
    } else if (millis() - lastPoll >= POLL_MS) {
      lastPoll = millis();
      request(http, client, false, statePath, "");
    }
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

void netBegin() {
  mtx = xSemaphoreCreateMutex();
  touchQueue = xQueueCreate(4, sizeof(TouchMsg));
  shared.configured = isConfigured();
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  // Big stack: TLS needs it. Core 0 keeps the network away from drawing on core 1.
  xTaskCreatePinnedToCore(netTask, "net", 16384, nullptr, 1, nullptr, 0);
}

bool netTake(String &out, uint32_t &seq) {
  bool changed = false;
  xSemaphoreTake(mtx, portMAX_DELAY);
  if (latestSeq != seq) {
    out = latestBody;
    seq = latestSeq;
    changed = true;
  }
  xSemaphoreGive(mtx);
  return changed;
}

void netStatus(NetStatus &st) {
  xSemaphoreTake(mtx, portMAX_DELAY);
  st = shared;
  xSemaphoreGive(mtx);
}

void netSendTouch(const char *id) {
  TouchMsg msg;
  strlcpy(msg.id, id, sizeof(msg.id));
  xQueueSend(touchQueue, &msg, 0);
}
