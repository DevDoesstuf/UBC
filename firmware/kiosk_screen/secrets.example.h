// Copy this file to secrets.h (same folder) and fill it in. secrets.h is git-ignored.
// If secrets.h is missing, the sketch still builds with these placeholders and shows a setup screen.
#pragma once

// Phone hotspot (or any 2.4 GHz Wi-Fi; the ESP32 cannot see 5 GHz).
// iPhone: Settings > Personal Hotspot > turn on "Maximize Compatibility".
// Android: set the hotspot band to 2.4 GHz.
#define WIFI_SSID "YOUR_HOTSPOT_NAME"
#define WIFI_PASSWORD "YOUR_HOTSPOT_PASSWORD"

// The website, no trailing slash. For local testing use your laptop's IP on the same Wi-Fi,
// e.g. "http://192.168.43.20:3000" (and run `npm run dev -- -H 0.0.0.0` in web/).
#define SERVER_URL "https://your-site.vercel.app"

// Which kiosk this is. The NFC sticker on this kiosk should hold https://<site>/k/<KIOSK_ID>.
#define KIOSK_ID "1"

// Same value as the KIOSK_KEY env var on the site. Leave "" if the site does not set one.
#define KIOSK_KEY ""
