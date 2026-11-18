// Copy this file to secrets.h (same folder) and fill it in. secrets.h is committed to the repo (hotspot details are not secret for this demo).
// Use the SAME values as the kiosk screen's secrets.h: same hotspot, same site, same kiosk id.
#pragma once

#define WIFI_SSID "YOUR_HOTSPOT_NAME"       // 2.4 GHz (iPhone: turn on "Maximize Compatibility")
#define WIFI_PASSWORD "YOUR_HOTSPOT_PASSWORD"
#define SERVER_URL "https://your-site.vercel.app"  // or "http://<laptop-ip>:3000" for local testing
#define KIOSK_ID "1"                         // the kiosk this speaker belongs to
