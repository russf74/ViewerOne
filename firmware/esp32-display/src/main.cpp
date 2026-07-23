/**
 * ViewerOne — ESP32-2432S028R ILI9341 (CYD), landscape 320×240 via ROTATION in board_pins.h
 *
 * PC @ 115200 — display (unchanged):
 *   {"t":"Title","c":"1999","l":true,"m":false}
 *   c = release year. m = FX mute colours. l accepted for compatibility.
 *
 * PC @ 115200 — LED strip (WS2812B on GPIO 27 / CN1):
 *   {"led":"pattern","id":0}          id 0–9 or "name":"fire"
 *   {"led":"brightness","v":96}       0–255
 *   {"led":"off"}
 *   {"led":"status"}
 * Replies: {"evt":"led", ...} — ViewerOne desktop ignores unknown evt (only mute_toggle/boot).
 *
 * To PC (touch): {"evt":"mute_toggle"}
 * To PC (boot):  {"evt":"boot"}
 *
 * Auto-recovery: task WDT reboots if the main loop stalls > WDT_TIMEOUT_S.
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include <FastLED.h>
#include <cstdio>
#include <cstring>
#include <driver/spi_common.h>
#include <esp_task_wdt.h>
#include <LovyanGFX.hpp>

#include "board_pins.h"
#include "led_config.h"
#include "patterns.h"

/** Keep in sync with repository root `package.json` version when releasing the app. */
static constexpr const char *VIEWERONE_FW_VERSION = "5.6.1";

/** Seconds the main loop may go without feeding the watchdog before it force-reboots the board. */
static constexpr uint32_t WDT_TIMEOUT_S = 5;

// RGB565
static constexpr uint16_t C_BLACK = 0x0000;
static constexpr uint16_t C_WHITE = 0xFFFF;
static constexpr uint16_t C_YELLOW = 0xFFE0;
static constexpr uint16_t C_GREY = 0x7BEF;
static constexpr uint16_t C_LIME = 0x37E0;
static constexpr uint16_t C_NAVY = 0x0011;

static CRGB leds[NUM_LEDS];

/** Cached song fields so LED pattern changes can refresh the footer without a new PC payload. */
static char s_title[160] = "Waiting";
static char s_year[24] = "";
static bool s_muted = false;
static bool s_showing_waiting = true;

static constexpr int32_t PATTERN_FOOTER_H = 18;

/** ILI9341 + SPI — profile matching pinout-scan id 2 (HSPI, 40 MHz) or id 1 (20 MHz slow env). */
class PanelGfx : public lgfx::LGFX_Device {
  lgfx::Bus_SPI _bus{};
  lgfx::Panel_ILI9341 _panel{};
  lgfx::Touch_XPT2046 _touch{};

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

#if !defined(VIEWERONE_NO_TOUCH)
    {
      auto touch_cfg = _touch.config();
      touch_cfg.spi_host = VSPI_HOST;
      touch_cfg.freq = 2500000;
      touch_cfg.pin_sclk = PIN_TOUCH_SCLK;
      touch_cfg.pin_mosi = PIN_TOUCH_MOSI;
      touch_cfg.pin_miso = PIN_TOUCH_MISO;
      touch_cfg.pin_cs = PIN_TOUCH_CS;
      touch_cfg.pin_int = PIN_TOUCH_IRQ;
      touch_cfg.bus_shared = false;
      touch_cfg.offset_rotation = ROTATION;
      touch_cfg.x_min = 300;
      touch_cfg.x_max = 3900;
      touch_cfg.y_min = 200;
      touch_cfg.y_max = 3900;
      _touch.config(touch_cfg);
    }
    _panel.setTouch(&_touch);
#endif
  }
};

static String lineBuf;
static PanelGfx tft;

static void drawPatternFooter(uint16_t bg, uint16_t textColor) {
  const int32_t W = tft.width();
  const int32_t H = tft.height();
  char label[48];
  patternLabelDisplay(patternsCurrent(), label, sizeof(label));
  // Size 2 ≈ 12px/char (~26 fit on 320); fall back to size 1 if longer.
  const size_t len = strlen(label);
  const uint8_t textSize = (len > 25) ? 1 : 2;
  tft.fillRect(0, H - PATTERN_FOOTER_H, W, PATTERN_FOOTER_H, bg);
  tft.setTextSize(textSize);
  tft.setTextColor(textColor, bg);
  tft.setCursor(4, textSize == 2 ? (H - 15) : (H - 12));
  tft.print(label);
}

#if !defined(VIEWERONE_NO_TOUCH)
static bool s_touch_raw_down = false;
static uint32_t s_touch_raw_since_ms = 0;
static bool s_touch_down = false;
static uint32_t s_touch_down_ms = 0;
static uint32_t s_last_toggle_ms = 0;

static constexpr uint32_t TOUCH_CONFIRM_MS = 20;
static constexpr uint32_t TOUCH_TOGGLE_COOLDOWN_MS = 200;
#endif

