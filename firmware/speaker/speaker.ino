// Huddle kiosk speaker: a separate ESP32 + I2S amplifier (NULLLAB I2S amp, MAX98357A-style) + speaker.
//
// The website decides every sound; this board only plays what it is told:
//   GET {SERVER_URL}/api/kiosk/audio?kiosk={KIOSK_ID}&after=<last id>   about every 0.7 s
//     after=-1 at boot      -> {"id": <latest>, "url": null}      remember the id, play nothing old
//     something new          -> {"id": 1794969444886, "url": "https://.../sounds/win.wav", "text": "..."}
//     nothing new            -> {"id": <after>, "url": null}
// Each url is a WAV (22 kHz mono 16-bit today: the event sounds in web/public/sounds, and the announcer's voice
// from /api/tts when the site has ELEVENLABS_API_KEY). It is streamed straight to the amp, any length.
// To change what plays and when, change the website, never this file.
//
// Sounds you hear without the website:
//   two quick beeps at power-up  = the amp and wiring work
//   one high beep                = Wi-Fi is up and the website answered
//
// Setup: secrets.h (same values as the kiosk screen's secrets.h). Board: "ESP32 Dev Module".
// Libraries: ArduinoJson 7.x. Wi-Fi, HTTP and I2S come with the esp32 board package.

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>
#include <math.h>

#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

// ---------------------------------------------------------------- wiring (fixed: matches the board as built)
#define I2S_BCLK 26  // amp BCLK
#define I2S_LRC 25   // amp LRC
#define I2S_DOUT 27  // amp DIN

// ---------------------------------------------------------------- settings
#define SAMPLE_RATE 22050   // the site's sounds are 22 kHz; other rates in a WAV are switched to automatically
#define VOLUME_PERCENT 60   // 100 = full scale. Lower = quieter and smaller current spikes on the 5 V supply.
#define POLL_MS 700         // how often to ask the website for a new sound
#define WIFI_TX_POWER WIFI_POWER_15dBm

static uint32_t currentRate = 0;
static long long lastId = -1;  // -1 = just booted: ask for the latest id without playing it
static bool announcedOnline = false;

static bool isConfigured() {
  return strcmp(WIFI_SSID, "YOUR_HOTSPOT_NAME") != 0 && strlen(WIFI_SSID) > 0;
}

// ---------------------------------------------------------------- I2S (same driver and settings as the tested beep sketch)

static bool i2sBegin() {
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = 0,
    .dma_buf_count = 8,
    .dma_buf_len = 256,
    .use_apll = false,
    .tx_desc_auto_clear = true,  // send silence when there is nothing to play (no buzzing between sounds)
    .fixed_mclk = 0
  };
  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_BCLK,
    .ws_io_num = I2S_LRC,
    .data_out_num = I2S_DOUT,
    .data_in_num = I2S_PIN_NO_CHANGE
  };
  esp_err_t result = i2s_driver_install(I2S_NUM_0, &i2s_config, 0, NULL);
  if (result != ESP_OK) {
    Serial.printf("[spk] I2S install failed: %d\n", result);
    return false;
  }
  i2s_set_pin(I2S_NUM_0, &pin_config);
  i2s_zero_dma_buffer(I2S_NUM_0);
  currentRate = SAMPLE_RATE;
  return true;
}

static void setRate(uint32_t rate) {
  if (rate == currentRate) return;
  if (i2s_set_sample_rates(I2S_NUM_0, rate) == ESP_OK) currentRate = rate;
  else Serial.printf("[spk] could not switch to %u Hz\n", (unsigned)rate);
}

// Stereo 16-bit frames: L, R, L, R, ...
static void writeFrames(const int16_t *frames, size_t count) {
  size_t written = 0;
  i2s_write(I2S_NUM_0, frames, count * 2 * sizeof(int16_t), &written, portMAX_DELAY);
}

static void writeSilence(uint32_t ms) {
  static int16_t zeros[256 * 2] = {0};
  uint32_t total = currentRate * ms / 1000;
  while (total > 0) {
    size_t n = total < 256 ? total : 256;
    writeFrames(zeros, n);
    total -= n;
  }
}

static void playTone(float frequency, int durationMs) {
  setRate(SAMPLE_RATE);
  const int frames = 256;
  int16_t buffer[frames * 2];
  int totalFrames = SAMPLE_RATE * durationMs / 1000;
  int framePosition = 0;
  const float amplitude = 8000.0f * VOLUME_PERCENT / 100.0f;
  while (framePosition < totalFrames) {
    int count = min(frames, totalFrames - framePosition);
    for (int i = 0; i < count; i++) {
      float t = (float)(framePosition + i) / SAMPLE_RATE;
      int16_t sample = (int16_t)(amplitude * sinf(2.0f * PI * frequency * t));
      buffer[i * 2] = sample;
      buffer[i * 2 + 1] = sample;
    }
    writeFrames(buffer, count);
    framePosition += count;
  }
  writeSilence(40);
}

