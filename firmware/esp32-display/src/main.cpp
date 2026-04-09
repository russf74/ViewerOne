/**
 * ViewerOne — ESP32-2432S028R ILI9341 (CYD), landscape 320×240 via ROTATION in board_pins.h
 *
 * PC @ 115200: {"t":"Title","c":"Chords","l":true}
 * Chords: capital letter N in "c" starts a new line (N is not drawn).
 *
 * Display: LovyanGFX (same SPI wiring as firmware/display-pinout-scan profiles 1–2).
 * TFT_eSPI was dropped — its User_Setup path did not match this hardware reliably.
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include <cstdio>
#include <driver/spi_common.h>
#include <LovyanGFX.hpp>

#include "board_pins.h"

/** Keep in sync with repository root `package.json` version. */
static constexpr const char *VIEWERONE_FW_VERSION = "0.4.1";

// RGB565 (same as TFT_eSPI defaults)
static constexpr uint16_t C_BLACK = 0x0000;
static constexpr uint16_t C_WHITE = 0xFFFF;
static constexpr uint16_t C_CYAN = 0x07FF;
static constexpr uint16_t C_YELLOW = 0xFFE0;
static constexpr uint16_t C_GREY = 0x7BEF;

/** ILI9341 + SPI — profile matching pinout-scan id 2 (HSPI, 40 MHz) or id 1 (20 MHz slow env). */
class PanelGfx : public lgfx::LGFX_Device {
  lgfx::Bus_SPI _bus{};
  lgfx::Panel_ILI9341 _panel{};

public:
  PanelGfx() {
    {
      auto cfg = _bus.config();
      cfg.spi_host = HSPI_HOST;
      cfg.spi_mode = 0;
#if defined(VIEWERONE_TFT_SLOW_SPI)
      cfg.freq_write = 20000000;
#else
      cfg.freq_write = 40000000;
#endif
      cfg.freq_read = 16000000;
      cfg.spi_3wire = true;
      cfg.use_lock = true;
      cfg.dma_channel = SPI_DMA_CH_AUTO;
      cfg.pin_sclk = PIN_TFT_SCLK;
      cfg.pin_mosi = PIN_TFT_MOSI;
      cfg.pin_miso = PIN_TFT_MISO;
      cfg.pin_dc = PIN_TFT_DC;
      _bus.config(cfg);
      _panel.setBus(&_bus);
    }
    {
      auto cfg = _panel.config();
      cfg.pin_cs = PIN_TFT_CS;
      cfg.pin_rst = -1;
      cfg.pin_busy = -1;
      cfg.panel_width = 240;
      cfg.panel_height = 320;
      cfg.memory_width = 240;
      cfg.memory_height = 320;
#if defined(VIEWERONE_TFT_INVERSION)
      cfg.invert = true;
#else
      cfg.invert = false;
#endif
      cfg.rgb_order = false;
      cfg.readable = true;
      cfg.bus_shared = true;
      _panel.config(cfg);
    }
    setPanel(&_panel);
  }
};

static String lineBuf;
static PanelGfx tft;

/** Word-wrap (GLCD font); converts newlines to spaces. Optional maxLines (0 = no limit). */
static int32_t drawTextBlock(const char *text, int32_t x, int32_t y, int32_t maxW, int32_t maxY, uint16_t color,
                             uint8_t textSize, int32_t maxLines = 0) {
  if (!text || !*text) return y;
  tft.setTextSize(textSize);
  tft.setTextColor(color, C_BLACK);
  const int32_t cw = 6 * textSize;
  const int32_t lineH = 8 * textSize + 2;
  String rem = String(text);
  rem.replace('\n', ' ');
  rem.trim();
  int32_t cy = y;
  int32_t mc = (maxW - 4) / cw;
  if (mc < 4) mc = 4;
  const int32_t maxChars = mc;
  int32_t lines = 0;

  while (rem.length() > 0 && cy < maxY - lineH) {
    if (maxLines > 0 && lines >= maxLines) {
      break;
    }
    int cut = rem.length();
    if (cut > maxChars) {
      int sp = rem.lastIndexOf(' ', maxChars);
      cut = (sp > 2) ? sp : maxChars;
    }
    String line = rem.substring(0, cut);
    rem = rem.substring(cut);
    rem.trim();
    tft.setCursor(x, cy);
    tft.print(line);
    cy += lineH;
    lines++;
  }
  return cy;
}

