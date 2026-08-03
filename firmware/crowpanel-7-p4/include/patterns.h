#pragma once

#include "led_config.h"
#include <stddef.h>
#include <stdint.h>

#if defined(VIEWERONE_ENABLE_LED)
#include <FastLED.h>
#endif

const char *patternName(PatternId id);
void patternLabelDisplay(PatternId id, char *out, size_t n);

#if defined(VIEWERONE_ENABLE_LED)
void patternsBegin(CRGB *leds, uint16_t count);
void patternsSet(PatternId id);
PatternId patternsCurrent();
void patternsSetBrightness(uint8_t brightness);
void patternsTick();
void patternsClear();
bool patternsConsumeFooterDirty();
#else
/** Stub API when FastLED is not linked (default CrowPanel build). */
inline PatternId patternsCurrent() { return DEFAULT_PATTERN; }
inline void patternsSet(PatternId) {}
inline void patternsSetBrightness(uint8_t) {}
inline void patternsTick() {}
inline void patternsClear() {}
inline bool patternsConsumeFooterDirty() { return false; }
#endif
