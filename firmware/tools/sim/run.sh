#!/bin/sh
# Builds the kiosk renderer simulator (desktop C++ compiler, zlib) and runs a script from stdin.
#   firmware/tools/sim/run.sh <out-dir> [site-url] [kiosk-id] < script.txt
# Needs the ArduinoJson 7 headers: ARDUINOJSON=/path/to/ArduinoJson/src (default: the Arduino sketchbook copy).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
FW="$HERE/../../kiosk_screen"
AJ=${ARDUINOJSON:-$HOME/Documents/Arduino/libraries/ArduinoJson/src}
BIN=${SIM_BIN:-/tmp/huddle-kiosk-sim}
c++ -std=c++17 -O2 -DHOST_SIM -I"$HERE" -I"$AJ" -I"$FW" "$HERE/main.cpp" "$FW/ui.cpp" "$FW/ui_draw.cpp" -lz -o "$BIN"
mkdir -p "$1"
"$BIN" "$@"