/**
 * Chord string: ASCII 'N' splits logical lines; the marker is never sent to the printer.
 * C-string scan avoids String::indexOf edge cases that could leave 'N' visible on some builds.
 */
static int32_t drawChordLines(const char *chords, int32_t x, int32_t y, int32_t maxW, int32_t maxY, uint16_t color,
                              uint8_t textSize) {
  if (!chords || !*chords) return y;
  int32_t cy = y;
  const char *p = chords;
  const int32_t minRoom = 8 * textSize + 2;
  while (cy < maxY - minRoom) {
    const char *q = p;
    while (*q && *q != 'N') ++q;
    String part;
    for (const char *t = p; t < q; ++t) part += *t;
    part.trim();
    if (part.length() > 0) {
      cy = drawTextBlock(part.c_str(), x, cy, maxW, maxY, color, textSize, 0);
    }
    if (!*q) break;
    p = q + 1;
  }
  return cy;
}

static void drawSong(const char *title, const char *chords, bool live) {
  const int32_t W = tft.width();
  const int32_t H = tft.height();
  const int32_t mid = H / 2;
  const uint16_t titleColor = C_WHITE;
  const uint16_t chordColor = live ? C_CYAN : C_YELLOW;
  constexpr uint8_t kTitleSize = 5;
  constexpr uint8_t kChordSize = 5;
  constexpr int32_t kPad = 6;

  tft.fillScreen(C_BLACK);

  /* Big font; wraps to extra lines as needed within top/bottom halves (no fixed line cap). */
  drawTextBlock(title, kPad, kPad, W - 2 * kPad, mid - kPad, titleColor, kTitleSize, 0);
  drawChordLines(chords, kPad, mid + kPad / 2, W - 2 * kPad, H - kPad, chordColor, kChordSize);

  Serial.printf("[ViewerOne] draw ok live=%d\n", live ? 1 : 0);
}

void setup() {
  Serial.begin(115200);
  lineBuf.reserve(512);

  pinMode(PIN_TFT_BL, OUTPUT);
  digitalWrite(PIN_TFT_BL, HIGH);

  if (!tft.init()) {
    Serial.println("ViewerOne: LovyanGFX init failed");
    return;
  }
  tft.setRotation(ROTATION);
  tft.fillScreen(C_BLACK);

  const int32_t H = tft.height();
  tft.setTextSize(3);
  tft.setTextColor(C_YELLOW, C_BLACK);
  tft.setCursor(4, H / 2 - 44);
  tft.println("Waiting");
  tft.setCursor(4, H / 2 - 14);
  tft.println("for signal");
  tft.setTextSize(1);
  tft.setTextColor(C_GREY, C_BLACK);
  tft.setCursor(4, H - 20);
  {
    char line[40];
    snprintf(line, sizeof(line), "ViewerOne %s 115200", VIEWERONE_FW_VERSION);
    tft.println(line);
  }

  Serial.printf("ViewerOne ILI9341 v%s ready @ 115200 (LovyanGFX)\n", VIEWERONE_FW_VERSION);
}

void loop() {
  while (Serial.available()) {
    char ch = static_cast<char>(Serial.read());
    if (ch == '\r') continue;
    if (ch == '\n') {
      if (lineBuf.length() == 0) continue;
      JsonDocument doc;
      DeserializationError err = deserializeJson(doc, lineBuf);
      lineBuf = "";
      if (err) {
        Serial.printf("JSON err: %s\n", err.c_str());
        continue;
      }
      const char *t = doc["t"] | "";
      const char *c = doc["c"] | "";
      bool l = doc["l"] | true;
      drawSong(t, c, l);
    } else if (lineBuf.length() < 480) {
      lineBuf += ch;
    }
  }
}
