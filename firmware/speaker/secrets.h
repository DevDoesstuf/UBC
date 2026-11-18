// Speaker Wi-Fi + site settings: a copy of kiosk_screen/secrets.h (keep the two the same). Committed to the repo on purpose.
#pragma once

// CHANGE ME: your phone hotspot's name and password (2.4 GHz; iPhone: turn on "Maximize Compatibility").
#define WIFI_SSID "iPhone"
#define WIFI_PASSWORD "Devhotspot"

// CHANGE ME: the laptop's IPv4 address on the hotspot (run ipconfig while connected to the hotspot),
// with the laptop running npm run lan in the web folder. Later: "https://<your-site>.vercel.app".
#define SERVER_URL "https://huddle-live-eight.vercel.app"

#define KIOSK_ID "1"
#define KIOSK_KEY ""