/** Word-wrap (GLCD font); converts newlines to spaces. Optional maxLines (0 = no limit). */
static int32_t drawTextBlock(const char *text, int32_t x, int32_t y, int32_t maxW, int32_t maxY, uint16_t color,
                             uint8_t textSize, uint16_t bg, int32_t maxLines = 0) {
  if (!text || !*text) return y;
  tft.setTextSize(textSize);
  tft.setTextColor(color, bg);
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

static void drawSong(const char *title, const char *year, bool /*live*/, bool muted) {
  const int32_t W = tft.width();
  const int32_t H = tft.height();
  const int32_t mid = H / 2;
  const uint16_t bg = muted ? C_NAVY : C_BLACK;
  const uint16_t textColor = muted ? C_YELLOW : C_LIME;
  constexpr uint8_t kTitleSize = 5;
  constexpr uint8_t kYearSize = 7;
  constexpr int32_t kPad = 6;

  strncpy(s_title, title && title[0] ? title : "—", sizeof(s_title) - 1);
  s_title[sizeof(s_title) - 1] = '\0';
  strncpy(s_year, year ? year : "", sizeof(s_year) - 1);
  s_year[sizeof(s_year) - 1] = '\0';
  s_muted = muted;
  s_showing_waiting = false;

  tft.fillScreen(bg);

  drawTextBlock(s_title, kPad, kPad, W - 2 * kPad, mid - kPad, textColor, kTitleSize, bg, 0);
  drawTextBlock(s_year, kPad, mid + kPad / 2, W - 2 * kPad, H - kPad - PATTERN_FOOTER_H, textColor, kYearSize,
                bg, 0);
  drawPatternFooter(bg, textColor);
}

static void drawWaitingScreen() {
  const int32_t H = tft.height();
  const uint16_t bg = C_BLACK;
  s_showing_waiting = true;
  s_muted = false;
  strncpy(s_title, "Waiting", sizeof(s_title) - 1);
  s_year[0] = '\0';

  tft.fillScreen(bg);
  tft.setTextSize(3);
  tft.setTextColor(C_YELLOW, bg);
  tft.setCursor(4, H / 2 - 44);
  tft.println("Waiting");
  tft.setCursor(4, H / 2 - 14);
  tft.println("for signal");
  tft.setTextSize(1);
  tft.setTextColor(C_GREY, bg);
  tft.setCursor(4, H - 20 - PATTERN_FOOTER_H);
  {
    char line[56];
    snprintf(line, sizeof(line), "ViewerOne %s +LED", VIEWERONE_FW_VERSION);
    tft.println(line);
  }
  drawPatternFooter(bg, C_GREY);
}

/** Redraw title/year (or idle) plus pattern footer after an LED pattern change. */
static void refreshDisplayForPatternChange() {
  if (s_showing_waiting) {
    drawWaitingScreen();
  } else {
    drawSong(s_title, s_year, true, s_muted);
  }
}

#if !defined(VIEWERONE_NO_TOUCH)
static void pollTouchMuteToggle() {
  int32_t tx = 0;
  int32_t ty = 0;
  bool raw = tft.getTouch(&tx, &ty);
  uint32_t now = millis();

  if (raw != s_touch_raw_down) {
    s_touch_raw_down = raw;
    s_touch_raw_since_ms = now;
  }
  bool confirmedRaw = s_touch_raw_down && (now - s_touch_raw_since_ms) >= TOUCH_CONFIRM_MS;

  if (confirmedRaw) {
    if (!s_touch_down) {
      s_touch_down = true;
      s_touch_down_ms = s_touch_raw_since_ms;
    }
  } else if (s_touch_down && !s_touch_raw_down) {
    uint32_t dur = now - s_touch_down_ms;
    if (dur >= 30 && dur < 1200 && (now - s_last_toggle_ms) >= TOUCH_TOGGLE_COOLDOWN_MS) {
      s_last_toggle_ms = now;
      Serial.println("{\"evt\":\"mute_toggle\"}");
    }
    s_touch_down = false;
  }
}
#endif

static PatternId parsePatternId(JsonVariantConst idField, JsonVariantConst nameField) {
  if (!nameField.isNull()) {
    const char *n = nameField.as<const char *>();
    if (n) {
      for (uint8_t i = 0; i < PATTERN_COUNT; i++) {
        if (strcasecmp(n, patternName((PatternId)i)) == 0) return (PatternId)i;
      }
      if (strcasecmp(n, "off") == 0 || strcasecmp(n, "stop") == 0) return PATTERN_OFF;
    }
  }
  if (!idField.isNull()) {
    int n = idField.as<int>();
    if (n >= 0 && n < PATTERN_COUNT) return (PatternId)n;
    if (n == 255) return PATTERN_OFF;
  }
  return (PatternId)254;  // invalid
}

static void replyLedOk(const char *detail) {
  Serial.printf("{\"evt\":\"led\",\"ok\":true,%s}\n", detail);
}

static void replyLedErr(const char *msg) {
  Serial.printf("{\"evt\":\"led\",\"ok\":false,\"err\":\"%s\"}\n", msg);
}

static void handleLedCommand(JsonDocument &doc) {
  const char *cmd = doc["led"] | "";
  if (!cmd[0]) {
    replyLedErr("missing_led_cmd");
    return;
  }

  if (strcasecmp(cmd, "pattern") == 0 || strcasecmp(cmd, "p") == 0) {
    PatternId id = parsePatternId(doc["id"], doc["name"]);
    if ((uint8_t)id == 254) {
      replyLedErr("unknown_pattern");
      return;
    }
    patternsSet(id);
    refreshDisplayForPatternChange();
    char detail[64];
    snprintf(detail, sizeof(detail), "\"cmd\":\"pattern\",\"id\":%u,\"name\":\"%s\"", (unsigned)id,
             patternName(id));
    replyLedOk(detail);
    return;
  }

  if (strcasecmp(cmd, "brightness") == 0 || strcasecmp(cmd, "bri") == 0) {
    if (doc["v"].isNull()) {
      replyLedErr("brightness_needs_v");
      return;
    }
    int v = doc["v"].as<int>();
    if (v < 0 || v > 255) {
      replyLedErr("brightness_0_255");
      return;
    }
    patternsSetBrightness((uint8_t)v);
    char detail[40];
    snprintf(detail, sizeof(detail), "\"cmd\":\"brightness\",\"v\":%d", v);
    replyLedOk(detail);
    return;
  }

  if (strcasecmp(cmd, "off") == 0 || strcasecmp(cmd, "stop") == 0) {
    patternsSet(PATTERN_OFF);
    refreshDisplayForPatternChange();
    replyLedOk("\"cmd\":\"off\",\"name\":\"off\"");
    return;
  }

  if (strcasecmp(cmd, "status") == 0) {
    char detail[96];
    snprintf(detail, sizeof(detail),
             "\"cmd\":\"status\",\"id\":%u,\"name\":\"%s\",\"brightness\":%u,\"leds\":%u,\"pin\":%d",
             (unsigned)patternsCurrent(), patternName(patternsCurrent()),
             (unsigned)FastLED.getBrightness(), (unsigned)NUM_LEDS, (int)PIN_LED_DATA);
    replyLedOk(detail);
    return;
  }

  replyLedErr("unknown_led_cmd");
}

static void handleSerialLine(const String &line) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, line);
  if (err) {
    // Non-JSON noise only — do not break display path with spam during MIDI storms.
    return;
  }

  // LED commands must not be treated as song payloads (would blank the TFT).
  if (!doc["led"].isNull()) {
    handleLedCommand(doc);
    return;
  }

  // Display payload: require title key so unrelated JSON cannot wipe the screen.
  if (doc["t"].isNull()) {
    return;
  }

  const char *t = doc["t"] | "";
  const char *c = doc["c"] | "";
  bool l = doc["l"] | true;
  bool m = doc["m"] | false;
  drawSong(t, c, l, m);
}

