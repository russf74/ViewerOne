/**
 * ViewerOne — ESP32-2432S028R ILI9341 (CYD), landscape 320×240 via ROTATION in board_pins.h
 *
 * PC @ 115200 — display (transport / song change only — not every second):
 *   {"t":"Title","c":"1999","d":"04:32","n":"01/24","x":"Next Title","r":272,"p":true,"l":true,"m":false}
 *   c = release year. d = full/remaining duration. n = setlist position. m = FX mute colours.
 *   x = next setlist row title — single clipped line above meta; song-change only.
 *   r = remaining seconds, p = playing — firmware ticks MM:SS locally while p=true.
 *
 * PC @ 115200 — LED strip (WS2812B on GPIO 27 / CN1):
 *   {"led":"pattern","id":0}          id 0–9 or "name":"fire"
 *   {"led":"brightness","v":96}       0–255
 *   {"led":"off"}
 *   {"led":"status"}
 * Replies: {"evt":"led", ...} — ViewerOne desktop ignores unknown evt (only mute_toggle/boot).
 *
 * To PC (touch): {"evt":"mute_toggle"}
 * To PC (boot/identity):
 *   {"evt":"boot","device":"cyd","model":"ESP32-2432S028R","w":320,"h":240,...}
 * PC may request it again with {"cmd":"hello"}.
 *
 * Auto-recovery: task WDT reboots if the main loop stalls > WDT_TIMEOUT_S.
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include <FastLED.h>
#include <cstdio>
#include <cstring>
#include <driver/spi_common.h>
#include <esp_idf_version.h>
#include <esp_task_wdt.h>
#include <LovyanGFX.hpp>

#include "board_pins.h"
#include "led_config.h"
#include "patterns.h"

/** Keep in sync with repository root `package.json` version when releasing the app. */
static constexpr const char *VIEWERONE_FW_VERSION = "5.12.14";

/** Seconds the main loop may go without feeding the watchdog before it force-reboots the board. */
static constexpr uint32_t WDT_TIMEOUT_S = 5;

// RGB565
static constexpr uint16_t C_BLACK = 0x0000;
static constexpr uint16_t C_WHITE = 0xFFFF;
static constexpr uint16_t C_YELLOW = 0xFFE0;
static constexpr uint16_t C_GREY = 0x7BEF;
static constexpr uint16_t C_LIME = 0x37E0;
static constexpr uint16_t C_CYAN = 0x073F;  // #00E5FF — now-playing title
static constexpr uint16_t C_NAVY = 0x0011;

static CRGB leds[NUM_LEDS];

/** Cached song fields so LED pattern changes can refresh the footer without a new PC payload. */
static char s_title[160] = "Waiting";
static char s_year[24] = "";
static char s_duration[16] = "";
static char s_position[16] = "";
static char s_next[160] = "";
static bool s_muted = false;
static bool s_showing_waiting = true;

/** Device-side countdown — host arms via r/p; firmware ticks without per-second USB. */
static int32_t s_cd_remain_sec = -1;
static bool s_cd_running = false;
static uint32_t s_cd_anchor_ms = 0;
static int32_t s_cd_anchor_sec = 0;
static int32_t s_cd_last_shown = -1;

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
  // Always size 2 (≈12px/char); truncate if wider than the footer — never fall back to size 1.
  const uint8_t textSize = 2;
  const int32_t cw = 6 * textSize;
  const int32_t maxChars = cw > 0 ? (W - 8) / cw : 0;
  if (maxChars > 0 && (int32_t)strlen(label) > maxChars) {
    label[maxChars] = '\0';
  }
  tft.fillRect(0, H - PATTERN_FOOTER_H, W, PATTERN_FOOTER_H, bg);
  tft.setTextSize(textSize);
  tft.setTextColor(textColor, bg);
  tft.setCursor(4, H - 15);
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

static void formatMmSs(int32_t sec, char *buf, size_t n) {
  if (sec < 0) sec = 0;
  snprintf(buf, n, "%02d:%02d", (int)(sec / 60), (int)(sec % 60));
}

static void stopLocalCountdown() {
  s_cd_running = false;
  s_cd_remain_sec = -1;
  s_cd_last_shown = -1;
}

static void armLocalCountdown(int32_t remain_sec, bool running) {
  if (remain_sec < 0) remain_sec = 0;
  s_cd_remain_sec = remain_sec;
  s_cd_anchor_sec = remain_sec;
  s_cd_anchor_ms = millis();
  s_cd_last_shown = remain_sec;
  s_cd_running = running && remain_sec > 0;
  formatMmSs(remain_sec, s_duration, sizeof(s_duration));
}

