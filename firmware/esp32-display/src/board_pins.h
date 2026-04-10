/**
 * DIYmalls / CYD 2.8" 240×320 — ILI9341 over SPI (ESP32-2432S028R family).
 * GPIO 12 = TFT MISO; software reset only (RST = -1 in LovyanGFX panel config in main.cpp).
 */
#pragma once

static constexpr int8_t PIN_TFT_MOSI = 13;
static constexpr int8_t PIN_TFT_MISO = 12;
static constexpr int8_t PIN_TFT_SCLK = 14;
static constexpr int8_t PIN_TFT_CS = 15;
static constexpr int8_t PIN_TFT_DC = 2;
static constexpr int8_t PIN_TFT_BL = 21;

/** LovyanGFX setRotation(0–3). Landscape 320×240; 3 vs 1 = 180° flip if upside-down. */
static constexpr uint8_t ROTATION = 3;

/**
 * XPT2046 (ESP32-2432S028R “CYD”) — separate SPI from the ILI9341 bus.
 * See firmware README: add -D VIEWERONE_NO_TOUCH if your board differs.
 */
static constexpr int8_t PIN_TOUCH_SCLK = 25;
static constexpr int8_t PIN_TOUCH_MOSI = 32;
static constexpr int8_t PIN_TOUCH_MISO = 39;
static constexpr int8_t PIN_TOUCH_CS = 33;
static constexpr int8_t PIN_TOUCH_IRQ = 36;