// ---------------------------------------------------------------- WAV stream -> I2S
// HTTPClient::writeToStream pushes the downloaded file into this "stream" (it also undoes chunked encoding).
// The first bytes are the WAV header; everything after the "data" chunk header is samples.

class WavToI2S : public Stream {
 public:
  void reset() {
    state = HEADER;
    hdrLen = 0;
    haveFmt = false;
    carry = -1;
    frames = 0;
    outLen = 0;
  }
  bool failed() const { return state == BAD; }
  uint32_t playedMs() const { return rate ? (uint32_t)((uint64_t)frames * 1000 / rate) : 0; }

  // Sends whatever is still buffered. Call once after the download ends.
  void finish() {
    if (state == DATA) flushOut();
  }

  size_t write(uint8_t b) override { return write(&b, 1); }
  size_t write(const uint8_t *buf, size_t n) override {
    if (state == HEADER) {
      size_t take = min(n, sizeof(hdr) - hdrLen);
      memcpy(hdr + hdrLen, buf, take);
      hdrLen += take;
      size_t dataStart = 0;
      int r = parseHeader(dataStart);
      if (r < 0 || (r == 0 && hdrLen == sizeof(hdr))) {
        Serial.println("[spk] not a WAV file this speaker can play (needs 8 or 16-bit PCM)");
        state = BAD;
        return n;
      }
      if (r == 0) return n;  // need more header bytes
      setRate(rate);
      state = DATA;
      if (hdrLen > dataStart) feed(hdr + dataStart, hdrLen - dataStart);
      if (take < n) feed(buf + take, n - take);
      return n;
    }
    if (state == DATA) feed(buf, n);
    return n;  // BAD: swallow the rest
  }
  // The read side of Stream is unused.
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}

 private:
  enum { HEADER, DATA, BAD } state = HEADER;
  uint8_t hdr[1024];
  size_t hdrLen = 0;
  bool haveFmt = false;
  uint16_t fmtTag = 0, channels = 1, bits = 16;
  uint32_t rate = SAMPLE_RATE, dataLeft = 0, frames = 0;
  int carry = -1;              // low byte of a 16-bit sample split across two network packets
  int16_t out[256 * 2];        // stereo frames waiting to go to I2S
  size_t outLen = 0;           // samples (not frames) in `out`

  static uint16_t le16(const uint8_t *p) { return p[0] | (p[1] << 8); }
  static uint32_t le32(const uint8_t *p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }

  // 1 = header complete (dataStart set), 0 = need more bytes, -1 = not playable
  int parseHeader(size_t &dataStart) {
    if (hdrLen < 12) return 0;
    if (memcmp(hdr, "RIFF", 4) != 0 || memcmp(hdr + 8, "WAVE", 4) != 0) return -1;
    size_t p = 12;
    while (p + 8 <= hdrLen) {
      uint32_t sz = le32(hdr + p + 4);
      if (memcmp(hdr + p, "fmt ", 4) == 0) {
        if (p + 8 + 16 > hdrLen) return 0;
        fmtTag = le16(hdr + p + 8);
        channels = le16(hdr + p + 10);
        rate = le32(hdr + p + 12);
        bits = le16(hdr + p + 22);
        haveFmt = true;
        if (fmtTag != 1 || (bits != 8 && bits != 16) || channels < 1 || channels > 2 || rate < 4000 || rate > 48000) return -1;
      } else if (memcmp(hdr + p, "data", 4) == 0) {
        if (!haveFmt) return -1;
        dataStart = p + 8;
        dataLeft = (sz == 0 || sz == 0xFFFFFFFF) ? 0xFFFFFFFF : sz;  // streamed WAVs may not know their size
        return 1;
      }
      if (sz > sizeof(hdr)) return -1;  // a huge extra chunk before the audio: not one of the site's files
      p += 8 + sz + (sz & 1);
    }
    return 0;
  }

  void flushOut() {
    if (outLen) writeFrames(out, outLen / 2);
    outLen = 0;
  }

  void push(int32_t s) {
    int16_t v = (int16_t)(s * VOLUME_PERCENT / 100);
    if (channels == 1) {  // mono: same sample on left and right
      out[outLen++] = v;
      out[outLen++] = v;
      frames++;
    } else {
      out[outLen++] = v;
      if ((outLen & 1) == 0) frames++;
    }
    if (outLen >= sizeof(out) / sizeof(out[0])) flushOut();
  }

  void feed(const uint8_t *p, size_t n) {
    if (dataLeft != 0xFFFFFFFF) {
      if (n > dataLeft) n = dataLeft;
      dataLeft -= n;
    }
    size_t i = 0;
    if (bits == 8) {
      for (; i < n; i++) push(((int32_t)p[i] - 128) * 256);  // 8-bit WAV is unsigned
      return;
    }
    if (carry >= 0 && n > 0) {
      push((int16_t)(carry | (p[0] << 8)));
      carry = -1;
      i = 1;
    }
    for (; i + 1 < n; i += 2) push((int16_t)(p[i] | (p[i + 1] << 8)));
    if (i < n) carry = p[i];
  }
};

