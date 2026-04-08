/**
 * Standalone TFT pinout probe — NOT part of ViewerOne serial protocol.
 * Cycles ILI9341 SPI profiles (LovyanGFX), 2 s each, big profile number on screen.
 * Open serial @ 115200 to read which option is active.
 */

#include <Arduino.h>
#include <cstdio>
#include <cstring>
#include <driver/spi_common.h>
#include <LovyanGFX.hpp>

static constexpr int8_t kBlPin = 21;

struct PinProfile {
  uint8_t id;
  const char *tag;
  spi_host_device_t host;
  int16_t mosi;
  int16_t sclk;
  int16_t miso;
  int16_t cs;
  int16_t dc;
  int16_t rst;
  uint32_t freq_write;
  bool invert;
  bool rgb_order;
  /** Most CYD boards: HIGH = backlight on. Some modules invert the transistor. */
  bool bl_active_high;
};

// id 1..N — note which number first shows pixels on your panel
static const PinProfile kProfiles[] = {
    // Cheap Yellow Display / ESP32-2432S028R style (GPIO 12 = MISO, not RST)
    {1, "CYD HSPI 20M rst-1", HSPI_HOST, 13, 14, 12, 15, 2, -1, 20000000, false, false, true},
    {2, "CYD HSPI 40M rst-1", HSPI_HOST, 13, 14, 12, 15, 2, -1, 40000000, false, false, true},
    {3, "CYD VSPI 20M rst-1", VSPI_HOST, 13, 14, 12, 15, 2, -1, 20000000, false, false, true},
    {4, "CYD HSPI noMISO", HSPI_HOST, 13, 14, -1, 15, 2, -1, 20000000, false, false, true},
    {5, "CYD HSPI rst=4", HSPI_HOST, 13, 14, 12, 15, 2, 4, 20000000, false, false, true},
    {6, "VSPI 23/18/19", VSPI_HOST, 23, 18, 19, 15, 2, 4, 40000000, false, false, true},
    {7, "VSPI 23/18 noMISO", VSPI_HOST, 23, 18, -1, 15, 2, -1, 20000000, false, false, true},
    {8, "CYD HSPI inv=true", HSPI_HOST, 13, 14, 12, 15, 2, -1, 20000000, true, false, true},
    {9, "CYD HSPI rgb=1", HSPI_HOST, 13, 14, 12, 15, 2, -1, 20000000, false, true, true},
    {10, "CYD HSPI 10M", HSPI_HOST, 13, 14, 12, 15, 2, -1, 10000000, false, false, true},
    {11, "CYD HSPI rst=12", HSPI_HOST, 13, 14, 12, 15, 2, 12, 20000000, false, false, true},
    {12, "CS@5 HSPI", HSPI_HOST, 13, 14, 12, 5, 2, -1, 20000000, false, false, true},
    {13, "CYD BL pin LOW=on", HSPI_HOST, 13, 14, 12, 15, 2, -1, 20000000, false, false, false},
};

static constexpr size_t kProfileCount = sizeof(kProfiles) / sizeof(kProfiles[0]);

class Prober : public lgfx::LGFX_Device {
  lgfx::Bus_SPI _bus{};
  lgfx::Panel_ILI9341 _panel{};

public:
  explicit Prober(const PinProfile &p) {
    {
      auto cfg = _bus.config();
      cfg.spi_host = p.host;
      cfg.spi_mode = 0;
      cfg.freq_write = p.freq_write;
      cfg.freq_read = 8000000;
      cfg.spi_3wire = true;
      cfg.use_lock = true;
      cfg.dma_channel = SPI_DMA_CH_AUTO;
      cfg.pin_sclk = p.sclk;
      cfg.pin_mosi = p.mosi;
      cfg.pin_miso = p.miso;
      cfg.pin_dc = p.dc;
      _bus.config(cfg);
      _panel.setBus(&_bus);
    }
    {
      auto cfg = _panel.config();
      cfg.pin_cs = p.cs;
      cfg.pin_rst = p.rst;
      cfg.pin_busy = -1;
      cfg.panel_width = 240;
      cfg.panel_height = 320;
      cfg.memory_width = 240;
      cfg.memory_height = 320;
      cfg.invert = p.invert;
      cfg.rgb_order = p.rgb_order;
      cfg.readable = true;
      cfg.bus_shared = true;
      _panel.config(cfg);
    }
    setPanel(&_panel);
  }
};

static Prober *g_disp = nullptr;
static uint8_t g_idx = 0;
static uint32_t g_hide_after_ms = 0;

static void backlightFor(const PinProfile &p) {
  pinMode(kBlPin, OUTPUT);
  digitalWrite(kBlPin, p.bl_active_high ? HIGH : LOW);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("TFT pinout scan — ILI9341 (LovyanGFX)");
  Serial.printf("Testing %u profiles, 2 s each. Note the FIRST id that shows graphics.\n", (unsigned)kProfileCount);
  backlightFor(kProfiles[0]);
}

void loop() {
  const uint32_t now = millis();

  if (g_disp != nullptr) {
    if (now < g_hide_after_ms) {
      return;
    }
    delete g_disp;
    g_disp = nullptr;
    g_idx = static_cast<uint8_t>((g_idx + 1U) % kProfileCount);
  }

  const PinProfile &p = kProfiles[g_idx];
  Serial.printf("--- Profile id=%u: %s ---\n", p.id, p.tag);
  backlightFor(p);

  g_disp = new Prober(p);
  if (!g_disp->init()) {
    Serial.println("init() failed (SPI or panel)");
    delete g_disp;
    g_disp = nullptr;
    g_idx = static_cast<uint8_t>((g_idx + 1U) % kProfileCount);
    g_hide_after_ms = now + 300;
    return;
  }

  g_disp->setRotation(0);
  const uint16_t bg = (p.id & 1U) ? 0xF800U : 0x07E0U;
  g_disp->fillScreen(bg);
  g_disp->setTextSize(7);
  g_disp->setTextDatum(lgfx::textdatum_t::middle_center);
  g_disp->setTextColor(0xFFFFU);
  g_disp->drawNumber(p.id, g_disp->width() / 2, g_disp->height() / 2 - 20);
  g_disp->setTextSize(1);
  g_disp->setTextColor(0xFFFFU);
  char subtitle[36];
  snprintf(subtitle, sizeof(subtitle), "%u %s", p.id, p.tag);
  if (strlen(subtitle) > 30) {
    subtitle[27] = '.';
    subtitle[28] = '.';
    subtitle[29] = '.';
    subtitle[30] = '\0';
  }
  g_disp->drawString(subtitle, 2, g_disp->height() - 28);
  g_disp->setTextDatum(lgfx::textdatum_t::top_left);

  g_hide_after_ms = now + 2000U;
}
