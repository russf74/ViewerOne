/**
 * ViewerOne — ESP32-2432S028R ILI9341 (CYD), landscape 320×240 via ROTATION in board_pins.h
 *
 * PC @ 115200: {"t":"Title","c":"1999","l":true,"m":false}
 *   c = release year (4-digit). m = FX mute: bright red text on black; unmuted = white text on black.
 *   l is accepted for compatibility (display colour does not depend on live).
 * To PC (touch): {"evt":"mute_toggle"} — tap anywhere to toggle (handled by ViewerOne).
 * To PC (boot): {"evt":"boot"} — sent once on startup so ViewerOne immediately re-sends the
 *   current song/mute state after any reset (manual power cycle or watchdog auto-recovery).
 *
 * Display: LovyanGFX (same SPI wiring as firmware/display-pinout-scan profiles 1–2).
 *
 * Auto-recovery: a task watchdog reboots the board if the main loop ever stalls (e.g. a wedged
 * touch/SPI read) for longer than WDT_TIMEOUT_S, so a hang mid-gig clears itself without needing
 * a manual unplug/replug. The boot handshake above then restores the display within ~1s.
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include <cstdio>
#include <driver/spi_common.h>
#include <esp_task_wdt.h>
#include <LovyanGFX.hpp>

#include "board_pins.h"

/** Keep in sync with repository root `package.json` version. */
static constexpr const char *VIEWERONE_FW_VERSION = "5.0.2";

/** Seconds the main loop may go without feeding the watchdog before it force-reboots the board. */
static constexpr uint32_t WDT_TIMEOUT_S = 5;

// RGB565
static constexpr uint16_t C_BLACK = 0x0000;
static constexpr uint16_t C_WHITE = 0xFFFF;
static constexpr uint16_t C_YELLOW = 0xFFE0;
static constexpr uint16_t C_GREY = 0x7BEF;
/** Muted text: full-brightness red (RGB565 0xF800) on black background */
static constexpr uint16_t C_RED = 0xF800;

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

#if !defined(VIEWERONE_NO_TOUCH)
static bool s_touch_raw_down = false;    // raw tft.getTouch() reading, unfiltered
static uint32_t s_touch_raw_since_ms = 0; // when the raw reading last changed state
static bool s_touch_down = false;        // confirmed (debounced) touch-down in progress
static uint32_t s_touch_down_ms = 0;      // when the confirmed touch-down started
static uint32_t s_last_toggle_ms = 0;

/**
 * A raw touch reading must hold steady for this long before it's trusted as a real press-down,
 * rejecting brief electrical/contact noise glitches at the source rather than after the fact.
 */
static constexpr uint32_t TOUCH_CONFIRM_MS = 20;

/**
 * Minimum time between two mute_toggle events. Capacitive/resistive touch controllers on these
 * cheap panels can chatter — a single finger press was observed in the field producing over a
 * dozen rapid, independently valid-looking press/release cycles within a few seconds (each
 * passing the normal 30-1200ms tap filter below, spaced ~250-900ms apart — i.e. full press/release
 * cycles, not sub-debounce noise), which without this cooldown fires that many contradictory mute
 * toggles instead of one. IMPORTANT: keep this short — an earlier 500ms value was long enough
 * that a user's own quick legitimate re-tap (e.g. re-tapping because they didn't see instant
 * visual feedback) got silently swallowed, making single taps feel unreliable. 200ms is still
 * long enough to knock out the tightest part of an observed chatter burst without being
 * perceptible as "unresponsive" for normal deliberate tapping.
 */
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
  const uint16_t bg = C_BLACK;
  const uint16_t textColor = muted ? C_RED : C_WHITE;
  constexpr uint8_t kTitleSize = 5;
  constexpr uint8_t kYearSize = 7;
  constexpr int32_t kPad = 6;

  tft.fillScreen(bg);

  drawTextBlock(title, kPad, kPad, W - 2 * kPad, mid - kPad, textColor, kTitleSize, bg, 0);
  drawTextBlock(year, kPad, mid + kPad / 2, W - 2 * kPad, H - kPad, textColor, kYearSize, bg, 0);
}

#if !defined(VIEWERONE_NO_TOUCH)
static void pollTouchMuteToggle() {
  int32_t tx = 0;
  int32_t ty = 0;
  bool raw = tft.getTouch(&tx, &ty);
  uint32_t now = millis();

  // Stage 1: edge-detect the raw reading and require it to hold steady for TOUCH_CONFIRM_MS
  // before trusting it, so a brief electrical blip can't even start a touch-down. This does NOT
  // delay recognizing a genuine tap in practice — a real fingertip press easily holds past 20ms.
  if (raw != s_touch_raw_down) {
    s_touch_raw_down = raw;
    s_touch_raw_since_ms = now;
  }
  bool confirmedRaw = s_touch_raw_down && (now - s_touch_raw_since_ms) >= TOUCH_CONFIRM_MS;

  if (confirmedRaw) {
    if (!s_touch_down) {
      s_touch_down = true;
      s_touch_down_ms = s_touch_raw_since_ms; // true physical contact start, not the confirm instant
    }
  } else if (s_touch_down && !s_touch_raw_down) {
    // Confirmed touch has now genuinely released (raw signal is low, not just mid-confirm).
    uint32_t dur = now - s_touch_down_ms;
    if (dur >= 30 && dur < 1200 && (now - s_last_toggle_ms) >= TOUCH_TOGGLE_COOLDOWN_MS) {
      s_last_toggle_ms = now;
      Serial.println("{\"evt\":\"mute_toggle\"}");
    }
    s_touch_down = false;
  }
}
#endif

void setup() {
  Serial.begin(115200);
  lineBuf.reserve(512);

  // Arm the watchdog before anything that could conceivably hang (panel/touch init included),
  // so a wedged board reboots itself instead of freezing silently for the rest of a gig.
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

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
    char line[48];
    snprintf(line, sizeof(line), "ViewerOne %s 115200", VIEWERONE_FW_VERSION);
    tft.println(line);
  }

  Serial.printf("ViewerOne ILI9341 v%s ready @ 115200 (LovyanGFX", VIEWERONE_FW_VERSION);
#if defined(VIEWERONE_NO_TOUCH)
  Serial.printf(", touch off)\n");
#else
  Serial.printf(", touch on)\n");
#endif

  // Ask ViewerOne to resend the current song/mute state — restores the screen after any reset.
  Serial.println("{\"evt\":\"boot\"}");
}

void loop() {
  esp_task_wdt_reset();

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
      bool m = doc["m"] | false;
      drawSong(t, c, l, m);
    } else if (lineBuf.length() < 480) {
      lineBuf += ch;
    }
  }

#if !defined(VIEWERONE_NO_TOUCH)
  pollTouchMuteToggle();
#endif
}