static WavToI2S wav;

// ---------------------------------------------------------------- network
// Polling and sound downloads each keep one connection open, so HTTPS does not redo its handshake every time.

static WiFiClientSecure pollTls, playTls;
static WiFiClient pollPlain, playPlain;
static HTTPClient pollHttp, playHttp;

static WiFiClient &pickClient(const String &url, WiFiClientSecure &tls, WiFiClient &plain) {
  return url.startsWith("https://") ? (WiFiClient &)tls : plain;
}

static void ensureWiFi() {
  static uint32_t lastBegin = 0;
  if (WiFi.status() == WL_CONNECTED) return;
  if (lastBegin == 0 || millis() - lastBegin > 15000) {
    Serial.printf("[spk] connecting to Wi-Fi \"%s\"\n", WIFI_SSID);
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    WiFi.setTxPower(WIFI_TX_POWER);
    lastBegin = millis();
  }
}

static bool playUrl(const String &url) {
  HTTPClient &http = playHttp;
  http.setReuse(true);
  http.setTimeout(10000);
  http.setConnectTimeout(8000);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  if (!http.begin(pickClient(url, playTls, playPlain), url)) {
    Serial.printf("[spk] bad sound url %s\n", url.c_str());
    return false;
  }
  int code = http.GET();
  if (code != 200) {
    Serial.printf("[spk] sound download failed: HTTP %d\n", code);
    http.end();
    return false;
  }
  wav.reset();
  int n = http.writeToStream(&wav);
  http.end();
  wav.finish();
  writeSilence(60);  // let the last samples leave the amp
  i2s_zero_dma_buffer(I2S_NUM_0);
  Serial.printf("[spk] played %u ms (%d bytes)%s\n", (unsigned)wav.playedMs(), n, wav.failed() ? " - FAILED" : "");
  return n > 0 && !wav.failed();
}

// Asks the website for the next sound. Returns true if it played one (then ask again right away).
static bool pollOnce() {
  char path[96];
  snprintf(path, sizeof(path), "/api/kiosk/audio?kiosk=%s&after=%lld", KIOSK_ID, lastId);
  String url = String(SERVER_URL) + path;
  HTTPClient &http = pollHttp;
  http.setReuse(true);
  http.setTimeout(6000);
  http.setConnectTimeout(6000);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  if (!http.begin(pickClient(url, pollTls, pollPlain), url)) return false;
  int code = http.GET();
  String body = code == 200 ? http.getString() : String();
  http.end();  // the connection stays open for the next poll (setReuse)
  if (code != 200) {
    static uint32_t lastErr = 0;
    if (millis() - lastErr > 10000) {
      Serial.printf("[spk] %s -> %d %s\n", url.c_str(), code, code < 0 ? HTTPClient::errorToString(code).c_str() : "");
      lastErr = millis();
    }
    return false;
  }
  JsonDocument doc;
  if (deserializeJson(doc, body)) return false;
  if (!announcedOnline) {
    announcedOnline = true;
    Serial.println("[spk] website reached, listening for sounds");
    playTone(1760, 150);
  }
  long long id = (long long)(doc["id"] | 0.0);  // ms timestamps: read as a double so nothing overflows
  const char *soundUrl = doc["url"].as<const char *>();  // null when there is nothing new
  if (lastId < 0 || !soundUrl) {
    if (id > lastId) lastId = id;
    return false;
  }
  lastId = id;  // move on even if playing fails, so one bad file can't loop forever
  Serial.printf("[spk] playing %s  \"%s\"\n", soundUrl, (const char *)(doc["text"] | ""));
  playUrl(String(soundUrl));
  return true;
}

// ---------------------------------------------------------------- main

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n[spk] Huddle speaker for kiosk %s (BCLK %d, LRC %d, DOUT %d)\n", KIOSK_ID, I2S_BCLK, I2S_LRC, I2S_DOUT);
  if (i2sBegin()) {
    Serial.println("[spk] speaker ready");
    playTone(880, 120);
    playTone(1320, 120);
  }
  pollTls.setInsecure();  // demo: do not check the server certificate
  playTls.setInsecure();
  if (!isConfigured()) {
    Serial.println("[spk] Wi-Fi not set up: copy secrets.example.h to secrets.h and fill it in.");
    return;
  }
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  ensureWiFi();
}

void loop() {
  static uint32_t lastPoll = 0;
  static bool wasUp = false;
  if (!isConfigured()) {
    delay(1000);
    return;
  }
  ensureWiFi();
  bool up = WiFi.status() == WL_CONNECTED;
  if (up != wasUp) {
    if (up) Serial.printf("[spk] Wi-Fi up, IP %s\n", WiFi.localIP().toString().c_str());
    else Serial.println("[spk] Wi-Fi down");
    wasUp = up;
  }
  if (!up) {
    delay(200);
    return;
  }
  if (millis() - lastPoll >= POLL_MS) {
    lastPoll = millis();
    if (pollOnce()) lastPoll = 0;  // played something: check for the next one right away
  }
  delay(20);
}