/**
 * Three fixed meta slots — year left, MM:SS center-ish, position right.
 * Never concatenate into one reflowing string (content length must not shove neighbors).
 */
static void drawMetaSlots(int32_t metaY, uint16_t textColor, uint16_t bg) {
  const int32_t W = tft.width();
  constexpr int32_t kPad = 6;
  const bool multi = s_duration[0] || s_position[0];
  const uint8_t metaSize = multi ? 3 : 7;
  const int32_t cw = 6 * metaSize;
  const int32_t yearX = kPad;
  // Fixed columns independent of string length.
  const int32_t durX = W / 2 - (5 * cw) / 2;          // "MM:SS" centered
  const int32_t posX = W - kPad - 6 * cw;             // "01/24" / "IN/24" right slot

  tft.setTextSize(metaSize);
  tft.setTextColor(textColor, bg);
  if (s_year[0]) {
    tft.setCursor(yearX, metaY);
    tft.print(s_year);
  }
  if (s_duration[0]) {
    tft.setCursor(durX, metaY);
    tft.print(s_duration);
  }
  if (s_position[0]) {
    tft.setCursor(posX < kPad ? kPad : posX, metaY);
    tft.print(s_position);
  }
}

/** Redraw only the year/duration band — avoids full fillScreen hitching LEDs. */
static void redrawMetaLineOnly() {
  if (s_showing_waiting) return;
  const int32_t W = tft.width();
  const int32_t H = tft.height();
  const uint16_t bg = s_muted ? C_NAVY : C_BLACK;
  const uint16_t textColor = s_muted ? C_YELLOW : C_LIME;
  constexpr int32_t kPad = 6;
  const bool multi = s_duration[0] || s_position[0];
  const uint8_t metaSize = multi ? 3 : 7;
  const int32_t metaLineH = 8 * metaSize + 2;
  const int32_t metaBottom = H - kPad - PATTERN_FOOTER_H;
  const int32_t metaY = metaBottom - metaLineH;
  tft.fillRect(0, metaY, W, metaBottom - metaY, bg);
  drawMetaSlots(metaY, textColor, bg);
}

static void tickLocalCountdown() {
  if (!s_cd_running || s_cd_remain_sec < 0) return;
  const uint32_t elapsed_ms = millis() - s_cd_anchor_ms;
  int32_t shown = s_cd_anchor_sec - (int32_t)(elapsed_ms / 1000U);
  if (shown < 0) shown = 0;
  if (shown == s_cd_last_shown) return;
  s_cd_last_shown = shown;
  s_cd_remain_sec = shown;
  formatMmSs(shown, s_duration, sizeof(s_duration));
  redrawMetaLineOnly();
  if (shown == 0) s_cd_running = false;
}

static void drawSong(const char *title, const char *year, const char *duration, const char *position,
                     const char *next, bool /*live*/, bool muted) {
  const int32_t W = tft.width();
  const int32_t H = tft.height();
  const int32_t mid = H / 2;
  const uint16_t bg = muted ? C_NAVY : C_BLACK;
  const uint16_t textColor = muted ? C_YELLOW : C_LIME;
  constexpr uint8_t kTitleSize = 5;
  constexpr uint8_t kNextSize = 2;  // slightly smaller than meta size 3
  constexpr int32_t kPad = 6;

  if (title != s_title) {
    strncpy(s_title, title && title[0] ? title : "—", sizeof(s_title) - 1);
    s_title[sizeof(s_title) - 1] = '\0';
  }
  if (year != s_year) {
    strncpy(s_year, year ? year : "", sizeof(s_year) - 1);
    s_year[sizeof(s_year) - 1] = '\0';
  }
  if (duration != s_duration) {
    strncpy(s_duration, duration ? duration : "", sizeof(s_duration) - 1);
    s_duration[sizeof(s_duration) - 1] = '\0';
  }
  if (position != s_position) {
    strncpy(s_position, position ? position : "", sizeof(s_position) - 1);
    s_position[sizeof(s_position) - 1] = '\0';
  }
  if (next != s_next) {
    strncpy(s_next, next ? next : "", sizeof(s_next) - 1);
    s_next[sizeof(s_next) - 1] = '\0';
  }
  s_muted = muted;
  s_showing_waiting = false;

  tft.fillScreen(bg);

  // Pin year/duration/position to fixed slots at the bottom (above pattern footer),
  // independent of how many lines the title wraps to.
  const bool multi = s_duration[0] || s_position[0];
  const uint8_t metaSize = multi ? 3 : 7;
  const int32_t metaLineH = 8 * metaSize + 2;
  const int32_t nextLineH = 8 * kNextSize + 2;
  const int32_t metaBottom = H - kPad - PATTERN_FOOTER_H;
  const int32_t metaY = metaBottom - metaLineH;
  // Next song sits just above meta (static); title must not draw into that band.
  const int32_t nextY = metaY - nextLineH - 2;
  const int32_t titleMaxY = (s_next[0] ? nextY : metaY) - kPad;
  drawTextBlock(s_title, kPad, kPad, W - 2 * kPad, titleMaxY > kPad ? titleMaxY : mid - kPad, C_CYAN,
                kTitleSize, bg, 0);
  if (s_next[0]) {
    // Single line, hard clip (maxLines=1) — no wrap. Prefix matches CrowPanel / PC preview.
    char nextBuf[176];
    snprintf(nextBuf, sizeof(nextBuf), "Next : %s", s_next);
    drawTextBlock(nextBuf, kPad, nextY, W - 2 * kPad, nextY + nextLineH + 1, textColor, kNextSize, bg, 1);
  }
  drawMetaSlots(metaY, textColor, bg);
  drawPatternFooter(bg, textColor);
}