void setup() {
  Serial.begin(115200);
  lineBuf.reserve(512);

  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

  pinMode(PIN_TFT_BL, OUTPUT);
  digitalWrite(PIN_TFT_BL, HIGH);

  if (!tft.init()) {
    Serial.println("ViewerOne: LovyanGFX init failed");
    return;
  }
  tft.setRotation(ROTATION);

  FastLED.addLeds<WS2812B, PIN_LED_DATA, GRB>(leds, NUM_LEDS);
  FastLED.setBrightness(LED_BRIGHTNESS);
  FastLED.clear(true);
  patternsBegin(leds, NUM_LEDS);

  drawWaitingScreen();

  Serial.printf("ViewerOne ILI9341 v%s ready @ 115200 (LovyanGFX", VIEWERONE_FW_VERSION);
#if defined(VIEWERONE_NO_TOUCH)
  Serial.printf(", touch off");
#else
  Serial.printf(", touch on");
#endif
  Serial.printf(", LED GPIO%d x%u)\n", (int)PIN_LED_DATA, (unsigned)NUM_LEDS);

  Serial.printf("{\"evt\":\"boot\",\"led_id\":%u,\"led\":\"%s\"}\n", (unsigned)patternsCurrent(),
                patternName(patternsCurrent()));
}

void loop() {
  esp_task_wdt_reset();

  while (Serial.available()) {
    char ch = static_cast<char>(Serial.read());
    if (ch == '\r') continue;
    if (ch == '\n') {
      if (lineBuf.length() == 0) continue;
      handleSerialLine(lineBuf);
      lineBuf = "";
    } else if (lineBuf.length() < 480) {
      lineBuf += ch;
    }
  }

#if !defined(VIEWERONE_NO_TOUCH)
  pollTouchMuteToggle();
#endif

  patternsTick();
  if (patternsConsumeFooterDirty()) {
    refreshDisplayForPatternChange();
  }
}
