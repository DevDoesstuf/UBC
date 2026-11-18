// Kiosk renderer simulator: runs the real ui.cpp/ui_draw.cpp against the site's kiosk API and saves PNGs,
// so the firmware drawing can be checked without the board. Build + use: firmware/tools/sim/run.sh.
// Script lines (stdin):
//   state                  GET /api/kiosk/state and feed it to the UI (what the firmware polls every second)
//   tap <id>               POST /api/kiosk/touch {id} and feed the answer (what a tap does)
//   json <file>            feed a JSON file
//   wait <ms>              advance the clock, running frames every 16 ms (animations play)
//   down <x> <y> | move <x> <y> | up     finger input (a completed tap is POSTed like on the board)
//   shot <name>            save <out>/<name>.png
//   stale <ms>             pretend the last good reply was <ms> ago (Wi-Fi loss)
//   sh <command...>        run a shell command (e.g. phones joining and trading through the lobby API)
#include <zlib.h>
#include <string>
#include "Arduino.h"
#include "../../kiosk_screen/ui.h"
#include "../../kiosk_screen/ui_draw.h"

SerialShim Serial;
static uint32_t simNow = 1000;
uint32_t millis() { return simNow; }
static std::string base = "http://localhost:3401", kiosk = "41", outDir = ".";
static uint32_t lastOk = 0;

static std::string sh(const std::string &cmd) {
  std::string out;
  FILE *p = popen(cmd.c_str(), "r");
  if (!p) return out;
  char buf[4096];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, p)) > 0) out.append(buf, n);
  pclose(p);
  return out;
}

static void feed(const std::string &body) {
  if (body.empty() || body[0] != '{') {
    fprintf(stderr, "bad body: %.120s\n", body.c_str());
    return;
  }
  uiSetJson(String(body));
  lastOk = simNow;
}

static void put32(std::string &s, uint32_t v) {
  for (int i = 3; i >= 0; i--) s.push_back((char)((v >> (i * 8)) & 255));
}
static void chunk(std::string &png, const char *type, const std::string &data) {
  put32(png, data.size());
  std::string td = std::string(type, 4) + data;
  png += td;
  put32(png, crc32(0, (const Bytef *)td.data(), td.size()));
}
static void shot(const std::string &name) {
  const uint16_t *fb = dr::buffer();
  std::string raw;
  for (int y = 0; y < 480; y++) {
    raw.push_back(0);
    for (int x = 0; x < 800; x++) {
      uint16_t c = fb[y * 800 + x];
      int r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
      raw.push_back((char)((r << 3) | (r >> 2)));
      raw.push_back((char)((g << 2) | (g >> 4)));
      raw.push_back((char)((b << 3) | (b >> 2)));
    }
  }
  uLongf zl = compressBound(raw.size());
  std::string z(zl, 0);
  compress2((Bytef *)&z[0], &zl, (const Bytef *)raw.data(), raw.size(), 6);
  z.resize(zl);
  std::string png("\x89PNG\r\n\x1a\n", 8), ih;
  put32(ih, 800);
  put32(ih, 480);
  ih += std::string("\x08\x02\x00\x00\x00", 5);
  chunk(png, "IHDR", ih);
  chunk(png, "IDAT", z);
  chunk(png, "IEND", "");
  std::string path = outDir + "/" + name + ".png";
  FILE *f = fopen(path.c_str(), "wb");
  if (!f) return;
  fwrite(png.data(), 1, png.size(), f);
  fclose(f);
  printf("saved %s\n", path.c_str());
}

static NetStatus status() {
  NetStatus st = {};
  st.configured = true;
  st.wifi = true;
  st.lastOkMs = lastOk;
  st.lastCode = 200;
  strcpy(st.ip, "192.168.4.2");
  return st;
}

static int frames = 0;
static void step(uint32_t ms) {
  uint32_t end = simNow + ms;
  while (simNow < end) {
    simNow += 16;
    NetStatus st = status();
    if (uiFrame(st)) frames++;
  }
}

static void tapSend(const char *id) {
  std::string body = sh("curl -s -X POST -H 'content-type: application/json' -d '{\"kiosk\":\"" + kiosk + "\",\"id\":\"" + id +
                        "\"}' " + base + "/api/kiosk/touch");
  printf("tap %s -> %.70s\n", id, body.c_str());
  feed(body);
}

int main(int argc, char **argv) {
  if (argc > 1) outDir = argv[1];
  if (argc > 2) base = argv[2];
  if (argc > 3) kiosk = argv[3];
  uiBegin();
  uiBootScreen("Starting...");
  char line[512];
  bool down = false;
  int fx = 0, fy = 0;
  while (fgets(line, sizeof line, stdin)) {
    char cmd[32] = "", a[256] = "";
    sscanf(line, "%31s %255s", cmd, a);
    if (!strcmp(cmd, "state")) feed(sh("curl -s '" + base + "/api/kiosk/state?kiosk=" + kiosk + "'"));
    else if (!strcmp(cmd, "tap")) tapSend(a);
    else if (!strcmp(cmd, "json")) {
      FILE *f = fopen(a, "rb");
      if (!f) continue;
      std::string body;
      char buf[4096];
      size_t n;
      while ((n = fread(buf, 1, sizeof buf, f)) > 0) body.append(buf, n);
      fclose(f);
      feed(body);
    } else if (!strcmp(cmd, "wait")) step(atoi(a));
    else if (!strcmp(cmd, "shot")) shot(a);
    else if (!strcmp(cmd, "sh")) {
      std::string out = sh(std::string(line + 3));
      if (!out.empty()) printf("%s", out.c_str());
    } else if (!strcmp(cmd, "stale")) lastOk = simNow > (uint32_t)atoi(a) ? simNow - atoi(a) : 0;
    else if (!strcmp(cmd, "down") || !strcmp(cmd, "move") || !strcmp(cmd, "up")) {
      if (strcmp(cmd, "up")) {
        sscanf(line, "%*s %d %d", &fx, &fy);
        down = true;
      } else {
        down = false;
      }
      const char *id = uiTouch(down, fx, fy);
      if (id) tapSend(id);
      step(16);
    }
  }
  printf("frames drawn: %d\n", frames);
  return 0;
}
