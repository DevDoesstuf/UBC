// Hardware + app settings for the kiosk touchscreen.
// Board: Waveshare ESP32-S3-Touch-LCD-4.3 (800x480 RGB IPS, ST7262, GT911 touch, CH422G IO expander).
// The 4.3B uses the same pins, so this file works for both.
//
// Your Wi-Fi / server settings are NOT here: copy secrets.example.h to secrets.h and edit that.
#pragma once

#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

// ---------------------------------------------------------------- display (RGB565 parallel)
#define SCR_W 800
#define SCR_H 480

#define PIN_LCD_DE 5
#define PIN_LCD_VSYNC 3
#define PIN_LCD_HSYNC 46
#define PIN_LCD_PCLK 7
#define PIN_LCD_R0 1
#define PIN_LCD_R1 2
#define PIN_LCD_R2 42
#define PIN_LCD_R3 41
#define PIN_LCD_R4 40
#define PIN_LCD_G0 39
#define PIN_LCD_G1 0
#define PIN_LCD_G2 45
#define PIN_LCD_G3 48
#define PIN_LCD_G4 47
#define PIN_LCD_G5 21
#define PIN_LCD_B0 14
#define PIN_LCD_B1 38
#define PIN_LCD_B2 18
#define PIN_LCD_B3 17
#define PIN_LCD_B4 10

// Timings used by the Arduino_GFX examples for this board (known to work with Arduino_GFX).
// Waveshare's own config uses pulse/back/front = 4/8/8 for both h and v; try those if the image is shifted.
#define LCD_HSYNC_POLARITY 0
#define LCD_HSYNC_FRONT_PORCH 40
#define LCD_HSYNC_PULSE_WIDTH 48
#define LCD_HSYNC_BACK_PORCH 88
#define LCD_VSYNC_POLARITY 0
#define LCD_VSYNC_FRONT_PORCH 13
#define LCD_VSYNC_PULSE_WIDTH 3
#define LCD_VSYNC_BACK_PORCH 32
#define LCD_PCLK_ACTIVE_NEG 1
#define LCD_PCLK_HZ 16000000

// Bounce buffer (pixels) keeps the picture from drifting while Wi-Fi is busy. 0 turns it off.
#define LCD_BOUNCE_BUFFER_PX (SCR_W * 10)

// ---------------------------------------------------------------- I2C: touch + IO expander
#define PIN_I2C_SDA 8
#define PIN_I2C_SCL 9
#define PIN_TOUCH_INT 4

// CH422G uses "command addresses" instead of registers (from the CH422 datasheet):
//   0x24 = set system parameters (bit0 IO_OE: 1 = EXIO0..7 are outputs)
//   0x38 = write EXIO0..7 output levels
#define CH422G_ADDR_MODE 0x24
#define CH422G_ADDR_OUT 0x38
#define EXIO_TP_RST (1 << 1)   // GT911 reset, active low
#define EXIO_BL (1 << 2)       // backlight enable (on/off only, no PWM)
#define EXIO_LCD_RST (1 << 3)  // panel reset, active low
#define EXIO_SD_CS (1 << 4)    // SD card chip select, keep high (not used)
// EXIO5 is USB_SEL on the 4.3 (low = USB mode). Left low.

// If touches land in the wrong place, flip these.
#define TOUCH_SWAP_XY 0
#define TOUCH_INVERT_X 0
#define TOUCH_INVERT_Y 0

// ---------------------------------------------------------------- app
#define POLL_MS 1000          // how often the screen asks the site for state
#define HTTP_TIMEOUT_MS 6000
#define STALE_MS 10000        // show "Reconnecting" when no good reply for this long (longer than one slow request)
#define TAP_DEBOUNCE_MS 250