static void drawWaitingScreen() {
  stopLocalCountdown();
  const int32_t H = tft.height();
  const uint16_t bg = C_BLACK;
  s_showing_waiting = true;
  s_muted = false;
  strncpy(s_title, "Waiting", sizeof(s_title) - 1);
  s_year[0] = '\0';
  s_duration[0] = '\0';
  s_position[0] = '\0';
  s_next[0] = '\0';

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
    drawSong(s_title, s_year, s_duration, s_position, s_next, true, s_muted);
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
      if (strcasecmp(n, "blackout") == 0) return PATTERN_BLACKOUT;
      if (strcasecmp(n, "off") == 0 || strcasecmp(n, "stop") == 0) return PATTERN_OFF;
    }
  }
  if (!idField.isNull()) {
    int n = idField.as<int>();
    if (n >= 0 && n < PATTERN_COUNT) return (PatternId)n;
    if (n == (int)PATTERN_BLACKOUT) return PATTERN_BLACKOUT;
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

static void sendDeviceIdentity(const char *evt) {
  Serial.printf(
      "{\"evt\":\"%s\",\"device\":\"cyd\",\"model\":\"ESP32-2432S028R\",\"w\":320,\"h\":240,"
      "\"fw\":\"%s\",\"led_id\":%u,\"led\":\"%s\"}\n",
      evt, VIEWERONE_FW_VERSION, (unsigned)patternsCurrent(), patternName(patternsCurrent()));
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

  const char *cmd = doc["cmd"] | "";
  if (strcasecmp(cmd, "hello") == 0) {
    sendDeviceIdentity("hello");
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
  const char *d = doc["d"] | "";
  const char *n = doc["n"] | "";
  const char *x = doc["x"] | "";
  bool l = doc["l"] | true;
  bool m = doc["m"] | false;
  const bool has_r = !doc["r"].isNull();
  const char *duration_for_ui = d;
  if (has_r) {
    armLocalCountdown(doc["r"].as<int32_t>(), doc["p"] | false);
    duration_for_ui = s_duration;
  } else {
    stopLocalCountdown();
  }
  drawSong(t, c, duration_for_ui, n, x, l, m);
}

void setup() {
  Serial.begin(115200);
  lineBuf.reserve(512);

#if ESP_IDF_VERSION_MAJOR >= 5
  const esp_task_wdt_config_t wdtConfig = {
      .timeout_ms = WDT_TIMEOUT_S * 1000,
      .idle_core_mask = (1U << portNUM_PROCESSORS) - 1U,
      .trigger_panic = true,
  };
  esp_task_wdt_init(&wdtConfig);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
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

  sendDeviceIdentity("boot");
}

void loop() {
  esp_task_wdt_reset();

  // LED refresh first so serial/TFT work never starves WS2812 timing.
  patternsTick();
  if (patternsConsumeFooterDirty()) {
    refreshDisplayForPatternChange();
  }

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

  tickLocalCountdown();
}
