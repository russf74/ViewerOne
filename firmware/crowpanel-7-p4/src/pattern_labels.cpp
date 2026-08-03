/**
 * Pattern name/label helpers shared with CYD firmware semantics.
 * Full FastLED pattern engine lives in patterns.cpp (crowpanel-7-p4-led env only).
 */
#include "patterns.h"
#include <cstdio>
#include <cstring>

static const char *const kNames[PATTERN_COUNT] = {
    "knight_rider", "aurora",         "dual_comet",     "ocean",         "lava",
    "starfield",    "cyber_rain",     "rainbow_ripple", "neon_pulse",    "galaxy",
    "strobe_wave",  "disco_ball",     "laser_sweep",    "bass_pulse",    "confetti_storm",
    "hyper_chase",  "prism_spin",     "spark_shower",   "color_bomb",    "roller_derby",
    "random",
};

static const char *const kTitles[PATTERN_COUNT] = {
    "Knight Rider", "Aurora",         "Dual Comet",     "Ocean",         "Lava",
    "Starfield",    "Cyber Rain",     "Rainbow Ripple", "Neon Pulse",    "Galaxy",
    "Strobe Wave",  "Disco Ball",     "Laser Sweep",    "Bass Pulse",    "Confetti Storm",
    "Hyper Chase",  "Prism Spin",     "Spark Shower",   "Color Bomb",    "Roller Derby",
    "Random",
};

const char *patternName(PatternId id) {
  if (id == PATTERN_BLACKOUT) return "blackout";
  if (id == PATTERN_OFF) return "off";
  if ((uint8_t)id < PATTERN_COUNT) return kNames[id];
  return "unknown";
}

void patternLabelDisplay(PatternId id, char *out, size_t n) {
  if (!out || n == 0) return;
  if (id == PATTERN_BLACKOUT) {
    snprintf(out, n, "99 - Blackout");
    return;
  }
  if (id == PATTERN_OFF) {
    snprintf(out, n, "Off");
    return;
  }
  if ((uint8_t)id >= PATTERN_COUNT) {
    snprintf(out, n, "—");
    return;
  }
  if (id == PATTERN_RANDOM) {
    snprintf(out, n, "(A) - %s", kTitles[PATTERN_AURORA]);
    return;
  }
  snprintf(out, n, "%02u - %s", (unsigned)id, kTitles[id]);
}
