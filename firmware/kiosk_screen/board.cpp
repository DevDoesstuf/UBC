#include "board.h"
#include <Wire.h>
#include "config.h"

#ifndef GFX_SKIP_OUTPUT_BEGIN
#define GFX_SKIP_OUTPUT_BEGIN -2
#endif

Arduino_GFX *gfx = nullptr;
static Arduino_ESP32RGBPanel *rgbpanel = nullptr;
static Arduino_RGB_Display *display = nullptr;
static Arduino_Canvas *canvas = nullptr;

// ---------------------------------------------------------------- CH422G IO expander

static uint8_t exioState = 0;

static bool exioWrite(uint8_t v) {
  exioState = v;
  Wire.beginTransmission(CH422G_ADDR_OUT);
  Wire.write(v);
  return Wire.endTransmission() == 0;
}

static void exioSet(uint8_t bits, bool on) {
  exioWrite(on ? (exioState | bits) : (exioState & ~bits));
}

// ---------------------------------------------------------------- GT911 touch

static uint8_t gtAddr = 0;

static bool gtRead(uint16_t reg, uint8_t *buf, uint8_t n) {
  Wire.beginTransmission(gtAddr);
  Wire.write(reg >> 8);
  Wire.write(reg & 0xFF);
  if (Wire.endTransmission() != 0) return false;
  if (Wire.requestFrom((uint16_t)gtAddr, (size_t)n, true) != n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

static bool gtWrite(uint16_t reg, uint8_t value) {
  Wire.beginTransmission(gtAddr);
  Wire.write(reg >> 8);
  Wire.write(reg & 0xFF);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

static bool gtProbe() {
  const uint8_t candidates[] = {0x5D, 0x14};
  for (uint8_t a : candidates) {
    gtAddr = a;
    uint8_t id[4] = {0};
    if (gtRead(0x8140, id, 4)) {
      Serial.printf("[touch] GT911 at 0x%02X, product id %c%c%c\n", a, id[0], id[1], id[2]);
      return true;
    }
  }
  gtAddr = 0;
  Serial.println("[touch] GT911 not found");
  return false;
}

bool boardTouchOk() { return gtAddr != 0; }

bool boardTouch(int16_t &x, int16_t &y) {
  static bool down = false;
  static int16_t lx = 0, ly = 0;
  if (!gtAddr) return false;
  uint8_t status = 0;
  if (!gtRead(0x814E, &status, 1)) return down;
  if (status & 0x80) {  // new data ready
    uint8_t points = status & 0x0F;
    if (points > 0 && points <= 5) {
      uint8_t p[8];  // track id, x lo, x hi, y lo, y hi, size lo, size hi, reserved
      if (gtRead(0x814F, p, 8)) {
        int16_t tx = p[1] | (p[2] << 8);
        int16_t ty = p[3] | (p[4] << 8);
#if TOUCH_SWAP_XY
        int16_t t = tx; tx = ty; ty = t;
#endif
#if TOUCH_INVERT_X
        tx = SCR_W - 1 - tx;
#endif
#if TOUCH_INVERT_Y
        ty = SCR_H - 1 - ty;
#endif
        lx = constrain(tx, 0, SCR_W - 1);
        ly = constrain(ty, 0, SCR_H - 1);
        down = true;
      }
    } else {
      down = false;
    }
    gtWrite(0x814E, 0);  // tell the GT911 we read it
  }
  x = lx;
  y = ly;
  return down;
}

// ---------------------------------------------------------------- bring-up

bool boardBegin() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 400000);

  // IO expander: all EXIO pins as outputs. Touch + LCD held in reset, backlight off, SD deselected.
  Wire.beginTransmission(CH422G_ADDR_MODE);
  Wire.write(0x01);
  if (Wire.endTransmission() != 0) Serial.println("[board] CH422G did not answer");
  exioWrite(EXIO_SD_CS);
  delay(20);

  // GT911 address select: INT low while reset is released -> address 0x5D.
  pinMode(PIN_TOUCH_INT, OUTPUT);
  digitalWrite(PIN_TOUCH_INT, LOW);
  delay(10);
  exioSet(EXIO_TP_RST, true);
  delay(10);
  pinMode(PIN_TOUCH_INT, INPUT);
  delay(60);

  exioSet(EXIO_LCD_RST, true);
  delay(100);

  rgbpanel = new Arduino_ESP32RGBPanel(
      PIN_LCD_DE, PIN_LCD_VSYNC, PIN_LCD_HSYNC, PIN_LCD_PCLK,
      PIN_LCD_R0, PIN_LCD_R1, PIN_LCD_R2, PIN_LCD_R3, PIN_LCD_R4,
      PIN_LCD_G0, PIN_LCD_G1, PIN_LCD_G2, PIN_LCD_G3, PIN_LCD_G4, PIN_LCD_G5,
      PIN_LCD_B0, PIN_LCD_B1, PIN_LCD_B2, PIN_LCD_B3, PIN_LCD_B4,
      LCD_HSYNC_POLARITY, LCD_HSYNC_FRONT_PORCH, LCD_HSYNC_PULSE_WIDTH, LCD_HSYNC_BACK_PORCH,
      LCD_VSYNC_POLARITY, LCD_VSYNC_FRONT_PORCH, LCD_VSYNC_PULSE_WIDTH, LCD_VSYNC_BACK_PORCH,
      LCD_PCLK_ACTIVE_NEG, LCD_PCLK_HZ, false /* useBigEndian */,
      0 /* de_idle_high */, 0 /* pclk_idle_high */, LCD_BOUNCE_BUFFER_PX);
  display = new Arduino_RGB_Display(SCR_W, SCR_H, rgbpanel, 0 /* rotation */, true /* auto_flush */);
  if (!display->begin()) {
    Serial.println("[board] panel begin failed (is PSRAM set to OPI PSRAM?)");
    return false;
  }

  // Full-screen canvas (768 KB, lands in PSRAM). Draw everything there, then copy in one go.
  canvas = new Arduino_Canvas(SCR_W, SCR_H, display);
  if (canvas->begin(GFX_SKIP_OUTPUT_BEGIN)) {
    gfx = canvas;
  } else {
    Serial.println("[board] no memory for canvas, drawing straight to the panel");
    gfx = display;
  }
  gfx->fillScreen(0x0000);
  boardPresent();

  gtProbe();
  return true;
}

void boardBacklight(bool on) { exioSet(EXIO_BL, on); }

void boardPresent() {
  if (gfx == canvas && canvas) canvas->flush();
}
