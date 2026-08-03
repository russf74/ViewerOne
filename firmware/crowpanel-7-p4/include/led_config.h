#pragma once

#include <stdint.h>

/**
 * Optional WS2812B on CrowPanel Advanced 7" (ESP32-P4).
 * Default pin is a free expansion GPIO candidate — verify against your wiring.
 * LED support is off unless built with -e crowpanel-7-p4-led.
 */
#ifndef PIN_LED_DATA
#define PIN_LED_DATA 20
#endif

#ifndef NUM_LEDS
#define NUM_LEDS 144
#endif

#ifndef LED_BRIGHTNESS
#define LED_BRIGHTNESS 96
#endif

enum PatternId : uint8_t {
  PATTERN_KNIGHT_RIDER = 0,
  PATTERN_AURORA = 1,
  PATTERN_DUAL_COMET = 2,
  PATTERN_OCEAN = 3,
  PATTERN_LAVA = 4,
  PATTERN_STARFIELD = 5,
  PATTERN_CYBER_RAIN = 6,
  PATTERN_RAINBOW_RIPPLE = 7,
  PATTERN_NEON_PULSE = 8,
  PATTERN_GALAXY = 9,
  PATTERN_STROBE_WAVE = 10,
  PATTERN_DISCO_BALL = 11,
  PATTERN_LASER_SWEEP = 12,
  PATTERN_BASS_PULSE = 13,
  PATTERN_CONFETTI_STORM = 14,
  PATTERN_HYPER_CHASE = 15,
  PATTERN_PRISM_SPIN = 16,
  PATTERN_SPARK_SHOWER = 17,
  PATTERN_COLOR_BOMB = 18,
  PATTERN_ROLLER_DERBY = 19,
  PATTERN_RANDOM = 20,
  PATTERN_COUNT = 21,
  PATTERN_BLACKOUT = 99,
  PATTERN_OFF = 255
};

#define DEFAULT_PATTERN PATTERN_KNIGHT_RIDER
