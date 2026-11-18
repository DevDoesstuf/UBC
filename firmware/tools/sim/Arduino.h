// Minimal Arduino shim so the kiosk UI (ui.cpp, ui_draw.cpp) builds on a desktop for the simulator.
#pragma once
#include <ctype.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <algorithm>
#include <string>
using std::max;
using std::min;

uint32_t millis();

class String {
 public:
  String() {}
  String(const char *s) : s_(s ? s : "") {}
  String(const std::string &s) : s_(s) {}
  const char *c_str() const { return s_.c_str(); }
  unsigned length() const { return (unsigned)s_.size(); }
  std::string s_;
};

struct SerialShim {
  template <class... A>
  void printf(const char *f, A... a) { ::printf(f, a...); }
  void println(const char *s) { ::puts(s); }
};
extern SerialShim Serial;

inline void *ps_malloc(size_t n) { return malloc(n); }
inline void *ps_calloc(size_t n, size_t s) { return calloc(n, s); }
