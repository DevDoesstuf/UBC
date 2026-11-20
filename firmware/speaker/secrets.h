// Speaker Wi-Fi + site settings: same values as kiosk_screen/secrets.h. Committed with placeholders: put your hotspot in locally and do not commit it.
#pragma once

// CHANGE ME: your phone hotspot's name and password (2.4 GHz; iPhone: turn on "Maximize Compatibility").
#define WIFI_SSID "YOUR_HOTSPOT_NAME"
#define WIFI_PASSWORD "YOUR_HOTSPOT_PASSWORD"

// CHANGE ME: the laptop's IPv4 address on the hotspot (run ipconfig while connected to the hotspot),
// with the laptop running npm run lan in the web folder. Later: "https://<your-site>.vercel.app".
#define SERVER_URL "https://huddle-live-eight.vercel.app"

#define KIOSK_ID "1"
#define KIOSK_KEY ""
